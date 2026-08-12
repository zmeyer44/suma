/**
 * The page's UI, as the pixel field sees it.
 *
 * The field is a grid of heat drawn behind the page, and every panel and
 * control on top of it is opaque — so anything it draws underneath one is
 * simply lost. What is left is the boundary, and that is the only place an
 * interaction between the two can read. This module reduces an element to the
 * shape of that boundary: a rounded box in the same viewport coordinates the
 * field is drawn in, answering the two questions the field asks of it —
 *
 *   - where is the point at arc length `t` around your edge, so heat can be
 *     run around it;
 *   - which point on your edge is nearest this one, and how deep inside are
 *     we, so a blob that has gone under you can be pushed back out.
 *
 * Boxes are measured per frame rather than cached. They move with every
 * scroll, and a reveal transition moves them without one.
 */

export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radius, already clamped to what the box can carry. */
  radius: number;
};

export type Point = { x: number; y: number };

function makeBox(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): Box {
  // A pill declares a radius far larger than it can hold (`rounded-full` is
  // 9999px); every formula below assumes the straight runs are non-negative,
  // so the declared value is clamped rather than trusted.
  const limit = Math.min(width, height) / 2;
  return {
    x,
    y,
    width,
    height,
    radius: Math.max(0, Math.min(radius, limit)),
  };
}

/**
 * The element's declared corner radius. Read once when the field picks the
 * element up: it is a computed style, and reading one per frame would flush
 * style recalculation on every frame the pointer is over a card.
 */
export function readCorner(element: Element): number {
  const declared = Number.parseFloat(
    getComputedStyle(element).borderTopLeftRadius,
  );
  return Number.isFinite(declared) ? declared : 0;
}

/** Measure the element as it stands right now, grown by `grow` on every side. */
export function boxOf(element: Element, corner: number, grow = 0): Box {
  const rect = element.getBoundingClientRect();
  return makeBox(
    rect.left - grow,
    rect.top - grow,
    rect.width + grow * 2,
    rect.height + grow * 2,
    corner + grow,
  );
}

/**
 * The same box, grown on every side. Growing the radius with it is what keeps
 * a ring offset from a pill parallel to the pill rather than squared off at
 * its ends.
 */
export function grownBox(box: Box, grow: number): Box {
  return makeBox(
    box.x - grow,
    box.y - grow,
    box.width + grow * 2,
    box.height + grow * 2,
    box.radius + grow,
  );
}

export function perimeter(box: Box): number {
  const straight =
    (box.width - box.radius * 2) * 2 + (box.height - box.radius * 2) * 2;
  return straight + 2 * Math.PI * box.radius;
}

/**
 * The point at arc length `t` clockwise from the top-left corner's end, wrapped
 * into the perimeter. Written into `out` rather than returned: this runs a few
 * hundred times a frame per traced element, and the garbage would show.
 */
export function pointAt(box: Box, t: number, out: Point): void {
  const r = box.radius;
  const runX = box.width - r * 2;
  const runY = box.height - r * 2;
  const arc = (Math.PI / 2) * r;
  const total = runX * 2 + runY * 2 + arc * 4;

  let at = total > 0 ? t % total : 0;
  if (at < 0) at += total;

  // Top edge, left to right.
  if (at < runX) {
    out.x = box.x + r + at;
    out.y = box.y;
    return;
  }
  at -= runX;

  if (at < arc) {
    const angle = -Math.PI / 2 + (at / arc) * (Math.PI / 2);
    out.x = box.x + box.width - r + Math.cos(angle) * r;
    out.y = box.y + r + Math.sin(angle) * r;
    return;
  }
  at -= arc;

  if (at < runY) {
    out.x = box.x + box.width;
    out.y = box.y + r + at;
    return;
  }
  at -= runY;

  if (at < arc) {
    const angle = (at / arc) * (Math.PI / 2);
    out.x = box.x + box.width - r + Math.cos(angle) * r;
    out.y = box.y + box.height - r + Math.sin(angle) * r;
    return;
  }
  at -= arc;

  if (at < runX) {
    out.x = box.x + box.width - r - at;
    out.y = box.y + box.height;
    return;
  }
  at -= runX;

  if (at < arc) {
    const angle = Math.PI / 2 + (at / arc) * (Math.PI / 2);
    out.x = box.x + r + Math.cos(angle) * r;
    out.y = box.y + box.height - r + Math.sin(angle) * r;
    return;
  }
  at -= arc;

  if (at < runY) {
    out.x = box.x;
    out.y = box.y + box.height - r - at;
    return;
  }
  at -= runY;

  const angle = Math.PI + (arc > 0 ? (at / arc) * (Math.PI / 2) : 0);
  out.x = box.x + r + Math.cos(angle) * r;
  out.y = box.y + r + Math.sin(angle) * r;
}

/**
 * The nearest point on the box's edge to (x, y), written into `out`. Returns
 * the signed distance to it — negative when the point is inside the box, which
 * is how the field knows the cursor has gone under an element and by how much.
 *
 * The core rect is the box pulled in by its own radius: clamping into it and
 * stepping back out by the radius lands on the edge for every point outside
 * that core, corners included. Points inside the core clamp to themselves, and
 * are resolved against the four sides instead.
 */
export function nearestEdge(
  box: Box,
  x: number,
  y: number,
  out: Point,
): number {
  const r = box.radius;
  const left = box.x + r;
  const right = box.x + box.width - r;
  const top = box.y + r;
  const bottom = box.y + box.height - r;

  const coreX = Math.min(Math.max(x, left), right);
  const coreY = Math.min(Math.max(y, top), bottom);
  const dx = x - coreX;
  const dy = y - coreY;
  const distance = Math.hypot(dx, dy);

  if (distance > 0.0001) {
    out.x = coreX + (dx / distance) * r;
    out.y = coreY + (dy / distance) * r;
    return distance - r;
  }

  // Deep inside: whichever wall is closest.
  const toLeft = x - box.x;
  const toRight = box.x + box.width - x;
  const toTop = y - box.y;
  const toBottom = box.y + box.height - y;
  const least = Math.min(toLeft, toRight, toTop, toBottom);

  out.x = least === toLeft ? box.x : least === toRight ? box.x + box.width : x;
  out.y = least === toTop ? box.y : least === toBottom ? box.y + box.height : y;
  return -least;
}

/** Samples used to locate a point around the edge. */
const SEARCH_SAMPLES = 96;

/**
 * Where a point sits around the edge, as a fraction of the perimeter.
 *
 * Found by sampling rather than solved, because the answer is only used to
 * pick where an outline starts drawing from — and a fraction, unlike an arc
 * length, stays roughly put when the same box is measured at another offset.
 */
export function nearestArcFraction(box: Box, x: number, y: number): number {
  const length = perimeter(box);
  if (length <= 0) return 0;

  const probe: Point = { x: 0, y: 0 };
  let bestAt = 0;
  let best = Infinity;

  for (let i = 0; i < SEARCH_SAMPLES; i++) {
    const at = (i / SEARCH_SAMPLES) * length;
    pointAt(box, at, probe);
    const gap = (probe.x - x) ** 2 + (probe.y - y) ** 2;
    if (gap < best) {
      best = gap;
      bestAt = at;
    }
  }

  return bestAt / length;
}
