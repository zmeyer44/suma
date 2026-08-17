/**
 * The simulator's fetch.public — the local-mode twin of agent/src/fetch.rs.
 *
 * Same contract, same refusals: public http(s) URLs only, no credentials
 * (the request carries none and never will), private/loopback/link-local
 * targets refused on the literal host AND on every DNS answer, ≤5 redirects
 * each re-checked, https never downgrades to http, Content-Length required,
 * 8 GiB cap with partial-file cleanup. Transport is Node's fetch (undici),
 * which handles TLS; redirects are followed MANUALLY so every hop passes
 * the same target policy the first URL passed — `redirect: "follow"` would
 * skip exactly the checks that matter.
 *
 * Known, accepted gap (simulator only): undici re-resolves DNS itself, so a
 * host that changes answers between our check and the dial slips through
 * (TOCTOU). The Rust agent dials the vetted address directly; here the
 * "VM" is the user's own Mac and the fetch runs with the user's own
 * network access, so the check is a guardrail, not a boundary.
 */

import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import dns from "node:dns/promises";
import net from "node:net";
import type { AgentCtlResponse } from "@suma/protocol";

/** Mirrors agent/src/fetch.rs — one fetch's disk-exhaustion guard. */
export const SIM_MAX_FETCH_BYTES = 8 * 1024 * 1024 * 1024;

/** Emit progress roughly this often (bytes). */
const PROGRESS_STRIDE = 64 * 1024;

const MAX_REDIRECTS = 5;

export interface SimFetchArgs {
  url: string;
  /** Absolute host path, ALREADY confined via LocalVfs.resolveNewFile. */
  destTarget: string;
  /** The Files wire path the caller asked for — what events carry. */
  destWirePath: string;
  emit: (event: AgentCtlResponse) => void;
  /** Test seams. */
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  allowPrivate?: boolean;
}

/**
 * Run the download to completion, emitting fetch.progress and exactly one
 * terminal fetch.done or fetch.failed. Never throws.
 */
export async function simFetchPublic(args: SimFetchArgs): Promise<void> {
  const emitFailed = async (error: string): Promise<void> => {
    await fs.rm(args.destTarget, { force: true }).catch(() => undefined);
    args.emit({
      t: "fetch.failed",
      url: args.url,
      path: args.destWirePath,
      error,
    });
  };
  try {
    const bytes = await run(args);
    args.emit({
      t: "fetch.done",
      url: args.url,
      path: args.destWirePath,
      bytes,
    });
  } catch (err) {
    await emitFailed(err instanceof Error ? err.message : String(err));
  }
}

async function run(args: SimFetchArgs): Promise<number> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const maxBytes = args.maxBytes ?? SIM_MAX_FETCH_BYTES;

  let current = parseFetchUrl(args.url);
  let response: Response | null = null;
  for (let hop = 0; ; hop += 1) {
    await checkTarget(current.hostname, args);
    const answered = await fetchImpl(current.toString(), {
      redirect: "manual",
      headers: { "user-agent": "suma-agent-sim" },
    });
    if ([301, 302, 303, 307, 308].includes(answered.status)) {
      // The body of a redirect is noise; release the connection.
      await answered.body?.cancel().catch(() => undefined);
      if (hop + 1 > MAX_REDIRECTS) {
        throw new Error(`fetch refused: more than ${MAX_REDIRECTS} redirects`);
      }
      const location = answered.headers.get("location");
      if (location === null) throw new Error("redirect without a Location header");
      current = resolveRedirect(current, location);
      continue;
    }
    if (answered.status !== 200) {
      await answered.body?.cancel().catch(() => undefined);
      throw new Error(`fetch failed: upstream answered ${answered.status}`);
    }
    response = answered;
    break;
  }

  const declared = response.headers.get("content-length");
  if (declared === null) {
    throw new Error("fetcher requires Content-Length (no chunked transfer)");
  }
  const total = Number.parseInt(declared, 10);
  if (!Number.isFinite(total) || total < 0) {
    throw new Error("fetcher requires a sane Content-Length");
  }
  if (total > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `fetch refused: ${total} bytes exceeds the ${maxBytes} byte limit for one fetch`,
    );
  }
  if (response.body === null) {
    throw new Error("fetch failed: response carried no body");
  }

  const file = createWriteStream(args.destTarget);
  let received = 0;
  let lastEmit = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      // Content-Length is the server's claim, not a promise (same rule as
      // the Rust fetcher): enforce the cap against bytes actually written.
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `fetch aborted: body exceeded the ${maxBytes} byte limit for one fetch`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        file.write(Buffer.from(value), (err) =>
          err ? reject(err) : resolve(),
        );
      });
      if (received - lastEmit >= PROGRESS_STRIDE || received >= total) {
        lastEmit = received;
        args.emit({
          t: "fetch.progress",
          url: args.url,
          received,
          total,
        });
      }
    }
  } finally {
    await new Promise<void>((resolve) => file.end(resolve));
  }

  if (received !== total) {
    throw new Error(`fetch truncated: got ${received} of ${total} bytes`);
  }
  return received;
}

/* ------------------------------ URL policy ------------------------------ */

function parseFetchUrl(raw: string): URL {
  // eslint-disable-next-line no-control-regex -- rejecting them is the point
  if (/[\u0000-\u0020\u007f]/.test(raw)) {
    throw new Error("URL contains a control character or space; refusing to fetch it");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("fetch.public accepts http(s) URLs only");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("fetch.public accepts http(s) URLs only");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("fetch refused: URL carries userinfo");
  }
  return url;
}

/** Same strictness as the agent: absolute http(s) or root-relative only,
 *  and an https fetch is never talked down to http. */
export function resolveRedirect(from: URL, location: string): URL {
  let next: URL;
  if (location.startsWith("http://") || location.startsWith("https://")) {
    next = parseFetchUrl(location);
  } else if (location.startsWith("/") && !location.startsWith("//")) {
    next = parseFetchUrl(new URL(location, from).toString());
  } else {
    throw new Error(
      `redirect Location ${JSON.stringify(location)} is neither absolute http(s) nor root-relative`,
    );
  }
  if (from.protocol === "https:" && next.protocol === "http:") {
    throw new Error("redirect refused: https must not downgrade to http");
  }
  return next;
}

/** Literal-host policy + every-DNS-answer policy, port of check_target_host
 *  and the post-lookup filter in agent/src/fetch.rs. */
export async function checkTarget(
  hostname: string,
  args: Pick<SimFetchArgs, "allowPrivate" | "lookup">,
): Promise<void> {
  if (args.allowPrivate === true) return;
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (net.isIP(bare) !== 0) {
    if (ipIsPrivate(bare)) {
      throw new Error(`fetch refused: ${hostname} is a private or local address`);
    }
    return;
  }
  if (bare === "localhost" || bare.endsWith(".localhost") || !bare.includes(".")) {
    throw new Error(`fetch refused: ${hostname} is a private or local address`);
  }
  const lookup =
    args.lookup ?? (async (host: string) => dns.lookup(host, { all: true }));
  let answers: Array<{ address: string }>;
  try {
    answers = await lookup(bare);
  } catch {
    throw new Error(`fetch failed: resolving ${hostname}`);
  }
  const permitted = answers.filter((a) => !ipIsPrivate(a.address));
  if (permitted.length === 0 || permitted.length !== answers.length) {
    // ANY private answer refuses the host: undici picks its own address
    // from the answer set, so a mixed set cannot be trusted.
    throw new Error(
      `fetch refused: ${hostname} did not resolve to a permitted public address`,
    );
  }
}

export function ipIsPrivate(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4IsPrivate(ip);
  if (kind === 6) return ipv6IsPrivate(ip);
  return true; // not an IP — the caller should not have asked
}

function ipv4IsPrivate(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o))) return true;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && octets[1] === 168) ||
    (a === 169 && octets[1] === 254) || // link-local / metadata
    a === 0 || // unspecified
    ip === "255.255.255.255" ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64.0.0/10
  );
}

function ipv6IsPrivate(ip: string): boolean {
  const lower = ip.toLowerCase();
  // v4-mapped: judged as the embedded IPv4 — same anti-bypass as the agent.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped !== null && mapped[1] !== undefined) return ipv4IsPrivate(mapped[1]);
  if (lower === "::1" || lower === "::") return true;
  return (
    lower.startsWith("fc") ||
    lower.startsWith("fd") || // unique-local fc00::/7
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") // link-local fe80::/10
  );
}
