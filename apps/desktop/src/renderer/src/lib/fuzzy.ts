/**
 * Pure fuzzy subsequence matcher for the command bar. No DOM, no deps —
 * unit-tested in vitest's node environment.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the original text that matched, in order. */
  positions: number[];
}

const WORD_START_BONUS = 3;
const CONSECUTIVE_BONUS = 2;
const BASE_CHAR_SCORE = 1;

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text.charAt(index - 1);
  return !/[a-z0-9]/i.test(prev);
}

/**
 * Greedy left-to-right subsequence match. Returns null when `query` is not a
 * subsequence of `text`; an empty query matches everything with score 0.
 * Word-start and consecutive hits score higher; earlier first hits win ties.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  const t = text.toLowerCase();

  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += BASE_CHAR_SCORE;
    if (isWordStart(text, found)) score += WORD_START_BONUS;
    const last = positions[positions.length - 1];
    if (last !== undefined && found === last + 1) score += CONSECUTIVE_BONUS;
    positions.push(found);
    ti = found + 1;
  }

  const first = positions[0];
  if (first !== undefined) {
    // Prefer matches that start early without letting position dominate.
    score += Math.max(0, 4 - Math.min(4, Math.floor(first / 4)));
  }
  return { score, positions };
}

/** Filters + ranks `items` by fuzzy score over `keyOf(item)`, best first (stable). */
export function fuzzyFilter<T>(items: ReadonlyArray<T>, query: string, keyOf: (item: T) => string): T[] {
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const m = fuzzyMatch(query, keyOf(item));
    if (m !== null) scored.push({ item, score: m.score, index });
  });
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
  return scored.map((s) => s.item);
}
