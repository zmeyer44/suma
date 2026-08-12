/**
 * The empty state's decoration: the marketing site's pixel motif (apps/www
 * pixel-field.tsx / pixel-mosaic.tsx) brought into the content hole.
 *
 * Two pieces, chosen from a concept round (2026-08-11): corner drift —
 * accent pixels scattering in from two corners, thinning with distance —
 * and the corner watermark rebuilt as a pixel mosaic of the mark itself.
 *
 * The motif's grammar, kept intact from the reference: hard-edged squares on
 * a 9px lattice with a 2px seam, colour in flat bands (never a gradient, no
 * part-transparent fade — a cell is drawn at a band's alpha or not at all),
 * scatter that thins with distance, and a seeded PRNG so the composition is
 * identical on every mount instead of reshuffling.
 */

import { useEffect, useMemo, useRef } from "react";
import { MARK_BOX, MARK_PATH } from "./ui/suma-mark";

/** Lattice pitch and dot, straight from the reference (9px cell, 2px seam). */
const CELL = 9;
const DOT = CELL - 2;

/** mulberry32 — a tiny seeded PRNG, so the scatter is a composition and not
 *  a per-mount dice roll. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Cell = { x: number; y: number; fill: string; alpha: number };

/** The banded palette: mostly faint accent, a step up now and then, and the
 *  rare ok-green speckle — the reference's "bulk, shadow, speckle" idea in
 *  this app's tokens. */
function rollTone(rand: () => number): { fill: string; alpha: number } {
  const roll = rand();
  if (roll < 0.66) return { fill: "var(--color-accent)", alpha: 0.07 };
  if (roll < 0.86) return { fill: "var(--color-accent)", alpha: 0.12 };
  if (roll < 0.96) return { fill: "var(--color-accent)", alpha: 0.2 };
  return { fill: "var(--color-ok)", alpha: 0.16 };
}

/* ── Corner drift ─────────────────────────────────────────────────────────
   Two corners shed pixels toward the middle of the hole, density falling
   with the cube of distance the way the mosaic's dispersion does. The
   bottom-right cloud drifts across the mosaic watermark, as if the globe
   were coming apart into the page. */

function driftCells(seed: number, cols: number, rows: number): Cell[] {
  const rand = mulberry32(seed);
  const out: Cell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Distance from the anchored corner (0,0 of this SVG), normalised so
      // the falloff is the same shape whatever the patch's aspect.
      const d = Math.min(1, Math.hypot(col / cols, row / rows));
      const chance = 0.4 * (1 - d) ** 3;
      if (rand() > chance) continue;
      out.push({ x: col * CELL, y: row * CELL, ...rollTone(rand) });
    }
  }
  return out;
}

function CornerDrift({ corner }: { corner: "tl" | "br" }) {
  const cols = 52;
  const rows = 38;
  const cells = useMemo(
    () => driftCells(corner === "tl" ? 7 : 23, cols, rows),
    [corner],
  );
  return (
    <svg
      width={cols * CELL}
      height={rows * CELL}
      aria-hidden="true"
      // The falloff is anchored at the SVG's own origin, so the bottom-right
      // patch is the same drawing rotated into its corner.
      className={
        corner === "tl"
          ? "absolute top-0 left-0"
          : "absolute right-0 bottom-0 rotate-180"
      }
    >
      {cells.map((cell, i) => (
        <rect
          key={i}
          x={cell.x}
          y={cell.y}
          width={DOT}
          height={DOT}
          fill={cell.fill}
          opacity={cell.alpha}
        />
      ))}
    </svg>
  );
}

/* ── Mosaic watermark ─────────────────────────────────────────────────────
   The corner watermark rebuilt in the motif — the globe sampled onto the
   lattice the way pixel-mosaic.tsx does, shedding strays at its edges, with
   the odd accent speckle in the bulk. Drawn once to a canvas; colours are
   read from the theme's tokens at mount, and redrawn when the theme's
   class/attribute flips so a scheme change recolours it. */

const MOSAIC_W = 342;
const MOSAIC_H = 306;

function drawMosaic(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const styles = getComputedStyle(document.documentElement);
  const ink = styles.getPropertyValue("--color-ink").trim() || "#000";
  const accent = styles.getPropertyValue("--color-accent").trim() || "#46f";

  const dpr = window.devicePixelRatio || 1;
  canvas.width = MOSAIC_W * dpr;
  canvas.height = MOSAIC_H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, MOSAIC_W, MOSAIC_H);

  const cols = Math.floor(MOSAIC_W / CELL);
  const rows = Math.floor(MOSAIC_H / CELL);

  // Sample the mark's own path — the same trick as the reference's
  // stampMark, so the pixel version can never drift from the artwork.
  const sampler = document.createElement("canvas");
  sampler.width = cols;
  sampler.height = rows;
  const sctx = sampler.getContext("2d", { willReadFrequently: true });
  if (sctx === null) return;
  const scale = (rows * 0.92) / MARK_BOX.height;
  sctx.setTransform(
    scale,
    0,
    0,
    scale,
    (cols - MARK_BOX.width * scale) / 2 - MARK_BOX.x * scale,
    (rows - MARK_BOX.height * scale) / 2 - MARK_BOX.y * scale,
  );
  sctx.fill(new Path2D(MARK_PATH));
  const bitmap = sctx.getImageData(0, 0, cols, rows).data;
  const filled = (col: number, row: number): boolean =>
    col >= 0 &&
    row >= 0 &&
    col < cols &&
    row < rows &&
    (bitmap[(row * cols + col) * 4 + 3] ?? 0) > 70;

  const rand = mulberry32(101);
  const dotAt = (col: number, row: number, fill: string, alpha: number) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    ctx.fillRect(col * CELL, row * CELL, DOT, DOT);
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!filled(col, row)) continue;
      const roll = rand();
      if (roll < 0.85) dotAt(col, row, ink, 0.065);
      else if (roll < 0.95) dotAt(col, row, ink, 0.1);
      else dotAt(col, row, accent, 0.12);

      // Edge cells shed strays into the page, per the reference — that
      // dissolve is what says "pixels", not just "low-res logo".
      const edge =
        !filled(col - 1, row) ||
        !filled(col + 1, row) ||
        !filled(col, row - 1) ||
        !filled(col, row + 1);
      if (!edge || rand() > 0.3) continue;
      const spread = 3 + Math.floor(rand() * 7);
      const sCol = col + Math.round((rand() - 0.5) * spread * 2);
      const sRow = row + Math.round((rand() - 0.5) * spread * 2);
      if (sCol < 0 || sRow < 0 || sCol >= cols || sRow >= rows) continue;
      if (filled(sCol, sRow)) continue;
      dotAt(sCol, sRow, ink, 0.04 + rand() * 0.03);
    }
  }
  ctx.globalAlpha = 1;
}

function MosaicMark() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    drawMosaic(canvas);
    // The theme lands as a class/attribute flip on <html> (lib/theme.ts);
    // the canvas holds resolved colours, so it has to repaint on that flip.
    const observer = new MutationObserver(() => drawMosaic(canvas));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ width: MOSAIC_W, height: MOSAIC_H }}
      className="absolute -right-10 -bottom-14"
    />
  );
}

/** Everything painted into the hole's fixed decoration layer: the two drift
 *  corners, and the mosaic watermark the bottom-right cloud drifts across. */
export function PixelBackdrop() {
  return (
    <>
      <CornerDrift corner="tl" />
      <CornerDrift corner="br" />
      <MosaicMark />
    </>
  );
}
