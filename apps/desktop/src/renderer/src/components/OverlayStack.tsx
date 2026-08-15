/**
 * The floating overlay stack — the page rendered inside the transparent
 * overlay WebContentsView (shell-window.ts), layered above the tab views
 * and NOT part of the chrome document. A STACK OF SEPARATE CARDS, anchored
 * to the content hole's top-right: the floating audio player
 * (AudioPlayer.tsx) on top, the save-preview cards (SavePreviewOverlay.tsx)
 * stacking below it, so neither can ever cover the other.
 *
 * Each row carries its own opaque surface and edge (ui/overlay-card.ts).
 * They are unrelated notices that merely share a corner, so one tall
 * container around them would read as a single compound widget with its
 * parts run together. The div below is therefore unpainted — it exists to
 * lay the rows out and to be measured.
 *
 * The stack renders EDGE-TO-EDGE with no margins anywhere: the view swallows
 * clicks over its whole rect, so any padding would deaden a strip of the
 * page around the content. Even the inter-card gap is written to appear only
 * BETWEEN open rows, never at the ends (styles.css, [data-overlay-row]). All
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
import { DownloadCompleteOverlay } from "./DownloadCompleteOverlay";
import { NostrApprovalOverlay } from "./NostrApprovalOverlay";
import { SavePreviewOverlay } from "./SavePreviewOverlay";

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
      // The explicit zero still matters even now that the panel paints
      // nothing of its own: it is what takes the view off screen, rather
      // than leaving a 0×0 one parked over the corner.
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
      <div data-overlay-panel className="flex w-max flex-col items-end">
        {/* The voice assistant is NOT here anymore: it moved into the tool
            rail (RailVoice.tsx), whose column is chrome the tab views never
            cover — the other always-visible, always-alive surface — and it
            took the mic and speakers with it. */}
        <FloatingAudioPlayer />
        {/* Approval cards above save cards: they are actionable and waiting
            on the user, while a save card is a receipt. */}
        <NostrApprovalOverlay />
        {/* Download receipts above save receipts only because a finished
            download is the one the user was waiting on. */}
        <DownloadCompleteOverlay />
        <SavePreviewOverlay />
      </div>
    </div>
  );
}
