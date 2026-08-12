import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveSpaceKeys,
  generateDeviceKeypair,
  seal,
  toBase64,
  utf8,
  workspaceKeyFor,
  type Hlc,
  type SpaceKeys,
  type WorkspaceDoc,
  type WorkspaceRecordWire,
} from "@suma/protocol";
import {
  WORKSPACE_PSEUDO_SPACE_ID,
  workspaceSealAad,
} from "../src/main/sync/workspace-map";
import type { WorkspaceRegister } from "../src/main/sync/workspace-map";
import { WorkspaceSyncService } from "../src/main/sync/workspace-sync";
import { resetWorkspaceHlc, WorkspaceStore } from "../src/main/workspace-store";

function store(): WorkspaceStore {
  return new WorkspaceStore(
    path.join(tmpdir(), `suma-attachment-${randomUUID()}`, "workspace.json"),
    "device-a",
  );
}

async function keys(): Promise<SpaceKeys> {
  return deriveSpaceKeys(WORKSPACE_PSEUDO_SPACE_ID, new Uint8Array(32).fill(7));
}

function openTab(
  target: WorkspaceStore,
  id: string,
  rank: string,
  url = `https://example.com/${id}`,
): void {
  target.openSyncedTab({
    id,
    spaceId: "space-1",
    createdAtMs: 1,
    url,
    rank,
  });
}

function setFocus(target: WorkspaceStore, tabId: string): void {
  target.setActiveSpaceId("space-1");
  target.setActiveTabFor("space-1", tabId);
  target.updateSyncedWorkspaceFocus({
    activeSpaceId: "space-1",
    activeTabId: tabId,
    splitTabId: null,
  });
}

async function wires(
  workspaceKeys: SpaceKeys,
  docs: ReadonlyArray<WorkspaceDoc | { key: string; doc: null }>,
): Promise<WorkspaceRecordWire[]> {
  const at = Date.now() + 60_000;
  return Promise.all(
    docs.map(async (item, index) => {
      const key = "kind" in item ? workspaceKeyFor(item) : item.key;
      const doc = "kind" in item ? item : item.doc;
      const hlc: Hlc = {
        physicalMs: at + index,
        logical: 0,
        deviceId: "device-b",
      };
      return {
        key,
        sealedValue:
          doc === null
            ? null
            : toBase64(
                await seal(
                  workspaceKeys.sealKey,
                  utf8(JSON.stringify(doc)),
                  workspaceSealAad(key),
                ),
              ),
        hlc,
        deviceSig: toBase64(new Uint8Array(64)),
      };
    }),
  );
}

async function deviceSnapshotWire(
  workspaceKeys: SpaceKeys,
  deviceId: string,
  registers: Record<string, WorkspaceRegister>,
  physicalMs = Date.now() + 120_000,
): Promise<WorkspaceRecordWire> {
  const key = `device-workspace:${encodeURIComponent(deviceId)}`;
  const hlc: Hlc = { physicalMs, logical: 0, deviceId };
  return {
    key,
    sealedValue: toBase64(
      await seal(
        workspaceKeys.sealKey,
        utf8(
          JSON.stringify({
            version: 1,
            deviceId,
            capturedAtMs: physicalMs,
            registers,
          }),
        ),
        workspaceSealAad(key),
      ),
    ),
    hlc,
    deviceSig: toBase64(new Uint8Array(64)),
  };
}

function attachmentState(
  id: string,
  deviceId: string,
  url = `https://example.com/${id}`,
): Record<string, WorkspaceRegister> {
  const hlc: Hlc = {
    physicalMs: Date.now() + 90_000,
    logical: 0,
    deviceId,
  };
  return {
    [`tab:${id}:presence`]: {
      doc: {
        kind: "tabPresence",
        tab: { id, spaceId: "space-1", createdAtMs: 1 },
      },
      hlc,
    },
    [`tab:${id}:url`]: {
      doc: { kind: "tabUrl", tab: { tabId: id, url } },
      hlc,
    },
    [`tab:${id}:order`]: {
      doc: {
        kind: "tabOrder",
        tab: { tabId: id, spaceId: "space-1", rank: "0" },
      },
      hlc,
    },
    "workspace:focus": {
      doc: {
        kind: "workspaceFocus",
        focus: {
          activeSpaceId: "space-1",
          activeTabId: id,
          splitTabId: null,
        },
      },
      hlc,
    },
  };
}

async function service(target: WorkspaceStore): Promise<{
  sync: WorkspaceSyncService;
  workspaceKeys: SpaceKeys;
}> {
  // These cases model an already-linked Mac making a later manual choice.
  target.markManualSyncInitialized();
  const workspaceKeys = await keys();
  const pair = await generateDeviceKeypair();
  const sync = new WorkspaceSyncService({
    deviceId: "device-a",
    privateKey: pair.privateKey,
    keys: workspaceKeys,
    store: target,
    publish: () => undefined,
    onRemoteApplied: () => undefined,
  });
  sync.start();
  return { sync, workspaceKeys };
}

beforeEach(() => resetWorkspaceHlc());

describe("manual workspace reconciliation", () => {
  it("holds an explicit Push behind the session causal fence", async () => {
    const target = store();
    target.markManualSyncInitialized();
    const workspaceKeys = await keys();
    const pair = await generateDeviceKeypair();
    const published: WorkspaceRecordWire[][] = [];
    let releaseFence: ((confirmed: boolean) => void) | undefined;
    let noteFenceStarted: (() => void) | undefined;
    const fenceStarted = new Promise<void>((resolve) => {
      noteFenceStarted = resolve;
    });
    const fence = new Promise<boolean>((resolve) => {
      releaseFence = resolve;
    });
    const sync = new WorkspaceSyncService({
      deviceId: "device-a",
      privateKey: pair.privateKey,
      keys: workspaceKeys,
      store: target,
      publish: (docs) => published.push(docs),
      beforeAttachmentPublish: async () => {
        noteFenceStarted?.();
        return fence;
      },
      onRemoteApplied: () => undefined,
    });
    sync.start();

    openTab(target, "google-tab", "0", "https://mail.google.com/mail/u/0/");
    await sync.handleHydrated();
    const pushing = sync.synchronize("push");
    await fenceStarted;
    expect(
      published
        .flat()
        .filter(
          (wire) =>
            wire.key.startsWith("tab:") || wire.key === "workspace:focus",
        ),
    ).toEqual([]);

    releaseFence?.(true);
    await pushing;
    expect(
      published
        .flat()
        .some(
          (wire) =>
            wire.key.startsWith("tab:") || wire.key === "workspace:focus",
        ),
    ).toBe(true);
    sync.stop();
  });

  it("auto-saves local tab changes only to this device's snapshot lane", async () => {
    const target = store();
    target.markManualSyncInitialized();
    openTab(target, "base", "0");
    setFocus(target, "base");
    const workspaceKeys = await keys();
    const oldPair = await generateDeviceKeypair();
    const stalePublishes: WorkspaceRecordWire[][] = [];
    const stale = new WorkspaceSyncService({
      deviceId: "device-a",
      privateKey: oldPair.privateKey,
      keys: workspaceKeys,
      store: target,
      publish: (docs) => stalePublishes.push(docs),
      onRemoteApplied: () => undefined,
    });
    stale.start();

    // SyncService replaces the bootstrap transport this way after control
    // discovers the account's real SessionHub endpoint.
    stale.stop();
    const currentPair = await generateDeviceKeypair();
    const currentPublishes: WorkspaceRecordWire[][] = [];
    const current = new WorkspaceSyncService({
      deviceId: "device-a",
      privateKey: currentPair.privateKey,
      keys: workspaceKeys,
      store: target,
      publish: (docs) => currentPublishes.push(docs),
      onRemoteApplied: () => undefined,
    });
    current.start();
    await current.handleHydrated();
    await vi.waitFor(() => expect(currentPublishes.length).toBeGreaterThan(0));
    currentPublishes.length = 0;

    openTab(target, "manual-local", "10");
    await vi.waitFor(() => expect(currentPublishes.length).toBeGreaterThan(0));

    expect(stalePublishes).toEqual([]);
    expect(currentPublishes.flat().map((wire) => wire.key)).toEqual([
      "device-workspace:device-a",
    ]);
    expect(current.syncStatus()).toMatchObject({
      pending: true,
      localChanged: true,
    });
    current.stop();
  });

  it("Pull discards local tabs and adopts remote tabs and focus", async () => {
    const target = store();
    openTab(target, "base", "0");
    setFocus(target, "base");
    const { sync, workspaceKeys } = await service(target);

    openTab(target, "local", "10");
    target.closeSyncedTab("base");
    setFocus(target, "local");
    await sync.handleRemoteDocs(
      await wires(workspaceKeys, [
        { key: "tab:base:presence", doc: null },
        {
          kind: "tabPresence",
          tab: { id: "remote", spaceId: "space-1", createdAtMs: 2 },
        },
        {
          kind: "tabUrl",
          tab: { tabId: "remote", url: "https://example.com/remote" },
        },
        {
          kind: "tabOrder",
          tab: { tabId: "remote", spaceId: "space-1", rank: "20" },
        },
        {
          kind: "workspaceFocus",
          focus: {
            activeSpaceId: "space-1",
            activeTabId: "remote",
            splitTabId: null,
          },
        },
      ]),
    );
    await sync.handleHydrated();

    await sync.synchronize("pull");
    expect(target.syncedTabsFor("space-1").map((tab) => tab.id)).toEqual([
      "remote",
    ]);
    expect(target.syncedWorkspaceFocus()?.activeTabId).toBe("remote");
    expect(sync.syncStatus().pending).toBe(false);
    sync.stop();
  });

  it("Push makes the local graph authoritative and tombstones remote-only tabs", async () => {
    const target = store();
    openTab(target, "base", "0");
    setFocus(target, "base");
    const { sync, workspaceKeys } = await service(target);

    openTab(target, "local", "10");
    target.closeSyncedTab("base");
    setFocus(target, "local");
    await sync.handleRemoteDocs(
      await wires(workspaceKeys, [
        {
          kind: "tabPresence",
          tab: { id: "remote", spaceId: "space-1", createdAtMs: 2 },
        },
        {
          kind: "tabUrl",
          tab: { tabId: "remote", url: "https://example.com/remote" },
        },
        {
          kind: "tabOrder",
          tab: { tabId: "remote", spaceId: "space-1", rank: "20" },
        },
      ]),
    );
    await sync.handleHydrated();

    await sync.synchronize("push");
    expect(target.syncedTabsFor("space-1").map((tab) => tab.id)).toEqual([
      "local",
    ]);
    expect(target.lwwRegisters()["tab:remote:presence"]?.doc).toBeNull();
    expect(target.syncedWorkspaceFocus()?.activeTabId).toBe("local");
    sync.stop();
  });

  it("Merge appends local-only tabs, keeps remote common fields, and adopts remote focus", async () => {
    const target = store();
    openTab(target, "base", "0", "https://example.com/base-start");
    setFocus(target, "base");
    const { sync, workspaceKeys } = await service(target);

    target.updateSyncedTabUrl("base", "https://example.com/base-local");
    openTab(target, "local", "10");
    setFocus(target, "local");
    await sync.handleRemoteDocs(
      await wires(workspaceKeys, [
        {
          kind: "tabPresence",
          tab: { id: "base", spaceId: "space-1", createdAtMs: 1 },
        },
        {
          kind: "tabUrl",
          tab: { tabId: "base", url: "https://example.com/base-remote" },
        },
        {
          kind: "tabOrder",
          tab: { tabId: "base", spaceId: "space-1", rank: "0" },
        },
        {
          kind: "tabPresence",
          tab: { id: "remote", spaceId: "space-1", createdAtMs: 2 },
        },
        {
          kind: "tabUrl",
          tab: { tabId: "remote", url: "https://example.com/remote" },
        },
        {
          kind: "tabOrder",
          tab: { tabId: "remote", spaceId: "space-1", rank: "20" },
        },
        {
          kind: "workspaceFocus",
          focus: {
            activeSpaceId: "space-1",
            activeTabId: "remote",
            splitTabId: null,
          },
        },
      ]),
    );
    await sync.handleHydrated();

    await sync.synchronize("merge");
    const tabs = target.syncedTabsFor("space-1");
    expect(tabs.map((tab) => tab.id)).toEqual(["base", "remote", "local"]);
    expect(tabs.find((tab) => tab.id === "base")?.url).toBe(
      "https://example.com/base-remote",
    );
    expect(target.syncedWorkspaceFocus()?.activeTabId).toBe("remote");
    sync.stop();
  });

  it("automatically inherits canonical tabs and focus on first link", async () => {
    const target = store();
    openTab(target, "placeholder", "0");
    setFocus(target, "placeholder");
    const workspaceKeys = await keys();
    const pair = await generateDeviceKeypair();
    const published: WorkspaceRecordWire[][] = [];
    const sync = new WorkspaceSyncService({
      deviceId: "device-a",
      privateKey: pair.privateKey,
      keys: workspaceKeys,
      store: target,
      publish: (docs) => published.push(docs),
      onRemoteApplied: () => undefined,
    });
    sync.start();
    await sync.handleRemoteDocs(
      await wires(workspaceKeys, [
        ...Object.values(attachmentState("remote", "device-b")).map(
          (register) => register.doc as WorkspaceDoc,
        ),
      ]),
    );

    await sync.handleHydrated();

    expect(target.syncedTabsFor("space-1").map((tab) => tab.id)).toEqual([
      "remote",
    ]);
    expect(target.syncedWorkspaceFocus()?.activeTabId).toBe("remote");
    await vi.waitFor(() =>
      expect(
        published
          .flat()
          .some((wire) => wire.key === "device-workspace:device-a"),
      ).toBe(true),
    );
    sync.stop();
  });

  it("inherits after account linking even if local loopback already initialized", async () => {
    const target = store();
    target.markManualSyncInitialized("local:device-a");
    openTab(target, "local-before-link", "0");
    const workspaceKeys = await keys();
    const pair = await generateDeviceKeypair();
    const sync = new WorkspaceSyncService({
      deviceId: "device-a",
      accountId: "local:device-a",
      privateKey: pair.privateKey,
      keys: workspaceKeys,
      store: target,
      publish: () => undefined,
      onRemoteApplied: () => undefined,
    });
    sync.start();

    sync.rekey(workspaceKeys, "linked-account");
    await sync.handleRemoteDocs(
      await wires(
        workspaceKeys,
        Object.values(attachmentState("linked-remote", "device-b")).map(
          (register) => register.doc as WorkspaceDoc,
        ),
      ),
    );
    await sync.handleHydrated();

    expect(target.syncedTabsFor("space-1").map((tab) => tab.id)).toEqual([
      "linked-remote",
    ]);
    expect(target.manualSyncInitialized("linked-account")).toBe(true);
    sync.stop();
  });

  it("offers only distinct device snapshots and can Pull one without changing canonical", async () => {
    const target = store();
    target.markManualSyncInitialized();
    openTab(target, "canonical", "0");
    setFocus(target, "canonical");
    const workspaceKeys = await keys();
    const pair = await generateDeviceKeypair();
    const published: WorkspaceRecordWire[][] = [];
    const sync = new WorkspaceSyncService({
      deviceId: "device-a",
      privateKey: pair.privateKey,
      keys: workspaceKeys,
      store: target,
      publish: (docs) => published.push(docs),
      onRemoteApplied: () => undefined,
    });
    sync.start();
    await sync.handleRemoteDocs(
      await wires(
        workspaceKeys,
        Object.values(attachmentState("canonical", "device-b")).map(
          (register) => register.doc as WorkspaceDoc,
        ),
      ),
    );
    await sync.handleRemoteDocs([
      await deviceSnapshotWire(
        workspaceKeys,
        "device-b",
        attachmentState("canonical", "device-b"),
      ),
    ]);
    await sync.handleHydrated();
    expect(sync.syncStatus().sources).toEqual([]);

    await sync.handleRemoteDocs([
      await deviceSnapshotWire(
        workspaceKeys,
        "device-b",
        attachmentState("device-b-only", "device-b"),
        Date.now() + 180_000,
      ),
    ]);
    expect(sync.syncStatus().sources.map((source) => source.deviceId)).toEqual([
      "device-b",
    ]);
    published.length = 0;

    await sync.synchronize("pull", "device-b");

    expect(target.syncedTabsFor("space-1").map((tab) => tab.id)).toEqual([
      "device-b-only",
    ]);
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0));
    expect(
      published
        .flat()
        .filter(
          (wire) =>
            wire.key.startsWith("tab:") || wire.key === "workspace:focus",
        ),
    ).toEqual([]);
    expect(sync.syncStatus()).toMatchObject({
      canonicalPending: true,
      sources: [],
    });
    sync.stop();
  });
});
