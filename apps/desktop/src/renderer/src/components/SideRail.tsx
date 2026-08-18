/**
 * The right tool rail: a RAIL_W icon column on the window's right edge that
 * expands to EXPANDED_W on hover, OVER the page instead of pushing it.
 *
 * Two rules make it behave:
 *
 * 1. The layout column (<aside>) is ALWAYS RAIL_W. The content hole never
 *    changes when the rail expands — the extra SLIDE px paints over the page
 *    — so ContentPanes never re-reports bounds and the tab views never move.
 *    That overhang crosses the content hole, where the chrome renders BELOW
 *    the tab WebContentsViews (§8.1), so expansion raises the chrome via the
 *    store's railExpanded flag (the same overlay mechanism modals use). The
 *    flag stays up through the collapse slide — CLOSE_MS below — or the
 *    retreating panel would vanish the instant the pointer left it.
 *
 * 2. The panel inside is a fixed EXPANDED_W slab and the ONLY thing that
 *    animates is one translateX on it (.rail-slide in styles.css). Collapsed,
 *    the slab is shifted +SLIDE px so its left RAIL_W — the icon cells —
 *    fills the rail exactly, and the label region hangs past the window edge
 *    where `body { overflow: hidden }` clips it. Expanded, it slides to 0 and
 *    the labels arrive already laid out. Icons, labels, fill, and the left
 *    edge ride one rigid transform: they cannot desync from the reveal, and
 *    the ride stays on the compositor (no per-frame layout or reflow at
 *    intermediate widths). The hover pill is the one state-aware piece — its
 *    right edge tracks the reveal on the same clock (.rail-pill).
 *
 * Rows are placeholders wired to the store actions that already exist (chat,
 * saves, videos, downloads, settings); the profile control at the bottom
 * shows the active space and does nothing yet.
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Bookmark,
  ChevronsUpDown,
  Clapperboard,
  Settings2,
  Sparkles,
} from "lucide-react";
import { RailVoice } from "./RailVoice";
import { selectActiveSpace, useSumaStore } from "../store";

/** The permanent layout column — also each row's icon cell, so a collapsed
 *  icon is centered in exactly the strip that stays visible. */
const RAIL_W = 46;
const EXPANDED_W = 210;
/** How far the slab travels between states. */
const SLIDE = EXPANDED_W - RAIL_W;

/** Must outlast .rail-slide's collapsed duration (180ms): this timer is what
 *  drops railExpanded and lowers the chrome after the retreat lands. */
const CLOSE_MS = 220;

function RailButton({
  icon,
  label,
  hint,
  expanded,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // The label announces the row when expanded; collapsed, the native
      // tooltip stands in for it.
      title={expanded ? undefined : label}
      className="group relative flex h-8 w-full cursor-pointer items-center outline-none"
    >
      {/* The hover pill wraps the WHOLE row — icon, label, and hint — but a
          fixed full-width pill would be sliced by the window edge while
          collapsed. So its right edge rides the reveal: SLIDE px in while
          collapsed (leaving a chip around just the icon), flush while
          expanded, transitioned on the same clock as the panel transform
          (.rail-pill in styles.css) so the pill never outruns the edge. */}
      <span
        className="rail-pill pointer-events-none absolute inset-y-0 left-1 rounded-lg group-hover:bg-ink/8 group-focus-visible:bg-ink/8 group-focus-visible:ring-2 group-focus-visible:ring-accent/50"
        style={{ right: expanded ? 4 : SLIDE + 4 }}
      />
      <span
        className="flex shrink-0 items-center justify-center text-muted transition-colors group-hover:text-text group-focus-visible:text-text"
        style={{ width: RAIL_W }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-[12.5px] text-muted transition-colors group-hover:text-text group-focus-visible:text-text">
        {label}
      </span>
      {hint === undefined ? null : (
        <span className="shrink-0 pr-3.5 font-mono text-[10.5px] text-faint transition-colors group-hover:text-muted group-focus-visible:text-muted">
          {hint}
        </span>
      )}
    </button>
  );
}

export function SideRail() {
  const [expanded, setExpanded] = useState(false);
  const setRailExpanded = useSumaStore((s) => s.setRailExpanded);
  const toggleChat = useSumaStore((s) => s.toggleChat);
  const toggleSaves = useSumaStore((s) => s.toggleSaves);
  const toggleVideos = useSumaStore((s) => s.toggleVideos);
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const openSettings = useSumaStore((s) => s.openSettings);
  const space = useSumaStore(selectActiveSpace);

  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const open = () => {
    cancelClose();
    setExpanded(true);
    setRailExpanded(true);
  };
  const close = () => {
    cancelClose();
    setExpanded(false);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setRailExpanded(false);
    }, CLOSE_MS);
  };

  // A stuck flag would leave the chrome permanently raised, deadening every
  // click on the page — clear it if the rail ever unmounts mid-hover.
  useEffect(
    () => () => {
      cancelClose();
      setRailExpanded(false);
    },
    [setRailExpanded],
  );

  return (
    <aside
      className="no-drag relative h-full shrink-0"
      style={{ width: RAIL_W }}
      onPointerEnter={open}
      onPointerLeave={close}
      // Keyboard users get the same reveal: tabbing into any row expands,
      // tabbing out collapses.
      onFocusCapture={open}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
    >
      <div
        data-collapsed={expanded ? undefined : ""}
        className="rail-slide absolute inset-y-0 right-0 flex flex-col border-l border-chrome-edge bg-chrome"
        style={{
          width: EXPANDED_W,
          transform: `translateX(${expanded ? 0 : SLIDE}px)`,
        }}
      >
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-2">
          {/* The voice assistant lives at the very top — this row owns the
              microphone for the whole feature, not just its indicator
              (RailVoice.tsx). Renders nothing while the assistant is off. */}
          <RailVoice expanded={expanded} railWidth={RAIL_W} slide={SLIDE} />
          <RailButton
            icon={<Sparkles size={16} strokeWidth={1.8} />}
            label="AI chat"
            hint="⌘I"
            expanded={expanded}
            onClick={toggleChat}
          />
          <RailButton
            icon={<Bookmark size={16} strokeWidth={1.8} />}
            label="Saves"
            hint="⌘B"
            expanded={expanded}
            onClick={toggleSaves}
          />
          <RailButton
            icon={<Clapperboard size={16} strokeWidth={1.8} />}
            label="Videos"
            hint="⇧⌘V"
            expanded={expanded}
            onClick={toggleVideos}
          />
          <RailButton
            icon={<ArrowDownToLine size={16} strokeWidth={1.8} />}
            label="Downloads"
            hint="⇧⌘J"
            expanded={expanded}
            onClick={() => setOverlay("downloads")}
          />
          <RailButton
            icon={<Settings2 size={16} strokeWidth={1.8} />}
            label="Settings"
            hint="⌘,"
            expanded={expanded}
            onClick={() => void openSettings()}
          />
        </nav>

        {/* Profile selector placeholder: shows the active space; switching
            lives elsewhere for now. */}
        <div className="shrink-0 border-t border-hairline py-2">
          <button
            type="button"
            title={expanded ? undefined : (space?.name ?? "Profile")}
            className="group relative flex h-10 w-full cursor-pointer items-center outline-none"
          >
            <span
              className="rail-pill pointer-events-none absolute inset-y-1 left-1 rounded-lg group-hover:bg-ink/8 group-focus-visible:bg-ink/8 group-focus-visible:ring-2 group-focus-visible:ring-accent/50"
              style={{ right: expanded ? 4 : SLIDE + 4 }}
            />
            <span
              className="flex shrink-0 items-center justify-center"
              style={{ width: RAIL_W }}
            >
              <span
                className="grid size-5 place-items-center rounded-full text-[10px] font-semibold text-white"
                style={{ background: space?.color ?? "var(--color-accent)" }}
              >
                {(space?.name ?? "P").slice(0, 1).toUpperCase()}
              </span>
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-[12.5px] text-text">
              {space?.name ?? "Profile"}
            </span>
            <span className="shrink-0 pr-3.5 text-faint transition-colors group-hover:text-muted group-focus-visible:text-muted">
              <ChevronsUpDown size={14} strokeWidth={1.8} />
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}
