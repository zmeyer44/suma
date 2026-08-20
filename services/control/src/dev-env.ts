/**
 * Selective repo-root .env adoption for the LOCAL dev server only.
 *
 * `pnpm dev` at the repo root reaches this workspace through turbo, which
 * does not load .env files — and neither does tsx. Without FLY_API_TOKEN the
 * server silently selects the stub sandbox provider, so a cloud-mode account
 * gets machine rows stuck in "provisioning" with no agentAddress and the
 * desktop shows "Connecting to your computer…" forever. Adopting the
 * compute-plane keys here makes a bare root `pnpm dev` provision real VMs.
 *
 * Only the allowlist below is adopted, and only for keys the real
 * environment leaves unset. DATABASE_URL is deliberately NOT on it: the root
 * .env's value points at Railway's internal hostname, unreachable from a
 * laptop — dev must keep falling back to the embedded pglite. server.ts (the
 * production entry) never runs this and still fails closed on missing env.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Compute-plane wiring a local dev control plane needs to create real VMs. */
export const ADOPTED_ENV_KEYS = [
  "FLY_API_TOKEN",
  "FLY_ORG_SLUG",
  "FLY_COMPUTE_IMAGE",
  "FLY_AGENT_PUBLIC",
  "FLY_COMPUTE_APP_PREFIX",
] as const;

/** KEY=VALUE per line; `#` comments; optional `export ` prefix; matching
 *  single/double quotes stripped (mirrors apps/desktop main/env.ts — the
 *  quoted-value handling matters: a quoted token adopted verbatim would keep
 *  its quotes and fail upstream auth in confusing ways). */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (match === null) continue;
    const key = match[1] ?? "";
    let value = (match[2] ?? "").trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    result[key] = value;
  }
  return result;
}

/**
 * Fill unset allowlisted keys in `env` from parsed .env text. Returns the
 * keys adopted, for the boot log. The real environment always wins.
 */
export function adoptComputeEnv(
  dotEnvText: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const parsed = parseDotEnv(dotEnvText);
  const adopted: string[] = [];
  for (const key of ADOPTED_ENV_KEYS) {
    const value = parsed[key];
    if (env[key] === undefined && value !== undefined && value !== "") {
      env[key] = value;
      adopted.push(key);
    }
  }
  return adopted;
}

/** Nearest .env walking up from `startDir`, or null when none exists. */
export function findDotEnv(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) return file;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Locate, parse, and adopt in one step; silent when no .env exists. */
export function adoptComputeEnvFromDisk(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; adopted: string[] } | null {
  const file = findDotEnv(startDir);
  if (file === null) return null;
  try {
    return { file, adopted: adoptComputeEnv(readFileSync(file, "utf8"), env) };
  } catch {
    return null;
  }
}
