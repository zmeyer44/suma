/**
 * Adapter mapping tests.
 *
 * The adapter is the seam between the app's method contract and the desktop's
 * channel contract, so what is asserted here is exactly what breaks the Files
 * page when it drifts: the channel each method names, the argument shape main
 * validates, and the result shape the UI renders.
 *
 * Pure: the fake channel API records calls and returns canned payloads. No
 * Electron, no DOM.
 */

import { describe, expect, it } from "vitest";
import { CLOUD_ROOT, type FileEntry, type Transfer } from "@suma/protocol";
import type { SumaFilesBridge, UploadProgress } from "./bridge";
import { adaptBridge, ChannelBridge, isChannelApi, type SumaFilesChannelApi } from "./channel-bridge";
import { MockBridge } from "./mock-bridge";

interface Call {
  channel: string;
  args: unknown;
}

class FakeChannelApi implements SumaFilesChannelApi {
  readonly calls: Call[] = [];
  readonly listeners = new Map<string, (payload: unknown) => void>();
  /** Channels that reject, the way the preload rejects one outside its allowlist. */
  readonly blocked = new Set<string>();
  #results = new Map<string, unknown>();
  #failures = new Map<string, Error>();

  constructor(results: Record<string, unknown> = {}) {
    for (const [channel, value] of Object.entries(results)) this.#results.set(channel, value);
  }

  fail(channel: string, message: string): void {
    this.#failures.set(channel, new Error(message));
  }

  invoke(channel: string, args?: unknown): Promise<unknown> {
    this.calls.push({ channel, args });
    const failure = this.#failures.get(channel);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(this.#results.get(channel));
  }

  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (this.blocked.has(channel)) throw new Error(`blocked event channel "${channel}"`);
    this.listeners.set(channel, listener);
    return () => this.listeners.delete(channel);
  }

  emit(channel: string, payload: unknown): void {
    this.listeners.get(channel)?.(payload);
  }
}

function entry(path: string, sizeBytes = 10): FileEntry {
  return {
    id: `file_${path}`,
    path,
    sizeBytes,
    fileHash: "a".repeat(64),
    contentType: "text/plain",
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

function transfer(id: string): Transfer {
  return {
    id,
    url: "https://example.com/big.tar",
    destPath: "/datasets/big.tar",
    state: "fetching",
    receivedBytes: 1,
    totalBytes: 2,
    originDeviceId: "dev_studio",
    error: null,
    startedAtMs: 1,
    updatedAtMs: 2,
  };
}

describe("adaptBridge", () => {
  it("wraps a channel-shaped injection", () => {
    const api = new FakeChannelApi();
    expect(isChannelApi(api)).toBe(true);
    expect(adaptBridge(api)).toBeInstanceOf(ChannelBridge);
  });

  it("passes a method-shaped injection through untouched", () => {
    const bridge: SumaFilesBridge = new MockBridge({ empty: true });
    expect(isChannelApi(bridge)).toBe(false);
    expect(adaptBridge(bridge)).toBe(bridge);
  });
});

describe("reads", () => {
  it("lists the recursive entries the tree is built from", async () => {
    const api = new FakeChannelApi({
      "files:list": { path: "/", dirs: [], files: [entry("/a.txt")], entries: [entry("/a.txt"), entry("/n/b.txt")] },
    });
    const files = await adaptBridge(api).list("/");
    expect(api.calls[0]).toEqual({ channel: "files:list", args: { path: "/" } });
    expect(files.map((file) => file.path)).toEqual(["/a.txt", "/n/b.txt"]);
  });

  it("falls back to the directory level when a listing has no recursive entries", async () => {
    const api = new FakeChannelApi({ "files:list": { path: "/", dirs: [], files: [entry("/a.txt")] } });
    expect((await adaptBridge(api).list("/")).map((file) => file.path)).toEqual(["/a.txt"]);
  });

  it("maps the quota meter down to the two numbers the UI meters", async () => {
    const api = new FakeChannelApi({
      "files:quota": { usedBytes: 5, limitBytes: 10, usedLabel: "5 B", softBlocked: false },
    });
    expect(await adaptBridge(api).quota()).toEqual({ usedBytes: 5, limitBytes: 10 });
  });

  it("takes the transfers half of the snapshot", async () => {
    const api = new FakeChannelApi({
      "transfers:list": { transfers: [transfer("t1")], declined: { url: "https://x" } },
    });
    const list = await adaptBridge(api).listTransfers();
    expect(list.map((item) => item.id)).toEqual(["t1"]);
  });

  it("returns null from stat for a file that is gone", async () => {
    const api = new FakeChannelApi({ "files:stat": null });
    expect(await adaptBridge(api).stat("/gone.txt")).toBeNull();
  });

  it("reports device labels and never claims encryption it was not told about", async () => {
    const api = new FakeChannelApi({
      "files:context": {
        thisDeviceId: "dev_this",
        devices: [{ id: "dev_studio", name: "Mac Studio" }, { id: 7 }],
        cloudRoot: "~/cloud",
      },
    });
    const context = await adaptBridge(api).context();
    expect(context).toEqual({
      thisDeviceId: "dev_this",
      devices: [{ id: "dev_studio", name: "Mac Studio" }],
      cloudRoot: CLOUD_ROOT,
      endToEndEncrypted: false,
    });
  });
});

describe("read (preview)", () => {
  it("passes the byte budget through and returns copied, ArrayBuffer-backed bytes", async () => {
    const source = new Uint8Array([1, 2, 3]);
    const api = new FakeChannelApi({
      "files:read": { data: source, truncated: true, totalBytes: 99 },
    });
    const bytes = await adaptBridge(api).read("/notes/a.md", 256);
    expect(api.calls[0]).toEqual({
      channel: "files:read",
      args: { path: "/notes/a.md", maxBytes: 256 },
    });
    expect(bytes).not.toBeNull();
    expect([...(bytes?.data ?? [])]).toEqual([1, 2, 3]);
    expect(bytes?.truncated).toBe(true);
    expect(bytes?.totalBytes).toBe(99);
    // A copy: mutating what main sent must not change what the UI holds.
    source[0] = 42;
    expect(bytes?.data[0]).toBe(1);
    expect(bytes?.data.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("reads null as 'the file is gone', not as an empty file", async () => {
    const api = new FakeChannelApi({ "files:read": null });
    expect(await adaptBridge(api).read("/gone.png", 16)).toBeNull();
  });
});

describe("writes", () => {
  it("sends the bytes with the correlation id and returns the stored entry", async () => {
    const api = new FakeChannelApi({ "files:upload": { file: entry("/n/a.txt", 3), uploadedChunks: 1 } });
    const data = new Uint8Array([1, 2, 3]);
    const result = await adaptBridge(api).upload({
      uploadId: "up_1",
      path: "/n/a.txt",
      contentType: "text/plain",
      data,
    });
    expect(api.calls[0]).toEqual({
      channel: "files:upload",
      args: { path: "/n/a.txt", contentType: "text/plain", data, uploadId: "up_1" },
    });
    expect(result).toEqual({ ok: true, entry: entry("/n/a.txt", 3) });
  });

  it("keeps the quota refusal distinguishable from a generic failure", async () => {
    const api = new FakeChannelApi();
    api.fail(
      "files:upload",
      "Error invoking remote method 'files:upload': Error: This would put you over your 100 GB Files quota.",
    );
    const result = await adaptBridge(api).upload({
      uploadId: "up_2",
      path: "/big.bin",
      contentType: null,
      data: new Uint8Array(1),
    });
    expect(result).toEqual({
      ok: false,
      reason: "quota",
      message: "This would put you over your 100 GB Files quota.",
    });
  });

  it("calls a bad destination rejected rather than an error", async () => {
    const api = new FakeChannelApi();
    api.fail("files:upload", 'invalid destination "../etc/passwd"');
    const result = await adaptBridge(api).upload({
      uploadId: "up_3",
      path: "../etc/passwd",
      contentType: null,
      data: new Uint8Array(1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("rejected");
  });

  it("turns a hydration into where it landed, and a missing file into 'missing'", async () => {
    const ok = new FakeChannelApi({ "files:download": { savePath: "/Users/z/Downloads/a.txt" } });
    expect(await adaptBridge(ok).download("/a.txt")).toEqual({
      ok: true,
      savePath: "/Users/z/Downloads/a.txt",
    });

    const gone = new FakeChannelApi();
    gone.fail("files:download", "/a.txt is not in your cloud files");
    const result = await adaptBridge(gone).download("/a.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  it("reports a delete as ok or with the reason it failed", async () => {
    const ok = new FakeChannelApi({ "files:delete": undefined });
    expect(await adaptBridge(ok).remove("/a.txt")).toEqual({ ok: true });

    const bad = new FakeChannelApi();
    bad.fail("files:delete", "Files is unreachable");
    expect(await adaptBridge(bad).remove("/a.txt")).toEqual({
      ok: false,
      message: "Files is unreachable",
    });
  });

  it("cancels a transfer by id", async () => {
    const api = new FakeChannelApi({ "transfers:cancel": undefined });
    await adaptBridge(api).cancelTransfer("t1");
    expect(api.calls[0]).toEqual({ channel: "transfers:cancel", args: { id: "t1" } });
  });
});

describe("events", () => {
  it("forwards change, transfer, and upload-progress events, and unsubscribes", () => {
    const api = new FakeChannelApi();
    const bridge = adaptBridge(api);

    let changes = 0;
    const offChanged = bridge.onFilesChanged(() => (changes += 1));
    api.emit("files:changed", { path: "/n" });
    expect(changes).toBe(1);
    offChanged();
    api.emit("files:changed", { path: "/n" });
    expect(changes).toBe(1);

    let seen: Transfer[] = [];
    bridge.onTransfersUpdated((next) => (seen = next));
    api.emit("transfers:updated", { transfers: [transfer("t9")], declined: null });
    expect(seen.map((item) => item.id)).toEqual(["t9"]);

    const progress: UploadProgress[] = [];
    bridge.onUploadProgress((next) => progress.push(next));
    api.emit("files:uploadProgress", {
      uploadId: "up_1",
      path: "/n/a.txt",
      sentBytes: 4,
      totalBytes: 8,
      state: "uploading",
      error: null,
    });
    // A payload with no recognizable state is dropped, never guessed at.
    api.emit("files:uploadProgress", { uploadId: "up_1", state: "teleporting" });
    expect(progress).toEqual([
      {
        uploadId: "up_1",
        path: "/n/a.txt",
        sentBytes: 4,
        totalBytes: 8,
        state: "uploading",
        error: null,
      },
    ]);
  });

  it("degrades to no progress, not a crash, on a preload without that channel", () => {
    const api = new FakeChannelApi();
    api.blocked.add("files:uploadProgress");
    const off = adaptBridge(api).onUploadProgress(() => {
      throw new Error("should never fire");
    });
    expect(typeof off).toBe("function");
    off();
  });
});
