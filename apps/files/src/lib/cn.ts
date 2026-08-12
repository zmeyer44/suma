/**
 * Join class strings, dropping the falsy ones.
 *
 * Mirrors `apps/desktop/src/renderer/src/lib/cn.ts`: a plain join, with none of
 * tailwind-merge's conflict resolution. Passing `px-0` to a component whose base
 * sets `px-3` does not reliably win — the victor is decided by Tailwind's
 * generated source order, not by class-list position.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}
