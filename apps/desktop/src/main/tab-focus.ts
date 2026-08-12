/**
 * Which tabs hold which panes after a tab closes (§6 split view).
 *
 * Pure — no Electron, no store — so the rule can be read and tested on its
 * own; TabManager applies the result and re-resolves the layout.
 *
 * A split is two panes holding exactly two tabs, so closing either half leaves
 * ONE page, and one page takes the whole content hole. Both halves of that
 * follow: the survivor is never left half-width beside an empty pane, and a
 * third tab is never pulled into the seat the closed half left behind.
 */

export interface PaneFocus {
  activeId: string | null;
  splitId: string | null;
}

export function focusAfterClose(args: {
  /** Visual order with the closed tab ALREADY removed. */
  order: readonly string[];
  /** The index the closed tab occupied in that order. */
  index: number;
  closedId: string;
  activeId: string | null;
  splitId: string | null;
}): PaneFocus {
  const { order, index, closedId, activeId, splitId } = args;
  // The split half closed: the active tab is the only page left, so it stops
  // being a pane and becomes the whole hole.
  if (splitId === closedId) return { activeId, splitId: null };
  // A background tab closing changes no pane at all.
  if (activeId !== closedId) return { activeId, splitId };
  // The active half closed. Its successor is the OTHER half whenever a split
  // is open — promoting anything else would swap a stranger into a layout the
  // user built from two specific tabs — and otherwise whichever tab slid into
  // the closed tab's place.
  const successor =
    splitId ?? order[Math.min(Math.max(index, 0), order.length - 1)] ?? null;
  return {
    activeId: successor,
    splitId: successor === splitId ? null : splitId,
  };
}
