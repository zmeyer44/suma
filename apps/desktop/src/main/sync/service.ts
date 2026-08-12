/**
 * SyncService — one SpaceSyncEngine per space wired to the shared transport,
 * the Electron cookie applier, and cookie capture (PRD §8.3). Also owns the
 * per-origin last-known-good snapshots backing sync:rollbackOrigin and the
 * SyncStatus surfaced in the chrome (§10 "Sync paused" pill).
 */

import {
  clearInterval,
  clearTimeout,
  setInterval,
  setImmediate,
  setTimeout,
} from "node:timers";
import { SEED_CORPUS } from "@suma/config";
import {
  compareHlc,
  computeOriginIdHex,
  computeRecordIdHex,
  deriveSpaceKeys,
  matchOriginPolicy,
  normalizedHost,
  type DevicePresence,
  type CookieRecordWire,
  type SpaceKeys,
} from "@suma/protocol";
import {
  DeviceRegistryVerifier,
  SpaceSyncEngine,
  type OriginSnapshot,
} from "@suma/sync-engine";
import type { Session } from "electron";
import type {
  OriginContinuityInfo,
  SyncConnectionState,
  SyncStatus,
  WorkspaceSyncMode,
  WorkspaceSyncStatus,
} from "../../shared/ipc";
import type { DeviceStore } from "../device";
import { isDeviceLocalCookieName } from "../gateway/routing";
import type { WorkspaceStore } from "../workspace-store";
import { attachCookieCapture, type CookieCapture } from "./capture";
import { attributesForCookie, identityForCookie } from "./cookie-map";
import { ElectronCookieApplier } from "./cookie-applier";
import {
  LoopbackTransport,
  WsTransport,
  type HubTransport,
  type TransportEvents,
} from "./transport";
import { WORKSPACE_PSEUDO_SPACE_ID } from "./workspace-map";
import { WorkspaceSyncService } from "./workspace-sync";

const SNAPSHOT_REFRESH_MS = 15 * 60 * 1000;
const STATUS_DEBOUNCE_MS = 100;
const SESSION_HYDRATION_RETRY_MS = 1_000;

export interface SyncServiceDeps {
  device: DeviceStore;
  store: WorkspaceStore;
  sessionFor(spaceId: string): Session;
  emitStatus(status: SyncStatus): void;
  /** Control-plane device token for the hub edge; null pre-enrollment (§8.2). */
  getToken?: () => Promise<string | null>;
  /** Remote workspace winners were applied into the store (§8.3). */
  onWorkspaceApplied?: () => void;
  onWorkspaceSyncChanged?: (status: WorkspaceSyncStatus) => void;
  /** Live device presence changed; used to refresh the friendly device list. */
  onPresenceChanged?: () => void;
  /** A space finished hydrating (its stored records have all been applied) —
   *  the safe moment to judge whether a space is genuinely empty (§8.8). */
  onConverged?: () => void;
  /** Browser tabs must not make their first request while an account cookie
   * snapshot is still being applied. These callbacks bracket that barrier. */
  onSessionHydrating?: (spaceId: string) => void;
  onSessionReady?: (spaceId: string) => void;
  /** A manual session pull completed; reload already-open pages against it. */
  onSessionSynchronized?: (spaceId: string) => void;
  /** The structured network gateway owns only portable origins. Native
   * origins keep using sealed cookie sync while Chromium owns their network. */
  gatewayOwnsHost?: (host: string) => boolean;
  /** Drain the structured gateway's canonical cookie/token lane before an
   * authenticated workspace URL is published. */
  beforeGatewaySessionFence?: () => Promise<boolean>;
}

interface SpaceSyncState {
  spaceId: string;
  engine: SpaceSyncEngine;
  keys: SpaceKeys;
  hydrating: boolean;
  /** Record frames contain async crypto and cookie-store writes. Preserve
   * transport order and make hydrate.done wait for every queued apply. */
  recordQueue: Promise<void>;
  recordError: unknown | null;
  capture: CookieCapture;
  /** Only the newest live-record queue tail may reopen tab navigation. */
  recordEpoch: number;
  /** First-link hydration is automatic; later live records wait for Sync. */
  hasHydratedOnce: boolean;
  pendingRemoteRecords: Map<string, CookieRecordWire>;
  /** Per-origin last-known-good restore points (§8.3 rollback). */
  snapshots: Map<string, OriginSnapshot>;
}

export class SyncService {
  private readonly spaces = new Map<string, SpaceSyncState>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly declaredSpaceIds = new Set<string>();
  private transport: HubTransport;
  private readonly transportEvents: TransportEvents;
  /** Current ws endpoint; null while on loopback. Env-set URLs pin it. */
  private hubUrl: string | null = null;
  private readonly hubPinnedByEnv: boolean;
  private started = false;
  /** Invalidates async setup continuations after a transport/account swap. */
  private syncGeneration = 0;
  private workspace: WorkspaceSyncService | null = null;
  /** Workspace frames contain async crypto; preserve wire order through it. */
  private workspaceQueue: Promise<void> = Promise.resolve();
  /** Async recovery work scheduled by rejected cookie publish acks. */
  private rejectionQueue: Promise<void> = Promise.resolve();
  private lastConvergedMs: number | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SyncServiceDeps) {
    const events: TransportEvents = {
      onStateChanged: (state) => {
        const online = state === "connected";
        console.log(
          `[suma cookie-sync] transport ${state}; spaces declared: [${[...this.spaces.keys()].join(", ")}]`,
        );
        for (const space of this.spaces.values()) {
          if (state === "connected") {
            // Only the first linked-device hydration gates browsing and
            // applies automatically. Reconnect/live snapshots are staged for
            // the explicit Sync control, avoiding races with a running site.
            if (!space.hasHydratedOnce && !space.hydrating) {
              space.hydrating = true;
              void space.engine.beginHydration();
              this.deps.onSessionHydrating?.(space.spaceId);
            }
            if (!space.hasHydratedOnce) space.recordError = null;
          }
          space.engine.setOnline(online);
          // A returning device can still browse its local Chromium session
          // while the SessionHub is unavailable. A later successful hello
          // closes the barrier again before requesting hydration.
          if (state === "offline" && space.hydrating && space.hasHydratedOnce) {
            space.hydrating = false;
            void space.engine.endHydration();
            this.deps.onSessionReady?.(space.spaceId);
          }
        }
        this.pushStatus();
      },
      onRecords: (spaceId, records) => {
        const space = this.spaces.get(spaceId);
        console.log(
          `[suma cookie-sync] received ${records.length} record(s) for space ${spaceId}` +
            (space === undefined
              ? " — NO LOCAL ENGINE (space not subscribed)"
              : ""),
        );
        if (space !== undefined && records.length > 0) {
          if (space.hasHydratedOnce) {
            let changed = false;
            for (const record of records) {
              // Hub echoes of this device's own acknowledged publish are not
              // remote work and must not light the sync button.
              if (record.hlc.deviceId === this.deps.device.deviceId) continue;
              const applied = space.engine.getRecord(record.recordId);
              if (
                applied !== undefined &&
                compareHlc(record.hlc, applied.hlc) <= 0
              ) {
                continue;
              }
              const current = space.pendingRemoteRecords.get(record.recordId);
              if (
                current === undefined ||
                compareHlc(record.hlc, current.hlc) > 0
              ) {
                space.pendingRemoteRecords.set(record.recordId, record);
                changed = true;
              }
            }
            if (changed) this.pushWorkspaceSyncStatus();
            return;
          }
          // Close the browser-load gate synchronously, before a following
          // workspace URL frame can be handled. Reopen it only after these
          // records have reached Electron's cookie store.
          const epoch = ++space.recordEpoch;
          this.deps.onSessionHydrating?.(spaceId);
          space.recordQueue = space.recordQueue
            .then(async () => {
              await space.engine.applyRemote(records);
            })
            .catch((err: unknown) => {
              space.recordError = err;
              this.logError(err);
            });
          void space.recordQueue.then(() => {
            if (
              this.spaces.get(spaceId) === space &&
              !space.hydrating &&
              space.recordEpoch === epoch
            ) {
              this.deps.onSessionReady?.(spaceId);
            }
          });
        }
      },
      onHydrated: (spaceId) => {
        void this.finishHydration(spaceId).catch((err) => this.logError(err));
      },
      onConverged: () => {
        this.lastConvergedMs = Date.now();
        this.pushStatus();
        this.deps.onConverged?.();
      },
      onPublishRejected: (rejections) => {
        this.rejectionQueue = this.rejectionQueue
          .then(async () => {
            for (const rejection of rejections) {
              for (const space of this.spaces.values()) {
                await space.engine.publishRejected(
                  rejection.recordId,
                  rejection.reason,
                );
              }
            }
          })
          .catch((err: unknown) => this.logError(err));
      },
      onPublishInterrupted: (recordIds) => {
        this.rejectionQueue = this.rejectionQueue
          .then(async () => {
            for (const recordId of recordIds) {
              for (const space of this.spaces.values()) {
                // Reuse the engine's current-winner retry path. The transport
                // is offline before this callback fires, so the record lands
                // in the engine's ordered offline queue and drains on hello.
                await space.engine.publishRejected(recordId, "lease_required");
              }
            }
          })
          .catch((err: unknown) => this.logError(err));
      },
      onPresence: () => {
        this.pushStatus();
        this.deps.onPresenceChanged?.();
      },
      onLeaseRevoked: (spaceId, originId) => {
        this.spaces.get(spaceId)?.engine.leaseRevoked(originId);
      },
      onWorkspaceRecords: (docs) => {
        const workspace = this.workspace;
        if (workspace === null) return;
        const generation = this.syncGeneration;
        this.workspaceQueue = this.workspaceQueue
          .then(async () => {
            if (
              generation !== this.syncGeneration ||
              this.workspace !== workspace
            )
              return;
            await workspace.handleRemoteDocs(docs);
          })
          .catch((err: unknown) => this.logError(err));
      },
      onWorkspaceHydrated: () => {
        const workspace = this.workspace;
        if (workspace === null) return;
        const generation = this.syncGeneration;
        this.workspaceQueue = this.workspaceQueue
          .then(async () => {
            if (
              generation === this.syncGeneration &&
              this.workspace === workspace
            ) {
              await workspace.handleHydrated();
            }
          })
          .catch((err: unknown) => this.logError(err));
      },
      getToken: deps.getToken,
      // Enrolled ⇒ a null token is revoked/expired, not local/dev mode: the
      // transport must not dial the prod hub tokenless and loop (§8.2).
      authRequired: () => this.deps.device.enrollment().state === "enrolled",
    };
    this.transportEvents = events;
    const hubUrl = process.env["SUMA_HUB_URL"];
    this.hubPinnedByEnv = hubUrl !== undefined && hubUrl.length > 0;
    this.hubUrl = this.hubPinnedByEnv ? (hubUrl as string) : null;
    this.transport = this.hubPinnedByEnv
      ? new WsTransport(this.hubUrl as string, deps.device.deviceId, events)
      : new LoopbackTransport(deps.device.deviceId, events);
  }

  /**
   * Point sync at a real hub discovered from the control plane (§7): swap
   * the loopback stub for a WsTransport at runtime, the way the agent link
   * retargets to the VM. SUMA_HUB_URL pins the transport (dev override),
   * and re-announcing the same URL is a no-op.
   */
  setHubUrl(url: string): void {
    if (this.hubPinnedByEnv || url === this.hubUrl) return;
    const previous = this.transport;
    this.hubUrl = url;
    this.transport = new WsTransport(
      url,
      this.deps.device.deviceId,
      this.transportEvents,
    );
    if (!this.started) {
      // Nothing built yet — start() will construct everything on the new one.
      previous.stop();
      this.pushStatus();
      return;
    }
    // The per-space cookie engines captured the OLD transport by value at
    // construction (unlike the workspace stream, which reads this.transport
    // dynamically). A bare swap would leave cookie sync publishing into the
    // dead loopback while tabs alone followed the hub — so rebuild every
    // engine against the new transport. Re-hydration also re-seeds existing
    // cookies (finishHydration → seedExistingCookies) onto the real hub.
    const spaceIds = [...this.declaredSpaceIds];
    this.teardownSyncState();
    previous.stop();
    void this.start(spaceIds).catch((err) => this.logError(err));
  }

  /** Tear down engines/workspace/timers WITHOUT touching the transport, so a
   *  hub swap can rebuild them against the new one. */
  private teardownSyncState(): void {
    this.syncGeneration += 1;
    if (this.snapshotTimer !== null) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.workspace?.stop();
    this.workspace = null;
    for (const space of this.spaces.values()) space.capture.detach();
    this.spaces.clear();
    this.pending.clear();
    this.workspaceQueue = Promise.resolve();
    this.started = false;
  }

  async start(spaceIds: string[]): Promise<void> {
    for (const spaceId of spaceIds) this.declaredSpaceIds.add(spaceId);
    const generation = ++this.syncGeneration;
    this.started = true;
    const workspaceKeys = await deriveSpaceKeys(
      WORKSPACE_PSEUDO_SPACE_ID,
      this.deps.device.workspaceSecret(),
    );
    if (generation !== this.syncGeneration || !this.started) return;
    const workspace = new WorkspaceSyncService({
      deviceId: this.deps.device.deviceId,
      accountId: this.workspaceAccountId(),
      privateKey: this.deps.device.identity.privateKey,
      keys: workspaceKeys,
      store: this.deps.store,
      publish: (docs) => this.transport.publishWorkspace(docs),
      beforeAttachmentPublish: () => this.establishSessionFence(),
      onRemoteApplied: () => this.deps.onWorkspaceApplied?.(),
      onSyncStatusChanged: () => this.pushWorkspaceSyncStatus(),
    });
    this.workspace = workspace;
    workspace.start();
    for (const spaceId of this.declaredSpaceIds) {
      await this.ensureSpace(spaceId, generation);
      if (generation !== this.syncGeneration || !this.started) return;
    }
    this.transport.start([...this.declaredSpaceIds]);
    this.snapshotTimer = setInterval(() => {
      void this.refreshAllSnapshots().catch((err) => this.logError(err));
    }, SNAPSHOT_REFRESH_MS);
    this.snapshotTimer.unref();
  }

  /** Idempotent — used for spaces created after startup (UI or migration). */
  async addSpace(spaceId: string): Promise<void> {
    this.declaredSpaceIds.add(spaceId);
    if (this.spaces.has(spaceId)) return;
    const generation = this.syncGeneration;
    await this.ensureSpace(spaceId, generation);
    if (generation !== this.syncGeneration || !this.started) return;
    this.transport.addSpace(spaceId);
  }

  stop(): void {
    this.syncGeneration += 1;
    this.started = false;
    if (this.snapshotTimer !== null) clearInterval(this.snapshotTimer);
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.workspace?.stop();
    for (const space of this.spaces.values()) space.capture.detach();
    this.transport.stop();
  }

  /** True once a space's stored records have all been applied — the only point
   *  at which "this space has no cookies" is a trustworthy judgement (§8.8). */
  isHydrated(spaceId: string): boolean {
    return this.spaces.get(spaceId)?.hydrating === false;
  }

  workspaceSyncStatus(): WorkspaceSyncStatus {
    const workspace = this.workspace?.syncStatus() ?? {
      remoteReady: false,
      pending: false,
      canonicalPending: false,
      localChanged: false,
      remoteChanged: false,
      sources: [],
    };
    const sessionRemoteChanged = [...this.spaces.values()].some(
      (space) => space.pendingRemoteRecords.size > 0,
    );
    return {
      ...workspace,
      pending: workspace.pending || sessionRemoteChanged,
      canonicalPending: workspace.canonicalPending || sessionRemoteChanged,
      remoteChanged: workspace.remoteChanged || sessionRemoteChanged,
    };
  }

  async synchronizeWorkspace(
    mode: WorkspaceSyncMode,
    sourceDeviceId?: string,
  ): Promise<WorkspaceSyncStatus> {
    if (this.workspace === null) throw new Error("workspace sync is not ready");
    const workspace = this.workspace;
    const generation = this.syncGeneration;
    const operation = this.workspaceQueue.then(async () => {
      if (generation !== this.syncGeneration || this.workspace !== workspace) {
        throw new Error("Sync connection changed — try again");
      }
      // Pull/Merge install cookies first, then materialize any remote URL.
      // This is the explicit causal barrier that prevents Gmail/YouTube from
      // following a redirect before their session exists in Chromium.
      if (mode === "pull" || mode === "merge") {
        await this.applyPendingSessions();
      } else {
        for (const space of this.spaces.values()) {
          await this.pushLocalSessionState(space);
        }
      }
      await workspace.synchronize(mode, sourceDeviceId);
      if (generation !== this.syncGeneration || this.workspace !== workspace) {
        throw new Error("Sync connection changed — try again");
      }
      for (const space of this.spaces.values()) {
        this.deps.onSessionSynchronized?.(space.spaceId);
      }
      this.pushWorkspaceSyncStatus();
    });
    this.workspaceQueue = operation.catch((err: unknown) => {
      this.logError(err);
    });
    await operation;
    return this.workspaceSyncStatus();
  }

  /**
   * The device token or key material changed — re-dial the hub cleanly and
   * re-derive the workspace key (§8.2). Recovery (auth:recoverKeys) replaces
   * the account workspace secret AFTER start() derived the seal/open key from
   * a fresh device's random stand-in, so without re-deriving here the running
   * WorkspaceSyncService would keep using the stale key until an app restart
   * and workspace metadata would never converge.
   */
  refreshAuth(): void {
    void this.rekeyWorkspace().catch((err) => this.logError(err));
  }

  /**
   * Re-derive the workspace seal/open key from the current device workspace
   * secret, hand it to the running WorkspaceSyncService (which republishes
   * every local register under it), and re-dial so the hub re-sends the
   * account docs for us to re-open and converge (§8.2 recovery path).
   */
  async rekeyWorkspace(): Promise<void> {
    if (this.workspace !== null) {
      const keys = await deriveSpaceKeys(
        WORKSPACE_PSEUDO_SPACE_ID,
        this.deps.device.workspaceSecret(),
      );
      this.workspace.rekey(keys, this.workspaceAccountId());
    }
    this.transport.reconnect();
  }

  status(): SyncStatus {
    let queueDepth = 0;
    for (const space of this.spaces.values())
      queueDepth += space.engine.queueDepth;
    return {
      state: this.connectionState(),
      queueDepth,
      lastConvergedMs: this.lastConvergedMs,
      keyMode: this.deps.store.settings().keyMode,
    };
  }

  originInfo(host: string): OriginContinuityInfo {
    const normalized = normalizedHost(host);
    const policy = matchOriginPolicy(SEED_CORPUS, normalized);
    return {
      host: normalized,
      label: policy.domain === "" ? normalized : policy.label,
      mode: policy.mode,
      syncTier: policy.syncTier,
      rotatingAuth: policy.rotatingAuth,
      sensitive: policy.sensitive,
      userOverride: this.overrideFor(normalized),
    };
  }

  setOriginOverride(
    host: string,
    override: "sync" | "never" | null,
  ): OriginContinuityInfo {
    const normalized = normalizedHost(host);
    this.deps.store.setOriginOverride(normalized, override);
    for (const space of this.spaces.values()) {
      space.engine.setOriginOverride(normalized, override);
    }
    // Opting an origin INTO sync must carry the session you already have, not
    // just future logins — otherwise a user turns it on and nothing happens
    // until they re-authenticate. Re-seed existing cookies; the engine's
    // isSynced gate now lets this origin through while still dropping the rest.
    if (override === "sync") {
      for (const space of this.spaces.values()) {
        if (space.hydrating) continue;
        void this.seedExistingCookies(space).catch((err) => this.logError(err));
      }
    }
    return this.originInfo(normalized);
  }

  /** A structured origin hit an anti-bot challenge and moved to Chromium. */
  promoteNativeOrigin(host: string): void {
    const normalized = normalizedHost(host);
    const policy = matchOriginPolicy(SEED_CORPUS, normalized);
    // Unknown assisted origins need an explicit sync opt-in because their
    // conservative corpus default is tier 0. Promotion is that opt-in; an
    // existing user "never" choice remains authoritative.
    if (policy.domain === "" && this.overrideFor(normalized) === null) {
      this.deps.store.setOriginOverride(normalized, "sync");
      for (const space of this.spaces.values())
        space.engine.setOriginOverride(normalized, "sync");
    }
    for (const space of this.spaces.values()) {
      if (space.hydrating) continue;
      void this.activateNativeOrigin(space, normalized).catch((err) =>
        this.logError(err),
      );
    }
  }

  /** Restore an origin's last-known-good state in one space (§8.3 kill switch). */
  async rollbackOrigin(
    host: string,
    spaceId: string,
  ): Promise<{ restored: number }> {
    const space = this.spaces.get(spaceId);
    if (space === undefined)
      throw new Error(`sync is not running for space ${spaceId}`);
    const originId = await computeOriginIdHex(
      space.keys.idKey,
      spaceId,
      normalizedHost(host),
    );
    const snapshot: OriginSnapshot = space.snapshots.get(originId) ?? {
      spaceId,
      originId,
      capturedAtMs: 0,
      records: [],
    };
    await space.engine.rollbackOrigin(originId, snapshot);
    space.snapshots.set(originId, space.engine.snapshotOrigin(originId));
    this.pushStatus();
    return {
      restored: snapshot.records.filter((record) => !record.plain.deleted)
        .length,
    };
  }

  devices(): DevicePresence[] {
    return this.transport.presence();
  }

  pushStatus(): void {
    if (this.statusTimer !== null) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.deps.emitStatus(this.status());
    }, STATUS_DEBOUNCE_MS);
    this.statusTimer.unref();
  }

  /* ------------------------------ internals ------------------------------ */

  private ensureSpace(
    spaceId: string,
    generation = this.syncGeneration,
  ): Promise<void> {
    if (this.spaces.has(spaceId)) return Promise.resolve();
    const pending = this.pending.get(spaceId);
    if (pending !== undefined) return pending;
    const setup = this.setupSpace(spaceId, generation).finally(() => {
      if (this.pending.get(spaceId) === setup) this.pending.delete(spaceId);
    });
    this.pending.set(spaceId, setup);
    return setup;
  }

  private async setupSpace(spaceId: string, generation: number): Promise<void> {
    this.deps.onSessionHydrating?.(spaceId);
    const rootSecret = this.deps.device.spaceRootSecret(spaceId);
    const keys = await deriveSpaceKeys(spaceId, rootSecret);
    if (generation !== this.syncGeneration || !this.started) return;
    const ses = this.deps.sessionFor(spaceId);
    // v0 registry knows only this device; unknown devices are accepted until
    // the control plane serves the enrolled-device key registry (Phase 1) —
    // the caveat is documented in docs/security-model.md. Tampered or
    // mis-signed records from KNOWN devices are already rejected.
    const verifier = new DeviceRegistryVerifier("accept");
    verifier.addDevice(
      this.deps.device.deviceId,
      this.deps.device.identity.publicKey,
    );
    const engine = new SpaceSyncEngine(
      spaceId,
      keys,
      {
        deviceId: this.deps.device.deviceId,
        privateKey: this.deps.device.identity.privateKey,
      },
      this.transport,
      new ElectronCookieApplier(ses, (host, name) =>
        this.cookieHandledElsewhere(host, name),
      ),
      { deviceId: this.deps.device.deviceId, verifier },
    );
    for (const [host, override] of Object.entries(
      this.deps.store.originOverrides(),
    )) {
      engine.setOriginOverride(host, override);
    }
    engine.setOnline(this.transport.state === "connected");
    await engine.beginHydration();
    const state: SpaceSyncState = {
      spaceId,
      engine,
      keys,
      hydrating: true,
      recordQueue: Promise.resolve(),
      recordError: null,
      capture: { detach: () => undefined, drain: async () => undefined },
      recordEpoch: 0,
      hasHydratedOnce: false,
      pendingRemoteRecords: new Map(),
      snapshots: new Map(),
    };
    state.capture = attachCookieCapture(
      ses,
      spaceId,
      engine,
      () => state.hydrating,
      (err) => this.logError(err),
      (cookie) => this.cookieHandledElsewhere(cookie.domain ?? "", cookie.name),
    );
    if (generation !== this.syncGeneration || !this.started) {
      state.capture.detach();
      return;
    }
    this.spaces.set(spaceId, state);
  }

  /**
   * Establish a causal fence between auth state and a manual tab publication.
   * Chromium first gets an event-loop turn to report Set-Cookie mutations;
   * capture and offline queues then drain; finally SessionHub must acknowledge
   * those records before the workspace URL is allowed onto the same socket.
   */
  private async establishSessionFence(): Promise<boolean> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (
      this.deps.beforeGatewaySessionFence !== undefined &&
      !(await this.deps.beforeGatewaySessionFence())
    ) {
      return false;
    }
    const spaces = [...this.spaces.values()];
    await Promise.all(spaces.map((space) => space.capture.drain()));
    await Promise.all(spaces.map((space) => space.engine.flushPending()));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.transport.flushCookiePublishes()) return true;
      // A lease_required ack schedules recovery in onPublishRejected. Await
      // that work and any queue it created before fencing the retry's ack.
      await this.rejectionQueue;
      await Promise.all(spaces.map((space) => space.engine.flushPending()));
    }
    return false;
  }

  private async finishHydration(spaceId: string): Promise<void> {
    const space = this.spaces.get(spaceId);
    if (space === undefined || !space.hydrating) return;
    // hydrate.done is only the end of the wire stream. The corresponding
    // record frame handlers may still be decrypting and writing Chromium's
    // cookie store, so tabs are not safe to load until this queue drains.
    await space.recordQueue;
    if (this.spaces.get(spaceId) !== space || !space.hydrating) return;
    if (space.recordError !== null) {
      // Never open tabs after a partial cookie hydrate. Re-dial for a complete
      // snapshot while the navigation barrier remains closed.
      setTimeout(() => {
        if (
          this.spaces.get(spaceId) === space &&
          !space.hasHydratedOnce &&
          space.hydrating
        ) {
          this.transport.reconnect();
        }
      }, SESSION_HYDRATION_RETRY_MS).unref();
      return;
    }
    await space.engine.endHydration();
    space.hydrating = false;
    // Publish cookies that already existed in this session before Suma
    // started watching — the whole point of continuity is carrying the logins
    // you ALREADY have, and the 'changed' listener only ever sees future
    // mutations (§8.3). Runs after hydration so it can skip anything a peer
    // already sent (hasRecord), which also prevents a stale local value from
    // clobbering the peer's newer one.
    await this.seedExistingCookies(space);
    await this.refreshSnapshots(space);
    space.hasHydratedOnce = true;
    this.lastConvergedMs = Date.now();
    this.pushStatus();
    this.deps.onSessionReady?.(spaceId);
  }

  private async applyPendingSessions(): Promise<void> {
    for (const space of this.spaces.values()) {
      if (space.pendingRemoteRecords.size === 0) continue;
      const records = [...space.pendingRemoteRecords.values()].sort((a, b) =>
        compareHlc(a.hlc, b.hlc),
      );
      this.deps.onSessionHydrating?.(space.spaceId);
      await space.engine.beginHydration();
      try {
        await space.engine.applyRemote(records);
        space.pendingRemoteRecords.clear();
      } finally {
        await space.engine.endHydration();
        this.deps.onSessionReady?.(space.spaceId);
      }
    }
  }

  /** Make the local cookie set authoritative, including remote-only deletion. */
  private async pushLocalSessionState(space: SpaceSyncState): Promise<void> {
    const ses = this.deps.sessionFor(space.spaceId);
    const localRecordIds = new Set<string>();
    try {
      for (const cookie of await ses.cookies.get({})) {
        const identity = identityForCookie(space.spaceId, cookie);
        localRecordIds.add(
          await computeRecordIdHex(space.keys.idKey, identity),
        );
      }
    } catch (err) {
      this.logError(err);
      throw new Error("Could not read this Mac's session state");
    }

    for (const record of space.pendingRemoteRecords.values()) {
      if (localRecordIds.has(record.recordId)) continue;
      const identity = await space.engine.inspectRemoteIdentity(record);
      if (identity === null) continue;
      await space.engine.localChange(identity, null, true, "explicit");
    }
    space.pendingRemoteRecords.clear();
    await this.seedExistingCookies(space, undefined, true);
  }

  /** One-time reconcile: feed pre-existing local cookies the engine hasn't
   *  already recorded into the publish path (policy-gated inside the engine). */
  private async seedExistingCookies(
    space: SpaceSyncState,
    onlyHost?: string,
    force = false,
  ): Promise<void> {
    const ses = this.deps.sessionFor(space.spaceId);
    let cookies: Awaited<ReturnType<typeof ses.cookies.get>>;
    try {
      cookies = await ses.cookies.get({});
    } catch (err) {
      this.logError(err);
      return;
    }
    let seeded = 0;
    for (const cookie of cookies) {
      const host = normalizedHost(cookie.domain ?? "");
      if (
        onlyHost !== undefined &&
        host !== onlyHost &&
        !host.endsWith(`.${onlyHost}`)
      )
        continue;
      if (this.cookieHandledElsewhere(host, cookie.name)) continue;
      const identity = identityForCookie(space.spaceId, cookie);
      try {
        if (!force && (await space.engine.hasRecord(identity))) continue;
        const wire = await space.engine.localChange(
          identity,
          attributesForCookie(cookie),
          false,
          "explicit",
        );
        if (wire !== null) seeded += 1;
      } catch (err) {
        this.logError(err);
      }
    }
    console.log(
      `[suma cookie-sync] space ${space.spaceId}: ${cookies.length} local cookie(s), ` +
        `${seeded} newly published to the hub (rest already synced or policy-blocked)`,
    );
  }

  private async activateNativeOrigin(
    space: SpaceSyncState,
    host: string,
  ): Promise<void> {
    // This device's current browser state wins first. A newly joining device
    // with no local cookie then receives the stored peer winner in reapply.
    await this.seedExistingCookies(space, host, true);
    await space.engine.reapplyOrigin(host);
  }

  private async refreshAllSnapshots(): Promise<void> {
    for (const space of this.spaces.values()) {
      if (!space.hydrating) await this.refreshSnapshots(space);
    }
  }

  private async refreshSnapshots(space: SpaceSyncState): Promise<void> {
    const originIds = new Set<string>();
    for (const plain of space.engine.listLiveCookies()) {
      originIds.add(
        await computeOriginIdHex(
          space.keys.idKey,
          space.spaceId,
          plain.identity.hostKey,
        ),
      );
    }
    for (const originId of originIds) {
      space.snapshots.set(originId, space.engine.snapshotOrigin(originId));
    }
  }

  private connectionState(): SyncConnectionState {
    switch (this.transport.state) {
      case "connected":
        return "connected";
      case "connecting":
        return "connecting";
      case "offline":
        // §10: session plane unreachable ⇒ "Sync paused" pill + queue depth;
        // mutations keep queueing locally.
        return "paused";
    }
  }

  private cookieHandledElsewhere(host: string, name: string): boolean {
    return (
      isDeviceLocalCookieName(name) ||
      this.deps.gatewayOwnsHost?.(host) === true
    );
  }

  private workspaceAccountId(): string {
    return (
      this.deps.device.enrollment().userId ??
      `local:${this.deps.device.deviceId}`
    );
  }

  private overrideFor(host: string): "sync" | "never" | null {
    let bestDomain: string | null = null;
    let bestOverride: "sync" | "never" | null = null;
    for (const [domain, override] of Object.entries(
      this.deps.store.originOverrides(),
    )) {
      const matches = host === domain || host.endsWith(`.${domain}`);
      if (
        matches &&
        (bestDomain === null || domain.length > bestDomain.length)
      ) {
        bestDomain = domain;
        bestOverride = override;
      }
    }
    return bestOverride;
  }

  private logError(err: unknown): void {
    console.error("suma sync:", err);
  }

  private pushWorkspaceSyncStatus(): void {
    this.deps.onWorkspaceSyncChanged?.(this.workspaceSyncStatus());
  }
}
