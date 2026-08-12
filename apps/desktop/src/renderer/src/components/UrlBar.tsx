import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  ArrowRight,
  Globe,
  History,
  Star,
  X,
} from "lucide-react";
import type { HistoryVisit } from "@suma/protocol";
import { cn } from "../lib/cn";
import { dismissRecent, loadDismissedRecents } from "../lib/recents";
import {
  hostOf,
  isProbablyUrl,
  normalizeUrlInput,
  prettyUrl,
} from "../lib/url";
import { selectActiveTab, useSumaStore } from "../store";
import { Favicon, googleFavicon } from "./Favicon";
import { FavoriteIcon } from "./FavoriteIcon";
import { Input } from "./ui/input";

interface UrlItem {
  id: string;
  kind: "navigate" | "search" | "history";
  title: string;
  subtitle?: string;
  hint?: string;
  faviconSeed?: string;
  url: string;
}

/**
 * One selectable thing in the modal, across every region. `horizontal` rows
 * (chips, tiles) are walked with ←/→; vertical lists with ↑/↓.
 */
type Entry =
  | { kind: "suggestion"; id: string; url: string; item: UrlItem }
  | { kind: "recent"; id: string; url: string; label: string }
  | { kind: "favorite"; id: string; url: string; label: string }
  | { kind: "history"; id: string; url: string; visit: HistoryVisit }
  | { kind: "tab"; id: string; url: string; tabId: string; title: string; faviconUrl: string | null };

const HORIZONTAL_KINDS: ReadonlySet<Entry["kind"]> = new Set([
  "recent",
  "favorite",
]);

/** A run of same-kind entries — the unit ↑/↓ jump between. */
interface Zone {
  start: number;
  end: number;
  horizontal: boolean;
}

function zonesOf(entries: Entry[]): Zone[] {
  const zones: Zone[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const last = zones.at(-1);
    const horizontal = HORIZONTAL_KINDS.has(entry.kind);
    const sameRun =
      last !== undefined &&
      last.end === i &&
      entries[i - 1]?.kind === entry.kind;
    if (sameRun && last !== undefined) last.end = i + 1;
    else zones.push({ start: i, end: i + 1, horizontal });
  }
  return zones;
}

const BROWSE_RECENTS = 8;
const BROWSE_HISTORY_ROWS = 6;
const BROWSE_TAB_ROWS = 8;

/** The dialog's width, and the chips row's own horizontal padding (px-6). */
const MODAL_MAX_W = 816;
const CHIP_ROW_PADDING = 48;

/**
 * A chip's rendered width, estimated from its label so the row can be SLICED
 * to what fits — the chips are a shelf, not a scroller, and a clipped
 * half-chip at the edge reads as broken. Deliberately generous per-character
 * (12.5px semibold averages under 7px/char) so estimation error under-fills
 * the row instead of overflowing it.
 */
function chipWidthEstimate(label: string): number {
  const text = Math.min(label.length * 7, 110); // truncation cap: max-w-[110px]
  // pl-2 + icon + gap-2 + label + pr-3.5 + the w-2 inter-chip spacer.
  return 8 + 20 + 8 + text + 14 + 8;
}

/**
 * The address bar, as a search-style modal (⌘L, or clicking a visible tab's
 * URL). The tab strip has no editable field of its own: editing happens here,
 * with the input prefilled with the current URL and selected, so typing
 * replaces it and Escape leaves the page untouched.
 *
 * It edits whichever tab opened it (store.urlBarTabId) rather than always the
 * active one: a split shows two live pages, and clicking either pane's address
 * has to edit THAT pane. ⌘L opens it with no target and means the active tab.
 *
 * Two faces, keyed on whether the address has been EDITED:
 *
 * BROWSE — the field still holds what it opened with (or nothing): a row of
 * recently-visited sites as chips, then a sidebar beside the favorites dock
 * (app-style icons that lift on hover/selection to reveal their name in the
 * space they vacate), recent pages, and the open tabs. Nothing is selected at
 * first, so ⌘L ↵ still just re-commits the current address; arrows step into
 * the regions (↓ between regions and down lists, ←/→ along chip/tile rows —
 * left alone otherwise so they keep moving the input caret).
 *
 * TYPING — the classic suggestion list: go-to/search for what was typed,
 * plus matching history.
 */
export function UrlBar() {
  const open = useSumaStore((s) => s.overlay === "url");
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const activeTab = useSumaStore(selectActiveTab);
  const urlBarTabId = useSumaStore((s) => s.urlBarTabId);
  const targetTab = useSumaStore(
    (s) => s.tabs.find((t) => t.id === s.urlBarTabId) ?? null,
  );
  const tab = urlBarTabId === null ? activeTab : targetTab;
  const navigate = useSumaStore((s) => s.navigate);
  const selectTab = useSumaStore((s) => s.selectTab);
  const searchHistory = useSumaStore((s) => s.searchHistory);
  const favorites = useSumaStore((s) => s.favorites);
  const tabs = useSumaStore((s) => s.tabs);

  const [query, setQuery] = useState("");
  // -1 ⇒ nothing selected (browse mode's initial state, like a palette with a
  // hidden default item): ↵ acts on the typed address, never on a region.
  const [selected, setSelected] = useState(-1);
  const [historyHits, setHistoryHits] = useState<HistoryVisit[]>([]);
  const [recentVisits, setRecentVisits] = useState<HistoryVisit[]>([]);
  /** Hosts ✕'d off the chips row — see lib/recents.ts for the semantics. */
  const [dismissed, setDismissed] = useState(loadDismissedRecents);
  /** Chips mid-exit: still mounted, fading and collapsing, inert. */
  const [removingHosts, setRemovingHosts] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [section, setSection] = useState("favorites");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingSelect = useRef(false);
  /** What the field opened holding — while unchanged, the modal browses. */
  const prefillRef = useRef("");

  // Prefill on open. `about:` URLs (a blank new tab) are a placeholder, not an
  // address worth editing, so those open empty.
  const currentUrl = tab?.url ?? "";
  useEffect(() => {
    if (!open) return;
    const prefill = currentUrl.startsWith("about:") ? "" : currentUrl;
    prefillRef.current = prefill;
    setQuery(prefill);
    setSelected(-1);
    setSection("favorites");
    pendingSelect.current = true;
    // Deliberately keyed on `open` alone: a live navigation while the bar is
    // up must not overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Selecting has to wait for the render that COMMITS the prefill — calling
  // select() beside the setQuery above would select the previous (usually
  // empty) value and leave the caret parked at the end instead. The ref gates
  // this to the one render after opening, so typing is never re-selected.
  useLayoutEffect(() => {
    if (!pendingSelect.current) return;
    pendingSelect.current = false;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  });

  const q = query.trim();
  const browsing = q.length === 0 || query === prefillRef.current;

  // The browse regions draw on the latest visits, fetched once per open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void searchHistory("", 40).then((visits) => {
      if (!cancelled) setRecentVisits(visits);
    });
    return () => {
      cancelled = true;
    };
  }, [open, searchHistory]);

  // Typed-history matches load async per keystroke; a stale response must
  // never clobber the results of a newer query.
  useEffect(() => {
    if (!open || browsing || q.length < 2) {
      setHistoryHits([]);
      return;
    }
    let cancelled = false;
    void searchHistory(q).then((hits) => {
      if (!cancelled) setHistoryHits(hits);
    });
    return () => {
      cancelled = true;
    };
  }, [open, browsing, q, searchHistory]);

  const items = useMemo<UrlItem[]>(() => {
    if (browsing || q.length === 0) return [];

    const primary: UrlItem = isProbablyUrl(q)
      ? {
          id: "goto",
          kind: "navigate",
          title: `Go to ${prettyUrl(normalizeUrlInput(q))}`,
          subtitle: normalizeUrlInput(q),
          hint: "↵",
          url: normalizeUrlInput(q),
        }
      : {
          id: "search",
          kind: "search",
          title: `Search the web for “${q}”`,
          hint: "↵",
          url: normalizeUrlInput(q),
        };

    // History records one row per VISIT, so a page opened twice would list
    // twice — collapse to the first (most recent) hit per URL. The current URL
    // is what the field opened with; offering to navigate to it is noise.
    const seen = new Set([currentUrl, primary.url]);
    const historyItems: UrlItem[] = [];
    for (const v of historyHits) {
      if (seen.has(v.url)) continue;
      seen.add(v.url);
      historyItems.push({
        id: `history:${v.id}`,
        kind: "history",
        title: v.title || prettyUrl(v.url),
        subtitle: prettyUrl(v.url),
        hint: "History",
        faviconSeed: hostOf(v.url),
        url: v.url,
      });
      if (historyItems.length === 5) break;
    }

    return [primary, ...historyItems];
  }, [browsing, q, historyHits, currentUrl]);

  /** Recently-visited SITES: latest visit per host, as chips. A host whose
   *  latest visit predates its ✕ stays hidden; a newer visit resurrects it.
   *  The list is cut to the chips that FIT the row — never scrolled or
   *  wrapped, so the shelf can't stack or clip at the modal's edge. */
  const recents = useMemo(() => {
    const available =
      Math.min(MODAL_MAX_W, window.innerWidth - 48) - CHIP_ROW_PADDING;
    let used = 0;
    const seen = new Set<string>();
    const out: Array<{
      id: string;
      url: string;
      label: string;
      host: string;
    }> = [];
    for (const v of recentVisits) {
      const host = hostOf(v.url);
      if (host === "" || seen.has(host)) continue;
      seen.add(host);
      if ((dismissed[host] ?? 0) >= v.atMs) continue;
      const label = host.replace(/^www\./, "");
      used += chipWidthEstimate(label);
      if (used > available) break;
      out.push({ id: `recent:${v.id}`, url: v.url, label, host });
      if (out.length === BROWSE_RECENTS) break;
    }
    return out;
  }, [recentVisits, dismissed]);

  /** Recent PAGES: latest visits deduped by address, minus where we are. */
  const historyRows = useMemo(() => {
    const seen = new Set([currentUrl]);
    const out: HistoryVisit[] = [];
    for (const v of recentVisits) {
      if (seen.has(v.url)) continue;
      seen.add(v.url);
      out.push(v);
      if (out.length === BROWSE_HISTORY_ROWS) break;
    }
    return out;
  }, [recentVisits, currentUrl]);

  // The tab being edited is where ↵ already goes — listing it is noise.
  const tabRows = useMemo(
    () => tabs.filter((t) => t.id !== tab?.id).slice(0, BROWSE_TAB_ROWS),
    [tabs, tab?.id],
  );

  const entries = useMemo<Entry[]>(() => {
    if (!browsing) {
      return items.map((item) => ({
        kind: "suggestion",
        id: item.id,
        url: item.url,
        item,
      }));
    }
    return [
      ...recents.map<Entry>((r) => ({ kind: "recent", ...r })),
      ...favorites.map<Entry>((f) => ({
        kind: "favorite",
        id: `favorite:${f.id}`,
        url: f.url,
        label: f.title,
      })),
      ...historyRows.map<Entry>((v) => ({
        kind: "history",
        id: `visit:${v.id}`,
        url: v.url,
        visit: v,
      })),
      ...tabRows.map<Entry>((t) => ({
        kind: "tab",
        id: `tab:${t.id}`,
        url: t.url,
        tabId: t.id,
        title: t.title || prettyUrl(t.url) || "New tab",
        faviconUrl: t.faviconUrl,
      })),
    ];
  }, [browsing, items, recents, favorites, historyRows, tabRows]);

  const zones = useMemo(() => zonesOf(entries), [entries]);
  const total = entries.length;

  // Typing resets the cursor: to the primary suggestion while editing, to
  // nothing while browsing (↵ must keep meaning the typed address).
  useEffect(() => {
    setSelected(browsing ? -1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Entries shrinking (a favorite removed, tabs closing) must not leave the
  // cursor pointing past the end of everything.
  useEffect(() => {
    setSelected((i) => Math.min(i, total - 1));
  }, [total]);

  useEffect(() => {
    dialogRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  if (!open) return null;

  const close = () => setOverlay("none");

  const commit = (url: string | undefined) => {
    if (url === undefined) return;
    close();
    void navigate(tab?.id ?? null, url);
  };

  const act = (entry: Entry | undefined) => {
    if (entry === undefined) return;
    if (entry.kind === "tab") {
      close();
      void selectTab(entry.tabId);
      return;
    }
    commit(entry.url);
  };

  const zoneAt = (index: number): Zone | undefined =>
    zones.find((z) => index >= z.start && index < z.end);

  /**
   * The chip's ✕: fade the chip where it stands, then collapse its slot so
   * the neighbours slide over, and only then record the dismissal (which
   * unmounts it). The timeout outlives a close — the component stays mounted
   * behind `open`, so the dismissal always lands.
   */
  const dismissChip = (host: string) => {
    if (removingHosts.has(host)) return;
    setRemovingHosts((s) => new Set(s).add(host));
    window.setTimeout(() => {
      setDismissed((m) => dismissRecent(m, host, Date.now()));
      setRemovingHosts((s) => {
        const next = new Set(s);
        next.delete(host);
        return next;
      });
    }, 320);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[selected];
      if (entry !== undefined) {
        act(entry);
        return;
      }
      // Nothing selected: act on the typed address. Browsing with an empty
      // field has nothing to act on — leave the modal up.
      if (q.length > 0) commit(normalizeUrlInput(q));
      else if (!browsing) act(entries[0]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const zone = zoneAt(selected);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (total === 0) return;
      if (zone === undefined) {
        setSelected(0);
        return;
      }
      // Down LEAVES a horizontal row (→ walks along it); in a list it steps,
      // rolling into the next region at the end.
      if (zone.horizontal) {
        if (zone.end < total) setSelected(zone.end);
      } else {
        setSelected(Math.min(selected + 1, total - 1));
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (zone === undefined) return;
      if (zone.horizontal || selected === zone.start) {
        const prev = zoneAt(zone.start - 1);
        if (prev === undefined) setSelected(browsing ? -1 : 0);
        else setSelected(prev.horizontal ? prev.start : prev.end - 1);
      } else {
        setSelected(selected - 1);
      }
      return;
    }
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      zone !== undefined &&
      zone.horizontal
    ) {
      // Only intercepted along a chip/tile row — everywhere else these keys
      // keep moving the input's caret.
      e.preventDefault();
      setSelected((i) =>
        e.key === "ArrowLeft"
          ? Math.max(i - 1, zone.start)
          : Math.min(i + 1, zone.end - 1),
      );
    }
  };

  const indexOfKind = (kind: Entry["kind"], offset: number): number =>
    entries.findIndex((entry) => entry.kind === kind) + offset;

  const scrollToSection = (key: string) => {
    setSection(key);
    scrollRef.current
      ?.querySelector(`[data-section="${key}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const sections = [
    { key: "favorites", label: "Favorites", icon: Star, count: favorites.length },
    { key: "history", label: "Recent", icon: History, count: historyRows.length },
    { key: "tabs", label: "Open tabs", icon: AppWindow, count: tabRows.length },
  ].filter((s) => s.count > 0);

  const hasBrowseContent = browsing && sections.length > 0;

  return (
    <div
      className="animate-backdrop-in veil fixed inset-0 z-40"
      onClick={close}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Address bar"
        onClick={(e) => e.stopPropagation()}
        className="animate-overlay-in mx-auto mt-[8vh] flex max-h-[min(720px,80vh)] w-[816px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[24px] border border-modal-edge bg-modal shadow-pop"
      >
        {/* The input row: tall and borderless, the field IS the header. */}
        <div className="flex shrink-0 items-center gap-3 px-6 pt-5 pb-3">
          <Globe className="size-4 shrink-0 text-faint" aria-hidden="true" />
          <Input
            variant="bare"
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="Search or enter URL"
            aria-label="Address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="h-7 w-full font-mono text-[14px] placeholder:font-sans"
          />
          <kbd className="shrink-0 rounded-md border border-hairline bg-ink/4 px-1.5 py-0.5 text-[10px] text-faint">
            esc
          </kbd>
        </div>

        {/* Recently-visited sites, as chips. Hovering a chip crossfades its
            icon to a ✕; the ✕ dismisses the chip — fade in place, then the
            slot collapses (grid 0fr trick) so the row slides closed. The
            inter-chip spacing lives INSIDE the clipped content rather than as
            a row gap, so it collapses with the chip instead of leaving an
            8px seam behind. */}
        {browsing && recents.length > 0 ? (
          <div className="flex shrink-0 overflow-hidden px-6 pb-4">
            {recents.map((recent, ri) => {
              const index = ri;
              const active = index === selected;
              const removing = removingHosts.has(recent.host);
              return (
                <span
                  key={recent.id}
                  className={cn(
                    "grid transition-[grid-template-columns] duration-200 ease-out",
                    removing ? "grid-cols-[0fr] delay-100" : "grid-cols-[1fr]",
                  )}
                >
                  <span className="flex min-w-0 overflow-hidden">
                    <button
                      type="button"
                      data-index={index}
                      title={prettyUrl(recent.url)}
                      onMouseMove={() => {
                        if (!removing) setSelected(index);
                      }}
                      onClick={() => {
                        if (!removing) commit(recent.url);
                      }}
                      className={cn(
                        "group/chip flex shrink-0 cursor-pointer items-center gap-2 rounded-full py-1.5 pr-3.5 pl-2 transition-[background-color,opacity] duration-150 ease-out",
                        active && !removing
                          ? "bg-ink/14"
                          : "bg-ink/6 hover:bg-ink/10",
                        removing && "pointer-events-none opacity-0",
                      )}
                    >
                      <span className="relative size-5 shrink-0">
                        <FavoriteIcon
                          url={recent.url}
                          title={recent.label}
                          className="size-5 rounded-[6px] text-[10px] transition-opacity duration-150 ease-out group-hover/chip:opacity-0"
                        />
                        <span
                          role="button"
                          aria-label={`Remove ${recent.label} from recent sites`}
                          onClick={(e) => {
                            e.stopPropagation();
                            dismissChip(recent.host);
                          }}
                          className="absolute inset-0 grid cursor-pointer place-items-center opacity-0 transition-opacity duration-150 ease-out group-hover/chip:opacity-100"
                        >
                          <span className="grid size-5 place-items-center rounded-full bg-ink/25">
                            <X
                              className="size-3 text-modal"
                              strokeWidth={3}
                              aria-hidden="true"
                            />
                          </span>
                        </span>
                      </span>
                      <span className="max-w-[110px] truncate text-[12.5px] font-semibold text-text">
                        {recent.label}
                      </span>
                    </button>
                    <span aria-hidden="true" className="w-2 shrink-0" />
                  </span>
                </span>
              );
            })}
          </div>
        ) : null}

        {/* Browse mode: sidebar beside the grouped content. */}
        {hasBrowseContent ? (
          <div className="flex min-h-0 flex-1 pb-2 pl-3">
            <aside className="flex w-[190px] shrink-0 flex-col gap-px pt-1 pr-2 pb-4">
              {sections.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  tabIndex={-1}
                  onClick={() => scrollToSection(key)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-text transition-colors duration-150",
                    section === key ? "bg-ink/8" : "hover:bg-ink/8",
                  )}
                >
                  <Icon className="size-4 text-muted" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </aside>

            <div
              ref={scrollRef}
              className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-1 pb-6"
            >
              {/* The favorites dock. Each tile is a 64px clipped box; its
                  icon+label column rides 20px up on selection, the label
                  surfacing in the space the icon vacates (hover selects, so
                  hovering and arrowing read identically). */}
              {favorites.length > 0 ? (
                <div
                  data-section="favorites"
                  role="listbox"
                  aria-label="Favorite sites"
                  className="flex flex-wrap gap-x-2 gap-y-4"
                >
                  {favorites.map((favorite, fi) => {
                    const index = indexOfKind("favorite", fi);
                    const active = index === selected;
                    return (
                      <button
                        key={favorite.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-index={index}
                        title={`${favorite.title}\n${prettyUrl(favorite.url)}`}
                        onMouseMove={() => setSelected(index)}
                        onClick={() => commit(favorite.url)}
                        className="relative size-16 shrink-0 cursor-pointer overflow-clip rounded-t-2xl"
                      >
                        <span
                          className={cn(
                            "absolute inset-x-0 top-0 flex flex-col items-center gap-1 transition-transform duration-300 ease-out",
                            active && "-translate-y-5",
                          )}
                        >
                          <FavoriteIcon
                            url={favorite.url}
                            title={favorite.title}
                            className="size-16 rounded-[19px] text-[22px]"
                          />
                          <span className="w-full shrink-0 truncate text-center text-[10.5px] font-semibold text-text">
                            {favorite.title}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {historyRows.length > 0 ? (
                <div data-section="history" className="flex flex-col gap-1.5">
                  <p className="px-1 text-[12px] font-medium text-faint">
                    Recent
                  </p>
                  <div>
                    {historyRows.map((visit, vi) => {
                      const index = indexOfKind("history", vi);
                      const active = index === selected;
                      return (
                        <button
                          key={visit.id}
                          type="button"
                          data-index={index}
                          onMouseMove={() => setSelected(index)}
                          onClick={() => commit(visit.url)}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-[7px] text-left",
                            active && "bg-ink/8",
                          )}
                        >
                          {/* History visits record no favicon (protocol
                              HistoryVisit) — the favicon service stands in,
                              with Favicon's own letter fallback behind it. */}
                          <Favicon
                            src={googleFavicon(hostOf(visit.url))}
                            seed={hostOf(visit.url)}
                          />
                          <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                            {visit.title || prettyUrl(visit.url)}
                          </span>
                          <span className="max-w-[180px] shrink-0 truncate text-[11px] text-faint">
                            {prettyUrl(visit.url)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {tabRows.length > 0 ? (
                <div data-section="tabs" className="flex flex-col gap-1.5">
                  <p className="px-1 text-[12px] font-medium text-faint">
                    Open tabs
                  </p>
                  <div>
                    {tabRows.map((t, ti) => {
                      const index = indexOfKind("tab", ti);
                      const active = index === selected;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          data-index={index}
                          onMouseMove={() => setSelected(index)}
                          onClick={() => {
                            close();
                            void selectTab(t.id);
                          }}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-[7px] text-left",
                            active && "bg-ink/8",
                          )}
                        >
                          <Favicon
                            src={t.faviconUrl}
                            seed={hostOf(t.url) || t.title}
                          />
                          <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                            {t.title || prettyUrl(t.url) || "New tab"}
                          </span>
                          <span className="shrink-0 text-[10px] text-faint">
                            Switch
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Typing mode: the classic suggestion list. */}
        {!browsing && items.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
            {items.map((item, i) => (
              <button
                key={item.id}
                type="button"
                data-index={i}
                onMouseMove={() => setSelected(i)}
                onClick={() => commit(item.url)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-[7px] text-left",
                  i === selected && "bg-accent/15",
                )}
              >
                {item.kind === "history" ? (
                  <Favicon
                    src={
                      item.faviconSeed === undefined
                        ? null
                        : googleFavicon(item.faviconSeed)
                    }
                    seed={item.faviconSeed ?? item.title}
                  />
                ) : (
                  <span className="grid size-4 shrink-0 place-items-center text-faint">
                    <ArrowRight className="size-3" aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-text">
                    {item.title}
                  </span>
                  {item.subtitle !== undefined && item.subtitle.length > 0 ? (
                    <span className="block truncate text-[10.5px] text-faint">
                      {item.subtitle}
                    </span>
                  ) : null}
                </span>
                {item.hint !== undefined ? (
                  <span className="shrink-0 text-[10px] text-faint">
                    {item.hint}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
