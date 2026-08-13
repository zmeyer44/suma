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
4. **Touch ID passkeys are OFF in shipped builds for now** — learned the hard
   way in 0.0.2: `keychain-access-groups` is a *restricted* entitlement, and
   a Developer ID app carrying it without an embedded provisioning profile is
   killed by AMFI at spawn ("Launchd job spawn failed", POSIX error 163) on
   every launch. Notarization does not catch it; the app passes `spctl` and
   still won't start. The entitlement is deliberately absent from
   `build/entitlements.mac.plist`. To enable passkeys later:
   - Portal → Identifiers: register `com.sumabrowser.app`; Profiles: create a
     **Developer ID** provisioning profile for it (Account Holder only).
   - Wire it via `mac.provisioningProfile` in `electron-builder.prod.yml`
     and re-add `keychain-access-groups` =
     `<TEAM_ID>.com.sumabrowser.app.webauthn` to the entitlements.
   - Bake the team id into the build (webauthn-policy.ts currently reads
     `SUMA_APPLE_TEAM_ID` from the runtime env, which no user machine has —
     it must become a build-time constant for the plan to report passkeys
     available).

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
# Bump the version first — electron-builder tags the GitHub release v<version>
# and electron-updater compares against it, so shipping the same version twice
# is a no-op for existing installs.
#   edit apps/desktop/package.json "version"

pnpm --filter @suma/desktop dist:mac:prod    # build only, publish nothing
```

This runs `electron-vite build`, packages with the hardened runtime and
entitlements, signs every binary with the Developer ID identity, submits to
Apple's notary service, and staples the ticket. Notarization typically takes
1–15 minutes; electron-builder waits. Output in `apps/desktop/dist/`:

- `Suma-<version>-arm64.dmg` — what people download from the site
- `Suma-<version>-arm64-mac.zip` (+ `.blockmap`) — what the auto-updater
  consumes (Squirrel.Mac updates from a zip, never a dmg)
- `latest-mac.yml` — the update feed manifest pointing at the zip

If the Widevine step (§2) is in play, note that `castlabs_evs.vmp sign-pkg`
re-signs the already-packaged `.app` — the dmg/zip built *before* that step
don't contain the VMP signature. Run the VMP signing from an electron-builder
`afterSign` hook instead, so the artifacts (and therefore every auto-update)
carry it.

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

## 5. Publish — GitHub Releases is the update feed

Releases live on the public `zmeyer44/suma` repo: `electron-builder.yml`'s
`publish` block is baked into the app as `app-update.yml`, so every packaged
build knows to look there. Because the repo is public, running apps need no
token to check or download.

```sh
export GH_TOKEN=<a token with repo scope on zmeyer44/suma>
pnpm --filter @suma/desktop release:mac
```

Same build as §3, then uploads the dmg, zip, blockmap, and `latest-mac.yml`
to a **draft** GitHub release tagged `v<version>`. Drafts are invisible to
the updater — installed apps see nothing until the release is published, so:

1. Verify the draft's assets (all four files present).
2. Drag-install the dmg on a clean machine, run §4's checks.
3. Publish the release on GitHub. Within four hours (or on their next
   launch, or via Suma menu → Check for Updates…) every install downloads it
   in the background and swaps it in on quit. Settings → About & updates
   shows the cycle and offers "Restart to update".

Then point the marketing site at the new dmg: set
`SUMA_MAC_DMG_URL=https://github.com/zmeyer44/suma/releases/download/v<version>/Suma-<version>-arm64.dmg`
in the `apps/www` deployment. The `/download` button follows
`/download/macos`, which 302s to that URL (falls back to `public/downloads/`
for local dev).

### How the auto-update works (and its edges)

- The client is `electron-updater` in main
  (`apps/desktop/src/main/updates/update-service.ts`): check ~20s after
  launch and every 4h, download silently, install on quit; the About page
  and the app menu are the only UI. macOS updates require the app to be
  Developer ID-signed — the unsigned `dist:mac` build reports "This build
  isn't signed for automatic updates" and that is correct behavior.
- **Installs that predate the updater** (anything ≤ 0.1.0) have no updater
  to run — those users must download the next dmg by hand once. Every
  install from then on self-updates.
- **Staged rollout**: after publishing, you can edit `latest-mac.yml` on the
  release to add `stagingPercentage: 10` — electron-updater rolls the dice
  per install. Raise it as confidence grows.
- **Rollback**: publishing a new release with a higher version is the only
  rollback path — installs never downgrade (`allowDowngrade` is off).

## Regenerating the DMG art

The SVG sources are committed (`build/icon.svg`, `build/background.svg`);
the rasters they produce are gitignored and must be regenerated on a fresh
clone before packaging:

- App icon: `node apps/desktop/scripts/build-icons.mjs` (rasterizes
  `build/icon.svg` — the site mark from `apps/www/public/mark.svg` refit to
  the macOS icon grid — into `icon.png` + `icon.icns`; needs ImageMagick)
- Installer background, deterministic path (used for 0.0.1):
  `rsvg-convert -w 1320 -h 800 build/background.svg -o build/background@2x.png`
  then `magick build/background@2x.png -resize 660x400 build/background.png`
  (`brew install librsvg imagemagick`)
- Installer background, AI path (the original art direction):
  `apps/desktop/scripts/generate-dmg-background.mjs`
  (needs `AI_GATEWAY_API_KEY`; writes `build/background.png` + `@2x`)
