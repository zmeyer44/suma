import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Search, Star } from "lucide-react";
import type { HistoryVisit } from "@suma/protocol";
import { cn } from "../lib/cn";
import { fuzzyFilter } from "../lib/fuzzy";
import {
  hostOf,
  isProbablyUrl,
  normalizeUrlInput,
  prettyUrl,
} from "../lib/url";
import { selectActiveTab, useSumaStore } from "../store";
import { Favicon } from "./Favicon";
import { Input } from "./ui/input";

interface CommandItem {
  id: string;
  kind: "navigate" | "tab" | "space" | "action" | "search" | "history";
  title: string;
  subtitle?: string;
  hint?: string;
  faviconUrl?: string | null;
  faviconSeed?: string;
  dotColor?: string;
  run: () => void;
}

function searchKey(item: CommandItem): string {
  return `${item.title} ${item.subtitle ?? ""}`;
}

/** Cmd+K palette: fuzzy tabs/spaces/actions, URL-ish input navigates. */
export function CommandBar() {
  const open = useSumaStore((s) => s.overlay === "command");
  const setOverlay = useSumaStore((s) => s.setOverlay);
  const openSettings = useSumaStore((s) => s.openSettings);
  const openTerminal = useSumaStore((s) => s.openTerminal);
  const tabs = useSumaStore((s) => s.tabs);
  const spaces = useSumaStore((s) => s.spaces);
  const activeTab = useSumaStore(selectActiveTab);
  const selectTab = useSumaStore((s) => s.selectTab);
  const setActiveSpace = useSumaStore((s) => s.setActiveSpace);
  const createTab = useSumaStore((s) => s.createTab);
  const createSpace = useSumaStore((s) => s.createSpace);
  const togglePin = useSumaStore((s) => s.togglePin);
  const toggleSplit = useSumaStore((s) => s.toggleSplit);
  const navigate = useSumaStore((s) => s.navigate);
  const activeDownloads = useSumaStore(
    (s) => s.downloads.filter((d) => d.state === "progressing").length,
  );
  const authState = useSumaStore((s) => s.auth.state);
  const authKnown = useSumaStore((s) => s.authKnown);
  const openOnboarding = useSumaStore((s) => s.openOnboarding);

  const searchHistory = useSumaStore((s) => s.searchHistory);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [historyHits, setHistoryHits] = useState<HistoryVisit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      inputRef.current?.focus();
    }
  }, [open]);

  // History matches load async per keystroke; a stale response must never
  // clobber the results of a newer query.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
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
  }, [open, query, searchHistory]);

  const close = () => setOverlay("none");

  const items = useMemo<CommandItem[]>(() => {
    const q = query.trim();

    const tabItems: CommandItem[] = tabs.map((t) => ({
      id: `tab:${t.id}`,
      kind: "tab",
      title: t.title || prettyUrl(t.url) || "New tab",
      subtitle: prettyUrl(t.url),
      hint: t.pinned ? "Pinned tab" : "Tab",
      faviconUrl: t.faviconUrl,
      faviconSeed: hostOf(t.url),
      run: () => void selectTab(t.id),
    }));

    const spaceItems: CommandItem[] = spaces
      .filter((sp) => !sp.active)
      .map((sp) => ({
        id: `space:${sp.id}`,
        kind: "space",
        title: sp.name,
        subtitle: `${sp.tabCount} tab(s)`,
        hint: "Switch space",
        dotColor: sp.color,
        run: () => void setActiveSpace(sp.id),
      }));

    const actionItems: CommandItem[] = [
      {
        id: "act:new-tab",
        kind: "action",
        title: "New tab",
        hint: "⌘T",
        run: () => void createTab(),
      },
      {
        id: "act:new-space",
        kind: "action",
        title: "New space",
        run: () => void createSpace(),
      },
      ...(activeTab !== null
        ? [
            {
              id: "act:pin",
              kind: "action" as const,
              title: activeTab.pinned ? "Unpin this tab" : "Pin this tab",
              subtitle: activeTab.pinned
                ? "Keep it open but remove the pinned treatment"
                : "Open tabs sync when you confirm; pinning keeps this one prominent",
              run: () => void togglePin(activeTab.id),
            },
          ]
        : []),
      ...(() => {
        const splitTab = tabs.find((t) => t.split);
        if (splitTab !== undefined) {
          return [
            {
              id: "act:unsplit",
              kind: "action" as const,
              title: "Close split view",
              subtitle: `${splitTab.title || prettyUrl(splitTab.url)} returns to a single pane`,
              run: () => void toggleSplit(splitTab.id),
            },
          ];
        }
        if (activeTab !== null && tabs.length > 1) {
          return [
            {
              id: "act:split",
              kind: "action" as const,
              title: "Split view with this tab",
              subtitle: "Show this tab beside the previous one (2-pane)",
              run: () => void toggleSplit(activeTab.id),
            },
          ];
        }
        return [];
      })(),
      {
        id: "act:settings",
        kind: "action",
        title: "Open settings",
        subtitle: "suma://settings — a page, not a dialog",
        hint: "⌘,",
        run: () => void openSettings(),
      },
      {
        id: "act:terminal",
        kind: "action",
        title: "Terminal",
        subtitle: "suma://terminal — a shell on your Suma machine, in a tab",
        run: () => void openTerminal(),
      },
      {
        id: "act:ports",
        kind: "action",
        title: "Ports",
        subtitle:
          "Detected listeners and forwarding chips, on the terminal page",
        run: () => void openTerminal(),
      },
      {
        id: "act:audit",
        kind: "action",
        title: "Audit log",
        subtitle: "Account activity recorded by the control plane",
        run: () => void openSettings("privacy/audit"),
      },
      {
        id: "act:egress",
        kind: "action",
        title: "Egress settings",
        subtitle: "Identity IP vs direct, per space — plus site bypasses",
        run: () => void openSettings("privacy/egress"),
      },
      {
        id: "act:downloads",
        kind: "action",
        title: "Downloads",
        subtitle:
          activeDownloads > 0
            ? `${activeDownloads} in progress`
            : "Open the downloads list",
        hint: "⌘⇧J",
        run: () => setOverlay("downloads"),
      },
      ...(activeTab !== null && hostOf(activeTab.url).length > 0
        ? [
            {
              id: "act:fill",
              kind: "action" as const,
              title: "Fill password",
              subtitle: `Search logins for ${hostOf(activeTab.url)}`,
              run: () => setOverlay("credentials"),
            },
          ]
        : []),
      ...(authKnown && authState !== "enrolled"
        ? [
            {
              id: "act:setup",
              kind: "action" as const,
              title: "Set up Suma sync",
              subtitle: "Create your account and enroll this Mac",
              run: () => openOnboarding(),
            },
          ]
        : []),
      {
        id: "act:devices",
        kind: "action",
        title: "Manage devices",
        subtitle: "Enrolled Macs, revocation, recovery",
        run: () => void openSettings("account/devices"),
      },
      {
        id: "act:recover",
        kind: "action",
        title: "Recover on a new device",
        subtitle: "Enter your recovery code in settings",
        run: () => void openSettings("account/recovery"),
      },
      {
        id: "act:migrate",
        kind: "action",
        title: "Start migration",
        subtitle: "Import spaces, tabs, and bookmarks from Chrome or Arc",
        run: () => setOverlay("migration"),
      },
    ];

    const ranked = fuzzyFilter(
      [...tabItems, ...spaceItems, ...actionItems],
      q,
      searchKey,
    ).slice(0, 10);

    // History matches rank below live tabs/actions — an open tab beats a
    // memory of one. Skip URLs that are already open as a tab.
    const openUrls = new Set(tabs.map((t) => t.url));
    const historyItems: CommandItem[] = historyHits
      .filter((v) => !openUrls.has(v.url))
      .slice(0, 4)
      .map((v) => ({
        id: `history:${v.id}`,
        kind: "history",
        title: v.title || prettyUrl(v.url),
        subtitle: prettyUrl(v.url),
        hint: "History",
        faviconSeed: hostOf(v.url),
        run: () => void navigate(activeTab?.id ?? null, v.url),
      }));

    const out: CommandItem[] = [];
    if (q.length > 0 && isProbablyUrl(q)) {
      const url = normalizeUrlInput(q);
      out.push({
        id: "goto",
        kind: "navigate",
        title: `Go to ${prettyUrl(url)}`,
        subtitle: url,
        hint: "↵",
        run: () => void navigate(activeTab?.id ?? null, url),
      });
    }
    out.push(...ranked, ...historyItems);
    if (q.length > 0 && !isProbablyUrl(q)) {
      out.push({
        id: "search",
        kind: "search",
        title: `Search the web for "${q}"`,
        hint: "↵",
        run: () => void navigate(activeTab?.id ?? null, normalizeUrlInput(q)),
      });
    }
    return out;
  }, [
    query,
    tabs,
    spaces,
    activeTab,
    historyHits,
    selectTab,
    setActiveSpace,
    createTab,
    createSpace,
    togglePin,
    toggleSplit,
    navigate,
    setOverlay,
    openSettings,
    openTerminal,
    activeDownloads,
    authKnown,
    authState,
    openOnboarding,
  ]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  const run = (item: CommandItem | undefined) => {
    if (item === undefined) return;
    // Dismiss the bar BEFORE running the item. `close()` is
    // `setOverlay("none")`, so closing afterwards cancelled every item that
    // opens another overlay — Terminal, Open settings, Downloads, Audit log,
    // Egress settings, Manage devices, Recover, Start migration, Fill
    // password. Both calls are synchronous store writes, so ordering them
    // this way lets the item's own overlay be the one that survives.
    close();
    item.run();
  };

  return (
    <div
      className="animate-backdrop-in veil fixed inset-0 z-40"
      onClick={close}
    >
      <div
        role="dialog"
        aria-label="Command bar"
        onClick={(e) => e.stopPropagation()}
        className="animate-overlay-in mx-auto mt-[12vh] w-[580px] max-w-[calc(100vw-48px)] overflow-hidden rounded-2xl border border-ink/10 bg-raised shadow-pop"
      >
        <div className="flex items-center gap-2.5 border-b border-hairline px-4">
          <Search className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
          <Input
            variant="bare"
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="Search tabs, spaces, actions — or type a URL"
            aria-label="Command input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (items.length > 0) run(items[selected]);
                else if (query.trim().length > 0) {
                  void navigate(
                    activeTab?.id ?? null,
                    normalizeUrlInput(query),
                  );
                  close();
                }
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            className="h-[46px] w-full text-[14px]"
          />
          <kbd className="shrink-0 rounded-md border border-hairline bg-ink/4 px-1.5 py-0.5 text-[10px] text-faint">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[320px] overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-faint">
              No matches.
            </p>
          ) : (
            items.map((item, i) => (
              <button
                key={item.id}
                type="button"
                data-index={i}
                onMouseMove={() => setSelected(i)}
                onClick={() => run(item)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left",
                  i === selected && "bg-accent/15",
                )}
              >
                {item.kind === "tab" || item.kind === "history" ? (
                  <Favicon
                    src={item.faviconUrl ?? null}
                    seed={item.faviconSeed ?? item.title}
                  />
                ) : item.kind === "space" ? (
                  <span
                    className="size-3 shrink-0 rounded-full"
                    style={{
                      background: item.dotColor ?? "var(--color-accent)",
                    }}
                  />
                ) : (
                  <span className="grid size-4 shrink-0 place-items-center text-faint">
                    {item.kind === "navigate" || item.kind === "search" ? (
                      <ArrowRight className="size-3" aria-hidden="true" />
                    ) : (
                      <Star className="size-3" aria-hidden="true" />
                    )}
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
            ))
          )}
        </div>
      </div>
    </div>
  );
}
