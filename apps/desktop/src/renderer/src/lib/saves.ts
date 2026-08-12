/**
 * The Saves panel's device-local presentation state — open/width persistence,
 * exactly the chat sidebar's pattern (lib/chat.ts): localStorage, clamped on
 * every read and write, best-effort when storage is unavailable.
 */

const OPEN_KEY = "suma:savesOpen";
const WIDTH_KEY = "suma:savesWidth";

export const SAVES_DEFAULT_WIDTH = 340;
/** Below this the cards stop being readable; above it the panel crowds the
 *  page the items came from. */
export const SAVES_MIN_WIDTH = 280;
export const SAVES_MAX_WIDTH = 620;

export function clampSavesWidth(px: number): number {
  if (!Number.isFinite(px)) return SAVES_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(px), SAVES_MIN_WIDTH), SAVES_MAX_WIDTH);
}

export function getStoredSavesOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeSavesOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Best effort; the panel still works this session.
  }
}

export function getStoredSavesWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw === null
      ? SAVES_DEFAULT_WIDTH
      : clampSavesWidth(Number.parseInt(raw, 10));
  } catch {
    return SAVES_DEFAULT_WIDTH;
  }
}

export function storeSavesWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(clampSavesWidth(px)));
  } catch {
    // Best effort.
  }
}
