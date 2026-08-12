/**
 * The page's pixel lattice.
 *
 * Everything pixel-shaped on the site — the graph paper, the cursor field, the
 * hero mosaic — is a multiple of one pitch, and that pitch is a fraction of the
 * viewport rather than a fixed count of CSS px.
 *
 * A CSS px is not a fixed physical size. A Mac set to "More Space", a HiDPI
 * panel and browser zoom all change how large one lands on the glass and how
 * many of them fit across the screen, so a hard-coded 14px lattice reads chunky
 * on one machine and fine and far apart on the next. Sizing against the viewport
 * takes every one of those out of the picture in one move: the field is always
 * the same number of pixels across, so it composes identically everywhere.
 *
 * The pitch is declared in CSS as `--pixel-pitch` so the graph paper can share
 * it without a round trip through JS. This module reads it, and re-derives the
 * same clamp for browsers that do not resolve a registered custom property.
 */

/** Pitch at the reference width — every constant below is quoted against it. */
export const REFERENCE_PITCH = 14;
/** Viewport width the site was drawn at. Keep in step with `--pixel-pitch`. */
export const REFERENCE_WIDTH = 1440;
const MIN_PITCH = 11;
const MAX_PITCH = 20;

export type Lattice = {
  /** Pitch in CSS px, snapped so a cell lands on whole device pixels. */
  pitch: number;
  /** Pitch relative to the reference. Multiply any px-quoted constant by it. */
  scale: number;
  /** Device pixels per CSS px, capped — a 3x panel gains nothing here. */
  dpr: number;
};

/**
 * The unsnapped pitch, in CSS px. Read from CSS when the browser resolves
 * `--pixel-pitch` to a length (it is registered with `@property`), otherwise
 * computed here from the same clamp.
 */
function rawPitch(): number {
  const declared = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--pixel-pitch",
    ),
  );
  if (Number.isFinite(declared) && declared > 0) return declared;

  const width = document.documentElement.clientWidth || REFERENCE_WIDTH;
  const fluid = (width / REFERENCE_WIDTH) * REFERENCE_PITCH;
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, fluid));
}

/**
 * Resolve the lattice for the viewport as it is right now. Call this on every
 * resize — browser zoom and a display change both surface as a resize.
 */
export function readLattice(): Lattice {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Snap to whole device pixels. A fractional pitch would put fills on
  // half-pixel boundaries and antialias the edges, and a soft edge is the one
  // thing that stops a square reading as a pixel.
  const pitch = Math.max(1, Math.round(rawPitch() * dpr)) / dpr;
  return { pitch, scale: pitch / REFERENCE_PITCH, dpr };
}
