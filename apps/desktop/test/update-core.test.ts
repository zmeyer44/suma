import { describe, expect, it } from "vitest";
import { initialUpdateState, type UpdateState } from "../src/shared/updates";
import { reduceUpdate, type UpdateEvent } from "../src/main/updates/update-core";

const T0 = 1_755_000_000_000;

function run(state: UpdateState, ...events: UpdateEvent[]): UpdateState {
  return events.reduce(reduceUpdate, state);
}

describe("update-core", () => {
  it("walks the happy path: check → download → ready", () => {
    let s = initialUpdateState("0.1.0", true);
    expect(s.phase).toBe("idle");
    expect(s.checkedAt).toBeNull();

    s = run(
      s,
      { kind: "checking" },
      { kind: "available", version: "0.2.0" },
      { kind: "progress", percent: 41.5 },
    );
    expect(s.phase).toBe("downloading");
    expect(s.availableVersion).toBe("0.2.0");
    expect(s.percent).toBe(41.5);

    s = reduceUpdate(s, { kind: "downloaded", version: "0.2.0", at: T0 });
    expect(s.phase).toBe("ready");
    expect(s.percent).toBeNull();
    expect(s.checkedAt).toBe(T0);
    // The running version is unchanged until the restart.
    expect(s.currentVersion).toBe("0.1.0");
  });

  it("records an up-to-date check as idle + checkedAt", () => {
    const s = run(
      initialUpdateState("0.1.0", true),
      { kind: "checking" },
      { kind: "not-available", at: T0 },
    );
    expect(s.phase).toBe("idle");
    expect(s.checkedAt).toBe(T0);
    expect(s.availableVersion).toBeNull();
  });

  it("never un-stages a downloaded update on later failures", () => {
    const ready = run(
      initialUpdateState("0.1.0", true),
      { kind: "available", version: "0.2.0" },
      { kind: "downloaded", version: "0.2.0", at: T0 },
    );

    // A periodic re-check fails offline: the staged build must stay staged.
    const afterError = run(
      ready,
      { kind: "checking" },
      { kind: "error", message: "net::ERR_INTERNET_DISCONNECTED" },
    );
    expect(afterError.phase).toBe("ready");
    expect(afterError.availableVersion).toBe("0.2.0");
    expect(afterError.error).toBeNull();

    // And a re-check that re-finds the same version changes nothing.
    expect(reduceUpdate(ready, { kind: "available", version: "0.2.0" })).toBe(
      ready,
    );

    // A "nothing newer" answer only refreshes the check timestamp.
    const reChecked = reduceUpdate(ready, { kind: "not-available", at: T0 + 1 });
    expect(reChecked.phase).toBe("ready");
    expect(reChecked.checkedAt).toBe(T0 + 1);
  });

  it("lets a newer version supersede a staged one", () => {
    const s = run(
      initialUpdateState("0.1.0", true),
      { kind: "available", version: "0.2.0" },
      { kind: "downloaded", version: "0.2.0", at: T0 },
      { kind: "available", version: "0.3.0" },
    );
    expect(s.phase).toBe("downloading");
    expect(s.availableVersion).toBe("0.3.0");
    expect(s.percent).toBe(0);
  });

  it("clears an error on the next check and reports errors readably", () => {
    const failed = run(
      initialUpdateState("0.1.0", true),
      { kind: "checking" },
      { kind: "error", message: "boom" },
    );
    expect(failed.phase).toBe("error");
    expect(failed.error).toBe("boom");

    const retried = reduceUpdate(failed, { kind: "checking" });
    expect(retried.phase).toBe("checking");
    expect(retried.error).toBeNull();
  });

  it("clamps progress and ignores it outside a download", () => {
    const downloading = run(
      initialUpdateState("0.1.0", true),
      { kind: "available", version: "0.2.0" },
    );
    expect(reduceUpdate(downloading, { kind: "progress", percent: 250 }).percent).toBe(100);
    expect(reduceUpdate(downloading, { kind: "progress", percent: -4 }).percent).toBe(0);

    const idle = initialUpdateState("0.1.0", true);
    expect(reduceUpdate(idle, { kind: "progress", percent: 50 })).toBe(idle);
  });

  it("keeps unsupported terminal — dev builds never leave it", () => {
    const dev = initialUpdateState("0.1.0", false);
    expect(dev.phase).toBe("unsupported");
    const after = run(
      dev,
      { kind: "checking" },
      { kind: "available", version: "9.9.9" },
      { kind: "downloaded", version: "9.9.9", at: T0 },
      { kind: "error", message: "boom" },
    );
    expect(after).toBe(dev);
  });
});
