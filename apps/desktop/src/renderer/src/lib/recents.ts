/**
 * Dismissals for the URL bar's recent-site chips (the ✕ on hover).
 *
 * A dismissal is "stop suggesting this site — until I visit it again": it
 * records WHEN the ✕ was pressed, and the chips row skips a host only while
 * its latest visit predates that moment, so fresh browsing naturally
 * resurrects the chip. Device-local presentation state in localStorage, like
 * the split ratios — history itself is never touched.
 */

const STORAGE_KEY = "suma.dismissedRecents";
/** Oldest dismissals fall off past this — the map must not grow unbounded. */
const MAX_DISMISSALS = 100;

export function loadDismissedRecents(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const map: Record<string, number> = {};
    for (const [host, atMs] of Object.entries(parsed)) {
      if (typeof atMs === "number" && Number.isFinite(atMs)) map[host] = atMs;
    }
    return map;
  } catch {
    return {};
  }
}

/** The map with `host` dismissed as of `atMs`, capped and persisted. */
export function dismissRecent(
  map: Record<string, number>,
  host: string,
  atMs: number,
): Record<string, number> {
  const next = Object.fromEntries(
    Object.entries({ ...map, [host]: atMs })
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_DISMISSALS),
  );
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota/privacy failures just lose persistence, never the dismissal.
  }
  return next;
}
