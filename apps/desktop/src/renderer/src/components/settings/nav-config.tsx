/**
 * The settings sidebar's nav tree (§8.1 `suma://settings`).
 *
 * Every leaf's `section` is a key of SETTINGS_SECTIONS (shared with main), so
 * a route cannot appear here without the tab strip knowing what to title it,
 * and cannot be renamed in one place only. Groups own a route PREFIX: landing
 * anywhere under it — a deep link, a command-bar action, another device's
 * synced tab — opens that group's menu, which is what makes the drill-down a
 * function of the address rather than of click history.
 */

import type { LucideIcon } from "lucide-react";
import {
  Clock,
  Globe,
  Import,
  Info,
  KeyRound,
  Zap,
  Laptop,
  LifeBuoy,
  Mic,
  Palette,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  User,
  Volume2,
} from "lucide-react";
import type { SettingsSection } from "../../../../shared/internal-pages";
import { SETTINGS_SECTIONS } from "../../../../shared/internal-pages";

type IconType = LucideIcon;

export interface NavItem {
  key: string;
  /** Defaults to the section's shared label. */
  label?: string;
  icon: IconType;
  section: SettingsSection;
  /** One-line caption under the label. */
  note?: string;
}

/**
 * A nav entry that owns its own menu. Selecting it swaps the sidebar's list
 * for `items` instead of only navigating — recursive, so a group may itself
 * contain groups.
 */
export interface NavGroup {
  key: string;
  label: string;
  icon: IconType;
  /** Route prefix the group owns; any section at or under it opens the menu. */
  match: string;
  /** Section entered when the group is selected. */
  section: SettingsSection;
  /** Caption under the title in the group's menu header. */
  description: string;
  items: NavEntry[];
}

export type NavEntry = NavItem | NavGroup;

export interface NavSection {
  key: string;
  /** Rendered as an uppercase eyebrow; omit for a hairline-separated group. */
  label?: string;
  items: NavEntry[];
}

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return "items" in entry;
}

export function labelFor(entry: NavEntry): string {
  if (isNavGroup(entry)) return entry.label;
  return entry.label ?? SETTINGS_SECTIONS[entry.section];
}

/* ------------------------------ the tree ------------------------------- */

export const SETTINGS_NAV: NavSection[] = [
  {
    key: "browser",
    label: "Browser",
    items: [
      {
        key: "general",
        icon: Settings,
        section: "",
        note: "New tab page, archiving",
      },
      {
        key: "appearance",
        icon: Palette,
        section: "appearance",
        note: "Colors, translucency",
      },
      {
        key: "favorites",
        icon: Star,
        section: "favorites",
        note: "The tile row under ⌘L",
      },
      {
        key: "voice",
        icon: Volume2,
        section: "voice",
        note: "Read-aloud voice, playback",
      },
      {
        key: "assistant",
        icon: Sparkles,
        section: "assistant",
        note: "Chat model, browser tools",
      },
      {
        key: "voice-assistant",
        icon: Mic,
        section: "voice-assistant",
        note: "Wake word, hands-free control",
      },
    ],
  },
  {
    key: "privacy",
    label: "Privacy",
    items: [
      {
        key: "privacy",
        icon: ShieldCheck,
        label: "Privacy & security",
        match: "privacy",
        section: "privacy",
        description: "Sign-in, history, egress, audit",
        items: [
          { key: "signin", icon: KeyRound, section: "privacy" },
          { key: "history", icon: Clock, section: "privacy/history" },
          { key: "egress", icon: Globe, section: "privacy/egress" },
          { key: "audit", icon: ScrollText, section: "privacy/audit" },
        ],
      },
      {
        key: "nostr",
        icon: Zap,
        section: "nostr",
        note: "Signing key, site permissions",
      },
      {
        key: "account",
        icon: User,
        label: "Account",
        match: "account",
        section: "account",
        description: "Identity, devices, keys",
        items: [
          { key: "you", icon: User, section: "account" },
          { key: "devices", icon: Laptop, section: "account/devices" },
          { key: "sync", icon: RefreshCw, section: "account/sync" },
          {
            key: "recovery",
            icon: LifeBuoy,
            section: "account/recovery",
          },
        ],
      },
    ],
  },
  {
    key: "workspace",
    label: "Workspace",
    items: [
      {
        key: "import",
        icon: Import,
        section: "import",
        label: "Import & migrate",
        note: "Chrome or Arc",
      },
    ],
  },
  {
    key: "app",
    items: [
      {
        key: "about",
        icon: Info,
        section: "about",
        note: "Version, updates",
      },
    ],
  },
];
