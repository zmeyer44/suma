import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HISTORY_MAX_VISITS, type HistoryVisit } from "@suma/protocol";
import { HISTORY_DEDUPE_MS, HistoryService, type HistoryStore } from "../src/main/history";
import { WorkspaceStore } from "../src/main/workspace-store";

/**
 * §8.3 "Browsing history — user-configurable encrypted sync (off by default)".
 * The service tests cover capture semantics; the WorkspaceStore tests cover
 * the sync gate — visits must never grow an LWW register (the thing that gets
 * published) while the toggle is off.
 */

function fakeStore(): HistoryStore & { visits: HistoryVisit[]; cleared: number } {
  const state = {
    visits: [] as HistoryVisit[],
    cleared: 0,
    historyVisits: () => [...state.visits].sort((a, b) => b.atMs - a.atMs),
    addHistoryVisit: (visit: HistoryVisit) => void state.visits.push({ ...visit }),
    updateHistoryVisitTitle: (id: string, title: string) => {
      const visit = state.visits.find((v) => v.id === id);
      if (visit) visit.title = title;
    },
    clearHistory: () => {
      state.visits = [];
      state.cleared += 1;
    },
  };
  return state;
}

function service(store: HistoryStore, clock: { now: number }): HistoryService {
  let seq = 0;
  return new HistoryService(store, () => clock.now, () => `visit-${++seq}`);
}

describe("HistoryService capture", () => {
  it("records committed web navigations, newest first", () => {
    const store = fakeStore();
    const clock = { now: 1000 };
    const history = service(store, clock);
    history.noteVisit("https://a.example/", "A");
    clock.now += HISTORY_DEDUPE_MS + 1;
    history.noteVisit("https://b.example/", "B");
    expect(history.list("", 10).map((v) => v.url)).toEqual([
      "https://b.example/",
      "https://a.example/",
    ]);
  });

  it("never records privileged or blank URLs", () => {
    const store = fakeStore();
    const history = service(store, { now: 0 });
    history.noteVisit("about:blank", "");
    history.noteVisit("suma://files", "Files");
    history.noteVisit("file:///etc/passwd", "");
    history.noteVisit("", "");
    expect(store.visits).toEqual([]);
  });

  it("collapses reload/SPA echoes of the same URL inside the dedupe window", () => {
    const store = fakeStore();
    const clock = { now: 0 };
    const history = service(store, clock);
    history.noteVisit("https://app.example/inbox", "Inbox");
    clock.now = HISTORY_DEDUPE_MS - 1;
    history.noteVisit("https://app.example/inbox", "Inbox");
    expect(store.visits).toHaveLength(1);
    // Past the window it is a genuine revisit.
    clock.now = HISTORY_DEDUPE_MS * 3;
    history.noteVisit("https://app.example/inbox", "Inbox");
    expect(store.visits).toHaveLength(2);
  });

  it("attaches the late page title to the visit that navigated", () => {
    const store = fakeStore();
    const history = service(store, { now: 0 });
    history.noteVisit("https://a.example/doc", "");
    history.noteTitle("https://a.example/doc", "The Document");
    expect(store.visits[0]?.title).toBe("The Document");
    // A title for a URL never visited goes nowhere.
    history.noteTitle("https://never.example/", "Nope");
    expect(store.visits).toHaveLength(1);
  });

  it("filters by substring of URL or title, case-insensitively", () => {
    const store = fakeStore();
    const clock = { now: 0 };
    const history = service(store, clock);
    history.noteVisit("https://github.com/suma/suma", "Suma repo");
    clock.now += HISTORY_DEDUPE_MS + 1;
    history.noteVisit("https://linear.app/team", "Sprint board");
    expect(history.list("GITHUB", 10)).toHaveLength(1);
    expect(history.list("sprint", 10)).toHaveLength(1);
    expect(history.list("zzz", 10)).toHaveLength(0);
  });
});

describe("WorkspaceStore history sync gate (§8.3, off by default)", () => {
  function tmpStore(): WorkspaceStore {
    return new WorkspaceStore(
      path.join(tmpdir(), `suma-history-${randomUUID()}`, "workspace.json"),
      "device-test",
    );
  }

  const visit = (id: string, atMs: number): HistoryVisit => ({
    id,
    url: `https://example.com/${id}`,
    title: id,
    atMs,
  });

  it("stores visits locally but publishes NO register while sync is off", () => {
    const store = tmpStore();
    store.addHistoryVisit(visit("v1", Date.now()));
    expect(store.historyVisits()).toHaveLength(1);
    expect(Object.keys(store.lwwRegisters())).toEqual([]);
  });

  it("publishes a sealed-doc register per visit once the toggle is on", () => {
    const store = tmpStore();
    store.updateSettings({ historySyncEnabled: true });
    store.addHistoryVisit(visit("v1", Date.now()));
    expect(Object.keys(store.lwwRegisters())).toContain("history:v1");
  });

  it("does not retroactively publish visits recorded before enabling", () => {
    const store = tmpStore();
    store.addHistoryVisit(visit("old", Date.now()));
    store.updateSettings({ historySyncEnabled: true });
    store.addHistoryVisit(visit("new", Date.now()));
    const keys = Object.keys(store.lwwRegisters());
    expect(keys).toContain("history:new");
    expect(keys).not.toContain("history:old");
  });

  it("a title update must not leak an unsynced visit", () => {
    const store = tmpStore();
    store.addHistoryVisit(visit("quiet", Date.now()));
    store.updateSettings({ historySyncEnabled: true });
    store.updateHistoryVisitTitle("quiet", "Now titled");
    expect(store.historyVisits()[0]?.title).toBe("Now titled");
    expect(Object.keys(store.lwwRegisters())).not.toContain("history:quiet");
  });

  it("clear tombstones published visits and simply drops unpublished ones", () => {
    const store = tmpStore();
    store.addHistoryVisit(visit("local-only", Date.now()));
    store.updateSettings({ historySyncEnabled: true });
    store.addHistoryVisit(visit("synced", Date.now()));
    store.clearHistory();
    expect(store.historyVisits()).toEqual([]);
    const registers = store.lwwRegisters();
    expect(registers["history:synced"]?.doc).toBeNull(); // tombstone → deletes everywhere
    expect(registers["history:local-only"]).toBeUndefined(); // never left this Mac
  });

  it("caps retained visits and drops the pruned visits' registers, not tombstoning them", () => {
    const store = tmpStore();
    store.updateSettings({ historySyncEnabled: true });
    const base = Date.now();
    for (let i = 0; i < HISTORY_MAX_VISITS + 10; i += 1) {
      store.addHistoryVisit(visit(`v${i}`, base + i));
    }
    expect(store.historyVisits()).toHaveLength(HISTORY_MAX_VISITS);
    const registers = store.lwwRegisters();
    expect(registers["history:v0"]).toBeUndefined(); // pruned, silently
    expect(registers[`history:v${HISTORY_MAX_VISITS + 9}`]).toBeDefined();
  });

  it("applies remote visits and remote clear-tombstones", () => {
    const store = tmpStore();
    const hlc = { physicalMs: Date.now(), logical: 0, deviceId: "device-a" };
    store.applyRemoteDoc("history:r1", { kind: "history", visit: visit("r1", Date.now()) }, hlc);
    expect(store.historyVisits().map((v) => v.id)).toEqual(["r1"]);
    store.applyRemoteDoc("history:r1", null, { ...hlc, logical: 1 });
    expect(store.historyVisits()).toEqual([]);
  });
});
