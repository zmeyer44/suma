# Gala

Gala is the web control surface for Suma's external assistant. It contains the
public product site, operator sign-in, and the authenticated `/home` console for
channel, browser, capability, and runtime-policy settings.

## Run locally

```sh
pnpm --filter @suma/gala dev
```

The app listens on `http://localhost:3001`. The public landing page works
without configuration. Sign-in fails closed until these variables are present:

| Variable                   | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `GALA_AUTH_SECRET`         | At least 32 characters; signs the seven-day HttpOnly session cookie. |
| `GALA_ADMIN_EMAIL`         | Email address for the initial single-workspace operator.             |
| `GALA_ADMIN_PASSWORD_HASH` | A scrypt hash encoded as `<salt>:<64-byte-base64url-hash>`.          |

The dashboard currently persists non-secret settings as a versioned browser
draft. It intentionally does not accept or retain bot tokens. The next
connection step is to give Gala a first-class Suma web identity, then replace
the draft adapter with the existing control-plane channel and assistant-policy
routes. The UI calls this state out rather than implying that a draft is live.

## Verify

```sh
pnpm --filter @suma/gala test
pnpm --filter @suma/gala check-types
pnpm --filter @suma/gala lint
pnpm --filter @suma/gala build
```

The browser journey is in `e2e/gala.spec.ts`. It requires the three auth
variables above and runs with:

```sh
pnpm exec playwright test e2e/gala.spec.ts
```
