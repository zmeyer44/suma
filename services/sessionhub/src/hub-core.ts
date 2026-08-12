/**
 * Session Plane decision logic (PRD §7, §8.3), pure and workerd-free.
 *
 * HubCore only ever handles sealed records and pseudonymous ids: it reads
 * spaceId/recordId/originId/hlc for routing and ordering, and never opens
 * `sealedRecord`/`sealedValue` or verifies their contents (I-1, §8.3 metadata
 * minimization — devices verify signatures on receipt; the server echoes
 * `deviceSig` through untouched).
 */

import {
  MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE,
  ORIGIN_LEASE_TTL_MS,
} from "@suma/config";
import {
  compareHlc,
  encodeHlc,
  hlcSchema,
  parseClientMessage,
  sortByHlc,
  type ClientMessage,
  type CookieRecordWire,
  type DevicePresence,
  type Hlc,
  type PublishRejection,
  type ServerMessage,
  type WorkspaceRecordWire,
} from "@suma/protocol";
import { z } from "zod";

export const HYDRATE_CHUNK_SIZE = 256;
export const RATE_WINDOW_MS = 60_000;
export const MAX_LEASE_TTL_MS = ORIGIN_LEASE_TTL_MS * 5;
/** Versions retained per (spaceId, recordId) so fresh devices can walk causal
 * chains (e.g. tombstone → rewrite → rewrite) during hydration. */
export const MAX_RECORD_HISTORY = 8;
/** Cap on spaces a device may declare in hello. */
export const MAX_DECLARED_SPACES = 64;

export const hydrateRequestSchema = z.object({
  spaceId: z.string().min(1),
  sinceHlc: hlcSchema.nullable(),
});
export type HydrateRequest = z.infer<typeof hydrateRequestSchema>;

/** Body of POST /v1/admin/revoke — userId routes at the edge, deviceId is
 * what the DO revokes. */
export const revokeRequestSchema = z.object({
  userId: z.string().min(1),
  deviceId: z.string().min(1),
});
export type RevokeRequest = z.infer<typeof revokeRequestSchema>;

/** WS close code for a revoked device (control-plane revocation, PRD §12). */
export const CLOSE_REVOKED = 4003;

/** Minimal key-value surface HubCore needs; bound to DO storage in production
 * and to an in-memory map in tests. */
export interface HubStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

/** One connected socket. `deviceId` is null until bound — by the
 * edge-verified `x-suma-device` header at accept, or by the hello frame in
 * stub mode. */
export interface HubConnection {
  deviceId: string | null;
  /** Stable for one physical socket and persisted through hibernation. */
  connectionId: string;
  spaceIds: string[];
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

interface PresenceEntry {
  deviceId: string;
  lastSeenMs: number;
}

interface LeaseEntry {
  spaceId: string;
  originId: string;
  holderDeviceId: string;
  expiresAtMs: number;
}

const recKey = (spaceId: string, recordId: string): string =>
  `rec:${spaceId}:${recordId}`;
/** encodeHlc sorts lexicographically in HLC order, so a prefix list over
 * `hist:<spaceId>:<recordId>:` yields versions oldest-first. */
const histKey = (spaceId: string, recordId: string, hlc: Hlc): string =>
  `hist:${spaceId}:${recordId}:${encodeHlc(hlc)}`;
const histPrefix = (spaceId: string, recordId: string): string =>
  `hist:${spaceId}:${recordId}:`;
const wmKey = (spaceId: string): string => `wm:${spaceId}`;
const leaseKey = (spaceId: string, originId: string): string =>
  `lease:${spaceId}:${originId}`;
const workspaceKey = (key: string): string => `ws:${key}`;
const presenceKey = (deviceId: string): string => `presence:${deviceId}`;
const rateKey = (deviceId: string, originId: string): string =>
  `rl:${deviceId}:${originId}`;
/** Declared spaces are owned by a physical socket, not merely a device. A
 * reconnect briefly has two sockets with the same device id; per-connection
 * keys prevent the stale socket's close handler from deleting its replacement. */
const legacyConnKey = (deviceId: string): string => `conn:${deviceId}`;
const connPrefix = (deviceId: string): string => `conn:${deviceId}:`;
export const connectionStorageKey = (
  deviceId: string,
  connectionId: string,
): string => `${connPrefix(deviceId)}${connectionId}`;
/** Durable revocation set — a revoked device stays out even though its
 * short-lived token may still verify (tokens cannot be un-signed). */
const revokedKey = (deviceId: string): string => `revoked:${deviceId}`;

type Msg<T extends ClientMessage["t"]> = Extract<ClientMessage, { t: T }>;

export class HubCore {
  constructor(
    private readonly storage: HubStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async handleMessage(
    sender: HubConnection,
    raw: string,
    others: readonly HubConnection[],
  ): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(raw);
    } catch {
      sender.send({
        t: "error",
        code: "malformed",
        message: "frame failed validation",
      });
      return;
    }
    if (msg.t === "hello") {
      await this.handleHello(sender, msg, others);
      return;
    }
    const deviceId = sender.deviceId;
    if (deviceId === null) {
      sender.send({
        t: "error",
        code: "hello_required",
        message: "send hello before other frames",
      });
      return;
    }
    // Re-check revocation on every frame, not just at hello: if the admin
    // close raced an already-open socket (or was missed), the device's next
    // frame still terminates the session — bounding a revoked device's sync
    // to its next message rather than the socket's lifetime (§8.2).
    if (await this.isRevoked(deviceId)) {
      sender.close(CLOSE_REVOKED, "revoked");
      return;
    }
    // The declared space set lives in DO storage, not the size-capped socket
    // attachment. It is scoped to this physical connection so a stale close
    // can never erase a replacement socket's subscription.
    sender.spaceIds = await this.declaredSpaces(deviceId, sender.connectionId);
    switch (msg.t) {
      case "publish":
        return this.handlePublish(sender, deviceId, msg, others);
      case "hydrate":
        return this.handleHydrate(sender, msg);
      case "lease.acquire":
        return this.handleLeaseAcquire(sender, deviceId, msg, others);
      case "lease.release":
        return this.handleLeaseRelease(deviceId, msg);
      case "rollback":
        return this.handleRollback(sender, msg, others);
      case "workspace.publish":
        return this.handleWorkspacePublish(msg, others);
      case "workspace.hydrate":
        return this.handleWorkspaceHydrate(sender, msg);
      case "ping":
        sender.send({ t: "pong" });
        return;
    }
  }

  async handleClose(
    conn: HubConnection,
    others: readonly HubConnection[],
  ): Promise<void> {
    const deviceId = conn.deviceId;
    if (deviceId === null) return;
    await this.storage.delete(
      connectionStorageKey(deviceId, conn.connectionId),
    );
    // A reconnect opens the replacement socket before the stale one closes:
    // while any other connection for this device is open, closing this one
    // must neither broadcast offline nor drop the stored space set.
    if (others.some((peer) => peer.deviceId === deviceId)) return;
    // revokeDevice already cleared this device's state and broadcast offline;
    // the close of the socket it revoked must not resurrect presence.
    if (await this.isRevoked(deviceId)) return;
    // The WebSocket close callback's peer snapshot can predate a replacement
    // hello. Check durable per-connection bindings too; this is the race that
    // previously let an old close mark a live replacement offline.
    if ((await this.connectionBindings(deviceId)).size > 0) return;
    // A closed device cannot remain the rotating-auth writer. Releasing its
    // leases immediately avoids making another Mac wait for the TTL merely
    // because the process or network disappeared before sending release.
    const leases = await this.storage.list<LeaseEntry>({ prefix: "lease:" });
    for (const [key, lease] of leases) {
      if (lease.holderDeviceId === deviceId) await this.storage.delete(key);
    }
    // Re-check after async lease cleanup. If a replacement hello landed while
    // this close handler yielded, it is authoritative and stays online.
    if ((await this.connectionBindings(deviceId)).size > 0) return;
    await this.storage.delete(legacyConnKey(deviceId));
    const nowMs = this.now();
    await this.storage.put<PresenceEntry>(presenceKey(deviceId), {
      deviceId,
      lastSeenMs: nowMs,
    });
    const update: DevicePresence = {
      deviceId,
      online: false,
      lastSeenMs: nowMs,
    };
    for (const peer of others) peer.send({ t: "presence", devices: [update] });
  }

  /** Full-space snapshot streaming every retained version (up to
   * MAX_RECORD_HISTORY per record) in HLC-ascending order — shared by the WS
   * hydrate frame and the POST /v1/hub/hydrate fast path. */
  async hydrateSpace(
    spaceId: string,
    sinceHlc: Hlc | null,
  ): Promise<{ records: CookieRecordWire[]; watermark: Hlc | null }> {
    const versions = new Map<string, CookieRecordWire>();
    const consider = (record: CookieRecordWire): void => {
      if (record.spaceId !== spaceId) return;
      if (sinceHlc !== null && compareHlc(record.hlc, sinceHlc) <= 0) return;
      versions.set(`${record.recordId}@${encodeHlc(record.hlc)}`, record);
    };
    const history = await this.storage.list<CookieRecordWire>({
      prefix: `hist:${spaceId}:`,
    });
    for (const record of history.values()) consider(record);
    // The latest version is also in history; the map dedupes it. Records
    // stored before history existed still hydrate via this pass.
    const latest = await this.storage.list<CookieRecordWire>({
      prefix: `rec:${spaceId}:`,
    });
    for (const record of latest.values()) consider(record);
    const watermark = (await this.storage.get<Hlc>(wmKey(spaceId))) ?? null;
    return { records: sortByHlc([...versions.values()]), watermark };
  }

  private async connectionBindings(
    deviceId: string,
  ): Promise<Map<string, string[]>> {
    return this.storage.list<string[]>({ prefix: connPrefix(deviceId) });
  }

  private async declaredSpaces(
    deviceId: string,
    connectionId: string,
  ): Promise<string[]> {
    const current = await this.storage.get<string[]>(
      connectionStorageKey(deviceId, connectionId),
    );
    if (current !== undefined) return current;
    // Rolling-deploy compatibility: hibernated sockets created by the prior
    // version have only the device-wide key until their next hello/reconnect.
    return (await this.storage.get<string[]>(legacyConnKey(deviceId))) ?? [];
  }

  async isRevoked(deviceId: string): Promise<boolean> {
    return (await this.storage.get(revokedKey(deviceId))) !== undefined;
  }

  /**
   * Revoke a device (control-side, PRD §12): persist the revocation, clear
   * the device's presence/connection state, broadcast offline to everyone else,
   * and return the device's open connections for the adapter to close with
   * CLOSE_REVOKED. Touches no session data — sealed records stay untouched
   * (I-1).
   */
  async revokeDevice<C extends HubConnection>(
    deviceId: string,
    connections: readonly C[],
  ): Promise<C[]> {
    await this.storage.put(revokedKey(deviceId), true);
    await this.storage.delete(legacyConnKey(deviceId));
    for (const key of (await this.connectionBindings(deviceId)).keys()) {
      await this.storage.delete(key);
    }
    await this.storage.delete(presenceKey(deviceId));
    const update: DevicePresence = {
      deviceId,
      online: false,
      lastSeenMs: this.now(),
    };
    for (const peer of connections) {
      if (peer.deviceId !== deviceId)
        peer.send({ t: "presence", devices: [update] });
    }
    return connections.filter((conn) => conn.deviceId === deviceId);
  }

  private async handleHello(
    sender: HubConnection,
    msg: Msg<"hello">,
    others: readonly HubConnection[],
  ): Promise<void> {
    // An edge-verified identity (signed device token → x-suma-device) is
    // already bound; the hello frame's claim only counts in stub mode.
    const deviceId = sender.deviceId ?? msg.deviceId;
    if (await this.isRevoked(deviceId)) {
      sender.close(CLOSE_REVOKED, "revoked");
      return;
    }
    if (msg.spaceIds.length > MAX_DECLARED_SPACES) {
      sender.send({
        t: "error",
        code: "too_many_spaces",
        message: `declare at most ${MAX_DECLARED_SPACES} spaces`,
      });
      return;
    }
    sender.deviceId = deviceId;
    sender.spaceIds = [...msg.spaceIds];
    await this.storage.put<string[]>(
      connectionStorageKey(deviceId, sender.connectionId),
      [...msg.spaceIds],
    );
    const nowMs = this.now();
    await this.storage.put<PresenceEntry>(presenceKey(deviceId), {
      deviceId,
      lastSeenMs: nowMs,
    });
    const presence = await this.presenceSnapshot([sender, ...others]);
    sender.send({ t: "hello.ack", serverTimeMs: nowMs, presence });
    const self: DevicePresence = { deviceId, online: true, lastSeenMs: nowMs };
    for (const peer of others) peer.send({ t: "presence", devices: [self] });
  }

  private async presenceSnapshot(
    connected: readonly HubConnection[],
  ): Promise<DevicePresence[]> {
    const online = new Set<string>();
    for (const conn of connected) {
      if (conn.deviceId !== null) online.add(conn.deviceId);
    }
    const entries = await this.storage.list<PresenceEntry>({
      prefix: "presence:",
    });
    return [...entries.values()].map((entry) => ({
      deviceId: entry.deviceId,
      online: online.has(entry.deviceId),
      lastSeenMs: entry.lastSeenMs,
    }));
  }

  private async handlePublish(
    sender: HubConnection,
    deviceId: string,
    msg: Msg<"publish">,
    others: readonly HubConnection[],
  ): Promise<void> {
    const nowMs = this.now();
    const declared = new Set(sender.spaceIds);
    const accepted: string[] = [];
    const rejected: PublishRejection[] = [];
    const acceptedBySpace = new Map<string, CookieRecordWire[]>();
    const rateWindows = new Map<string, number[]>();
    let rateLimited = false;

    for (const record of msg.records) {
      if (!declared.has(record.spaceId)) {
        rejected.push({ recordId: record.recordId, reason: "malformed" });
        continue;
      }
      const lease = await this.storage.get<LeaseEntry>(
        leaseKey(record.spaceId, record.originId),
      );
      if (
        lease !== undefined &&
        lease.holderDeviceId !== deviceId &&
        lease.expiresAtMs > nowMs
      ) {
        rejected.push({ recordId: record.recordId, reason: "lease_required" });
        continue;
      }
      const stored = await this.storage.get<CookieRecordWire>(
        recKey(record.spaceId, record.recordId),
      );
      if (stored !== undefined && compareHlc(stored.hlc, record.hlc) >= 0) {
        rejected.push({ recordId: record.recordId, reason: "stale" });
        continue;
      }
      const rk = rateKey(deviceId, record.originId);
      let window = rateWindows.get(rk);
      if (window === undefined) {
        window = (await this.storage.get<number[]>(rk)) ?? [];
        rateWindows.set(rk, window);
      }
      const cutoff = nowMs - RATE_WINDOW_MS;
      while (window.length > 0) {
        const head = window[0];
        if (head === undefined || head > cutoff) break;
        window.shift();
      }
      if (window.length >= MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE) {
        // The protocol rejection enum stays authoritative: reason `stale`,
        // with an `error` frame carrying the real cause alongside.
        rateLimited = true;
        rejected.push({ recordId: record.recordId, reason: "stale" });
        continue;
      }
      window.push(nowMs);
      await this.storage.put(recKey(record.spaceId, record.recordId), record);
      await this.appendHistory(record);
      accepted.push(record.recordId);
      const group = acceptedBySpace.get(record.spaceId);
      if (group === undefined) acceptedBySpace.set(record.spaceId, [record]);
      else group.push(record);
    }

    for (const [key, window] of rateWindows)
      await this.storage.put(key, window);
    for (const [spaceId, records] of acceptedBySpace) {
      const current = await this.storage.get<Hlc>(wmKey(spaceId));
      let max = current ?? null;
      for (const record of records) {
        if (max === null || compareHlc(record.hlc, max) > 0) max = record.hlc;
      }
      if (
        max !== null &&
        (current === undefined || compareHlc(max, current) > 0)
      ) {
        await this.storage.put(wmKey(spaceId), max);
      }
    }

    sender.send({ t: "publish.ack", accepted, rejected });
    if (rateLimited) {
      sender.send({
        t: "error",
        code: "rate_limited",
        message: `over ${MAX_MUTATIONS_PER_ORIGIN_PER_MINUTE} mutations/origin/minute`,
      });
    }
    if (acceptedBySpace.size > 0) {
      // Peer space sets come from storage too — a hibernated socket wakes
      // with only its deviceId and must still receive fan-out.
      for (const peer of others) {
        if (peer.deviceId !== null) {
          peer.spaceIds = await this.declaredSpaces(
            peer.deviceId,
            peer.connectionId,
          );
        }
      }
    }
    for (const [spaceId, records] of acceptedBySpace) {
      for (const peer of others) {
        if (peer.spaceIds.includes(spaceId))
          peer.send({ t: "records", spaceId, records });
      }
    }
  }

  /** Retain the newest MAX_RECORD_HISTORY versions of a record, oldest pruned
   * first. History keys embed encodeHlc(hlc), so list order is HLC order. */
  private async appendHistory(record: CookieRecordWire): Promise<void> {
    await this.storage.put(
      histKey(record.spaceId, record.recordId, record.hlc),
      record,
    );
    const versions = await this.storage.list<CookieRecordWire>({
      prefix: histPrefix(record.spaceId, record.recordId),
    });
    let excess = versions.size - MAX_RECORD_HISTORY;
    for (const key of versions.keys()) {
      if (excess <= 0) break;
      await this.storage.delete(key);
      excess -= 1;
    }
  }

  private async handleHydrate(
    sender: HubConnection,
    msg: Msg<"hydrate">,
  ): Promise<void> {
    const { records, watermark } = await this.hydrateSpace(
      msg.spaceId,
      msg.sinceHlc,
    );
    for (let i = 0; i < records.length; i += HYDRATE_CHUNK_SIZE) {
      sender.send({
        t: "records",
        spaceId: msg.spaceId,
        records: records.slice(i, i + HYDRATE_CHUNK_SIZE),
      });
    }
    sender.send({
      t: "hydrate.done",
      spaceId: msg.spaceId,
      count: records.length,
      watermark,
    });
  }

  private async handleLeaseAcquire(
    sender: HubConnection,
    deviceId: string,
    msg: Msg<"lease.acquire">,
    others: readonly HubConnection[],
  ): Promise<void> {
    const nowMs = this.now();
    const key = leaseKey(msg.spaceId, msg.originId);
    const existing = await this.storage.get<LeaseEntry>(key);
    const live =
      existing !== undefined && existing.expiresAtMs > nowMs
        ? existing
        : undefined;
    const foreign = live !== undefined && live.holderDeviceId !== deviceId;
    if (foreign && msg.force !== true) {
      sender.send({
        t: "lease.denied",
        spaceId: msg.spaceId,
        originId: msg.originId,
        holderDeviceId: live.holderDeviceId,
        expiresAtMs: live.expiresAtMs,
      });
      return;
    }
    if (foreign && msg.force === true) {
      const stored =
        msg.recordId === undefined
          ? undefined
          : await this.storage.get<CookieRecordWire>(
              recKey(msg.spaceId, msg.recordId),
            );
      // A bare force flag cannot steal rotating-auth ownership. The requester
      // must name the still-newer local candidate that triggered recovery.
      if (
        msg.recordId === undefined ||
        msg.candidateHlc === undefined ||
        (stored !== undefined &&
          (stored.originId !== msg.originId ||
            compareHlc(msg.candidateHlc, stored.hlc) <= 0))
      ) {
        sender.send({
          t: "lease.denied",
          spaceId: msg.spaceId,
          originId: msg.originId,
          holderDeviceId: live.holderDeviceId,
          expiresAtMs: live.expiresAtMs,
        });
        return;
      }
    }
    const ttlMs = Math.min(msg.ttlMs ?? ORIGIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS);
    const lease: LeaseEntry = {
      spaceId: msg.spaceId,
      originId: msg.originId,
      holderDeviceId: deviceId,
      expiresAtMs: nowMs + ttlMs,
    };
    await this.storage.put(key, lease);
    sender.send({
      t: "lease.granted",
      spaceId: msg.spaceId,
      originId: msg.originId,
      holderDeviceId: deviceId,
      expiresAtMs: lease.expiresAtMs,
    });
    if (foreign) {
      for (const peer of others) {
        if (peer.deviceId === live.holderDeviceId) {
          peer.send({
            t: "lease.revoked",
            spaceId: msg.spaceId,
            originId: msg.originId,
            newHolderDeviceId: deviceId,
          });
        }
      }
    }
  }

  private async handleLeaseRelease(
    deviceId: string,
    msg: Msg<"lease.release">,
  ): Promise<void> {
    const key = leaseKey(msg.spaceId, msg.originId);
    const existing = await this.storage.get<LeaseEntry>(key);
    if (existing !== undefined && existing.holderDeviceId === deviceId) {
      await this.storage.delete(key);
    }
  }

  /** Rollback deletes the rolled-back versions outright — no persistent
   * marker, so records published after the rollback hydrate normally. Clients
   * converge by republishing restored state. */
  private async handleRollback(
    sender: HubConnection,
    msg: Msg<"rollback">,
    others: readonly HubConnection[],
  ): Promise<void> {
    if (!sender.spaceIds.includes(msg.spaceId)) {
      sender.send({
        t: "error",
        code: "malformed",
        message: "space not declared in hello",
      });
      return;
    }
    const stored = await this.storage.list<CookieRecordWire>({
      prefix: `rec:${msg.spaceId}:`,
    });
    for (const [key, record] of stored) {
      if (record.spaceId !== msg.spaceId || record.originId !== msg.originId)
        continue;
      if (compareHlc(record.hlc, msg.toHlc) <= 0) continue;
      const versions = await this.storage.list<CookieRecordWire>({
        prefix: histPrefix(msg.spaceId, record.recordId),
      });
      let survivor: CookieRecordWire | undefined;
      for (const [versionKey, version] of versions) {
        if (compareHlc(version.hlc, msg.toHlc) > 0)
          await this.storage.delete(versionKey);
        else survivor = version; // keys ascend in HLC order: ends as the newest kept
      }
      if (survivor === undefined) await this.storage.delete(key);
      else await this.storage.put(key, survivor);
    }
    const applied: ServerMessage = {
      t: "rollback.applied",
      spaceId: msg.spaceId,
      originId: msg.originId,
      toHlc: msg.toHlc,
    };
    sender.send(applied);
    for (const peer of others) peer.send(applied);
  }

  private async handleWorkspacePublish(
    msg: Msg<"workspace.publish">,
    others: readonly HubConnection[],
  ): Promise<void> {
    const winners: WorkspaceRecordWire[] = [];
    for (const doc of msg.docs) {
      const existing = await this.storage.get<WorkspaceRecordWire>(
        workspaceKey(doc.key),
      );
      if (existing !== undefined && compareHlc(existing.hlc, doc.hlc) >= 0)
        continue;
      await this.storage.put(workspaceKey(doc.key), doc);
      winners.push(doc);
    }
    if (winners.length === 0) return;
    for (const peer of others)
      peer.send({ t: "workspace.records", docs: winners });
  }

  private async handleWorkspaceHydrate(
    sender: HubConnection,
    msg: Msg<"workspace.hydrate">,
  ): Promise<void> {
    const stored = await this.storage.list<WorkspaceRecordWire>({
      prefix: "ws:",
    });
    const docs = sortByHlc(
      [...stored.values()].filter(
        (doc) => msg.sinceHlc === null || compareHlc(doc.hlc, msg.sinceHlc) > 0,
      ),
    );
    for (let i = 0; i < docs.length; i += HYDRATE_CHUNK_SIZE) {
      sender.send({
        t: "workspace.records",
        docs: docs.slice(i, i + HYDRATE_CHUNK_SIZE),
      });
    }
    sender.send({ t: "workspace.hydrate.done", count: docs.length });
  }
}
