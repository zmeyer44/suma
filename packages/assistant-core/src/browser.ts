import { jsonSchema, tool, type ToolSet } from "ai";

export interface BrowserTab {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
}

export interface BrowserPageRead {
  title: string;
  url: string;
  text: string;
}

export interface BrowserScreenshot {
  title: string;
  url: string;
  width: number;
  height: number;
  mediaType: "image/jpeg" | "image/png";
  data: string;
}

export interface BrowserActionResult {
  tab: BrowserTab;
  description: string;
}

export interface BrowserClickInput {
  tabId?: string;
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right";
  doubleClick?: boolean;
}

export interface BrowserTypeInput {
  tabId?: string;
  selector?: string;
  text: string;
  append?: boolean;
  pressEnter?: boolean;
}

export interface BrowserBackend {
  listTabs(): Promise<BrowserTab[]>;
  openTab(url?: string): Promise<BrowserTab>;
  selectTab(tabId: string): Promise<BrowserTab>;
  navigate(url: string, tabId?: string): Promise<BrowserTab>;
  reload(tabId?: string): Promise<BrowserTab>;
  goBack(tabId?: string): Promise<BrowserTab>;
  goForward(tabId?: string): Promise<BrowserTab>;
  readPage(tabId?: string): Promise<BrowserPageRead>;
  screenshot(tabId?: string): Promise<BrowserScreenshot>;
  click(input: BrowserClickInput): Promise<BrowserActionResult>;
  typeText(input: BrowserTypeInput): Promise<BrowserActionResult>;
  pressKey(key: string, tabId?: string): Promise<BrowserActionResult>;
  scroll(
    direction: "up" | "down" | "left" | "right",
    tabId?: string,
    selector?: string,
  ): Promise<BrowserActionResult>;
}

/** Builds the same model-facing browser vocabulary for Electron and remote. */
export function createBrowserToolSet(backend: BrowserBackend): ToolSet {
  return {
    list_tabs: tool({
      description:
        "List open browser tabs, including ids, URLs, titles, loading state, and the active tab.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: () => backend.listTabs(),
    }),
    open_tab: tool({
      description: "Open and select a browser tab, optionally at an HTTP(S) URL.",
      inputSchema: jsonSchema<{ url?: string }>({
        type: "object",
        properties: { url: { type: "string" } },
        additionalProperties: false,
      }),
      execute: ({ url }) => backend.openTab(url),
    }),
    select_tab: tool({
      description: "Select a browser tab by id.",
      inputSchema: jsonSchema<{ tabId: string }>({
        type: "object",
        properties: { tabId: { type: "string" } },
        required: ["tabId"],
        additionalProperties: false,
      }),
      execute: ({ tabId }) => backend.selectTab(tabId),
    }),
    navigate: tool({
      description: "Navigate a tab to an absolute HTTP(S) URL.",
      inputSchema: jsonSchema<{ url: string; tabId?: string }>({
        type: "object",
        properties: { url: { type: "string" }, tabId: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      }),
      execute: ({ url, tabId }) => backend.navigate(url, tabId),
    }),
    reload: tool({
      description: "Reload a tab, defaulting to the active tab.",
      inputSchema: optionalTabSchema(),
      execute: ({ tabId }) => backend.reload(tabId),
    }),
    go_back: tool({
      description: "Navigate a tab backward in its history.",
      inputSchema: optionalTabSchema(),
      execute: ({ tabId }) => backend.goBack(tabId),
    }),
    go_forward: tool({
      description: "Navigate a tab forward in its history.",
      inputSchema: optionalTabSchema(),
      execute: ({ tabId }) => backend.goForward(tabId),
    }),
    read_page: tool({
      description: "Read visible text, title, and URL from a browser tab.",
      inputSchema: optionalTabSchema(),
      execute: ({ tabId }) => backend.readPage(tabId),
    }),
    screenshot: tool({
      description: "Capture the visible browser page as an image.",
      inputSchema: optionalTabSchema(),
      execute: ({ tabId }) => backend.screenshot(tabId),
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
        "Click by CSS selector, visible text, or page coordinates. Coordinates are viewport pixels.",
      inputSchema: jsonSchema<BrowserClickInput>({
        type: "object",
        properties: {
          tabId: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "middle", "right"] },
          doubleClick: { type: "boolean" },
        },
        additionalProperties: false,
      }),
      execute: (input) => backend.click(input),
    }),
    type_text: tool({
      description:
        "Type into a CSS-selected element or the currently focused element. Can replace or append and optionally press Enter.",
      inputSchema: jsonSchema<BrowserTypeInput>({
        type: "object",
        properties: {
          tabId: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
          append: { type: "boolean" },
          pressEnter: { type: "boolean" },
        },
        required: ["text"],
        additionalProperties: false,
      }),
      execute: (input) => backend.typeText(input),
    }),
    press_key: tool({
      description:
        "Press a keyboard key or shortcut in a tab, such as Enter, Escape, ArrowDown, or Control+A.",
      inputSchema: jsonSchema<{ key: string; tabId?: string }>({
        type: "object",
        properties: { key: { type: "string" }, tabId: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      }),
      execute: ({ key, tabId }) => backend.pressKey(key, tabId),
    }),
    scroll: tool({
      description: "Scroll the page or a CSS-selected scrollable element.",
      inputSchema: jsonSchema<{
        direction?: "up" | "down" | "left" | "right";
        tabId?: string;
        selector?: string;
      }>({
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
          },
          tabId: { type: "string" },
          selector: { type: "string" },
        },
        additionalProperties: false,
      }),
      execute: ({ direction = "down", tabId, selector }) =>
        backend.scroll(direction, tabId, selector),
    }),
  };
}

function optionalTabSchema() {
  return jsonSchema<{ tabId?: string }>({
    type: "object",
    properties: { tabId: { type: "string" } },
    additionalProperties: false,
  });
}
