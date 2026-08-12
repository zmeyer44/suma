#!/usr/bin/env node
/**
 * Phase-0 egress spike harness (docs/egress-spike.md, PRD §8.4 Phase 0).
 *
 * Measures the one thing the spike exists to measure: how origins in the
 * supported corpus treat the SAME client when only the exit IP changes —
 * direct from this network vs. through the identity egress gateway.
 *
 * Both probes share curl's TLS fingerprint and headers, so the DELTA between
 * direct and proxied isolates the IP variable. Absolute challenge rates here
 * do not predict the real browser's (Chromium's fingerprint differs); the
 * comparison across runs and networks is the data.
 *
 *   node spike.mjs --proxy https://suma-egressgw-spike.fly.dev:8443 \
 *     --token "$(mint-egress-token spike)" --label home-wifi --direct
 *
 *   node spike.mjs report results/home-wifi-*.json results/hotspot-*.json
 *
 * Zero dependencies; shells out to curl (needs the HTTPS-proxy feature for
 * an https:// proxy URL — stock macOS/Linux curl has it).
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, "../../packages/config/src/corpus.ts");
const RESULTS_DIR = path.join(HERE, "results");

/** Statuses that read as "the origin pushed back". cf-mitigated is checked
 * separately — Cloudflare labels its own challenges for us. */
const CHALLENGE_STATUSES = new Set([403, 429, 503]);
const CONCURRENCY = 4;
const TIMEOUT_S = 25;

/** curl's own UA invites blocks that say nothing about the IP; a browser UA
 * keeps the noise floor down. The TLS fingerprint is still curl's — caveat
 * recorded in every result file. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const args = { direct: false, limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--proxy") args.proxy = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--origins") args.origins = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--direct") args.direct = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function corpusOrigins() {
  const source = readFileSync(CORPUS, "utf8");
  const origins = [];
  for (const match of source.matchAll(
    /domain:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g,
  )) {
    origins.push({ domain: match[1], label: match[2] });
  }
  if (origins.length === 0) throw new Error(`no origins parsed from ${CORPUS}`);
  return origins;
}

async function curlVersionHasHttpsProxy() {
  const { stdout } = await run("curl", ["--version"]);
  return stdout.includes("HTTPS-proxy");
}

/** One probe. Returns status 0 + error class on transport failure. */
async function probe(url, { proxy, token } = {}) {
  const argv = [
    "-sS", "-o", "/dev/null",
    "-w", "%{http_code}\t%{time_total}\t%{remote_ip}",
    "--max-time", String(TIMEOUT_S),
    "-A", UA,
    "-D", "-",
  ];
  if (proxy) {
    argv.push("--proxy", proxy);
    argv.push("--proxy-header", `Proxy-Authorization: Bearer ${token}`);
  }
  argv.push(url);
  try {
    const { stdout } = await run("curl", argv, { maxBuffer: 4 * 1024 * 1024 });
    // stdout = response headers (from -D -) then the -w line.
    const lastLine = stdout.trimEnd().split("\n").at(-1) ?? "";
    const [code, seconds] = lastLine.split("\t");
    const headers = {};
    for (const line of stdout.split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0) {
        const name = line.slice(0, i).trim().toLowerCase();
        if (["server", "cf-mitigated", "cf-ray", "retry-after", "x-akamai-request-id"].includes(name)) {
          headers[name] = line.slice(i + 1).trim();
        }
      }
    }
    return { status: Number(code), seconds: Number(seconds), headers };
  } catch (error) {
    return { status: 0, seconds: null, headers: {}, error: String(error.message ?? error).split("\n")[0] };
  }
}

function challenged(result) {
  if (result.status === 0) return false; // transport failure, not a challenge
  if (result.headers["cf-mitigated"]?.includes("challenge")) return true;
  return CHALLENGE_STATUSES.has(result.status);
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

async function measure(args) {
  if (!args.proxy || !args.token || !args.label) {
    console.error(
      "usage: spike.mjs --proxy <https://host:8443> --token <sm-egress-v1…> --label <network-name> [--direct] [--origins file] [--limit N]\n" +
      "       spike.mjs report <results.json>…",
    );
    process.exit(2);
  }
  if (args.proxy.startsWith("https://") && !(await curlVersionHasHttpsProxy())) {
    console.error("this curl lacks the HTTPS-proxy feature — use a newer curl, or an http:// proxy URL for loopback testing");
    process.exit(1);
  }

  const origins = (args.origins
    ? readFileSync(args.origins, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((domain) => ({ domain, label: domain }))
    : corpusOrigins()
  ).slice(0, args.limit);

  // Exit identity first — the whole point of the gateway. ipify returns the
  // caller's public IP as plain text-ish JSON-free body.
  const [proxiedIp, directIp] = await Promise.all([
    probe("https://api.ipify.org/", args),
    probe("https://api.ipify.org/"),
  ]);
  console.log(`network: ${args.label}`);
  console.log(`direct exit IP:  (probe ${directIp.status})`);
  console.log(`proxied exit IP: (probe ${proxiedIp.status})`);
  if (proxiedIp.status !== 200) {
    console.error("proxied exit-IP probe failed — gateway/token problem, aborting before the corpus run");
    if (proxiedIp.error) console.error(`  ${proxiedIp.error}`);
    process.exit(1);
  }
  // remote_ip on the ipify probes is ipify's server, not the exit IP — fetch
  // bodies for those two specifically.
  const exitIps = {};
  for (const [key, viaProxy] of [["proxied", true], ["direct", false]]) {
    const argv = ["-sS", "--max-time", String(TIMEOUT_S), "-A", UA];
    if (viaProxy) argv.push("--proxy", args.proxy, "--proxy-header", `Proxy-Authorization: Bearer ${args.token}`);
    argv.push("https://api.ipify.org/");
    try {
      exitIps[key] = (await run("curl", argv)).stdout.trim();
    } catch {
      exitIps[key] = null;
    }
  }
  console.log(`direct:  ${exitIps.direct}`);
  console.log(`proxied: ${exitIps.proxied}${exitIps.proxied === exitIps.direct ? "  (!! same as direct — the tunnel is not exiting elsewhere)" : ""}`);
  console.log(`probing ${origins.length} origins${args.direct ? " (proxied + direct)" : " (proxied only)"}…\n`);

  const rows = await pool(origins, async (origin) => {
    const url = `https://${origin.domain}/`;
    const proxied = await probe(url, args);
    const direct = args.direct ? await probe(url) : null;
    return { ...origin, proxied, direct };
  });

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("origin", 24) + pad("proxied", 10) + (args.direct ? pad("direct", 10) : "") + "notes");
  let challengedCount = 0;
  let divergences = 0;
  for (const row of rows) {
    const marks = [];
    if (challenged(row.proxied)) { marks.push("CHALLENGED"); challengedCount += 1; }
    if (row.proxied.headers["cf-mitigated"]) marks.push(`cf-mitigated=${row.proxied.headers["cf-mitigated"]}`);
    if (row.proxied.status === 0) marks.push(`transport: ${row.proxied.error ?? "failed"}`);
    if (row.direct && row.direct.status !== row.proxied.status) { marks.push(`direct=${row.direct.status} differs`); divergences += 1; }
    console.log(
      pad(row.domain, 24) +
      pad(row.proxied.status, 10) +
      (args.direct ? pad(row.direct?.status ?? "-", 10) : "") +
      marks.join(" · "),
    );
  }
  console.log(`\nchallenged via proxy: ${challengedCount}/${rows.length}` + (args.direct ? ` · status divergences vs direct: ${divergences}` : ""));

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(RESULTS_DIR, `${args.label}-${stamp}.json`);
  writeFileSync(file, JSON.stringify({
    label: args.label,
    when: new Date().toISOString(),
    proxy: args.proxy,
    exitIps,
    caveat: "curl TLS fingerprint, not Chromium's — compare deltas across runs, not absolute rates",
    rows,
  }, null, 2));
  console.log(`written: ${path.relative(process.cwd(), file)}`);
}

/** Cross-run comparison: which origins changed behavior between networks? */
function report(files) {
  const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
  console.log("run".padEnd(28) + "exit IP".padEnd(18) + "challenged");
  for (const r of runs) {
    const c = r.rows.filter((row) => challenged(row.proxied)).length;
    console.log(r.label.padEnd(28) + String(r.exitIps?.proxied ?? "?").padEnd(18) + `${c}/${r.rows.length}`);
  }
  const stable = runs.every((r) => r.exitIps?.proxied && r.exitIps.proxied === runs[0].exitIps?.proxied);
  console.log(`\nexit IP stable across runs: ${stable ? "YES" : "NO — the identity promise is broken, investigate before drawing conclusions"}`);

  const byDomain = new Map();
  for (const r of runs) {
    for (const row of r.rows) {
      const entry = byDomain.get(row.domain) ?? {};
      entry[r.label] = row.proxied.status;
      byDomain.set(row.domain, entry);
    }
  }
  const diverging = [...byDomain.entries()].filter(([, statuses]) => new Set(Object.values(statuses)).size > 1);
  if (diverging.length > 0) {
    console.log("\norigins whose proxied status differs across networks (should be ~none if the IP is doing its job):");
    for (const [domain, statuses] of diverging) {
      console.log(`  ${domain.padEnd(24)} ${Object.entries(statuses).map(([l, s]) => `${l}=${s}`).join("  ")}`);
    }
  } else {
    console.log("no per-origin divergence across networks — consistent identity.");
  }
}

const argv = process.argv.slice(2);
if (argv[0] === "report") {
  report(argv.slice(1));
} else {
  await measure(parseArgs(argv));
}
