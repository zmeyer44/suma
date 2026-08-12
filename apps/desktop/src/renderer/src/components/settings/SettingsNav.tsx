/**
 * The `suma://settings` sidebar: a nav stack whose menus PUSH rather than
 * swap. Selecting a group slides its menu in from the right over the one that
 * opened it; the back control slides the parent menu back in from the left.
 *
 * The push is opaque, not a crossfade. A crossfade leaves both label sets
 * legible on top of each other for a beat, so the incoming panel carries the
 * rail's own background and occludes the outgoing one, which trails at a
 * quarter distance for depth and empties its opacity over the first half of
 * the travel — before the exposed sliver at the edge gets narrow enough to
 * read as a rendering artifact. Timings and curve live in styles.css
 * (`.settings-menu-*`), which also owns the reduced-motion form: no travel,
 * and the two fades sequenced so the lists never overlap.
 *
 * WHICH MENU IS OPEN IS A FUNCTION OF THE ADDRESS. Any navigation into a
 * group's prefix opens that group — a deep link, the command bar, a settings
 * tab synced from another Mac. The back control is the one exception: it
 * steps up a level WITHOUT navigating (you are still on the page you were
 * reading), which is why the open menu is state rather than a pure derivation
 * of the section.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import type { SettingsSection } from "../../../../shared/internal-pages";
import {
  isNavGroup,
  labelFor,
  SETTINGS_NAV,
  type NavEntry,
  type NavGroup,
  type NavItem,
  type NavSection,
} from "./nav-config";

/** Must outlast the longest `.settings-menu-*` animation in styles.css. */
const PUSH_MS = 320;

export function SettingsNav({
  section,
  onNavigate,
}: {
  section: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
}) {
  const { direction, focusTarget, groupPath, onBack, onOpenGroup } =
    useNavDrilldown(section);
  const panels = usePushStack(groupPath.join("/"), direction);

  return (
    // overflow-clip, not -hidden: a hidden box is still programmatically
    // scrollable, so anything that scrolls-into-view (focus, a screen reader
    // moving its cursor) can shove the clipped menu sideways and cancel the
    // push pixel-for-pixel. clip forbids scrolling outright.
    <nav
      aria-label="Settings sections"
      className="relative isolate min-h-0 flex-1 overflow-clip"
    >
      {panels.map((panel) => {
        const groups = resolveGroupPath(panel.key);
        const group = groups[groups.length - 1] ?? null;
        return (
          <SettingsMenu
            className={panel.className}
            focusTarget={panel.leaving ? null : focusTarget}
            group={group}
            inert={panel.leaving}
            key={panel.key}
            onBack={onBack}
            onNavigate={onNavigate}
            onOpenGroup={onOpenGroup}
            section={section}
            sections={group === null ? SETTINGS_NAV : [{ key: group.key, items: group.items }]}
          />
        );
      })}
    </nav>
  );
}

/* --------------------------- the push stack ---------------------------- */

interface Panel {
  key: string;
  /** Mounted only to animate out; kept out of the tab order while it does. */
  leaving: boolean;
  className: string;
}

/**
 * Holds the outgoing menu mounted alongside the incoming one for the length
 * of the push. Two panels at most: a swap that arrives mid-push replaces the
 * one already leaving rather than stacking a third, so a fast drill-in never
 * leaves a pile of half-faded menus behind.
 */
function usePushStack(key: string, direction: number): Panel[] {
  const [state, setState] = useState<{ current: string; leaving: string | null }>(
    () => ({ current: key, leaving: null }),
  );
  const timer = useRef<number | null>(null);

  if (state.current !== key) {
    setState({ current: key, leaving: state.current });
  }

  // Re-armed per outgoing menu. `leaving` strictly alternates between the two
  // most recent keys, so a swap arriving mid-push always changes it and always
  // restarts the clock — the new outgoing panel gets a full push, and the one
  // it replaced is dropped in the same commit rather than left animating.
  useEffect(() => {
    if (state.leaving === null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setState((s) => ({ ...s, leaving: null }));
    }, PUSH_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [state.leaving]);

  const way = direction > 0 ? "fwd" : "back";
  const panels: Panel[] = [];
  if (state.leaving !== null) {
    panels.push({
      key: state.leaving,
      leaving: true,
      className: `settings-menu-out-${way}`,
    });
  }
  panels.push({
    key: state.current,
    leaving: false,
    // No animation on the very first render: the sidebar opening should show
    // its menu already in place, not slide it in from nowhere.
    className: state.leaving === null ? "" : `settings-menu-in-${way}`,
  });
  return panels;
}

/* ---------------------------- the drill-down ---------------------------- */

type FocusTarget = { key: string; kind: "back" | "group" } | null;

function useNavDrilldown(section: SettingsSection) {
  const [state, setState] = useState(() => ({
    direction: 1,
    // What the newly rendered menu should focus, when the swap came from a
    // keyboard or pointer interaction in the rail. Null for address-driven
    // swaps — stealing focus on page load would trap it in the nav.
    focusTarget: null as FocusTarget,
    path: findGroupPath(section),
    /** The section `path` was last reconciled against. */
    syncedSection: section as string,
  }));

  // Derived during render rather than in an effect: an effect would paint one
  // frame of the wrong menu after a deep link or a command-bar jump.
  if (state.syncedSection !== section) {
    const path = findGroupPath(section);
    setState({
      direction: path.length >= state.path.length ? 1 : -1,
      // Cleared, not carried: a group's own entry drills in on click, one
      // render before its navigation resolves, so the focus move has already
      // happened. Keeping the target alive would let it fire again on some
      // later address-driven swap and yank focus into the rail.
      focusTarget: null,
      path,
      syncedSection: section,
    });
  }

  const groupPath = resolveGroupPath(state.path.join("/")).map((g) => g.key);

  return {
    direction: state.direction,
    focusTarget: state.focusTarget,
    groupPath,
    onBack: () =>
      setState((current) => ({
        ...current,
        direction: -1,
        // Focus returns to the entry that opened the menu — how a menu stack
        // is expected to behave.
        focusTarget: {
          key: groupPath[groupPath.length - 1] ?? "",
          kind: "group",
        },
        path: groupPath.slice(0, -1),
      })),
    onOpenGroup: (key: string) =>
      setState((current) => ({
        ...current,
        direction: 1,
        focusTarget: { key, kind: "back" },
        path: [...groupPath, key],
      })),
  };
}

function ownsSection(group: NavGroup, section: string): boolean {
  return section === group.match || section.startsWith(`${group.match}/`);
}

/** Deepest-first chain of group keys owning `section`. */
function findGroupPath(section: string): string[] {
  const walk = (entries: NavEntry[]): string[] => {
    for (const entry of entries) {
      if (!isNavGroup(entry) || !ownsSection(entry, section)) continue;
      return [entry.key, ...walk(entry.items)];
    }
    return [];
  };
  return walk(SETTINGS_NAV.flatMap((s) => s.items));
}

/**
 * Walk a "a/b" key chain back into group objects, stopping at the first key
 * that no longer resolves — so a stale path degrades to its valid prefix
 * instead of rendering a menu the panel key disagrees with.
 */
function resolveGroupPath(key: string): NavGroup[] {
  const groups: NavGroup[] = [];
  let level = SETTINGS_NAV.flatMap((s) => s.items);
  for (const step of key.split("/").filter((k) => k.length > 0)) {
    const match = level.find((entry) => entry.key === step);
    if (match === undefined || !isNavGroup(match)) break;
    groups.push(match);
    level = match.items;
  }
  return groups;
}

/* ------------------------------ the menu ------------------------------- */

function SettingsMenu({
  className,
  focusTarget,
  group,
  inert,
  onBack,
  onNavigate,
  onOpenGroup,
  section,
  sections,
}: {
  className: string;
  focusTarget: FocusTarget;
  group: NavGroup | null;
  inert: boolean;
  onBack: () => void;
  onNavigate: (section: SettingsSection) => void;
  onOpenGroup: (key: string) => void;
  section: SettingsSection;
  sections: NavSection[];
}) {
  return (
    <div
      // The outgoing menu lingers for the length of the push. Taking it out of
      // the tab order and the accessibility tree keeps a fast Tab (or a screen
      // reader) from landing on links on their way out.
      aria-hidden={inert ? true : undefined}
      inert={inert ? true : undefined}
      // bg-bg is the rail's own surface: it is what makes the push opaque, so
      // the outgoing menu is never legible through this one.
      className={cn(
        "absolute inset-0 flex flex-col overflow-x-hidden overflow-y-auto bg-bg px-2 pt-0.5 pb-4",
        className,
      )}
    >
      {group === null ? null : (
        <MenuHeader autoFocus={focusTarget?.kind === "back"} group={group} onBack={onBack} />
      )}
      {sections.map((navSection, index) => (
        <div className="flex w-full flex-col" key={navSection.key}>
          {/* Groups are separated by a rule that runs the full width of the
              rail rather than by whitespace alone: it is the only banding the
              collapsed icon strip has, where the labels below are hidden. */}
          {index === 0 ? null : <Rule className="my-1.5" />}
          {navSection.label === undefined ? null : (
            <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-faint @max-md:hidden">
              {navSection.label}
            </p>
          )}
          <div className="flex flex-col gap-0.5">
            {navSection.items.map((entry) =>
              isNavGroup(entry) ? (
                <GroupButton
                  autoFocus={focusTarget?.kind === "group" && focusTarget.key === entry.key}
                  group={entry}
                  isActive={ownsSection(entry, section)}
                  key={entry.key}
                  onOpen={() => {
                    onOpenGroup(entry.key);
                    onNavigate(entry.section);
                  }}
                />
              ) : (
                <ItemButton
                  isActive={section === entry.section}
                  item={entry}
                  key={entry.key}
                  onSelect={() => onNavigate(entry.section)}
                />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Programmatic focus after a pointer click does not match :focus-visible in
 * any current engine, so this only draws a ring for keyboard users — which is
 * exactly who needs it.
 */
function useAutoFocus(shouldFocus: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // preventScroll is load-bearing, not defensive: the target sits in a panel
    // mid-push from translateX(100%), and a bare focus() makes the browser
    // scroll the nav's overflow ancestors by the panel's full width to reveal
    // it — cancelling the slide while the animation keeps running.
    if (shouldFocus) ref.current?.focus({ preventScroll: true });
    // Mount-only: the menu remounts on every swap, so there is nothing to
    // re-run against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/** Full-bleed against the panel's px-2, so the rule reaches the rail's edges. */
function Rule({ className }: { className: string }) {
  return <div aria-hidden="true" className={cn("-mx-2 h-px shrink-0 bg-hairline", className)} />;
}

function MenuHeader({
  autoFocus,
  group,
  onBack,
}: {
  autoFocus: boolean;
  group: NavGroup;
  onBack: () => void;
}) {
  const ref = useAutoFocus(autoFocus);
  return (
    <div className="flex flex-col">
      <button
        ref={ref}
        type="button"
        onClick={onBack}
        aria-label={`Back to all settings from ${group.label}`}
        title={group.label}
        // Padding and gap match ItemButton exactly, so the menu title sits on
        // the same text baseline column as the entries under it.
        className="group/back flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left outline-none transition-colors hover:bg-ink/6 focus-visible:ring-2 focus-visible:ring-accent/40 @max-md:justify-center @max-md:px-0"
      >
        <ChevronLeft
          className="size-4 shrink-0 text-muted transition-all duration-200 group-hover/back:-translate-x-0.5 group-hover/back:text-text"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 @max-md:hidden">
          <span className="block truncate text-[13px] font-semibold text-text">
            {group.label}
          </span>
          <span className="block truncate text-[10.5px] leading-4 text-faint">
            {group.description}
          </span>
        </span>
      </button>
      <Rule className="my-1.5" />
    </div>
  );
}

const ENTRY =
  "group/nav flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left outline-none transition-[background-color,box-shadow,color] focus-visible:ring-2 focus-visible:ring-accent/40 @max-md:justify-center @max-md:px-0";

/**
 * The selected row is a RAISED card, not a tinted wash: --color-raised sits
 * above the rail's bg on both ladders (in a light theme it is the near-white
 * base against a recessed rail), and the hairline plus the 1px drop are what
 * make it read as lifted off the surface rather than merely painted lighter.
 * Inset rather than a border so the row's box stays the same size in both
 * states and the list does not shift by a pixel as the selection moves.
 */
function entryState(isActive: boolean): string {
  return isActive
    ? "bg-raised text-text shadow-[0_1px_2px_rgb(0_0_0/0.08),inset_0_0_0_1px_var(--color-hairline)]"
    : "text-muted hover:bg-ink/5 hover:text-text";
}

function iconState(isActive: boolean): string {
  return `size-4 shrink-0 transition-colors ${
    isActive ? "text-text" : "text-faint group-hover/nav:text-muted"
  }`;
}

function ItemButton({
  isActive,
  item,
  onSelect,
}: {
  isActive: boolean;
  item: NavItem;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  const label = labelFor(item);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isActive ? "page" : undefined}
      title={label}
      className={cn(ENTRY, entryState(isActive))}
    >
      <Icon className={iconState(isActive)} />
      <span className="min-w-0 flex-1 @max-md:hidden">
        <span className="block truncate text-[13px]">{label}</span>
        {item.note === undefined ? null : (
          <span className="block truncate text-[10px] leading-4 text-faint">
            {item.note}
          </span>
        )}
      </span>
    </button>
  );
}

function GroupButton({
  autoFocus,
  group,
  isActive,
  onOpen,
}: {
  autoFocus: boolean;
  group: NavGroup;
  isActive: boolean;
  onOpen: () => void;
}) {
  const ref = useAutoFocus(autoFocus);
  const Icon = group.icon;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      title={group.label}
      className={cn(ENTRY, entryState(isActive))}
    >
      <Icon className={iconState(isActive)} />
      <span className="min-w-0 flex-1 truncate text-[13px] @max-md:hidden">
        {group.label}
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-faint/70 transition-all duration-200 group-hover/nav:translate-x-0.5 group-hover/nav:text-muted @max-md:hidden"
      />
    </button>
  );
}
