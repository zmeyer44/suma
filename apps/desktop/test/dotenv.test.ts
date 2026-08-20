import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/main/env";

describe("loadDotEnv", () => {
  it("fills only unset keys from the nearest .env", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "suma-dotenv-"));
    writeFileSync(path.join(dir, ".env"), "A=from-file\nB=from-file\n");
    const env: NodeJS.ProcessEnv = { A: "from-shell" };
    loadDotEnv(dir, env);
    expect(env["A"]).toBe("from-shell");
    expect(env["B"]).toBe("from-file");
  });

  it("loads nothing when SUMA_NO_DOTENV=1", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "suma-dotenv-"));
    writeFileSync(path.join(dir, ".env"), "A=from-file\n");
    const env: NodeJS.ProcessEnv = { SUMA_NO_DOTENV: "1" };
    loadDotEnv(dir, env);
    expect(env["A"]).toBeUndefined();
  });
});
