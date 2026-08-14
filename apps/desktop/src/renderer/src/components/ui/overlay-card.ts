/**
 * The surface of ONE row of the floating overlay stack (OverlayStack) — the
 * voice HUD, the audio player, and the approval / download / save cards.
 *
 * Every row wears this itself rather than borrowing one tall shared
 * container: the rows are unrelated notices that happen to share a corner,
 * and a single box around them reads as one compound widget whose parts run
 * together. Separate cards with a gap say what they are — a stack.
 *
 * Utilities rather than a CSS class on purpose. Written as plain CSS this
 * would sit OUTSIDE Tailwind's `utilities` layer and so outrank it, and a
 * `background` here would then beat the `hover:bg-ink/5` and `bg-danger/5`
 * a row paints over its own fill. As a class list it composes normally: the
 * later utility in the row's own className wins, exactly as elsewhere.
 *
 * Deliberately no shadow — over arbitrary page pixels a soft drop shadow
 * reads as a gray smudge (learned twice; see SavePreviewOverlay). The opaque
 * fill and the drawn --color-float-edge carry the separation instead.
 */
export const OVERLAY_CARD = "rounded-xl border border-float-edge bg-raised";
