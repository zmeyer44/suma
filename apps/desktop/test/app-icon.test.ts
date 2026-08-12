import path from "node:path";
import { describe, expect, it } from "vitest";
import { appIconCandidates, resolveAppIcon } from "../src/main/app-icon";

describe("app icon discovery", () => {
  it("looks in build/ beside the built main bundle", () => {
    const candidates = appIconCandidates(
      "/repo/apps/desktop/out/main",
      "/app/Resources",
    );
    expect(candidates).toContain("/repo/apps/desktop/build/icon.png");
    expect(candidates).toContain("/app/Resources/icon.png");
  });

  it("has no packaged candidate when there are no resources", () => {
    expect(appIconCandidates("/repo/apps/desktop/out/main")).toEqual([
      "/repo/apps/desktop/build/icon.png",
    ]);
  });

  it("returns null rather than a path that isn't there", () => {
    expect(resolveAppIcon(["/nope/icon.png"])).toBeNull();
  });

  /**
   * The committed raster, found through the same path a dev run walks. This is
   * the assertion that actually catches the icon being moved or renamed — the
   * candidate list above would still pass while the dock showed Electron's
   * default.
   */
  it("finds the committed icon from the dev main-bundle path", () => {
    const found = resolveAppIcon(
      appIconCandidates(path.resolve(process.cwd(), "out/main")),
    );
    expect(found).toBe(path.resolve(process.cwd(), "build/icon.png"));
  });
});
