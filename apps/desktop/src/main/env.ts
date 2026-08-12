/**
 * Development .env loading.
 *
 * Nothing in the stack loads .env files into the main process: electron-vite
 * only exposes MAIN_VITE_-prefixed vars through import.meta.env, and turbo
 * passes through only its allowlist. Keys like AI_GATEWAY_API_KEY, set in the
 * repo-root .env for local testing, would silently never arrive. This walks
 * up from the app directory, parses every .env it finds on the way to the
 * filesystem root, and fills ONLY variables that are not already set — the
 * real environment always wins, and the nearest file wins over ancestors.
 *
 * In a packaged build there is no .env anywhere above the app bundle, so this
 * is a cheap no-op.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** KEY=VALUE per line; `#` comments; optional `export ` prefix; matching
 *  single/double quotes stripped. Anything else is skipped, never an error. */
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
      // An unquoted value may carry a trailing comment.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    result[key] = value;
  }
  return result;
}

/** Load .env files from `startDir` upward into `env`, never overwriting. */
export function loadDotEnv(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  let dir = path.resolve(startDir);
  // Nearest-first: a value set by apps/desktop/.env must not be replaced by
  // the repo root's, and neither replaces the real environment.
  for (;;) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) {
      try {
        const parsed = parseDotEnv(readFileSync(file, "utf8"));
        for (const [key, value] of Object.entries(parsed)) {
          if (env[key] === undefined) env[key] = value;
        }
      } catch {
        // Unreadable .env — behave as if it were absent.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
