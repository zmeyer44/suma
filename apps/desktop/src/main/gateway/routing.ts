/**
 * Origin-aware transport selection for the structured session gateway.
 *
 * Portable origins can safely use the SessionHub as their HTTP client. Sites
 * with device-integrity or anti-bot checks must keep Chromium in the network
 * path so its JavaScript, TLS, IP, and cookie identity stay coherent.
 */

import { SEED_CORPUS } from "@suma/config";
import { matchOriginPolicy, normalizedHost } from "@suma/protocol";
import { getDomain } from "tldts";

export type BrowserTransport = "structured" | "native";

const DEVICE_LOCAL_COOKIE_NAMES: ReadonlySet<string> = new Set([
  "__cf_bm",
  "__cfseq",
  "aec",
  "cf_clearance",
  "google_abuse_exemption",
]);

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Loopback targets are never gateway material: the SessionHub Worker cannot
 * see this device's (or the VM's) loopback and its jar must never learn a
 * "localhost" identity. They stay on Chromium's native stack, where the
 * egress policy's local bypass already lets them go direct — and where a
 * compute-plane port forward can answer for a dev server inside the VM.
 */
export function isLoopbackHost(value: string): boolean {
  const host = normalizedHost(value).replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  return /^127(\.\d{1,3}){3}$/.test(host);
}

/** Public-suffix-aware eTLD+1 used for whole-site transport promotion. */
export function routingDomainForHost(value: string): string {
  const host = normalizedHost(value);
  if (host === "") return host;

  const policy = matchOriginPolicy(SEED_CORPUS, host);
  if (policy.domain !== "") return policy.domain;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/** Challenge and abuse proofs are intentionally bound to one local browser. */
export function isDeviceLocalCookieName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    DEVICE_LOCAL_COOKIE_NAMES.has(lower) ||
    lower.startsWith("cf_chl_") ||
    lower.startsWith("__cf_chl_")
  );
}

export function urlLooksLikeBrowserChallenge(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const path = url.pathname.toLowerCase();
  if (path.startsWith("/cdn-cgi/challenge-platform/")) return true;
  if (path === "/sorry/" || path.startsWith("/sorry/")) return true;
  for (const key of url.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (lower.startsWith("__cf_chl_") || lower.startsWith("cf_chl_"))
      return true;
  }
  return false;
}

export function responseIsBrowserChallenge(
  requestUrl: string,
  response: Response,
): boolean {
  if (urlLooksLikeBrowserChallenge(requestUrl)) return true;
  if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge")
    return true;
  const location = response.headers.get("location");
  if (location === null) return false;
  try {
    return urlLooksLikeBrowserChallenge(new URL(location, requestUrl).href);
  } catch {
    return false;
  }
}

/**
 * Unknown origins start structured and are promoted when a challenge proves
 * they require Chromium networking. Corpus origins already marked assisted or
 * device-bound start native, avoiding an IP/TLS switch in the middle of login.
 */
export class GatewayOriginRouter {
  private readonly promoted = new Set<string>();

  constructor(initiallyPromoted: ReadonlyArray<string> = []) {
    for (const domain of initiallyPromoted) {
      const normalized = routingDomainForHost(domain);
      if (normalized !== "") this.promoted.add(normalized);
    }
  }

  routeForHost(value: string): BrowserTransport {
    const host = normalizedHost(value);
    if (isLoopbackHost(host)) return "native";
    if ([...this.promoted].some((domain) => hostMatchesDomain(host, domain)))
      return "native";
    const policy = matchOriginPolicy(SEED_CORPUS, host);
    if (policy.domain !== "" && policy.mode !== "portable") return "native";
    return "structured";
  }

  promote(value: string): { domain: string; changed: boolean } {
    // Loopback is unconditionally native; persisting it as a promoted domain
    // would plant a meaningless "localhost" entry in the synced domain store.
    if (isLoopbackHost(value)) return { domain: "", changed: false };
    const domain = routingDomainForHost(value);
    if (domain === "") return { domain, changed: false };
    const size = this.promoted.size;
    this.promoted.add(domain);
    return { domain, changed: this.promoted.size !== size };
  }

  promotedDomains(): string[] {
    return [...this.promoted].sort();
  }
}
