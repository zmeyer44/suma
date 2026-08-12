import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Download,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  Sparkles,
  SquareTerminal,
  Star,
  X,
} from "lucide-react";
import {
  favoriteForUrl,
  normalizeFavoriteUrl,
} from "../../../shared/favorites";
import {
  isInternalPageUrl,
  parseInternalUrl,
} from "../../../shared/internal-pages";
import type { ContentBounds, SpaceInfo, TabInfo } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { folderOutline, n } from "../lib/folder";
import { useMeasuredWidth } from "../lib/measure";
import { hostOf, prettyUrl } from "../lib/url";
import { useSumaStore } from "../store";
import { ContinuityDot } from "./ContinuityDot";
import { Favicon } from "./Favicon";
import { StatusPills } from "./StatusPills";

/**
 * Single-row browser chrome doubling as the titlebar: nav controls on the
 * left, tabs inline, and the space switcher plus utility buttons on the
 * right. Tabs hold their position — selecting one never moves it — and any
 * tab can be dragged to reorder, with the tabs it passes sliding
 * (FLIP-animated) into their new slots. A drag never leaves the row: it is
 * clamped to the tabs' own span, so a tab cannot be flung off either end of
 * the window. Dragging one DOWN out of the strip instead offers the two halves
 * of the page as drop targets, and releasing over one puts the tab in that
 * pane of a split (§6). The active tab doubles as the
 * omnibox: it shows the page title at rest and cross-fades to its address on
 * hover. The active tab is
 * a manila-folder silhouette — rounded top corners, sides tapering ~4°
 * outward, and concave bottom flares — drawn as an SVG path so it merges
 * seamlessly into the chrome panel below. Geometry and shading were sampled
 * frame-by-frame from the reference capture:
 *   top radius ≈ 0.28·H, flare radius ≈ 0.21·H, side taper ≈ 0.07·H,
 *   fill = panel color with a faint lighter wash at the top,
 *   and one uniform 1px highlight tracing the whole silhouette (it continues
 *   into the strip's bottom hairline, which is the panel's top edge).
 */
const TAB_H = 40;
const FLARE = 9;
const RADIUS = 11;
const TAPER = 3;
/** The active tab's silhouette, shared with the modal chrome (lib/folder). */
const FOLDER = { h: TAB_H, flare: FLARE, radius: RADIUS, taper: TAPER };

/** The folder-shaped backdrop behind the active tab; flares overflow 9px per side. */
function FolderShell() {
  const [ref, width] = useMeasuredWidth();
  const gradientId = useId();

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute -inset-x-[9px] bottom-0 h-[40px]"
    >
      {width > 0 ? (
        <svg
          width={width}
          height={TAB_H}
          className="absolute inset-0 overflow-visible filter-(--drop-tab)"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              {/* style, not stopColor: var() only resolves through CSS.
                  --color-tab-*, not --color-chrome*: this fill paints over the
                  strip, and the tab tokens carry the alpha that composites
                  with it to the intended face opacity (styles.css). */}
              <stop offset="0" style={{ stopColor: "var(--color-tab-wash)" }} />
              <stop
                offset="0.6"
                style={{ stopColor: "var(--color-tab-face)" }}
              />
            </linearGradient>
          </defs>
          <path
            d={`${folderOutline(width, FOLDER)} Z`}
            fill={`url(#${gradientId})`}
          />
          <path
            d={folderOutline(width, FOLDER)}
            fill="none"
            stroke="var(--color-chrome-edge)"
            strokeWidth="1.5"
          />
        </svg>
      ) : null}
    </div>
  );
}

const HOVER_H = 32;
const HOVER_R = 9;
/** Visual gap between the active tab's silhouette and an adjacent raised fill. */
const GAP = 5;

/**
 * Raised-fill outline for a tab that sits right beside the active tab. The
 * near edge runs parallel to the active tab's taper at a constant GAP, and
 * both of its ends are tangent fillets — an arc matching the active tab's
 * corner RADIUS into the strip top, and a HOVER_R arc into the fill's bottom
 * edge — so every transition is smoothly rounded. The far side keeps the
 * plain rounded-rect corners.
 */
function hoverAdjacentPath(w: number, side: "left" | "right"): string {
  const R = HOVER_R;
  const RT = RADIUS; // near-top fillet, same curvature as the active corner
  const RB = HOVER_R; // near-bottom fillet
  const DY = TAB_H - RADIUS - FLARE; // vertical run of the active taper
  const len = Math.hypot(TAPER, DY);
  const nx = DY / len; // slant's rightward unit normal
  const ny = -TAPER / len;
  // Slant parallel to the taper, GAP to the right of the active silhouette.
  const xAt = (y: number) => GAP - (TAPER * (HOVER_H - 1 - y)) / DY;
  // Fillet tangent to the slant and the strip top (y = 0).
  const tpY = RT * (1 - ny);
  const tpX = xAt(tpY);
  const tcX = tpX + nx * RT;
  // Fillet tangent to the slant and the fill's bottom edge (y = HOVER_H).
  const bpY = HOVER_H - RB * (1 + ny);
  const bpX = xAt(bpY);
  const bcX = bpX + nx * RB;
  if (side === "left") {
    return [
      `M${n(bcX)} ${HOVER_H}`,
      `A${RB} ${RB} 0 0 1 ${n(bpX)} ${n(bpY)}`,
      `L${n(tpX)} ${n(tpY)}`,
      `A${RT} ${RT} 0 0 1 ${n(tcX)} 0`,
      `L${n(w - R)} 0`,
      `A${R} ${R} 0 0 1 ${w} ${R}`,
      `L${w} ${HOVER_H - R}`,
      `A${R} ${R} 0 0 1 ${n(w - R)} ${HOVER_H}`,
      "Z",
    ].join(" ");
  }
  return [
    `M${n(w - bcX)} ${HOVER_H}`,
    `A${RB} ${RB} 0 0 0 ${n(w - bpX)} ${n(bpY)}`,
    `L${n(w - tpX)} ${n(tpY)}`,
    `A${RT} ${RT} 0 0 0 ${n(w - tcX)} 0`,
    `L${R} 0`,
    `A${R} ${R} 0 0 0 0 ${R}`,
    `L0 ${HOVER_H - R}`,
    `A${R} ${R} 0 0 0 ${R} ${HOVER_H}`,
    "Z",
  ].join(" ");
}

/**
 * Hover backdrop for tabs bordering the active tab. Mounted always (so the
 * width is measurable) with the svg itself toggled on group-hover.
 */
function HoverShell({ side }: { side: "left" | "right" }) {
  const [ref, width] = useMeasuredWidth();
  const gradientId = useId();

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
    >
      {width > 0 ? (
        <svg
          width={width}
          height={HOVER_H}
          className="absolute inset-0 overflow-visible hidden group-hover:block"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              {/* style, not stopColor: var() only resolves through CSS. */}
              <stop
                offset="0"
                style={{ stopColor: "var(--color-ink)" }}
                stopOpacity="0.05"
              />
              <stop
                offset="1"
                style={{ stopColor: "var(--color-ink)" }}
                stopOpacity="0.10"
              />
            </linearGradient>
          </defs>
          <path
            d={hoverAdjacentPath(width, side)}
            fill={`url(#${gradientId})`}
          />
        </svg>
      ) : null}
    </div>
  );
}

/**
 * A tab's origin — "" for an internal page (`suma://settings`), which has
 * none. Empty is exactly what ContinuityDot renders as a spacer and what
 * keeps the sync corpus from being consulted about a host called "settings".
 */
function tabHost(tab: TabInfo): string {
  return isInternalPageUrl(tab.url) ? "" : hostOf(tab.url);
}

/**
 * A tab's 16px mark. Internal pages get one of Suma's own glyphs rather than
 * the initial-letter tile: they have no favicon to fail over from, and the
 * letter would change as the sidebar walked between settings sections.
 */
function TabMark({ tab }: { tab: TabInfo }) {
  const route = parseInternalUrl(tab.url);
  if (route === null)
    return <Favicon src={tab.faviconUrl} seed={tabHost(tab) || tab.title} />;
  const Glyph = route.page === "terminal" ? SquareTerminal : Settings;
  return (
    <span className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-ink/8 text-muted">
      <Glyph className="size-2.5" aria-hidden="true" />
    </span>
  );
}

/** Compact nav button living inside the active tab; swallows tab gestures. */
function TabNavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="grid size-5 shrink-0 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-ink/10 hover:text-text"
    >
      {children}
    </button>
  );
}

/**
 * Progressive nav reveal: bare at rest, reload alone once the tab is hovered,
 * and back/forward unfolding to its left when the pointer reaches the cluster.
 * `group/nav` wraps the *whole* cluster rather than the reload button, so
 * sliding onto an arrow keeps the arrows open — and since the cluster
 * collapses to zero width at rest, it can only be entered via the revealed
 * reload button. Each slot tweens with the grid 0fr→1fr trick, so the widths
 * follow their content instead of a hardcoded pixel value and everything
 * downstream (favicon, title, omnibox) slides rather than jumps. Directions
 * with no history are omitted entirely — never shown as dead affordances.
 *
 * Drawn by every tab that is a VISIBLE page — the active tab, and both panes
 * of a split. It is addressed to its own tab rather than to the active one,
 * so the arrows and their disabled/omitted state always describe the history
 * of the page the cluster is drawn on.
 */
function TabNavCluster({ tab }: { tab: TabInfo }) {
  const goBack = useSumaStore((s) => s.goBack);
  const goForward = useSumaStore((s) => s.goForward);
  const reload = useSumaStore((s) => s.reload);

  return (
    <span className="no-drag group/nav flex shrink-0 items-center">
      {tab.canGoBack || tab.canGoForward ? (
        <span className="grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-250 ease-out group-hover/nav:grid-cols-[1fr] group-hover/nav:opacity-100 group-focus-within/nav:grid-cols-[1fr] group-focus-within/nav:opacity-100">
          {/* Spacing lives on clipped *content*, never as padding on the
              clip box: padding does not shrink, so it would leave the
              cluster a couple of px wide at rest — enough to catch a
              hover and unfold the arrows without the reload button ever
              being visible. */}
          <span className="flex min-w-0 items-center gap-0.5 overflow-hidden">
            {tab.canGoBack ? (
              <TabNavButton label="Back" onClick={() => void goBack(tab.id)}>
                <ChevronLeft className="size-3" aria-hidden="true" />
              </TabNavButton>
            ) : null}
            {tab.canGoForward ? (
              <TabNavButton
                label="Forward"
                onClick={() => void goForward(tab.id)}
              >
                <ChevronRight className="size-3" aria-hidden="true" />
              </TabNavButton>
            ) : null}
            <span aria-hidden="true" className="w-0.5 shrink-0" />
          </span>
        </span>
      ) : null}
      <span className="grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-200 ease-out group-hover:grid-cols-[1fr] group-hover:opacity-100 group-has-[:focus-visible]:grid-cols-[1fr] group-has-[:focus-visible]:opacity-100">
        <span className="flex min-w-0 items-center overflow-hidden">
          <TabNavButton label="Reload" onClick={() => void reload(tab.id)}>
            <RotateCw className="size-2.5" aria-hidden="true" />
          </TabNavButton>
        </span>
      </span>
    </span>
  );
}

/**
 * Loading prefix and title — the label under every favicon in the strip.
 *
 * The prefix is a spinner rather than the word "Loading…": it costs a fraction
 * of the width in a strip where titles are already being truncated, and it
 * reads as motion instead of as the first word of the title. The label stays
 * on the element for anyone who is not looking at it.
 */
function TabTitle({ tab }: { tab: TabInfo }) {
  return (
    <>
      {tab.isLoading ? (
        <LoaderCircle
          role="img"
          aria-label="Loading"
          className="mr-1 inline-block size-2.5 shrink-0 animate-spin align-[-1px] text-faint"
        />
      ) : null}
      {tab.title || prettyUrl(tab.url) || "New tab"}
    </>
  );
}

/**
 * The label of a tab whose page is on screen — the active tab, or either pane
 * of a split. Title at rest, cross-fading to the clickable address on hover,
 * or when the address itself is keyboard-focused. Background tabs get a plain
 * title instead: an address is only worth editing where its page is visible.
 *
 * has-[:focus-visible], NOT focus-within: the tab root is the group AND is
 * focusable, so :focus-within matches it the moment the tab is clicked —
 * which left the selected tab showing neither its title nor (it is not
 * hovered) its address.
 */
function ActiveTabLabel({ tab, onEdit }: { tab: TabInfo; onEdit: () => void }) {
  return (
    <span className="relative min-w-0 flex-1 self-stretch">
      <span className="pointer-events-none absolute inset-0 flex items-center transition-opacity duration-150 group-has-[:focus-visible]:opacity-0 group-hover:opacity-0">
        <span className="min-w-0 truncate text-[12.5px]">
          <TabTitle tab={tab} />
        </span>
      </span>
      <ActiveTabUrl tab={tab} onEdit={onEdit} />
    </span>
  );
}

function TabCloseButton({ tab }: { tab: TabInfo }) {
  const closeTab = useSumaStore((s) => s.closeTab);

  return (
    <button
      type="button"
      title="Close tab"
      aria-label={`Close ${tab.title || "tab"}`}
      onClick={(e) => {
        e.stopPropagation();
        void closeTab(tab.id);
      }}
      className="grid size-4 place-items-center rounded text-faint hover:bg-ink/12 hover:text-text"
    >
      <X className="size-2.5" aria-hidden="true" />
    </button>
  );
}

/**
 * Stars the tab's CURRENT address in the favorite sites (the tile row under
 * the URL bar, editable in settings). An address, not a page: navigating away
 * unfills the star, and pressing it again on another page favorites that one
 * too. Hidden on anything a favorite could not reopen (internal pages).
 */
function FavoriteToggleButton({ tab }: { tab: TabInfo }) {
  const isFavorite = useSumaStore(
    (s) => favoriteForUrl(s.favorites, tab.url) !== null,
  );
  const toggleFavorite = useSumaStore((s) => s.toggleFavorite);

  if (normalizeFavoriteUrl(tab.url) === null) return null;
  return (
    <button
      type="button"
      title={isFavorite ? "Remove from favorites" : "Add to favorites"}
      aria-label={
        isFavorite
          ? `Remove ${tab.title || "tab"} from favorites`
          : `Add ${tab.title || "tab"} to favorites`
      }
      aria-pressed={isFavorite}
      onClick={(e) => {
        e.stopPropagation();
        void toggleFavorite(tab.url, tab.title);
      }}
      className={cn(
        "grid size-4 place-items-center rounded hover:bg-ink/12 hover:text-text",
        isFavorite ? "text-accent" : "text-faint",
      )}
    >
      <Star
        className="size-2.5"
        fill={isFavorite ? "currentColor" : "none"}
        aria-hidden="true"
      />
    </button>
  );
}

/** Opens the tab in the second pane, or dissolves the split it is part of. */
function SplitToggleButton({ tab }: { tab: TabInfo }) {
  const toggleSplit = useSumaStore((s) => s.toggleSplit);

  return (
    <button
      type="button"
      title={tab.split ? "Close split" : "Open in split view"}
      aria-label={
        tab.split
          ? `Close split for ${tab.title || "tab"}`
          : `Open ${tab.title || "tab"} in split view`
      }
      onClick={(e) => {
        e.stopPropagation();
        void toggleSplit(tab.id);
      }}
      className={cn(
        "grid size-4 place-items-center rounded hover:bg-ink/12 hover:text-text",
        tab.split ? "text-accent" : "text-faint",
      )}
    >
      <Columns2 className="size-2.5" aria-hidden="true" />
    </button>
  );
}

function Tab({
  tab,
  iconOnly,
  activeSide,
  dragging = false,
  onActivate,
  onEditAddress,
  onPointerDown,
}: {
  tab: TabInfo;
  iconOnly?: boolean;
  /** Which side of this tab the active tab sits on, if directly adjacent. */
  activeSide: "left" | "right" | null;
  /** This tab is the one being dragged: it rides above the row, not with it. */
  dragging?: boolean;
  /** Select — routed through the strip so a drag doesn't read as a click. */
  onActivate: () => void;
  /** Open the URL bar — same drag guard as onActivate. */
  onEditAddress: () => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const closeTab = useSumaStore((s) => s.closeTab);
  const togglePin = useSumaStore((s) => s.togglePin);
  const host = tabHost(tab);

  // Beside the active tab the raised fill is drawn by HoverShell (its near
  // edge follows the folder silhouette); elsewhere it is a plain rounded rect.
  // A tab in a split never renders here — SplitTab draws both of its panes.
  const inactiveShape =
    activeSide !== null
      ? "text-muted hover:text-text"
      : "rounded-[9px] text-muted hover:bg-gradient-to-b hover:from-ink/[0.05] hover:to-ink/[0.10] hover:text-text";

  const shape = tab.active
    ? "z-10 h-[40px] pb-[5px] text-text"
    : `mb-2 h-8 ${inactiveShape}`;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter") onActivate();
      }}
      onPointerDown={onPointerDown}
      onAuxClick={(e) => {
        if (e.button === 1) void closeTab(tab.id);
      }}
      onDoubleClick={() => void togglePin(tab.id)}
      title={`${tab.title || tab.url}\n${prettyUrl(tab.url)}`}
      data-flip-id={tab.id}
      className={cn(
        "no-drag group relative flex items-center",
        // touch-none so a trackpad drag reorders instead of being swallowed
        // as a scroll gesture.
        dragging
          ? "z-30 cursor-grabbing touch-none"
          : "cursor-pointer touch-none",
        iconOnly
          ? "w-10 shrink-0 justify-center"
          : tab.active
            ? "min-w-[176px] max-w-[240px] flex-1 px-2.5"
            : "min-w-[56px] max-w-[240px] flex-1 px-3",
        shape,
      )}
    >
      {tab.active ? <FolderShell /> : null}
      {!tab.active && activeSide !== null ? (
        <HoverShell side={activeSide} />
      ) : null}
      <span
        className={cn(
          "relative flex min-w-0 items-center gap-2",
          !iconOnly && "flex-1 self-stretch",
        )}
      >
        {tab.active ? <TabNavCluster tab={tab} /> : null}
        <TabMark tab={tab} />
        {iconOnly ? null : (
          <>
            {tab.active ? (
              <ActiveTabLabel tab={tab} onEdit={onEditAddress} />
            ) : (
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                <TabTitle tab={tab} />
              </span>
            )}
            <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
              <FavoriteToggleButton tab={tab} />
              <SplitToggleButton tab={tab} />
              <TabCloseButton tab={tab} />
            </span>
            <span className="shrink-0 group-has-[:focus-visible]:hidden group-hover:hidden">
              <ContinuityDot host={host} />
            </span>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * One pane inside the fused split tab. Its own hover group, so revealing one
 * half's omnibox or close button never lights up the other half.
 */
function SplitPane({
  tab,
  focused,
  hoverActions,
  onActivate,
  onEditAddress,
}: {
  tab: TabInfo;
  /**
   * This half is the active tab. Styling only — both panes are live pages and
   * carry the same controls; this is just which one the window-level keys
   * (⌘L, ⌘R, ⌘[) will find.
   */
  focused: boolean;
  /** Extra controls revealed beside this half's close button. */
  hoverActions?: React.ReactNode;
  onActivate: () => void;
  onEditAddress: () => void;
}) {
  const closeTab = useSumaStore((s) => s.closeTab);
  const host = tabHost(tab);

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter") onActivate();
      }}
      onAuxClick={(e) => {
        if (e.button === 1) void closeTab(tab.id);
      }}
      title={`${tab.title || tab.url}\n${prettyUrl(tab.url)}`}
      className={cn(
        "group relative flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-[7px] px-1.5",
        focused ? "text-text" : "text-muted hover:text-text",
      )}
    >
      <TabNavCluster tab={tab} />
      <TabMark tab={tab} />
      <ActiveTabLabel tab={tab} onEdit={onEditAddress} />
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <FavoriteToggleButton tab={tab} />
        {hoverActions}
        <TabCloseButton tab={tab} />
      </span>
      <span className="shrink-0 group-has-[:focus-visible]:hidden group-hover:hidden">
        <ContinuityDot host={host} />
      </span>
    </span>
  );
}

/**
 * A split view as ONE extended tab (§6).
 *
 * A split is a single layout made of two pages, so the strip shows it as a
 * single double-width folder tab divided down the middle — not as two tabs
 * with a chip on one of them. The halves are in PANE order, so the tab reads
 * the way the window looks: the left half is the left pane, and the seam
 * between them sits where the divider between the panes sits.
 *
 * Both halves are live pages, so both are whole tabs: each has its own nav
 * cluster driving its own history, and its own address opening the URL bar on
 * itself. The only asymmetry is which one is the ACTIVE tab — that half is
 * drawn in the full foreground, the other in the muted one, because the
 * window-level keys (⌘L, ⌘R, ⌘[) go to the active tab. Selecting the right
 * half swaps the panes (main's TabManager.select), and the halves swap with
 * them.
 */
function SplitTab({
  flipId,
  left,
  right,
  dragging = false,
  onActivate,
  onEditAddress,
  onPointerDown,
}: {
  /** The pair's row identity — see rowItems(). */
  flipId: string;
  /** Left pane: the active tab. */
  left: TabInfo;
  /** Right pane: the split assignment. */
  right: TabInfo;
  dragging?: boolean;
  /** Select a half — routed through the strip so a drag doesn't read as a click. */
  onActivate: (tabId: string) => void;
  /** Open the URL bar on a half — same drag guard as onActivate. */
  onEditAddress: (tabId: string) => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`Split view: ${left.title || "tab"} and ${right.title || "tab"}`}
      onPointerDown={onPointerDown}
      data-flip-id={flipId}
      // Two panes' worth of row: flex-[2] against the single tabs' flex-1, so
      // a split takes twice the share of whatever space the row has.
      className={cn(
        "no-drag relative flex h-[40px] min-w-[264px] max-w-[520px] flex-[2] items-center px-1 pb-[5px] text-text",
        dragging
          ? "z-30 cursor-grabbing touch-none"
          : "z-10 cursor-pointer touch-none",
      )}
    >
      <FolderShell />
      <SplitPane
        tab={left}
        focused={left.active}
        onActivate={() => onActivate(left.id)}
        onEditAddress={() => onEditAddress(left.id)}
      />
      {/* The seam, echoing the divider between the panes below. */}
      <span
        aria-hidden="true"
        className="relative mx-0.5 h-5 w-px shrink-0 self-center bg-ink/15"
      />
      <SplitPane
        tab={right}
        focused={right.active}
        hoverActions={<SplitToggleButton tab={right} />}
        onActivate={() => onActivate(right.id)}
        onEditAddress={() => onEditAddress(right.id)}
      />
    </div>
  );
}

/**
 * The row's tail: ⌘T's + button, and — revealed when the pointer reaches it —
 * a second button that opens a new SHELL instead of a new page. Two ways to
 * start something, in the one place the strip already means "start something".
 *
 * The terminal slot is ALWAYS in layout, invisible and inert at rest, rather
 * than expanding the cluster on hover. The strip FLIP-animates tabs from their
 * offsetLeft (useTabFlip), so a cluster that changed width would leave every
 * tab's recorded position stale — and the next unrelated re-render (a title, a
 * favicon) would slide the whole row sideways to "correct" it. Reserving the
 * width costs one button of tab space and keeps the row still.
 *
 * `data-flip-id` moves to the wrapper with it: the drag clamps a tab's travel
 * at this element's offsetLeft, which is still exactly where the tabs stop.
 */
function NewTabCluster() {
  const createTab = useSumaStore((s) => s.createTab);
  const newTerminal = useSumaStore((s) => s.newTerminal);

  return (
    <div
      data-flip-id="__new-tab"
      className="no-drag group/new mb-2 ml-1 flex shrink-0 items-center"
    >
      <button
        type="button"
        title="New tab (⌘T)"
        aria-label="New tab"
        onClick={() => void createTab()}
        className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-[9px] text-faint hover:bg-gradient-to-b hover:from-ink/[0.05] hover:to-ink/[0.10] hover:text-text"
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
      {/* Slides out from behind the + rather than fading in place, so the two
          read as one control unfolding instead of a button blinking into
          existence beside another.

          The transition lists `translate` and `scale`, NOT `transform`: those
          utilities compile to the separate CSS properties of the same name,
          which `transition-[…,transform]` does not cover. Naming `transform`
          left the slide untransitioned in both directions — invisible on the
          way in (it snapped into place while still at opacity 0) but a visible
          jump on the way out, where it snapped back BEFORE fading. */}
      <button
        type="button"
        title="New terminal — a shell on your Suma machine"
        aria-label="New terminal"
        onClick={() => void newTerminal()}
        className="pointer-events-none grid size-8 shrink-0 -translate-x-2 scale-90 cursor-pointer place-items-center rounded-[9px] text-faint opacity-0 transition-[opacity,translate,scale] duration-200 ease-out group-hover/new:pointer-events-auto group-hover/new:translate-x-0 group-hover/new:scale-100 group-hover/new:opacity-100 hover:bg-gradient-to-b hover:from-ink/[0.05] hover:to-ink/[0.10] hover:text-text focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:scale-100 focus-visible:opacity-100"
      >
        <SquareTerminal className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled === true}
      onClick={onClick}
      className="no-drag grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-ink/8 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
    >
      {children}
    </button>
  );
}

/**
 * A visible tab's address layer. The tab shows its title at rest; on hover the
 * title cross-fades to the current URL rendered as a pressable field. Clicking
 * it opens the URL bar modal ON THIS TAB — the tab itself is never an editable
 * input, so a stray click on the strip can never leave a half-typed address
 * sitting over the page. (⌘L opens the same modal on the active tab.)
 */
function ActiveTabUrl({ tab, onEdit }: { tab: TabInfo; onEdit: () => void }) {
  const shown = prettyUrl(tab.url);

  return (
    <button
      type="button"
      title="Edit address (⌘L)"
      aria-label="Edit address"
      // A drag handle, not just a control: this field covers the active tab's
      // whole title area on hover, so the strip lets a press here start a tab
      // drag (and then swallows the click that ends it).
      data-drag-handle="true"
      onClick={(e) => {
        // The whole tab is a click target that selects the tab; this one
        // opens the URL bar instead.
        e.stopPropagation();
        onEdit();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="pointer-events-none absolute inset-x-0 inset-y-[4px] flex w-full min-w-0 cursor-text items-center rounded-[7px] px-1.5 text-left font-mono text-[11.5px] text-muted opacity-0 transition-opacity duration-150 hover:bg-ink/8 hover:text-text focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none group-hover:pointer-events-auto group-hover:opacity-100"
    >
      <span className="min-w-0 truncate">
        {shown.length > 0 ? (
          shown
        ) : (
          <span className="text-faint">Search or enter URL</span>
        )}
      </span>
    </button>
  );
}

function SpaceChip({ space }: { space: SpaceInfo }) {
  const setActiveSpace = useSumaStore((s) => s.setActiveSpace);
  const removeSpace = useSumaStore((s) => s.removeSpace);
  const spaceCount = useSumaStore((s) => s.spaces.length);
  const pushToast = useSumaStore((s) => s.pushToast);

  // Right-click removes an EMPTY space (the duplicate-"Personal" cleanup, §8.8).
  // Guarded to no-tab, non-active, not-the-last so a real space is never lost;
  // deletion tombstones and propagates to every device.
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (space.tabCount > 0) {
      pushToast("Close its tabs before removing a space", "warning");
      return;
    }
    if (space.active || spaceCount <= 1) {
      pushToast("Switch to another space first", "warning");
      return;
    }
    if (
      !window.confirm(
        `Remove empty space “${space.name}”? This applies on all your devices.`,
      )
    ) {
      return;
    }
    void removeSpace(space.id);
  };

  return (
    <button
      type="button"
      title={`${space.name} · ${space.tabCount} tab(s)${space.tabCount === 0 ? " · right-click to remove" : ""}`}
      aria-label={`Switch to ${space.name}`}
      onClick={() => void setActiveSpace(space.id)}
      onContextMenu={onContextMenu}
      className={cn(
        "grid size-[20px] shrink-0 cursor-pointer place-items-center rounded-full text-[9.5px] font-bold text-white/90 transition-transform",
        space.active
          ? "scale-110 ring-2 ring-ink/35 ring-offset-2 ring-offset-chrome"
          : "opacity-60 hover:scale-105 hover:opacity-90",
      )}
      style={{ background: space.color }}
    >
      {space.name.charAt(0).toUpperCase()}
    </button>
  );
}

/**
 * The two split targets, drawn over the content hole while a tab is dragged
 * out of the strip. They are only visible because a tab drag raises the chrome
 * view above the tab WebContentsViews (store.tabDragging) — the same mechanism
 * modals and the divider drag use — and they mirror the hole's own geometry,
 * so the highlighted half is exactly the region the dropped tab will fill.
 */
function SplitDropZones({
  bounds,
  zone,
  shown,
}: {
  bounds: ContentBounds;
  zone: SplitZone | null;
  shown: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      // z-20: above the split divider, below the dragged tab (z-30) that is
      // being carried over these zones.
      className={cn(
        "pointer-events-none fixed z-20 flex gap-2 p-2 transition-opacity duration-150",
        shown ? "opacity-100" : "opacity-0",
      )}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
    >
      {(["left", "right"] as const).map((side) => (
        <div
          key={side}
          // Label near the top, not centered: the dragged tab rides under the
          // pointer, which is usually mid-pane, and would cover it there.
          className={cn(
            "flex flex-1 items-start justify-center rounded-2xl border-2 border-dashed pt-14 transition-colors duration-150",
            zone === side
              ? "border-accent/70 bg-accent/12"
              : "border-ink/15 bg-ink/[0.03]",
          )}
        >
          <span
            className={cn(
              "rounded-full bg-chrome/90 px-2.5 py-1 text-[11px] font-medium tracking-wide shadow-sm transition-opacity duration-150",
              zone === side ? "text-accent opacity-100" : "opacity-0",
            )}
          >
            Split {side}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * One slot in the row. A split view is ONE slot holding both of its tabs: the
 * strip mirrors the window, and the window shows a single layout made of two
 * pages. Everything the row does — reorder, drop targets, drag limits, FLIP —
 * is expressed over these units rather than over tabs, so a split moves,
 * animates and drops as one tab.
 */
interface RowItem {
  /** Stable while the item exists: the FLIP key and the drag's identity. */
  id: string;
  /** A split's two panes in PANE order (left, right), or one lone tab. */
  tabs: TabInfo[];
  pinned: boolean;
  /** Holds the active tab — the folder-shaped slot. */
  active: boolean;
}

/**
 * Fuse the active tab and its split partner into a single slot, placed where
 * the first of the two sat; every other tab is a slot of its own.
 */
function rowItems(order: TabInfo[]): RowItem[] {
  const lone = (t: TabInfo): RowItem => ({
    id: t.id,
    tabs: [t],
    pinned: t.pinned,
    active: t.active,
  });
  const active = order.find((t) => t.active) ?? null;
  const split = order.find((t) => t.split) ?? null;
  if (active === null || split === null || active.id === split.id)
    return order.map(lone);
  // Id independent of WHICH pane holds which tab: selecting the right half
  // swaps the panes, and a key that changed with them would read as the pair
  // being replaced — FLIP would fade a new element in instead of leaving the
  // slot alone.
  const id = `split:${[active.id, split.id].sort().join(":")}`;
  const items: RowItem[] = [];
  let placed = false;
  for (const t of order) {
    if (t.id !== active.id && t.id !== split.id) {
      items.push(lone(t));
      continue;
    }
    if (placed) continue;
    // pinned: false — a split is a full-size slot even if a member was
    // pinned; the pin group is the row of icon-sized tabs at the head.
    items.push({ id, tabs: [active, split], pinned: false, active: true });
    placed = true;
  }
  return items;
}

const SETTLE_EASING = "cubic-bezier(0.22, 0.9, 0.26, 1)";

/** Pointer travel that turns a press into a drag rather than a click. */
const DRAG_START_PX = 5;

/**
 * How far into the content area the pointer must travel before a drop means
 * "split" rather than "reorder". Measured from the top of the content hole,
 * so the whole strip — plus a margin under it — stays pure reorder territory
 * and a sloppy horizontal drag can never trip the split.
 */
const SPLIT_ARM_PX = 24;

/** Where a drop below the strip sends the tab: one pane of a 2-pane split. */
type SplitZone = "left" | "right";

interface TabDrag {
  id: string;
  /** Where the pointer grabbed the tab, in px from the tab's left edge. */
  grabOffset: number;
  /**
   * Layout centers of every tab in visual order, frozen when the drag began.
   * Frozen, not live: the slots the pointer is compared against must not move
   * as the row reflows around the drag, or each swap would shift the very
   * boundary that caused it and the row would oscillate.
   */
  slots: Array<{ id: string; center: number }>;
  fromIndex: number;
  /** Insertion index among the OTHER tabs — where the row previews the drop. */
  toIndex: number;
  /**
   * The dragged tab's left edge in layout space, already clamped. The pointer
   * position is never used directly downstream: clamping once, here, is what
   * keeps the tab, its drop index and its settle animation from disagreeing
   * about where it is when the pointer runs past the limit.
   */
  left: number;
  /** How far the tab has been lifted below the strip (0 while inside it). */
  lift: number;
  /** Pointer is over the content area — the split zones are showing. */
  overContent: boolean;
  /** Armed split target; the drop splits instead of reordering. */
  zone: SplitZone | null;
  /** Insertion range: a tab stays inside its own pin group. */
  min: number;
  max: number;
  /**
   * Travel limits for `left`, and the drop below which the tab cannot go.
   * Inside the strip the tab is held to the tabs' own span, so it can never be
   * dragged past either end of the row; carried out over the page it is free
   * to track the pointer but still cannot leave the window.
   */
  rowMinLeft: number;
  rowMaxLeft: number;
  winMinLeft: number;
  winMaxLeft: number;
  maxLift: number;
}

/** Layout box of a tab, in the coordinate space every tab's offsetLeft uses. */
function slotOf(el: HTMLElement): { id: string; center: number } {
  return {
    id: el.dataset["flipId"] ?? "",
    center: el.offsetLeft + el.offsetWidth / 2,
  };
}

/**
 * FLIP-animate the tab row: whenever tabs reorder (a drag passing its
 * neighbors, a tab closing) or appear, glide each element from its previous
 * layout position to its new one.
 *
 * Positions are read from offsetLeft — the pure layout position — NEVER from
 * getBoundingClientRect, which includes any in-flight transform: measuring
 * mid-animation would poison the stored positions and compound the deltas on
 * every store refresh (tabs launching in from thousands of px away). For the
 * same reason only transform is animated — layout properties like width
 * would shift the measured positions of every sibling while tweening. A
 * follow-up render with unchanged layout therefore computes dx = 0 and
 * leaves the running animation untouched.
 *
 * `skipId` is the tab under the pointer during a drag. Its new layout position
 * is still recorded (so the drop computes dx = 0 and stays put), but it is
 * never animated: it is being positioned by the pointer, and a FLIP tween
 * would fight the inline transform that follows the cursor. While a drag is
 * live the displaced tabs also glide faster — at drag speed the standard
 * settle reads as lag.
 */
function useTabFlip(
  containerRef: React.RefObject<HTMLDivElement | null>,
  skipId: string | null = null,
): void {
  const lefts = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (root === null) return;
    const prev = lefts.current;
    const next = new Map<string, number>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const id = el.dataset["flipId"];
      if (id === undefined) continue;
      const left = el.offsetLeft;
      next.set(id, left);
      if (id === skipId) continue;
      const p = prev.get(id);
      if (p === undefined) {
        // A brand-new tab: fade/scale in (skip the initial mount of the strip).
        if (prev.size > 0) {
          el.animate(
            [
              { opacity: 0, transform: "scale(0.96)" },
              { opacity: 1, transform: "scale(1)" },
            ],
            { duration: 160, easing: "ease-out" },
          );
        }
        continue;
      }
      const dx = p - left;
      if (Math.abs(dx) < 0.5) continue;
      el.animate(
        [
          { transform: `translateX(${n(dx)}px)` },
          { transform: "translateX(0px)" },
        ],
        { duration: skipId === null ? 280 : 190, easing: SETTLE_EASING },
      );
    }
    lefts.current = next;
  });
}

/**
 * The full titlebar row: draggable strip with nav controls, tabs (the active
 * one leading as the omnibox), the new-tab button, and the
 * status/space/utility cluster on the right. The strip darkens toward the
 * window edge and its bottom hairline is the panel's top-edge highlight —
 * the active tab's silhouette highlight joins it at the flare tips.
 */
export function TabStrip() {
  const tabs = useSumaStore((s) => s.tabs);
  const spaces = useSumaStore((s) => s.spaces);
  const selectTab = useSumaStore((s) => s.selectTab);
  const openUrlBar = useSumaStore((s) => s.openUrlBar);
  const createSpace = useSumaStore((s) => s.createSpace);
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const openSettings = useSumaStore((s) => s.openSettings);
  const workspaceSyncReady = useSumaStore((s) => s.workspaceSync.remoteReady);
  const workspaceSyncPending = useSumaStore((s) => s.workspaceSync.pending);
  const chatOpen = useSumaStore((s) => s.chatOpen);
  const toggleChat = useSumaStore((s) => s.toggleChat);
  const savesOpen = useSumaStore((s) => s.savesOpen);
  const toggleSaves = useSumaStore((s) => s.toggleSaves);
  const hasActiveDownload = useSumaStore((s) =>
    s.downloads.some((d) => d.state === "progressing"),
  );

  const reorderTab = useSumaStore((s) => s.reorderTab);
  const splitTabToSide = useSumaStore((s) => s.splitTabToSide);
  const setTabDragging = useSumaStore((s) => s.setTabDragging);
  const contentBounds = useSumaStore((s) => s.contentBounds);

  const tabsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<TabDrag | null>(null);
  useTabFlip(tabsRef, drag?.id ?? null);

  // Tabs keep their position; selecting one never moves it. Pinned tabs still
  // lead the row as compact icons — pinning is a grouping, and a tab only ever
  // reorders within its own group. A split's two tabs fuse into one slot, so
  // the row below is units, not tabs.
  const order = rowItems([
    ...tabs.filter((t) => t.pinned),
    ...tabs.filter((t) => !t.pinned),
  ]);
  const others = order.filter((i) => i.id !== drag?.id);
  // While dragging, the row renders the drop it would commit right now.
  const view =
    drag === null
      ? order
      : (() => {
          const dragged = order.find((i) => i.id === drag.id);
          if (dragged === undefined) return order;
          const next = [...others];
          next.splice(drag.toIndex, 0, dragged);
          return next;
        })();

  const elFor = (id: string): HTMLElement | null =>
    tabsRef.current?.querySelector<HTMLElement>(
      `[data-flip-id="${CSS.escape(id)}"]`,
    ) ?? null;

  /** Viewport x of the origin every tab's offsetLeft is measured from. */
  const layoutOriginX = (): number => {
    const parent = tabsRef.current?.offsetParent;
    return parent instanceof HTMLElement
      ? parent.getBoundingClientRect().left
      : 0;
  };

  /** Where the dragged tab wants to sit, as an insertion index among `others`. */
  const dropIndexFor = (state: TabDrag, left: number): number => {
    const el = elFor(state.id);
    if (el === null) return state.toIndex;
    // Dragged as far as the row allows ⇒ the end of the row, whatever the
    // centers say. The slot centers are frozen at their PRE-drag positions,
    // so an item wider than the slot it vacated — a split, which is two
    // tabs wide — can have its center clamped short of the last frozen
    // center and could otherwise never reach the last position at all.
    if (left >= state.rowMaxLeft - 0.5) return state.max;
    if (left <= state.rowMinLeft + 0.5) return state.min;
    const center = left + el.offsetWidth / 2;
    const passed = state.slots.filter(
      (s) => s.id !== state.id && s.center < center,
    ).length;
    return Math.min(Math.max(passed, state.min), state.max);
  };

  // Set true once a press turns into a real drag, so the click that follows
  // pointerup drops instead of selecting the tab under it.
  const draggedRef = useRef(false);

  const beginPress = (
    item: RowItem,
    e: React.PointerEvent<HTMLDivElement>,
  ): void => {
    // Left button only, and never from a control inside the tab (close, split,
    // reload) — those own their own gestures. The address field is the
    // exception: on the active tab it covers the whole title area on hover, so
    // refusing it would make the active tab the one tab you cannot drag.
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const control = e.target.closest("button");
    if (
      control instanceof HTMLElement &&
      control.dataset["dragHandle"] === undefined
    )
      return;
    const container = tabsRef.current;
    const el = elFor(item.id);
    if (container === null || el === null) return;
    draggedRef.current = false;

    const startX = e.clientX;
    const startY = e.clientY;
    const grabOffset = startX - layoutOriginX() - el.offsetLeft;
    // Frozen with the slots: the split zones must stay put while the row
    // reflows underneath them, and the hole cannot move mid-drag anyway.
    const area = contentBounds;
    // Which tabs each slot stands for, frozen with the slots — the drop
    // resolves store positions, and the store holds tabs, not slots.
    const tabsBySlot = new Map(
      order.map((i) => [i.id, i.tabs.map((t) => t.id)]),
    );
    // A split is already both panes: there is nowhere for it to be dropped.
    const canSplit = item.tabs.length === 1;
    let state: TabDrag | null = null;

    /**
     * Which pane a drop right now would target. The zone is the content hole,
     * not the window: the chat sidebar and the banners above the hole are not
     * split targets, and halving the hole is what makes the highlighted region
     * the region the tab actually lands in.
     */
    const zoneFor = (ev: PointerEvent): SplitZone | null => {
      if (!canSplit || area === null) return null;
      if (ev.clientY < area.y + SPLIT_ARM_PX) return null;
      if (ev.clientX < area.x || ev.clientX > area.x + area.width) return null;
      return ev.clientX < area.x + area.width / 2 ? "left" : "right";
    };

    const onMove = (ev: PointerEvent): void => {
      if (state === null) {
        if (
          Math.abs(ev.clientX - startX) < DRAG_START_PX &&
          Math.abs(ev.clientY - startY) < DRAG_START_PX
        )
          return;
        const slots = [
          ...container.querySelectorAll<HTMLElement>("[data-flip-id]"),
        ]
          .filter((node) => node.dataset["flipId"] !== "__new-tab")
          .map(slotOf);
        const fromIndex = slots.findIndex((s) => s.id === item.id);
        if (fromIndex < 0) return;
        const pinnedOthers = order.filter(
          (i) => i.id !== item.id && i.pinned,
        ).length;
        // Travel limits, frozen like the slots. The row's right end is the
        // new-tab button rather than the container edge, so a dragged tab
        // stops where the tabs stop instead of sliding over the button.
        const newTabEl = container.querySelector<HTMLElement>(
          '[data-flip-id="__new-tab"]',
        );
        const rowMinLeft = container.offsetLeft;
        const rowMaxLeft = Math.max(
          rowMinLeft,
          (newTabEl?.offsetLeft ?? rowMinLeft + container.offsetWidth) -
            el.offsetWidth,
        );
        const originX = layoutOriginX();
        const winMinLeft = -originX;
        const winMaxLeft = Math.max(
          winMinLeft,
          winMinLeft + window.innerWidth - el.offsetWidth,
        );
        state = {
          id: item.id,
          grabOffset,
          slots,
          fromIndex,
          toIndex: fromIndex,
          left: rowMinLeft,
          lift: 0,
          overContent: false,
          zone: null,
          min: item.pinned ? 0 : pinnedOthers,
          max: item.pinned ? pinnedOthers : slots.length - 1,
          rowMinLeft,
          rowMaxLeft,
          winMinLeft,
          winMaxLeft,
          maxLift: Math.max(
            0,
            window.innerHeight - el.getBoundingClientRect().bottom,
          ),
        };
        draggedRef.current = true;
        setTabDragging(true);
      }
      // Out over the page the tab is carried by the pointer and only the
      // window holds it back; inside the strip it is held to the row. A split
      // has nowhere to be dropped, so it never leaves the row at all.
      const overContent = canSplit && area !== null && ev.clientY >= area.y;
      const left = Math.min(
        Math.max(
          ev.clientX - layoutOriginX() - grabOffset,
          overContent ? state.winMinLeft : state.rowMinLeft,
        ),
        overContent ? state.winMaxLeft : state.rowMaxLeft,
      );
      const zone = zoneFor(ev);
      state = {
        ...state,
        left,
        lift: canSplit
          ? Math.min(Math.max(ev.clientY - startY, 0), state.maxLift)
          : 0,
        overContent,
        zone,
        // Carried out over the page, the gesture is no longer a reorder: hold
        // the row at the tab's own slot so it stops previewing a move it will
        // not commit, whether the drop lands on a pane or nowhere at all.
        toIndex: overContent ? state.fromIndex : dropIndexFor(state, left),
      };
      setDrag(state);
    };

    const finish = (commit: boolean): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      const done = state;
      setTabDragging(false);
      if (done === null) return;
      // Settle the tab from wherever the pointer left it into its slot. Read
      // the offset BEFORE clearing the inline transform: after the drop the
      // preview order is the real order, so its slot no longer moves.
      const dragged = elFor(done.id);
      if (dragged !== null) {
        const dx = done.left - dragged.offsetLeft;
        dragged.style.transform = "";
        dragged.animate(
          [
            { transform: `translate(${n(dx)}px, ${n(done.lift)}px)` },
            { transform: "translate(0px, 0px)" },
          ],
          { duration: 170, easing: SETTLE_EASING },
        );
      }
      // Dropped over a pane: that is the whole gesture — split, don't reorder.
      if (commit && done.zone !== null) {
        const zone = done.zone;
        const id = done.id;
        setDrag(null);
        void splitTabToSide(id, zone);
        return;
      }
      const moved = commit && done.toIndex !== done.fromIndex;
      // Read the neighbours from the frozen slots, never from the render
      // closure this handler was created in: that closure predates the drag,
      // so its `others` still contains the dragged tab and every rightward
      // drop would resolve to "after itself" — a no-op.
      const others = done.slots.filter((s) => s.id !== done.id);
      // The drop only ever means something RELATIVE TO THE TAB'S OWN GROUP:
      // the row renders pinned tabs first regardless of where they sit in the
      // space order, so translating a visual slot with a plain "insert after
      // the tab on my left" puts the tab after a member of the other group and
      // the row snaps back. `done.min` is where this tab's group starts, so at
      // the head of the group the anchor is the group's first member and the
      // tab goes BEFORE it instead.
      // Slots are units; the store holds tabs. Anchoring "after" on the
      // neighbour's LAST tab and "before" on its FIRST is what lets a split —
      // two tabs in one slot — be landed beside as a single block.
      const anchorAfter =
        done.toIndex > done.min ? others[done.toIndex - 1]?.id : undefined;
      const anchorBefore =
        done.toIndex === done.min ? others[done.min]?.id : undefined;
      const after =
        anchorAfter === undefined
          ? undefined
          : tabsBySlot.get(anchorAfter)?.at(-1);
      const before =
        anchorBefore === undefined
          ? undefined
          : tabsBySlot.get(anchorBefore)?.[0];
      const draggedIds = tabsBySlot.get(done.id) ?? [done.id];
      setDrag(null);
      if (!moved) return;
      const [head, ...rest] = draggedIds;
      if (head === undefined) return;
      // Positions are resolved against the list reorderTab itself splices
      // into — every tab but the ONE being moved. Excluding the whole unit
      // here instead would misplace a split by however many of its own tabs
      // still sit left of the anchor.
      const live = useSumaStore.getState().tabs.filter((t) => t.id !== head);
      const index =
        after !== undefined
          ? live.findIndex((t) => t.id === after) + 1
          : before !== undefined
            ? live.findIndex((t) => t.id === before)
            : -1;
      // -1 ⇒ the tab is the only member of its group, so every store position
      // renders identically. Leave the order alone.
      if (index < 0) return;
      void (async () => {
        await reorderTab(head, index);
        // A split lands as a contiguous run: each following tab goes directly
        // after the one before it, re-read from the live order every time
        // (reorderTab's index is taken AFTER the moved tab is lifted out).
        let prev = head;
        for (const id of rest) {
          const without = useSumaStore
            .getState()
            .tabs.filter((t) => t.id !== id);
          const at = without.findIndex((t) => t.id === prev);
          if (at < 0) break;
          await reorderTab(id, at + 1);
          prev = id;
        }
      })();
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  // The dragged tab is positioned by the pointer, not by layout: re-apply the
  // offset after every render (the row reflows underneath it as tabs snap).
  // Once a drop would split, it also shrinks and fades — the tab reads as
  // picked up and carried, and it shrinks toward the pointer's grab point so
  // the cursor keeps holding the same part of the tab. Both cues switch on the
  // same threshold as the highlighted zone, so the armed state reads as one
  // change rather than three.
  useLayoutEffect(() => {
    if (drag === null) return;
    const el = elFor(drag.id);
    if (el === null) return;
    const armed = drag.zone !== null;
    el.style.transformOrigin = `${n(drag.grabOffset)}px 50%`;
    el.style.transform = `translate(${n(drag.left - el.offsetLeft)}px, ${n(drag.lift)}px) scale(${armed ? 0.9 : 1})`;
    el.style.opacity = armed ? "0.9" : "";
    return () => {
      el.style.transformOrigin = "";
      el.style.opacity = "";
    };
  });

  // Both tab-level clicks are guarded the same way: the click that ends a drag
  // must neither select the tab nor open the URL bar.
  const activate = (tabId: string): void => {
    if (draggedRef.current) return;
    void selectTab(tabId);
  };
  // Addressed to a tab, not to "the active one": in a split either pane's
  // address may be the one clicked, and the bar has to edit that page.
  const editAddress = (tabId: string): void => {
    if (draggedRef.current) return;
    openUrlBar(tabId);
  };

  const activeIndex = view.findIndex((i) => i.active);
  const sideOf = (i: number): "left" | "right" | null => {
    if (activeIndex < 0 || i === activeIndex) return null;
    if (i === activeIndex + 1) return "left";
    if (i === activeIndex - 1) return "right";
    return null;
  };

  return (
    <div className="drag-region relative flex h-12 shrink-0 items-end bg-[linear-gradient(180deg,var(--color-strip-deep)_0%,var(--color-strip)_100%)]">
      {drag !== null && contentBounds !== null ? (
        <SplitDropZones
          bounds={contentBounds}
          zone={drag.zone}
          shown={drag.overContent}
        />
      ) : null}
      {/* Window top-edge catch light */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-ink/6"
      />
      {/* Panel top edge — the active tab covers its own span of this line */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-chrome-edge"
      />
      {/* pl clears the macOS traffic lights */}
      <div className="flex min-w-0 flex-1 items-end gap-1.5 pr-2.5 pl-[84px]">
        <div ref={tabsRef} className="flex min-w-0 flex-1 items-end">
          {view.map((item, i) => {
            const [first, second] = item.tabs;
            if (first === undefined) return null;
            return second === undefined ? (
              <Tab
                key={item.id}
                tab={first}
                iconOnly={item.pinned}
                activeSide={sideOf(i)}
                dragging={drag?.id === item.id}
                onActivate={() => activate(first.id)}
                onEditAddress={() => editAddress(first.id)}
                onPointerDown={(e) => beginPress(item, e)}
              />
            ) : (
              <SplitTab
                key={item.id}
                flipId={item.id}
                left={first}
                right={second}
                dragging={drag?.id === item.id}
                onActivate={activate}
                onEditAddress={editAddress}
                onPointerDown={(e) => beginPress(item, e)}
              />
            );
          })}
          <NewTabCluster />
        </div>

        <div className="no-drag mb-2 flex h-8 shrink-0 items-center gap-1.5">
          <StatusPills />
          {/* The chat toggle sits at the right end of the strip, above the
              sidebar it opens. It stays lit while the sidebar is open — the
              one button here with a persistent on-state. */}
          <button
            type="button"
            title="AI chat (⌘I)"
            aria-label="AI chat"
            aria-pressed={chatOpen}
            onClick={toggleChat}
            className={cn(
              "no-drag grid size-6 shrink-0 cursor-pointer place-items-center rounded-md transition-colors",
              chatOpen
                ? "bg-accent/15 text-accent hover:bg-accent/25"
                : "text-muted hover:bg-ink/8 hover:text-text",
            )}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
          </button>
          {/* The saves toggle: same persistent on-state as the chat button,
              for the panel beside the sidebar it opens. */}
          <button
            type="button"
            title="Saves (⌘B) — double-tap Shift to save a page"
            aria-label="Saves"
            aria-pressed={savesOpen}
            onClick={toggleSaves}
            className={cn(
              "no-drag grid size-6 shrink-0 cursor-pointer place-items-center rounded-md transition-colors",
              savesOpen
                ? "bg-accent/15 text-accent hover:bg-accent/25"
                : "text-muted hover:bg-ink/8 hover:text-text",
            )}
          >
            <Bookmark className="size-3.5" aria-hidden="true" />
          </button>
          <NavButton label="Downloads" onClick={() => setOverlay("downloads")}>
            <span className="relative">
              <Download className="size-3.5" aria-hidden="true" />
              {hasActiveDownload ? (
                <span className="animate-pulse-dot absolute -top-[3px] -right-[4px] size-[5px] rounded-full bg-accent shadow-[0_0_4px_var(--color-accent)]" />
              ) : null}
            </span>
          </NavButton>
          <NavButton label="Settings (⌘,)" onClick={() => void openSettings()}>
            <Settings className="size-3.5" aria-hidden="true" />
          </NavButton>
          <button
            type="button"
            title={
              !workspaceSyncReady
                ? "Waiting for the shared workspace"
                : workspaceSyncPending
                  ? "Sync changes with your other devices"
                  : "Workspace is up to date"
            }
            aria-label={
              workspaceSyncPending
                ? "Sync workspace changes"
                : "Workspace is up to date"
            }
            disabled={!workspaceSyncReady || !workspaceSyncPending}
            data-testid="workspace-sync-button"
            onClick={() => setOverlay("workspace-sync")}
            className={cn(
              "no-drag relative grid size-6 shrink-0 cursor-pointer place-items-center rounded-md transition-colors",
              workspaceSyncPending
                ? "bg-accent/12 text-accent hover:bg-accent/20"
                : "cursor-default text-faint opacity-55",
            )}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {workspaceSyncPending ? (
              <span
                aria-hidden="true"
                className="absolute right-0.5 bottom-0.5 size-1 rounded-full bg-accent shadow-[0_0_4px_var(--color-accent)]"
              />
            ) : null}
          </button>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-ink/8" />
          {spaces.map((sp) => (
            <SpaceChip key={sp.id} space={sp} />
          ))}
          <button
            type="button"
            title="New space"
            aria-label="New space"
            onClick={() => void createSpace()}
            className="grid size-[20px] shrink-0 cursor-pointer place-items-center rounded-full border border-dashed border-ink/25 text-faint hover:border-ink/45 hover:text-muted"
          >
            <Plus className="size-2.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
