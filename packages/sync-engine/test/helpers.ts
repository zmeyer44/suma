/**
 * Deterministic test harness for the fidelity properties. No timers drive
 * behavior and no Math.random appears anywhere — schedules come exclusively
 * from fast-check, time from ManualClock, and delivery from explicit queues.
 */

import {
  computeRecordIdHex,
  deriveSpaceKeys,
  encodeHlc,
  generateDeviceKeypair,
  SPACE_ROOT_SECRET_BYTES,
  type Cause,
  type CookieAttributes,
  type CookieIdentity,
  type CookiePlain,
  type CookieRecordWire,
  type DeviceKeypair,
  type SpaceKeys,
} from "@suma/protocol";
import {
  SpaceSyncEngine,
  type CookieApplier,
  type SyncEngineOptions,
  type SyncTransport,
} from "../src/index.js";

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

export class ManualClock {
  private ms: number;

  constructor(startMs = 1_700_000_000_000) {
    this.ms = startMs;
  }

  readonly now = (): number => this.ms;

  tick(deltaMs = 1): number {
    this.ms += deltaMs;
    return this.ms;
  }
}

/**
 * Bounded event-loop yields until a condition holds. Node's WebCrypto resolves
 * off the microtask queue, so async engine work (queue drain) needs event-loop
 * turns; this is not a wall-clock wait and cannot flake on timing.
 */
export async function settle(predicate: () => boolean, maxTurns = 200): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (!predicate()) throw new Error("condition did not settle within the turn budget");
}

export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

/* ------------------------------------------------------------------ *
 * Identities and attributes
 * ------------------------------------------------------------------ */

export function makeIdentity(spaceId: string, hostKey: string, name: string): CookieIdentity {
  return { spaceId, hostKey, name, path: "/", partitionKey: "", sourceScheme: "secure" };
}

export const IDENTITY_POOL_SIZE = 8;

/** Small fixed identity pool varying hostKey dot-scope, partitionKey, sourceScheme. */
export function identityAt(spaceId: string, index: number): CookieIdentity {
  const combos: Array<Pick<CookieIdentity, "hostKey" | "name" | "partitionKey" | "sourceScheme">> = [
    { hostKey: "github.com", name: "sid", partitionKey: "", sourceScheme: "secure" },
    { hostKey: ".github.com", name: "sid", partitionKey: "", sourceScheme: "secure" },
    { hostKey: "github.com", name: "sid", partitionKey: "https://app.example", sourceScheme: "secure" },
    { hostKey: "github.com", name: "sid", partitionKey: "", sourceScheme: "nonsecure" },
    { hostKey: "gitlab.com", name: "token", partitionKey: "", sourceScheme: "secure" },
    { hostKey: ".gitlab.com", name: "token", partitionKey: "", sourceScheme: "unset" },
    { hostKey: "github.com", name: "csrf", partitionKey: "", sourceScheme: "secure" },
    { hostKey: "gitlab.com", name: "sid", partitionKey: "https://other.example", sourceScheme: "secure" },
  ];
  const combo = combos[index % combos.length];
  if (!combo) throw new Error("identity pool exhausted");
  return { spaceId, path: "/", ...combo };
}

export function attrsFor(value: string): CookieAttributes {
  return {
    value,
    expiresMs: null,
    persistent: false,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    priority: "medium",
  };
}

/* ------------------------------------------------------------------ *
 * Keys and signers (cached; contents never depend on run order)
 * ------------------------------------------------------------------ */

const spaceKeysCache = new Map<string, Promise<SpaceKeys>>();

export function testSpaceKeys(spaceId: string): Promise<SpaceKeys> {
  let cached = spaceKeysCache.get(spaceId);
  if (!cached) {
    const secret = new Uint8Array(SPACE_ROOT_SECRET_BYTES).fill(0x42);
    cached = deriveSpaceKeys(spaceId, secret);
    spaceKeysCache.set(spaceId, cached);
  }
  return cached;
}

let keypairPromise: Promise<DeviceKeypair> | null = null;

export function testKeypair(): Promise<DeviceKeypair> {
  keypairPromise ??= generateDeviceKeypair();
  return keypairPromise;
}

/* ------------------------------------------------------------------ *
 * Applier and transports
 * ------------------------------------------------------------------ */

export class MemoryApplier implements CookieApplier {
  readonly applied: Array<{ plain: CookiePlain; cause: Cause }> = [];
  enabled = true;

  canApply(): boolean {
    return this.enabled;
  }

  apply(plain: CookiePlain, cause: Cause): Promise<void> {
    this.applied.push({ plain, cause });
    return Promise.resolve();
  }
}

export class CollectingTransport implements SyncTransport {
  readonly published: CookieRecordWire[] = [];
  readonly leaseCalls: Array<{ spaceId: string; originId: string; force: boolean | undefined }> = [];
  readonly released: string[] = [];
  leaseGranted = true;
  readonly leaseResults: boolean[] = [];

  publish(records: CookieRecordWire[]): void {
    this.published.push(...records);
  }

  acquireLease(spaceId: string, originId: string, force?: boolean): Promise<boolean> {
    this.leaseCalls.push({ spaceId, originId, force });
    return Promise.resolve(this.leaseResults.shift() ?? this.leaseGranted);
  }

  releaseLease(spaceId: string, originId: string): void {
    this.released.push(originId);
  }
}

/* ------------------------------------------------------------------ *
 * LoopbackHub — deterministic in-memory hub connecting engines
 * ------------------------------------------------------------------ */

interface HubMember {
  deviceId: string;
  engine: SpaceSyncEngine | null;
  cursor: number;
  partitioned: boolean;
}

/**
 * Publishes append to one global log (the SessionHub total order); each member
 * holds a cursor into it. Schedules control per-link partition/delay (withheld
 * deliveries) and cross-link interleaving (deliver command order). Publishers
 * are never re-delivered their own records.
 */
export class LoopbackHub {
  private readonly log: Array<{ from: string; record: CookieRecordWire }> = [];
  private readonly members = new Map<string, HubMember>();
  private readonly leases = new Map<string, string>();

  register(deviceId: string): SyncTransport {
    const member: HubMember = { deviceId, engine: null, cursor: 0, partitioned: false };
    this.members.set(deviceId, member);
    return {
      publish: (records: CookieRecordWire[]): void => {
        for (const record of records) this.log.push({ from: deviceId, record });
      },
      acquireLease: (spaceId: string, originId: string, force?: boolean): Promise<boolean> => {
        const key = `${spaceId}/${originId}`;
        const holder = this.leases.get(key);
        if (holder === undefined || holder === deviceId || force === true) {
          this.leases.set(key, deviceId);
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      },
      releaseLease: (spaceId: string, originId: string): void => {
        const key = `${spaceId}/${originId}`;
        if (this.leases.get(key) === deviceId) this.leases.delete(key);
      },
    };
  }

  attach(deviceId: string, engine: SpaceSyncEngine): void {
    this.member(deviceId).engine = engine;
  }

  partition(deviceId: string, partitioned: boolean): void {
    this.member(deviceId).partitioned = partitioned;
  }

  pendingFor(deviceId: string): number {
    const member = this.member(deviceId);
    let pending = 0;
    for (let i = member.cursor; i < this.log.length; i += 1) {
      const entry = this.log[i];
      if (entry && entry.from !== deviceId) pending += 1;
    }
    return pending;
  }

  async deliver(deviceId: string, max: number = Number.POSITIVE_INFINITY): Promise<number> {
    const member = this.member(deviceId);
    if (member.partitioned || member.engine === null) return 0;
    let delivered = 0;
    while (member.cursor < this.log.length && delivered < max) {
      const entry = this.log[member.cursor];
      member.cursor += 1;
      if (entry === undefined || entry.from === deviceId) continue;
      await member.engine.applyRemote([entry.record]);
      delivered += 1;
    }
    return delivered;
  }

  /** Full eventual delivery: heals partitions and drains every link. */
  async deliverAll(): Promise<void> {
    for (const member of this.members.values()) member.partitioned = false;
    let pending = true;
    while (pending) {
      pending = false;
      for (const member of this.members.values()) {
        await this.deliver(member.deviceId);
        if (member.cursor < this.log.length) pending = true;
      }
    }
  }

  private member(deviceId: string): HubMember {
    const member = this.members.get(deviceId);
    if (!member) throw new Error(`unknown hub member ${deviceId}`);
    return member;
  }
}

/* ------------------------------------------------------------------ *
 * Cluster / standalone-engine factories
 * ------------------------------------------------------------------ */

export interface Replica {
  deviceId: string;
  engine: SpaceSyncEngine;
  applier: MemoryApplier;
}

export interface Cluster {
  hub: LoopbackHub;
  clock: ManualClock;
  keys: SpaceKeys;
  replicas: Replica[];
}

export async function createCluster(
  spaceId: string,
  size: number,
  overrides: Partial<SyncEngineOptions> = {},
): Promise<Cluster> {
  const keys = await testSpaceKeys(spaceId);
  const keypair = await testKeypair();
  const hub = new LoopbackHub();
  const clock = new ManualClock();
  const replicas: Replica[] = [];
  for (let i = 0; i < size; i += 1) {
    const deviceId = `dev-${i}`;
    const transport = hub.register(deviceId);
    const applier = new MemoryApplier();
    const engine = new SpaceSyncEngine(
      spaceId,
      keys,
      { deviceId, privateKey: keypair.privateKey },
      transport,
      applier,
      { deviceId, now: clock.now, ...overrides },
    );
    hub.attach(deviceId, engine);
    replicas.push({ deviceId, engine, applier });
  }
  return { hub, clock, keys, replicas };
}

export interface Standalone {
  engine: SpaceSyncEngine;
  transport: CollectingTransport;
  applier: MemoryApplier;
  clock: ManualClock;
}

export async function createEngine(
  spaceId: string,
  deviceId: string,
  clock: ManualClock,
  overrides: Partial<SyncEngineOptions> = {},
): Promise<Standalone> {
  const keys = await testSpaceKeys(spaceId);
  const keypair = await testKeypair();
  const transport = new CollectingTransport();
  const applier = new MemoryApplier();
  const engine = new SpaceSyncEngine(
    spaceId,
    keys,
    { deviceId, privateKey: keypair.privateKey },
    transport,
    applier,
    { deviceId, now: clock.now, ...overrides },
  );
  return { engine, transport, applier, clock };
}

/* ------------------------------------------------------------------ *
 * State fingerprints for convergence assertions
 * ------------------------------------------------------------------ */

export async function poolRecordIds(keys: SpaceKeys, spaceId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < IDENTITY_POOL_SIZE; i += 1) {
    ids.push(await computeRecordIdHex(keys.idKey, identityAt(spaceId, i)));
  }
  return ids;
}

export function enginePrint(engine: SpaceSyncEngine, recordIds: ReadonlyArray<string>): string {
  const rows = recordIds.map((recordId) => {
    const record = engine.getRecord(recordId);
    if (!record) return { recordId, state: "absent" };
    return {
      recordId,
      hlc: encodeHlc(record.hlc),
      cause: record.cause,
      deleted: record.plain.deleted,
      value: record.plain.attributes?.value ?? null,
    };
  });
  return JSON.stringify(rows);
}

export function livePrint(engine: SpaceSyncEngine): string {
  const rows = engine.listLiveCookies().map((plain) => ({
    hostKey: plain.identity.hostKey,
    name: plain.identity.name,
    path: plain.identity.path,
    partitionKey: plain.identity.partitionKey,
    sourceScheme: plain.identity.sourceScheme,
    value: plain.attributes?.value ?? null,
  }));
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(rows);
}
