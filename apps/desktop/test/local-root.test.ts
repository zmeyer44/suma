import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSimRoot } from "../src/main/compute/local-root";

const saved = process.env["SUMA_WORKSPACE_ROOT"];

afterEach(() => {
  if (saved === undefined) delete process.env["SUMA_WORKSPACE_ROOT"];
  else process.env["SUMA_WORKSPACE_ROOT"] = saved;
});

describe("resolveSimRoot", () => {
  it("SUMA_WORKSPACE_ROOT wins over everything", () => {
    process.env["SUMA_WORKSPACE_ROOT"] = "/tmp/override";
    expect(resolveSimRoot(true, "local")).toBe("/tmp/override");
    expect(resolveSimRoot(false, null)).toBe("/tmp/override");
  });

  it("local mode roots at ~/Suma, packaged or not", () => {
    delete process.env["SUMA_WORKSPACE_ROOT"];
    const suma = path.join(os.homedir(), "Suma");
    expect(resolveSimRoot(true, "local")).toBe(suma);
    expect(resolveSimRoot(false, "local")).toBe(suma);
  });

  it("dev runs sit in the project; packaged unknown-mode falls to ~/Suma, never bare homedir", () => {
    delete process.env["SUMA_WORKSPACE_ROOT"];
    expect(resolveSimRoot(false, null)).toBe(process.cwd());
    expect(resolveSimRoot(true, null)).toBe(path.join(os.homedir(), "Suma"));
    expect(resolveSimRoot(true, "cloud")).toBe(path.join(os.homedir(), "Suma"));
  });
});
