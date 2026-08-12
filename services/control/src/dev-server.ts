/**
 * Local-dev entry (`pnpm dev`). Fills in defaults for the backing services a
 * developer has no local copy of — Neon and R2 — then boots the real server.
 *
 * The defaults live here, not in `server.ts`, on purpose: a production boot
 * runs `server.ts`, where a missing `DATABASE_URL` or absent R2 credentials
 * still fail closed rather than silently degrading to a database on local disk
 * and a chunk store that forgets every upload on restart (§8.6).
 *
 * `??=` throughout: a real `DATABASE_URL` or R2 credential in the environment
 * always wins, so pointing dev at a branch database stays a one-liner.
 */

process.env["DATABASE_URL"] ??= "pglite";
// Leave a configured bucket alone; `objectStoreFromEnv` reports partial R2
// config better than a guess here would.
if (process.env["R2_BUCKET"] === undefined) process.env["OBJECT_STORE"] ??= "stub";
// Local dev signs up freely; a DEPLOYED control plane keeps the §11 invite
// gate, which defaults on in server.ts.
process.env["SUMA_INVITES_REQUIRED"] ??= "0";

await import("./server.js");
