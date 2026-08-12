/**
 * Selection core — the pure half of the page-selection toolbar (like
 * tts-core / saves-core): the script injected into tab pages, the sanitizer
 * for what it hands back, and the toolbar placement geometry. Effects (the
 * WebContentsViews, the re-arm loop) live in shell-window.ts and tabs.ts.
 *
 * Tab pages are sandboxed with NO preload (tabs.ts), so the watcher follows
 * the CAPTURE_SCRIPT precedent: `executeJavaScript` into the page's main
 * world. Instead of polling, the script is a LONG-POLL — each injection
 * returns a promise that resolves on the next meaningful selection change
 * (settled selection, or cleared), and main re-arms it after every answer.
 * Everything that resolves is UNTRUSTED page-world data: a hostile page can
 * fabricate any payload, which is why it is clamped and validated here and
 * why acting on it never does more than show two buttons over that page.
 */

import type { ContentBounds } from "../shared/ipc";
import {
  SELECTION_TOOLBAR_GAP,
  SELECTION_TOOLBAR_HEIGHT,
  SELECTION_TOOLBAR_WIDTH,
  type SelectionRect,
} from "../shared/selection";

/** In-page clamp, so a select-all on a heavy page never ships megabytes. */
export const SELECTION_MAX_CHARS = 4000;

/** What one long-poll resolves with: a settled selection, or none. */
export type SelectionSignal =
  | { kind: "clear" }
  | { kind: "show"; text: string; rect: SelectionRect };

/**
 * Runs inside the tab via `executeJavaScript`; evaluates to a promise for
 * the NEXT selection change. First injection installs the listeners once
 * (idempotent via the window global); every injection returns a fresh
 * waiter. A change that lands between two waits is queued so it is never
 * lost, and consecutive "clear"s are coalesced so scroll storms cost one
 * round trip, not one per event.
 */
export const SELECTION_WAIT_SCRIPT = `(() => {
  const g = window;
  if (!g.__sumaSelectionWait) {
    let pending = null;
    let queued = null;
    let lastKind = "clear";
    const snapshot = () => {
      const sel = g.getSelection();
      const text = sel ? String(sel).slice(0, ${String(SELECTION_MAX_CHARS)}).trim() : "";
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || text === "") {
        return { kind: "clear" };
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return { kind: "clear" };
      return {
        kind: "show",
        text,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      };
    };
    const fire = (payload) => {
      if (payload.kind === "clear" && lastKind === "clear") return;
      lastKind = payload.kind;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve(payload);
      } else {
        queued = payload;
      }
    };
    // mouseup after the click has settled the selection (a double-click's
    // word selection lands after the event itself).
    document.addEventListener("mouseup", () => {
      setTimeout(() => fire(snapshot()), 0);
    }, true);
    // Keyboard selection: shift+arrows (keyup with shift held, or the Shift
    // release itself) and select-all.
    document.addEventListener("keyup", (ev) => {
      if (ev.shiftKey || ev.key === "Shift" || ((ev.metaKey || ev.ctrlKey) && ev.key === "a")) {
        fire(snapshot());
      }
    }, true);
    // Collapsing (click elsewhere, Escape, programmatic) hides the toolbar.
    document.addEventListener("selectionchange", () => {
      const sel = g.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) fire({ kind: "clear" });
    });
    // The rect goes stale the moment the page moves under it — hide rather
    // than track.
    g.addEventListener("scroll", () => fire({ kind: "clear" }), true);
    g.addEventListener("resize", () => fire({ kind: "clear" }));
    g.__sumaSelectionWait = () => new Promise((resolve) => {
      if (queued !== null) {
        const payload = queued;
        queued = null;
        resolve(payload);
        return;
      }
      pending = resolve;
    });
  }
  return g.__sumaSelectionWait();
})()`;

/** Rect coordinates beyond this are nonsense, not geometry. */
const MAX_RECT_COORD = 1_000_000;

function finiteCoord(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (Math.abs(value) > MAX_RECT_COORD) return null;
  return Math.round(value);
}

/**
 * Validate one long-poll answer. Null means the payload was not even
 * shaped like a signal — the page is answering with garbage, so the caller
 * should stop believing it rather than retry.
 */
export function sanitizeSelectionSignal(raw: unknown): SelectionSignal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record["kind"] === "clear") return { kind: "clear" };
  if (record["kind"] !== "show") return null;
  const text =
    typeof record["text"] === "string"
      ? record["text"].slice(0, SELECTION_MAX_CHARS).trim()
      : "";
  if (text === "") return null;
  const rectRaw = record["rect"];
  if (typeof rectRaw !== "object" || rectRaw === null) return null;
  const rect = rectRaw as Record<string, unknown>;
  const x = finiteCoord(rect["x"]);
  const y = finiteCoord(rect["y"]);
  const width = finiteCoord(rect["width"]);
  const height = finiteCoord(rect["height"]);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 0 || height < 0) return null;
  return { kind: "show", text, rect: { x, y, width, height } };
}

/**
 * Where the toolbar view sits for a selection rect (viewport coordinates of
 * the pane's view) inside its pane (window coordinates) — pure, for the
 * tests. Above the selection when there is room, below it otherwise, and
 * always clamped inside the pane; null ⇒ nowhere sensible ⇒ stay hidden.
 */
export function selectionToolbarBounds(
  pane: ContentBounds,
  rect: SelectionRect,
): ContentBounds | null {
  const width = SELECTION_TOOLBAR_WIDTH;
  const height = SELECTION_TOOLBAR_HEIGHT;
  const gap = SELECTION_TOOLBAR_GAP;
  if (pane.width < width + gap * 2 || pane.height < height + gap * 2) return null;
  // A rect scrolled out of the viewport has nothing to anchor to.
  if (rect.y + rect.height < 0 || rect.y > pane.height) return null;
  const centerX = pane.x + rect.x + rect.width / 2;
  const x = Math.round(
    Math.min(
      Math.max(centerX - width / 2, pane.x + gap),
      pane.x + pane.width - width - gap,
    ),
  );
  const above = pane.y + rect.y - height - gap;
  const below = pane.y + rect.y + rect.height + gap;
  const y =
    above >= pane.y + gap
      ? above
      : Math.min(below, pane.y + pane.height - height - gap);
  return { x, y: Math.round(y), width, height };
}
