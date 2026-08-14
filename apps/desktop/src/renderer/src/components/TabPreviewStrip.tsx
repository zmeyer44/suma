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
 * The preview shelf: hovering the tab row slides the page down and shows a
 * thumbnail card per tab, so "which tab was that?" is answered by looking at
 * the pages instead of guessing from favicons and truncated titles.
 *
 * The shelf is a layout SIBLING of the content hole, exactly like the chat
 * sidebar (App.tsx): its height shrinks the hole, ContentPanes re-reports the
 * bounds every frame of the slide, and main tracks the tab WebContentsViews
 * onto the smaller region — the live page slides down with the shelf, it is
 * never covered by it. That is also why no chrome-raise is needed: the shelf
 * only ever occupies chrome-owned rows, so it gets its pointer events for
 * free.
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
/** Slide durations, in ms. These MUST match `.tab-preview-slide` in
 *  styles.css: the close timer below is what unmounts the shelf. */
const OPEN_MS = 220;
const CLOSE_MS = 160;

function PreviewCard({ tab }: { tab: TabInfo }) {
  const selectTab = useSumaStore((s) => s.selectTab);
  const thumb = useSumaStore((s) => s.tabThumbnails[tab.id]);
  const shownOnScreen = tab.active || tab.split;

  return (
    <button
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
        shownOnScreen
          ? "border-accent/60 shadow-[0_0_0_1px_var(--color-accent)]"
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
      <span className="flex h-7 shrink-0 items-center gap-1.5 border-t border-ink/8 bg-chrome px-2">
        <TabMark tab={tab} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted group-hover:text-text">
          {tab.title || prettyUrl(tab.url) || "New tab"}
        </span>
      </span>
    </button>
  );
}

export function TabPreviewStrip() {
  const open = useSumaStore((s) => s.tabPreviewOpen);
  const tabs = useSumaStore((s) => s.tabs);

  // The shelf outlives `open` by one animation, the ChatSidebar pattern: it
  // mounts collapsed and expands next frame; on close it collapses first and
  // unmounts when the slide lands.
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [animating, setAnimating] = useState(false);
  const firstRun = useRef(true);

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
    setAnimating(true);
    setExpanded(false);
    const settle = window.setTimeout(() => {
      setMounted(false);
      setAnimating(false);
    }, CLOSE_MS);
    return () => window.clearTimeout(settle);
  }, [open]);

  if (!mounted) return null;

  // Same order as the strip renders: pinned tabs lead.
  const ordered = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];

  return (
    <div
      data-closing={open ? undefined : ""}
      style={{ height: expanded ? SHELF_H : 0 }}
      className={cn(
        "relative shrink-0 overflow-hidden bg-chrome",
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
