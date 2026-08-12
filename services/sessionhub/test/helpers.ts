import type {
  ClientMessage,
  CookieRecordWire,
  Hlc,
  ServerMessage,
  WorkspaceRecordWire,
} from "@suma/protocol";
import {
  HubCore,
  type HubConnection,
  type HubStorage,
} from "../src/hub-core.js";

export class MemoryHubStorage implements HubStorage {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    return Promise.resolve(
      value === undefined ? undefined : (structuredClone(value) as T),
    );
  }

  put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }

  list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const keys = [...this.map.keys()].sort();
    for (const key of keys) {
      if (key.startsWith(options.prefix))
        out.set(key, structuredClone(this.map.get(key)) as T);
    }
    return Promise.resolve(out);
  }
}

export class FakeConnection implements HubConnection {
  private static sequence = 0;
  deviceId: string | null = null;
  connectionId = `fake-connection-${++FakeConnection.sequence}`;
  spaceIds: string[] = [];
  readonly sent: ServerMessage[] = [];
  readonly closed: { code: number; reason: string }[] = [];

  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }

  ofType<T extends ServerMessage["t"]>(
    t: T,
  ): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter(
      (m): m is Extract<ServerMessage, { t: T }> => m.t === t,
    );
  }

  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export interface Fixture {
  storage: MemoryHubStorage;
  core: HubCore;
  clock: { nowMs: number };
}

export function makeFixture(startMs = 1_000_000): Fixture {
  const storage = new MemoryHubStorage();
  const clock = { nowMs: startMs };
  const core = new HubCore(storage, () => clock.nowMs);
  return { storage, core, clock };
}

export function frame(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

export async function sendHello(
  core: HubCore,
  conn: FakeConnection,
  deviceId: string,
  spaceIds: string[],
  others: FakeConnection[] = [],
): Promise<void> {
  await core.handleMessage(
    conn,
    frame({ t: "hello", deviceId, spaceIds }),
    others,
  );
}

export function hex64(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

let recordSeq = 0;

export function makeRecord(
  overrides: Partial<CookieRecordWire> & { spaceId: string; hlc: Hlc },
): CookieRecordWire {
  recordSeq += 1;
  return {
    recordId: hex64(recordSeq),
    originId: hex64(0xabcdef),
    sealedRecord: "c2VhbGVk",
    causalParent: null,
    deviceSig: "c2ln",
    cause: "WRITE",
    ...overrides,
  };
}

export function makeWorkspaceDoc(
  overrides: Partial<WorkspaceRecordWire> & { key: string; hlc: Hlc },
): WorkspaceRecordWire {
  return {
    sealedValue: "c2VhbGVk",
    deviceSig: "c2ln",
    ...overrides,
  };
}

export function makeHlc(
  physicalMs: number,
  deviceId = "dev-a",
  logical = 0,
): Hlc {
  return { physicalMs, logical, deviceId };
}
