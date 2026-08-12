/**
 * Browser-native HTTP forwarding for a protocol.handle interception.
 *
 * Electron's Session.fetch is the recommended way to bypass a custom handler,
 * but it follows redirects internally by default and rejects with "Redirect
 * was cancelled" in manual mode. ClientRequest exposes redirect metadata, so
 * this bridge can return the 3xx to Chromium and preserve navigation semantics.
 */

import { net, type ClientRequest, type Session } from "electron";
import {
  isNavigationRequest,
  navigationCookieHeader,
  responseMustBeBodyless,
  stripRedirectBodyHeaders,
  type NativeRequestHeaderBridge,
} from "./native-request-headers";
import { routingDomainForHost } from "./routing";

const RESTRICTED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of request.headers) {
    if (RESTRICTED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

function requestOrigin(request: Request): string {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") {
    try {
      return new URL(origin).origin;
    } catch {
      // Fall through to the referrer or target origin.
    }
  }
  const referrer = request.referrer || request.headers.get("referer");
  if (referrer !== null && referrer !== "") {
    try {
      return new URL(referrer).origin;
    } catch {
      // Fall through to the target origin.
    }
  }
  return new URL(request.url).origin;
}

function isSameSiteCrossOrigin(requestUrl: string, origin: string): boolean {
  try {
    const target = new URL(requestUrl);
    const source = new URL(origin);
    return (
      source.origin !== target.origin &&
      source.protocol === target.protocol &&
      routingDomainForHost(source.hostname) ===
        routingDomainForHost(target.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Chromium sends destination cookies on top-level navigations, including a
 * cross-site redirect such as accounts.google.com -> mail.google.com. The
 * Request exposed by protocol.handle does not retain navigation credential
 * semantics (redirected documents can even arrive as mode=cors), so
 * ClientRequest interprets it as a subresource fetch: destination cookies are
 * suppressed and Google's one-time SetOSID endpoint rejects the handoff as
 * malformed. ClientRequest's navigation path therefore uses the session jar
 * directly; renderer fetch/XHR requests keep their original credentials mode
 * and origin.
 */
function replayCredentials(
  request: Request,
): Pick<
  Electron.ClientRequestConstructorOptions,
  "credentials" | "origin" | "useSessionCookies"
> {
  if (isNavigationRequest(request)) {
    return { useSessionCookies: true };
  }
  const origin = requestOrigin(request);
  return {
    // Electron's protocol.handle conversion constructs a new Request without
    // copying the renderer's credentials mode, so both `include` and `omit`
    // arrive here as the default `same-origin`. OAuth clients commonly post a
    // provider credential to a same-site auth subdomain (X uses jf.x.com) with
    // `credentials: include`; replaying the reset value drops the transaction
    // and response cookies, making only a second flow work after the client
    // switches to its same-origin fallback. Restore include for schemeful
    // same-site cross-origin traffic. Cookie Domain/host scoping still decides
    // which cookies are eligible for the target subdomain.
    credentials:
      request.credentials === "same-origin" &&
      isSameSiteCrossOrigin(request.url, origin)
        ? "include"
        : request.credentials,
    origin,
  };
}

function inferredNavigationMetadata(request: Request): Record<string, string> {
  if (!isNavigationRequest(request)) return {};
  let site = "none";
  const referrer = request.referrer || request.headers.get("referer");
  if (referrer !== null && referrer !== "") {
    try {
      const target = new URL(request.url);
      const source = new URL(referrer);
      if (source.origin === target.origin) {
        site = "same-origin";
      } else if (
        source.protocol === target.protocol &&
        routingDomainForHost(source.hostname) ===
          routingDomainForHost(target.hostname)
      ) {
        site = "same-site";
      } else {
        site = "cross-site";
      }
    } catch {
      site = "cross-site";
    }
  }
  return {
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Site": site,
  };
}

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value])
      headers.append(name, item);
  }
  return headers;
}

function makeRedirectLocationAbsolute(
  headers: Headers,
  requestUrl: string,
): void {
  const location = headers.get("location");
  if (location === null) return;
  try {
    headers.set("location", new URL(location, requestUrl).href);
  } catch {
    // Leave an invalid Location untouched; Chromium will reject it normally.
  }
}

function streamingBody(
  incoming: Electron.IncomingMessage,
  client: ClientRequest,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      incoming.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
      incoming.once("end", () => controller.close());
      incoming.once("error", (error) => controller.error(error));
      incoming.once("aborted", () =>
        controller.error(new Error("native response aborted")),
      );
    },
    cancel() {
      client.abort();
    },
  });
}

function writeRequestBody(
  client: ClientRequest,
  request: Request,
  onError: (error: Error) => void,
): void {
  if (request.body === null) {
    client.end();
    return;
  }
  const useChunkedEncoding = request.headers.get("content-length") === null;
  let bodyStarted = false;
  const reader = request.body.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Electron creates its chunked downstream pipe on the first actual
        // write. Enabling chunked mode for an empty stream makes _final call
        // done() on an undefined pipe, which escapes as an uncaught exception.
        if (value.byteLength === 0) continue;
        if (!bodyStarted) {
          bodyStarted = true;
          if (useChunkedEncoding) client.chunkedEncoding = true;
        }
        client.write(Buffer.from(value));
      }
      client.end();
    } catch (error) {
      // Chromium represents an explicitly empty Blob upload (X's logout POST
      // is one example) as a renderer-owned blob data pipe. If the document
      // navigates away before Electron pulls that pipe, getBlobData rejects
      // instead of reporting EOF. No downstream body pipe exists yet, so end
      // the original request: this preserves its one-shot header-bridge entry
      // and therefore its CSRF/auth headers. Once any byte has been observed,
      // the same error is a truncated upload and must remain fatal.
      if (
        !bodyStarted &&
        error instanceof Error &&
        error.message === "Could not get blob data"
      ) {
        client.end();
        return;
      }
      client.abort();
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  })().catch(() => undefined);
}

export async function browserNativeFetch(
  session: Session,
  request: Request,
  headerBridge?: NativeRequestHeaderBridge,
): Promise<Response> {
  const fallbackFetchMetadata = inferredNavigationMetadata(request);
  const cookieHeader = isNavigationRequest(request)
    ? navigationCookieHeader(
        request,
        await session.cookies.get({ url: request.url }),
        fallbackFetchMetadata["Sec-Fetch-Site"],
      )
    : undefined;
  const requestId = headerBridge?.prepare(
    request.headers,
    cookieHeader,
    fallbackFetchMetadata,
  );
  const promise = new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (response: Response): void => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", abort);
      resolve(response);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", abort);
      reject(error);
    };

    const headers = requestHeaders(request);
    if (cookieHeader !== undefined && cookieHeader !== "") {
      headers.Cookie = cookieHeader;
    }
    const client = net.request({
      url: request.url,
      method: request.method,
      headers:
        requestId === undefined || headerBridge === undefined
          ? headers
          : headerBridge.mark(headers, requestId),
      session,
      bypassCustomProtocolHandlers: true,
      redirect: "manual",
      ...replayCredentials(request),
      referrerPolicy: request.referrerPolicy,
      cache: request.cache,
    });
    const abort = (): void => {
      client.abort();
      fail(
        request.signal.reason instanceof Error
          ? request.signal.reason
          : new Error("request aborted"),
      );
    };
    request.signal.addEventListener("abort", abort, { once: true });

    client.once("redirect", (statusCode, _method, redirectUrl, rawHeaders) => {
      const headers = responseHeaders(rawHeaders);
      // A synthetic Response has no network URL of its own, so Chromium
      // cannot reliably resolve a relative Location against it. Electron may
      // expose redirectUrl in the same relative form as the response header,
      // so resolve it against the intercepted request before returning it.
      headers.set("location", redirectUrl);
      makeRedirectLocationAbsolute(headers, request.url);
      stripRedirectBodyHeaders(statusCode, headers);
      finish(new Response(null, { status: statusCode, headers }));
    });
    client.once("response", (incoming) => {
      const headers = responseHeaders(incoming.headers);
      makeRedirectLocationAbsolute(headers, request.url);
      const noBody = responseMustBeBodyless(
        request.method,
        incoming.statusCode,
        headers,
      );
      if (noBody) stripRedirectBodyHeaders(incoming.statusCode, headers);
      finish(
        new Response(noBody ? null : streamingBody(incoming, client), {
          status: incoming.statusCode,
          statusText: incoming.statusMessage,
          headers,
        }),
      );
      if (noBody) {
        // Drain/discard any bytes Electron exposes for a redirect. Returning
        // them through protocol.handle can make Chromium commit the fallback
        // HTML instead of following Location (Google then hangs on its
        // intentionally non-executable "One moment please..." document).
        incoming.on("data", () => undefined);
        incoming.once("error", () => undefined);
      }
    });
    client.once("error", fail);
    if (request.signal.aborted) {
      abort();
      return;
    }
    writeRequestBody(client, request, fail);
  });
  return promise.finally(() => {
    if (requestId !== undefined) headerBridge?.release(requestId);
  });
}
