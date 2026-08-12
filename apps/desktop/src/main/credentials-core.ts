/**
 * Pure 1Password-CLI bridge logic (PRD §8.1 credential ship-blocker, option
 * 1): op argv construction, host matching over `op item list` JSON, field
 * parsing, and fill-script generation. No spawning, no Electron — unit tests
 * exercise this directly; credentials.ts owns the processes.
 */

import type { CredentialItem } from "../shared/ipc";

export const OP_VERSION_ARGS: readonly string[] = ["--version"];

/**
 * `op item list` has no host filter server-side; the JSON list is filtered
 * client-side per lookup and NEVER stored (§8.1).
 */
export const OP_LIST_ARGS: readonly string[] = [
  "item",
  "list",
  "--categories",
  "Login",
  "--format",
  "json",
];

export function opGetArgs(itemId: string): string[] {
  return [
    "item",
    "get",
    itemId,
    "--fields",
    "label=username,label=password",
    "--reveal",
    "--format",
    "json",
  ];
}

const MAX_RESULTS = 20;

function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function hostFromHref(href: string): string | null {
  try {
    return normalizeHost(new URL(href).hostname);
  } catch {
    // op stores bare domains too ("example.com")
    const bare = href.toLowerCase().split("/")[0] ?? "";
    return /^[a-z0-9.-]+$/.test(bare) && bare.includes(".") ? normalizeHost(bare) : null;
  }
}

function hostsRelated(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

interface OpItemSummary {
  id: string;
  title: string;
  urls?: Array<{ href?: string }>;
  additional_information?: string;
}

function isOpItem(value: unknown): value is OpItemSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OpItemSummary).id === "string" &&
    typeof (value as OpItemSummary).title === "string"
  );
}

/** Filter+shape `op item list --format json` output for one host. */
export function credentialItemsForHost(itemsJson: unknown, host: string): CredentialItem[] {
  if (!Array.isArray(itemsJson)) return [];
  const target = normalizeHost(host);
  const out: CredentialItem[] = [];
  for (const raw of itemsJson as unknown[]) {
    if (!isOpItem(raw)) continue;
    const hrefs = Array.isArray(raw.urls) ? raw.urls : [];
    const matches = hrefs.some((entry) => {
      if (typeof entry?.href !== "string") return false;
      const itemHost = hostFromHref(entry.href);
      return itemHost !== null && hostsRelated(target, itemHost);
    });
    if (!matches) continue;
    out.push({
      id: raw.id,
      title: raw.title,
      username: typeof raw.additional_information === "string" ? raw.additional_information : "",
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** Parse `op item get --fields … --format json` (array of field objects). */
export function parseOpFields(json: unknown): { username: string; password: string } | null {
  if (!Array.isArray(json)) return null;
  let username = "";
  let password = "";
  for (const raw of json as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const field = raw as { label?: unknown; id?: unknown; value?: unknown };
    const label = typeof field.label === "string" ? field.label : String(field.id ?? "");
    if (typeof field.value !== "string") continue;
    if (label === "username") username = field.value;
    if (label === "password") password = field.value;
  }
  return password === "" ? null : { username, password };
}

/**
 * JS injected into the tab to fill the focused login form: find the password
 * input (prefer the focused one) and its form's username/email input, set
 * values through the native setter (so framework-controlled inputs see the
 * change), and dispatch input/change events. Values are embedded via
 * JSON.stringify — never string interpolation. Best-effort automation; the
 * native-messaging/SDK integration is the eventual path (§8.1).
 */
export function buildFillScript(username: string, password: string): string {
  return `(() => {
  const u = ${JSON.stringify(username)};
  const p = ${JSON.stringify(password)};
  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const active = document.activeElement;
  const pw = active instanceof HTMLInputElement && active.type === "password"
    ? active
    : document.querySelector('input[type="password"]');
  if (!(pw instanceof HTMLInputElement)) return false;
  const scope = pw.form || document;
  const user = scope.querySelector(
    'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[type="text"]',
  );
  if (user instanceof HTMLInputElement && u) setValue(user, u);
  setValue(pw, p);
  return true;
})();`;
}
