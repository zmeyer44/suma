import { randomUUID } from "node:crypto";
import type {
  Cookie,
  OnBeforeSendHeadersListenerDetails,
  Session,
} from "electron";

const REQUEST_ID_HEADER = "X-Suma-Native-Request-Id";
const FETCH_METADATA_PREFIX = "sec-fetch-";

type RequestHeaders = Record<string, string>;
interface PendingRequestHeaders {
  fetchMetadata: RequestHeaders;
  /** Undefined for subresources; a string (including empty) for navigation. */
  navigationCookie?: string;
}
type RequestObserver = (
  spaceId: string,
  details: OnBeforeSendHeadersListenerDetails,
  headers: RequestHeaders,
) => void;

/**
 * `protocol.handle` gives Suma the renderer's real navigation headers, but
 * Electron regenerates Sec-Fetch-* when the request is replayed with `net`.
 * That turns a top-level navigation into `no-cors`/`empty`, which strict
 * identity providers reject as malformed.
 *
 * Pair each replay with its browser-owned Fetch Metadata headers, then restore
 * them in the session's single onBeforeSendHeaders listener immediately before
 * the request reaches the network. The opaque id is process-local: page
 * content cannot forge a metadata rewrite by supplying the marker itself.
 */
export class NativeRequestHeaderBridge {
  private readonly pending = new Map<string, PendingRequestHeaders>();
  private readonly observers = new Set<RequestObserver>();

  /** Own the session's sole header hook and fan observations out internally. */
  attachTo(session: Session, spaceId: string): void {
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = this.rewrite(details.requestHeaders);
      for (const observer of this.observers)
        observer(spaceId, details, requestHeaders);
      callback({ requestHeaders });
    });
  }

  addObserver(observer: RequestObserver): void {
    this.observers.add(observer);
  }

  prepare(
    headers: Headers,
    navigationCookie?: string,
    fallbackFetchMetadata: RequestHeaders = {},
  ): string {
    const id = randomUUID();
    const fetchMetadata: RequestHeaders = {};
    for (const [name, value] of headers) {
      if (name.toLowerCase().startsWith(FETCH_METADATA_PREFIX)) {
        fetchMetadata[name] = value;
      }
    }
    const present = new Set(
      Object.keys(fetchMetadata).map((name) => name.toLowerCase()),
    );
    for (const [name, value] of Object.entries(fallbackFetchMetadata)) {
      if (!present.has(name.toLowerCase())) fetchMetadata[name] = value;
    }
    this.pending.set(id, { fetchMetadata, navigationCookie });
    return id;
  }

  mark(headers: RequestHeaders, id: string): RequestHeaders {
    return { ...headers, [REQUEST_ID_HEADER]: id };
  }

  rewrite(outgoing: RequestHeaders): RequestHeaders {
    const marker = Object.keys(outgoing).find(
      (name) => name.toLowerCase() === REQUEST_ID_HEADER.toLowerCase(),
    );
    if (marker === undefined) return outgoing;

    const rewritten = { ...outgoing };
    const id = rewritten[marker];
    delete rewritten[marker];
    if (id === undefined) return rewritten;

    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending === undefined) return rewritten;

    for (const name of Object.keys(rewritten)) {
      const lower = name.toLowerCase();
      if (
        lower.startsWith(FETCH_METADATA_PREFIX) ||
        (pending.navigationCookie !== undefined && lower === "cookie")
      ) {
        delete rewritten[name];
      }
    }
    if (
      pending.navigationCookie !== undefined &&
      pending.navigationCookie !== ""
    ) {
      rewritten.Cookie = pending.navigationCookie;
    }
    return { ...rewritten, ...pending.fetchMetadata };
  }

  release(id: string): void {
    this.pending.delete(id);
  }
}

/**
 * Electron's protocol Request omits Cookie, while ClientRequest can suppress
 * the destination jar on a cross-site top-level redirect. Reconstruct only
 * the browser navigation case from Electron's matching cookie query. Fetch
 * and XHR keep using their original credentials mode and never enter here.
 */
export function navigationCookieHeader(
  request: Pick<Request, "headers" | "method" | "mode">,
  cookies: ReadonlyArray<Pick<Cookie, "name" | "value" | "sameSite">>,
  inferredFetchSite?: string,
): string | undefined {
  if (!isNavigationRequest(request)) return undefined;

  const crossSite =
    (request.headers.get("sec-fetch-site") ?? inferredFetchSite) ===
    "cross-site";
  const safeTopLevel = request.method === "GET" || request.method === "HEAD";
  return cookies
    .filter((cookie) => {
      if (!crossSite) return true;
      if (cookie.sameSite === "no_restriction") return true;
      if (cookie.sameSite === "strict") return false;
      // Chromium treats unspecified cookies as Lax by default. Lax cookies
      // accompany safe top-level navigations, but not a cross-site POST.
      return safeTopLevel;
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

/**
 * Redirected navigations are exposed by Electron 43 as mode=cors with no
 * Sec-Fetch-* fields. Upgrade-Insecure-Requests is a forbidden renderer
 * header and Chromium adds it to document navigations, making it a safe
 * fallback when the explicit navigation signals survive neither redirect.
 */
export function isNavigationRequest(
  request: Pick<Request, "headers" | "mode">,
): boolean {
  if (
    request.mode === "navigate" ||
    request.headers.get("sec-fetch-mode") === "navigate"
  ) {
    return true;
  }
  return (
    request.headers.get("upgrade-insecure-requests") === "1" &&
    request.headers.get("accept")?.toLowerCase().includes("text/html") === true
  );
}

/**
 * Redirect response bodies are advisory and must never become a document.
 * Some identity providers send a styled fallback body with a deliberately
 * unrelated CSP nonce on their 302 responses. Electron can emit `response`
 * before `redirect`, so the native bridge must recognize the status/header
 * shape instead of relying on event order.
 */
export function responseMustBeBodyless(
  method: string,
  status: number,
  headers: Pick<Headers, "has">,
): boolean {
  if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
    return true;
  }
  return status >= 300 && status < 400 && headers.has("location");
}

/**
 * `protocol.handle` can apply a redirect body's CSP to the destination
 * document even though Chromium's native loader treats that policy as
 * representation metadata for the discarded 3xx body. Keep redirect and
 * cookie semantics, but remove only headers that describe that absent body.
 */
export function stripRedirectBodyHeaders(
  status: number,
  headers: Headers,
): void {
  if (status < 300 || status >= 400 || !headers.has("location")) return;
  for (const name of [
    "content-encoding",
    "content-length",
    "content-security-policy",
    "content-security-policy-report-only",
    "content-type",
  ]) {
    headers.delete(name);
  }
}
