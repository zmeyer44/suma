import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SpaceMeta } from "@suma/protocol";
import { WorkspaceStore } from "../src/main/workspace-store";
import { SpaceManager } from "../src/main/spaces";

/**
 * Space fragmentation fix (§8.8): repeated fresh launches each minted a
 * throwaway "Personal", splitting synced cookies across look-alike spaces.
 * These cover the deletion primitive (tombstone that propagates) and the
 * reconcile that drops this device's unused default once the account's real
 * spaces sync in.
 */

function tmpStore(): WorkspaceStore {
  return new WorkspaceStore(
    path.join(tmpdir(), `suma-space-${randomUUID()}`, "workspace.json"),
    "device-test",
  );
}

function pin(spaceId: string, id: string) {
  return { id, spaceId, url: `https://example.com/${id}`, title: id, position: 0 };
}

describe("WorkspaceStore.removeSpace", () => {
  it("removes the space and tombstones it (publishes a null doc that propagates)", () => {
    const store = tmpStore();
    const meta: SpaceMeta = {
      id: "s1",
      name: "Personal",
      color: "#fff",
      position: 0,
      egressPolicy: "direct",
      createdAtMs: 1,
    };
    store.upsertSpace(meta);
    store.upsertPin(pin("s1", "p1"));
    expect(store.spaces()).toHaveLength(1);

    store.removeSpace("s1");
    expect(store.spaces()).toHaveLength(0);
    // Its pins go too, so nothing orphaned resurrects the space.
    expect(store.pinsFor("s1")).toHaveLength(0);

    // The removal is a tombstone: a peer applying the null space doc drops the
    // space rather than re-adding it — that is what makes the cleanup converge
    // across devices instead of a peer re-publishing the space back.
    const peer = tmpStore();
    peer.upsertSpace(meta);
    expect(peer.spaces()).toHaveLength(1);
    peer.applyRemoteDoc("space:s1", null, { physicalMs: 2, logical: 0, deviceId: "x" });
    expect(peer.spaces()).toHaveLength(0);
  });
});

describe("SpaceManager", () => {
  it("auto-creates exactly one default when the store is empty", () => {
    const store = tmpStore();
    const spaces = new SpaceManager(store);
    expect(spaces.list()).toHaveLength(1);
    expect(spaces.list()[0]?.name).toBe("Personal");
    expect(spaces.activeSpaceId).toBe(spaces.list()[0]?.id);
  });

  it("reconcileAfterSync drops the throwaway default once account spaces arrive", () => {
    const store = tmpStore();
    const spaces = new SpaceManager(store); // creates the throwaway default

    // The account's real space syncs in (as a remote workspace doc would).
    store.upsertSpace({
      id: "real",
      name: "Personal",
      color: "#fff",
      position: 1,
      egressPolicy: "direct",
      createdAtMs: 5,
    });
    store.upsertPin(pin("real", "p1")); // the real space has content

    spaces.reconcileAfterSync();

    const ids = spaces.list().map((s) => s.id);
    expect(ids).toEqual(["real"]); // the empty default is gone
    expect(spaces.activeSpaceId).toBe("real"); // and we're moved onto the real one
  });

  it("reconcileAfterSync keeps the default if it was actually used (has pins)", () => {
    const store = tmpStore();
    const spaces = new SpaceManager(store);
    const defaultId = spaces.list()[0]!.id;
    store.upsertPin(pin(defaultId, "p1")); // user pinned something in it
    store.upsertSpace({
      id: "other",
      name: "Work",
      color: "#000",
      position: 1,
      egressPolicy: "direct",
      createdAtMs: 5,
    });

    spaces.reconcileAfterSync();
    expect(spaces.list().map((s) => s.id).sort()).toEqual([defaultId, "other"].sort());
  });

  it("remove refuses to delete the last remaining space", () => {
    const store = tmpStore();
    const spaces = new SpaceManager(store);
    const only = spaces.list()[0]!.id;
    expect(() => spaces.remove(only)).toThrow(/last space/);
    expect(spaces.list()).toHaveLength(1);
  });
});
