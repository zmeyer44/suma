# Releasing Suma for macOS — signed + notarized DMG

The dev build (`pnpm --filter @suma/desktop dist:mac`) is deliberately
unsigned: Gatekeeper warns, Touch ID passkeys stay off, Widevine is absent.
This runbook produces the real thing. Config lives in
`apps/desktop/electron-builder.prod.yml` (which extends the base
`electron-builder.yml`); entitlements in `apps/desktop/build/entitlements.mac.plist`.

## 0. One-time prerequisites

1. **Apple Developer Program** membership ($99/yr) for the org, and the
   **Team ID** (10 chars, e.g. `ABCDE12345`) from
   [developer.apple.com/account](https://developer.apple.com/account) → Membership.
2. **Developer ID Application certificate** — this is what signs apps
   distributed *outside* the App Store:
   - Easiest: Xcode → Settings → Accounts → your team → Manage Certificates →
     "+" → **Developer ID Application**. It lands in the login keychain.
   - Or via the portal: Certificates → "+" → Developer ID Application, with a
     CSR from Keychain Access.
   - For CI, export it from Keychain Access as a password-protected `.p12`.
3. **Notarization credentials** — an App Store Connect **API key** is the
   maintainable option (no 2FA prompts): App Store Connect → Users and Access
   → Integrations → App Store Connect API → Team Keys → "+", role
   **Developer**. Download the `.p8` once, note the **Key ID** and **Issuer
   ID**. (Alternative: an Apple ID + app-specific password, below.)
4. The keychain access group in `build/entitlements.mac.plist` must resolve to
   `<TEAM_ID>.com.sumabrowser.app.webauthn` — the plist uses
   `$(AppIdentifierPrefix)`; verify it expanded after the first signed build
   (step 4) and hardcode the team id prefix if it did not.

## 1. Environment for the release shell

```sh
# Signing — skip both if the Developer ID cert is in the login keychain;
# electron-builder auto-discovers it there.
export CSC_LINK=/path/to/developer-id.p12     # or base64 of it
export CSC_KEY_PASSWORD='p12 passphrase'

# Notarization (API key path)
export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Notarization (Apple ID alternative — instead of the three above)
# export APPLE_ID=you@company.com
# export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx   # appleid.apple.com → App-Specific Passwords
# export APPLE_TEAM_ID=ABCDE12345

# Runtime team id used by the passkey plan (webauthn.ts) — also needed at
# build time only if you script the entitlements substitution.
export SUMA_APPLE_TEAM_ID=ABCDE12345
```

## 2. Widevine (castLabs ECS) — required for DRM playback

Stock Electron has no Widevine. Production uses the castLabs **ECS** fork
plus their **EVS** (VMP signing) service:

1. Swap the dependency in `apps/desktop/package.json`:
   `"electron": "npm:@castlabs/electron-releases@43.x.y+wvcus"` (match the
   Electron 43 line), then `pnpm install`.
2. `pip install castlabs-evs` and create an account once:
   `python3 -m castlabs_evs.account signup`.
3. After electron-builder signs the app (step 3), VMP-sign it:
   `python3 -m castlabs_evs.vmp sign-pkg apps/desktop/dist/mac-arm64/Suma.app`
   — EVS re-signs the Widevine bits so the CDM attests as a verified media
   path. `com.apple.security.cs.disable-library-validation` in the
   entitlements is what lets the Google-signed CDM load at all.

A first signed release without DRM can skip this section.

## 3. Build

```sh
pnpm --filter @suma/desktop dist:mac:prod
```

This runs `electron-vite build`, packages with the hardened runtime and
entitlements, signs every binary with the Developer ID identity, submits to
Apple's notary service, and staples the ticket. Notarization typically takes
1–15 minutes; electron-builder waits. Output:
`apps/desktop/dist/Suma-<version>-arm64.dmg`.

## 4. Verify before shipping

```sh
APP=apps/desktop/dist/mac-arm64/Suma.app

codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vv "$APP"                          # want: "accepted · Notarized Developer ID"
xcrun stapler validate "$APP"
codesign -d --entitlements - "$APP" | grep webauthn   # group must show your real team id

# Then the disk image itself: mount, drag-install on a clean machine (or a
# fresh macOS VM), launch — no Gatekeeper dialog beyond the standard
# "downloaded from the internet" first-open prompt.
```

If the webauthn grep prints a literal `$(AppIdentifierPrefix)`, edit
`build/entitlements.mac.plist` to the explicit
`ABCDE12345.com.sumabrowser.app.webauthn` form and rebuild — Touch ID
passkeys silently fail without the resolved group (docs/auth-flows.md).

## 5. Publish

Upload the DMG wherever releases live and point the marketing site at it:
set `SUMA_MAC_DMG_URL=https://…/Suma-<version>-arm64.dmg` in the `apps/www`
deployment. The `/download` button follows `/download/macos`, which 302s to
that URL (falls back to `public/downloads/` for local dev).

## Regenerating the DMG art

- App icon: `apps/desktop/scripts/build-icons.mjs`
- Installer background: `apps/desktop/scripts/generate-dmg-background.mjs`
  (needs `AI_GATEWAY_API_KEY`; writes `build/background.png` + `@2x`)
