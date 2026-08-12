/**
 * What fills the content hole when the active space has no tabs (§6).
 *
 * This is the one moment in Suma with no omnibox: the address field lives
 * INSIDE the active tab (TabStrip.tsx), so with zero tabs there is nowhere to
 * type a URL short of ⌘T or ⌘K. The field here is therefore the primary
 * action, not decoration — everything else on the card is a shortcut to
 * something the empty window can't otherwise reach quickly.
 *
 * It paints no opaque surface of its own. The hole is transparent, so this
 * floats over the window background — or, with translucent chrome on, over
 * the blurred desktop (styles.css). The only decoration is the marketing
 * site's pixel motif (EmptyStatePixels.tsx): hard-edged lattice squares at
 * whisper opacity, which tint the ground without becoming a surface, and a
 * ghosted corner watermark. A solid card would still fight the blur — and
 * backdrop-filter is off-limits here entirely, since the transparent hole
 * gives it nothing to sample and Chromium composites dark garbage instead.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Command, Import, Plus, Search, SquareTerminal } from "lucide-react";
import type { HistoryVisit } from "@suma/protocol";
import { cn } from "../lib/cn";
import { agoLabel } from "../lib/format";
import { greetingFor } from "../lib/greeting";
import { PixelBackdrop } from "./EmptyStatePixels";
import { hostOf, normalizeUrlInput, prettyUrl } from "../lib/url";
import { selectActiveSpace, useSumaStore } from "../store";
import { Favicon } from "./Favicon";
import { Input } from "./ui/input";
import { SumaMark } from "./ui/suma-mark";

/** Recent visits shown; history returns the same URL once per session-ish
 *  (30s dedupe upstream), so identical URLs are collapsed here too. */
const RECENT_LIMIT = 5;

function Action({
  title,
  note,
  hint,
  onClick,
  children,
}: {
  title: string;
  note: string;
  hint?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex cursor-pointer items-center gap-2.5 rounded-xl border border-hairline bg-ink/4 px-3 py-2.5 text-left transition-colors hover:border-ink/20 hover:bg-ink/8"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-ink/6 text-muted transition-colors group-hover:bg-accent/15 group-hover:text-accent">
        {children}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] text-text">{title}</span>
          {hint !== undefined ? (
            <kbd className="shrink-0 rounded border border-ink/10 bg-ink/5 px-1 font-sans text-[9.5px] text-faint">
              {hint}
            </kbd>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-[10.5px] text-faint">
          {note}
        </span>
      </span>
    </button>
  );
}

/** Newest-first visits, one row per URL. */
function dedupeByUrl(visits: HistoryVisit[]): HistoryVisit[] {
  const seen = new Set<string>();
  const out: HistoryVisit[] = [];
  for (const v of visits) {
    if (seen.has(v.url)) continue;
    seen.add(v.url);
    out.push(v);
  }
  return out;
}

function RecentVisits({ onOpen }: { onOpen: (url: string) => void }) {
  const searchHistory = useSumaStore((s) => s.searchHistory);
  const [visits, setVisits] = useState<HistoryVisit[]>([]);

  // Fetched on mount — this component only exists while the space is empty,
  // so mounting IS the moment the list becomes relevant.
  useEffect(() => {
    let live = true;
    void searchHistory("").then((hits) => {
      if (live) setVisits(dedupeByUrl(hits).slice(0, RECENT_LIMIT));
    });
    return () => {
      live = false;
    };
  }, [searchHistory]);

  if (visits.length === 0) return null;

  return (
    <section className="mt-5">
      <h2 className="mb-1.5 text-[10px] font-semibold tracking-[0.16em] text-faint uppercase">
        Pick up where you left off
      </h2>
      <ul className="flex flex-col">
        {visits.map((visit) => {
          const host = hostOf(visit.url);
          return (
            <li key={visit.id}>
              <button
                type="button"
                onClick={() => onOpen(visit.url)}
                title={`${visit.title || visit.url}\n${prettyUrl(visit.url)}`}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink/6"
              >
                <Favicon src={null} seed={host || visit.title} />
                {/* Title and host read as one phrase, so they stay adjacent
                    and share the slack; only the timestamp is pushed right. */}
                <span className="max-w-[60%] shrink truncate text-[12px] text-text">
                  {visit.title || prettyUrl(visit.url)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">
                  {host}
                </span>
                <span className="shrink-0 text-[10.5px] text-faint/70">
                  {agoLabel(visit.atMs)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function EmptyState() {
  const createTab = useSumaStore((s) => s.createTab);
  const toggleCommandBar = useSumaStore((s) => s.toggleCommandBar);
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const openTerminal = useSumaStore((s) => s.openTerminal);
  const space = useSumaStore(selectActiveSpace);
  const displayName = useSumaStore((s) => s.auth.displayName);
  const wizardOpen = useSumaStore((s) => s.wizardOpen);

  const newTabUrl = useSumaStore((s) => s.settings.newTabUrl);

  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // One seed per mount: the greeting varies visit to visit but holds still
  // while the card is up. Recomputed (not frozen) so the line upgrades from
  // the anonymous pool to a by-name one when auth finishes loading.
  const [greetingSeed] = useState(() => Math.random());
  const greeting = useMemo(
    () =>
      greetingFor({
        displayName,
        hour: new Date().getHours(),
        seed: greetingSeed,
      }),
    [displayName, greetingSeed],
  );

  // The card promises what ⌘T actually does, which is now a setting.
  const newTabNote =
    newTabUrl === ""
      ? "Blank tab in this space"
      : `Opens ${prettyUrl(newTabUrl)}`;

  // The window has no other text target while it is empty, so taking focus
  // costs nothing and saves a click.
  useEffect(() => inputRef.current?.focus(), []);

  const submit = (): void => {
    const value = draft.trim();
    if (value.length === 0) return;
    void createTab(normalizeUrlInput(value));
    setDraft("");
  };

  // With translucent chrome on, the onboarding screen's bg-panel is NOT
  // opaque — anything painted here shows through it. Unmount instead of
  // relying on the wizard to cover us.
  if (wizardOpen) return null;

  return (
    <div className="absolute inset-0">
      {/* The pixel motif from the marketing site, pinned to the hole (not the
          scroll container, so it holds still under a short window): corner
          drift plus the mosaic watermark — hard flat-banded squares, no
          gradients. See EmptyStatePixels.tsx. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <PixelBackdrop />
      </div>

      <div className="absolute inset-0 flex justify-center overflow-y-auto p-6">
        {/* my-auto rather than items-center: centered when it fits, scrollable
            from the top when the hole is shorter than the card. */}
        <div className="my-auto w-full max-w-[480px]">
          <header className="flex flex-col items-center text-center">
            {/* The same mark the settings rail and onboarding carry, set in the
              user's accent on the icon-tile wash the onboarding cards use. */}
            <span className="grid size-12 place-items-center rounded-2xl border border-accent/20 bg-accent/10">
              <SumaMark className="h-6 text-accent" />
            </span>
            <h1 className="mt-4 text-[16px] font-semibold tracking-[-0.01em] text-text">
              {greeting}
            </h1>
            {/* Status pill, same shape as onboarding's "Signed up as" chip; the
              dot names the egress path — accent for Suma IP, ok for direct.
              With the headline now a greeting, this is also what still says
              WHICH space the window is sitting in. */}
            <p className="mt-2.5 inline-flex items-center gap-2 rounded-full border border-hairline bg-ink/4 px-3 py-1 text-[11px] text-muted">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  space?.egressPolicy === "suma-ip" ? "bg-accent" : "bg-ok",
                )}
              />
              {space !== null ? (
                <span className="font-medium text-text">{space.name}</span>
              ) : null}
              {space?.egressPolicy === "suma-ip"
                ? "browsing through your Suma identity IP"
                : "browsing direct from this Mac"}
            </p>
          </header>

          <form
            className="mt-5"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="flex items-center gap-2 rounded-xl border border-hairline bg-bg/60 px-3 py-2 shadow-lg shadow-ink/5 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
              <Search
                className="size-3 shrink-0 text-faint"
                aria-hidden="true"
              />
              <Input
                variant="bare"
                ref={inputRef}
                type="text"
                spellCheck={false}
                autoComplete="off"
                aria-label="Search or enter URL"
                placeholder="Search or enter URL"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="flex-1 font-mono text-[12.5px] selection:bg-accent/25 placeholder:font-sans"
              />
              <kbd className="shrink-0 rounded border border-ink/10 bg-ink/5 px-1 py-px font-sans text-[9.5px] text-faint">
                ↵
              </kbd>
            </div>
          </form>

          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <Action
              title="New tab"
              hint="⌘T"
              note={newTabNote}
              onClick={() => void createTab()}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Action>
            {/* A palette of rows, deliberately unlike the terminal's prompt
              chevron below — the two glyphs sat side by side and read as
              the same icon when both were a bracketed caret. */}
            <Action
              title="Command bar"
              hint="⌘K"
              note="Tabs, spaces, history, actions"
              onClick={toggleCommandBar}
            >
              <Command className="size-3.5" aria-hidden="true" />
            </Action>
            <Action
              title="Terminal"
              note="Shell on your Suma machine"
              onClick={() => void openTerminal()}
            >
              <SquareTerminal className="size-3.5" aria-hidden="true" />
            </Action>
            <Action
              title="Import"
              note="Bring over Chrome or Arc"
              onClick={() => setOverlay("migration")}
            >
              <Import className="size-3.5" aria-hidden="true" />
            </Action>
          </div>

          <RecentVisits onOpen={(url) => void createTab(url)} />
        </div>
      </div>
    </div>
  );
}
