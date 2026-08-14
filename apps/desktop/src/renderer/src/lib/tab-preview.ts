/**
 * Hover intent for the tab preview shelf (TabPreviewStrip).
 *
 * Both hover zones — the tab row in the strip and the shelf itself — report
 * enter/leave here, and one pair of timers turns those edges into open/close.
 * Module-level on purpose: the zones live in two components, and the pointer
 * crossing from one into the other must read as "still inside", not as a
 * leave that closes the shelf mid-hop.
 *
 * Opening waits HOVER_OPEN_MS so a pointer merely passing through the strip
 * (or heading for a tab to click it) never yanks the page down; closing waits
 * HOVER_CLOSE_MS so a grazing exit doesn't slam it shut.
 */
import { useSumaStore } from "../store";

const HOVER_OPEN_MS = 450;
const HOVER_CLOSE_MS = 300;

let openTimer: number | null = null;
let closeTimer: number | null = null;

function clearTimers(): void {
  if (openTimer !== null) {
    window.clearTimeout(openTimer);
    openTimer = null;
  }
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
}

export function previewZoneEnter(): void {
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
  const state = useSumaStore.getState();
  if (state.tabPreviewOpen || openTimer !== null) return;
  openTimer = window.setTimeout(() => {
    openTimer = null;
    const now = useSumaStore.getState();
    // Checked at fire time, not arm time: a drag can start under a pending
    // timer. One tab has nothing to compare — the shelf earns its slide only
    // when there is a choice to make.
    if (now.tabDragging || now.tabs.length < 2) return;
    now.setTabPreviewOpen(true);
  }, HOVER_OPEN_MS);
}

export function previewZoneLeave(): void {
  if (openTimer !== null) {
    window.clearTimeout(openTimer);
    openTimer = null;
  }
  if (!useSumaStore.getState().tabPreviewOpen) return;
  if (closeTimer !== null) window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => {
    closeTimer = null;
    useSumaStore.getState().setTabPreviewOpen(false);
  }, HOVER_CLOSE_MS);
}

/** Immediate dismissal (a thumbnail was clicked) — no grace period. */
export function previewDismiss(): void {
  clearTimers();
  useSumaStore.getState().setTabPreviewOpen(false);
}
