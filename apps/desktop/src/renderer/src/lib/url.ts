/**
 * URL-vs-search heuristics for the sidebar field and command bar. Pure —
 * unit-tested in vitest's node environment.
 */

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const INTERNAL_RE = /^(about|suma):/i;
const LOCALHOST_RE = /^localhost(:\d+)?([/?#]|$)/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/;
const DOMAIN_RE = /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i;

export function isProbablyUrl(raw: string): boolean {
  const input = raw.trim();
  if (input.length === 0 || input.includes(" ")) return false;
  return (
    SCHEME_RE.test(input) ||
    INTERNAL_RE.test(input) ||
    LOCALHOST_RE.test(input) ||
    IPV4_RE.test(input) ||
    DOMAIN_RE.test(input)
  );
}

/** Turns raw omnibox input into a navigable URL, falling back to a web search. */
export function normalizeUrlInput(raw: string): string {
  const input = raw.trim();
  if (SCHEME_RE.test(input) || INTERNAL_RE.test(input)) return input;
  if (LOCALHOST_RE.test(input) || IPV4_RE.test(input)) return `http://${input}`;
  if (isProbablyUrl(input)) return `https://${input}`;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/** Hostname of a URL, or "" when unparsable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Compact display form: strip scheme, www. and trailing slash. */
export function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}
