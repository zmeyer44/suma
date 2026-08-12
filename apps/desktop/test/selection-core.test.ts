import { describe, expect, it } from "vitest";
import {
  sanitizeSelectionSignal,
  SELECTION_MAX_CHARS,
  selectionToolbarBounds,
} from "../src/main/selection-core";
import {
  SELECTION_TOOLBAR_GAP,
  SELECTION_TOOLBAR_HEIGHT,
  SELECTION_TOOLBAR_WIDTH,
} from "../src/shared/selection";

describe("sanitizeSelectionSignal", () => {
  it("passes a well-formed show signal through, rounded", () => {
    const signal = sanitizeSelectionSignal({
      kind: "show",
      text: "  hello world  ",
      rect: { x: 10.4, y: 20.6, width: 100, height: 18 },
    });
    expect(signal).toEqual({
      kind: "show",
      text: "hello world",
      rect: { x: 10, y: 21, width: 100, height: 18 },
    });
  });

  it("passes clear through", () => {
    expect(sanitizeSelectionSignal({ kind: "clear" })).toEqual({ kind: "clear" });
  });

  it("clamps runaway text to the selection budget", () => {
    const signal = sanitizeSelectionSignal({
      kind: "show",
      text: "x".repeat(SELECTION_MAX_CHARS * 2),
      rect: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(signal?.kind).toBe("show");
    if (signal?.kind === "show") {
      expect(signal.text).toHaveLength(SELECTION_MAX_CHARS);
    }
  });

  it("rejects garbage wholesale: wrong shapes, empty text, bad rects", () => {
    expect(sanitizeSelectionSignal(null)).toBeNull();
    expect(sanitizeSelectionSignal("show")).toBeNull();
    expect(sanitizeSelectionSignal({ kind: "explode" })).toBeNull();
    expect(
      sanitizeSelectionSignal({ kind: "show", text: "   ", rect: { x: 0, y: 0, width: 1, height: 1 } }),
    ).toBeNull();
    expect(sanitizeSelectionSignal({ kind: "show", text: "hi" })).toBeNull();
    expect(
      sanitizeSelectionSignal({ kind: "show", text: "hi", rect: { x: Number.NaN, y: 0, width: 1, height: 1 } }),
    ).toBeNull();
    expect(
      sanitizeSelectionSignal({ kind: "show", text: "hi", rect: { x: 0, y: 0, width: -5, height: 1 } }),
    ).toBeNull();
    expect(
      sanitizeSelectionSignal({ kind: "show", text: "hi", rect: { x: 2e6, y: 0, width: 1, height: 1 } }),
    ).toBeNull();
  });
});

describe("selectionToolbarBounds", () => {
  const pane = { x: 100, y: 48, width: 1000, height: 700 };

  it("centers above the selection when there is headroom", () => {
    const rect = { x: 400, y: 300, width: 200, height: 20 };
    const bounds = selectionToolbarBounds(pane, rect);
    expect(bounds).toEqual({
      x: Math.round(100 + 400 + 100 - SELECTION_TOOLBAR_WIDTH / 2),
      y: 48 + 300 - SELECTION_TOOLBAR_HEIGHT - SELECTION_TOOLBAR_GAP,
      width: SELECTION_TOOLBAR_WIDTH,
      height: SELECTION_TOOLBAR_HEIGHT,
    });
  });

  it("flips below when the selection hugs the pane top", () => {
    const rect = { x: 400, y: 10, width: 200, height: 20 };
    const bounds = selectionToolbarBounds(pane, rect);
    expect(bounds?.y).toBe(48 + 10 + 20 + SELECTION_TOOLBAR_GAP);
  });

  it("stays inside the pane when the selection hugs an edge", () => {
    const left = selectionToolbarBounds(pane, { x: 0, y: 300, width: 10, height: 20 });
    expect(left?.x).toBe(pane.x + SELECTION_TOOLBAR_GAP);
    const right = selectionToolbarBounds(pane, { x: 990, y: 300, width: 10, height: 20 });
    expect(right?.x).toBe(pane.x + pane.width - SELECTION_TOOLBAR_WIDTH - SELECTION_TOOLBAR_GAP);
    // Bottom edge: below would leave the pane, so it clamps up inside it.
    const bottom = selectionToolbarBounds(pane, { x: 400, y: 5, width: 10, height: 690 });
    expect(bottom?.y).toBe(pane.y + pane.height - SELECTION_TOOLBAR_HEIGHT - SELECTION_TOOLBAR_GAP);
  });

  it("hides when the rect is scrolled out of the viewport", () => {
    expect(selectionToolbarBounds(pane, { x: 0, y: -100, width: 10, height: 20 })).toBeNull();
    expect(selectionToolbarBounds(pane, { x: 0, y: 800, width: 10, height: 20 })).toBeNull();
  });

  it("hides in a pane too small to host the toolbar", () => {
    expect(
      selectionToolbarBounds(
        { x: 0, y: 0, width: SELECTION_TOOLBAR_WIDTH, height: 700 },
        { x: 0, y: 100, width: 10, height: 10 },
      ),
    ).toBeNull();
  });
});
