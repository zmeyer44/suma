/**
 * Page-selection toolbar contract, shared by main (which positions the
 * floating toolbar view and caches the live selection) and both renderers
 * (the toolbar surface itself, and the chrome that performs the actions).
 */

/** A selection's bounding rect, in viewport coordinates of its tab view. */
export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The selected text plus where it came from — what both actions consume. */
export interface SelectionActionPayload {
  text: string;
  url: string;
  title: string;
}

export type SelectionToolbarAction = "readAloud" | "addToChat";

/**
 * The toolbar view is sized to EXACTLY these dimensions: like the
 * save-preview overlay, the view swallows clicks over its whole rect, so any
 * slack would deaden a strip of the page around the buttons. The renderer
 * draws the same fixed box, which is what lets main place the view without a
 * measurement round trip.
 */
export const SELECTION_TOOLBAR_WIDTH = 224;
export const SELECTION_TOOLBAR_HEIGHT = 34;
/** Breathing room between the toolbar and the selection / pane edges. */
export const SELECTION_TOOLBAR_GAP = 8;
