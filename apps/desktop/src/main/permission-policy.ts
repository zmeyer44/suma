/**
 * Permission policy for site content (PRD §8.1 permission-UI baseline).
 * Pure — imported by unit tests; no Electron here.
 *
 * The v0 handler denied everything except camera/mic/screen-share. That is
 * too blunt for a daily driver, and two of the silent denials break sign-in
 * outright:
 *
 *  - **`storage-access` / `top-level-storage-access`** — the Storage Access
 *    API. With third-party cookies restricted, federated sign-in ("Continue
 *    with Google") and embedded identity iframes call
 *    `document.requestStorageAccess()` and cannot complete the handshake if
 *    it is refused. Chromium only surfaces the request after a user gesture
 *    on a site the user has interacted with, so honoring it is both required
 *    and safe.
 *  - **`clipboard-sanitized-write`** — every "copy your backup/recovery code"
 *    button in an MFA enrollment flow.
 *
 * Everything else keeps failing closed: unknown permissions, geolocation,
 * MIDI, notifications, and `openExternal` (which would hand arbitrary URLs to
 * other applications) stay denied in v0.
 */

/** Granted without prompting — required for auth flows, low risk. */
const AUTO_GRANT: ReadonlySet<string> = new Set([
  "storage-access",
  "top-level-storage-access",
  "clipboard-sanitized-write",
  // A WebAuthn ceremony or OAuth consent screen legitimately goes fullscreen
  // on some providers; the user can always escape it.
  "fullscreen",
]);

/** Granted only after an explicit user decision, remembered per origin. */
const PROMPTED: ReadonlySet<string> = new Set(["media", "display-capture"]);

export type PermissionOutcome = "grant" | "deny" | "prompt";

/**
 * Decide a permission request. `fromTabInSpace` is false when the request did
 * not come from a live tab of the space that owns the session — a request we
 * cannot attribute is always denied.
 */
export function classifyPermission(permission: string, fromTabInSpace: boolean): PermissionOutcome {
  if (!fromTabInSpace) return "deny";
  if (AUTO_GRANT.has(permission)) return "grant";
  if (PROMPTED.has(permission)) return "prompt";
  return "deny";
}

/** Human phrasing for the prompted permissions. */
export function permissionPromptText(permission: string): string {
  return permission === "display-capture"
    ? "share your screen"
    : "use your camera and microphone";
}
