/**
 * The application-level audio player (renderer/src/lib/audio.ts).
 *
 * The claim being tested is the one the feature exists for: playback is owned by
 * a MODULE, not by a component, so nothing in the UI can interrupt it — and the
 * expensive part (synthesis) happens once per track no matter how often the
 * dock is redrawn or the track replayed.
 *
 * These run in the plain node environment, so the four browser things the module
 * touches — the audio element, object URLs, localStorage, and the preload
 * bridge — are stubbed globals (the same pattern as theme-default.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsClip } from "../src/shared/tts";

/** The audio elements the module constructed, newest last. */
let elements: FakeAudio[] = [];
let stored: Record<string, string>;
let revoked: string[];
let objectUrlCount: number;
/** Every channel the module invoked, in order. */
let invoked: { channel: string; args: unknown }[];
/** Resolvers for pending tts:speak calls, so a test can hold one open. */
let speakGate: ((clip: TtsClip) => void) | null;
/** When set, the next tts:speak rejects with it. */
let speakFailure: Error | null;
/** What the player asked the chrome to tell the user. */
let notices: { message: string; type: string }[];

class FakeAudio {
  src = "";
  currentTime = 0;
  duration = 12;
  volume = 1;
  playbackRate = 1;
  preload = "";
  paused = true;
  playCount = 0;
  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

  constructor() {
    elements.push(this);
  }

  addEventListener(type: string, fn: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  load(): void {
    /* no-op */
  }

  play(): Promise<void> {
    this.playCount += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  /** Drive an element event the module listens for. */
  emit(type: string, event?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

function clip(overrides: Partial<TtsClip> = {}): TtsClip {
  return {
    data: new Uint8Array([1, 2, 3]),
    mimeType: "audio/wav",
    provider: "system",
    voiceLabel: "macOS · Samantha",
    truncated: false,
    ...overrides,
  };
}

type AudioModule = typeof import("../src/renderer/src/lib/audio");

/** Fresh globals, then a fresh module — the store is created at import time. */
async function loadModule(): Promise<AudioModule> {
  vi.resetModules();
  const mod = await import("../src/renderer/src/lib/audio");
  mod.setAudioNotifier((message, type) => {
    notices.push({ message, type });
  });
  return mod;
}

beforeEach(() => {
  elements = [];
  stored = {};
  revoked = [];
  objectUrlCount = 0;
  invoked = [];
  speakGate = null;
  speakFailure = null;
  notices = [];

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
    removeItem: (key: string) => {
      delete stored[key];
    },
  });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("window", {
    suma: {
      invoke: (channel: string, args: unknown) => {
        invoked.push({ channel, args });
        if (channel !== "tts:speak") return Promise.resolve(undefined);
        if (speakFailure !== null) return Promise.reject(speakFailure);
        if (speakGate !== null) {
          return new Promise<TtsClip>((resolve) => {
            speakGate = resolve;
          });
        }
        return Promise.resolve(clip());
      },
    },
  });
  // Node's URL has no object-URL support; the module only needs these two.
  (URL as unknown as Record<string, unknown>)["createObjectURL"] = () => {
    objectUrlCount += 1;
    return `blob:mock-${String(objectUrlCount)}`;
  };
  (URL as unknown as Record<string, unknown>)["revokeObjectURL"] = (url: string) => {
    revoked.push(url);
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (URL as unknown as Record<string, unknown>)["createObjectURL"];
  delete (URL as unknown as Record<string, unknown>)["revokeObjectURL"];
});

function speakCalls(): unknown[] {
  return invoked.filter((entry) => entry.channel === "tts:speak").map((e) => e.args);
}

describe("reading text aloud", () => {
  it("synthesizes in main, then plays the returned bytes", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().play({
      id: "m1",
      source: { kind: "tts", text: "Hello there, friend." },
    });

    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });
    expect(speakCalls()).toHaveLength(1);
    const el = elements[0];
    expect(el?.src).toBe("blob:mock-1");
    expect(el?.playCount).toBe(1);
    // The title falls back to the text's first line, stripped of markdown.
    expect(useAudioStore.getState().queue[0]?.title).toBe("Hello there, friend.");
    expect(useAudioStore.getState().queue[0]?.voiceLabel).toBe("macOS · Samantha");
  });

  it("passes a one-off provider and voice through for the settings preview", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().play({
      id: "preview",
      source: { kind: "tts", text: "sample", provider: "openai", voice: "sage" },
    });
    await vi.waitFor(() => {
      expect(speakCalls()).toHaveLength(1);
    });
    expect(speakCalls()[0]).toMatchObject({
      text: "sample",
      provider: "openai",
      voice: "sage",
    });
  });

  /* A second synthesis is a second network round trip and, on a paid provider,
     a second charge for audio we already have. */
  it("replays a paused track without synthesizing it again", async () => {
    const { useAudioStore } = await loadModule();
    const store = useAudioStore.getState();
    store.play({ id: "m1", source: { kind: "tts", text: "one" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });

    useAudioStore.getState().toggle();
    expect(useAudioStore.getState().status).toBe("paused");
    useAudioStore.getState().toggle();
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });
    expect(speakCalls()).toHaveLength(1);
    expect(revoked).toEqual([]);
  });

  it("toggles when the same id is asked for again, and replaces on a new one", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().toggleTrack({ id: "m1", source: { kind: "tts", text: "one" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });

    // Same id: a pause, not a second reading.
    useAudioStore.getState().toggleTrack({ id: "m1", source: { kind: "tts", text: "one" } });
    expect(useAudioStore.getState().status).toBe("paused");
    expect(speakCalls()).toHaveLength(1);

    // A different id replaces the queue — and releases the first clip's blob.
    useAudioStore.getState().toggleTrack({ id: "m2", source: { kind: "tts", text: "two" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().queue[0]?.id).toBe("m2");
    });
    expect(revoked).toEqual(["blob:mock-1"]);
    await vi.waitFor(() => {
      expect(speakCalls()).toHaveLength(2);
    });
  });
});

describe("when synthesis fails", () => {
  /* Electron wraps a thrown handler as "Error invoking remote method '…':
     Error: <message>". The part worth showing is the message main wrote — it
     names the thing to fix. */
  it("shows the provider's own words, not Electron's IPC envelope", async () => {
    const { useAudioStore, unwrapIpcError } = await loadModule();
    expect(
      unwrapIpcError(
        new Error(
          "Error invoking remote method 'tts:speak': Error: OpenAI: Incorrect API key provided",
        ),
      ),
    ).toBe("OpenAI: Incorrect API key provided");
    // A message that is not wrapped survives untouched.
    expect(unwrapIpcError(new Error("Speech cancelled."))).toBe("Speech cancelled.");
    expect(unwrapIpcError(new Error(""))).toBe("Speech generation failed.");

    speakFailure = new Error(
      "Error invoking remote method 'tts:speak': Error: Vercel AI Gateway needs an API key — add one under Settings → Voice & audio.",
    );
    useAudioStore.getState().play({ id: "a", source: { kind: "tts", text: "one" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("error");
    });
    expect(useAudioStore.getState().error).toBe(
      "Vercel AI Gateway needs an API key — add one under Settings → Voice & audio.",
    );
    expect(notices).toEqual([
      {
        message:
          "Vercel AI Gateway needs an API key — add one under Settings → Voice & audio.",
        type: "error",
      },
    ]);
    // The track stays loaded, so the dock can show what went wrong.
    expect(useAudioStore.getState().queue).toHaveLength(1);
  });
});

describe("the queue", () => {
  it("advances to the next track when one ends", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().play([
      { id: "a", source: { kind: "tts", text: "first" } },
      { id: "b", source: { kind: "tts", text: "second" } },
    ]);
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });
    expect(useAudioStore.getState().index).toBe(0);

    elements[0]?.emit("ended");
    await vi.waitFor(() => {
      expect(useAudioStore.getState()).toMatchObject({ index: 1, status: "playing" });
    });
    // The second clip is its own synthesis, on the same element.
    expect(speakCalls()).toHaveLength(2);
    expect(elements).toHaveLength(1);
  });

  /* Holding the last track loaded rather than clearing it keeps the dock put,
     so the next press replays instead of the controls vanishing. */
  it("holds the last track at the end of the queue instead of clearing it", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().play({ id: "a", source: { kind: "tts", text: "only" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });

    elements[0]?.emit("ended");
    expect(useAudioStore.getState().status).toBe("paused");
    expect(useAudioStore.getState().ended).toBe(true);
    expect(useAudioStore.getState().index).toBe(0);

    // Toggling an ended track rewinds and plays it again — still one synthesis.
    useAudioStore.getState().toggle();
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });
    expect(elements[0]?.currentTime).toBe(0);
    expect(speakCalls()).toHaveLength(1);
  });

  it("stops, clears the queue, and releases every blob", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().play({ id: "a", source: { kind: "tts", text: "only" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });

    useAudioStore.getState().stop();
    expect(useAudioStore.getState()).toMatchObject({
      queue: [],
      index: -1,
      status: "idle",
    });
    expect(revoked).toEqual(["blob:mock-1"]);
    expect(elements[0]?.src).toBe("");
  });

  it("plays a plain clip without going near the TTS provider", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore
      .getState()
      .play({ id: "chime", title: "Chime", source: { kind: "clip", url: "asset:chime.wav" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });
    expect(speakCalls()).toEqual([]);
    expect(elements[0]?.src).toBe("asset:chime.wav");
    // Not ours to revoke: we never created it.
    useAudioStore.getState().stop();
    expect(revoked).toEqual([]);
  });
});

describe("racing a slow provider", () => {
  /* A synthesis for a track the user already skipped past must not come back
     and seize the element — nor leak the blob it created on the way. */
  it("cancels the pending synthesis and ignores its late result", async () => {
    const { useAudioStore } = await loadModule();
    speakGate = () => undefined; // the next tts:speak hangs
    useAudioStore.getState().play({ id: "slow", source: { kind: "tts", text: "slow one" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("preparing");
    });
    const resolveSlow = speakGate;
    speakGate = null;

    // The user moves on before the provider answers.
    useAudioStore.getState().play({ id: "fast", source: { kind: "tts", text: "fast one" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });
    expect(invoked.some((e) => e.channel === "tts:cancel")).toBe(true);

    // The abandoned clip lands late: it must not touch the element, and its
    // blob must be revoked rather than left behind.
    resolveSlow?.(clip());
    await vi.waitFor(() => {
      expect(revoked.length).toBeGreaterThan(0);
    });
    expect(elements[0]?.src).toBe("blob:mock-1");
    expect(useAudioStore.getState().queue[0]?.id).toBe("fast");
  });
});

describe("playback settings", () => {
  it("applies the speed to the element and remembers it on this Mac", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().play({ id: "a", source: { kind: "tts", text: "one" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });

    useAudioStore.getState().setRate(1.5);
    expect(elements[0]?.playbackRate).toBe(1.5);
    expect(stored["suma.audio.rate"]).toBe("1.5");

    // Out-of-range values are clamped, never sent to the element raw.
    useAudioStore.getState().setRate(9);
    expect(useAudioStore.getState().rate).toBe(2);
  });

  it("starts a new clip at the remembered speed and volume", async () => {
    stored["suma.audio.rate"] = "1.25";
    stored["suma.audio.volume"] = "0.4";
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().play({ id: "a", source: { kind: "tts", text: "one" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });
    expect(elements[0]?.playbackRate).toBe(1.25);
    expect(elements[0]?.volume).toBe(0.4);
  });

  it("mutes without forgetting the volume it will come back to", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().play({ id: "a", source: { kind: "tts", text: "one" } });
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });

    useAudioStore.getState().setVolume(0.6);
    useAudioStore.getState().setMuted(true);
    expect(elements[0]?.volume).toBe(0);
    expect(useAudioStore.getState().volume).toBe(0.6);

    useAudioStore.getState().setMuted(false);
    expect(elements[0]?.volume).toBe(0.6);
  });

  it("clamps a seek to the clip and reuses the one element throughout", async () => {
    const { useAudioStore } = await loadModule();
    useAudioStore.getState().play([
      { id: "a", source: { kind: "tts", text: "one" } },
      { id: "b", source: { kind: "tts", text: "two" } },
    ]);
    await vi.waitFor(() => {
      expect(useAudioStore.getState().status).toBe("playing");
    });

    useAudioStore.getState().seek(500);
    expect(elements[0]?.currentTime).toBe(12);
    useAudioStore.getState().seek(-5);
    expect(elements[0]?.currentTime).toBe(0);

    // One element for the whole session: it is a module singleton, which is
    // what keeps playback alive across every UI change.
    useAudioStore.getState().next();
    await vi.waitFor(() => {
      expect(useAudioStore.getState().index).toBe(1);
    });
    expect(elements).toHaveLength(1);
  });
});
