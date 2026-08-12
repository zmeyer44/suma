/**
 * Offline mutation queue (PRD §8.3): append-only, drained in HLC order.
 * Persistence is pluggable — the desktop app supplies a SQLite-backed
 * QueueStorage later; tests and defaults use the in-memory implementation.
 */

import { compareHlc, sortByHlc, type CookieRecordWire } from "@suma/protocol";

export interface QueueStorage {
  append(record: CookieRecordWire): void;
  all(): CookieRecordWire[];
  clear(): void;
  size(): number;
}

export class InMemoryQueueStorage implements QueueStorage {
  private items: CookieRecordWire[] = [];

  append(record: CookieRecordWire): void {
    this.items.push(record);
  }

  all(): CookieRecordWire[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }

  size(): number {
    return this.items.length;
  }
}

export class OfflineQueue {
  constructor(
    private readonly storage: QueueStorage = new InMemoryQueueStorage(),
  ) {}

  enqueue(record: CookieRecordWire): void {
    this.storage.append(record);
  }

  get depth(): number {
    return this.compacted().length;
  }

  /** Pending records in HLC order without removing them. */
  peek(): CookieRecordWire[] {
    return sortByHlc(this.compacted());
  }

  /** Remove and return all pending records, oldest HLC first. */
  drain(): CookieRecordWire[] {
    // Only the newest mutation for a cookie can be a useful retry. Publishing
    // every intermediate Google rotation after reconnect both wastes the
    // lease and can temporarily roll a session backward.
    const ordered = sortByHlc(this.compacted());
    this.storage.clear();
    return ordered;
  }

  private compacted(): CookieRecordWire[] {
    const newest = new Map<string, CookieRecordWire>();
    for (const record of this.storage.all()) {
      const current = newest.get(record.recordId);
      if (current === undefined || compareHlc(record.hlc, current.hlc) > 0) {
        newest.set(record.recordId, record);
      }
    }
    return [...newest.values()];
  }
}
