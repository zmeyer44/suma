"use client";

import { useEffect, useRef } from "react";

import { MARK_BOX, MARK_PATH } from "@/components/suma-mark";
import { readLattice } from "@/lib/pixel-lattice";

/**
 * Share of the band's height the mark is drawn at. The mark is wider than it is
 * tall, so at full height it would run the width of the band and leave the
 * strays around it no room to disperse into — the dissolve is the point of the
 * poster, not the silhouette.
 */
const MARK_FILL = 0.7;

/**
 * Cell, dot and repulsion at the reference viewport. The mosaic sits on the
 * same lattice as the cursor field — two thirds of its pitch — and every length
 * here is multiplied by the lattice scale at build time, so the mark is made of
 * the same count of pixels on every display rather than getting finer as the
 * screen gets denser. See `@/lib/pixel-lattice`.
 */
const REF_CELL = 9;
const REF_SEAM = 2;
/** Alpha in the sampled bitmap above which a cell becomes a pixel. */
const THRESHOLD = 70;
const REF_REPEL_RADIUS = 130;
const REF_REPEL_FORCE = 420;
const STIFFNESS = 0.055;
const DAMPING = 0.86;

type Pixel = {
  tx: number;
  ty: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** ms into the entrance before this pixel starts moving to its place. */
  delay: number;
  /** Index into the active palette, so the mark can be recoloured in place. */
  tone: number;
  alpha: number;
};

/**
 * How long after a build the mark is allowed to report disturbance. Pixels
 * arrive from off-canvas, so until they have settled their displacement is the
 * entrance, not the cursor.
 */
const SETTLE_MS = 2200;

/**
 * Draws the Suma mark into the sampling grid, from the same path the SVG
 * component uses — so there is no image to load, and the poster cannot drift
 * from the wordmark.
 *
 * The mark is one filled path whose graticule is holes rather than strokes; the
 * subpaths are wound against the disc, so the default non-zero fill leaves those
 * holes open and the alpha read below sees them.
 */
function stampMark(ctx: CanvasRenderingContext2D, cols: number, rows: number) {
  const scale = (rows * MARK_FILL) / MARK_BOX.height;

  ctx.save();
  // Centre the box in the grid on both axes, cancelling the box's own origin so
  // the artwork lands flush rather than offset by its viewBox.
  ctx.setTransform(
    scale,
    0,
    0,
    scale,
    (cols - MARK_BOX.width * scale) / 2 - MARK_BOX.x * scale,
    (rows - MARK_BOX.height * scale) / 2 - MARK_BOX.y * scale,
  );

  ctx.fillStyle = "#000";
  ctx.fill(new Path2D(MARK_PATH));

  ctx.restore();
}

export function PixelMosaic({
  className,
  inverted = false,
  onDisturbance,
}: {
  className?: string;
  /** Repaint the mark for a dark ground instead of the paper one. */
  inverted?: boolean;
  /**
   * Called once a frame with the mark's mean displacement from rest, measured
   * in cell widths — 0 when it is sitting still, rising as the cursor pushes
   * it apart. Read through a ref, so passing a new function never rebuilds
   * the mosaic.
   */
  onDisturbance?: (intensity: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const invertedRef = useRef(inverted);
  const disturbanceRef = useRef(onDisturbance);

  useEffect(() => {
    invertedRef.current = inverted;
  }, [inverted]);

  useEffect(() => {
    disturbanceRef.current = onDisturbance;
  }, [onDisturbance]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const styles = getComputedStyle(document.documentElement);
    const read = (name: string) => styles.getPropertyValue(name).trim();
    // Two palettes in the same tone order — bulk, shadow, speckle — so the
    // mark can be swapped onto a royal ground without rebuilding a pixel.
    const paperTones = [read("--royal"), read("--royal-deep"), read("--ink")];
    const royalTones = [
      read("--paper"),
      read("--paper-raised"),
      read("--royal-deep"),
    ];
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let pixels: Pixel[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let start = 0;
    let pointerX = -1e5;
    let pointerY = -1e5;
    // Sized from the lattice on every build, so a zoom or a move to another
    // display re-resolves them along with the canvas.
    let cell = REF_CELL;
    let dot = cell - REF_SEAM;
    let repelRadius = REF_REPEL_RADIUS;
    let repelForce = REF_REPEL_FORCE;
    // Absolute time before which displacement is the entrance settling rather
    // than the cursor. Pushed forward by every build, resize included.
    let settleUntil = 0;

    const build = () => {
      settleUntil = performance.now() + SETTLE_MS;
      const rect = canvas.getBoundingClientRect();
      const lattice = readLattice();
      const dpr = lattice.dpr;
      // Whole device pixels, so the dots keep the hard edge that makes them
      // read as pixels rather than as blur.
      cell = Math.max(2, Math.round(REF_CELL * lattice.scale * dpr)) / dpr;
      dot = cell - Math.max(1, Math.round(REF_SEAM * lattice.scale));
      repelRadius = REF_REPEL_RADIUS * lattice.scale;
      repelForce = REF_REPEL_FORCE * lattice.scale;

      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cols = Math.floor(width / cell);
      const rows = Math.floor(height / cell);
      if (cols < 8 || rows < 8) {
        pixels = [];
        return;
      }

      const sampler = document.createElement("canvas");
      sampler.width = cols;
      sampler.height = rows;
      const sctx = sampler.getContext("2d", { willReadFrequently: true });
      if (!sctx) return;
      stampMark(sctx, cols, rows);
      const bitmap = sctx.getImageData(0, 0, cols, rows).data;

      const filled = (col: number, row: number) => {
        if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
        return (bitmap[(row * cols + col) * 4 + 3] ?? 0) > THRESHOLD;
      };

      // Centre the grid in whatever space is left over after the division.
      const offsetX = (width - cols * cell) / 2;
      const offsetY = (height - rows * cell) / 2;
      const next: Pixel[] = [];

      const add = (
        col: number,
        row: number,
        alpha: number,
        delayJitter: number,
      ) => {
        const tx = offsetX + col * cell;
        const ty = offsetY + row * cell;
        const roll = Math.random();
        next.push({
          tx,
          ty,
          // Enter from a ring outside the canvas, biased to the left so the
          // mark reads as arriving rather than falling in.
          x: tx - width * (0.35 + Math.random() * 0.5),
          y: ty + (Math.random() - 0.5) * height * 1.2,
          vx: 0,
          vy: 0,
          delay: (col / cols) * 620 + delayJitter,
          tone: roll < 0.7 ? 0 : roll < 0.88 ? 1 : 2,
          alpha,
        });
      };

      let markMinCol = cols;
      let markMaxCol = 0;
      let markMinRow = rows;
      let markMaxRow = 0;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          if (!filled(col, row)) continue;
          add(col, row, 1, Math.random() * 260);

          if (col < markMinCol) markMinCol = col;
          if (col > markMaxCol) markMaxCol = col;
          if (row < markMinRow) markMinRow = row;
          if (row > markMaxRow) markMaxRow = row;

          // Edge cells shed a few strays, so the mark dissolves into the page
          // instead of ending on a hard cut.
          const edge =
            !filled(col - 1, row) ||
            !filled(col + 1, row) ||
            !filled(col, row - 1) ||
            !filled(col, row + 1);
          if (!edge || Math.random() > 0.32) continue;

          const spread = 3 + Math.floor(Math.random() * 8);
          const sCol = col + Math.round((Math.random() - 0.5) * spread * 2);
          const sRow = row + Math.round((Math.random() - 0.5) * spread * 2);
          if (sCol < 0 || sRow < 0 || sCol >= cols || sRow >= rows) continue;
          if (filled(sCol, sRow)) continue;
          add(sCol, sRow, 0.16 + Math.random() * 0.34, Math.random() * 420);
        }
      }

      // Dispersion. The mark thins out sideways across the whole band rather
      // than stopping at its own silhouette — a workspace coming apart on one
      // machine and settling on the next.
      const reachX = Math.max(1, cols * 0.62);
      const reachY = Math.max(1, rows * 0.75);
      for (let row = 0; row < rows; row++) {
        const dy =
          row < markMinRow
            ? markMinRow - row
            : row > markMaxRow
              ? row - markMaxRow
              : 0;
        const fallY = Math.max(0, 1 - dy / reachY);
        if (fallY <= 0) continue;

        for (let col = 0; col < cols; col++) {
          if (filled(col, row)) continue;
          const dx =
            col < markMinCol
              ? markMinCol - col
              : col > markMaxCol
                ? col - markMaxCol
                : 0;
          const fallX = Math.max(0, 1 - dx / reachX);
          const chance = 0.3 * fallX * fallX * fallX * fallY;
          if (Math.random() > chance) continue;
          add(col, row, 0.1 + Math.random() * 0.3 * fallX, Math.random() * 700);
        }
      }

      pixels = next;
    };

    const paint = (elapsed: number) => {
      ctx.clearRect(0, 0, width, height);

      const palette = invertedRef.current ? royalTones : paperTones;
      let displaced = 0;

      for (const pixel of pixels) {
        if (elapsed >= pixel.delay) {
          let ax = (pixel.tx - pixel.x) * STIFFNESS;
          let ay = (pixel.ty - pixel.y) * STIFFNESS;

          const dx = pixel.x - pointerX;
          const dy = pixel.y - pointerY;
          const dist = Math.hypot(dx, dy);
          if (dist < repelRadius && dist > 0.01) {
            const falloff = 1 - dist / repelRadius;
            const push = (falloff * falloff * repelForce) / dist;
            ax += dx * push * 0.01;
            ay += dy * push * 0.01;
          }

          pixel.vx = (pixel.vx + ax) * DAMPING;
          pixel.vy = (pixel.vy + ay) * DAMPING;
          pixel.x += pixel.vx;
          pixel.y += pixel.vy;
        }

        displaced +=
          Math.abs(pixel.x - pixel.tx) + Math.abs(pixel.y - pixel.ty);

        ctx.globalAlpha = pixel.alpha;
        ctx.fillStyle = palette[pixel.tone] ?? palette[0] ?? "#000";
        ctx.fillRect(Math.round(pixel.x), Math.round(pixel.y), dot, dot);
      }
      ctx.globalAlpha = 1;

      const report = disturbanceRef.current;
      if (report && pixels.length > 0 && performance.now() >= settleUntil) {
        report(displaced / pixels.length / cell);
      }
    };

    const settle = () => {
      for (const pixel of pixels) {
        pixel.x = pixel.tx;
        pixel.y = pixel.ty;
        pixel.vx = 0;
        pixel.vy = 0;
      }
      paint(Number.MAX_SAFE_INTEGER);
    };

    const loop = (now: number) => {
      if (start === 0) start = now;
      paint(now - start);
      frame = requestAnimationFrame(loop);
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointerX = event.clientX - rect.left;
      pointerY = event.clientY - rect.top;
    };

    const onPointerLeave = () => {
      pointerX = -1e5;
      pointerY = -1e5;
    };

    const restart = () => {
      build();
      if (reduce) {
        settle();
        return;
      }
      start = 0;
      if (frame === 0) frame = requestAnimationFrame(loop);
    };

    restart();

    const observer = new ResizeObserver(() => {
      if (reduce) {
        build();
        settle();
      } else {
        build();
      }
    });
    observer.observe(canvas);

    if (!reduce) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.addEventListener("pointerleave", onPointerLeave);
    }

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className={className} />;
}
