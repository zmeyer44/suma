/**
 * Pane-layout geometry (PRD §6 split view), shared by BOTH processes.
 *
 * Main resolves each tab WebContentsView's absolute bounds from it;
 * the renderer resolves divider positions from the same functions on the
 * same inputs — which is what keeps the draggable splitline pixel-aligned
 * with the seam between the views without any cross-process negotiation.
 *
 * The engine is a recursive layout tree (row/column splits, weighted
 * children, a fixed gap between siblings) even though today's only layout is
 * a single two-child row: multi-pane and mixed-orientation layouts later are
 * deeper trees, not a new mechanism. Pure — no Electron, no DOM.
 */

import type { ContentBounds } from "./ipc";

/** Which slot of the content hole a tab view occupies (assigned by main). */
export type PaneRegion = "full" | "left" | "right";

/** Visual gap between sibling panes — also the divider's hit target, since
 *  the chrome shows through (and receives mouse events) exactly there. */
export const SPLIT_GAP_PX = 6;

/**
 * Below this content width a split stops being two usable pages and starts
 * being two crushed ones — the layout collapses the right pane and lets the
 * left pane take the full hole. (The split assignment itself is untouched;
 * widening the window brings the pane back.)
 */
export const MIN_SPLIT_CONTENT_WIDTH_PX = 760;

/** No drag may crush a pane below this. */
export const MIN_PANE_SIZE_PX = 280;

export const DEFAULT_SPLIT_RATIO = 0.5;

/* ------------------------------------------------------------------ *
 * Layout tree
 * ------------------------------------------------------------------ */

export type SplitDirection = "row" | "column";

/** A leaf: one pane region a tab view can be assigned to. */
export interface PaneLeaf {
  pane: string;
}

/** An n-way split along one axis; `sizes` are relative weights per child. */
export interface PaneSplit {
  direction: SplitDirection;
  sizes: number[];
  children: PaneLayoutNode[];
}

export type PaneLayoutNode = PaneLeaf | PaneSplit;

function isSplit(node: PaneLayoutNode): node is PaneSplit {
  return "children" in node;
}

/**
 * Resolve a layout tree to absolute, integer-edged bounds per pane.
 * Children tile their axis exactly: every child but the last gets
 * `floor(available * weight)`, the last takes the remainder — no spill, no
 * drift, and fractional view bounds (which blur page rendering) can't occur.
 */
export function resolvePaneBounds(
  node: PaneLayoutNode,
  bounds: ContentBounds,
  gap: number = SPLIT_GAP_PX,
): Map<string, ContentBounds> {
  const out = new Map<string, ContentBounds>();
  resolveInto(node, bounds, gap, out);
  return out;
}

function resolveInto(
  node: PaneLayoutNode,
  bounds: ContentBounds,
  gap: number,
  out: Map<string, ContentBounds>,
): void {
  if (!isSplit(node)) {
    out.set(node.pane, { ...bounds });
    return;
  }
  const axis = node.direction === "row" ? bounds.width : bounds.height;
  const available = axis - gap * (node.children.length - 1);
  const totalWeight = node.sizes.reduce((sum, s) => sum + s, 0);
  let cursor = node.direction === "row" ? bounds.x : bounds.y;
  let remaining = available;
  node.children.forEach((child, i) => {
    const last = i === node.children.length - 1;
    const size = last
      ? remaining
      : Math.floor((available * (node.sizes[i] ?? 0)) / totalWeight);
    remaining -= size;
    const childBounds: ContentBounds =
      node.direction === "row"
        ? { x: cursor, y: bounds.y, width: size, height: bounds.height }
        : { x: bounds.x, y: cursor, width: bounds.width, height: size };
    resolveInto(child, childBounds, gap, out);
    cursor += size + gap;
  });
}

/* ------------------------------------------------------------------ *
 * Today's layout: the §6 two-pane horizontal split
 * ------------------------------------------------------------------ */

/** Clamp a drag ratio so neither pane of a 2-way split drops below
 *  MIN_PANE_SIZE_PX; non-finite input falls back to the default. */
export function clampSplitRatio(ratio: number, axisPx: number, gap: number = SPLIT_GAP_PX): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  const available = axisPx - gap;
  if (available <= 0) return DEFAULT_SPLIT_RATIO;
  const min = Math.min(MIN_PANE_SIZE_PX / available, 0.5);
  return Math.min(Math.max(ratio, min), 1 - min);
}

/**
 * The split-view layout for a content hole of `contentWidth`: a two-child
 * row, or a lone left pane when the hole is too narrow to split.
 */
export function splitViewLayout(contentWidth: number, ratio: number): PaneLayoutNode {
  if (contentWidth < MIN_SPLIT_CONTENT_WIDTH_PX) return { pane: "left" };
  const r = clampSplitRatio(ratio, contentWidth);
  return {
    direction: "row",
    sizes: [r, 1 - r],
    children: [{ pane: "left" }, { pane: "right" }],
  };
}

/** Bounds for one region of the content hole. `null` means "do not show
 *  this view" (the collapsed right pane of a too-narrow split). */
export function paneBoundsFor(
  content: ContentBounds,
  region: PaneRegion,
  ratio: number = DEFAULT_SPLIT_RATIO,
): ContentBounds | null {
  if (region === "full") return { ...content };
  return resolvePaneBounds(splitViewLayout(content.width, ratio), content).get(region) ?? null;
}
