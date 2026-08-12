/**
 * Window-open policy (PRD §8.1 "pop-up/window behavior").
 *
 * Pure — imported by unit tests; no Electron here.
 *
 * Suma must distinguish three very different things a page can mean by
 * `window.open`:
 *
 *  - **An auth ceremony.** OAuth and WebAuthn flows open a popup, then talk to
 *    it through the live `window.opener` handle: they `postMessage` the code
 *    back, or poll `popup.closed`, or read `popup.location` after the redirect.
 *    Denying the open (or silently substituting a tab) hands the page a `null`
 *    handle, and every mainstream OAuth client library treats that as
 *    "popup blocked" — it either throws immediately or hangs forever waiting
 *    for a message that can never arrive. These MUST become real popups.
 *  - **A normal new page.** `target="_blank"`, "open in new tab" — Arc turns
 *    these into tabs in the current space, and so do we.
 *  - **Junk.** Popunders and popup floods, denied and rate-limited.
 *
 * Classification never depends on the *opener's* origin, only on what is
 * being opened and how, so a login page hosted anywhere still works.
 */

/** Registrable domains whose pages are auth ceremonies wherever they appear. */
const AUTH_HOST_SUFFIXES: ReadonlyArray<string> = [
  "accounts.google.com",
  "oauth2.googleapis.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
  "login.microsoft.com",
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "slack.com",
  "auth0.com",
  "okta.com",
  "oktapreview.com",
  "onelogin.com",
  "duosecurity.com",
  "workos.com",
  "clerk.accounts.dev",
  "stytch.com",
  "facebook.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "discord.com",
  "atlassian.com",
  "id.atlassian.com",
  "amazon.com",
  "amazoncognito.com",
  "salesforce.com",
  "zoom.us",
  "notion.so",
  "figma.com",
  "linear.app",
];

/**
 * Path shapes used by OAuth 2.0 / OIDC / SAML endpoints. Matched
 * case-insensitively against the pathname of ANY origin, so self-hosted and
 * white-labelled identity providers are covered too.
 */
const AUTH_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/oauth2?(\/|$)/,
  /\/oauth2?\/authorize/,
  /\/authorize(\/|$)/,
  /\/connect\/authorize/,
  /\/sso(\/|$)/,
  /\/saml(\/|$)/,
  /\/openid(\/|$)/,
  /\/\.well-known\/openid/,
  /\/signin(\/|$)/,
  /\/sign-in(\/|$)/,
  /\/login(\/|$)/,
  /\/auth(\/|$)/,
  /\/session\/new/,
  /\/webauthn(\/|$)/,
  /\/passkey/,
  /\/mfa(\/|$)/,
  /\/2fa(\/|$)/,
  /\/verify(\/|$)/,
];

/** Query parameters that only appear in an OAuth/OIDC authorization request. */
const AUTH_QUERY_KEYS: ReadonlyArray<string> = [
  "client_id",
  "response_type",
  "redirect_uri",
  "code_challenge",
  "id_token_hint",
  "saml_request",
  "samlrequest",
];

export type PopupDisposition = "popup" | "tab" | "glance" | "deny";

/** The subset of Electron's window-open details the policy needs. */
export interface WindowOpenRequest {
  url: string;
  /** Electron's disposition: `new-window` when features were supplied. */
  disposition: string;
  /** Raw `window.open` features string ("width=500,height=600,..."). */
  features: string;
  /**
   * True when the OPENER is a pinned tab. Pinned tabs are anchors — Arc's
   * "Peek" rule: a link opened from one previews in a glance instead of
   * piling a new tab next to the pin.
   */
  openerPinned?: boolean;
}

export interface PopupDecision {
  disposition: PopupDisposition;
  /** Why — surfaced in logs and the denied-popup toast. */
  reason: string;
  /** Present when disposition is "popup": the window size to request. */
  size?: { width: number; height: number };
}

/** Popup geometry, clamped so a hostile page cannot request a 1×1 popunder
 * or a window larger than the shell it came from. */
const MIN_POPUP_WIDTH = 320;
const MIN_POPUP_HEIGHT = 320;
const MAX_POPUP_WIDTH = 1200;
const MAX_POPUP_HEIGHT = 1000;
/** Sized for the Google/Apple/Microsoft consent screens, which assume ~500×640. */
export const DEFAULT_POPUP_WIDTH = 520;
export const DEFAULT_POPUP_HEIGHT = 680;

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * True when the URL is an authentication ceremony — the flows that genuinely
 * need a live `window.opener` and must never be turned into a tab.
 */
export function isAuthFlowUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (AUTH_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix))) {
    // A known identity host still has non-auth pages (github.com/user/repo);
    // require an auth-shaped path or OAuth query parameters there.
    if (AUTH_PATH_PATTERNS.some((re) => re.test(path))) return true;
    if (hasAuthQuery(parsed)) return true;
    // Bare identity hosts (accounts.google.com, appleid.apple.com) exist only
    // to authenticate.
    return host.startsWith("accounts.") || host.startsWith("login.") || host.startsWith("appleid.");
  }
  if (AUTH_PATH_PATTERNS.some((re) => re.test(path)) && hasAuthQuery(parsed)) return true;
  return hasAuthQuery(parsed) && path.length > 1;
}

function hasAuthQuery(parsed: URL): boolean {
  for (const key of parsed.searchParams.keys()) {
    if (AUTH_QUERY_KEYS.includes(key.toLowerCase())) return true;
  }
  return false;
}

/** Parse `window.open` features into the requested popup size, if any. */
export function parseFeatureSize(features: string): { width?: number; height?: number } {
  const out: { width?: number; height?: number } = {};
  for (const part of features.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    if (rawKey === undefined || rawValue === undefined) continue;
    const key = rawKey.trim().toLowerCase();
    const value = Number.parseInt(rawValue.trim(), 10);
    if (Number.isNaN(value)) continue;
    if (key === "width" || key === "innerwidth") out.width = value;
    if (key === "height" || key === "innerheight") out.height = value;
  }
  return out;
}

function clampSize(requested: { width?: number; height?: number }): {
  width: number;
  height: number;
} {
  const width = requested.width ?? DEFAULT_POPUP_WIDTH;
  const height = requested.height ?? DEFAULT_POPUP_HEIGHT;
  return {
    width: Math.min(Math.max(width, MIN_POPUP_WIDTH), MAX_POPUP_WIDTH),
    height: Math.min(Math.max(height, MIN_POPUP_HEIGHT), MAX_POPUP_HEIGHT),
  };
}

/**
 * Decide what a window-open request becomes. `isAllowedUrl` is injected so
 * this module stays free of the tab-policy import cycle.
 */
export function classifyWindowOpen(
  request: WindowOpenRequest,
  isAllowedUrl: (url: string) => boolean,
): PopupDecision {
  if (!isAllowedUrl(request.url)) {
    return { disposition: "deny", reason: "protocol not allowed in a tab or popup" };
  }
  // A page opening a blank window scripts its content afterwards; there is no
  // URL to judge and no auth flow that needs it. Arc drops these too.
  if (request.url === "about:blank" || request.url === "") {
    return { disposition: "deny", reason: "blank popup" };
  }

  const featureSize = parseFeatureSize(request.features);

  if (isAuthFlowUrl(request.url)) {
    return {
      disposition: "popup",
      reason: "authentication flow needs a live window.opener",
      size: clampSize(featureSize),
    };
  }
  // Chromium reports `new-window` for two very different things: a scripted
  // `window.open` that passed popup features (`width=…`, `popup=1` — always a
  // non-empty features string), and the USER's shift+click on a link, which
  // carries no features at all. The first is a deliberate popup (payment
  // sheet, share dialog); the second is the Glance gesture — preview the
  // link in a floating page over the current tab (Zen's Glance). Plain
  // `window.open(url)` and `target="_blank"` clicks both arrive as
  // `foreground-tab` and become tabs, which is the Arc behavior. Measured
  // against Electron 43; do not infer this from the features string alone,
  // since `popup=1` carries no dimensions.
  if (request.disposition === "new-window") {
    if (request.features.trim() === "") {
      return {
        disposition: "glance",
        reason: "shift-clicked link previews in a glance",
      };
    }
    return {
      disposition: "popup",
      reason: "page requested a popup window",
      size: clampSize(featureSize),
    };
  }
  // Arc's Peek: a pinned tab is an anchor, so a link it opens in the
  // foreground previews in a glance rather than adding a tab beside the pin.
  // A cmd+click (`background-tab`) is a deliberate "give me a tab, quietly"
  // and stays one even from a pin.
  if (request.openerPinned === true && request.disposition === "foreground-tab") {
    return {
      disposition: "glance",
      reason: "link from a pinned tab previews in a glance",
    };
  }
  return { disposition: "tab", reason: "ordinary new page" };
}
