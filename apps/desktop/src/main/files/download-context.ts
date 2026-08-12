/**
 * Download routing for §8.6 — pure, no Electron, unit-tested directly.
 *
 * THE RULE: §8.6 deleted v1.0's "sealed one-shot request", which shipped the
 * user's URL and Cookie header into the VM to be decrypted there. Nothing here
 * may reintroduce a path that hands a credential — cookie, Authorization
 * header, client certificate, or userinfo in a URL — to the compute plane.
 * `cloudFetchEligibility` (@suma/protocol, FROZEN) is the enforcement point;
 * this module only assembles the facts it judges and never second-guesses its
 * verdict.
 *
 * What the browser can actually observe about a download, and how each fact is
 * obtained:
 *
 *   hasCookies / hasAuthHeader — read off the REAL outgoing request headers,
 *     recorded by a `webRequest.onBeforeSendHeaders` listener on the space
 *     session (download-router.ts) and looked up here by SESSION AND URL.
 *   usesClientCert — recorded when Chromium asks the app to choose a client
 *     certificate for that origin (`app.on("select-client-certificate")`).
 *   totalBytes — Electron's `DownloadItem.getTotalBytes()`, 0 when the server
 *     declared no length (reported to the protocol as null, not as 0).
 *
 * When a download's request was never observed, we cannot prove it carried no
 * credential — so it stays local. That is the fail-closed direction, and its
 * explanation says exactly that rather than borrowing the (wrong, in that
 * case) "this download is authenticated" copy.
 *
 * Two ways a URL-only lookup could be made to vouch for a credentialed
 * download, both closed here:
 *
 *   Across spaces — every space has its own cookie jar. The same URL loaded in
 *     a signed-out space says nothing about what it would send in a signed-in
 *     one, so observations are keyed by session as well as URL and a download
 *     only ever reads its OWN space's observations.
 *   Within one space — the same URL can be requested both with and without
 *     credentials (a cross-origin `fetch(…, {credentials: "omit"})` beside the
 *     real, cookied load). Nothing links a `will-download` back to which of
 *     them produced it, so fresh observations of one URL are merged
 *     PESSIMISTICALLY: any credential seen counts for all of them.
 */

import {
  cloudFetchEligibility,
  normalizeVfsPath,
  type CloudFetchRefusal,
  type DownloadContext,
} from "@suma/protocol";

/** Credential facts about one outgoing request. */
export interface CredentialSignals {
  hasCookies: boolean;
  hasAuthHeader: boolean;
  usesClientCert: boolean;
}

/** How long a recorded request stays usable — a download starts right after
 *  its request, and stale entries must never vouch for a later one. */
export const SIGNAL_TTL_MS = 120_000;

/**
 * Bound on remembered requests, across every space; the oldest fall off first.
 * The router records nearly every resource type (an `<img>` or `<video>` load
 * can be answered with `Content-Disposition: attachment`), so this has to hold
 * more than a page's worth of requests or a real download's observation is
 * evicted before `will-download` fires — safe (it fails closed to a local
 * download) but needlessly so. Each entry is three booleans and a timestamp.
 */
export const MAX_TRACKED_REQUESTS = 2_000;

/** Headers whose presence means "this request carries a credential". */
const AUTH_HEADERS: ReadonlyArray<string> = ["authorization", "proxy-authorization"];

function headerValue(headers: Record<string, unknown>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join("; ");
  }
  return null;
}

/**
 * Session id + URL. The fragment is stripped so a `#`-suffixed download URL
 * still matches its request; the NUL separator cannot occur in either half of
 * the key, so no session id can be spelled to collide with another's entries.
 */
function signalKey(sessionId: string, url: string): string {
  const hash = url.indexOf("#");
  return `${sessionId}\u0000${hash < 0 ? url : url.slice(0, hash)}`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Remembers the credential shape of recent requests, keyed by SESSION and URL.
 *
 * The URL is the only identifier `will-download` shares with the request that
 * produced it, and the session is what makes that identifier mean anything: a
 * space is a cookie jar, so the same URL is a different request in each one.
 * A signed-out space's cookie-less load must never vouch for a signed-in
 * space's download of the same URL, and keying by session is what stops it.
 *
 * Client-certificate challenges are the one signal kept ACROSS sessions:
 * `app.on("select-client-certificate")` fires on the app, not on a session, so
 * the space cannot be attributed. Applying it to every space is the fail-closed
 * direction — it can only make a download look more credentialed, never less.
 */
export class RequestSignalTracker {
  private readonly requests = new Map<string, { signals: CredentialSignals; atMs: number }>();
  /** Hosts that asked this Mac for a client certificate, with the time. */
  private readonly clientCertHosts = new Map<string, number>();

  /** Record one outgoing request's headers (webRequest.onBeforeSendHeaders). */
  note(sessionId: string, url: string, headers: Record<string, unknown>, atMs: number): void {
    const cookie = headerValue(headers, "cookie");
    const hasAuthHeader = AUTH_HEADERS.some((name) => {
      const value = headerValue(headers, name);
      return value !== null && value.length > 0;
    });
    const key = signalKey(sessionId, url);
    // Merge with whatever this session already saw for this URL, rather than
    // overwrite it: a cookie-less request cannot be used to erase a cookied
    // one, so `fetch(url, {credentials: "omit"})` plants nothing.
    const previous = this.requests.get(key);
    const carried =
      previous !== undefined && atMs - previous.atMs <= SIGNAL_TTL_MS ? previous.signals : null;
    // Re-insert so the Map's insertion order stays "oldest first" for eviction.
    this.requests.delete(key);
    this.requests.set(key, {
      signals: {
        hasCookies: (cookie !== null && cookie.length > 0) || (carried?.hasCookies ?? false),
        hasAuthHeader: hasAuthHeader || (carried?.hasAuthHeader ?? false),
        usesClientCert: this.usedClientCert(url, atMs) || (carried?.usesClientCert ?? false),
      },
      atMs,
    });
    this.evict(atMs);
  }

  /** Record that an origin required client-certificate authentication. */
  noteClientCert(url: string, atMs: number): void {
    const host = hostOf(url);
    if (host === null) return;
    this.clientCertHosts.set(host, atMs);
  }

  /**
   * Signals for a download's URL IN THAT SESSION, or null when this session
   * never made that exact request — which routeDownload treats as unobserved
   * and keeps on this Mac.
   */
  signalsFor(sessionId: string, url: string, atMs: number): CredentialSignals | null {
    const key = signalKey(sessionId, url);
    const entry = this.requests.get(key);
    if (entry === undefined) return null;
    if (atMs - entry.atMs > SIGNAL_TTL_MS) {
      this.requests.delete(key);
      return null;
    }
    // The client-cert challenge can arrive after the headers were recorded.
    return { ...entry.signals, usesClientCert: entry.signals.usesClientCert || this.usedClientCert(url, atMs) };
  }

  private usedClientCert(url: string, atMs: number): boolean {
    const host = hostOf(url);
    if (host === null) return false;
    const seen = this.clientCertHosts.get(host);
    return seen !== undefined && atMs - seen <= SIGNAL_TTL_MS;
  }

  private evict(atMs: number): void {
    for (const [key, entry] of this.requests) {
      if (atMs - entry.atMs <= SIGNAL_TTL_MS) break; // insertion-ordered: rest are fresher
      this.requests.delete(key);
    }
    while (this.requests.size > MAX_TRACKED_REQUESTS) {
      const oldest = this.requests.keys().next();
      if (oldest.done === true) break;
      this.requests.delete(oldest.value);
    }
  }
}

/**
 * Desktop-side refusals sit alongside the protocol's. They are NOT eligibility
 * decisions — `cloudFetchEligibility` still runs for everything that gets
 * past them; they cover the two cases it cannot see: no observation of the
 * request, and no cloud to fetch with.
 */
export type DownloadRefusal = CloudFetchRefusal | "unobserved_request" | "cloud_unavailable";

export interface DownloadRouteInput {
  url: string;
  filename: string;
  /** Electron's `getTotalBytes()`: 0 means "server declared no length". */
  totalBytes: number;
  /** Null when this download's request was never observed. */
  signals: CredentialSignals | null;
  /** User setting: keep downloads on this Mac. */
  alwaysLocal: boolean;
  /** False when there is no control plane / Files service to fetch with. */
  cloudAvailable: boolean;
}

export type DownloadRoute =
  | { kind: "cloud"; reason: "public" | "presigned"; destPath: string }
  | {
      kind: "local";
      refusal: DownloadRefusal;
      explanation: string;
      /** Whether the user is told — §8.6 requires it for authenticated links. */
      notify: boolean;
    };

/** Where a cloud-fetched download lands in the only cloud-native tree (§8.6). */
export const CLOUD_DOWNLOAD_DIR = "/Downloads";

/** A filename safe to use as a single VFS path segment. */
export function safeFilename(filename: string): string {
  const cleaned = [...filename]
    .filter((ch) => {
      if (ch === "/" || ch === "\\") return false;
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "download";
  return cleaned.slice(0, 200);
}

export function cloudDestPath(filename: string): string {
  return normalizeVfsPath(`${CLOUD_DOWNLOAD_DIR}/${safeFilename(filename)}`) ?? CLOUD_DOWNLOAD_DIR;
}

/**
 * The facts `cloudFetchEligibility` judges. Unobserved requests default to
 * "credentialed" — defence in depth behind routeDownload's earlier, more
 * honest refusal, so a future caller that skips that check still fails closed.
 */
export function buildDownloadContext(input: DownloadRouteInput): DownloadContext {
  const signals = input.signals ?? {
    hasCookies: true,
    hasAuthHeader: true,
    usesClientCert: false,
  };
  return {
    url: input.url,
    totalBytes: input.totalBytes > 0 ? input.totalBytes : null,
    hasCookies: signals.hasCookies,
    hasAuthHeader: signals.hasAuthHeader,
    usesClientCert: signals.usesClientCert,
    alwaysLocal: input.alwaysLocal,
  };
}

/**
 * Route one download. Local is always the safe answer, so every path that is
 * not a positive `eligible: true` from the frozen check stays here.
 */
export function routeDownload(input: DownloadRouteInput): DownloadRoute {
  if (!input.cloudAvailable) {
    return {
      kind: "local",
      refusal: "cloud_unavailable",
      explanation: "Suma Files isn't set up on this Mac, so downloads land here.",
      notify: false,
    };
  }
  if (input.signals === null) {
    return {
      kind: "local",
      refusal: "unobserved_request",
      explanation:
        "Suma couldn't confirm this download carries no credentials, so it stays on this Mac.",
      notify: false,
    };
  }
  const verdict = cloudFetchEligibility(buildDownloadContext(input));
  if (!verdict.eligible) {
    return {
      kind: "local",
      refusal: verdict.reason,
      explanation: verdict.explanation,
      // §8.6: the authenticated case is the one users must understand, or
      // Suma looks inconsistent. The rest (too small, local network, the
      // user's own always-local setting) are self-evident and stay quiet.
      notify: verdict.reason === "credentialed_request" || verdict.reason === "userinfo_in_url",
    };
  }
  return { kind: "cloud", reason: verdict.reason, destPath: cloudDestPath(input.filename) };
}
