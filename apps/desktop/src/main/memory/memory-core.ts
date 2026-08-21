/**
 * memory-core — the assistant's long-term memory, PURE half.
 *
 * A TypeScript port of OptMem (github.com/VictorTaelin/OptMem): an
 * append-only log of one-line memories plus a binary merge tree of one-line
 * summaries over it. The intelligence lives in the model, not here — this
 * module only decides WHAT the model reads (the wake cover), WHAT it owes
 * (pending compressions), and HOW records are laid out on disk.
 *
 * The storage design is fixed-width records: position is identity, lookup is
 * one seek. Memory #i lives at byte i*LOG_RECORD_BYTES of LOG.txt; the
 * summary of the aligned power-of-two block [lo, hi) lives at record
 * lo/(hi-lo) of TREE/<hi-lo>. Each tree level file is a dense prefix — its
 * length alone says how far compression got, so there is no index to corrupt.
 *
 * Everything here is pure (accessors are passed in); the VFS half lives in
 * memory-store.ts and the assistant-facing operations in memory-service.ts.
 */

/** Fixed size of one LOG.txt record: "#<id> <date> <text>" space-padded. */
export const LOG_RECORD_BYTES = 320;
/** Fixed size of one TREE/<size> record: the summary line, space-padded. */
export const TREE_RECORD_BYTES = 288;
/** The longest a single memory or summary may be, in UTF-8 bytes. */
export const ENTRY_MAX_BYTES = 280;
/** The wake context's line budget (~8k tokens over the whole history). */
export const WAKE_LINES = 96;
/** Blocks up to this size compress straight from raw memories; larger ones
 *  compress from their two half-summaries. */
export const RAW_MAX = 16;
/** Wake degrades gracefully when summaries are missing (compressions not
 *  paid yet) by expanding blocks into halves or raw lines. Expansion stops
 *  at this many lines; single memories still always render, so the total
 *  stays under WAKE_EXPANSION_CAP + budget. */
export const WAKE_EXPANSION_CAP = WAKE_LINES * 3;

/** Where the memory lives in the account's VFS — under the hidden app-data
 *  folder (".suma" is in VFS_TREE_SKIPPED_DIRS, so the IDE tree skips it). */
export const MEMORY_DIR = "/.suma/memory";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

/** One record: the line, space-padded to recordBytes-1, then "\n". Position
 *  is identity, so a record NEVER exceeds its slot — callers checked first. */
export function padRecord(line: string, recordBytes: number): Uint8Array {
  const bytes = encoder.encode(line);
  if (bytes.byteLength > recordBytes - 1) {
    throw new Error(`record overflow: ${bytes.byteLength} bytes`);
  }
  const record = new Uint8Array(recordBytes).fill(0x20);
  record.set(bytes);
  record[recordBytes - 1] = 0x0a;
  return record;
}

/** Decode one fixed-width record back to its line. null = not valid UTF-8
 *  (a torn or corrupt record); "" = a blank record (also corrupt). Records
 *  are sliced as BYTES before decoding — decoding first would shift slot
 *  boundaries after any multi-byte character. */
export function decodeRecord(record: Uint8Array): string | null {
  try {
    return decoder.decode(record).replace(/[\s\n]+$/u, "").trimStart();
  } catch {
    return null;
  }
}

export interface MemoryEntry {
  id: number;
  date: string;
  text: string;
}

export function formatEntry(entry: MemoryEntry): string {
  return `#${entry.id} ${entry.date} ${entry.text}`;
}

export function parseEntry(line: string): MemoryEntry | null {
  const match = /^#(\d+) (\d{4}-\d{2}-\d{2}) (.*)$/u.exec(line);
  if (match === null) return null;
  return {
    id: Number.parseInt(match[1] as string, 10),
    date: match[2] as string,
    text: match[3] as string,
  };
}

/** Validate a memory or summary the model wants to store. Thrown messages
 *  are for the model — they become error tool results it can act on. */
export function checkEntry(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("a memory cannot be empty");
  if (/[\n\r]/u.test(trimmed)) {
    throw new Error(
      "a memory is one line: merge the lines into one, or save them as separate memories",
    );
  }
  const bytes = utf8Length(trimmed);
  if (bytes > ENTRY_MAX_BYTES) {
    throw new Error(
      `too long: ${bytes} bytes (limit ${ENTRY_MAX_BYTES}) — accented characters and emoji cost more than one byte; compress it further`,
    );
  }
  return trimmed;
}

/** Local calendar date, ISO — memories are stamped in the user's own day. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear().toString().padStart(4, "0");
  const m = (now.getMonth() + 1).toString().padStart(2, "0");
  const d = now.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/* --------------------------------- blocks --------------------------------- */

/** [lo, hi) — hi exclusive internally; "lo-(hi-1)" inclusive everywhere the
 *  model sees a block id, matching what wake lines show. */
export interface Block {
  lo: number;
  hi: number;
}

export function formatBlock(lo: number, hi: number): string {
  return `${lo}-${hi - 1}`;
}

function isAlignedPow2Block(lo: number, hi: number): boolean {
  const size = hi - lo;
  return size >= 2 && (size & (size - 1)) === 0 && lo % size === 0 && lo >= 0;
}

/** Parse a model-provided block id ("16-31"). Throws model-readable errors. */
export function parseBlock(spec: string): Block {
  const match = /^\s*#?(\d+)\s*-\s*(\d+)\s*$/u.exec(spec);
  if (match === null) {
    throw new Error(
      `"${spec}" is not a block id — use the "lo-hi" form shown in your memory context, e.g. "16-31"`,
    );
  }
  const lo = Number.parseInt(match[1] as string, 10);
  const hi = Number.parseInt(match[2] as string, 10) + 1;
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || !isAlignedPow2Block(lo, hi)) {
    throw new Error(
      `"${spec}" is not a valid block: a block spans an aligned power of two of at least 2 memories (e.g. "0-1", "16-31")`,
    );
  }
  return { lo, hi };
}

/* --------------------------------- cover ---------------------------------- */

/** Tile [0,T) with aligned power-of-two blocks: keep a block whole iff its
 *  size is at most alpha times its age (age = T - lo) — detail decays with
 *  age. Smaller alpha ⇒ more, finer blocks. */
function coverAt(T: number, alpha: number): Block[] {
  let root = 1;
  while (root < T) root *= 2;
  const out: Block[] = [];
  const stack: Block[] = [{ lo: 0, hi: root }];
  while (stack.length > 0) {
    const { lo, hi } = stack.pop() as Block;
    if (lo >= T) continue;
    const size = hi - lo;
    if (size > 1 && (hi > T || size > alpha * (T - lo))) {
      const mid = lo + size / 2;
      stack.push({ lo, hi: mid }, { lo: mid, hi });
    } else {
      out.push({ lo, hi });
    }
  }
  return out.sort((a, b) => a.lo - b.lo);
}

/**
 * The wake cover: an exact partition of [0,T) into at most `budget` aligned
 * power-of-two blocks, sizes non-increasing toward the present, the newest
 * memory always by itself (verbatim). Found by binary search on alpha; the
 * power-of-two jumps make the search undershoot, so leftover budget is spent
 * splitting the newest multi-block — extra detail goes to the present.
 */
export function cover(T: number, budget: number): Block[] {
  if (T <= 0) return [];
  if (T <= budget) {
    const out: Block[] = [];
    for (let i = 0; i < T; i++) out.push({ lo: i, hi: i + 1 });
    return out;
  }
  let lo = 0.0;
  let hi = 1.0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (coverAt(T, mid).length > budget) lo = mid;
    else hi = mid;
  }
  const out = coverAt(T, hi);
  while (out.length < budget) {
    let i = -1;
    for (let j = out.length - 1; j >= 0; j--) {
      const block = out[j] as Block;
      if (block.hi - block.lo > 1) {
        i = j;
        break;
      }
    }
    if (i === -1) break;
    const { lo: blo, hi: bhi } = out[i] as Block;
    const mid = blo + (bhi - blo) / 2;
    out.splice(i, 1, { lo: blo, hi: mid }, { lo: mid, hi: bhi });
  }
  return out;
}

/* ------------------------- compression scheduling ------------------------- */

/** How many summaries each tree level holds (levels are dense prefixes, so a
 *  count per size is the complete state of compression progress). */
export type TreeLevelCounts = ReadonlyMap<number, number>;

/** Blocks that are buildable and not built, SMALLEST SIZE FIRST — the order
 *  guarantees a block's two halves are settled before the block is listed. */
export function pendingBlocks(
  T: number,
  levels: TreeLevelCounts,
  limit = Number.POSITIVE_INFINITY,
): Block[] {
  const todo: Block[] = [];
  for (let size = 2; size <= T; size *= 2) {
    const have = levels.get(size) ?? 0;
    const want = Math.floor(T / size);
    for (let k = have; k < want; k++) {
      todo.push({ lo: k * size, hi: (k + 1) * size });
      if (todo.length >= limit) return todo;
    }
  }
  return todo;
}

/** Clamped at zero per level: a level may hold MORE summaries than a
 *  snapshot T needs when another session ran ahead. */
export function pendingCount(T: number, levels: TreeLevelCounts): number {
  let count = 0;
  for (let size = 2; size <= T; size *= 2) {
    count += Math.max(0, Math.floor(T / size) - (levels.get(size) ?? 0));
  }
  return count;
}

/** What compress_memory owes: the block, the material, and the ask. */
export interface NapRequest {
  /** Inclusive block id, exactly what compress_memory takes back. */
  block: string;
  /** The complete instruction, ready to hand to the model. */
  instruction: string;
  /** Compressions left AFTER this one. */
  remaining: number;
}

/** Body lines are raw memories for small blocks, the two half-summaries for
 *  large ones — assembled by the store, worded here. */
export function napInstruction(
  lo: number,
  hi: number,
  body: string[],
  remaining: number,
): string {
  const tail =
    remaining <= 0
      ? ""
      : remaining === 1
        ? "\n1 compression remains after this one."
        : `\n${remaining} compressions remain after this one.`;
  return (
    `Compress memories #${formatBlock(lo, hi)} into one line of at most ${ENTRY_MAX_BYTES} bytes. ` +
    `Keep what has lasting effect, drop what does not. Invent nothing.\n\n` +
    body.map((line) => `  ${line}`).join("\n") +
    `\n\nCall compress_memory with block "${formatBlock(lo, hi)}" and your line.${tail}`
  );
}

/* --------------------------------- wake ----------------------------------- */

/** Async accessors the renderer walks — the store provides them. */
export interface WakeSource {
  /** Raw memories [lo, hi) in order. */
  logSlice(lo: number, hi: number): Promise<MemoryEntry[]>;
  /** The settled summary of [lo, hi), or null when not compressed yet. */
  summary(lo: number, hi: number): Promise<string | null>;
}

/**
 * The memory context: one line per cover block, oldest first — recent
 * memories verbatim ("#id date text"), older ones as summaries
 * ("#lo-hi summary"). A block whose summary is missing (compression not paid
 * yet) degrades instead of failing: raw lines when small, halves when large,
 * a placeholder once WAKE_EXPANSION_CAP is spent — the assistant is not a
 * CLI session that can be refused until it pays its naps.
 */
export async function renderWakeLines(
  T: number,
  source: WakeSource,
  budget = WAKE_LINES,
): Promise<string[]> {
  const lines: string[] = [];
  const state = { emitted: 0 };
  const emit = (line: string): void => {
    lines.push(line);
    state.emitted += 1;
  };

  async function render(lo: number, hi: number): Promise<void> {
    const size = hi - lo;
    if (size === 1) {
      const [entry] = await source.logSlice(lo, hi);
      emit(entry === undefined ? `#${lo} (unreadable)` : formatEntry(entry));
      return;
    }
    const summary = await source.summary(lo, hi);
    if (summary !== null) {
      emit(`#${formatBlock(lo, hi)} ${summary}`);
      return;
    }
    if (state.emitted + size <= WAKE_EXPANSION_CAP && size <= RAW_MAX) {
      for (const entry of await source.logSlice(lo, hi)) emit(formatEntry(entry));
      return;
    }
    if (state.emitted + 2 <= WAKE_EXPANSION_CAP && size > RAW_MAX) {
      const mid = lo + size / 2;
      await render(lo, mid);
      await render(mid, hi);
      return;
    }
    emit(`#${formatBlock(lo, hi)} (${size} memories, not compressed yet)`);
  }

  for (const block of cover(T, budget)) await render(block.lo, block.hi);
  return lines;
}

/* --------------------------------- recall --------------------------------- */

/** The model's query, as a case-insensitive regex; a query that is not a
 *  valid regex is taken literally instead of erroring — models often pass
 *  plain words. */
export function compileRecallPattern(query: string): RegExp {
  try {
    return new RegExp(query, "iu");
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
  }
}
