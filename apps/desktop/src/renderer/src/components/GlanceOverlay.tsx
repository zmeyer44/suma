/**
 * GlanceOverlay — the chrome half of the Glance preview (Zen "Glance", Arc
 * "Peek"): a shift-clicked or pinned-tab link opened as a floating page over
 * the current tab instead of a new one.
 *
 * The PAGE is not rendered here — site content cannot live in the chrome
 * document. Main owns it as a WebContentsView (main/glance.ts) layered above
 * this raised frame; this component draws everything around it (the veil,
 * the card, the title bar) and reports the card's content hole via
 * `glance:bounds` so main places the page exactly inside it — the same
 * renderer-measures/main-positions contract as ContentPanes.
 *
 * Because the hole is filled by a sibling view, the measurement must wait
 * out the card's entrance animation: mid-animation the card is transform-
 * scaled, and a rect taken then would size the page wrong. Dismissal is
 * Esc, a click on the veil, or the ✕; ⌘↩ (and the title-bar button)
 * promotes the preview to a real tab, live view and all. Keystrokes landing
 * INSIDE the page are handled by main's before-input-event hook — this
 * component only sees them while the chrome has focus.
 */

import { useEffect, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  LoaderCircle,
  X,
} from "lucide-react";
import { useSumaStore } from "../store";
import { Button } from "./ui/button";

/** The card's entrance (--animate-overlay-in, 140ms) plus a safety frame —
 *  measure only once the card is at rest. */
const ENTRANCE_MS = 160;

export function GlanceOverlay() {
  const glance = useSumaStore((s) => s.glance);
  const open = glance !== null;
  const holeRef = useRef<HTMLDivElement | null>(null);

  // Measure the content hole once the entrance settles, then follow every
  // resize (the card is viewport-sized, so window resizes reshape it).
  useEffect(() => {
    if (!open) return;
    const el = holeRef.current;
    if (el === null) return;
    const report = (): void => {
      const rect = el.getBoundingClientRect();
      useSumaStore.getState().reportGlanceBounds({
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };
    let observer: ResizeObserver | null = null;
    const timer = window.setTimeout(() => {
      report();
      observer = new ResizeObserver(report);
      observer.observe(el);
    }, ENTRANCE_MS);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [open]);

  // Esc dismisses, ⌘↩ promotes — while the CHROME has focus (clicks on the
  // frame land here; clicks in the page move focus to the view, where main's
  // before-input-event hook takes over the same two keys).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        void useSumaStore.getState().closeGlance();
      } else if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        void useSumaStore.getState().promoteGlance();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (glance === null) return null;

  const origin = originOf(glance.url);
  const close = (): void => void useSumaStore.getState().closeGlance();

  return (
    <div className="fixed inset-0 z-40">
      {/* Click-anywhere-outside dismissal — the page view floats over the
          card, so every click this layer sees is genuinely outside it. */}
      <div
        className="veil animate-backdrop-in absolute inset-0"
        onClick={close}
      />
      <div className="pointer-events-none absolute inset-0 grid place-items-center px-10 py-8">
        <div className="animate-overlay-in filter-(--drop-modal) pointer-events-auto flex h-[min(88vh,940px)] w-[min(90vw,1240px)] flex-col overflow-hidden rounded-xl border border-modal-edge bg-modal">
          {/* Title bar: nav, identity, promote, dismiss. */}
          <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-hairline px-2.5">
            <Button
              variant="ghost"
              size="icon"
              title="Back"
              aria-label="Back"
              disabled={!glance.canGoBack}
              onClick={() => void useSumaStore.getState().glanceGoBack()}
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Forward"
              aria-label="Forward"
              disabled={!glance.canGoForward}
              onClick={() => void useSumaStore.getState().glanceGoForward()}
            >
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
            <div className="mx-1 flex min-w-0 flex-1 items-center justify-center gap-2">
              {glance.isLoading ? (
                <LoaderCircle
                  className="size-3.5 shrink-0 animate-spin text-muted"
                  aria-hidden="true"
                />
              ) : glance.faviconUrl !== null ? (
                <img
                  src={glance.faviconUrl}
                  alt=""
                  className="size-3.5 shrink-0 rounded-[3px]"
                />
              ) : (
                <Globe
                  className="size-3.5 shrink-0 text-faint"
                  aria-hidden="true"
                />
              )}
              <span className="truncate text-[12.5px] font-medium text-text">
                {glance.title || origin}
              </span>
              {origin !== "" ? (
                <span className="shrink-0 truncate text-[11.5px] text-faint">
                  {origin}
                </span>
              ) : null}
            </div>
            <Button
              variant="secondary"
              size="sm"
              title="Open as tab (⌘↩)"
              onClick={() => void useSumaStore.getState().promoteGlance()}
            >
              <ExternalLink className="size-3" aria-hidden="true" />
              Open as Tab
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Close (Esc)"
              aria-label="Close glance"
              onClick={close}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
          {/* The content hole. Main's page view covers this exact rect; the
              fill only shows for the beat before the first bounds report. */}
          <div ref={holeRef} className="min-h-0 flex-1 bg-bg" />
        </div>
      </div>
    </div>
  );
}

function originOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
