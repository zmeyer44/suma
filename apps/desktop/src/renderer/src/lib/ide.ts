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

import { isInternalPage } from "../../../shared/internal-pages";

export type IdePanel = "explorer" | "editor" | "terminal";

/** Only a visible Terminal pane consumes the workspace tree. Connection
 * events also fire during onboarding, before this page has ever been opened;
 * treating those as an explorer refresh races the machine's first boot and
 * turns an expected wake/disconnect into a global error toast. */
export function isIdePageVisible(
  tabs: ReadonlyArray<{
    url: string;
    active: boolean;
    split: boolean;
  }>,
): boolean {
  return tabs.some(
    (tab) => (tab.active || tab.split) && isInternalPage(tab.url, "terminal"),
  );
}

/** Transport failures are already represented by the explorer's connecting
 * state and retried on the next workspace connection event. They are not
 * actionable file-operation errors and should never leak into onboarding. */
export function isTransientWorkspaceError(message: string): boolean {
  return (
    message.includes("suma-agent unreachable") ||
    message.includes("suma-agent connection lost") ||
    message.includes("vfs channel lost") ||
    message.includes("agent client stopped")
  );
}

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
    if (parsed === null || typeof parsed !== "object")
      return DEFAULT_IDE_LAYOUT;
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

export interface IdeWorkspaceView {
  openFiles: string[];
  activeFile: string | null;
  dirty: Record<string, boolean>;
}

/** A path is only meaningful together with the machine and space behind it. */
export function ideWorkspaceKey(
  source: "sim" | "remote" | null,
  activeSpaceId: string | null,
  computeMode: "cloud" | "local" | null,
): string {
  return JSON.stringify([source ?? "unknown", computeMode, activeSpaceId]);
}

function ideBufferKey(workspaceKey: string, path: string): string {
  return JSON.stringify([workspaceKey, path]);
}

/**
 * Unsaved edits, keyed by workspace identity AND relative path. A module-level
 * map, not store state: the strings can be megabytes and change per keystroke
 * — the store carries only the boolean dirty flags the UI renders. Keeping the
 * identity in the key prevents `README.md` from one space being saved over the
 * same relative path after a machine or space switch.
 */
const ideBuffers = new Map<string, IdeBuffer>();
const ideWorkspaceViews = new Map<string, IdeWorkspaceView>();

export function getIdeBuffer(
  workspaceKey: string,
  path: string,
): IdeBuffer | undefined {
  return ideBuffers.get(ideBufferKey(workspaceKey, path));
}

export function setIdeBuffer(
  workspaceKey: string,
  path: string,
  buffer: IdeBuffer,
): void {
  ideBuffers.set(ideBufferKey(workspaceKey, path), buffer);
}

export function dropIdeBuffer(workspaceKey: string, path: string): void {
  ideBuffers.delete(ideBufferKey(workspaceKey, path));
}

/** Move buffers when the renderer learns the initial source after loading. */
export function moveIdeBuffers(
  fromWorkspaceKey: string,
  toWorkspaceKey: string,
  paths: readonly string[],
): void {
  if (fromWorkspaceKey === toWorkspaceKey) return;
  for (const path of paths) {
    const from = ideBufferKey(fromWorkspaceKey, path);
    const buffer = ideBuffers.get(from);
    if (buffer === undefined) continue;
    const to = ideBufferKey(toWorkspaceKey, path);
    if (!ideBuffers.has(to)) ideBuffers.set(to, buffer);
    ideBuffers.delete(from);
  }
}

export function stashIdeWorkspaceView(
  workspaceKey: string,
  view: IdeWorkspaceView,
): void {
  ideWorkspaceViews.set(workspaceKey, {
    openFiles: [...view.openFiles],
    activeFile: view.activeFile,
    dirty: { ...view.dirty },
  });
}

export function restoreIdeWorkspaceView(
  workspaceKey: string,
): IdeWorkspaceView {
  const view = ideWorkspaceViews.get(workspaceKey);
  return view === undefined
    ? { openFiles: [], activeFile: null, dirty: {} }
    : {
        openFiles: [...view.openFiles],
        activeFile: view.activeFile,
        dirty: { ...view.dirty },
      };
}
