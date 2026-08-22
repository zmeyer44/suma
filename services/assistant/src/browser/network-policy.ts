import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface BrowserNetworkPolicy {
  assertAllowed(url: string): Promise<void>;
}

export interface SafeBrowserNetworkPolicyOptions {
  /** Exact origins used for signed preview hosts and isolated local tests. */
  allowedOrigins?: readonly string[];
}

/** Blocks browser-driven SSRF on the initial URL and every subrequest. */
export class SafeBrowserNetworkPolicy implements BrowserNetworkPolicy {
  readonly #allowedOrigins: Set<string>;

  constructor(options: SafeBrowserNetworkPolicyOptions = {}) {
    this.#allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map((origin) => new URL(origin).origin),
    );
  }

  async assertAllowed(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`browser network policy blocks ${url.protocol} URLs`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new Error("credentials in browser URLs are not allowed");
    }
    if (this.#allowedOrigins.has(url.origin)) return;

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname === "metadata.google.internal"
    ) {
      throw new Error(`browser network policy blocks host ${hostname}`);
    }

    if (isIP(hostname) !== 0) {
      if (isBlockedAddress(hostname)) {
        throw new Error(`browser network policy blocks address ${hostname}`);
      }
      return;
    }

    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw new Error(`browser host ${hostname} did not resolve`);
    }
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        throw new Error(
          `browser network policy blocks ${hostname} because it resolves to ${address}`,
        );
      }
    }
  }
}

export function isBlockedAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/u.test(lower)) return true;

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
  if (mapped?.[1] !== undefined) return isBlockedIpv4(mapped[1]);
  if (isIP(lower) === 6) return false;
  return isBlockedIpv4(lower);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
