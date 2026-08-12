import { describe, expect, it } from "vitest";
import {
  clampSplitRatio,
  DEFAULT_SPLIT_RATIO,
  MIN_PANE_SIZE_PX,
  MIN_SPLIT_CONTENT_WIDTH_PX,
  paneBoundsFor,
  resolvePaneBounds,
  SPLIT_GAP_PX,
  splitViewLayout,
  type PaneLayoutNode,
} from "../src/shared/pane-layout";

const HOLE = { x: 240, y: 0, width: 1040, height: 820 };

describe("paneBoundsFor (§6 split view geometry)", () => {
  it("gives a full-region view the whole content hole", () => {
    expect(paneBoundsFor(HOLE, "full")).toEqual(HOLE);
  });

  it("splits the hole into two panes separated by the gap", () => {
    const left = paneBoundsFor(HOLE, "left");
    const right = paneBoundsFor(HOLE, "right");
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    if (left === null || right === null) return;
    expect(left.x).toBe(HOLE.x);
    expect(right.x).toBe(left.x + left.width + SPLIT_GAP_PX);
    // The two panes and the gap tile the hole exactly — no spill, no gap drift.
    expect(left.width + SPLIT_GAP_PX + right.width).toBe(HOLE.width);
    expect(left.height).toBe(HOLE.height);
    expect(right.height).toBe(HOLE.height);
  });

  it("keeps pane edges integral for any hole width and ratio", () => {
    for (const width of [MIN_SPLIT_CONTENT_WIDTH_PX, 801, 1033, 1440]) {
      for (const ratio of [0.3333, 0.5, 0.617]) {
        const hole = { ...HOLE, width };
        for (const region of ["left", "right"] as const) {
          const bounds = paneBoundsFor(hole, region, ratio);
          expect(bounds).not.toBeNull();
          if (bounds === null) continue;
          expect(Number.isInteger(bounds.x)).toBe(true);
          expect(Number.isInteger(bounds.width)).toBe(true);
        }
      }
    }
  });

  it("collapses the split below the minimum width instead of crushing both panes", () => {
    const narrow = { ...HOLE, width: MIN_SPLIT_CONTENT_WIDTH_PX - 1 };
    expect(paneBoundsFor(narrow, "left")).toEqual(narrow);
    expect(paneBoundsFor(narrow, "right")).toBeNull();
  });

  it("moves the seam with the ratio", () => {
    const wide = paneBoundsFor(HOLE, "left", 0.7);
    const slim = paneBoundsFor(HOLE, "left", 0.3);
    expect(wide).not.toBeNull();
    expect(slim).not.toBeNull();
    if (wide === null || slim === null) return;
    expect(wide.width).toBe(Math.floor((HOLE.width - SPLIT_GAP_PX) * 0.7));
    expect(wide.width).toBeGreaterThan(slim.width);
    // Both still tile exactly.
    const right = paneBoundsFor(HOLE, "right", 0.7);
    expect(right).not.toBeNull();
    if (right !== null) expect(wide.width + SPLIT_GAP_PX + right.width).toBe(HOLE.width);
  });
});

describe("clampSplitRatio (drag limits)", () => {
  it("refuses to crush a pane below MIN_PANE_SIZE_PX", () => {
    const available = HOLE.width - SPLIT_GAP_PX;
    const min = MIN_PANE_SIZE_PX / available;
    expect(clampSplitRatio(0, HOLE.width)).toBeCloseTo(min);
    expect(clampSplitRatio(1, HOLE.width)).toBeCloseTo(1 - min);
    expect(clampSplitRatio(0.5, HOLE.width)).toBe(0.5);
  });

  it("falls back to the default on garbage input", () => {
    expect(clampSplitRatio(Number.NaN, HOLE.width)).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampSplitRatio(Number.POSITIVE_INFINITY, HOLE.width)).toBe(DEFAULT_SPLIT_RATIO);
    expect(clampSplitRatio(0.5, 0)).toBe(DEFAULT_SPLIT_RATIO);
  });

  it("keeps the clamped ratio inside splitViewLayout", () => {
    const layout = splitViewLayout(HOLE.width, 0.01);
    const bounds = resolvePaneBounds(layout, HOLE);
    const left = bounds.get("left");
    expect(left).toBeDefined();
    if (left !== undefined) expect(left.width).toBeGreaterThanOrEqual(MIN_PANE_SIZE_PX);
  });
});

describe("resolvePaneBounds (generic layout tree)", () => {
  it("tiles an n-way row exactly, gaps included", () => {
    const layout: PaneLayoutNode = {
      direction: "row",
      sizes: [1, 2, 1],
      children: [{ pane: "a" }, { pane: "b" }, { pane: "c" }],
    };
    const bounds = resolvePaneBounds(layout, HOLE);
    const [a, b, c] = [bounds.get("a"), bounds.get("b"), bounds.get("c")];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    if (a === undefined || b === undefined || c === undefined) return;
    expect(a.x).toBe(HOLE.x);
    expect(b.x).toBe(a.x + a.width + SPLIT_GAP_PX);
    expect(c.x).toBe(b.x + b.width + SPLIT_GAP_PX);
    expect(a.width + b.width + c.width + 2 * SPLIT_GAP_PX).toBe(HOLE.width);
    // Weight 2 gets about twice the space of weight 1.
    expect(b.width).toBeGreaterThan(a.width * 1.9);
  });

  it("resolves nested mixed-orientation trees", () => {
    const layout: PaneLayoutNode = {
      direction: "row",
      sizes: [1, 1],
      children: [
        { pane: "main" },
        {
          direction: "column",
          sizes: [3, 1],
          children: [{ pane: "top" }, { pane: "bottom" }],
        },
      ],
    };
    const bounds = resolvePaneBounds(layout, HOLE);
    const [main, top, bottom] = [bounds.get("main"), bounds.get("top"), bounds.get("bottom")];
    expect(main).toBeDefined();
    expect(top).toBeDefined();
    expect(bottom).toBeDefined();
    if (main === undefined || top === undefined || bottom === undefined) return;
    expect(main.height).toBe(HOLE.height);
    expect(top.x).toBe(bottom.x);
    expect(top.width).toBe(bottom.width);
    expect(top.y).toBe(HOLE.y);
    expect(bottom.y).toBe(top.y + top.height + SPLIT_GAP_PX);
    expect(top.height + SPLIT_GAP_PX + bottom.height).toBe(HOLE.height);
    for (const b of [main, top, bottom]) {
      expect(Number.isInteger(b.x)).toBe(true);
      expect(Number.isInteger(b.y)).toBe(true);
      expect(Number.isInteger(b.width)).toBe(true);
      expect(Number.isInteger(b.height)).toBe(true);
    }
  });
});
