import { describe, expect, it } from "vitest";
import {
  checkEntry,
  compileRecallPattern,
  cover,
  decodeRecord,
  ENTRY_MAX_BYTES,
  formatBlock,
  formatEntry,
  LOG_RECORD_BYTES,
  napInstruction,
  padRecord,
  parseBlock,
  parseEntry,
  pendingBlocks,
  pendingCount,
  renderWakeLines,
  TREE_RECORD_BYTES,
  WAKE_EXPANSION_CAP,
  WAKE_LINES,
  type MemoryEntry,
  type WakeSource,
} from "../src/main/memory/memory-core";

/* ------------------------------- records ---------------------------------- */

describe("fixed-width records", () => {
  it("round-trips a line, including multi-byte UTF-8", () => {
    const line = "#7 2026-08-21 café ☕ — prefers the corner täble";
    const record = padRecord(line, LOG_RECORD_BYTES);
    expect(record.byteLength).toBe(LOG_RECORD_BYTES);
    expect(record[LOG_RECORD_BYTES - 1]).toBe(0x0a);
    expect(decodeRecord(record)).toBe(line);
  });

  it("refuses a line that overflows its slot", () => {
    expect(() =>
      padRecord("x".repeat(LOG_RECORD_BYTES), LOG_RECORD_BYTES),
    ).toThrow(/overflow/);
    // Multi-byte characters count in BYTES: 140 é fit a 288-byte slot, 150 don't.
    expect(() => padRecord("é".repeat(140), TREE_RECORD_BYTES)).not.toThrow();
    expect(() => padRecord("é".repeat(150), TREE_RECORD_BYTES)).toThrow(
      /overflow/,
    );
  });

  it("reports invalid UTF-8 as null, blank as empty", () => {
    const torn = new Uint8Array(LOG_RECORD_BYTES).fill(0xff);
    expect(decodeRecord(torn)).toBeNull();
    expect(decodeRecord(padRecord("", LOG_RECORD_BYTES))).toBe("");
  });

  it("formats and parses entries", () => {
    const entry: MemoryEntry = {
      id: 12,
      date: "2026-08-21",
      text: "likes tea",
    };
    expect(parseEntry(formatEntry(entry))).toEqual(entry);
    expect(parseEntry("garbage")).toBeNull();
  });
});

describe("checkEntry", () => {
  it("trims, and enforces one line under the byte limit", () => {
    expect(checkEntry("  likes tea  ")).toBe("likes tea");
    expect(() => checkEntry("   ")).toThrow(/empty/);
    expect(() => checkEntry("a\nb")).toThrow(/one line/);
    expect(() => checkEntry("x".repeat(ENTRY_MAX_BYTES + 1))).toThrow(
      /too long/,
    );
    // é is 2 bytes: 150 of them clear the char count but not the byte count.
    expect(() => checkEntry("é".repeat(150))).toThrow(/too long/);
    expect(checkEntry("x".repeat(ENTRY_MAX_BYTES)).length).toBe(
      ENTRY_MAX_BYTES,
    );
  });
});

describe("parseBlock", () => {
  it("accepts inclusive aligned power-of-two ids", () => {
    expect(parseBlock("16-31")).toEqual({ lo: 16, hi: 32 });
    expect(parseBlock("#0-1")).toEqual({ lo: 0, hi: 2 });
    expect(formatBlock(16, 32)).toBe("16-31");
  });

  it("rejects everything else with a model-readable message", () => {
    for (const bad of ["16-30", "3-4", "8-8", "1-2", "x", "-1-0", "0-2"]) {
      expect(() => parseBlock(bad)).toThrow(/block/);
    }
  });
});

/* -------------------------------- cover ----------------------------------- */

function checkCoverInvariants(T: number, budget: number): void {
  const blocks = cover(T, budget);
  // Exact partition of [0, T).
  let at = 0;
  for (const { lo, hi } of blocks) {
    expect(lo).toBe(at);
    expect(hi).toBeGreaterThan(lo);
    at = hi;
  }
  expect(at).toBe(T);
  // Within budget.
  expect(blocks.length).toBeLessThanOrEqual(Math.max(budget, 1));
  // Aligned powers of two, non-increasing toward the present, and every
  // multi-block buildable by the nap schedule (hi <= T).
  let prevSize = Number.POSITIVE_INFINITY;
  for (const { lo, hi } of blocks) {
    const size = hi - lo;
    expect(size & (size - 1)).toBe(0);
    expect(lo % size).toBe(0);
    expect(size).toBeLessThanOrEqual(prevSize);
    prevSize = size;
    if (size > 1) expect(hi).toBeLessThanOrEqual(T);
  }
  // The newest memory is always verbatim.
  if (T > 0) {
    const last = blocks[blocks.length - 1] as { lo: number; hi: number };
    expect(last.hi - last.lo).toBe(1);
  }
}

describe("cover", () => {
  it("holds every invariant for all small T and a spread of large ones", () => {
    for (let T = 0; T <= 400; T++) checkCoverInvariants(T, WAKE_LINES);
    for (const T of [1000, 4096, 10000, 65536, 100003]) {
      checkCoverInvariants(T, WAKE_LINES);
    }
  });

  it("is verbatim under budget and logarithmic above it", () => {
    expect(cover(96, WAKE_LINES)).toHaveLength(96);
    expect(cover(96, WAKE_LINES).every((b) => b.hi - b.lo === 1)).toBe(true);
    const big = cover(100000, WAKE_LINES);
    expect(big.length).toBeLessThanOrEqual(WAKE_LINES);
    expect(big.length).toBeGreaterThan(WAKE_LINES / 2);
  });
});

/* ---------------------------- nap scheduling ------------------------------- */

describe("pending compressions", () => {
  it("lists buildable blocks smallest size first, halves before parents", () => {
    const empty = new Map<number, number>();
    const todo = pendingBlocks(8, empty);
    expect(todo).toEqual([
      { lo: 0, hi: 2 },
      { lo: 2, hi: 4 },
      { lo: 4, hi: 6 },
      { lo: 6, hi: 8 },
      { lo: 0, hi: 4 },
      { lo: 4, hi: 8 },
      { lo: 0, hi: 8 },
    ]);
    expect(pendingCount(8, empty)).toBe(7);
    expect(pendingBlocks(8, empty, 1)).toEqual([{ lo: 0, hi: 2 }]);
  });

  it("clamps levels that ran ahead of the snapshot", () => {
    const ahead = new Map([[2, 10]]);
    expect(pendingCount(4, ahead)).toBe(1); // only the 0-3 block
  });

  it("keeps every multi-block a cover wants settled, over a whole life", () => {
    // Simulate 500 notes, paying every pending compression as it appears —
    // the discipline the tools enforce. At every T, the cover must only ask
    // for blocks the schedule has already built.
    const levels = new Map<number, number>();
    let naps = 0;
    for (let T = 1; T <= 500; T++) {
      for (const { lo, hi } of pendingBlocks(T, levels)) {
        const size = hi - lo;
        expect(levels.get(size) ?? 0).toBe(lo / size); // strictly in order
        levels.set(size, lo / size + 1);
        naps += 1;
      }
      expect(pendingCount(T, levels)).toBe(0);
      for (const { lo, hi } of cover(T, WAKE_LINES)) {
        const size = hi - lo;
        if (size === 1) continue;
        expect(levels.get(size) ?? 0).toBeGreaterThan(lo / size);
      }
    }
    let expected = 0;
    for (let size = 2; size <= 500; size *= 2)
      expected += Math.floor(500 / size);
    expect(naps).toBe(expected);
  });

  it("words the ask with the block id and the remaining count", () => {
    const text = napInstruction(
      16,
      32,
      ["#16 2026-01-01 a", "#17 2026-01-02 b"],
      2,
    );
    expect(text).toContain('compress_memory with block "16-31"');
    expect(text).toContain("2 compressions remain after this one.");
    expect(napInstruction(0, 2, [], 0)).not.toContain("remain");
  });
});

/* --------------------------------- wake ------------------------------------ */

function fakeSource(T: number, summaries: Map<string, string>): WakeSource {
  return {
    logSlice: (lo, hi) => {
      const out: MemoryEntry[] = [];
      for (let i = lo; i < Math.min(hi, T); i++) {
        out.push({ id: i, date: "2026-01-01", text: `memory ${i}` });
      }
      return Promise.resolve(out);
    },
    summary: (lo, hi) => Promise.resolve(summaries.get(`${lo}-${hi}`) ?? null),
  };
}

describe("renderWakeLines", () => {
  it("renders raw lines under budget and summaries above it", async () => {
    const few = await renderWakeLines(3, fakeSource(3, new Map()));
    expect(few).toEqual([
      "#0 2026-01-01 memory 0",
      "#1 2026-01-01 memory 1",
      "#2 2026-01-01 memory 2",
    ]);

    const T = 1000;
    const summaries = new Map<string, string>();
    for (const { lo, hi } of cover(T, WAKE_LINES)) {
      if (hi - lo > 1) summaries.set(`${lo}-${hi}`, `sum of ${lo}..${hi - 1}`);
    }
    const lines = await renderWakeLines(T, fakeSource(T, summaries));
    expect(lines.length).toBeLessThanOrEqual(WAKE_LINES);
    expect(lines[0]).toMatch(/^#0-\d+ sum of 0\.\./);
    expect(lines[lines.length - 1]).toBe(
      `#${T - 1} 2026-01-01 memory ${T - 1}`,
    );
  });

  it("degrades missing summaries without exceeding the expansion cap", async () => {
    const lines = await renderWakeLines(1000, fakeSource(1000, new Map()));
    expect(lines.length).toBeLessThanOrEqual(WAKE_EXPANSION_CAP + WAKE_LINES);
    expect(lines.some((l) => l.includes("not compressed yet"))).toBe(true);
    // The present stays verbatim regardless.
    expect(lines[lines.length - 1]).toBe("#999 2026-01-01 memory 999");
  });

  it("batches adjacent raw blocks and pipelines independent summaries", async () => {
    let rawCalls = 0;
    const raw = fakeSource(50, new Map());
    const lines = await renderWakeLines(50, {
      logSlice: (lo, hi) => {
        rawCalls += 1;
        return raw.logSlice(lo, hi);
      },
      summary: raw.summary,
    });
    expect(lines).toHaveLength(50);
    expect(rawCalls).toBe(1);

    let inFlight = 0;
    let maxInFlight = 0;
    const settled = fakeSource(1000, new Map());
    await renderWakeLines(1000, {
      logSlice: settled.logSlice,
      summary: async (lo, hi) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return `sum ${lo}-${hi}`;
      },
    });
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

/* -------------------------------- recall ----------------------------------- */

describe("compileRecallPattern", () => {
  it("matches literal text case-insensitively", () => {
    expect(
      compileRecallPattern("allerg").test("#3 2026-01-01 Shellfish ALLERGY"),
    ).toBe(true);
    expect(compileRecallPattern("#7 ").test("#7 2026-01-01 x")).toBe(true);
    expect(compileRecallPattern("#7 ").test("#17 2026-01-01 x")).toBe(false);
  });

  it("never executes regex syntax", () => {
    expect(
      compileRecallPattern("c++ (the").test(
        "#1 2026-01-01 loves c++ (the language)",
      ),
    ).toBe(true);
    expect(
      compileRecallPattern("(a+)+$").test("#1 2026-01-01 (a+)+$ literal"),
    ).toBe(true);
  });
});
