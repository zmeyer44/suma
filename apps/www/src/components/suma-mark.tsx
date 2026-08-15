import { cn } from "@/lib/utils";

/**
 * The mark's geometry, trimmed to the artwork itself — the drawing carries its
 * own margin, and a box with slack in it would make the mark sit small and
 * off-centre next to the wordmark. Shared with the OpenGraph card, so the
 * social image cannot drift from the logo in the nav.
 */
export const MARK_BOX = {
  x: 4,
  y: 16.2,
  width: 142.44,
  height: 117.6,
} as const;

/**
 * A meridian globe. One closed path: the graticule is drawn as holes in a solid
 * disc rather than as strokes over it, so the mark holds its weight at 24px in
 * the nav and survives any background it is set on.
 */
export const MARK_PATH =
  "m75 16.2c-36.1 0-71 22.8-71 58.3s32.3 59.3 71 59.3c36-0.1 65.9-20.8 70.6-47 6.3-32.5-23.5-70.6-70.6-70.6zm-30.8 17.3v1.3l-2.4 3.2c-0.9-0.1-3.1-1-3-1.7 1-1.2 3.1-1.4 5.4-2.8zm-13.9 9.4zm-1.2-0.3h0.2-0.2zm1 26.5h-16.4v-0.1c1.3-9 5.8-16.9 15-26.2l7.9 3.5c-3 6.3-5.2 14.7-5.6 22.6l-0.9 0.2zm-0.7 37.6c-0.3 0.2-0.7-0.1-0.9-0.2-7.1-5.6-13.8-15.8-15.1-26.5 0.2-0.6 0.2-0.6 0.4-0.6h16.3c0.4 0 0.6 0.2 0.6 0.5 0.7 6.6 2.2 14.2 5.7 21.4l-0.5 0.7c-2.1 1.2-5 3.4-6.5 4.7zm8.8 7.1-0.2-0.1c-0.3-0.4 2.2-2.2 2.4-2.4l0.5 0.1c1.2 2 1.8 3.1 3.1 4.4 0.4 1.6-1.9 0.1-5.8-2zm32.1 8.6c-7.6-1.6-14.2-6.3-20.2-14.7-0.7-1.1-0.7-1.3 0.4-1.7 6.5-2.3 13-4.1 19.5-4.4l0.3 0.2v18.9l0.2 1-0.2 0.7zm0-31.6-0.4 0.2c-11 0.5-20.3 3.6-25.2 5.8l-0.7-0.3c-2.2-6.2-3.5-10.3-4-16.8l0.3-0.3h29.5l0.4 0.2 0.1 11.2zm0-21.8-0.4 0.1h-29.6l-0.2-0.3 0.9-5.7 3.6-12.1 0.5-0.2 6.2 2c5.2 1.7 11.6 2.9 18.5 3.5l0.5 0.2v12.5zm0-24-0.4 0.2c-5.6-0.4-11.8-1.3-19.2-3.3-0.6-0.2-0.7-0.4-0.6-0.6 6-7.6 12.8-12.1 19.6-14l0.6 0.3v17.4zm9-17.4 0.6-0.3 4.1 1.2c5.7 2.4 11.4 6.9 15.8 12.6 0.3 0.4 0.3 0.6-0.6 1-6.2 1.9-13.2 2.9-19.8 3.2l-0.3-0.3 0.2-17.4zm0 29.1 2.6-0.2c7.8-0.9 14.9-2.2 21.9-5.7l1-0.2c1.9 3.5 4.2 12.1 4.6 18.1l-0.4 0.4h-29.3l-0.4-0.2v-12.2zm21.7 50.2c-4.9 7.7-12.4 13.3-21 15.6l-0.7-0.1-0.2-20.5 0.4-0.3c6.5 0.3 13.9 1.4 20.8 4.4 0.6 0.2 0.6 0.4 0.7 0.9zm4.5-10.4c-7.2-2.9-13-4.7-25.4-5.7l-0.8-0.2-0.1-6.4 0.2-4.6 0.4-0.2h29.3l0.4 0.2c0 5.1-1.9 10.7-3.6 16.9h-0.4zm0.4-62.5 0.4-0.5 4.8 2.6v0.3c-0.6 0.5-1.9 1.3-2.8 1.2-0.8-1.6-1.8-2-2.4-3.6zm0.2 82.6-0.3-0.5 1.7-2 1.5-2.7 0.5-0.3 2.9 2-0.1 0.7-6.2 2.8zm15.6-10.1-0.7 0.1-2.9-2.1-4.1-2.6-0.1-0.7c3.2-5.8 4.7-15.2 4.8-21.6l0.4-0.2h16.8l0.5 0.2c-0.7 10.5-7.8 20.1-14.7 26.9zm-3-37.5c-0.4-7.4-2.2-14.2-5.1-22.3l0.3-0.8 5.8-3.3h0.7c5.9 3.4 13.4 13.7 16.1 26.4l-0.4 0.1-17.4-0.1z";

/**
 * The Suma mark.
 *
 * Flat, single-weight, one colour, drawn in `currentColor` — the gaps in the
 * graticule are real transparency, so the mark survives any background it is
 * set on.
 */
export function SumaMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`}
      fill="currentColor"
      aria-hidden
      className={cn("h-6 w-auto", className)}
    >
      <path d={MARK_PATH} />
    </svg>
  );
}
