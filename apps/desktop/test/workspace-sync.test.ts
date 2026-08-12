import { describe, expect, it } from "vitest";
import {
  workspaceKeyFor,
  type Hlc,
  type PinnedTab,
  type SpaceMeta,
  type WorkspaceDoc,
} from "@suma/protocol";
import {
  decideMerge,
  docsForState,
  type GlobalWorkspaceState,
  type WorkspaceRegister,
} from "../src/main/sync/workspace-map";

function hlc(physicalMs: number, deviceId = "device-a", logical = 0): Hlc {
  return { physicalMs, logical, deviceId };
}

const spaceMeta: SpaceMeta = {
  id: "s1",
  name: "Personal",
  color: "#5b8cff",
  position: 0,
  egressPolicy: "direct",
  createdAtMs: 1000,
};

const pinTab: PinnedTab = {
  id: "p1",
  spaceId: "s1",
  url: "https://a.example/",
  title: "A",
  position: 0,
};

const spaceDoc: WorkspaceDoc = { kind: "space", space: spaceMeta };
const pinDoc: WorkspaceDoc = { kind: "pin", pin: pinTab };

describe("docsForState", () => {
  it("maps the snapshot-style globally-synced categories to docs (§8.3)", () => {
    const state: GlobalWorkspaceState = {
      spaces: [spaceMeta],
      pins: [pinTab],
      archives: [
        { id: "a1", spaceId: "s1", url: "https://b.example/", title: "B", archivedAtMs: 2 },
      ],
      settings: {
        historySyncEnabled: false,
        autoArchiveAfterHours: 12,
        keyMode: "e2ee",
        newTabUrl: "https://www.google.com",
      },
    };
    const docs = docsForState(state);
    // Each settings field is its own LWW register (§8.2), so settings fans out
    // to one independent doc key per field instead of a single "settings"
    // register.
    expect(docs.map(workspaceKeyFor).sort()).toEqual([
      "archive:a1",
      "pin:p1",
      "settings:autoArchive",
      "settings:historySync",
      "settings:keyMode",
      "settings:newTabUrl",
      "space:s1",
    ]);
    // Live-tab fields and focus are recorded incrementally by WorkspaceStore.
    expect(docs).toHaveLength(7);
  });
});

describe("decideMerge (LWW+HLC)", () => {
  const local: Record<string, WorkspaceRegister> = {
    "space:s1": { doc: spaceDoc, hlc: hlc(100, "device-a") },
  };

  it("applies a newer remote doc with a different value", () => {
    const renamed: WorkspaceDoc = { kind: "space", space: { ...spaceMeta, name: "Work" } };
    const decision = decideMerge(local, [
      { key: "space:s1", value: renamed, hlc: hlc(200, "device-b") },
    ]);
    expect(decision.apply).toHaveLength(1);
    expect(decision.adoptHlc).toHaveLength(0);
  });

  it("drops an older remote doc", () => {
    const decision = decideMerge(local, [
      { key: "space:s1", value: null, hlc: hlc(50, "device-b") },
    ]);
    expect(decision.apply).toHaveLength(0);
    expect(decision.adoptHlc).toHaveLength(0);
  });

  it("drops an equal-HLC doc (idempotent redelivery)", () => {
    const decision = decideMerge(local, [
      { key: "space:s1", value: spaceDoc, hlc: hlc(100, "device-a") },
    ]);
    expect(decision.apply).toHaveLength(0);
    expect(decision.adoptHlc).toHaveLength(0);
  });

  it("suppresses echoes: a newer doc equal to local state applies nothing", () => {
    const decision = decideMerge(local, [
      { key: "space:s1", value: spaceDoc, hlc: hlc(300, "device-b") },
    ]);
    // Adopt the HLC, apply nothing — no state change, no republish loop.
    expect(decision.apply).toHaveLength(0);
    expect(decision.adoptHlc).toHaveLength(1);
  });

  it("applies docs for unknown keys, including tombstones", () => {
    const decision = decideMerge(local, [
      { key: "pin:p1", value: pinDoc, hlc: hlc(150, "device-b") },
      { key: "pin:gone", value: null, hlc: hlc(151, "device-b") },
    ]);
    expect(decision.apply.map((d) => d.key)).toEqual(["pin:p1", "pin:gone"]);
  });

  it("applies a newer tombstone over a live local doc", () => {
    const decision = decideMerge(local, [
      { key: "space:s1", value: null, hlc: hlc(400, "device-b") },
    ]);
    expect(decision.apply).toHaveLength(1);
    expect(decision.apply[0]?.value).toBeNull();
  });
});
