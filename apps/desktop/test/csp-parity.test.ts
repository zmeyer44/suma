import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_CSP } from "../src/main/privileged";

/**
 * The dev-injected CSP header and the production meta CSP in index.html
 * intersect at runtime, so any divergence between them is either dead policy
 * or a dev/prod fidelity gap (a source dev allows but prod blocks, or the
 * reverse). This locks them together: change one, change both.
 */
describe("dev CSP header matches the production meta CSP", () => {
  it("is byte-identical to the meta in renderer/index.html", () => {
    const html = readFileSync(
      path.resolve(__dirname, "../src/renderer/index.html"),
      "utf8",
    );
    const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
      html,
    );
    expect(match).not.toBeNull();
    expect(DEV_CSP).toBe(match?.[1]);
  });
});
