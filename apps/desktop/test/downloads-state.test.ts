import { describe, expect, it } from "vitest";
import type { DownloadItemInfo } from "../src/shared/ipc";
import {
  MAX_TRACKED_DOWNLOADS,
  reduceDownloads,
  uniqueSavePath,
  type DownloadEvent,
} from "../src/main/downloads-state";

function started(id: string, atMs = 1000): DownloadEvent {
  return {
    type: "started",
    id,
    spaceId: "s1",
    url: `https://files.example/${id}`,
    filename: `${id}.zip`,
    savePath: `/tmp/${id}.zip`,
    totalBytes: 100,
    startedAtMs: atMs,
  };
}

function run(events: DownloadEvent[]): DownloadItemInfo[] {
  return events.reduce(reduceDownloads, [] as DownloadItemInfo[]);
}

describe("reduceDownloads", () => {
  it("prepends started items newest-first", () => {
    const items = run([started("a", 1), started("b", 2)]);
    expect(items.map((i) => i.id)).toEqual(["b", "a"]);
    expect(items[0]?.state).toBe("progressing");
    expect(items[0]?.receivedBytes).toBe(0);
  });

  it("updates progress only while progressing", () => {
    const items = run([
      started("a"),
      { type: "progress", id: "a", receivedBytes: 40, totalBytes: 100 },
    ]);
    expect(items[0]?.receivedBytes).toBe(40);

    const done = run([
      started("a"),
      { type: "cancelled", id: "a" },
      { type: "progress", id: "a", receivedBytes: 99, totalBytes: 100 },
    ]);
    expect(done[0]?.state).toBe("cancelled");
    expect(done[0]?.receivedBytes).toBe(0);
  });

  it("resolves the final save path on completion", () => {
    const items = run([
      started("a"),
      { type: "completed", id: "a", receivedBytes: 100, savePath: "/Users/x/Downloads/a.zip" },
    ]);
    expect(items[0]?.state).toBe("completed");
    expect(items[0]?.savePath).toBe("/Users/x/Downloads/a.zip");
    expect(items[0]?.receivedBytes).toBe(100);
  });

  it("marks interruptions", () => {
    const items = run([started("a"), { type: "interrupted", id: "a" }]);
    expect(items[0]?.state).toBe("interrupted");
  });

  it("ignores events for unknown ids", () => {
    const items = run([started("a"), { type: "completed", id: "ghost", receivedBytes: 1 }]);
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe("progressing");
  });

  it("re-starting an id replaces the old entry", () => {
    const items = run([started("a", 1), { type: "cancelled", id: "a" }, started("a", 2)]);
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe("progressing");
    expect(items[0]?.startedAtMs).toBe(2);
  });

  it("caps the list, dropping the oldest", () => {
    const events: DownloadEvent[] = [];
    for (let i = 0; i < MAX_TRACKED_DOWNLOADS + 5; i++) events.push(started(`d${i}`, i));
    const items = run(events);
    expect(items).toHaveLength(MAX_TRACKED_DOWNLOADS);
    expect(items[0]?.id).toBe(`d${MAX_TRACKED_DOWNLOADS + 4}`);
  });
});

describe("uniqueSavePath", () => {
  const none = () => false;

  it("uses the plain name when nothing is in the way", () => {
    expect(uniqueSavePath("/Users/me/Downloads", "report.pdf", none)).toBe(
      "/Users/me/Downloads/report.pdf",
    );
  });

  it("numbers around collisions the way Chrome does", () => {
    const taken = new Set(["/d/report.pdf", "/d/report (1).pdf"]);
    expect(uniqueSavePath("/d", "report.pdf", (p) => taken.has(p))).toBe("/d/report (2).pdf");
  });

  it("keeps a dotfile's name intact instead of treating it as an extension", () => {
    const taken = new Set(["/d/.gitignore"]);
    expect(uniqueSavePath("/d", ".gitignore", (p) => taken.has(p))).toBe("/d/.gitignore (1)");
  });

  it("numbers a name that has no extension", () => {
    const taken = new Set(["/d/LICENSE"]);
    expect(uniqueSavePath("/d", "LICENSE", (p) => taken.has(p))).toBe("/d/LICENSE (1)");
  });

  it("refuses to let a filename steer the write out of the downloads directory", () => {
    expect(uniqueSavePath("/d", "../../etc/passwd", none)).toBe("/d/passwd");
    expect(uniqueSavePath("/d", "a/b/evil.sh", none)).toBe("/d/evil.sh");
    expect(uniqueSavePath("/d", "..", none)).toBe("/d/download");
    expect(uniqueSavePath("/d", "   ", none)).toBe("/d/download");
  });

  it("joins with the platform separator and never doubles it", () => {
    expect(uniqueSavePath("C:\\Users\\me", "a.txt", none, "\\")).toBe("C:\\Users\\me\\a.txt");
    expect(uniqueSavePath("/d/", "a.txt", none)).toBe("/d/a.txt");
  });
});
