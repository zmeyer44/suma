import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDbFromUrl } from "./db/client.js";
import { ensureSchema } from "./db/migrate.js";
import { getSigningKeys } from "./keys-provider.js";
import { RelayRegistry } from "./relay.js";
import { attachRelay } from "./relay-server.js";
import { inferenceOptionsFromEnv } from "./inference.js";
import { inviteOptionsFromEnv } from "./invites.js";
import { envHubNotifier } from "./revocation.js";
import { startOutboxDrain } from "./outbox.js";
import { objectStoreFromEnv } from "./providers/object-store.js";
import { flySandboxFromEnv } from "./providers/fly.js";
import { StubSandboxProvider } from "./providers/sandbox.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is required. Set a Postgres URL, or "pglite" for an embedded ' +
      "local-dev database (`pnpm dev` sets that default).",
  );
}
const port = Number(process.env["PORT"] ?? 8787);

const db = await createDbFromUrl(databaseUrl);
await ensureSchema(db);

// Throws when R2 credentials are absent (§8.6): a control plane that accepted
// uploads it cannot store would report success for files that do not exist.
const objects = objectStoreFromEnv(process.env);

// Retry any revocations whose hub notification failed, so a revoked device's
// live sockets are eventually closed even across a control-plane restart (§8.2).
startOutboxDrain(db, envHubNotifier(process.env));

// Compute plane: Fly Machines when FLY_API_TOKEN is configured, otherwise
// the recording stub — provisioning "succeeds" without creating anything,
// which is fine for dev and useless in production, so say which one is live.
const flySandbox = flySandboxFromEnv(process.env);
const sandbox = flySandbox ?? new StubSandboxProvider();
console.log(
  flySandbox === null
    ? "compute: stub sandbox provider (FLY_API_TOKEN unset — no VMs will be created)"
    : "compute: Fly Machines provider",
);

// Vended inference: closed without an upstream key, so say which it is.
const inference = inferenceOptionsFromEnv(process.env);
console.log(
  inference.apiKey === null
    ? "inference: disabled (AI_GATEWAY_API_KEY unset — clients bring their own keys)"
    : `inference: vending via ${inference.upstreamUrl} (${inference.dailyRequestCap} requests/user/day)`,
);
console.log(
  inference.voiceApiKey === null
    ? "voice: disabled (GEMINI_API_KEY unset — clients bring their own keys)"
    : `voice: vending Live ephemeral tokens via ${inference.voiceUpstreamUrl}`,
);

// Home-machine relay (local compute mode): in-memory presence + piping —
// single-instance by design, see src/relay.ts.
const relay = new RelayRegistry();

// §11: invitation-only beta. The gate defaults ON here — a deployed control
// plane refuses uninvited signups unless SUMA_INVITES_REQUIRED=0 is set
// explicitly (local dev sets it in dev-server.ts).
const server = serve({
  fetch: createApp(
    db,
    sandbox,
    undefined,
    undefined,
    objects,
    inviteOptionsFromEnv(process.env),
    inference,
    relay,
  ).fetch,
  port,
});
// The WS relay needs the raw node:http server for its `upgrade` listener —
// @hono/node-server returns it, typed loosely.
attachRelay(server as import("node:http").Server, {
  db,
  registry: relay,
  getSigning: () => getSigningKeys(process.env),
});
console.log(`@suma/control listening on :${port} (relay: /v1/relay/*)`);
