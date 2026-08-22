import { randomUUID } from "node:crypto";
import type {
  BrowserActionResult,
  BrowserBackend,
  BrowserClickInput,
  BrowserPageRead,
  BrowserScreenshot,
  BrowserTab,
  BrowserTypeInput,
} from "@suma/assistant-core/browser";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  EmptyBrowserAuthProvider,
  type BrowserAuthProvider,
} from "./auth-provider";
import type { BrowserNetworkPolicy } from "./network-policy";
import type {
  BrowserSessionKey,
  BrowserSessionStore,
  BrowserStorageState,
} from "./session-store";

const PAGE_TEXT_LIMIT = 60_000;
const SAFE_POPUP_BINDING = "__sumaOpenGuardedPopup";
const SAFE_POPUP_SCRIPT = `(() => {
  const openGuarded = (value) => {
    const raw = value == null ? "" : String(value);
    void globalThis.${SAFE_POPUP_BINDING}(raw).catch(() => undefined);
    return null;
  };
  Object.defineProperty(globalThis, "open", {
    value: openGuarded,
    writable: false,
    configurable: false,
  });
  document.addEventListener("click", (event) => {
    const path = event.composedPath();
    const anchor = path.find((candidate) => candidate instanceof HTMLAnchorElement);
    if (!anchor) return;
    const baseTarget = document.querySelector("base")?.target || "";
    const target = (anchor.target || baseTarget).toLowerCase();
    if (target === "" || target === "_self" || target === "_top" || target === "_parent") return;
    event.preventDefault();
    openGuarded(anchor.href);
  }, true);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const target = form.target.toLowerCase();
    if (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent") {
      form.target = "_self";
    }
  }, true);
  const nativeSubmit = HTMLFormElement.prototype.submit;
  Object.defineProperty(HTMLFormElement.prototype, "submit", {
    value: function guardedSubmit() {
      const target = this.target.toLowerCase();
      if (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent") {
        this.target = "_self";
      }
      return nativeSubmit.call(this);
    },
    writable: false,
    configurable: false,
  });
})();`;

interface PausedBrowserRequest {
  requestId: string;
  request: { url: string; headers: Record<string, string> };
}

export interface PlaywrightBrowserRuntimeOptions {
  executablePath?: string;
  headless?: boolean;
  /** Test seam; production always uses Playwright's Chromium launcher. */
  launch?: () => Promise<Browser>;
}

export class PlaywrightBrowserRuntime {
  readonly #options: PlaywrightBrowserRuntimeOptions;
  #browserPromise: Promise<Browser> | null = null;

  constructor(options: PlaywrightBrowserRuntimeOptions = {}) {
    this.#options = options;
  }

  async browser(): Promise<Browser> {
    this.#browserPromise ??= (
      this.#options.launch?.() ??
      chromium.launch({
        executablePath: this.#options.executablePath,
        headless: this.#options.headless ?? true,
        args: ["--disable-dev-shm-usage"],
      })
    ).catch((error: unknown) => {
      this.#browserPromise = null;
      throw error;
    });
    return this.#browserPromise;
  }

  async close(): Promise<void> {
    const browserPromise = this.#browserPromise;
    this.#browserPromise = null;
    if (browserPromise !== null) await (await browserPromise).close();
  }
}

export interface PlaywrightBrowserBackendOptions {
  runtime: PlaywrightBrowserRuntime;
  sessionKey: BrowserSessionKey;
  store: BrowserSessionStore;
  networkPolicy: BrowserNetworkPolicy;
  authProvider?: BrowserAuthProvider;
}

/** A full-control, persistent browser session scoped to one user and space. */
export class PlaywrightBrowserBackend implements BrowserBackend {
  readonly #runtime: PlaywrightBrowserRuntime;
  readonly #sessionKey: BrowserSessionKey;
  readonly #store: BrowserSessionStore;
  readonly #networkPolicy: BrowserNetworkPolicy;
  readonly #authProvider: BrowserAuthProvider;
  #context: BrowserContext | null = null;
  readonly #pages = new Map<string, Page>();
  readonly #pageGuards = new Map<Page, Promise<void>>();
  #activeTabId: string | null = null;

  constructor(options: PlaywrightBrowserBackendOptions) {
    this.#runtime = options.runtime;
    this.#sessionKey = options.sessionKey;
    this.#store = options.store;
    this.#networkPolicy = options.networkPolicy;
    this.#authProvider = options.authProvider ?? new EmptyBrowserAuthProvider();
  }

  async listTabs(): Promise<BrowserTab[]> {
    await this.#ensureContext();
    return Promise.all(
      [...this.#pages.entries()].map(([tabId, page]) =>
        this.#presentTab(tabId, page),
      ),
    );
  }

  async openTab(url?: string): Promise<BrowserTab> {
    const context = await this.#ensureContext();
    const page = await context.newPage();
    await this.#registerPage(page);
    const tabId = this.#tabIdFor(page);
    this.#activeTabId = tabId;
    if (url !== undefined && url.trim() !== "") {
      await this.#navigatePage(page, url.trim());
      await this.flush();
    }
    return this.#presentTab(tabId, page);
  }

  async selectTab(tabId: string): Promise<BrowserTab> {
    const page = await this.#requirePage(tabId);
    this.#activeTabId = tabId;
    await page.bringToFront();
    return this.#presentTab(tabId, page);
  }

  async navigate(url: string, tabId?: string): Promise<BrowserTab> {
    const [id, page] = await this.#requirePageWithId(tabId);
    await this.#navigatePage(page, url.trim());
    await this.flush();
    return this.#presentTab(id, page);
  }

  async reload(tabId?: string): Promise<BrowserTab> {
    const [id, page] = await this.#requirePageWithId(tabId);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    await this.flush();
    return this.#presentTab(id, page);
  }

  async goBack(tabId?: string): Promise<BrowserTab> {
    const [id, page] = await this.#requirePageWithId(tabId);
    const response = await page.goBack({
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (response === null) throw new Error("the tab has no previous page");
    await this.flush();
    return this.#presentTab(id, page);
  }

  async goForward(tabId?: string): Promise<BrowserTab> {
    const [id, page] = await this.#requirePageWithId(tabId);
    const response = await page.goForward({
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (response === null) throw new Error("the tab has no next page");
    await this.flush();
    return this.#presentTab(id, page);
  }

  async readPage(tabId?: string): Promise<BrowserPageRead> {
    const [, page] = await this.#requirePageWithId(tabId);
    this.#requireWebPage(page);
    const text = await page.locator("body").innerText({ timeout: 10_000 });
    return {
      title: await page.title(),
      url: page.url(),
      text: text.slice(0, PAGE_TEXT_LIMIT),
    };
  }

  async screenshot(tabId?: string): Promise<BrowserScreenshot> {
    const [, page] = await this.#requirePageWithId(tabId);
    this.#requireWebPage(page);
    const data = await page.screenshot({
      type: "jpeg",
      quality: 80,
      fullPage: false,
    });
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    return {
      title: await page.title(),
      url: page.url(),
      width: viewport.width,
      height: viewport.height,
      mediaType: "image/jpeg",
      data: data.toString("base64"),
    };
  }

  async click(input: BrowserClickInput): Promise<BrowserActionResult> {
    const [id, page] = await this.#requirePageWithId(input.tabId);
    this.#requireWebPage(page);
    const methods = [
      input.selector !== undefined,
      input.text !== undefined,
      input.x !== undefined || input.y !== undefined,
    ].filter(Boolean).length;
    if (methods !== 1) {
      throw new Error(
        "click requires exactly one target: selector, text, or both x and y",
      );
    }

    const options = {
      button: input.button ?? "left",
      clickCount: input.doubleClick === true ? 2 : 1,
      timeout: 10_000,
    } as const;
    if (input.selector !== undefined) {
      await page.locator(input.selector).first().click(options);
    } else if (input.text !== undefined) {
      await page.getByText(input.text, { exact: false }).first().click(options);
    } else {
      if (input.x === undefined || input.y === undefined) {
        throw new Error("coordinate clicks require both x and y");
      }
      await page.mouse.click(input.x, input.y, options);
    }
    await page.waitForTimeout(150);
    await this.flush();
    return {
      tab: await this.#presentTab(id, page),
      description: "click completed",
    };
  }

  async typeText(input: BrowserTypeInput): Promise<BrowserActionResult> {
    const [id, page] = await this.#requirePageWithId(input.tabId);
    this.#requireWebPage(page);
    const locator =
      input.selector === undefined
        ? page.locator(":focus").first()
        : page.locator(input.selector).first();
    if ((await locator.count()) === 0) {
      throw new Error("no focused element; provide a CSS selector to type into");
    }
    if (input.append === true) {
      await locator.pressSequentially(input.text);
    } else {
      await locator.fill(input.text);
    }
    if (input.pressEnter === true) await locator.press("Enter");
    await page.waitForTimeout(100);
    await this.flush();
    return {
      tab: await this.#presentTab(id, page),
      description: `typed ${String(input.text.length)} characters`,
    };
  }

  async pressKey(
    key: string,
    tabId?: string,
  ): Promise<BrowserActionResult> {
    const [id, page] = await this.#requirePageWithId(tabId);
    this.#requireWebPage(page);
    await page.keyboard.press(key);
    await page.waitForTimeout(100);
    await this.flush();
    return {
      tab: await this.#presentTab(id, page),
      description: `pressed ${key}`,
    };
  }

  async scroll(
    direction: "up" | "down" | "left" | "right",
    tabId?: string,
    selector?: string,
  ): Promise<BrowserActionResult> {
    const [id, page] = await this.#requirePageWithId(tabId);
    this.#requireWebPage(page);
    const amount = 600;
    const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
    if (selector === undefined) {
      await page.mouse.wheel(deltaX, deltaY);
    } else {
      await page.locator(selector).first().evaluate(
        (element, delta) => element.scrollBy(delta.x, delta.y),
        { x: deltaX, y: deltaY },
      );
    }
    await page.waitForTimeout(100);
    return {
      tab: await this.#presentTab(id, page),
      description: `scrolled ${direction}`,
    };
  }

  async flush(): Promise<void> {
    if (this.#context === null) return;
    const state = await this.#context.storageState({ indexedDB: true });
    await this.#store.save(this.#sessionKey, state);
  }

  async exportStorageState(): Promise<BrowserStorageState> {
    const context = await this.#ensureContext();
    const state = await context.storageState({ indexedDB: true });
    await this.#store.save(this.#sessionKey, state);
    return state;
  }

  /** Replace this browser's account state with a trusted desktop handoff. */
  async importStorageState(state: BrowserStorageState): Promise<void> {
    if (this.#context !== null) {
      // Do not flush the outgoing state over the newer imported snapshot.
      await this.#context.close();
      this.#context = null;
      this.#pages.clear();
      this.#pageGuards.clear();
      this.#activeTabId = null;
    }
    await this.#store.save(this.#sessionKey, state);
  }

  async close(): Promise<void> {
    if (this.#context === null) return;
    await this.flush();
    await this.#context.close();
    this.#context = null;
    this.#pages.clear();
    this.#pageGuards.clear();
    this.#activeTabId = null;
  }

  async #ensureContext(): Promise<BrowserContext> {
    if (this.#context !== null) return this.#context;
    const browser = await this.#runtime.browser();
    const storageState = await this.#store.load(this.#sessionKey);
    const context = await browser.newContext({
      ...(storageState === null ? {} : { storageState }),
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await context.exposeBinding(
      SAFE_POPUP_BINDING,
      async ({ frame }, rawUrl: unknown) => {
        if (typeof rawUrl !== "string" || rawUrl.trim() === "") return false;
        const url = new URL(rawUrl, frame.url());
        await this.#networkPolicy.assertAllowed(url.href);
        const popup = await context.newPage();
        await this.#registerPage(popup);
        await this.#navigatePage(popup, url.href);
        this.#activeTabId = this.#tabIdFor(popup);
        return true;
      },
    );
    await context.addInitScript(SAFE_POPUP_SCRIPT);
    context.on("page", (page) => {
      void this.#registerPage(page).catch(() => {
        if (!page.isClosed()) void page.close();
      });
    });
    this.#context = context;
    return context;
  }

  #registerPage(page: Page): Promise<void> {
    const existing = this.#pageGuards.get(page);
    if (existing !== undefined) return existing;

    const tabId = randomUUID();
    this.#pages.set(tabId, page);
    this.#activeTabId ??= tabId;
    page.on("close", () => {
      this.#pages.delete(tabId);
      this.#pageGuards.delete(page);
      if (this.#activeTabId === tabId) {
        this.#activeTabId = this.#pages.keys().next().value ?? null;
      }
    });
    const guard = this.#installNetworkGuard(page);
    this.#pageGuards.set(page, guard);
    return guard;
  }

  async #installNetworkGuard(page: Page): Promise<void> {
    const session = await page.context().newCDPSession(page);
    session.on("Fetch.requestPaused", (event) => {
      void this.#continueGuardedRequest(session, event);
    });
    await session.send("Fetch.enable", {
      patterns: [
        { urlPattern: "http://*", requestStage: "Request" },
        { urlPattern: "https://*", requestStage: "Request" },
      ],
    });
  }

  async #continueGuardedRequest(
    session: CDPSession,
    event: PausedBrowserRequest,
  ): Promise<void> {
    try {
      await this.#networkPolicy.assertAllowed(event.request.url);
      const managed = new Set(
        this.#authProvider.managedHeaderNames().map((name) => name.toLowerCase()),
      );
      const headers = Object.entries(event.request.headers)
        .filter(([name]) => !managed.has(name.toLowerCase()))
        .map(([name, value]) => ({ name, value }));
      const injected = await this.#authProvider.headersFor(
        new URL(event.request.url),
      );
      for (const [name, value] of Object.entries(injected)) {
        headers.push({ name, value });
      }
      await session.send("Fetch.continueRequest", {
        requestId: event.requestId,
        headers,
      });
    } catch {
      await session
        .send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "BlockedByClient",
        })
        .catch(() => undefined);
    }
  }

  async #navigatePage(page: Page, rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    await this.#networkPolicy.assertAllowed(url.href);
    await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
  }

  async #requirePage(tabId?: string): Promise<Page> {
    const [, page] = await this.#requirePageWithId(tabId);
    return page;
  }

  async #requirePageWithId(tabId?: string): Promise<[string, Page]> {
    await this.#ensureContext();
    const id = tabId === undefined || tabId === "" ? this.#activeTabId : tabId;
    if (id === null) {
      throw new Error("there is no open browser tab; call open_tab first");
    }
    const page = this.#pages.get(id);
    if (page === undefined) {
      throw new Error(`unknown tab id "${id}"; call list_tabs for current ids`);
    }
    return [id, page];
  }

  #tabIdFor(page: Page): string {
    const entry = [...this.#pages.entries()].find(([, candidate]) => candidate === page);
    if (entry === undefined) throw new Error("new browser page was not registered");
    return entry[0];
  }

  async #presentTab(tabId: string, page: Page): Promise<BrowserTab> {
    return {
      tabId,
      url: page.url(),
      title: await page.title(),
      active: tabId === this.#activeTabId,
      loading: false,
    };
  }

  #requireWebPage(page: Page): void {
    if (!/^https?:/iu.test(page.url())) {
      throw new Error("browser content tools require an HTTP(S) page");
    }
  }
}
