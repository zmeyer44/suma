/**
 * The manila-folder silhouette shared across Suma's chrome: the active tab
 * in the tab strip and the title tab on modal panels are the same shape at
 * different scales — rounded top corners, sides tapering slightly outward
 * toward the base, and concave flares that merge the tab into the surface
 * below it. Geometry was sampled frame-by-frame from the reference capture
 * (see TabStrip).
 */

/** Cubic-bezier kappa for a quarter circle. */
const K = 0.552;

export interface FolderGeometry {
  /** Total height of the tab, flare base included. */
  h: number;
  /** Radius of the concave flares where the tab meets its surface. */
  flare: number;
  /** Radius of the rounded top corners. */
  radius: number;
  /** Horizontal inset of the top edge relative to the base (the ~4° lean). */
  taper: number;
}

export const n = (v: number): number => Number(v.toFixed(2));

/** Open path along the outer folder edge, left flare tip → right flare tip. */
export function folderOutline(w: number, g: FolderGeometry): string {
  const { h: H, flare: F, radius: R, taper } = g;
  const bl = F;
  const tl = F + taper;
  const br = w - F;
  const tr = w - F - taper;
  return [
    `M0 ${H}`,
    `C${n(K * F)} ${H} ${bl} ${n(H - F + K * F)} ${bl} ${H - F}`,
    `L${tl} ${R}`,
    `C${tl} ${n(R * (1 - K))} ${n(tl + R * (1 - K))} 0 ${tl + R} 0`,
    `L${n(tr - R)} 0`,
    `C${n(tr - R * (1 - K))} 0 ${tr} ${n(R * (1 - K))} ${tr} ${R}`,
    `L${br} ${H - F}`,
    `C${br} ${n(H - F + K * F)} ${n(w - K * F)} ${H} ${w} ${H}`,
  ].join(" ");
}
