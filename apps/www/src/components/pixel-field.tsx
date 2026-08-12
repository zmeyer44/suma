"use client";

import { useEffect, useRef } from "react";

import {
  type Box,
  boxOf,
  grownBox,
  nearestArcFraction,
  nearestEdge,
  perimeter,
  type Point,
  pointAt,
  readCorner,
} from "@/lib/pixel-bodies";
import { readLattice, REFERENCE_PITCH } from "@/lib/pixel-lattice";

/**
 * Pixel size at the reference viewport, and the seam between two pixels. The
 * reference runs a 9px lattice with a 1px seam; ours sits on the half-grid of
 * the graph paper so the field stays aligned to the page.
 *
 * Every length below is quoted at that same reference width and multiplied by
 * the lattice scale at runtime, so the blob covers the same pixels and the same
 * share of the screen on every display — see `@/lib/pixel-lattice`.
 */
const REF_GAP = 2;

/*
 * The physics below is ported from craft.wild.as. Their constants are written
 * in units of their own 9px cell and a brush of 10 cells, so they are
 * re-derived here in px rather than copied as bare numbers.
 */
const REF_CELL = 9;

/** How many pixels across the blob reads when the pointer is resting. */
const BLOB_PIXELS = 6;

/** They discard any cell whose stamp weight falls under this. */
const MIN_WEIGHT = 0.02;
/** Where that cutoff puts the edge of a stamp, in multiples of sigma. */
const REACH = Math.sqrt(-2 * Math.log(MIN_WEIGHT));

/** Heat laid down per stamp, and how finely the path is stamped. */
const DEPOSIT = 0.16;
const REF_STEP = REF_CELL * 0.8;
const MAX_STEPS = 48;

/**
 * Heat surviving one frame at 60fps. Theirs is a bare per-frame multiply, so
 * their trail fades twice as fast on a 120Hz display; normalising against a
 * 60Hz frame keeps the feel they tuned without inheriting that.
 */
const DECAY = 0.878;
const FRAME = 1 / 60;
/** Under this a cell is cold and stops being tracked. */
const COLD = 0.003;

/** Heat is read through this gain before it picks a band. */
const GAIN = 0.9;
/**
 * Bands, coolest first. Nothing under the first one is drawn at all and no
 * pixel is ever drawn part-transparent — that hard edge is what makes the
 * blob read as pixels rather than as a glow.
 */
const BANDS = [0.3, 0.46, 0.62, 0.78];

/**
 * Sigma of one stamp, at the reference pitch — derived from the size the blob
 * should be rather than set as a bare number, so `BLOB_PIXELS` above is a
 * measurement you can trust and not a guess to re-tune by eye.
 *
 * A resting pointer restamps the same gaussian every frame against a constant
 * decay, so a cell at distance d settles at `DEPOSIT·w / (1 - DECAY)` with
 * `w = exp(-d² / 2σ²)`. The blob's edge is where that reading, through GAIN,
 * falls under the first band — so the weight at the edge is fixed, and asking
 * for it to land half a blob out is what fixes sigma.
 *
 * The reference this is ported from writes its stamp as
 * `exp(-d² / (2·BRUSH²·0.18))` over a brush of 10 of their cells — sigma
 * 10·√0.18 cells, which on our lattice drew about 9 pixels across.
 */
const EDGE_WEIGHT = (BANDS[0]! * (1 - DECAY)) / (DEPOSIT * GAIN);
const REF_SIGMA =
  ((BLOB_PIXELS * REFERENCE_PITCH) / 2) *
  (1 / Math.sqrt(-2 * Math.log(EDGE_WEIGHT)));

/** A click wave crosses this many viewport diagonals per second. */
const WAVE_SPEED = 1.7;
const WAVE_LIFE = 1.5;
const REF_WAVE_SIGMA = REF_CELL * 5.5;
/** Seconds of holding the pointer down that charges a wave to full. */
const CHARGE_FULL = 2.2;

type Wave = { x: number; y: number; born: number; power: number };

/* ---------------------------------------------------------------------------
   The page, as the field sees it.

   Everything below is about the boundary between the field and the elements
   sitting on top of it. A panel is opaque, so the field cannot draw *on* one —
   what it can do is hold its edge, and refuse to let the cursor's blob pass
   under it. See `@/lib/pixel-bodies` for the geometry.
--------------------------------------------------------------------------- */

/**
 * What the field can see. `data-pixel` opts an element in and picks which of
 * the two vocabularies it answers in — `card` for a panel, anything else for a
 * control — and a button is a control without having to be marked, whether it
 * renders as a `button` or was handed its slot by `asChild`.
 */
const BODY_SELECTOR = '[data-pixel], button, [data-slot="button"]';
/** How far up the tree the field looks, so a button in a panel lights both. */
const MAX_BODIES = 2;
/** Anything shorter than this on either axis is not worth outlining. */
const REF_MIN_BODY = 24;

/**
 * How far outside its own edge an element's outline is drawn. Just over half a
 * cell, so the lit cell is the one clear of the element rather than the one
 * the element covers.
 */
const REF_TRACE_OFFSET = REFERENCE_PITCH * 0.8;
/** Spacing between pokes along an outline — under a cell, so it never beads. */
const REF_TRACE_STEP = REFERENCE_PITCH * 0.4;
/** Ceiling on what one outline costs per frame, for the page-sized panels. */
const MAX_TRACE = 480;

/**
 * Heat an outline rests at, and the heat of the two heads that draw it, chosen
 * against `BANDS` above: the resting edge sits in the deep royal band and the
 * heads in the royal one. Nothing here reaches the palest band — a single
 * pixel of it is invisible against paper, which is only a core colour.
 */
const TRACE_HOLD = 0.52;
const TRACE_HEAD = 0.78;
/** The soft bloom each head drags along with it. */
const HEAD_BLOOM = 0.3;
const HEAD_SPREAD = 0.5;

/**
 * Seconds the two heads take to meet on the far side, and the bounds on how
 * fast they may run to manage it. Quoting the sweep as a duration rather than
 * a speed is what keeps a small card and a page-sized panel feeling like the
 * same gesture; the bounds keep the extremes from crawling or snapping.
 */
const IGNITE_SWEEP = 0.5;
const REF_IGNITE_MIN = 1100;
const REF_IGNITE_MAX = 5400;

/** Depth into an element over which the blob it displaced fades out. */
const REF_CLING_DEPTH = 190;
/** How far the blob is pinched as that happens. */
const CLING_PINCH = 0.5;

/**
 * Rings drawn converging on a hovered control, the heat they run through as
 * they land, and the cells they leave between them — a control is small, and
 * solid rings this close together would read as one block around it.
 */
const RINGS = 2;
const RING_PERIOD = 1.15;
const REF_RING_REACH = 58;
const RING_COOL = 0.34;
const RING_WARM = 0.74;
const RING_GAP = 2;

/**
 * A press throws a copy of the outline this far off the element, over this
 * long, thinning by up to this many cells between pokes as it goes.
 */
const REF_FLASH_THROW = 90;
const FLASH_LIFE = 0.45;
const FLASH_DISSOLVE = 2.5;

type Body = {
  element: Element;
  /** Depth in the hover chain. The outermost one deflects the cursor's blob. */
  depth: number;
  /** A panel, which is traced; otherwise a control, which is ringed. */
  card: boolean;
  /** Declared corner radius. Read once — re-reading it per frame is a recalc. */
  corner: number;
  /** Re-measured every frame: scrolling moves it, and so does a reveal. */
  box: Box;
  /** Where around the edge the outline started drawing, as a fraction of it. */
  entry: number;
  born: number;
  /** When the element was last pressed, in seconds. 0 if it has not been. */
  pressed: number;
};

/**
 * A field of pixels that follows the cursor, matching the blob on
 * craft.wild.as.
 *
 * There is no easing and no momentum: the blob is exactly at the cursor. What
 * gives it life is that heat is stamped along the segment the pointer actually
 * covered since the last frame — so a fast flick is a continuous streak rather
 * than a dotted line — and then decays hard, roughly to nothing within a third
 * of a second. Holding still is not a special case: the same stamp repeats in
 * place each frame and saturates the cell.
 *
 * Each cell then reads its own heat and picks a colour band. Cells below the
 * first band are not drawn, so the blob has a crisp pixel edge instead of
 * fading out. Holding the pointer down charges a shockwave that fires on
 * release.
 *
 * The field is also aware of the page sitting on top of it. Panels and
 * controls are solid to it: the blob cannot pass under one, and slides along
 * the edge of whatever it ran into instead. Meeting one lights its edge —
 * heat runs out from where the pointer crossed in, both ways around, until it
 * meets itself on the far side and the outline holds. A control adds rings
 * converging on it, and a press throws a copy of the outline off into the
 * field, in the shape of the thing that was pressed.
 *
 * Not ported: their idle Pac-Man, the headline arrows, the heart and the
 * marquee — those are content-specific, not part of the cursor physics.
 */
export function PixelField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    // Their ramp runs navy -> blue -> yellow -> acid as a cell heats up. Ours
    // runs the site's own royal ramp over the same thresholds: dark at the
    // cool outskirts, palest at the core.
    const colours = [
      token("--ink", "oklch(0.185 0.008 265)"),
      token("--royal-deep", "oklch(0.43 0.185 264.5)"),
      token("--royal", "oklch(0.517 0.192 264.5)"),
      token("--royal-wash", "oklch(0.948 0.032 264.5)"),
    ];

    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let heat = new Float32Array(0);

    // The lattice for the current viewport, and the lengths derived from it.
    // All of these are re-read on resize: a zoom, a window drag onto a second
    // display or a change of display scaling arrives as one.
    let pitch = REFERENCE_PITCH;
    let size = pitch - REF_GAP;
    let sigma = REF_SIGMA;
    let step = REF_STEP;
    let waveSigma = REF_WAVE_SIGMA;
    let traceOffset = REF_TRACE_OFFSET;
    let traceStep = REF_TRACE_STEP;
    let igniteMin = REF_IGNITE_MIN;
    let igniteMax = REF_IGNITE_MAX;
    let clingDepth = REF_CLING_DEPTH;
    let ringReach = REF_RING_REACH;
    let flashThrow = REF_FLASH_THROW;
    let minBody = REF_MIN_BODY;

    const waves: Wave[] = [];

    /**
     * The elements under the pointer, outermost first. Scratch points are held
     * here rather than allocated: the edge work runs a few hundred times a
     * frame and the garbage would show.
     */
    const bodies = new Map<Element, Body>();
    const edge: Point = { x: 0, y: 0 };
    const probe: Point = { x: 0, y: 0 };
    let hovered: EventTarget | null = null;

    let pointerX = -1;
    let pointerY = -1;
    let pointerLive = false;
    // Where the pointer was when it was last stamped, so the gap between two
    // frames can be filled in.
    let fromX = -1;
    let fromY = -1;

    let charging = false;
    let chargedAt = 0;
    let chargeX = 0;
    let chargeY = 0;

    let frame = 0;
    let last = 0;

    const resize = () => {
      const lattice = readLattice();
      const dpr = lattice.dpr;
      pitch = lattice.pitch;
      // The seam is a whole CSS px so it stays a clean hairline; everything
      // else rides the scale, which is what keeps the blob the same size
      // relative to the page no matter how large a CSS px happens to be here.
      size = pitch - Math.max(1, Math.round(REF_GAP * lattice.scale));
      sigma = REF_SIGMA * lattice.scale;
      step = REF_STEP * lattice.scale;
      waveSigma = REF_WAVE_SIGMA * lattice.scale;
      traceOffset = REF_TRACE_OFFSET * lattice.scale;
      traceStep = REF_TRACE_STEP * lattice.scale;
      igniteMin = REF_IGNITE_MIN * lattice.scale;
      igniteMax = REF_IGNITE_MAX * lattice.scale;
      clingDepth = REF_CLING_DEPTH * lattice.scale;
      ringReach = REF_RING_REACH * lattice.scale;
      flashThrow = REF_FLASH_THROW * lattice.scale;
      minBody = REF_MIN_BODY * lattice.scale;

      // Measure the element, not the window: `innerWidth` counts a classic
      // scrollbar, which would push this fixed layer past the viewport and
      // give the whole page a horizontal scroll.
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      cols = Math.ceil(width / pitch) + 1;
      rows = Math.ceil(height / pitch) + 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      heat = new Float32Array(cols * rows);

      // Corner radii are responsive; drop what is held so the next move
      // re-reads them rather than tracing last breakpoint's shape.
      bodies.clear();
      hovered = null;
    };

    /** Stamp a gaussian of heat centred on one point. */
    const stamp = (x: number, y: number, amount: number, spread: number) => {
      const reach = spread * REACH;
      const inv = 1 / (2 * spread * spread);
      const minCol = Math.max(0, Math.floor((x - reach) / pitch));
      const maxCol = Math.min(cols - 1, Math.ceil((x + reach) / pitch));
      const minRow = Math.max(0, Math.floor((y - reach) / pitch));
      const maxRow = Math.min(rows - 1, Math.ceil((y + reach) / pitch));

      for (let row = minRow; row <= maxRow; row++) {
        const dy = (row + 0.5) * pitch - y;
        for (let col = minCol; col <= maxCol; col++) {
          const dx = (col + 0.5) * pitch - x;
          const weight = Math.exp(-(dx * dx + dy * dy) * inv);
          if (weight < MIN_WEIGHT) continue;
          const index = row * cols + col;
          const next = heat[index]! + amount * weight;
          heat[index] = next > 1 ? 1 : next;
        }
      }
    };

    /**
     * Set one cell, hard, if the new reading is the hotter one.
     *
     * The outlines are poked rather than stamped: a gaussian would spread an
     * edge over two or three cells and read as a glow around the element,
     * where what is wanted is a line exactly one pixel thick.
     */
    const poke = (x: number, y: number, value: number) => {
      const col = Math.floor(x / pitch);
      const row = Math.floor(y / pitch);
      if (col < 0 || row < 0 || col >= cols || row >= rows) return;
      const index = row * cols + col;
      if (value > heat[index]!) heat[index] = value;
    };

    /**
     * Run heat around an edge, out from `from` in both directions and no
     * further than `span`. Passing a span past the half perimeter draws the
     * whole thing, which is what a settled outline is.
     *
     * `gap` is what separates a line from a dotted one: at the default the
     * pokes overlap and the edge comes out solid, and at a cell or more they
     * land on every second or third cell instead. Everything that is not the
     * element's own outline is drawn dotted, so the field can say several
     * things around one element without any of them reading as a border.
     */
    const traceEdge = (
      box: Box,
      from: number,
      span: number,
      value: number,
      gap = traceStep,
    ) => {
      const length = perimeter(box);
      if (length <= 0) return;
      const reach = Math.min(span, length / 2);
      // The cap only bites on the page-sized panels, where a couple of cells
      // between pokes is still under one cell of gap on screen.
      const spacing = Math.max(gap, (reach * 2) / MAX_TRACE);

      for (let at = 0; at <= reach; at += spacing) {
        pointAt(box, from + at, edge);
        poke(edge.x, edge.y, value);
        if (at === 0) continue;
        pointAt(box, from - at, edge);
        poke(edge.x, edge.y, value);
      }
    };

    /**
     * The element's own outline: two heads running out from where the pointer
     * crossed the edge, the lit part behind them holding, and — for a few
     * frames after a press — a copy of the whole thing thrown outwards.
     */
    const outline = (body: Body, now: number) => {
      const box = grownBox(body.box, traceOffset);
      const length = perimeter(box);
      const half = length / 2;
      const from = body.entry * length;

      const speed = Math.min(
        Math.max(half / IGNITE_SWEEP, igniteMin),
        igniteMax,
      );
      const front = (now - body.born) * speed;

      const age = body.pressed === 0 ? 1 : (now - body.pressed) / FLASH_LIFE;
      const flash = age < 1 ? 1 - age : 0;

      traceEdge(
        box,
        from,
        Math.min(front, half),
        TRACE_HOLD + flash * (TRACE_HEAD - TRACE_HOLD),
      );

      if (front < half) {
        for (let side = -1; side <= 1; side += 2) {
          pointAt(box, from + side * front, edge);
          poke(edge.x, edge.y, TRACE_HEAD);
          stamp(edge.x, edge.y, HEAD_BLOOM, sigma * HEAD_SPREAD);
        }
      }

      if (flash > 0) {
        // Eased out, so the copy leaves fast and settles — a shape coming off
        // the element rather than a ring drifting away from it. It also thins
        // as it goes: heat can only fall as far as the coolest band before it
        // is simply not drawn, so an outline that held every cell to the end
        // would wink out whole. Dropping cells is how it dissolves instead.
        const thrown = grownBox(box, flashThrow * (1 - flash * flash));
        traceEdge(
          thrown,
          from,
          Infinity,
          TRACE_HEAD * flash,
          traceStep + pitch * FLASH_DISSOLVE * (1 - flash),
        );
      }
    };

    /** A control pulls the field in: rings closing on it, warming as they land. */
    const rings = (body: Body, now: number) => {
      for (let i = 0; i < RINGS; i++) {
        const phase = ((now - body.born) / RING_PERIOD + i / RINGS) % 1;
        const box = grownBox(body.box, traceOffset + ringReach * (1 - phase));
        traceEdge(
          box,
          0,
          Infinity,
          RING_COOL + (RING_WARM - RING_COOL) * phase,
          pitch * RING_GAP,
        );
      }
    };

    /**
     * Lay the cursor's own heat at one point — unless an element is in the
     * way, in which case it goes to the nearest point on that element's edge
     * instead, pinched and fading with how far under it the pointer has gone.
     *
     * This is the whole of the occlusion: the blob never enters a panel, it
     * piles up against it and rides the edge as the pointer moves across.
     *
     * The outermost element wins, not the nearest. A button inside a card is
     * as opaque as the card is, so the edge that has open page on the far side
     * of it — the only edge where the blob can be seen at all — is the card's.
     */
    const deposit = (x: number, y: number) => {
      let depth = Number.POSITIVE_INFINITY;
      let under = 0;
      for (const body of bodies.values()) {
        if (body.depth >= depth) continue;
        const gap = nearestEdge(body.box, x, y, probe);
        if (gap >= 0) continue;
        depth = body.depth;
        under = gap;
        edge.x = probe.x;
        edge.y = probe.y;
      }

      if (depth === Number.POSITIVE_INFINITY) {
        stamp(x, y, DEPOSIT, sigma);
        return;
      }

      const left = 1 + under / clingDepth;
      if (left <= 0) return;
      stamp(
        edge.x,
        edge.y,
        DEPOSIT * left,
        sigma * (CLING_PINCH + (1 - CLING_PINCH) * left),
      );
    };

    /**
     * Lay heat along everywhere the pointer has been since the last frame. A
     * pointer that has not moved stamps once in place, which is what lets a
     * resting blob saturate rather than needing a dwell rule of its own.
     */
    const follow = (x: number, y: number) => {
      if (fromX < 0) {
        fromX = x;
        fromY = y;
      }
      const dx = x - fromX;
      const dy = y - fromY;
      const steps = Math.max(
        1,
        Math.min(MAX_STEPS, Math.round(Math.hypot(dx, dy) / step)),
      );
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        deposit(fromX + dx * f, fromY + dy * f);
      }
      fromX = x;
      fromY = y;
    };

    /** An expanding gaussian ring. It takes the max, so it never blows out. */
    const advanceWaves = (now: number) => {
      const diagonal = Math.hypot(width, height);
      for (let i = waves.length - 1; i >= 0; i--) {
        const wave = waves[i]!;
        const age = now - wave.born;
        if (age > WAVE_LIFE) {
          waves.splice(i, 1);
          continue;
        }
        const radius = age * diagonal * WAVE_SPEED;
        const spread = waveSigma * wave.power;
        const amp = (1 - age / WAVE_LIFE) * 1.2 * wave.power;
        const inv = 1 / (2 * spread * spread);

        for (let row = 0; row < rows; row++) {
          const dy = (row + 0.5) * pitch - wave.y;
          for (let col = 0; col < cols; col++) {
            const dx = (col + 0.5) * pitch - wave.x;
            const offset = Math.hypot(dx, dy) - radius;
            const value = amp * Math.exp(-(offset * offset) * inv);
            if (value < MIN_WEIGHT) continue;
            const index = row * cols + col;
            if (value > heat[index]!) heat[index] = value;
          }
        }
      }
    };

    /**
     * Bring the held set in line with what the pointer is over now, keeping
     * the ones that are still under it — an outline that has already run
     * around a card must not restart because the pointer crossed a word.
     */
    const syncBodies = (target: EventTarget | null, now: number) => {
      const chain: Element[] = [];
      let node = target instanceof Element ? target : null;
      while (node && chain.length < MAX_BODIES) {
        const hit = node.closest(BODY_SELECTOR);
        if (!hit) break;
        // Found innermost first; the field wants them the other way up, so
        // depth can say which element owns the blob.
        chain.unshift(hit);
        node = hit.parentElement;
      }

      for (const element of bodies.keys()) {
        if (!chain.includes(element)) bodies.delete(element);
      }

      chain.forEach((element, depth) => {
        const held = bodies.get(element);
        if (held) {
          held.depth = depth;
          return;
        }

        const corner = readCorner(element);
        const box = boxOf(element, corner);
        if (box.width < minBody || box.height < minBody) return;

        bodies.set(element, {
          element,
          depth,
          card: element.getAttribute("data-pixel") === "card",
          corner,
          box,
          entry: nearestArcFraction(
            grownBox(box, traceOffset),
            pointerX,
            pointerY,
          ),
          born: now,
          pressed: 0,
        });
      });
    };

    const draw = (time: number) => {
      const dt = last === 0 ? FRAME : Math.min((time - last) / 1000, 0.05);
      last = time;
      const now = time / 1000;

      const survives = Math.pow(DECAY, dt / FRAME);
      let warm = false;
      for (let i = 0; i < heat.length; i++) {
        const next = heat[i]! * survives;
        if (next < COLD) {
          heat[i] = 0;
        } else {
          heat[i] = next;
          warm = true;
        }
      }

      // Re-measure before the blob is laid: it is deflected off these boxes,
      // and a stale one would have it clinging to where a card used to be.
      for (const body of bodies.values()) {
        body.box = boxOf(body.element, body.corner);
      }

      if (pointerLive && pointerX >= 0) follow(pointerX, pointerY);
      if (charging) {
        const charge = Math.min((now - chargedAt) / CHARGE_FULL, 1);
        stamp(chargeX, chargeY, 0.45 + charge * 0.5, sigma * (2 + charge * 8));
      }

      for (const body of bodies.values()) {
        outline(body, now);
        if (!body.card) rings(body, now);
      }

      if (waves.length > 0) advanceWaves(now);

      ctx.clearRect(0, 0, width, height);
      let painted = -1;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const value = heat[row * cols + col]! * GAIN;
          if (value < BANDS[0]!) continue;
          let band = 0;
          for (let b = BANDS.length - 1; b > 0; b--) {
            if (value >= BANDS[b]!) {
              band = b;
              break;
            }
          }
          if (band !== painted) {
            ctx.fillStyle = colours[band]!;
            painted = band;
          }
          ctx.fillRect(col * pitch, row * pitch, size, size);
        }
      }

      if (
        !warm &&
        !pointerLive &&
        !charging &&
        waves.length === 0 &&
        bodies.size === 0
      ) {
        frame = 0;
        last = 0;
        return;
      }
      frame = requestAnimationFrame(draw);
    };

    const wake = () => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    };

    /**
     * What the pointer is over. Guarded on the target rather than run on every
     * move: a move within one element cannot change the set, and this is the
     * only place the field touches the DOM.
     *
     * `pointerover` carries the same news for the moves the pointer did not
     * make — scrolling a card out from under a resting cursor is a hover
     * change with no `pointermove` behind it.
     */
    const onPointerEnter = (event: PointerEvent) => {
      if (event.target === hovered) return;
      hovered = event.target;
      syncBodies(event.target, performance.now() / 1000);
      wake();
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerLive = true;
      onPointerEnter(event);
      wake();
    };

    const onPointerLeave = () => {
      pointerLive = false;
      fromX = -1;
      fromY = -1;
      bodies.clear();
      hovered = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      syncBodies(event.target, performance.now() / 1000);
      for (const body of bodies.values()) {
        body.pressed = performance.now() / 1000;
      }
      // Pressing an element throws its own outline; that reads as the answer
      // to the press, so it does not also charge the field's shockwave.
      if (bodies.size > 0) {
        wake();
        return;
      }

      const target = event.target as Element | null;
      if (target?.closest("a, button, input, textarea, select")) return;
      charging = true;
      chargedAt = performance.now() / 1000;
      chargeX = event.clientX;
      chargeY = event.clientY;
      wake();
    };

    const onPointerUp = (event: PointerEvent) => {
      // A finger has nowhere to rest: it never leaves an element, so nothing
      // would ever clear what it lit, and the field would hold the last thing
      // touched — and keep animating it — for as long as the page is open.
      if (event.pointerType !== "mouse") {
        pointerLive = false;
        fromX = -1;
        fromY = -1;
        bodies.clear();
        hovered = null;
      }

      if (!charging) return;
      charging = false;
      const charge = Math.min(
        (performance.now() / 1000 - chargedAt) / CHARGE_FULL,
        1,
      );
      waves.push({
        x: chargeX,
        y: chargeY,
        born: performance.now() / 1000,
        power: 0.35 + charge * 2.1,
      });
      stamp(chargeX, chargeY, 1, sigma * (2.5 + charge * 18));
      wake();
    };

    const onVisibility = () => {
      if (document.hidden) {
        pointerLive = false;
        charging = false;
        fromX = -1;
        fromY = -1;
        heat.fill(0);
        waves.length = 0;
        bodies.clear();
        hovered = null;
      }
    };

    // Ignore the height-only resizes an iOS address bar produces; rebuilding
    // the field on those wipes the trail mid-scroll. A width change is also
    // what a zoom looks like, and a ratio change is what dragging the window
    // onto a second display looks like — both need the lattice re-read.
    let lastWidth = window.innerWidth;
    let lastRatio = window.devicePixelRatio;
    const onResize = () => {
      if (
        window.innerWidth === lastWidth &&
        window.devicePixelRatio === lastRatio
      ) {
        return;
      }
      lastWidth = window.innerWidth;
      lastRatio = window.devicePixelRatio;
      resize();
    };

    resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerover", onPointerEnter, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    document.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerover", onPointerEnter);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      // A canvas is a replaced element: `inset-0` alone leaves it at its
      // intrinsic 300×150. `size-full` is what actually stretches it — and
      // sizing it in CSS rather than from `innerWidth` keeps a classic
      // scrollbar from pushing it past the viewport.
      className="pointer-events-none fixed inset-0 z-0 size-full"
    />
  );
}
