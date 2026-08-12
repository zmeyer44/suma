/**
 * The empty state's greeting line — "Good morning, Zach", "What can we tackle
 * today?" — picked by time of day and whether we know who we're talking to.
 *
 * Pure on purpose: the caller supplies the hour and a random seed, so the
 * pick is testable and stays put for the life of a mount instead of
 * reshuffling on every render.
 */

export type DayPeriod = "morning" | "afternoon" | "evening" | "late-night";

export function periodOfDay(hour: number): DayPeriod {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "late-night";
}

/** "Zach Meyer" → "Zach"; empty/whitespace names count as unknown. */
export function firstNameOf(displayName: string | null): string | null {
  const first = displayName?.trim().split(/\s+/)[0] ?? "";
  return first.length > 0 ? first : null;
}

/** A candidate line; returns null when it needs a name we don't have. */
type Line = (name: string | null) => string | null;

const named =
  (make: (name: string) => string): Line =>
  (name) =>
    name === null ? null : make(name);

const anon =
  (text: string): Line =>
  () =>
    text;

const POOLS: Record<DayPeriod, Line[]> = {
  morning: [
    named((n) => `Good morning, ${n}`),
    named((n) => `Morning, ${n} — where to first?`),
    named((n) => `${n}'s up and at it`),
    anon("Good morning — where to first?"),
    anon("What can we tackle today?"),
    anon("Fresh day, fresh tab"),
  ],
  afternoon: [
    named((n) => `Good afternoon, ${n}`),
    named((n) => `${n}'s back!`),
    named((n) => `Welcome back, ${n}`),
    anon("What can we tackle this afternoon?"),
    anon("Where to next?"),
    anon("Back at it?"),
  ],
  evening: [
    named((n) => `Good evening, ${n}`),
    named((n) => `Evening, ${n}`),
    named((n) => `${n}'s back!`),
    anon("Winding down or diving in?"),
    anon("Where to this evening?"),
    anon("The evening is yours"),
  ],
  "late-night": [
    named((n) => `Up late, ${n}?`),
    named((n) => `Burning the midnight oil, ${n}?`),
    anon("Time for some late-night browsing"),
    anon("Night-owl hours"),
    anon("The internet never sleeps"),
  ],
};

/**
 * Pick a greeting. `seed` is any number in [0, 1) — pass Math.random() once
 * and hold onto it; the same seed with the same context returns the same line.
 */
export function greetingFor(args: {
  displayName: string | null;
  hour: number;
  seed: number;
}): string {
  const name = firstNameOf(args.displayName);
  const lines = POOLS[periodOfDay(args.hour)]
    .map((line) => line(name))
    .filter((text): text is string => text !== null);
  const index = Math.min(
    Math.floor(args.seed * lines.length),
    lines.length - 1,
  );
  // Every pool has anonymous lines, so this only guards the type system.
  return lines[Math.max(index, 0)] ?? "Where to next?";
}
