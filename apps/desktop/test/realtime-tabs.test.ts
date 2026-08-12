import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Hlc, WorkspaceDoc } from "@suma/protocol";
import { decideMerge, type IncomingWorkspaceDoc } from "../src/main/sync/workspace-map";
import { rankForTabInsertion } from "../src/main/tabs";
import {
  resetWorkspaceHlc,
  WorkspaceStore,
  type SyncedTabState,
} from "../src/main/workspace-store";

function store(deviceId = "device-a"): WorkspaceStore {
  return new WorkspaceStore(
    path.join(tmpdir(), `suma-realtime-tabs-${randomUUID()}`, "workspace.json"),
    deviceId,
  );
}

function tab(id: string, rank: string, url = `https://example.com/${id}`): SyncedTabState {
  return { id, spaceId: "space-1", createdAtMs: 1, url, rank };
}

function hlc(physicalMs: number, deviceId = "device-b"): Hlc {
  return { physicalMs, logical: 0, deviceId };
}

function applyRemote(target: WorkspaceStore, incoming: IncomingWorkspaceDoc[]): void {
  const decision = decideMerge(target.lwwRegisters(), incoming);
  for (const doc of [...decision.apply, ...decision.adoptHlc]) {
    target.applyRemoteDoc(doc.key, doc.value, doc.hlc);
  }
}

beforeEach(() => resetWorkspaceHlc());

describe("realtime tab registers", () => {
  it("stores presence, URL, and order independently and publishes creation as one batch", () => {
    const target = store();
    const changed: string[][] = [];
    target.onDocsChanged((keys) => changed.push(keys));

    target.openSyncedTab(tab("one", "0"));

    expect(Object.keys(target.lwwRegisters()).sort()).toEqual([
      "tab:one:order",
      "tab:one:presence",
      "tab:one:url",
    ]);
    expect(changed).toEqual([
      ["tab:one:presence", "tab:one:url", "tab:one:order"],
    ]);
    expect(target.syncedTabsFor("space-1")).toEqual([tab("one", "0")]);
  });

  it("merges a concurrent navigation and reorder without either field being lost", () => {
    const target = store("device-a");
    target.openSyncedTab(tab("one", "0", "https://example.com/start"));
    target.updateSyncedTabUrl("one", "https://example.com/from-a");

    const remoteOrder: WorkspaceDoc = {
      kind: "tabOrder",
      tab: { tabId: "one", spaceId: "space-1", rank: "99" },
    };
    applyRemote(target, [
      { key: "tab:one:order", value: remoteOrder, hlc: hlc(Date.now() + 10_000) },
    ]);

    expect(target.syncedTabsFor("space-1")).toEqual([
      tab("one", "99", "https://example.com/from-a"),
    ]);
  });

  it("uses HLC for simultaneous edits to one field while preserving other fields", () => {
    const target = store("device-a");
    target.openSyncedTab(tab("one", "7", "https://example.com/local"));
    const winner: WorkspaceDoc = {
      kind: "tabUrl",
      tab: { tabId: "one", url: "https://example.com/remote" },
    };
    applyRemote(target, [
      { key: "tab:one:url", value: winner, hlc: hlc(Date.now() + 10_000) },
    ]);

    expect(target.syncedTabsFor("space-1")).toEqual([
      tab("one", "7", "https://example.com/remote"),
    ]);
  });

  it("makes a close tombstone authoritative over later URL/order delivery", () => {
    const target = store();
    target.openSyncedTab(tab("one", "0"));
    target.closeSyncedTab("one");
    target.applyRemoteDoc(
      "tab:one:url",
      { kind: "tabUrl", tab: { tabId: "one", url: "https://example.com/zombie" } },
      hlc(Date.now() + 10_000),
    );

    expect(target.syncedTabsFor("space-1")).toEqual([]);
    expect(target.lwwRegisters()["tab:one:presence"]?.doc).toBeNull();
  });

  it("orders concurrent same-gap inserts deterministically by tab id", () => {
    const target = store();
    target.openSyncedTab(tab("z-tab", "10"));
    target.openSyncedTab(tab("a-tab", "10"));

    expect(target.syncedTabsFor("space-1").map((item) => item.id)).toEqual([
      "a-tab",
      "z-tab",
    ]);
  });
});

describe("tab order rank allocation", () => {
  it("allocates exact ranks before, between, and after existing tabs", () => {
    expect(rankForTabInsertion([], 0)).toBe(0n);
    expect(rankForTabInsertion([{ rank: "0" }], 0)).toBe(-(1n << 64n));
    expect(rankForTabInsertion([{ rank: "0" }], 1)).toBe(1n << 64n);
    expect(rankForTabInsertion([{ rank: "0" }, { rank: "100" }], 1)).toBe(50n);
  });

  it("requests deterministic re-spacing when concurrent ranks leave no gap", () => {
    expect(rankForTabInsertion([{ rank: "10" }, { rank: "10" }], 1)).toBeNull();
    expect(rankForTabInsertion([{ rank: "10" }, { rank: "11" }], 1)).toBeNull();
  });
});
