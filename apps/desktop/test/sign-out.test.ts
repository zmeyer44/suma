import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import { LOCAL_STATE_FILES, performSignOut, removeLocalState } from "../src/main/sign-out";

const dirs: string[] = [];

function userDataDir(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "suma-signout-"));
  dirs.push(dir);
  for (const name of files) writeFileSync(path.join(dir, name), "{}");
  return dir;
}

/** A Session stub with just the three clear methods sign-out calls. */
function fakeSession(overrides: Partial<Record<"clearStorageData", () => Promise<void>>> = {}) {
  const calls: string[] = [];
  const session = {
    clearStorageData:
      overrides.clearStorageData ??
      (async () => {
        calls.push("storage");
      }),
    clearCache: async () => {
      calls.push("cache");
    },
    clearAuthCache: async () => {
      calls.push("auth");
    },
  };
  return { session: session as unknown as Session, calls };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("removeLocalState", () => {
  it("deletes every account file and its atomic-write staging twin", () => {
    const dir = userDataDir([...LOCAL_STATE_FILES, "device.json.tmp", "workspace.json.tmp"]);
    removeLocalState(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("takes the per-space cookie jars with it", () => {
    const dir = userDataDir([]);
    mkdirSync(path.join(dir, "Partitions", "space-abc"), { recursive: true });
    writeFileSync(path.join(dir, "Partitions", "space-abc", "Cookies"), "sqlite");
    removeLocalState(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves unrelated userData entries alone", () => {
    const dir = userDataDir(["device.json", "Cookies", "Preferences"]);
    removeLocalState(dir);
    expect(readdirSync(dir).sort()).toEqual(["Cookies", "Preferences"]);
  });

  it("is a no-op when nothing was ever written", () => {
    const dir = userDataDir([]);
    expect(() => removeLocalState(dir)).not.toThrow();
  });
});

describe("performSignOut", () => {
  it("stops services and clears sessions before deleting state, then restarts", async () => {
    const dir = userDataDir([...LOCAL_STATE_FILES]);
    const order: string[] = [];
    const { session } = fakeSession();

    await performSignOut({
      userDataDir: dir,
      stopServices: () => order.push("stop"),
      sessions: () => {
        order.push("sessions");
        return [session];
      },
      restart: async () => {
        order.push(`restart:${readdirSync(dir).length}`);
      },
    });

    // The restart sees an empty userData — the wipe happened before it.
    expect(order).toEqual(["stop", "sessions", "restart:0"]);
  });

  it("clears cookies, storage, and cached credentials for every session", async () => {
    const dir = userDataDir([]);
    const a = fakeSession();
    const b = fakeSession();

    await performSignOut({
      userDataDir: dir,
      stopServices: () => undefined,
      sessions: () => [a.session, b.session],
      restart: () => Promise.resolve(),
    });

    expect(a.calls).toEqual(["storage", "cache", "auth"]);
    expect(b.calls).toEqual(["storage", "cache", "auth"]);
  });

  it("still wipes and restarts when a session refuses to clear", async () => {
    const dir = userDataDir([...LOCAL_STATE_FILES]);
    const failing = fakeSession({
      clearStorageData: () => Promise.reject(new Error("session busy")),
    });
    const healthy = fakeSession();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let restarted = false;

    await performSignOut({
      userDataDir: dir,
      stopServices: () => undefined,
      sessions: () => [failing.session, healthy.session],
      restart: async () => {
        restarted = true;
      },
    });

    // A stuck session must never strand the user half-signed-out.
    expect(restarted).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(healthy.calls).toEqual(["storage", "cache", "auth"]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
