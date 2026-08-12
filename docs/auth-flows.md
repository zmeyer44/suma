# Sign-in flows: popups and passkeys

How Suma handles OAuth popups and WebAuthn/passkey ceremonies, what works
today, and what a build must do for passkeys to work at all. Related PRD
sections: §4 (continuity modes), §8.1 (daily-driver baseline: password/passkey
autofill, pop-up/window behavior), §8.8 (spaces are the cookie-jar boundary).

## OAuth popups

### The failure this replaces

The shell answered every `window.open` with `{ action: "deny" }` and opened a
tab instead. That is invisible to a link click but fatal to OAuth: the calling
page gets `null` where it expected a window handle, so it cannot `postMessage`
the authorization code back, cannot poll `popup.closed`, and cannot read the
redirected location. Client libraries report this as "popup blocked" or hang.

Measured in Electron 43 with a two-origin harness (opener on one port, identity
provider on another), sandboxed opener, per-space partition:

| Handler                     | Result                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `{ action: "deny" }` (old)  | `handle=NULL`, no message ever arrives → timeout                                                   |
| `{ action: "allow" }` (now) | `handle=OBJECT`, `message=code=…`, `origin` matches, `closed=true`, popup shares the space session |

### What Suma does now

`src/main/popup-policy.ts` classifies each request into **popup**, **tab**, or
**deny**:

- **popup** — the URL is an authentication ceremony (known identity hosts, or
  OAuth/OIDC/SAML path shapes together with OAuth query parameters), or
  Chromium reported disposition `new-window`, meaning the page passed popup
  features. Created for real by `src/main/popups.ts` with the opener
  relationship intact and **the opener's own space session**, so the cookies
  the ceremony sets land in the jar the tab reads.
- **tab** — everything else. Bare `window.open(url)`, `target="_blank"` clicks,
  and `noopener` opens all arrive as `foreground-tab` and become tabs in the
  current space, which is the Arc behavior.
- **deny** — non-http(s) schemes (`suma://`, `file://`, `javascript:`) and
  blank popups. Denials are rate-limited per source tab and surface as a toast
  rather than failing silently.

Popup windows are small, centered, parented to the shell, and titled with the
**live origin** — anti-phishing signal during a consent screen; the page cannot
override it. An auth popup can open another classified auth popup while keeping
the full `window.opener` chain intact. This covers identity flows that use an
intermediate "One moment please..." window before opening the provider. Every
window in the chain shares the space session and the source tab's rate limit.
They close with their opener and when their opener tab closes.

### Known limitation

Tabs are `WebContentsView`s, not Chromium-created windows, so a request routed
to a tab returns `null` to the page rather than a `WindowProxy`. Pages that
open a _non-auth_ window and then inspect the handle (typically popup-blocker
detection) will see it as blocked. Auth flows — the ones that genuinely need
the handle — are classified as popups and are unaffected. Removing this
limitation entirely would mean making every `window.open` a real window, which
trades one broken behavior for a worse one.

## Permissions that sign-in depends on

The permission handler used to deny everything except camera/mic/screen. Two of
those denials broke sign-in and are now granted to attributable tab or popup
requests (`src/main/permission-policy.ts`):

- **`storage-access` / `top-level-storage-access`** — the Storage Access API.
  With third-party cookies restricted, federated sign-in and embedded identity
  iframes call `document.requestStorageAccess()` and cannot complete the
  handshake if refused. Chromium only surfaces the request after a user gesture
  on a site the user has interacted with.
- **`clipboard-sanitized-write`** — "copy your backup code" in MFA enrollment.

Camera, mic, and screen share still prompt once per origin and remember the
decision. Everything else — geolocation, notifications, MIDI, `openExternal`,
unknown permissions — still fails closed.

## Passkeys (WebAuthn)

### Why they did not work

Electron had no browser-side WebAuthn implementation on macOS until
`app.configureWebAuthn({ touchID })` shipped (merged April 2026, backported to
Electron 41/42). Suma was pinned to Electron 35, where
`navigator.credentials.get()` cannot be serviced by a platform authenticator at
all. Electron's own documentation is explicit: until `configureWebAuthn` is
called, `isUserVerifyingPlatformAuthenticatorAvailable()` resolves to `false`
and platform-authenticator requests are not serviced.

The desktop app is now on Electron 43 and calls `configureWebAuthn` at
bootstrap when the build can actually support it.

### What a build must do

Touch ID credentials live in a **keychain access group**, and macOS honors the
group only if it appears in the signed app's entitlement. All three must agree:

1. `app.configureWebAuthn({ touchID: { keychainAccessGroup } })` — the group is
   derived at runtime as `<TEAM_ID>.<BUNDLE_ID>.webauthn` from
   `SUMA_APPLE_TEAM_ID` and `SUMA_BUNDLE_ID`.
2. `apps/desktop/build/entitlements.mac.plist` — `keychain-access-groups` must
   contain the same value (it uses `$(AppIdentifierPrefix)` so the team id is
   not duplicated).
3. The app must be **code-signed** with that entitlement.

`src/main/webauthn-policy.ts` decides support at runtime and reports it rather
than letting a ceremony fail with an opaque `NotAllowedError`:

| Status                 | When                                                     | Shown as      |
| ---------------------- | -------------------------------------------------------- | ------------- |
| `available`            | Signed macOS build, team id present, runtime has the API | "Ready"       |
| `unsigned-build`       | `electron-vite dev` or no team id                        | "Dev build"   |
| `unsupported-platform` | Not macOS, or Electron without `configureWebAuthn`       | "Unavailable" |

**A development run cannot do Touch ID passkeys**, no matter what the code
does. That is a signing fact, not a bug, and Settings says so.

### Device-bound, not synced

Secure-Enclave credentials created this way are **bound to the Mac that created
them and are not synced through iCloud Keychain**, and they require a Secure
Enclave (Apple silicon, or Intel with T2). In §4 terms a passkey enrolled in
Suma is **Device-bound**: another Mac enrolls its own. Suma must not imply
a passkey follows the user between machines — the settings copy states this
plainly.

### The account picker

When a discoverable-credential request matches several passkeys, Electron
fires `select-webauthn-account` and **the ceremony stays pending until
something answers it**. Electron ships no UI, so Suma renders its own picker
(`src/renderer/src/components/PasskeyPicker.tsx`). The overlay is load-bearing:
dismissing it cancels the sign-in, and never answering would hang the page.
Every path — choice, cancel, escape, backdrop click, 2-minute timeout, app
quit — resolves the callback exactly once. A single matching credential skips
the picker so the ceremony stays at one Touch ID prompt.
