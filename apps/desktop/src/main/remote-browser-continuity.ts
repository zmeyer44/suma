import type { Cookie, Session, WebContents } from "electron";
import type { BrowserContext } from "playwright-core";
import type { RemoteAssistantBrowserShareResult } from "../shared/remote-assistant";
import type { ControlClient } from "./control-client";

type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const MAX_BROWSER_STATE_BYTES = 8 * 1024 * 1024;
const LOCAL_STORAGE_CAPTURE_TIMEOUT_MS = 3_000;
const LOCAL_STORAGE_CAPTURE = `(() => {
  try {
    if (location.protocol !== "http:" && location.protocol !== "https:") return null;
    return {
      origin: location.origin,
      localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })),
    };
  } catch {
    return null;
  }
})()`;

export interface BrowserContinuityDependencies {
  control: () => ControlClient | null;
  spaces: {
    readonly activeSpaceId: string | null;
    get(spaceId: string): { id: string; name: string } | undefined;
    sessionFor(spaceId: string): Pick<Session, "cookies">;
  };
  tabs: {
    list(spaceId: string): Array<{ id: string }>;
    webContentsFor(
      tabId: string,
    ): Pick<WebContents, "executeJavaScript" | "getURL"> | null;
  };
  fetch?: typeof fetch;
  now?: () => Date;
}

interface CapturedOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

/**
 * Explicitly copies the active desktop space's authenticated browser state to
 * the user's encrypted remote Playwright profile. The broad device bearer is
 * never sent to the gateway: control vends a one-use, five-minute ticket.
 */
export class RemoteBrowserContinuityService {
  readonly #deps: BrowserContinuityDependencies;
  #inFlight: Promise<RemoteAssistantBrowserShareResult> | null = null;

  constructor(deps: BrowserContinuityDependencies) {
    this.#deps = deps;
  }

  shareActiveSpace(): Promise<RemoteAssistantBrowserShareResult> {
    if (this.#inFlight !== null) return this.#inFlight;
    const attempt = this.#shareActiveSpace();
    this.#inFlight = attempt;
    void attempt.then(
      () => {
        if (this.#inFlight === attempt) this.#inFlight = null;
      },
      () => {
        if (this.#inFlight === attempt) this.#inFlight = null;
      },
    );
    return attempt;
  }

  async #shareActiveSpace(): Promise<RemoteAssistantBrowserShareResult> {
    const control = this.#deps.control();
    if (control === null) {
      throw new Error("Sign in to share browser sessions with the remote assistant.");
    }
    const spaceId = this.#deps.spaces.activeSpaceId;
    const space = spaceId === null ? undefined : this.#deps.spaces.get(spaceId);
    if (spaceId === null || space === undefined) {
      throw new Error("Open a browser space before sharing its sessions.");
    }

    const state = await captureBrowserStorageState(
      this.#deps.spaces.sessionFor(spaceId),
      this.#deps.tabs.list(spaceId).map((tab) =>
        this.#deps.tabs.webContentsFor(tab.id),
      ),
    );
    if (state.cookies.length === 0 && state.origins.length === 0) {
      throw new Error("The active space has no browser sessions to share.");
    }
    const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    if (bytes > MAX_BROWSER_STATE_BYTES) {
      throw new Error("The active browser session exceeds the 8 MiB sharing limit.");
    }

    const authorization = await control.createAssistantBrowserSessionTicket();
    const uploadUrl = trustedUploadUrl(authorization.uploadUrl);
    const response = await (this.#deps.fetch ?? fetch)(uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: authorization.ticket, state }),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(
        `Remote browser session upload failed with HTTP ${String(response.status)}.`,
      );
    }

    return {
      sharedAt: (this.#deps.now ?? (() => new Date()))().toISOString(),
      spaceId,
      spaceName: space.name,
      cookieCount: state.cookies.length,
      originCount: state.origins.length,
      localStorageItemCount: state.origins.reduce(
        (count, origin) => count + origin.localStorage.length,
        0,
      ),
    };
  }
}

export async function captureBrowserStorageState(
  session: Pick<Session, "cookies">,
  webContents: Array<Pick<WebContents, "executeJavaScript" | "getURL"> | null>,
): Promise<BrowserStorageState> {
  const electronCookies = await session.cookies.get({});
  const cookies = electronCookies.flatMap((cookie) => {
    const mapped = mapCookie(cookie);
    return mapped === null ? [] : [mapped];
  });
  const captured = await Promise.allSettled(
    webContents
      .filter(
        (
          contents,
        ): contents is Pick<WebContents, "executeJavaScript" | "getURL"> =>
          contents !== null && isHttpUrl(contents.getURL()),
      )
      .map((contents) => captureLocalStorage(contents)),
  );
  const origins = new Map<string, CapturedOrigin>();
  for (const result of captured) {
    if (result.status !== "fulfilled") continue;
    const origin = parseCapturedOrigin(result.value);
    if (origin !== null) origins.set(origin.origin, origin);
  }
  return { cookies, origins: [...origins.values()] };
}

function captureLocalStorage(
  contents: Pick<WebContents, "executeJavaScript">,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("local storage capture timed out")),
      LOCAL_STORAGE_CAPTURE_TIMEOUT_MS,
    );
    timer.unref?.();
    void contents.executeJavaScript(LOCAL_STORAGE_CAPTURE).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function mapCookie(
  cookie: Cookie,
): BrowserStorageState["cookies"][number] | null {
  if (cookie.domain === undefined || cookie.path === undefined) return null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session === true ? -1 : (cookie.expirationDate ?? -1),
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? false,
    sameSite:
      cookie.sameSite === "strict"
        ? "Strict"
        : cookie.sameSite === "no_restriction"
          ? "None"
          : "Lax",
  };
}

function parseCapturedOrigin(value: unknown): CapturedOrigin | null {
  if (!isRecord(value) || typeof value["origin"] !== "string") return null;
  let url: URL;
  try {
    url = new URL(value["origin"]);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== value["origin"] ||
    !Array.isArray(value["localStorage"])
  ) {
    return null;
  }
  const localStorage: CapturedOrigin["localStorage"] = [];
  for (const item of value["localStorage"]) {
    if (
      !isRecord(item) ||
      typeof item["name"] !== "string" ||
      typeof item["value"] !== "string"
    ) {
      return null;
    }
    localStorage.push({ name: item["name"], value: item["value"] });
  }
  return { origin: url.origin, localStorage };
}

function trustedUploadUrl(value: string): URL {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") {
    throw new Error("The remote browser upload URL contains credentials.");
  }
  const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname))) {
    throw new Error("The remote browser upload URL must use HTTPS.");
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
