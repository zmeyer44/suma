/**
 * Join class strings, dropping the falsy ones.
 *
 * The shadcn originals call a `cn()` built on clsx + tailwind-merge. Suma's
 * chrome carries neither, so every component in the renderer composes its
 * classes through this instead. The one thing it does NOT do is
 * tailwind-merge's conflict resolution: passing `px-0` to a
 * component whose base sets `px-3` does not reliably win, because the victor
 * is decided by Tailwind's generated source order, not by class-list position.
 * Override with a different utility family, or edit the component.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}
