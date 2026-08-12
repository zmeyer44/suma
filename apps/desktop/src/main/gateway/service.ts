/**
 * Gateway-backed browser networking.
 *
 * Electron still owns Blink, V8, the DOM, GPU compositing, input, and every
 * WebContents. The intercepted boundary is HTTP(S): portable origins are sent
 * to the account SessionHub, while assisted/challenged origins keep Chromium's
 * browser-native network stack and use sealed cookie synchronization.
 */

import {
  encodeGatewayHeaderValue,
  GATEWAY_COOKIES_PATH,
  GATEWAY_CREDENTIALS_HEADER,
  GATEWAY_FETCH_PATH,
  GATEWAY_RESPONSE_HEADER,
  GATEWAY_SPACE_HEADER,
  GATEWAY_TARGET_HEADER,
  GATEWAY_TOP_LEVEL_SITE_HEADER,
  GATEWAY_UPSTREAM_AUTH_HEADER,
  type GatewayCookieMutation,
  type GatewayCookieMutationBatch,
  type GatewayCookieSnapshot,
} from "@suma/protocol";
import type { Cookie, Session } from "electron";
import {
  GatewayOriginRouter,
  isDeviceLocalCookieName,
  responseIsBrowserChallenge,
  urlLooksLikeBrowserChallenge,
} from "./routing";

interface GatewayBackedServiceDeps {
  getToken: () => Promise<string | null>;
  gatewayUrl?: string | null;
  devToken?: string | null;
  initialNativeDomains?: ReadonlyArray<string>;
  onNativePromoted?: (domain: string) => void;
  nativeFetchImpl?: (session: Session, request: Request) => Promise<Response>;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
}

interface SessionBinding {
  session: Session;
  cookieListener: (
    event: unknown,
    cookie: Cookie,
    cause: string,
    removed: boolean,
  ) => void;
}

interface CookieSnapshotResponse {
  cookies: GatewayCookieSnapshot[];
  initialized?: boolean;
}

const MAX_EAGER_AUTH_BODY_BYTES = 1024 * 1024;

function shouldRetainRequestBody(
  request: Request,
  mutationPending: boolean,
): boolean {
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.body === null
  ) {
    return false;
  }
  if (mutationPending) return true;

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    return (
      Number.isSafeInteger(bytes) &&
      bytes >= 0 &&
      bytes <= MAX_EAGER_AUTH_BODY_BYTES
    );
  }
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return (
    contentType === "application/json" ||
    contentType === "application/x-www-form-urlencoded"
  );
}

function gatewayOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported session gateway protocol: ${url.protocol}`);
  }
  return url.origin;
}

function topLevelUrl(request: Request): string {
  if (request.headers.get("sec-fetch-mode") === "navigate") return request.url;
  for (const referrer of [request.referrer, request.headers.get("referer")]) {
    if (referrer === null || referrer === "") continue;
    try {
      const url = new URL(referrer);
      if (url.protocol === "http:" || url.protocol === "https:")
        return url.origin;
    } catch {
      // Try the explicit Referer header, then fall back to the request origin.
    }
  }
  return new URL(request.url).origin;
}

function cookieSnapshot(cookie: Cookie): GatewayCookieSnapshot {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: (cookie.domain ?? "").replace(/^\./, ""),
    hostOnly: cookie.hostOnly === true,
    path: cookie.path ?? "/",
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    session: cookie.session === true,
    ...(cookie.expirationDate === undefined
      ? {}
      : { expirationDate: cookie.expirationDate }),
    sameSite: cookie.sameSite,
    partitionKey: null,
  };
}

function cookieSetDetails(
  cookie: GatewayCookieSnapshot,
): Electron.CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: host }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expirationDate === undefined
      ? {}
      : { expirationDate: cookie.expirationDate }),
    sameSite: cookie.sameSite,
  };
}

function cookieIdentity(cookie: GatewayCookieSnapshot): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain.replace(/^\./, "").toLowerCase(),
    cookie.path,
    cookie.partitionKey,
  ]);
}

export class GatewayBackedService {
  private endpoint: string | null;
  private readonly pinnedByEnv: boolean;
  private readonly router: GatewayOriginRouter;
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly hydrated = new Map<string, Promise<void>>();
  private readonly suppressCapture = new Set<string>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly requests = new Set<AbortController>();
  private stopped = false;

  constructor(private readonly deps: GatewayBackedServiceDeps) {
    const configured = deps.gatewayUrl?.trim() ?? "";
    this.pinnedByEnv = configured !== "";
    this.endpoint = configured === "" ? null : gatewayOrigin(configured);
    this.router = new GatewayOriginRouter(deps.initialNativeDomains);
  }

  /** A ws(s) hub discovery URL and the HTTP gateway share one Worker origin. */
  setHubUrl(hubUrl: string): void {
    if (this.pinnedByEnv) return;
    this.endpoint = gatewayOrigin(hubUrl);
  }

  /** Structured authority is origin-scoped; native origins use sealed sync. */
  ownsHost(host: string): boolean {
    return (
      this.endpoint !== null && this.router.routeForHost(host) === "structured"
    );
  }

  promoteNativeOrigin(host: string): string {
    const promotion = this.router.promote(host);
    if (promotion.changed) this.deps.onNativePromoted?.(promotion.domain);
    return promotion.domain;
  }

  attachTo(ses: Session, spaceId: string): void {
    if (this.bindings.has(spaceId)) return;
    const handler = (request: Request): Promise<Response> =>
      this.handle(ses, spaceId, request);
    ses.protocol.handle("http", handler);
    ses.protocol.handle("https", handler);

    const cookieListener = (
      _event: unknown,
      cookie: Cookie,
      cause: string,
      removed: boolean,
    ): void => {
      if (
        this.endpoint === null ||
        this.suppressCapture.has(spaceId) ||
        isDeviceLocalCookieName(cookie.name) ||
        !this.ownsHost(cookie.domain ?? "")
      ) {
        return;
      }
      // Chromium reports replacement as a removal half followed by the new
      // value. Publishing the removal would race the value and could erase a
      // freshly rotated canonical session.
      if (removed && cause === "overwrite") return;
      if (
        cause === "inserted-no-change-overwrite" ||
        cause === "inserted-no-value-change-overwrite"
      ) {
        return;
      }
      const mutation: GatewayCookieMutation = {
        cookie: cookieSnapshot(cookie),
        removed,
      };
      const previous = this.mutationQueues.get(spaceId) ?? Promise.resolve();
      const queued = previous
        .catch(() => undefined)
        .then(() => this.publishCookieMutation(spaceId, mutation));
      this.mutationQueues.set(spaceId, queued);
      void queued
        .catch((error) => this.log(error))
        .finally(() => {
          if (this.mutationQueues.get(spaceId) === queued)
            this.mutationQueues.delete(spaceId);
        });
    };
    ses.cookies.on("changed", cookieListener);
    this.bindings.set(spaceId, { session: ses, cookieListener });
  }

  /** A new device credential must be used on the next fetch and hydration. */
  refreshAuth(): void {
    this.hydrated.clear();
  }

  /**
   * Wait until every structured-origin cookie mutation observed so far is
   * acknowledged by the canonical gateway jar. Realtime tab URL publication
   * uses this alongside sealed-cookie sync so neither session lane can be
   * overtaken by an authenticated redirect.
   */
  async flushSessionState(): Promise<boolean> {
    try {
      await Promise.all(
        [...this.bindings.keys()].map((spaceId) =>
          this.awaitCookieMutations(spaceId),
        ),
      );
      return true;
    } catch (error) {
      this.log(error);
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    for (const { session: ses, cookieListener } of this.bindings.values()) {
      ses.cookies.removeListener("changed", cookieListener);
      ses.protocol.unhandle("http");
      ses.protocol.unhandle("https");
    }
    this.bindings.clear();
    this.hydrated.clear();
    this.suppressCapture.clear();
    this.mutationQueues.clear();
  }

  private async handle(
    ses: Session,
    spaceId: string,
    request: Request,
  ): Promise<Response> {
    const endpoint = this.endpoint;
    if (endpoint === null) {
      return this.nativeFetch(ses, request);
    }

    const requestUrl = new URL(request.url);
    if (urlLooksLikeBrowserChallenge(request.url)) {
      this.promoteNativeOrigin(requestUrl.hostname);
      return this.nativeFetch(ses, request);
    }
    if (!this.ownsHost(requestUrl.hostname)) {
      // Native origins are authoritative in Chromium and sealed cookie sync.
      // Importing a partial gateway jar here can mix two session lineages and
      // makes strict identity providers reject an otherwise valid request.
      return this.nativeFetch(ses, request);
    }
    // Once a page needs Chromium-native transport, keep its dependent request
    // graph on that same path. Sending a native identity page's CDN/API calls
    // through the gateway splits its IP/TLS identity and can also leave the
    // locally rendered page without auth-critical scripts or imagery.
    const contextUrl = topLevelUrl(request);
    if (
      contextUrl !== request.url &&
      !this.ownsHost(new URL(contextUrl).hostname)
    ) {
      return this.nativeFetch(ses, request);
    }

    // Electron exposes Blob uploads from protocol.handle through a renderer-
    // owned data pipe. Auth requests can wait for a preceding local cookie
    // mutation while an unload or navigation destroys the renderer before
    // fetch starts pulling that pipe (`Could not get blob data`). Begin
    // consuming small auth/form bodies (and every body behind a known barrier)
    // now. Large ordinary uploads remain streaming.
    const retainedBody = shouldRetainRequestBody(
      request,
      this.mutationQueues.has(spaceId),
    )
      ? request.arrayBuffer().then(
          (body) => ({ ok: true as const, body: new Uint8Array(body) }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      : null;

    try {
      await this.hydrateOnce(ses, spaceId);
      // document.cookie is synchronous to page JavaScript, but Electron emits
      // the matching cookies.changed event asynchronously. OAuth clients such
      // as X commonly write a transaction cookie and immediately exchange the
      // provider credential. Do not let that exchange overtake a mutation the
      // gateway has already begun committing, or the first flow is rejected
      // and only an uninterrupted second attempt sees the transaction state.
      await this.awaitCookieMutations(spaceId);
      const token = await this.token();
      if (token === null)
        return this.gatewayError(
          401,
          "Suma session gateway is not authenticated",
        );

      let outgoingBody: BodyInit | null = request.body;
      if (retainedBody !== null) {
        const retained = await retainedBody;
        if (!retained.ok) throw retained.error;
        outgoingBody = retained.body;
      }

      const headers = new Headers(request.headers);
      const upstreamAuthorization = headers.get("authorization");
      headers.delete("authorization");
      headers.delete(GATEWAY_UPSTREAM_AUTH_HEADER);
      headers.delete("cookie");
      headers.delete("content-length");
      headers.delete("host");
      headers.set("authorization", `Bearer ${token}`);
      headers.set(GATEWAY_SPACE_HEADER, spaceId);
      headers.set(GATEWAY_TARGET_HEADER, encodeGatewayHeaderValue(request.url));
      headers.set(
        GATEWAY_TOP_LEVEL_SITE_HEADER,
        encodeGatewayHeaderValue(topLevelUrl(request)),
      );
      headers.set(GATEWAY_CREDENTIALS_HEADER, request.credentials);
      if (upstreamAuthorization !== null) {
        headers.set(GATEWAY_UPSTREAM_AUTH_HEADER, upstreamAuthorization);
      }

      const fetchInit: RequestInit & {
        duplex?: "half";
      } = {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? null
            : outgoingBody,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD")
        fetchInit.duplex = "half";
      // This control-plane hop must not inherit the page's CORS context. A
      // Session.fetch carrying the origin's `Origin` plus Suma metadata is
      // treated as a cross-origin renderer fetch and Chromium preflights the
      // gateway itself. Main-process fetch is the privileged network boundary;
      // the returned response still enters Chromium under the original URL.
      const response = await this.gatewayFetch(
        new URL(GATEWAY_FETCH_PATH, endpoint),
        fetchInit,
      );
      if (response.headers.get(GATEWAY_RESPONSE_HEADER) !== "authoritative") {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `session gateway rejected request (${response.status}): ${detail}`,
        );
      }
      if (responseIsBrowserChallenge(request.url, response)) {
        this.promoteNativeOrigin(requestUrl.hostname);
        // GET/HEAD navigation and challenge resources are safe to replay. A
        // non-idempotent request is never duplicated; its response is allowed
        // through and the newly promoted origin goes native thereafter.
        if (request.method === "GET" || request.method === "HEAD") {
          await response.body?.cancel().catch(() => undefined);
          return this.nativeFetch(ses, request);
        }
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete(GATEWAY_RESPONSE_HEADER);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      this.log(error);
      return this.gatewayError(
        502,
        "Suma could not reach the session gateway",
      );
    }
  }

  private hydrateOnce(ses: Session, spaceId: string): Promise<void> {
    const existing = this.hydrated.get(spaceId);
    if (existing !== undefined) return existing;
    const pending = this.hydrate(ses, spaceId).catch((error) => {
      this.hydrated.delete(spaceId);
      throw error;
    });
    this.hydrated.set(spaceId, pending);
    return pending;
  }

  private async hydrate(ses: Session, spaceId: string): Promise<void> {
    const endpoint = this.endpoint;
    const token = await this.token();
    if (endpoint === null || token === null)
      throw new Error("session gateway is not authenticated");
    const response = await this.gatewayFetch(
      new URL(GATEWAY_COOKIES_PATH, endpoint),
      {
        headers: {
          authorization: `Bearer ${token}`,
          [GATEWAY_SPACE_HEADER]: spaceId,
        },
      },
    );
    if (!response.ok)
      throw new Error(`session gateway hydration failed (${response.status})`);
    const body = (await response.json()) as CookieSnapshotResponse;
    if (!Array.isArray(body.cookies))
      throw new Error("session gateway returned malformed cookies");

    // One-time rollout bridge: if this Mac already had a cookie that the new
    // canonical jar does not, adopt it before the gateway takes authority.
    // Existing canonical identities always win, preventing a stale device
    // from overwriting a session another Mac has already refreshed.
    const canonical = new Set(body.cookies.map(cookieIdentity));
    const local = await ses.cookies.get({});
    const missing =
      body.initialized === true || body.cookies.length > 0
        ? []
        : local
            .map(cookieSnapshot)
            .filter(
              (cookie) =>
                cookie.domain !== "" &&
                !isDeviceLocalCookieName(cookie.name) &&
                this.ownsHost(cookie.domain) &&
                !canonical.has(cookieIdentity(cookie)),
            )
            .map(
              (cookie) =>
                ({ cookie, removed: false }) satisfies GatewayCookieMutation,
            );
    if (missing.length > 0) await this.publishCookieMutations(spaceId, missing);

    this.suppressCapture.add(spaceId);
    try {
      for (const cookie of body.cookies) {
        if (isDeviceLocalCookieName(cookie.name)) continue;
        // Never copy the structured jar into a browser-native origin. Its
        // cookies are restored by the encrypted record-sync lane instead.
        if (!this.ownsHost(cookie.domain)) continue;
        // Electron 43 does not expose CHIPS partition keys in CookiesSetDetails.
        // The gateway still sends partitioned cookies outbound authoritatively;
        // only their document.cookie mirror is omitted.
        if (cookie.partitionKey !== null) continue;
        await ses.cookies.set(cookieSetDetails(cookie));
      }
    } finally {
      this.suppressCapture.delete(spaceId);
    }
  }

  private async publishCookieMutation(
    spaceId: string,
    mutation: GatewayCookieMutation,
  ): Promise<void> {
    await this.publishCookieMutations(spaceId, [mutation]);
  }

  private async awaitCookieMutations(spaceId: string): Promise<void> {
    // A renderer's synchronous document.cookie write and its next request can
    // reach different Electron APIs in the opposite order. Yield one main-loop
    // turn so the cookies.changed notification can join the queue first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    let pending = this.mutationQueues.get(spaceId);
    while (pending !== undefined) {
      await pending;
      const current = this.mutationQueues.get(spaceId);
      if (current === undefined || current === pending) return;
      pending = current;
    }
  }

  private async publishCookieMutations(
    spaceId: string,
    mutations: GatewayCookieMutation[],
  ): Promise<void> {
    const endpoint = this.endpoint;
    const token = await this.token();
    if (endpoint === null || token === null) return;
    const body: GatewayCookieMutation | GatewayCookieMutationBatch =
      mutations.length === 1 && mutations[0] !== undefined
        ? mutations[0]
        : { mutations };
    const response = await this.gatewayFetch(
      new URL(GATEWAY_COOKIES_PATH, endpoint),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [GATEWAY_SPACE_HEADER]: spaceId,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(
        `session gateway cookie update failed (${response.status})`,
      );
  }

  private async token(): Promise<string | null> {
    const dev = this.deps.devToken?.trim() ?? "";
    return dev === "" ? this.deps.getToken() : dev;
  }

  private gatewayFetch(input: URL, init: RequestInit): Promise<Response> {
    if (this.stopped)
      return Promise.reject(new Error("session gateway stopped"));
    const controller = new AbortController();
    this.requests.add(controller);
    return (this.deps.fetchImpl ?? fetch)(input, {
      ...init,
      signal: controller.signal,
    }).finally(() => {
      this.requests.delete(controller);
    });
  }

  private async nativeFetch(ses: Session, request: Request): Promise<Response> {
    if (this.deps.nativeFetchImpl !== undefined) {
      return this.deps.nativeFetchImpl(ses, request);
    }
    // Test/default adapter. Production injects the ClientRequest bridge, which
    // exposes redirects that Session.fetch treats as a cancelled request.
    return ses.fetch(request, {
      bypassCustomProtocolHandlers: true,
      redirect: "manual",
    });
  }

  private gatewayError(status: number, message: string): Response {
    return new Response(message, {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private log(error: unknown): void {
    (
      this.deps.onError ??
      ((value) => console.error("suma session gateway:", value))
    )(error);
  }
}

export const gatewayUrlForHub = gatewayOrigin;
