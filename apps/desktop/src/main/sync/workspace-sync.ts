/**
 * WorkspaceSyncService — globally-synced workspace metadata (spaces, pinned
 * tabs, archives, settings) per the PRD §8.3 ownership table.
 *
 * Docs are account-global, sealed under the account workspace key
 * (deriveSpaceKeys over the "__workspace__" pseudo-space id and device.ts's
 * per-account workspace secret), stamped with the store's HLC, signed with
 * the device key, and published through the hub transport on local change
 * (debounced). Remote docs are opened, merged LWW+HLC (workspace-map.ts),
 * and winners applied into the WorkspaceStore. Canonical tab/focus registers
 * change only after explicit reconciliation. Separately, every device
 * auto-saves one atomic sealed restore point that peers may Pull or Merge but
 * can never overwrite; account-global metadata continues to converge.
 */

import { clearTimeout, setTimeout } from "node:timers";
import {
  compareHlc,
  fromBase64,
  fromUtf8,
  open,
  seal,
  toBase64,
  utf8,
  type Hlc,
  type SpaceKeys,
  type WorkspaceDoc,
  type WorkspaceRecordWire,
} from "@suma/protocol";
import { receiveWorkspaceHlc, type WorkspaceStore } from "../workspace-store";
import type { WorkspaceSyncMode, WorkspaceSyncStatus } from "../../shared/ipc";
import {
  decideMerge,
  workspaceSealAad,
  workspaceSigningBytes,
  type IncomingWorkspaceDoc,
  type WorkspaceRegister,
} from "./workspace-map";

/** Device restore points should stay current while coalescing redirect bursts. */
const PUBLISH_DEBOUNCE_MS = 40;
const PUBLISH_FENCE_RETRY_MS = 1_000;
/** Ignore obsolete pre-realtime layout snapshots still retained by old hubs. */
const LEGACY_HANDOFF_KEY_PREFIX = "handoff:";
const DEVICE_SNAPSHOT_KEY_PREFIX = "device-workspace:";
const TAB_ORDER_STEP = 1n << 64n;

interface DeviceWorkspaceSnapshot {
  version: 1;
  deviceId: string;
  capturedAtMs: number;
  registers: Record<string, WorkspaceRegister>;
}

interface StoredDeviceWorkspaceSnapshot extends DeviceWorkspaceSnapshot {
  hlc: Hlc;
}

function isAttachmentKey(key: string): boolean {
  return key.startsWith("tab:") || key === "workspace:focus";
}

function deviceSnapshotKey(deviceId: string): string {
  return `${DEVICE_SNAPSHOT_KEY_PREFIX}${encodeURIComponent(deviceId)}`;
}

function snapshotDeviceId(key: string): string | null {
  if (!key.startsWith(DEVICE_SNAPSHOT_KEY_PREFIX)) return null;
  try {
    const deviceId = decodeURIComponent(
      key.slice(DEVICE_SNAPSHOT_KEY_PREFIX.length),
    );
    return deviceId.length === 0 ? null : deviceId;
  } catch {
    return null;
  }
}

function attachmentRegisters(
  source: Readonly<Record<string, WorkspaceRegister>>,
): Record<string, WorkspaceRegister> {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => isAttachmentKey(key))
      .map(([key, register]) => [key, { ...register }]),
  );
}

function liveTabIds(
  registers: Readonly<Record<string, WorkspaceRegister>>,
): Set<string> {
  const ids = new Set<string>();
  for (const register of Object.values(registers)) {
    if (register.doc?.kind === "tabPresence") ids.add(register.doc.tab.id);
  }
  return ids;
}

function rank(value: string): bigint {
  return /^-?\d+$/.test(value) ? BigInt(value) : 0n;
}

export interface WorkspaceSyncDeps {
  deviceId: string;
  /** Stable account scope. Local loopback and a newly linked account must not
   * share the one-time hydration marker. */
  accountId?: string;
  /** Device Ed25519 signing key — every published doc is device-signed. */
  privateKey: CryptoKey;
  /** Account workspace keys (WORKSPACE_PSEUDO_SPACE_ID derivation). */
  keys: SpaceKeys;
  store: WorkspaceStore;
  publish: (docs: WorkspaceRecordWire[]) => void;
  /** Cookie/session stream and workspace stream share a socket but use
   * independent records. Before publishing attached tab navigation, establish
   * a hub-acknowledged cookie fence so redirect URLs cannot overtake auth. */
  beforeAttachmentPublish?: () => Promise<boolean>;
  /** Remote winners were applied into the store — refresh the renderer. */
  onRemoteApplied: () => void;
  onSyncStatusChanged?: (status: WorkspaceSyncStatus) => void;
}

export class WorkspaceSyncService {
  private readonly dirty = new Set<string>();
  private deviceSnapshotDirty = false;
  private publishTimer: NodeJS.Timeout | null = null;
  private applyingRemote = false;
  private remoteReady = false;
  private canonicalRecordsSeen = false;
  private remoteAttachment: Record<string, WorkspaceRegister> = {};
  private readonly deviceSnapshots = new Map<
    string,
    StoredDeviceWorkspaceSnapshot
  >();
  private localChanged = false;
  private remoteChanged = false;
  private shouldInheritFirstSnapshot: boolean;
  private accountId: string;
  private unsubscribeDocs: (() => void) | null = null;

  constructor(private readonly deps: WorkspaceSyncDeps) {
    this.accountId = deps.accountId ?? "legacy";
    this.shouldInheritFirstSnapshot = !deps.store.manualSyncInitialized(
      this.accountId,
    );
  }

  start(): void {
    if (this.unsubscribeDocs !== null) return;
    const unsubscribe = this.deps.store.onDocsChanged((keys) => {
      // Echo guard: remote applies never notify, but a listener re-entered
      // during an apply (e.g. via SpaceManager) must not republish either.
      if (this.applyingRemote) return;
      for (const key of keys) {
        if (isAttachmentKey(key)) {
          this.localChanged = true;
          this.deviceSnapshotDirty = true;
        } else {
          this.dirty.add(key);
        }
      }
      if (this.dirty.size > 0 || this.deviceSnapshotDirty) {
        this.schedulePublish();
      }
      this.pushSyncStatus();
    });
    this.unsubscribeDocs = unsubscribe;
  }

  syncStatus(): WorkspaceSyncStatus {
    const local = attachmentRegisters(this.deps.store.lwwRegisters());
    const workspacePending =
      this.remoteReady &&
      !this.attachmentContentEqual(local, this.remoteAttachment);
    const sources = this.distinctDeviceSources(local);
    if (!workspacePending) {
      this.localChanged = false;
      this.remoteChanged = false;
    }
    return {
      remoteReady: this.remoteReady,
      pending: workspacePending || sources.length > 0,
      canonicalPending: workspacePending,
      localChanged: workspacePending && this.localChanged,
      remoteChanged: workspacePending && this.remoteChanged,
      sources,
    };
  }

  async synchronize(
    mode: WorkspaceSyncMode,
    sourceDeviceId?: string,
  ): Promise<WorkspaceSyncStatus> {
    if (!this.remoteReady) {
      throw new Error("Remote workspace is still loading — try again shortly");
    }
    if (mode === "push" && sourceDeviceId !== undefined) {
      throw new Error("Push always targets the canonical workspace");
    }

    const local = attachmentRegisters(this.deps.store.lwwRegisters());
    const source =
      sourceDeviceId === undefined
        ? this.remoteAttachment
        : this.deviceSnapshots.get(sourceDeviceId)?.registers;
    if (source === undefined) {
      throw new Error("That device workspace is no longer available");
    }
    const remote = attachmentRegisters(source);
    let target: Record<string, WorkspaceRegister>;
    let publishKeys: string[] = [];

    if (mode === "pull") {
      target = remote;
    } else if (mode === "push") {
      target = { ...local };
      for (const [key, register] of Object.entries(remote)) {
        if (target[key] === undefined) target[key] = { ...register, doc: null };
      }
      publishKeys = Object.keys(target);
    } else {
      const merged = this.mergeAttachmentRegisters(local, remote);
      target = merged.target;
      publishKeys = merged.publishKeys;
    }

    if (
      sourceDeviceId === undefined &&
      publishKeys.length > 0 &&
      this.deps.beforeAttachmentPublish !== undefined &&
      !(await this.deps.beforeAttachmentPublish())
    ) {
      throw new Error("Session state is still uploading — try again shortly");
    }

    this.deps.store.replaceAttachmentRegisters(target);
    if (sourceDeviceId === undefined && mode !== "pull") {
      this.remoteAttachment = attachmentRegisters(target);
    }
    if (sourceDeviceId === undefined && publishKeys.length > 0) {
      this.deps.store.publishAttachmentRegisters(publishKeys);
      for (const key of publishKeys) this.dirty.add(key);
      await this.flush();
    }
    this.deviceSnapshotDirty = true;
    this.schedulePublish();
    this.localChanged = false;
    this.remoteChanged = false;
    this.deps.onRemoteApplied();
    this.pushSyncStatus();
    return this.syncStatus();
  }

  stop(): void {
    this.unsubscribeDocs?.();
    this.unsubscribeDocs = null;
    if (this.publishTimer !== null) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
  }

  /**
   * Workspace hydration finished. A truly fresh device inherits the first
   * remote tab graph automatically; existing devices preserve their local
   * graph and expose any divergence through the manual sync control.
   */
  async handleHydrated(): Promise<void> {
    this.remoteReady = true;
    const initialSource = this.initialRemoteSnapshot();
    if (this.shouldInheritFirstSnapshot && initialSource !== null) {
      this.applyingRemote = true;
      try {
        this.deps.store.replaceAttachmentRegisters(initialSource);
      } finally {
        this.applyingRemote = false;
      }
      this.localChanged = false;
      this.remoteChanged = false;
      this.deps.onRemoteApplied();
    }
    // The first device establishes the canonical lane once. A fresh device
    // can also recover an account whose canonical lane predates this model
    // from the newest device snapshot, then promotes that recovered state.
    if (this.shouldInheritFirstSnapshot && !this.canonicalRecordsSeen) {
      await this.bootstrapCanonical();
    }
    this.shouldInheritFirstSnapshot = false;
    this.deps.store.markManualSyncInitialized(this.accountId);
    this.deviceSnapshotDirty = true;
    for (const key of Object.keys(this.deps.store.lwwRegisters())) {
      if (!isAttachmentKey(key)) this.dirty.add(key);
    }
    this.schedulePublish();
    this.pushSyncStatus();
  }

  /**
   * Adopt freshly-recovered workspace keys (auth:recoverKeys, §8.2). All
   * subsequent seals/opens use the new key, and every local register is
   * re-dirtied so it is republished sealed under it; the re-hydrate that the
   * caller triggers then re-opens the account's remote docs.
   */
  rekey(keys: SpaceKeys, accountId = this.accountId): void {
    if (accountId !== this.accountId) {
      this.accountId = accountId;
      this.remoteReady = false;
      this.canonicalRecordsSeen = false;
      this.remoteAttachment = {};
      this.deviceSnapshots.clear();
      this.shouldInheritFirstSnapshot =
        !this.deps.store.manualSyncInitialized(accountId);
    }
    this.deps.keys = keys;
    this.deviceSnapshotDirty = true;
    for (const key of Object.keys(this.deps.store.lwwRegisters())) {
      if (!isAttachmentKey(key)) this.dirty.add(key);
    }
    this.schedulePublish();
  }

  async handleRemoteDocs(docs: WorkspaceRecordWire[]): Promise<void> {
    const incoming: IncomingWorkspaceDoc[] = [];
    const attachmentIncoming: IncomingWorkspaceDoc[] = [];
    let deviceSnapshotChanged = false;
    for (const wire of docs) {
      receiveWorkspaceHlc(this.deps.deviceId, wire.hlc);
      let value: unknown;
      try {
        value = await this.openValue(wire);
      } catch {
        // Sealed under a different account workspace key (or tampered) —
        // unreadable by design; skip.
        continue;
      }
      if (wire.key.startsWith(LEGACY_HANDOFF_KEY_PREFIX)) continue;
      const sourceDeviceId = snapshotDeviceId(wire.key);
      if (sourceDeviceId !== null) {
        const snapshot = this.readDeviceSnapshot(
          sourceDeviceId,
          value,
          wire.hlc,
        );
        if (snapshot === null) continue;
        const current = this.deviceSnapshots.get(sourceDeviceId);
        if (
          current === undefined ||
          compareHlc(snapshot.hlc, current.hlc) > 0
        ) {
          this.deviceSnapshots.set(sourceDeviceId, snapshot);
          deviceSnapshotChanged = true;
        }
        continue;
      }
      const opened: IncomingWorkspaceDoc = {
        key: wire.key,
        value: value as WorkspaceDoc | null,
        hlc: wire.hlc,
      };
      if (isAttachmentKey(wire.key)) {
        this.canonicalRecordsSeen = true;
        attachmentIncoming.push(opened);
      } else if (wire.hlc.deviceId !== this.deps.deviceId) {
        incoming.push(opened);
      }
    }
    if (deviceSnapshotChanged) this.pushSyncStatus();
    if (attachmentIncoming.length > 0) {
      const before = this.attachmentFingerprint(this.remoteAttachment);
      const remoteDecision = decideMerge(
        this.remoteAttachment,
        attachmentIncoming,
      );
      for (const doc of [...remoteDecision.apply, ...remoteDecision.adoptHlc]) {
        this.remoteAttachment[doc.key] = {
          doc: doc.value,
          hlc: doc.hlc,
        };
      }
      if (before !== this.attachmentFingerprint(this.remoteAttachment)) {
        this.remoteChanged = !this.attachmentContentEqual(
          attachmentRegisters(this.deps.store.lwwRegisters()),
          this.remoteAttachment,
        );
        this.pushSyncStatus();
      }
    }
    if (incoming.length > 0) {
      const decision = decideMerge(this.deps.store.lwwRegisters(), incoming);
      this.applyingRemote = true;
      try {
        for (const doc of [...decision.apply, ...decision.adoptHlc]) {
          this.deps.store.applyRemoteDoc(doc.key, doc.value, doc.hlc);
        }
      } finally {
        this.applyingRemote = false;
      }
      if (decision.apply.length > 0) {
        this.deps.onRemoteApplied();
        this.pushSyncStatus();
      }
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private schedulePublish(delayMs = PUBLISH_DEBOUNCE_MS): void {
    if (this.publishTimer !== null) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.flush().catch((err: unknown) =>
        console.error("suma workspace-sync:", err),
      );
    }, delayMs);
    this.publishTimer.unref();
  }

  private async flush(): Promise<void> {
    const keys = [...this.dirty];
    const publishDeviceSnapshot = this.remoteReady && this.deviceSnapshotDirty;
    if (keys.length === 0 && !publishDeviceSnapshot) return;
    this.dirty.clear();
    if (publishDeviceSnapshot) this.deviceSnapshotDirty = false;
    try {
      const registers = this.deps.store.lwwRegisters();
      const wires: WorkspaceRecordWire[] = [];
      for (const key of keys) {
        const register = registers[key];
        if (register === undefined) continue;
        wires.push(await this.sealDoc(key, register.doc, register.hlc));
      }
      if (publishDeviceSnapshot) {
        const snapshot: DeviceWorkspaceSnapshot = {
          version: 1,
          deviceId: this.deps.deviceId,
          capturedAtMs: Date.now(),
          registers: attachmentRegisters(registers),
        };
        wires.push(
          await this.sealDoc(
            deviceSnapshotKey(this.deps.deviceId),
            snapshot,
            this.deps.store.nextSyncHlc(),
          ),
        );
      }
      if (wires.length > 0) this.deps.publish(wires);
    } catch (err) {
      // Dirty keys are only retired after sealing succeeds. A transient crypto
      // failure must never silently lose a tab/global update.
      for (const key of keys) this.dirty.add(key);
      if (publishDeviceSnapshot) this.deviceSnapshotDirty = true;
      this.schedulePublish(PUBLISH_FENCE_RETRY_MS);
      throw err;
    }
  }

  /** Pick the account canonical snapshot first. Accounts created before the
   * device-snapshot model may not have one yet, so fall back to the newest
   * other-device restore point during one-time device linking. */
  private initialRemoteSnapshot(): Record<string, WorkspaceRegister> | null {
    if (this.canonicalRecordsSeen) {
      return attachmentRegisters(this.remoteAttachment);
    }
    const newest = [...this.deviceSnapshots.values()]
      .filter((snapshot) => snapshot.deviceId !== this.deps.deviceId)
      .sort((a, b) => compareHlc(b.hlc, a.hlc))[0];
    return newest === undefined ? null : attachmentRegisters(newest.registers);
  }

  /** Establish the canonical lane exactly once. Normal automatic saves never
   * write canonical keys; they only update this device's atomic snapshot. */
  private async bootstrapCanonical(): Promise<void> {
    const local = attachmentRegisters(this.deps.store.lwwRegisters());
    const keys = Object.keys(local);
    if (keys.length === 0) return;
    if (
      this.deps.beforeAttachmentPublish !== undefined &&
      !(await this.deps.beforeAttachmentPublish())
    ) {
      return;
    }
    this.deps.store.publishAttachmentRegisters(keys);
    this.remoteAttachment = attachmentRegisters(this.deps.store.lwwRegisters());
    this.canonicalRecordsSeen = true;
    for (const key of keys) this.dirty.add(key);
    await this.flush();
  }

  private distinctDeviceSources(
    local: Readonly<Record<string, WorkspaceRegister>>,
  ): Array<{
    deviceId: string;
    name: string;
    platform: string;
    updatedAtMs: number;
  }> {
    const canonicalFingerprint = this.attachmentFingerprint(
      this.remoteAttachment,
    );
    const localFingerprint = this.attachmentFingerprint(local);
    const activities = this.deps.store.syncedDeviceActivities();
    const sources: Array<{
      deviceId: string;
      name: string;
      platform: string;
      updatedAtMs: number;
    }> = [];
    for (const snapshot of this.deviceSnapshots.values()) {
      if (snapshot.deviceId === this.deps.deviceId) continue;
      const fingerprint = this.attachmentFingerprint(snapshot.registers);
      // Neither choice could produce a visible change in these cases. The
      // canonical actions already represent an identical canonical source.
      if (
        fingerprint === canonicalFingerprint ||
        fingerprint === localFingerprint
      ) {
        continue;
      }
      const activity = activities.find(
        (candidate) =>
          candidate.deviceId === snapshot.deviceId ||
          candidate.identityDeviceId === snapshot.deviceId,
      );
      sources.push({
        deviceId: snapshot.deviceId,
        name: activity?.name ?? `Mac ${snapshot.deviceId.slice(0, 8)}`,
        platform: activity?.platform ?? "Mac",
        updatedAtMs: snapshot.hlc.physicalMs,
      });
    }
    return sources.sort(
      (a, b) =>
        b.updatedAtMs - a.updatedAtMs || a.deviceId.localeCompare(b.deviceId),
    );
  }

  private readDeviceSnapshot(
    expectedDeviceId: string,
    value: unknown,
    hlc: Hlc,
  ): StoredDeviceWorkspaceSnapshot | null {
    if (value === null || typeof value !== "object") return null;
    const candidate = value as Partial<DeviceWorkspaceSnapshot>;
    if (
      candidate.version !== 1 ||
      candidate.deviceId !== expectedDeviceId ||
      candidate.registers === null ||
      typeof candidate.registers !== "object"
    ) {
      return null;
    }
    const registers: Record<string, WorkspaceRegister> = {};
    for (const [key, raw] of Object.entries(candidate.registers)) {
      if (
        !isAttachmentKey(key) ||
        raw === null ||
        typeof raw !== "object" ||
        !("doc" in raw) ||
        !("hlc" in raw)
      ) {
        continue;
      }
      const register = raw as Partial<WorkspaceRegister>;
      const registerHlc = register.hlc;
      if (
        registerHlc === undefined ||
        typeof registerHlc.physicalMs !== "number" ||
        typeof registerHlc.logical !== "number" ||
        typeof registerHlc.deviceId !== "string"
      ) {
        continue;
      }
      if (
        register.doc !== null &&
        (register.doc === undefined || typeof register.doc !== "object")
      ) {
        continue;
      }
      registers[key] = {
        doc: register.doc as WorkspaceDoc | null,
        hlc: { ...registerHlc },
      };
    }
    return {
      version: 1,
      deviceId: expectedDeviceId,
      capturedAtMs:
        typeof candidate.capturedAtMs === "number"
          ? candidate.capturedAtMs
          : hlc.physicalMs,
      registers,
      hlc,
    };
  }

  private mergeAttachmentRegisters(
    local: Readonly<Record<string, WorkspaceRegister>>,
    remote: Readonly<Record<string, WorkspaceRegister>>,
  ): { target: Record<string, WorkspaceRegister>; publishKeys: string[] } {
    const target = attachmentRegisters(remote);
    const localLive = liveTabIds(local);
    const remoteLive = liveTabIds(remote);
    const localOnly = [...localLive].filter((id) => !remoteLive.has(id));
    const bySpace = new Map<string, string[]>();
    for (const id of localOnly) {
      const presence = local[`tab:${id}:presence`]?.doc;
      if (presence?.kind !== "tabPresence") continue;
      const ids = bySpace.get(presence.tab.spaceId) ?? [];
      ids.push(id);
      bySpace.set(presence.tab.spaceId, ids);
    }

    const publishKeys: string[] = [];
    for (const [spaceId, ids] of bySpace) {
      const remoteRanks = Object.values(target)
        .filter(
          (register) =>
            register.doc?.kind === "tabOrder" &&
            register.doc.tab.spaceId === spaceId,
        )
        .map((register) =>
          rank(register.doc?.kind === "tabOrder" ? register.doc.tab.rank : "0"),
        );
      let nextRank =
        remoteRanks.length === 0
          ? 0n
          : remoteRanks.reduce((a, b) => (a > b ? a : b)) + TAB_ORDER_STEP;
      ids.sort((a, b) => {
        const aDoc = local[`tab:${a}:order`]?.doc;
        const bDoc = local[`tab:${b}:order`]?.doc;
        const aRank = rank(aDoc?.kind === "tabOrder" ? aDoc.tab.rank : "0");
        const bRank = rank(bDoc?.kind === "tabOrder" ? bDoc.tab.rank : "0");
        return aRank < bRank ? -1 : aRank > bRank ? 1 : a.localeCompare(b);
      });
      for (const id of ids) {
        const presenceKey = `tab:${id}:presence`;
        const urlKey = `tab:${id}:url`;
        const orderKey = `tab:${id}:order`;
        const presence = local[presenceKey];
        const url = local[urlKey];
        const order = local[orderKey];
        if (presence !== undefined) target[presenceKey] = { ...presence };
        if (url !== undefined) target[urlKey] = { ...url };
        if (order?.doc?.kind === "tabOrder") {
          target[orderKey] = {
            ...order,
            doc: {
              kind: "tabOrder",
              tab: { ...order.doc.tab, spaceId, rank: nextRank.toString() },
            },
          };
          nextRank += TAB_ORDER_STEP;
        }
        publishKeys.push(presenceKey, urlKey, orderKey);
      }
    }
    return { target, publishKeys };
  }

  private attachmentContentEqual(
    a: Readonly<Record<string, WorkspaceRegister>>,
    b: Readonly<Record<string, WorkspaceRegister>>,
  ): boolean {
    return this.attachmentFingerprint(a) === this.attachmentFingerprint(b);
  }

  /** HLCs express causality, not visible divergence. Compare materialized docs. */
  private attachmentFingerprint(
    registers: Readonly<Record<string, WorkspaceRegister>>,
  ): string {
    return JSON.stringify(
      Object.entries(registers)
        .filter(([, register]) => register.doc !== null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, register]) => [key, register.doc]),
    );
  }

  private pushSyncStatus(): void {
    this.deps.onSyncStatusChanged?.(this.syncStatus());
  }

  private async sealDoc(
    key: string,
    value: unknown,
    hlc: Hlc,
  ): Promise<WorkspaceRecordWire> {
    const sealedValue =
      value === null
        ? null
        : toBase64(
            await seal(
              this.deps.keys.sealKey,
              utf8(JSON.stringify(value)),
              workspaceSealAad(key),
            ),
          );
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        this.deps.privateKey,
        workspaceSigningBytes(key, sealedValue, hlc) as BufferSource,
      ),
    );
    return { key, sealedValue, hlc, deviceSig: toBase64(sig) };
  }

  private async openValue(wire: WorkspaceRecordWire): Promise<unknown> {
    if (wire.sealedValue === null) return null;
    const bytes = await open(
      this.deps.keys.sealKey,
      fromBase64(wire.sealedValue),
      workspaceSealAad(wire.key),
    );
    return JSON.parse(fromUtf8(bytes)) as unknown;
  }
}
