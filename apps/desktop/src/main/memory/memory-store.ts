/**
 * MemoryStore — the memory's records over the account's VFS.
 *
 * Storage rides the same `vfs` channel the IDE and shells use: locally that
 * is the SimAgent's LocalVfs on ~/Suma, signed in it is the account
 * computer's ~/cloud — which is exactly what makes memories follow the user
 * across devices with no sync code here. Layout under /.suma/memory:
 *
 *   LOG.txt      every memory, fixed 320-byte records, append-only
 *   TREE/<size>  summaries of aligned <size>-blocks, fixed 288-byte records;
 *                a rebuildable cache — corrupt entries are dropped and the
 *                next compressions rebuild them
 *
 * Mutations are serialized through an in-process queue and use conditional
 * VFS writes/appends keyed to the file size. Competing devices therefore
 * cannot claim the same log id or dense summary slot: the loser re-reads and
 * retries, or reports an already-settled summary.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { VfsRequest, VfsResponse } from "@suma/protocol";
import {
  decodeRecord,
  formatBlock,
  formatEntry,
  LOG_RECORD_BYTES,
  MEMORY_DIR,
  napInstruction,
  padRecord,
  parseEntry,
  pendingBlocks,
  pendingCount,
  RAW_MAX,
  TREE_RECORD_BYTES,
  type MemoryEntry,
  type NapRequest,
} from "./memory-core";

/** What the store needs from an AgentLink — structural, so tests can hand it
 *  a SimAgent and the service can hand it the live (switchable) link. */
export interface MemoryVfsLink {
  connected(): boolean;
  vfs(request: VfsRequest): Promise<VfsResponse>;
}

const LOG_PATH = `${MEMORY_DIR}/LOG.txt`;
const TREE_DIR = `${MEMORY_DIR}/TREE`;

/** One vfs.read must stay well under VFS_MAX_READ_BYTES once base64-encoded;
 *  4096 records (1.25 MiB) keeps scans chunky but frame-safe. */
const SCAN_RECORDS_PER_READ = 4096;

/** A misaligned LOG.txt bigger than one vfs.write cannot be repaired in
 *  place — at 8 MiB that is ~26k memories with a torn tail, effectively
 *  unreachable; refuse rather than guess. */
const MAX_REPAIR_BYTES = 8 * 1024 * 1024;
/** A competing device should win quickly; retry a bounded number of times so
 *  a pathological writer cannot hold an assistant turn forever. */
const MAX_CONFLICT_RETRIES = 8;

function treeLevelPath(size: number): string {
  return `${TREE_DIR}/${size}`;
}

function isNotFound(resp: VfsResponse): boolean {
  return resp.t === "error" && resp.code === "vfs_not_found";
}

function isConflict(resp: VfsResponse): boolean {
  return resp.t === "error" && resp.code === "vfs_conflict";
}

function unwrap<T extends VfsResponse["t"]>(
  resp: VfsResponse,
  t: T,
  doing: string,
): Extract<VfsResponse, { t: T }> {
  if (resp.t === "error") throw new Error(`${doing}: ${resp.message}`);
  if (resp.t !== t) throw new Error(`${doing}: unexpected vfs answer ${resp.t}`);
  return resp as Extract<VfsResponse, { t: T }>;
}

export class MemoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly link: () => MemoryVfsLink | null) {}

  available(): boolean {
    const link = this.link();
    return link !== null && link.connected();
  }

  /* ------------------------------ plumbing ------------------------------- */

  private async call(request: VfsRequest): Promise<VfsResponse> {
    const link = this.link();
    if (link === null || !link.connected()) {
      throw new Error("memory is unavailable right now (no computer connected)");
    }
    return link.vfs(request);
  }

  /** Mutations run one at a time; a failed one never wedges the queue. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Atomically create an empty file without replacing one another device
   *  created meanwhile. vfs.rename is a no-overwrite operation. */
  private async ensureFile(path: string, doing: string): Promise<void> {
    const stat = await this.call({ t: "vfs.stat", path });
    if (!isNotFound(stat)) {
      const info = unwrap(stat, "vfs.info", `checking ${path}`);
      if (info.entry.kind !== "file") {
        throw new Error(`${doing}: ${path} is not a file`);
      }
      return;
    }

    const temporary = `${path}.init-${randomUUID()}`;
    unwrap(
      await this.call({ t: "vfs.write", path: temporary, dataB64: "" }),
      "vfs.wrote",
      doing,
    );
    const renamed = await this.call({
      t: "vfs.rename",
      from: temporary,
      to: path,
    });
    if (renamed.t === "error" && renamed.code === "vfs_already_exists") {
      await this.call({ t: "vfs.delete", path: temporary }).catch(() => null);
      return;
    }
    if (renamed.t === "error") {
      await this.call({ t: "vfs.delete", path: temporary }).catch(() => null);
    }
    unwrap(renamed, "vfs.renamed", doing);
  }

  /** Revalidated on every mutation because SwitchableAgentLink can move this
   *  store from the simulator to a cloud/relay filesystem without rebinding. */
  private async ensureInit(): Promise<void> {
    unwrap(
      await this.call({ t: "vfs.mkdir", path: TREE_DIR }),
      "vfs.created",
      "creating memory",
    );
    await this.ensureFile(LOG_PATH, "creating memory log");
  }

  private async fileSize(path: string): Promise<number | null> {
    const resp = await this.call({ t: "vfs.stat", path });
    if (isNotFound(resp)) return null;
    const info = unwrap(resp, "vfs.info", `checking ${path}`);
    return info.entry.kind === "file" ? info.entry.sizeBytes : null;
  }

  /** Read exactly [offset, offset+length) of a file whose size is known to
   *  cover it, chunking under the frame cap. */
  private async readRange(path: string, offset: number, length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let at = offset;
    const end = offset + length;
    while (at < end) {
      const want = Math.min(end - at, SCAN_RECORDS_PER_READ * LOG_RECORD_BYTES);
      const resp = unwrap(
        await this.call({ t: "vfs.read", path, offset: at, length: want }),
        "vfs.data",
        `reading ${path}`,
      );
      const chunk = Buffer.from(resp.dataB64, "base64");
      if (chunk.byteLength === 0) break;
      parts.push(chunk);
      at += chunk.byteLength;
    }
    return Buffer.concat(parts);
  }

  /** Truncate a torn trailing record (there is no vfs truncate — the aligned
   *  prefix is read back and rewritten whole, atomic on the other side). */
  private async repairIfTorn(
    path: string,
    recordBytes: number,
  ): Promise<number> {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      const size = (await this.fileSize(path)) ?? 0;
      const aligned = size - (size % recordBytes);
      if (aligned === size) return size;
      if (size > MAX_REPAIR_BYTES) {
        throw new Error(
          `memory file ${path} is damaged (${size} bytes, misaligned)`,
        );
      }
      const keep =
        aligned === 0
          ? Buffer.alloc(0)
          : await this.readRange(path, 0, aligned);
      const response = await this.call({
        t: "vfs.write",
        path,
        dataB64: keep.toString("base64"),
        expectedSizeBytes: size,
      });
      if (isConflict(response)) continue;
      unwrap(response, "vfs.wrote", `repairing ${path}`);
      return aligned;
    }
    throw new Error(
      `memory file ${path} kept changing while it was being repaired`,
    );
  }

  /* -------------------------------- log ---------------------------------- */

  async logLen(): Promise<number> {
    const size = await this.fileSize(LOG_PATH);
    return size === null ? 0 : Math.floor(size / LOG_RECORD_BYTES);
  }

  /** Append memories; ids are assigned from the freshly re-read length and
   *  claimed with a conditional append. Returns the first new id. */
  async append(texts: string[], date: string): Promise<number> {
    return this.locked(async () => {
      for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
        await this.ensureInit();
        const bytes = await this.repairIfTorn(LOG_PATH, LOG_RECORD_BYTES);
        const base = Math.floor(bytes / LOG_RECORD_BYTES);
        const records = texts.map((text, i) =>
          padRecord(
            formatEntry({ id: base + i, date, text }),
            LOG_RECORD_BYTES,
          ),
        );
        const payload = Buffer.concat(records);
        const response = await this.call({
          t: "vfs.append",
          path: LOG_PATH,
          dataB64: payload.toString("base64"),
          expectedSizeBytes: bytes,
        });
        if (isConflict(response)) continue;
        unwrap(response, "vfs.wrote", "saving memory");
        return base;
      }
      throw new Error("memory changed too often while saving — try again");
    });
  }

  /** Raw memories [lo, hi), skipping unreadable records. */
  async logSlice(lo: number, hi: number): Promise<MemoryEntry[]> {
    const len = await this.logLen();
    const from = Math.max(0, lo);
    const to = Math.min(hi, len);
    if (to <= from) return [];
    const bytes = await this.readRange(
      LOG_PATH,
      from * LOG_RECORD_BYTES,
      (to - from) * LOG_RECORD_BYTES,
    );
    const entries: MemoryEntry[] = [];
    for (let i = 0; i + LOG_RECORD_BYTES <= bytes.byteLength; i += LOG_RECORD_BYTES) {
      const line = decodeRecord(bytes.subarray(i, i + LOG_RECORD_BYTES));
      if (line === null || line === "") continue;
      const entry = parseEntry(line);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  /**
   * Stream the whole log against a pattern (matched on the full rendered
   * "#id date text" line, so ids and dates are searchable too). Keeps the
   * NEWEST matches within capBytes, like OptMem's recall — when the user
   * asks about "the restaurant", the recent one wins.
   */
  async scanMatches(
    pattern: RegExp,
    capBytes: number,
  ): Promise<{ lines: string[]; total: number }> {
    const len = await this.logLen();
    const kept: string[] = [];
    let keptBytes = 0;
    let total = 0;
    for (let at = 0; at < len; at += SCAN_RECORDS_PER_READ) {
      const to = Math.min(len, at + SCAN_RECORDS_PER_READ);
      for (const entry of await this.logSlice(at, to)) {
        const line = formatEntry(entry);
        if (!pattern.test(line)) continue;
        total += 1;
        kept.push(line);
        keptBytes += line.length + 1;
        while (keptBytes > capBytes && kept.length > 1) {
          const dropped = kept.shift() as string;
          keptBytes -= dropped.length + 1;
        }
      }
    }
    return { lines: kept, total };
  }

  /* -------------------------------- tree ---------------------------------- */

  async treeLevelCounts(T: number): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    for (let size = 2; size <= T; size *= 2) {
      const bytes = await this.fileSize(treeLevelPath(size));
      counts.set(size, bytes === null ? 0 : Math.floor(bytes / TREE_RECORD_BYTES));
    }
    return counts;
  }

  /**
   * The settled summary of [lo, hi), or null. A blank or non-UTF-8 record is
   * corruption; unlike the CLI (which asks its human-driven agent to run
   * `forget`), the store self-heals — the record and everything above it are
   * dropped, and the pending compressions rebuild them.
   */
  async summary(lo: number, hi: number): Promise<string | null> {
    const size = hi - lo;
    const path = treeLevelPath(size);
    const fileBytes = await this.fileSize(path);
    if (fileBytes === null) return null;
    const index = Math.floor(lo / size);
    const offset = index * TREE_RECORD_BYTES;
    if (offset + TREE_RECORD_BYTES > fileBytes) return null;
    const record = await this.readRange(path, offset, TREE_RECORD_BYTES);
    const line = decodeRecord(record);
    if (line !== null && line !== "") return line;
    await this.dropSummaries(lo, hi);
    return null;
  }

  /** Settle the summary of [lo, hi). False = someone settled or dropped it
   *  meanwhile (position check under the queue) — benign, retryable. */
  async putSummary(lo: number, hi: number, text: string): Promise<boolean> {
    const size = hi - lo;
    const path = treeLevelPath(size);
    return this.locked(async () => {
      const record = Buffer.from(padRecord(text, TREE_RECORD_BYTES)).toString(
        "base64",
      );
      for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
        await this.ensureInit();
        await this.ensureFile(path, "creating summary level");
        const bytes = await this.repairIfTorn(path, TREE_RECORD_BYTES);
        const count = Math.floor(bytes / TREE_RECORD_BYTES);
        if (count !== Math.floor(lo / size)) return false;
        const response = await this.call({
          t: "vfs.append",
          path,
          dataB64: record,
          expectedSizeBytes: bytes,
        });
        if (isConflict(response)) continue;
        unwrap(response, "vfs.wrote", "saving summary");
        return true;
      }
      throw new Error(
        "memory changed too often while saving a summary — try again",
      );
    });
  }

  /** Drop the summary of [lo, hi) and, because levels are dense prefixes,
   *  every later summary at that level and every level above — the next
   *  compressions rebuild them in order. The log is never touched. */
  async dropSummaries(lo: number, hi: number): Promise<void> {
    const logLen = await this.logLen();
    await this.locked(async () => {
      for (let size = hi - lo; size <= logLen; size *= 2) {
        const path = treeLevelPath(size);
        let settled = false;
        for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
          const bytes = await this.fileSize(path);
          if (bytes === null) {
            settled = true;
            break;
          }
          const keepRecords = Math.floor(lo / size);
          if (Math.floor(bytes / TREE_RECORD_BYTES) <= keepRecords) {
            settled = true;
            break;
          }
          const keep =
            keepRecords === 0
              ? Buffer.alloc(0)
              : await this.readRange(path, 0, keepRecords * TREE_RECORD_BYTES);
          const response = await this.call({
            t: "vfs.write",
            path,
            dataB64: keep.toString("base64"),
            expectedSizeBytes: bytes,
          });
          if (isConflict(response)) continue;
          unwrap(response, "vfs.wrote", "dropping summaries");
          settled = true;
          break;
        }
        if (!settled) {
          throw new Error(
            `memory changed too often while dropping summaries from ${path}`,
          );
        }
      }
    });
  }

  /* ---------------------------- scheduling -------------------------------- */

  async pendingCompressions(T: number): Promise<number> {
    return pendingCount(T, await this.treeLevelCounts(T));
  }

  /**
   * The next compression owed, with its material: raw memories for blocks up
   * to RAW_MAX, the two half-summaries above that (pending order settles
   * halves first). A half that turns out corrupt self-heals and the request
   * is recomputed.
   */
  async nextNap(T: number): Promise<NapRequest | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const counts = await this.treeLevelCounts(T);
      const [head] = pendingBlocks(T, counts, 1);
      if (head === undefined) return null;
      const { lo, hi } = head;
      const size = hi - lo;
      const remaining = pendingCount(T, counts) - 1;
      if (size <= RAW_MAX) {
        const body = (await this.logSlice(lo, hi)).map(formatEntry);
        return { block: formatBlock(lo, hi), instruction: napInstruction(lo, hi, body, remaining), remaining };
      }
      const mid = lo + size / 2;
      const left = await this.summary(lo, mid);
      const right = await this.summary(mid, hi);
      if (left === null || right === null) continue;
      const body = [
        `#${formatBlock(lo, mid)} ${left}`,
        `#${formatBlock(mid, hi)} ${right}`,
      ];
      return { block: formatBlock(lo, hi), instruction: napInstruction(lo, hi, body, remaining), remaining };
    }
    return null;
  }
}
