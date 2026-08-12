/**
 * The assistant's browser tools — the AI SDK ToolSet bound to the live
 * TabManager/SpaceManager.
 *
 * Every tool operates on the ACTIVE space only: the sidebar is a copilot for
 * what the user is looking at, not a background automation surface, and a
 * space is a privacy boundary (its own session, cookies, egress policy). Any
 * tool that touches page CONTENT (read/screenshot/interact) additionally
 * refuses non-http(s) documents — internal suma:// pages and the blank
 * new-tab view are the chrome's, not the page's, and must never round-trip
 * through a model.
 *
 * Tool failures are thrown Errors: the SDK converts them into error tool
 * results, so the model sees "unknown tab id …" and can recover, instead of
 * the run aborting.
 */

import type { NativeImage, WebContents } from "electron";
import { jsonSchema, tool, type ToolSet } from "ai";
import {
  CHAT_TOOL_GROUPS,
  isToolGroupEnabled,
  type ChatSettings,
} from "../../shared/chat";
import type { TabInfo } from "../../shared/ipc";
import type { SpaceManager } from "../spaces";
import type { TabManager } from "../tabs";
import {
  clickScript,
  focusForTypingScript,
  READ_PAGE_SCRIPT,
  resolvePressKey,
  sanitizePageText,
  sanitizeScriptOutcome,
  scrollScript,
} from "./chat-core";

export interface BrowserToolDeps {
  spaces: SpaceManager;
  tabs: TabManager;
}

/** Screenshots are scaled to this width — plenty for layout questions, small
 *  enough that a run with several screenshots stays affordable. */
const SCREENSHOT_MAX_WIDTH = 1024;
const SCREENSHOT_JPEG_QUALITY = 80;
/** How long navigate/click/read wait for the page to settle. */
const LOAD_SETTLE_MS = 12_000;
const LOAD_POLL_MS = 150;

/** The tab summary the model sees — no favicon URLs, no sync internals. */
interface TabForModel {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
}

function presentTab(info: TabInfo): TabForModel {
  return {
    tabId: info.id,
    url: info.url,
    title: info.title,
    active: info.active,
    loading: info.isLoading,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBrowserTools(deps: BrowserToolDeps): ToolSet {
  const { spaces, tabs } = deps;

  function requireSpaceId(): string {
    const spaceId = spaces.activeSpaceId;
    if (spaceId === null) throw new Error("no active space");
    return spaceId;
  }

  function listTabs(): TabInfo[] {
    return tabs.list(requireSpaceId());
  }

  /** The addressed tab, defaulting to the active one. */
  function requireTab(tabId: string | undefined): TabInfo {
    const all = listTabs();
    if (tabId === undefined || tabId === "") {
      const active = all.find((t) => t.active);
      if (active === undefined) throw new Error("there is no active tab");
      return active;
    }
    const found = all.find((t) => t.id === tabId);
    if (found === undefined) {
      throw new Error(
        `unknown tab id "${tabId}" — call list_tabs for current ids`,
      );
    }
    return found;
  }

  /** Live web-page contents, or a thrown reason the model can act on. */
  function requirePageContents(tabId: string | undefined): {
    info: TabInfo;
    wc: WebContents;
  } {
    const info = requireTab(tabId);
    const wc = tabs.webContentsFor(info.id);
    if (wc === null) {
      throw new Error(
        `tab "${info.title}" is not loaded — select_tab it first to wake it`,
      );
    }
    const url = wc.getURL();
    if (!/^https?:/i.test(url)) {
      throw new Error(
        "this tab is not showing a web page (internal or blank page) — tools can only work on http(s) pages",
      );
    }
    return { info, wc };
  }

  async function settle(wc: WebContents): Promise<void> {
    const deadline = Date.now() + LOAD_SETTLE_MS;
    // Give a just-issued navigation a beat to actually start loading.
    await delay(LOAD_POLL_MS * 2);
    while (Date.now() < deadline) {
      if (wc.isDestroyed() || !wc.isLoading()) return;
      await delay(LOAD_POLL_MS);
    }
  }

  const all: ToolSet = {
    list_tabs: tool({
      description:
        "List the open tabs in the current space: their tabId, url, title, and which one is active. Call this before addressing a tab by id.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: () => Promise.resolve(listTabs().map(presentTab)),
    }),

    open_tab: tool({
      description:
        "Open a new browser tab, optionally at a URL, and make it the active tab. Returns the new tab.",
      inputSchema: jsonSchema<{ url?: string }>({
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Absolute http(s) URL to open. Omit for an empty new tab.",
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ url }) => {
        const spaceId = requireSpaceId();
        const info = tabs.create(
          url === undefined || url.trim() === ""
            ? { spaceId }
            : { spaceId, url: url.trim() },
        );
        const wc = tabs.webContentsFor(info.id);
        if (wc !== null) await settle(wc);
        return presentTab(requireTab(info.id));
      },
    }),

    select_tab: tool({
      description:
        "Make a tab the active (visible) tab. Use list_tabs to find its tabId.",
      inputSchema: jsonSchema<{ tabId: string }>({
        type: "object",
        properties: {
          tabId: { type: "string", description: "The tab to activate." },
        },
        required: ["tabId"],
        additionalProperties: false,
      }),
      execute: ({ tabId }) => {
        const info = requireTab(tabId);
        tabs.select(info.id);
        return Promise.resolve(presentTab(requireTab(info.id)));
      },
    }),

    navigate: tool({
      description:
        "Navigate a tab to a URL and wait for the page to load. Defaults to the active tab.",
      inputSchema: jsonSchema<{ url: string; tabId?: string }>({
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
          tabId: {
            type: "string",
            description: "Tab to navigate; omit for the active tab.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      }),
      execute: async ({ url, tabId }) => {
        const info = requireTab(tabId);
        tabs.navigate(info.id, url.trim());
        const wc = tabs.webContentsFor(info.id);
        if (wc !== null) await settle(wc);
        return presentTab(requireTab(info.id));
      },
    }),

    read_page: tool({
      description:
        "Read a page's visible text (plus its title and URL). Defaults to the active tab. The text is what a reader would see; long pages are truncated.",
      inputSchema: jsonSchema<{ tabId?: string }>({
        type: "object",
        properties: {
          tabId: {
            type: "string",
            description: "Tab to read; omit for the active tab.",
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ tabId }) => {
        const { wc } = requirePageContents(tabId);
        await settle(wc);
        const raw: unknown = await wc.executeJavaScript(READ_PAGE_SCRIPT, true);
        return sanitizePageText(raw);
      },
    }),

    screenshot: tool({
      description:
        "Take a screenshot of a tab to see what the page looks like visually. The tab must be the active (visible) one — select_tab it first otherwise. Defaults to the active tab.",
      inputSchema: jsonSchema<{ tabId?: string }>({
        type: "object",
        properties: {
          tabId: {
            type: "string",
            description: "Tab to capture; omit for the active tab.",
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ tabId }) => {
        const { info, wc } = requirePageContents(tabId);
        if (!info.active) {
          throw new Error(
            "only the visible tab can be captured — call select_tab first",
          );
        }
        await settle(wc);
        const image: NativeImage = await wc.capturePage();
        if (image.isEmpty()) {
          throw new Error(
            "the capture came back empty — the page may still be rendering; try again",
          );
        }
        const size = image.getSize();
        const scaled =
          size.width > SCREENSHOT_MAX_WIDTH
            ? image.resize({ width: SCREENSHOT_MAX_WIDTH })
            : image;
        const jpeg = scaled.toJPEG(SCREENSHOT_JPEG_QUALITY);
        return {
          title: info.title,
          url: info.url,
          width: scaled.getSize().width,
          height: scaled.getSize().height,
          mediaType: "image/jpeg" as const,
          data: jpeg.toString("base64"),
        };
      },
      // The model gets the actual pixels; without this it would see a JSON
      // blob of base64 and learn nothing visual.
      toModelOutput: ({ output }) => ({
        type: "content",
        value: [
          {
            type: "text",
            text: `Screenshot of "${output.title}" (${output.url}), ${String(output.width)}×${String(output.height)}:`,
          },
          {
            type: "file",
            data: { type: "data", data: output.data },
            mediaType: output.mediaType,
          },
        ],
      }),
    }),

    click: tool({
      description:
        "Click an element on the page, found by CSS selector or by its visible text (links, buttons, inputs). Provide exactly one of selector/text. Defaults to the active tab.",
      inputSchema: jsonSchema<{
        selector?: string;
        text?: string;
        tabId?: string;
      }>({
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector to click." },
          text: {
            type: "string",
            description:
              "Visible text of the link/button to click (case-insensitive substring).",
          },
          tabId: {
            type: "string",
            description: "Tab to act on; omit for the active tab.",
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ selector, text, tabId }) => {
        if ((selector ?? "") === "" && (text ?? "") === "") {
          throw new Error("provide a selector or the element's visible text");
        }
        const { wc } = requirePageContents(tabId);
        const raw: unknown = await wc.executeJavaScript(
          clickScript(selector?.trim() || null, text?.trim() || null),
          true,
        );
        const outcome = sanitizeScriptOutcome(raw);
        if (!outcome.ok) throw new Error(outcome.message);
        // A click often starts a navigation; report where it landed.
        await settle(wc);
        const after = requireTab(tabId);
        return { ...outcome, url: after.url, title: after.title };
      },
    }),

    type_text: tool({
      description:
        "Type text into an input, textarea, or editable element (found by CSS selector). Clears the field first unless append is true. Set pressEnter to submit afterwards. Defaults to the active tab.",
      inputSchema: jsonSchema<{
        selector: string;
        text: string;
        append?: boolean;
        pressEnter?: boolean;
        tabId?: string;
      }>({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector of the field to type into.",
          },
          text: { type: "string", description: "The text to type." },
          append: {
            type: "boolean",
            description: "Keep the field's existing content (default false).",
          },
          pressEnter: {
            type: "boolean",
            description: "Press Enter after typing (default false).",
          },
          tabId: {
            type: "string",
            description: "Tab to act on; omit for the active tab.",
          },
        },
        required: ["selector", "text"],
        additionalProperties: false,
      }),
      execute: async ({ selector, text, append, pressEnter, tabId }) => {
        const { wc } = requirePageContents(tabId);
        const raw: unknown = await wc.executeJavaScript(
          focusForTypingScript(selector.trim(), append !== true),
          true,
        );
        const outcome = sanitizeScriptOutcome(raw);
        if (!outcome.ok) throw new Error(outcome.message);
        // insertText types into the focused element through the normal input
        // pipeline, so frameworks (React et al.) see real input events.
        await wc.insertText(text);
        if (pressEnter === true) {
          wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
          wc.sendInputEvent({ type: "char", keyCode: "Return" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
          await settle(wc);
        }
        const after = requireTab(tabId);
        return {
          ok: true,
          message: `typed into ${outcome.message.replace(/^focused /, "")}`,
          url: after.url,
          title: after.title,
        };
      },
    }),

    press_key: tool({
      description:
        "Press a single key on the page (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp/Down, Home, End). Defaults to the active tab.",
      inputSchema: jsonSchema<{ key: string; tabId?: string }>({
        type: "object",
        properties: {
          key: { type: "string", description: "The key name, e.g. Enter." },
          tabId: {
            type: "string",
            description: "Tab to act on; omit for the active tab.",
          },
        },
        required: ["key"],
        additionalProperties: false,
      }),
      execute: async ({ key, tabId }) => {
        const keyCode = resolvePressKey(key);
        if (keyCode === null) {
          throw new Error(`unsupported key "${key}"`);
        }
        const { wc } = requirePageContents(tabId);
        wc.focus();
        wc.sendInputEvent({ type: "keyDown", keyCode });
        if (keyCode === "Return") {
          wc.sendInputEvent({ type: "char", keyCode });
        }
        wc.sendInputEvent({ type: "keyUp", keyCode });
        await settle(wc);
        return { ok: true, message: `pressed ${key}` };
      },
    }),

    scroll: tool({
      description:
        "Scroll the page — by direction (up/down one screen, top, bottom) or to an element by CSS selector. Defaults to the active tab.",
      inputSchema: jsonSchema<{
        direction?: "up" | "down" | "top" | "bottom";
        selector?: string;
        tabId?: string;
      }>({
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "top", "bottom"],
            description: "Where to scroll when no selector is given.",
          },
          selector: {
            type: "string",
            description: "Scroll this element into view instead.",
          },
          tabId: {
            type: "string",
            description: "Tab to act on; omit for the active tab.",
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ direction, selector, tabId }) => {
        const { wc } = requirePageContents(tabId);
        const raw: unknown = await wc.executeJavaScript(
          scrollScript(direction ?? null, selector?.trim() || null),
          true,
        );
        const outcome = sanitizeScriptOutcome(raw);
        if (!outcome.ok) throw new Error(outcome.message);
        return outcome;
      },
    }),
  };

  return all;
}

/** The subset of tools the user has left enabled (settings page toggles). */
export function enabledBrowserTools(
  deps: BrowserToolDeps,
  settings: ChatSettings,
): ToolSet {
  const tools = createBrowserTools(deps);
  const enabled: ToolSet = {};
  for (const group of CHAT_TOOL_GROUPS) {
    if (!isToolGroupEnabled(settings, group.id)) continue;
    for (const name of group.tools) {
      const entry = tools[name];
      if (entry !== undefined) enabled[name] = entry;
    }
  }
  return enabled;
}
