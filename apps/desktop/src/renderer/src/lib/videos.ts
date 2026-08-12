/**
 * The Videos panel's device-local presentation state — open/width
 * persistence, exactly the Saves panel's pattern (lib/saves.ts).
 */

const OPEN_KEY = "suma:videosOpen";
const WIDTH_KEY = "suma:videosWidth";

export const VIDEOS_DEFAULT_WIDTH = 340;
export const VIDEOS_MIN_WIDTH = 280;
export const VIDEOS_MAX_WIDTH = 620;

export function clampVideosWidth(px: number): number {
  if (!Number.isFinite(px)) return VIDEOS_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(px), VIDEOS_MIN_WIDTH), VIDEOS_MAX_WIDTH);
}

export function getStoredVideosOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeVideosOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Best effort; the panel still works this session.
  }
}

export function getStoredVideosWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw === null
      ? VIDEOS_DEFAULT_WIDTH
      : clampVideosWidth(Number.parseInt(raw, 10));
  } catch {
    return VIDEOS_DEFAULT_WIDTH;
  }
}

export function storeVideosWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(clampVideosWidth(px)));
  } catch {
    // Best effort.
  }
}
