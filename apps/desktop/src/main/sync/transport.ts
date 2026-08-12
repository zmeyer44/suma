/**
 * Transports for the space sync engine (PRD §8.3).
 *
 * LoopbackTransport — in-process stub hub over an in-memory record store, so
 * the engine pipeline (seal → sign → publish → lease → hydrate) runs
 * end-to-end today with no network.
 *
 * WsTransport — SessionHub client (services/sessionhub) used when
 * SUMA_HUB_URL is set: connect/backoff, frame parsing, workspace-doc
 * frames, and control-plane device-token auth on the upgrade request.
 */

import { clearTimeout, setTimeout } from "node:timers";
import {
  compareHlc,
  parseServerMessage,
  type ClientMessage,
  type CookieRecordWire,
  type DevicePresence,
  type PublishRejection,
  type WorkspaceRecordWire,
} from "@suma/protocol";
import type { SyncTransport } from "@suma/sync-engine";

export type TransportState = "connecting" | "connected" | "offline";

export interface TransportEvents {
  onStateChanged?: (state: TransportState) => void;
  onRecords?: (spaceId: string, records: CookieRecordWire[]) => void;
  /** Hydration finished for a space (empty hydration included). */
  onHydrated?: (spaceId: string) => void;
  /** The hub acknowledged our state (publish ack / hydrate done). */
  onConverged?: () => void;
  /** Records the hub refused after an optimistic fire-and-forget publish. */
  onPublishRejected?: (rejections: readonly PublishRejection[]) => void;
  /** The socket disappeared before these records were acknowledged. The
   * engine must put their current winners back in its offline queue. */
  onPublishInterrupted?: (recordIds: readonly string[]) => void;
  onPresence?: (devices: DevicePresence[]) => void;
  /** A forced rotating-auth handoff moved the writer lease to another Mac. */
  onLeaseRevoked?: (spaceId: string, originId: string) => void;
  /** Workspace metadata docs from the hub (fan-out or hydration, §8.3). */
  onWorkspaceRecords?: (docs: WorkspaceRecordWire[]) => void;
  /** Workspace hydration finished — safe to reconcile-publish local docs. */
  onWorkspaceHydrated?: () => void;
  /**
   * Control-plane device token for the hub edge (§8.2); resolve null while
   * unenrolled. Fetched fresh on every dial so refreshed tokens are picked up.
   */
  getToken?: () => Promise<string | null>;
  /**
   * True once this device is ENROLLED (§8.2). Enrolled + null token means the
   * token was revoked/expired, not that we are in local/dev mode — the
   * transport must NOT dial the prod hub tokenless (and loop) in that case.
   */
  authRequired?: () => boolean;
}

/** Outcome of the pre-dial auth check (pure — unit-tested directly). */
export type DialDecision = "dial" | "dial-tokenless" | "await-auth";

/**
 * Decide how to dial given the freshly fetched token and whether auth is
 * required (device enrolled). A present token always dials authenticated;
 * a null token dials tokenless ONLY when auth is not required (local/dev hub).
 * Enrolled + null token yields "await-auth": stay offline, no reconnect storm.
 */
export function decideDial(
  token: string | null,
  authRequired: boolean,
): DialDecision {
  if (token !== null && token.length > 0) return "dial";
  return authRequired ? "await-auth" : "dial-tokenless";
}

export interface HubTransport extends SyncTransport {
  readonly state: TransportState;
  start(spaceIds: string[]): void;
  addSpace(spaceId: string): void;
  stop(): void;
  /** Cleanly tear down and re-dial — token or declared-space-set changes. */
  reconnect(): void;
  presence(): DevicePresence[];
  /** Resolve only after the hub has acknowledged every cookie publish sent so
   * far. False means the socket disappeared, an ack timed out, or a record was
   * rejected and has not yet been successfully retried. */
  flushCookiePublishes(): Promise<boolean>;
  publishWorkspace(docs: WorkspaceRecordWire[]): void;
}

/* ---------------------------------------------------------------------- *
 * Loopback
 * ---------------------------------------------------------------------- */

export class LoopbackTransport implements HubTransport {
  state: TransportState = "connecting";
  private readonly records = new Map<string, CookieRecordWire>();
  private readonly workspaceDocs = new Map<string, WorkspaceRecordWire>();
  private readonly leases = new Map<string, string>();
  private readonly spaceIds: string[] = [];

  constructor(
    private readonly deviceId: string,
    private readonly events: TransportEvents = {},
  ) {}

  start(spaceIds: string[]): void {
    for (const spaceId of spaceIds) {
      if (!this.spaceIds.includes(spaceId)) this.spaceIds.push(spaceId);
    }
    this.setState("connected");
    for (const spaceId of this.spaceIds) this.events.onHydrated?.(spaceId);
    this.events.onWorkspaceHydrated?.();
    this.events.onConverged?.();
  }

  addSpace(spaceId: string): void {
    if (this.spaceIds.includes(spaceId)) return;
    this.spaceIds.push(spaceId);
    if (this.state === "connected") this.events.onHydrated?.(spaceId);
  }

  stop(): void {
    this.setState("offline");
  }

  reconnect(): void {
    // In-process — there is no connection to re-establish.
  }

  publish(records: CookieRecordWire[]): void {
    for (const record of records) {
      const current = this.records.get(record.recordId);
      if (current === undefined || compareHlc(record.hlc, current.hlc) > 0) {
        this.records.set(record.recordId, record);
      }
    }
    this.events.onConverged?.();
  }

  publishWorkspace(docs: WorkspaceRecordWire[]): void {
    for (const doc of docs) {
      const current = this.workspaceDocs.get(doc.key);
      if (current === undefined || compareHlc(doc.hlc, current.hlc) > 0) {
        this.workspaceDocs.set(doc.key, doc);
      }
    }
    this.events.onConverged?.();
  }

  async flushCookiePublishes(): Promise<boolean> {
    return true;
  }

  async acquireLease(
    spaceId: string,
    originId: string,
    force?: boolean,
    _candidate?: Pick<CookieRecordWire, "recordId" | "hlc">,
  ): Promise<boolean> {
    const key = `${spaceId}:${originId}`;
    const holder = this.leases.get(key);
    if (holder !== undefined && holder !== this.deviceId && force !== true)
      return false;
    this.leases.set(key, this.deviceId);
    return true;
  }

  releaseLease(spaceId: string, originId: string): void {
    const key = `${spaceId}:${originId}`;
    if (this.leases.get(key) === this.deviceId) this.leases.delete(key);
  }

  presence(): DevicePresence[] {
    return [
      {
        deviceId: this.deviceId,
        online: this.state === "connected",
        lastSeenMs: Date.now(),
      },
    ];
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChanged?.(state);
  }
}

/* ---------------------------------------------------------------------- *
 * WebSocket skeleton (SessionHub)
 * ---------------------------------------------------------------------- */

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ): void;
}

type WsCtor = new (url: string) => WsLike;

const WS_OPEN = 1;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const LEASE_TIMEOUT_MS = 5_000;
const PUBLISH_ACK_TIMEOUT_MS = 10_000;
/** Enrolled-but-tokenless: re-check for a token slowly, never a reconnect storm. */
const AUTH_WAIT_RETRY_MS = MAX_BACKOFF_MS;

export class WsTransport implements HubTransport {
  state: TransportState = "offline";
  private socket: WsLike | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private spaceIds: string[] = [];
  private stopped = false;
  private connectSeq = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly pendingLeases = new Map<
    string,
    { promise: Promise<boolean>; resolve: (granted: boolean) => void }
  >();
  private readonly pendingCookiePublishes = new Set<string>();
  private readonly rejectedCookiePublishes = new Set<string>();
  private readonly cookieFlushWaiters = new Set<{
    resolve: (confirmed: boolean) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly presenceCache = new Map<string, DevicePresence>();

  constructor(
    private readonly url: string,
    private readonly deviceId: string,
    private readonly events: TransportEvents = {},
  ) {}

  start(spaceIds: string[]): void {
    this.spaceIds = [...spaceIds];
    this.stopped = false;
    this.connect();
  }

  addSpace(spaceId: string): void {
    if (this.spaceIds.includes(spaceId)) return;
    this.spaceIds.push(spaceId);
    // The hub scopes publishes to the spaces declared in the hello frame, so
    // a changed space set redeclares via a clean reconnect (fresh hello +
    // hydrate) until the protocol grows a rebind frame.
    if (this.state === "connected") this.reconnect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pendingLeases.values()) pending.resolve(false);
    this.pendingLeases.clear();
    this.failCookieFlushes();
    this.socket?.close();
    this.socket = null;
    this.setState("offline");
  }

  /** Cleanly tear down and re-dial — the token or space set changed (§8.2). */
  reconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null; // the old socket's close event must not double-dial
    for (const pending of this.pendingLeases.values()) pending.resolve(false);
    this.pendingLeases.clear();
    const interrupted = this.failCookieFlushes();
    this.setState("offline");
    if (interrupted.length > 0) this.events.onPublishInterrupted?.(interrupted);
    socket?.close();
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.connect();
  }

  publish(records: CookieRecordWire[]): void {
    // When disconnected the engine is offline (setOnline(false)) and queues
    // locally; anything racing the transition is dropped here, not lost —
    // the record is already in the engine's store.
    if (this.state !== "connected") return;
    for (const record of records) {
      this.pendingCookiePublishes.add(record.recordId);
      // A retry supersedes the failure from the previous attempt. The next
      // ack decides whether the causal navigation fence may open.
      this.rejectedCookiePublishes.delete(record.recordId);
    }
    this.send({ t: "publish", records });
  }

  async flushCookiePublishes(): Promise<boolean> {
    if (this.state !== "connected") return false;
    if (this.pendingCookiePublishes.size === 0) {
      return this.rejectedCookiePublishes.size === 0;
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.cookieFlushWaiters.delete(waiter);
          resolve(false);
        }, PUBLISH_ACK_TIMEOUT_MS),
      };
      waiter.timer.unref();
      this.cookieFlushWaiters.add(waiter);
    });
  }

  publishWorkspace(docs: WorkspaceRecordWire[]): void {
    // Offline drops are safe: the local LWW registers are the durable state,
    // and every (re)connection reconciles by republishing after hydration.
    if (this.state !== "connected" || docs.length === 0) return;
    this.send({ t: "workspace.publish", docs });
  }

  async acquireLease(
    spaceId: string,
    originId: string,
    force?: boolean,
    candidate?: Pick<CookieRecordWire, "recordId" | "hlc">,
  ): Promise<boolean> {
    if (this.state !== "connected") return false;
    const key = `${spaceId}:${originId}`;
    const existing = this.pendingLeases.get(key);
    if (existing !== undefined) return existing.promise;
    let settle: (granted: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        settle(false);
      }, LEASE_TIMEOUT_MS);
      timer.unref();
      settle = (granted) => {
        clearTimeout(timer);
        if (this.pendingLeases.get(key)?.promise === promise)
          this.pendingLeases.delete(key);
        resolve(granted);
      };
    });
    this.pendingLeases.set(key, {
      promise,
      resolve: (granted) => settle(granted),
    });
    const frame: ClientMessage = { t: "lease.acquire", spaceId, originId };
    this.send(
      force === true
        ? {
            ...frame,
            force: true,
            recordId: candidate?.recordId,
            candidateHlc: candidate?.hlc,
          }
        : frame,
    );
    return promise;
  }

  releaseLease(spaceId: string, originId: string): void {
    if (this.state !== "connected") return;
    this.send({ t: "lease.release", spaceId, originId });
  }

  presence(): DevicePresence[] {
    const merged = new Map<string, DevicePresence>(this.presenceCache);
    merged.set(this.deviceId, {
      deviceId: this.deviceId,
      online: this.state === "connected",
      lastSeenMs: Date.now(),
    });
    return [...merged.values()];
  }

  private connect(): void {
    const Ws = (globalThis as Record<string, unknown>)["WebSocket"] as
      | WsCtor
      | undefined;
    if (Ws === undefined) {
      console.warn(
        "suma: no WebSocket implementation available; sync stays offline",
      );
      this.setState("offline");
      return;
    }
    this.setState("connecting");
    const seq = ++this.connectSeq;
    void this.dial(Ws, seq);
  }

  private async dial(Ws: WsCtor, seq: number): Promise<void> {
    // Auth (§8.2): the control-plane device token rides as an `access_token`
    // query parameter on the upgrade URL — WebSocket clients cannot portably
    // set an Authorization header on the upgrade request, so the hub edge
    // reads the query parameter (and still accepts Authorization from
    // clients that can send it). Null token = unenrolled: the hub falls back
    // to trusting the hello frame's deviceId (dev mode).
    let token: string | null = null;
    try {
      token = (await this.events.getToken?.()) ?? null;
    } catch {
      token = null;
    }
    if (this.stopped || seq !== this.connectSeq) return;
    const decision = decideDial(token, this.events.authRequired?.() ?? false);
    if (decision === "await-auth") {
      // Enrolled but the token is revoked/expired: dialing the prod hub
      // tokenless would just loop. Go offline and wait; refreshAuth()/
      // reconnect() re-dials the instant a token is available, and a slow
      // timer re-checks in case one is minted without an explicit refresh.
      this.setState("offline");
      this.scheduleAuthRetry();
      return;
    }
    const url =
      decision === "dial-tokenless"
        ? this.url
        : `${this.url}${this.url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token as string)}`;
    const socket = new Ws(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.send({
        t: "hello",
        deviceId: this.deviceId,
        spaceIds: [...this.spaceIds],
      });
    });
    socket.addEventListener("message", (event) => {
      this.handleFrame(String(event.data));
    });
    socket.addEventListener("close", () => this.scheduleReconnect(socket));
    socket.addEventListener("error", () => undefined); // close always follows
  }

  /** Enrolled + no token: re-check on a slow cadence instead of hammering. */
  private scheduleAuthRetry(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, AUTH_WAIT_RETRY_MS);
    this.reconnectTimer.unref();
  }

  private scheduleReconnect(socket: WsLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const pending of this.pendingLeases.values()) pending.resolve(false);
    this.pendingLeases.clear();
    const interrupted = this.failCookieFlushes();
    this.setState("offline");
    if (interrupted.length > 0) this.events.onPublishInterrupted?.(interrupted);
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.reconnectTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private handleFrame(raw: string): void {
    let msg: ReturnType<typeof parseServerMessage>;
    try {
      msg = parseServerMessage(raw);
    } catch {
      return; // both sides validate; drop malformed frames
    }
    switch (msg.t) {
      case "hello.ack":
        this.setState("connected");
        for (const device of msg.presence)
          this.presenceCache.set(device.deviceId, device);
        this.events.onPresence?.(this.presence());
        for (const spaceId of this.spaceIds) {
          this.send({ t: "hydrate", spaceId, sinceHlc: null });
        }
        this.send({ t: "workspace.hydrate", sinceHlc: null });
        break;
      case "records":
        this.events.onRecords?.(msg.spaceId, msg.records);
        break;
      case "hydrate.done":
        this.events.onHydrated?.(msg.spaceId);
        this.events.onConverged?.();
        break;
      case "publish.ack":
        for (const recordId of msg.accepted) {
          this.pendingCookiePublishes.delete(recordId);
          this.rejectedCookiePublishes.delete(recordId);
        }
        for (const rejection of msg.rejected) {
          this.pendingCookiePublishes.delete(rejection.recordId);
          // `stale` means SessionHub already has this exact record or a newer
          // winner. That is a valid durability fence (and is the expected ack
          // when a lost-ack reconnect republishes an already-stored record).
          if (rejection.reason === "stale")
            this.rejectedCookiePublishes.delete(rejection.recordId);
          else this.rejectedCookiePublishes.add(rejection.recordId);
        }
        if (msg.rejected.length > 0)
          this.events.onPublishRejected?.(msg.rejected);
        this.settleCookieFlushes();
        this.events.onConverged?.();
        break;
      case "lease.granted":
        this.resolveLease(msg.spaceId, msg.originId, true);
        break;
      case "lease.denied":
        this.resolveLease(msg.spaceId, msg.originId, false);
        break;
      case "lease.revoked":
        this.events.onLeaseRevoked?.(msg.spaceId, msg.originId);
        break;
      case "workspace.records":
        this.events.onWorkspaceRecords?.(msg.docs);
        break;
      case "workspace.hydrate.done":
        this.events.onWorkspaceHydrated?.();
        this.events.onConverged?.();
        break;
      case "presence":
        for (const device of msg.devices)
          this.presenceCache.set(device.deviceId, device);
        this.events.onPresence?.(this.presence());
        break;
      default:
        break;
    }
  }

  private resolveLease(
    spaceId: string,
    originId: string,
    granted: boolean,
  ): void {
    const key = `${spaceId}:${originId}`;
    this.pendingLeases.get(key)?.resolve(granted);
  }

  private settleCookieFlushes(): void {
    if (this.pendingCookiePublishes.size > 0) return;
    const confirmed = this.rejectedCookiePublishes.size === 0;
    for (const waiter of this.cookieFlushWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(confirmed);
    }
    this.cookieFlushWaiters.clear();
  }

  private failCookieFlushes(): string[] {
    const interrupted = [...this.pendingCookiePublishes];
    this.pendingCookiePublishes.clear();
    this.rejectedCookiePublishes.clear();
    for (const waiter of this.cookieFlushWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.cookieFlushWaiters.clear();
    return interrupted;
  }

  private send(msg: ClientMessage): void {
    if (this.socket !== null && this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChanged?.(state);
  }
}
