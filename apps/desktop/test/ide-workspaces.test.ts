import { describe, expect, it } from "vitest";
import {
  dropIdeBuffer,
  getIdeBuffer,
  ideWorkspaceKey,
  moveIdeBuffers,
  restoreIdeWorkspaceView,
  setIdeBuffer,
  stashIdeWorkspaceView,
  type IdeWorkspaceView,
} from "../src/renderer/src/lib/ide";

describe("IDE workspace isolation", () => {
  it("keeps the same relative path separate across spaces and machines", () => {
    const local = ideWorkspaceKey("sim", "space-a", "local");
    const cloud = ideWorkspaceKey("remote", "space-b", "cloud");
    setIdeBuffer(local, "README.md", { saved: "a", current: "local edit" });
    setIdeBuffer(cloud, "README.md", { saved: "b", current: "cloud edit" });

    expect(getIdeBuffer(local, "README.md")?.current).toBe("local edit");
    expect(getIdeBuffer(cloud, "README.md")?.current).toBe("cloud edit");
    expect(ideWorkspaceKey("sim", "space-a", "cloud")).not.toBe(local);
    dropIdeBuffer(local, "README.md");
    expect(getIdeBuffer(local, "README.md")).toBeUndefined();
    expect(getIdeBuffer(cloud, "README.md")?.current).toBe("cloud edit");
  });

  it("re-keys buffers when the initial machine source is announced", () => {
    const unknown = ideWorkspaceKey(null, "space-c", "local");
    const announced = ideWorkspaceKey("sim", "space-c", "local");
    const buffer = { saved: "before", current: "unsaved" };
    setIdeBuffer(unknown, "src/app.ts", buffer);

    moveIdeBuffers(unknown, announced, ["src/app.ts"]);

    expect(getIdeBuffer(unknown, "src/app.ts")).toBeUndefined();
    expect(getIdeBuffer(announced, "src/app.ts")).toBe(buffer);
  });

  it("restores independent tab views without leaking mutable state", () => {
    const first = ideWorkspaceKey("sim", "space-d", "local");
    const view: IdeWorkspaceView = {
      openFiles: ["one.ts"],
      activeFile: "one.ts",
      dirty: { "one.ts": true },
    };
    stashIdeWorkspaceView(first, view);
    view.openFiles.push("mutated.ts");
    view.dirty["mutated.ts"] = true;

    const restored = restoreIdeWorkspaceView(first);
    expect(restored).toEqual({
      openFiles: ["one.ts"],
      activeFile: "one.ts",
      dirty: { "one.ts": true },
    });
    restored.openFiles.push("also-mutated.ts");
    expect(restoreIdeWorkspaceView(first).openFiles).toEqual(["one.ts"]);
  });
});
