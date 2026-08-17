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
    expect(resolveSimRoot()).toBe("/tmp/override");
  });

  it("resolves a relative SUMA_WORKSPACE_ROOT to an absolute path", () => {
    process.env["SUMA_WORKSPACE_ROOT"] = "some/rel";
    expect(resolveSimRoot()).toBe(path.resolve("some/rel"));
  });

  it("roots at ~/Suma everywhere with no override — dev included, never the repo cwd", () => {
    delete process.env["SUMA_WORKSPACE_ROOT"];
    const suma = path.join(os.homedir(), "Suma");
    expect(resolveSimRoot()).toBe(suma);
    // Regression guard: a dev run used to sit in process.cwd().
    expect(resolveSimRoot()).not.toBe(process.cwd());
  });

  it("treats an empty override as unset", () => {
    process.env["SUMA_WORKSPACE_ROOT"] = "";
    expect(resolveSimRoot()).toBe(path.join(os.homedir(), "Suma"));
  });
});
