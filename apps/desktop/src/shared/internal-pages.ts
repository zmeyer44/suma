/**
 * suma:// INTERNAL PAGES — the privileged surfaces the chrome renderer draws
 * itself, addressed like any other page (PRD §8.1).
 *
 * `suma://settings` is Suma's `chrome://settings`: a real tab, in the strip,
 * with an address you can type, bookmark by pinning, and close with ⌘W. What
 * it is NOT is a document. There is no bundle to serve and no second
 * WebContents to harden — an internal tab's WebContentsView never loads
 * anything and stays hidden, and the chrome view underneath paints the page
 * into that pane of the content hole. The settings UI therefore keeps reading
 * the one live store the rest of the chrome reads, instead of a second copy
 * of the workspace behind a second IPC bridge (contrast `suma://files`, which
 * is a genuine document because it is a genuine separate app).
 *
 * `suma://terminal` (§8.5) is the second one, and it is here for the same
 * reason settings stopped being a modal: a shell is somewhere you WORK, not
 * something you summon over the page you were reading. As a tab it gets the
 * whole content hole, it survives switching to another tab and back, it can be
 * pinned, and it can be dropped into a split beside the app it is building.
 *
 * Site content still cannot reach any of this: tab-policy.ts refuses suma://
 * at will-navigate/will-redirect, and this module is only consulted for
 * navigations Suma itself initiates.
 *
 * Pure and shared by both processes on purpose. Main derives tab titles from
 * it and the renderer derives its nav tree from it, so a route can never
 * exist in the sidebar without the tab strip knowing what to call it.
 *
 * Parsed with a regex rather than `new URL`: once `suma` is registered as a
 * standard scheme, Blink's URL parser normalizes it differently from Node's
 * (a trailing slash appears), and main and the renderer must agree on the
 * canonical string exactly — it is the tab's synced address register.
 */

/** Section path → the label shown in the sidebar AND in the tab strip. */
export const SETTINGS_SECTIONS = {
  "": "General",
  appearance: "Appearance",
  favorites: "Favorite sites",
  voice: "Voice & audio",
  assistant: "Assistant",
  privacy: "Sign-in & passkeys",
  nostr: "Nostr",
  "privacy/history": "Browsing history",
  "privacy/egress": "Identity IP",
  "privacy/audit": "Audit trail",
  account: "Account",
  "account/devices": "Devices",
  "account/sync": "Sync",
  "account/recovery": "Recovery",
  import: "Import",
} as const;

export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

export const SETTINGS_URL = "suma://settings";
export const TERMINAL_URL = "suma://terminal";

/** The canonical address of one settings section. */
export function settingsUrl(section: SettingsSection): string {
  return section === "" ? SETTINGS_URL : `${SETTINGS_URL}/${section}`;
}

/** Which internal page a route names — the tag ContentPanes switches on. */
export type InternalPage = "settings" | "terminal";

interface RouteBase {
  /** Canonical form — what the tab's address register holds. */
  url: string;
  /** What the tab strip labels the page. */
  title: string;
}

/**
 * A discriminated union, not one shape with optional fields: only the settings
 * page has sections, and the renderer picks the component off `page`.
 */
export type InternalRoute =
  | (RouteBase & { page: "settings"; section: SettingsSection })
  | (RouteBase & { page: "terminal" });

const SETTINGS_RE = /^suma:\/\/settings(\/[^?#]*)?(?:[?#].*)?$/i;
/* The terminal has no sub-pages: which shell is showing is UI state inside
   the page, not an address. Only the bare host (with or without a trailing
   slash) routes here, so `suma://terminal/anything` is not an internal page
   at all rather than silently landing on the shell. */
const TERMINAL_RE = /^suma:\/\/terminal\/?(?:[?#].*)?$/i;

function isSettingsSection(value: string): value is SettingsSection {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SECTIONS, value);
}

/**
 * The route a URL names, or null when it is not an internal page.
 *
 * An unknown settings section resolves to the root rather than to null: a
 * settings URL from a newer build (or a typo in the address bar) should land
 * on Settings, not fail to open as a tab at all.
 */
export function parseInternalUrl(raw: string): InternalRoute | null {
  const trimmed = raw.trim();
  if (TERMINAL_RE.test(trimmed))
    return { page: "terminal", url: TERMINAL_URL, title: "Terminal" };
  const match = SETTINGS_RE.exec(trimmed);
  if (match === null) return null;
  const path = (match[1] ?? "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/")
    .toLowerCase();
  const section: SettingsSection = isSettingsSection(path) ? path : "";
  const label = SETTINGS_SECTIONS[section];
  return {
    page: "settings",
    section,
    url: settingsUrl(section),
    title: section === "" ? "Settings" : `${label} — Settings`,
  };
}

/** True when `raw` addresses THIS internal page (any of its sections). */
export function isInternalPage(raw: string, page: InternalPage): boolean {
  return parseInternalUrl(raw)?.page === page;
}

export function isInternalPageUrl(raw: string): boolean {
  return parseInternalUrl(raw) !== null;
}

/** Canonical spelling of an internal URL, or null for anything else. */
export function canonicalInternalUrl(raw: string): string | null {
  return parseInternalUrl(raw)?.url ?? null;
}

/** Tab-strip label for an internal URL, or null for anything else. */
export function internalPageTitle(raw: string): string | null {
  return parseInternalUrl(raw)?.title ?? null;
}
