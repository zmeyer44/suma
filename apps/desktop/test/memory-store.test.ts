import { appendFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimAgent } from "../src/main/compute/sim-agent";
import {
  compileRecallPattern,
  formatBlock,
  LOG_RECORD_BYTES,
} from "../src/main/memory/memory-core";
import { MemoryService } from "../src/main/memory/memory-service";
import { MemoryStore } from "../src/main/memory/memory-store";

let root: string;
let link: SimAgent;
let store: MemoryStore;
let service: MemoryService;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "suma-memory-"));
  link = new SimAgent({ root: () => root });
  store = new MemoryStore(() => link);
  service = new MemoryService();
  service.bind(link);
});

afterEach(async () => {
  link.stop();
  await rm(root, { recursive: true, force: true });
});

const logPath = (): string => path.join(root, ".suma", "memory", "LOG.txt");
const treePath = (size: number): string =>
  path.join(root, ".suma", "memory", "TREE", String(size));

describe("MemoryStore over the VFS", () => {
  it("appends dense ids in aligned records and reads them back", async () => {
    expect(await store.logLen()).toBe(0);
    expect(await store.append(["likes tea ☕"], "2026-08-21")).toBe(0);
    expect(await store.append(["cat named Möbius"], "2026-08-21")).toBe(1);
    expect(statSync(logPath()).size).toBe(2 * LOG_RECORD_BYTES);
    expect(await store.logSlice(0, 2)).toEqual([
      { id: 0, date: "2026-08-21", text: "likes tea ☕" },
      { id: 1, date: "2026-08-21", text: "cat named Möbius" },
    ]);
  });

  it("keeps queued appends collision-free", async () => {
    const ids = await Promise.all(
      Array.from({ length: 16 }, (_, i) => store.append([`note ${i}`], "2026-08-21")),
    );
    expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(await store.logLen()).toBe(16);
  });

  it("repairs a torn trailing record before appending", async () => {
    await store.append(["first"], "2026-08-21");
    appendFileSync(logPath(), "torn garbage");
    await store.append(["second"], "2026-08-21");
    expect(statSync(logPath()).size).toBe(2 * LOG_RECORD_BYTES);
    const entries = await store.logSlice(0, 2);
    expect(entries.map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("settles summaries strictly in order and reads them back", async () => {
    await store.append(["a", "b", "c", "d"], "2026-08-21");
    expect(await store.summary(0, 2)).toBeNull();
    expect(await store.putSummary(2, 4, "cd summary")).toBe(false); // out of order
    expect(await store.putSummary(0, 2, "ab summary")).toBe(true);
    expect(await store.putSummary(0, 2, "again")).toBe(false); // already settled
    expect(await store.putSummary(2, 4, "cd summary")).toBe(true);
    expect(await store.summary(0, 2)).toBe("ab summary");
    expect(await store.summary(2, 4)).toBe("cd summary");
  });

  it("hands out naps smallest-first with raw bodies, then half-summary bodies", async () => {
    const texts = Array.from({ length: 32 }, (_, i) => `note ${i}`);
    await store.append(texts, "2026-08-21");
    // Pay everything up to the 32-block: its body must be the two 16-halves.
    for (;;) {
      const nap = await store.nextNap(32);
      expect(nap).not.toBeNull();
      if (nap === null) throw new Error("unreachable");
      if (nap.block === formatBlock(0, 32)) {
        expect(nap.instruction).toContain("#0-15 sum 0-15");
        expect(nap.instruction).toContain("#16-31 sum 16-31");
        expect(nap.remaining).toBe(0);
        break;
      }
      const [lo, hi] = nap.block.split("-").map(Number) as [number, number];
      expect(nap.instruction).toContain(`#${lo} 2026-08-21 note ${lo}`);
      await store.putSummary(lo, hi + 1, `sum ${nap.block}`);
    }
    await store.putSummary(0, 32, "sum 0-31");
    expect(await store.nextNap(32)).toBeNull();
    expect(await store.pendingCompressions(32)).toBe(0);
  });

  it("drops a corrupt summary and everything above it, then rebuilds", async () => {
    await store.append(["a", "b", "c", "d"], "2026-08-21");
    await store.putSummary(0, 2, "ab");
    await store.putSummary(2, 4, "cd");
    await store.putSummary(0, 4, "abcd");
    // Blank out the 2-level's first record on disk: corruption.
    const good = statSync(treePath(2)).size;
    await store.dropSummaries(0, 2);
    expect(statSync(treePath(2)).size).toBe(0);
    expect(statSync(treePath(4)).size).toBe(0);
    expect(await store.pendingCompressions(4)).toBe(3);
    // The schedule rebuilds in order.
    await store.putSummary(0, 2, "ab2");
    await store.putSummary(2, 4, "cd2");
    await store.putSummary(0, 4, "abcd2");
    expect(statSync(treePath(2)).size).toBe(good);
    expect(await store.summary(0, 4)).toBe("abcd2");
  });

  it("recalls by text, id, and date, newest first under the cap", async () => {
    await store.append(
      ["loves sushi", "daughter Maya born", "allergic to shellfish", "moved to Lisbon"],
      "2026-08-21",
    );
    const byText = await store.scanMatches(compileRecallPattern("shellfish"), 6000);
    expect(byText.total).toBe(1);
    expect(byText.lines[0]).toContain("#2 2026-08-21 allergic to shellfish");
    const byId = await store.scanMatches(compileRecallPattern("^#1 "), 6000);
    expect(byId.total).toBe(1);
    expect(byId.lines[0]).toContain("Maya");
    const byDate = await store.scanMatches(compileRecallPattern("2026-08-21"), 6000);
    expect(byDate.total).toBe(4);
    // The cap keeps the NEWEST matches.
    const capped = await store.scanMatches(compileRecallPattern("."), 80);
    expect(capped.total).toBe(4);
    expect(capped.lines.length).toBeLessThan(4);
    expect(capped.lines[capped.lines.length - 1]).toContain("Lisbon");
  });
});

describe("MemoryService", () => {
  it("notes, then chains compressions to done", async () => {
    for (let i = 0; i < 3; i++) {
      const result = await service.note(`note ${i}`);
      expect(result.id).toBe(i);
      if (result.pending !== null) {
        await service.compress(result.pending.block, `sum ${result.pending.block}`);
      }
    }
    // #0-1 completed at the second note and was paid.
    expect(await store.summary(0, 2)).toBe("sum 0-1");
    expect(await store.pendingCompressions(await store.logLen())).toBe(0);
  });

  it("rejects an out-of-order compression naming the right block", async () => {
    await store.append(["a", "b", "c", "d"], "2026-08-21");
    await expect(service.compress("2-3", "cd")).rejects.toThrow(/next owed is "0-1"/);
    const done = await service.compress("0-1", "ab");
    expect(done.message).toContain("saved");
    expect(done.next?.block).toBe("2-3");
  });

  it("expands summarized blocks down to raw memories", async () => {
    await store.append(Array.from({ length: 4 }, (_, i) => `note ${i}`), "2026-08-21");
    const raw = await service.expand("0-3");
    expect(raw).toEqual([
      "#0 2026-08-21 note 0",
      "#1 2026-08-21 note 1",
      "#2 2026-08-21 note 2",
      "#3 2026-08-21 note 3",
    ]);
    await expect(service.expand("64-127")).rejects.toThrow(/beyond the memory/);
  });

  it("builds a wake context with instructions, lines, and a pending note", async () => {
    expect(await service.wakeContext()).toContain("no saved memories");
    await store.append(["likes tea", "cat named Möbius", "lives in Lisbon"], "2026-08-21");
    const context = await service.wakeContext();
    expect(context).toContain("## Long-term memory");
    expect(context).toContain("#1 2026-08-21 cat named Möbius");
    expect(context).toContain("3 total");
    expect(context).toContain("1 compression pending");
  });

  it("goes quietly memoryless when no link is bound", async () => {
    const unbound = new MemoryService();
    expect(unbound.available()).toBe(false);
    expect(await unbound.wakeContext()).toBeNull();
    await expect(unbound.note("x")).rejects.toThrow(/unavailable/);
  });
});
