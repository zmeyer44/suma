import { useEffect, useRef, useState } from "react";
import type { TabInfo } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import {
  previewDismiss,
  previewZoneEnter,
  previewZoneLeave,
} from "../lib/tab-preview";
import { prettyUrl } from "../lib/url";
import { useSumaStore } from "../store";
import { TabMark } from "./TabStrip";

/**
 * The preview shelf: hovering the tab row unrolls a thumbnail card per tab
 * under the strip, so "which tab was that?" is answered by looking at the
 * pages instead of guessing from favicons and truncated titles.
 *
 * The shelf is an OVERLAY on the content hole, the SideRail's mechanism: the
 * page under it never moves or resizes — the shelf clips open over it. The
 * tab WebContentsViews normally sit ABOVE this document, so while the shelf
 * is mounted tabPreviewMounted rides App's modalOpen and main raises the
 * chrome; dismissal unmounts (and lowers) in the same frame. The raise means
 * page clicks go dead while the shelf shows, so a pointerdown anywhere
 * outside the shelf and the strip dismisses it immediately rather than
 * waiting out the hover grace period.
 *
 * The pictures come from main's per-tab capture cache (tabs.ts): the visible
 * tab is snapshotted when it settles after a load and again the moment it is
 * switched away from, so every card shows the page as it last looked while
 * on screen. Cards without a capture yet (never-shown tabs, internal pages,
 * blank new-tabs) fall back to the tab's mark on a plain surface.
 */

/** Shelf height. Cards are sized to it; see CARD_W's ratio note. */
const SHELF_H = 156;
/** Card width — with the shelf's padding/caption this leaves the thumbnail
 *  box near 16:10, the shape of the content hole it snapshots. */
const CARD_W = 176;
/** Opening slide duration, in ms — MUST match `.tab-preview-slide` in
 *  styles.css. Closing has no counterpart on purpose: dismissal is instant
 *  (unmount in the same frame), so the page is back the moment the shelf is
 *  no longer wanted. */
const OPEN_MS = 220;

function PreviewCard({ tab }: { tab: TabInfo }) {
  const selectTab = useSumaStore((s) => s.selectTab);
  const thumb = useSumaStore((s) => s.tabThumbnails[tab.id]);
  // The pointer is on this tab's slot in the STRIP: mirror the card's own
  // hover treatment, so the row and the shelf visibly agree on which page a
  // click right now would activate.
  const stripHovered = useSumaStore((s) => s.tabPreviewHoverId === tab.id);
  const shownOnScreen = tab.active || tab.split;

  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The shelf row scrolls; a mirrored hover on a card that is out of view
    // indicates nothing. Nearest-edge, so cards already visible stay put.
    if (stripHovered) {
      ref.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [stripHovered]);

  return (
    <button
      ref={ref}
      type="button"
      title={`${tab.title || tab.url}\n${prettyUrl(tab.url)}`}
      aria-label={`Switch to ${tab.title || prettyUrl(tab.url) || "tab"}`}
      aria-current={shownOnScreen ? "true" : undefined}
      onClick={() => {
        previewDismiss();
        void selectTab(tab.id);
      }}
      style={{ width: CARD_W }}
      className={cn(
        "group flex h-full shrink-0 cursor-pointer flex-col overflow-hidden rounded-[10px] border text-left transition-[border-color,transform] duration-150 hover:-translate-y-0.5",
        stripHovered && "-translate-y-0.5",
        shownOnScreen
          ? "border-accent/60 shadow-[0_0_0_1px_var(--color-accent)]"
          : stripHovered
            ? "border-ink/30"
            : "border-ink/12 hover:border-ink/30",
      )}
    >
      <span className="relative min-h-0 flex-1 overflow-hidden bg-panel">
        {thumb !== undefined ? (
          <img
            src={thumb.dataUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        ) : (
          // No capture yet — the page has never been on screen (or is an
          // internal page the chrome draws itself). The mark still names it.
          <span className="absolute inset-0 grid place-items-center">
            <span className="scale-150">
              <TabMark tab={tab} />
            </span>
          </span>
        )}
      </span>
      <span className="flex h-7 shrink-0 items-center gap-1.5 border-t border-ink/8 bg-shelf px-2">
        <TabMark tab={tab} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[11px] group-hover:text-text",
            stripHovered ? "text-text" : "text-muted",
          )}
        >
          {tab.title || prettyUrl(tab.url) || "New tab"}
        </span>
      </span>
    </button>
  );
}

export function TabPreviewStrip() {
  const open = useSumaStore((s) => s.tabPreviewOpen);
  const tabs = useSumaStore((s) => s.tabs);

  // Asymmetric lifecycle: opening mounts collapsed and expands next frame
  // (the ChatSidebar two-frame trick); closing unmounts instantly — no exit
  // animation, so the page is back the moment the shelf is dismissed.
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [animating, setAnimating] = useState(false);
  const firstRun = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);

  // The chrome-raise flag tracks mounted, so raise and unmount move as one
  // commit in both directions.
  const setTabPreviewMounted = useSumaStore((s) => s.setTabPreviewMounted);
  useEffect(() => {
    setTabPreviewMounted(mounted);
    // A stuck flag would leave the chrome permanently raised, deadening
    // every click on the page — clear it if the shelf ever unmounts early.
    return () => setTabPreviewMounted(false);
  }, [mounted, setTabPreviewMounted]);

  // With the chrome raised, clicks aimed at the page land on this document
  // instead — swallowed by nothing. Any press outside the shelf and the
  // strip dismisses at once, so the page is never more than one click away.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (rootRef.current?.contains(target)) return;
      // The strip owns its own gestures (selecting a tab already dismisses).
      if (target.closest(".drag-region") !== null) return;
      previewDismiss();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (open) {
      setMounted(true);
      setAnimating(true);
      // Two frames: the collapsed height must be painted before the expanded
      // one is set, or both coalesce and there is nothing to transition from.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      const settle = window.setTimeout(() => setAnimating(false), OPEN_MS + 60);
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        window.clearTimeout(settle);
      };
    }
    // Closing is INSTANT: no slide-out, no timer. Unmounting here also drops
    // tabPreviewMounted in the same commit, so the chrome lowers and the live
    // page is back in one frame.
    setMounted(false);
    setExpanded(false);
    setAnimating(false);
    return undefined;
  }, [open]);

  if (!mounted) return null;

  // Same order as the strip renders: pinned tabs lead.
  const ordered = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];

  return (
    <div
      ref={rootRef}
      style={{ height: expanded ? SHELF_H : 0 }}
      // Fixed under the strip (h-12), OVER the page: the content hole never
      // reflows for the shelf. z-30 sits above the split drop zones (z-20)
      // and below the notification stack (z-50); no modal coexists with it.
      // bg-shelf IS the active tab's face color (styles.css): the strip keeps
      // its own gradient, and the folder-shaped active tab — the one element
      // painted in this color up there — appears to flow directly into this
      // container, as if tab and shelf were one piece of paper. The cast
      // shadow is what reads as "floating over the page" now that the page
      // continues underneath.
      className={cn(
        "fixed inset-x-0 top-12 z-30 overflow-hidden bg-shelf shadow-pop",
        animating && "tab-preview-slide",
      )}
      onPointerEnter={previewZoneEnter}
      onPointerLeave={previewZoneLeave}
    >
      {/* Held at full height and bottom-anchored inside the clipped box, so
          the row slides down as one piece instead of reflowing per frame. */}
      <div
        style={{ height: SHELF_H }}
        className="absolute inset-x-0 bottom-0 flex items-stretch gap-2.5 overflow-x-auto overscroll-x-contain px-3 pt-2.5 pb-3"
      >
        {ordered.map((tab) => (
          <PreviewCard key={tab.id} tab={tab} />
        ))}
      </div>
      {/* Bottom hairline — the shelf's own edge against the banners/hole. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-chrome-edge"
      />
    </div>
  );
}
