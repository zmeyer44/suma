/**
 * Dev-only compute-env adoption (src/dev-env.ts): a bare root `pnpm dev`
 * must hand the dev control plane its Fly credentials, and must NEVER adopt
 * DATABASE_URL — the root .env's value is Railway-internal, and adopting it
 * would break the pglite fallback that keeps local accounts on disk.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adoptComputeEnv,
  findDotEnv,
  parseDotEnv,
} from "../src/dev-env.js";

describe("parseDotEnv", () => {
  it("parses assignments, strips quotes, skips comments", () => {
    const parsed = parseDotEnv(
      [
        "# comment",
        "PLAIN=value",
        'QUOTED="FlyV1 fm2_abc,fm2_def"',
        "SINGLE='sq'",
        "export EXPORTED=yes",
        "TRAILING=value # note",
        "not a line",
        "",
      ].join("\n"),
    );
    expect(parsed["PLAIN"]).toBe("value");
    // Quoted values must lose their quotes: a token adopted with quotes
    // intact fails upstream auth in ways that only surface at the Fly API.
    expect(parsed["QUOTED"]).toBe("FlyV1 fm2_abc,fm2_def");
    expect(parsed["SINGLE"]).toBe("sq");
    expect(parsed["EXPORTED"]).toBe("yes");
    expect(parsed["TRAILING"]).toBe("value");
    expect(Object.keys(parsed)).toHaveLength(5);
  });
});

describe("adoptComputeEnv", () => {
  const dotEnv = [
    'FLY_API_TOKEN="FlyV1 fm2_secret"',
    "FLY_ORG_SLUG=personal",
    "FLY_AGENT_PUBLIC=1",
    "DATABASE_URL=postgresql://user:pw@postgres.railway.internal:5432/railway",
    "R2_ACCESS_KEY_ID=nope",
  ].join("\n");

  it("fills unset allowlisted keys and reports them", () => {
    const env: NodeJS.ProcessEnv = {};
    const adopted = adoptComputeEnv(dotEnv, env);
    expect(adopted).toEqual([
      "FLY_API_TOKEN",
      "FLY_ORG_SLUG",
      "FLY_AGENT_PUBLIC",
    ]);
    expect(env["FLY_API_TOKEN"]).toBe("FlyV1 fm2_secret");
    expect(env["FLY_AGENT_PUBLIC"]).toBe("1");
  });

  it("never adopts keys off the allowlist — DATABASE_URL stays pglite-able", () => {
    const env: NodeJS.ProcessEnv = {};
    adoptComputeEnv(dotEnv, env);
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["R2_ACCESS_KEY_ID"]).toBeUndefined();
  });

  it("lets the real environment win and skips empty values", () => {
    const env: NodeJS.ProcessEnv = { FLY_API_TOKEN: "from-shell" };
    const adopted = adoptComputeEnv(
      "FLY_API_TOKEN=from-file\nFLY_ORG_SLUG=\n",
      env,
    );
    expect(env["FLY_API_TOKEN"]).toBe("from-shell");
    expect(adopted).toEqual([]);
    expect(env["FLY_ORG_SLUG"]).toBeUndefined();
  });
});

describe("findDotEnv", () => {
  it("returns the nearest .env walking upward", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dev-env-"));
    const nested = path.join(root, "services", "control", "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, ".env"), "FLY_ORG_SLUG=root\n");
    expect(findDotEnv(nested)).toBe(path.join(root, ".env"));
    // Nearest wins over ancestors.
    writeFileSync(
      path.join(root, "services", "control", ".env"),
      "FLY_ORG_SLUG=near\n",
    );
    expect(findDotEnv(nested)).toBe(
      path.join(root, "services", "control", ".env"),
    );
  });
});
