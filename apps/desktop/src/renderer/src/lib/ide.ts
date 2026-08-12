/**
 * IDE shape on suma://terminal — which panels are open, how big they are, and
 * the editor's unsaved buffers.
 *
 * Layout is presentation, so it persists exactly like the chat sidebar's
 * width (lib/chat.ts): device-local localStorage, clamped on every write.
 * It must NOT live in TerminalPage state — leaving the tab unmounts the page
 * (ContentPanes draws internal pages into the hole), and the IDE should come
 * back exactly as it was left.
 */

export type IdePanel = "explorer" | "editor" | "terminal";

export const EXPLORER_DEFAULT_WIDTH = 240;
/** Below this, filenames truncate into uselessness; above, the explorer
 *  crowds the editor it exists to feed. */
export const EXPLORER_MIN_WIDTH = 170;
export const EXPLORER_MAX_WIDTH = 480;

export const TERMINAL_DEFAULT_HEIGHT = 260;
/** A shell needs a few rows to be a shell; the max leaves the editor at
 *  least a code paragraph on common window heights. */
export const TERMINAL_MIN_HEIGHT = 120;
export const TERMINAL_MAX_HEIGHT = 720;

export function clampExplorerWidth(px: number): number {
  if (!Number.isFinite(px)) return EXPLORER_DEFAULT_WIDTH;
  return Math.min(
    Math.max(Math.round(px), EXPLORER_MIN_WIDTH),
    EXPLORER_MAX_WIDTH,
  );
}

export function clampTerminalHeight(px: number): number {
  if (!Number.isFinite(px)) return TERMINAL_DEFAULT_HEIGHT;
  return Math.min(
    Math.max(Math.round(px), TERMINAL_MIN_HEIGHT),
    TERMINAL_MAX_HEIGHT,
  );
}

export interface IdeLayout {
  explorerOpen: boolean;
  editorOpen: boolean;
  terminalOpen: boolean;
  explorerWidth: number;
  terminalHeight: number;
}

/** First visit: the classic layout, everything showing. */
export const DEFAULT_IDE_LAYOUT: IdeLayout = {
  explorerOpen: true,
  editorOpen: true,
  terminalOpen: true,
  explorerWidth: EXPLORER_DEFAULT_WIDTH,
  terminalHeight: TERMINAL_DEFAULT_HEIGHT,
};

const LAYOUT_KEY = "suma:ideLayout";

export function getStoredIdeLayout(): IdeLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw === null) return DEFAULT_IDE_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return DEFAULT_IDE_LAYOUT;
    const p = parsed as Record<string, unknown>;
    const bool = (v: unknown, fallback: boolean): boolean =>
      typeof v === "boolean" ? v : fallback;
    return {
      explorerOpen: bool(p["explorerOpen"], true),
      editorOpen: bool(p["editorOpen"], true),
      terminalOpen: bool(p["terminalOpen"], true),
      explorerWidth: clampExplorerWidth(Number(p["explorerWidth"])),
      terminalHeight: clampTerminalHeight(Number(p["terminalHeight"])),
    };
  } catch {
    return DEFAULT_IDE_LAYOUT;
  }
}

export function storeIdeLayout(layout: IdeLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Best effort; the layout still works this session.
  }
}

/* ----------------------------- editor buffers ----------------------------- */

export interface IdeBuffer {
  /** What is on disk (as of the last read or save). */
  saved: string;
  /** What is in the editor. Dirty ⇔ differs from `saved`. */
  current: string;
}

/**
 * Unsaved edits, keyed by workspace-relative path. A module-level map, not
 * store state: the strings can be megabytes and change per keystroke — the
 * store carries only the boolean dirty flags the UI renders. The chrome
 * renderer outlives the page, so buffers survive tab switches; they are
 * dropped when the file's editor tab closes.
 */
export const ideBuffers = new Map<string, IdeBuffer>();

export function dropIdeBuffer(path: string): void {
  ideBuffers.delete(path);
}
