#!/usr/bin/env node
/**
 * dev:cloud — run the desktop app in dev mode as a faithful preview of the
 * shipped build, against the real hosted planes.
 *
 * Production desktops need zero configuration: the packaged default control
 * URL (PROD_CONTROL_URL) is the single root, and the hub, session gateway,
 * agent address, and vended inference all cascade from /v1/me and
 * /v1/machine. This script reproduces that from a dev checkout:
 *
 *   - builds @suma/files so suma://files serves the same bundle a packaged
 *     app ships in <resources>/files
 *   - points SUMA_CONTROL_URL at the hosted control plane (a dev run is
 *     otherwise local-only)
 *   - uses a dedicated SUMA_USER_DATA profile, because a profile that once
 *     enrolled elsewhere keeps its persisted controlUrl forever
 *     (auth-service.ts: enrollment.controlUrl wins over the env var)
 *   - drops the plane-pinning vars (SUMA_HUB_URL etc.) that would bypass
 *     discovery, and the AI/TTS key vars that would put chat/voice/TTS on
 *     the bring-your-own-key path instead of the vended proxy real users get
 *   - sets SUMA_NO_DOTENV=1 so the repo-root .env can't reintroduce them
 *
 * Still not previewable in dev mode, by construction: Touch ID passkeys
 * (unsigned build), Widevine (stock Electron, not castLabs), auto-update,
 * and the empty SHELL/PATH a Finder launch gets. For those, use dist:mac.
 */

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROD_CONTROL_URL = "https://api.sumabrowser.com";

// Each of these pins a plane and defeats the /v1/me + /v1/machine discovery
// chain production uses (docs/deployment.md warns against exactly this).
const PINNING_VARS = [
  "SUMA_HUB_URL",
  "SUMA_SESSION_GATEWAY_URL",
  "SUMA_SESSION_GATEWAY_DEV_TOKEN",
  "SUMA_AGENT_URL",
  "SUMA_EGRESS_URL",
  "SUMA_WORKSPACE_ROOT",
  "SUMA_SAVES_MODEL",
];

// Present in the environment, these move chat/voice/TTS onto the env-key
// path (chat-service.ts GATEWAY_ENV_KEYS, tts-core.ts TTS_KEY_ENV_VARS) —
// production users only ever get "stored" or "vended".
const CREDENTIAL_VARS = [
  "AI_GATEWAY_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "SUMA_VERCEL_GATEWAY_API_KEY",
  "VERCEL_GATEWAY_API_KEY",
  "GEMINI_API_KEY",
  "SUMA_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "SUMA_ELEVENLABS_API_KEY",
  "ELEVENLABS_API_KEY",
  "SUMA_BLAND_API_KEY",
  "BLAND_API_KEY",
];

function defaultProfileDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Suma Dev Cloud");
  }
  return path.join(os.homedir(), ".suma-dev-cloud");
}

// suma://files must serve the same bundle a packaged app would.
const filesBuild = spawnSync("pnpm", ["--filter", "@suma/files", "build"], {
  cwd: appDir,
  stdio: "inherit",
});
if (filesBuild.status !== 0) {
  console.error("dev:cloud: @suma/files build failed — aborting.");
  process.exit(filesBuild.status ?? 1);
}

const env = { ...process.env };

const dropped = [...PINNING_VARS, ...CREDENTIAL_VARS].filter((key) => {
  if (env[key] === undefined) return false;
  delete env[key];
  return true;
});

env.SUMA_NO_DOTENV = "1";
env.SUMA_CONTROL_URL ??= PROD_CONTROL_URL;
env.SUMA_USER_DATA ??= defaultProfileDir();

console.log(`dev:cloud: control plane ${env.SUMA_CONTROL_URL}`);
console.log(`dev:cloud: profile ${env.SUMA_USER_DATA}`);
if (dropped.length > 0) {
  console.log(`dev:cloud: dropped from environment: ${dropped.join(", ")}`);
}

const child = spawn("pnpm", ["exec", "electron-vite", "dev"], {
  cwd: appDir,
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("close", (code) => process.exit(code ?? 0));
