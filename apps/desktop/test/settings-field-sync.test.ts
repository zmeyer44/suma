import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Hlc, WorkspaceDoc } from "@suma/protocol";
import { decideMerge, type IncomingWorkspaceDoc } from "../src/main/sync/workspace-map";
import { WorkspaceStore } from "../src/main/workspace-store";

/**
 * §8.2 beta gate: settings sync must never let a concurrent edit to one field
 * revert another, and keyMode (a visible security state) must change ONLY when
 * keyMode itself was written. These exercise the real WorkspaceStore through
 * its per-field LWW registers and the production decideMerge path.
 */

function tmpStore(deviceId: string): WorkspaceStore {
  return new WorkspaceStore(
    path.join(tmpdir(), `suma-ws-${randomUUID()}`, "workspace.json"),
    deviceId,
  );
}

/** A remote (device-a) HLC — far-future physical time makes it a clear winner. */
function remoteHlc(physicalMs: number): Hlc {
  return { physicalMs, logical: 0, deviceId: "device-a" };
}

const FUTURE = Date.now() + 1_000_000;

/** Merge remote docs exactly as WorkspaceSyncService.handleRemoteDocs does. */
function applyRemote(store: WorkspaceStore, incoming: IncomingWorkspaceDoc[]): void {
  const decision = decideMerge(store.lwwRegisters(), incoming);
  for (const doc of [...decision.apply, ...decision.adoptHlc]) {
    store.applyRemoteDoc(doc.key, doc.value, doc.hlc);
  }
}

const autoArchiveDoc = (hours: number): WorkspaceDoc => ({
  kind: "settings",
  field: "autoArchive",
  autoArchiveAfterHours: hours,
});

describe("per-field settings sync (§8.2)", () => {
  it("device A editing autoArchive does NOT revert device B's concurrent historySync edit", () => {
    const store = tmpStore("device-b");
    store.updateSettings({ historySyncEnabled: true });

    // Device B published only the field it touched.
    expect(Object.keys(store.lwwRegisters())).toEqual(["settings:historySync"]);

    // Device A's concurrent (and even newer) autoArchive edit lands.
    applyRemote(store, [
      { key: "settings:autoArchive", value: autoArchiveDoc(24), hlc: remoteHlc(FUTURE) },
    ]);

    const settings = store.settings();
    expect(settings.historySyncEnabled).toBe(true); // preserved, not clobbered
    expect(settings.autoArchiveAfterHours).toBe(24); // converged independently
    expect(settings.keyMode).toBe("e2ee"); // untouched
  });

  it("keyMode never changes unless keyMode itself was the field set", () => {
    const store = tmpStore("device-b");
    expect(store.settings().keyMode).toBe("e2ee");

    // No amount of newer edits to OTHER fields can move keyMode.
    applyRemote(store, [
      {
        key: "settings:historySync",
        value: { kind: "settings", field: "historySync", historySyncEnabled: true },
        hlc: remoteHlc(FUTURE),
      },
      { key: "settings:autoArchive", value: autoArchiveDoc(1), hlc: remoteHlc(FUTURE) },
    ]);
    expect(store.settings().keyMode).toBe("e2ee");

    // Only a keyMode doc flips keyMode — and it is visible, never silent.
    applyRemote(store, [
      {
        key: "settings:keyMode",
        value: { kind: "settings", field: "keyMode", keyMode: "suma-managed" },
        hlc: remoteHlc(FUTURE + 1),
      },
    ]);
    expect(store.settings().keyMode).toBe("suma-managed");
    // The other fields the earlier docs set are still intact.
    expect(store.settings().historySyncEnabled).toBe(true);
    expect(store.settings().autoArchiveAfterHours).toBe(1);
  });

  it("gates each field independently on its own HLC (older dropped, newer applied)", () => {
    const store = tmpStore("device-b");
    store.updateSettings({ autoArchiveAfterHours: 6 });

    // An older remote autoArchive is dropped — the local edit stands.
    applyRemote(store, [{ key: "settings:autoArchive", value: autoArchiveDoc(99), hlc: remoteHlc(1) }]);
    expect(store.settings().autoArchiveAfterHours).toBe(6);

    // A newer one wins.
    applyRemote(store, [
      { key: "settings:autoArchive", value: autoArchiveDoc(48), hlc: remoteHlc(FUTURE) },
    ]);
    expect(store.settings().autoArchiveAfterHours).toBe(48);
  });

  it("converges the new-tab page on its own register", () => {
    const store = tmpStore("device-b");
    expect(store.settings().newTabUrl).toBe("https://www.google.com");

    store.updateSettings({ newTabUrl: "https://example.com/start" });
    expect(Object.keys(store.lwwRegisters())).toEqual(["settings:newTabUrl"]);

    applyRemote(store, [
      {
        key: "settings:newTabUrl",
        value: { kind: "settings", field: "newTabUrl", newTabUrl: "https://duck.com" },
        hlc: remoteHlc(FUTURE),
      },
    ]);
    expect(store.settings().newTabUrl).toBe("https://duck.com");
    // Nothing else moved with it.
    expect(store.settings().keyMode).toBe("e2ee");
    expect(store.settings().historySyncEnabled).toBe(false);
  });

  it("records only the fields updateSettings actually changed", () => {
    const store = tmpStore("device-b");
    store.updateSettings({ autoArchiveAfterHours: 3 });
    expect(Object.keys(store.lwwRegisters())).toEqual(["settings:autoArchive"]);

    store.updateSettings({ keyMode: "suma-managed" });
    expect(Object.keys(store.lwwRegisters()).sort()).toEqual([
      "settings:autoArchive",
      "settings:keyMode",
    ]);
  });

  it("suppresses settings echoes: a newer remote doc equal to local state applies nothing", () => {
    const store = tmpStore("device-b");
    store.updateSettings({ historySyncEnabled: true });
    const decision = decideMerge(store.lwwRegisters(), [
      {
        key: "settings:historySync",
        value: { kind: "settings", field: "historySync", historySyncEnabled: true },
        hlc: remoteHlc(FUTURE),
      },
    ]);
    expect(decision.apply).toHaveLength(0);
    expect(decision.adoptHlc).toHaveLength(1);
  });
});
