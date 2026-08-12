/**
 * The content hole and its split-view divider (§6).
 *
 * The hole is fully transparent — the main process overlays the tab
 * WebContentsViews on exactly the bounds we report, and resolves each pane's
 * share with the SAME shared geometry (shared/pane-layout.ts) we use to place
 * the divider here. The divider lives in the SPLIT_GAP_PX seam between the
 * two panes, the one strip of the hole no tab view covers — which is why it
 * can receive mouse events at all while the chrome view sits underneath.
 *
 * During a drag the chrome view is raised above the tab views (the store's
 * paneResizing flag feeds the same overlay mechanism modals use), so pointer
 * moves crossing the panes keep landing on this document instead of the
 * sites. The ratio streams to main per frame; both sides re-resolve, and the
 * views track the divider live.
 *
 * The hole is also where INTERNAL pages are drawn (`suma://settings`,
 * `suma://terminal`). Main gives an internal tab no visible view at all, so
 * its share of the hole is left uncovered and this document paints the page
 * into it — positioned with the same pane geometry main would have used for a
 * site, which is what keeps a settings page (or a terminal) in a split pane
 * aligned with the divider beside it.
 */

import { useEffect, useRef, useState } from "react";
import { parseInternalUrl } from "../../../shared/internal-pages";
import {
  clampSplitRatio,
  DEFAULT_SPLIT_RATIO,
  resolvePaneBounds,
  SPLIT_GAP_PX,
  splitViewLayout,
} from "../../../shared/pane-layout";
import type { ContentBounds } from "../../../shared/ipc";
import type { TabInfo } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { selectActiveSpace, selectActiveTab, useSumaStore } from "../store";
import { EmptyState } from "./EmptyState";
import { TerminalPage } from "./TerminalPage";
import { SettingsPage } from "./settings/SettingsPage";

/** Keyboard resize step (←/→ on the focused divider). */
const KEY_STEP = 0.02;

function SplitDivider({
  holeRef,
  spaceId,
  ratio,
  x,
}: {
  holeRef: React.RefObject<HTMLDivElement | null>;
  spaceId: string;
  ratio: number;
  x: number;
}) {
  const setSplitRatio = useSumaStore((s) => s.setSplitRatio);
  const setPaneResizing = useSumaStore((s) => s.setPaneResizing);
  const resizing = useSumaStore((s) => s.paneResizing);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const hole = holeRef.current;
    if (hole === null) return;
    e.preventDefault();
    setPaneResizing(true);
    const rect = hole.getBoundingClientRect();
    let raf = 0;
    let pendingX = e.clientX;
    const apply = () => {
      raf = 0;
      const raw = (pendingX - rect.left - SPLIT_GAP_PX / 2) / (rect.width - SPLIT_GAP_PX);
      setSplitRatio(spaceId, clampSplitRatio(raw, rect.width));
    };
    const onMove = (ev: PointerEvent) => {
      pendingX = ev.clientX;
      if (raf === 0) raf = requestAnimationFrame(apply);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf !== 0) cancelAnimationFrame(raf);
      setPaneResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const hole = holeRef.current;
    if (hole === null) return;
    const width = hole.getBoundingClientRect().width;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = ratio + (e.key === "ArrowLeft" ? -KEY_STEP : KEY_STEP);
      setSplitRatio(spaceId, clampSplitRatio(next, width));
    }
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize split panes"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        title="Drag to resize — double-click to reset"
        className="group absolute inset-y-0 z-10 cursor-col-resize outline-none"
        style={{ left: x, width: SPLIT_GAP_PX }}
        onPointerDown={onPointerDown}
        onDoubleClick={() => setSplitRatio(spaceId, DEFAULT_SPLIT_RATIO)}
        onKeyDown={onKeyDown}
      >
        <div
          className={cn(
            "mx-auto h-full w-[2px] rounded-full transition-colors",
            resizing
              ? "bg-accent/60"
              : "bg-transparent group-hover:bg-ink/25 group-focus-visible:bg-accent/50",
          )}
        />
      </div>
      {/* While dragging, the pointer roams the whole raised chrome — keep the
          resize cursor everywhere instead of flickering per element. */}
      {resizing ? <div className="fixed inset-0 z-50 cursor-col-resize" /> : null}
    </>
  );
}

/**
 * One internal page and the pane it fills, in hole-relative coordinates.
 * `null` bounds means the layout collapsed that pane (a hole too narrow to
 * split) — main hides the corresponding tab view, and we skip the page for
 * the same reason.
 */
function InternalPane({
  bounds,
  tab,
}: {
  bounds: ContentBounds;
  tab: TabInfo;
}) {
  const route = parseInternalUrl(tab.url);
  if (route === null) return null;
  return (
    <div
      className="absolute overflow-hidden"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
    >
      {route.page === "terminal" ? (
        <TerminalPage />
      ) : (
        <SettingsPage section={route.section} tabId={tab.id} />
      )}
    </div>
  );
}

export function ContentPanes() {
  const holeRef = useRef<HTMLDivElement>(null);
  const reportContentBounds = useSumaStore((s) => s.reportContentBounds);
  const pushSplitRatio = useSumaStore((s) => s.pushSplitRatio);
  const activeTab = useSumaStore(selectActiveTab);
  const splitTab = useSumaStore((s) => s.tabs.find((t) => t.split) ?? null);
  const hydrated = useSumaStore((s) => s.hydrated);
  const spaceId = useSumaStore((s) => selectActiveSpace(s)?.id ?? null);
  const splitActive = useSumaStore((s) => s.tabs.some((t) => t.split));
  const ratio = useSumaStore((s) =>
    spaceId === null ? DEFAULT_SPLIT_RATIO : (s.splitRatios[spaceId] ?? DEFAULT_SPLIT_RATIO),
  );
  // Height matters as well as width now: an internal page is laid out by this
  // document, so it needs the pane's full rect rather than just the divider's
  // x — main resolves the same rect for a site's view from the same engine.
  const [hole, setHole] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = holeRef.current;
    if (el === null) return;

    let raf = 0;
    const measure = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      setHole({ width: r.width, height: r.height });
      reportContentBounds({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(measure);
    };

    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("resize", schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [reportContentBounds]);

  // Main holds one live ratio; hand it this space's on switch and startup.
  useEffect(() => {
    if (spaceId !== null) pushSplitRatio(spaceId);
  }, [spaceId, pushSplitRatio]);

  // Pane rects from the same engine main resolves view bounds with, in
  // hole-relative coordinates — a lone-left layout (hole too narrow to split)
  // yields no "right" pane at all, and therefore no divider.
  const panes = resolvePaneBounds(
    splitActive ? splitViewLayout(hole.width, ratio) : { pane: "left" },
    { x: 0, y: 0, width: hole.width, height: hole.height },
  );
  const dividerX =
    splitActive && spaceId !== null && panes.has("right")
      ? (panes.get("left")?.width ?? null)
      : null;

  // Only tabs main actually leaves uncovered: the active one, plus the split
  // pane's when the layout resolved it.
  const internalPanes = [
    { tab: activeTab, bounds: panes.get("left") },
    { tab: dividerX === null ? null : splitTab, bounds: panes.get("right") },
  ];

  return (
    <div className="min-h-0 min-w-0 flex-1 bg-transparent">
      <div ref={holeRef} className="relative h-full w-full bg-transparent">
        {internalPanes.map(({ tab, bounds }) =>
          tab === null || bounds === undefined ? null : (
            <InternalPane bounds={bounds} key={tab.id} tab={tab} />
          ),
        )}
        {dividerX !== null && spaceId !== null ? (
          <SplitDivider holeRef={holeRef} spaceId={spaceId} ratio={ratio} x={dividerX} />
        ) : null}
        {hydrated && activeTab === null ? <EmptyState /> : null}
      </div>
    </div>
  );
}
