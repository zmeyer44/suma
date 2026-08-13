/**
 * The floating overlay stack — the page rendered inside the transparent
 * overlay WebContentsView (shell-window.ts), layered above the tab views
 * and NOT part of the chrome document. One tinted GLASS PANEL, anchored to
 * the content hole's top-right: the floating audio player (AudioPlayer.tsx)
 * on top, the save-preview cards (SavePreviewOverlay.tsx) stacking below
 * it, so neither can ever cover the other.
 *
 * The panel's surface is a translucent app-palette tint (.overlay-glass) —
 * a sibling view's pixels cannot be blurred from here, so there is no real
 * frost (see styles.css for the history). The panel renders EDGE-TO-EDGE
 * with no margins anywhere: the view swallows clicks over its whole rect,
 * so any padding would deaden a strip of the page around the content. All
 * breathing room comes from the view's placement margin in main.
 *
 * This component owns the size contract with main: the view must be sized
 * to EXACTLY the visible panel. Every frame the panel's geometry changes
 * (the grid-cell transitions animate through intermediate heights), the
 * measured size goes out over `savePreview:bounds`; zero height ⇒ the view
 * leaves the screen. Width comes from the panel rather than the container —
 * the container is as wide as the view, which is as wide as the last
 * report, so measuring it would only echo the previous answer. This is what
 * lets the view shrink to a sliver when only the collapsed player pill is
 * showing, instead of deadening a full card-width of the page.
 */

import { useEffect, useRef } from "react";
import { FloatingAudioPlayer } from "./AudioPlayer";
import { NostrApprovalOverlay } from "./NostrApprovalOverlay";
import { SavePreviewOverlay } from "./SavePreviewOverlay";
import { VoiceHud } from "./VoiceHud";

export function OverlayStack() {
  const stackRef = useRef<HTMLDivElement>(null);
  const lastReported = useRef({ width: -1, height: -1 });

  useEffect(() => {
    const el = stackRef.current;
    if (el === null || !window.suma) return;
    const suma = window.suma;

    const report = (): void => {
      // Visibility is read off the CELLS' clipping wrappers (the
      // [data-overlay-item] carriers), never the content: overflow-hidden
      // clips a collapsed card visually, but the card element itself keeps
      // its full layout rect, so content would always measure "visible".
      // An empty panel is only its own border — nothing to show, so the
      // report is zero, not 2px.
      const rows = [...el.querySelectorAll("[data-overlay-item]")].filter(
        (row) => row.getBoundingClientRect().height >= 1,
      );
      const panel = el.querySelector("[data-overlay-panel]");
      const empty = rows.length === 0 || panel === null;
      const width = empty ? 0 : Math.ceil(panel.getBoundingClientRect().width);
      const height = empty ? 0 : Math.ceil(el.getBoundingClientRect().height);
      if (lastReported.current.width === width && lastReported.current.height === height) {
        return;
      }
      lastReported.current = { width, height };
      void suma.invoke("savePreview:bounds", { height, width }).catch(() => undefined);
    };

    // The observer pair covers every way the stack changes shape: the
    // ResizeObserver follows the animated heights frame by frame, and the
    // MutationObserver catches what resizing cannot — the last card
    // unmounting, and class swaps (card ⇄ pill) that change width without
    // changing height.
    const resizeObserver = new ResizeObserver(report);
    resizeObserver.observe(el);
    const mutationObserver = new MutationObserver(report);
    mutationObserver.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    report();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  // w-max, never w-fit: the panel's width is the window-width signal, and
  // fit-content is capped by the container — which is the window, which is
  // the previous report. That is a feedback loop that latches the panel at
  // whatever width it last had; max-content sizes from the rows alone (the
  // card's fixed 320px, the pill's fitted sliver), whatever the window is.
  return (
    <div ref={stackRef} className="flex flex-col items-end">
      <div
        data-overlay-panel
        className="overlay-glass flex w-max flex-col items-end overflow-hidden rounded-xl border border-ink/15"
      >
        {/* The voice assistant first: while a conversation is live it is the
            row the user is talking to — and this row also OWNS the mic and
            speakers for the feature (see VoiceHud.tsx), so it must live in
            this always-alive view, not the chrome. */}
        <VoiceHud />
        <FloatingAudioPlayer />
        {/* Approval cards above save cards: they are actionable and waiting
            on the user, while a save card is a receipt. */}
        <NostrApprovalOverlay />
        <SavePreviewOverlay />
      </div>
    </div>
  );
}
