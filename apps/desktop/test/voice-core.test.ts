import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserToolDeps } from "../src/main/chat/chat-tools";
import { VoiceService } from "../src/main/voice/voice-service";
import {
  DEFAULT_VOICE_MODEL,
  DEFAULT_VOICE_SETTINGS,
  DEFAULT_VOICE_STT_MODEL,
  DEFAULT_VOICE_TTS_PROVIDER,
  DEFAULT_VOICE_TTS_VOICE,
  DEFAULT_WAKE_WORD,
  mergeVoiceSettings,
  normalizeWakeWord,
  parseVoiceSettings,
  voiceSettingsInfo,
} from "../src/shared/voice";
import {
  buildKeywordsFile,
  concatFrames,
  encodeKeyword,
  extractSentences,
  frameRms,
  keywordsFileContents,
  NarrationQueue,
  narratorEvent,
  narratorPrompt,
  parseNarratorReply,
  parseTokenVocabulary,
  pcm16ToFloat32,
  pcm16ToWav,
  resamplePcm16,
  UtteranceDetector,
  voiceSystemInstruction,
  wakeWordSpellingVariants,
} from "../src/main/voice/voice-core";

/* ------------------------------ wake phrase ------------------------------- */

describe("normalizeWakeWord", () => {
  it("lowercases, collapses whitespace, and joins words", () => {
    expect(normalizeWakeWord("  Hey   Suma ")).toBe("hey suma");
  });

  it("refuses digits, punctuation, emptiness, and five-word phrases", () => {
    expect(normalizeWakeWord("suma2")).toBeNull();
    expect(normalizeWakeWord("su-ma")).toBeNull();
    expect(normalizeWakeWord("   ")).toBeNull();
    expect(normalizeWakeWord("a b c d e")).toBeNull();
  });
});

/* --------------------------- keyword encoding ----------------------------- */

describe("keyword encoding", () => {
  // Mirrors the real gigaspeech tokens.txt shape: "PIECE id" lines.
  const vocabulary = parseTokenVocabulary(
    ["▁SU 10", "MA 11", "▁HE 12", "Y 13", "S 14", "U 15", "M 16", "A 17", "<blk> 0"].join(
      "\n",
    ),
  );

  it("parses the piece column of tokens.txt", () => {
    expect(vocabulary.has("▁SU")).toBe(true);
    expect(vocabulary.has("10")).toBe(false);
  });

  it("encodes by greedy longest match with the word-start marker", () => {
    // Verified against the real model in the prototype: suma → ▁SU MA.
    expect(encodeKeyword("suma", vocabulary)).toEqual(["▁SU", "MA"]);
  });

  it("encodes multi-word phrases word by word", () => {
    expect(encodeKeyword("hey suma", vocabulary)).toEqual(["▁HE", "Y", "▁SU", "MA"]);
  });

  it("falls back to mid-word pieces when no ▁-piece starts the word", () => {
    // No "▁U…" piece exists; the marker is dropped and "U" carries it.
    expect(encodeKeyword("uma", vocabulary)).toEqual(["U", "MA"]);
  });

  it("returns null when a fragment has no piece at all", () => {
    expect(encodeKeyword("suma", new Set(["▁SU"]))).toBeNull();
    expect(encodeKeyword("", vocabulary)).toBeNull();
  });

  it("writes the sherpa keywords line with boost and label", () => {
    expect(keywordsFileContents(["▁SU", "MA"], "suma")).toBe("▁SU MA :2.0 @suma\n");
  });

  it("generates pronunciation-covering spelling variants", () => {
    const variants = wakeWordSpellingVariants("suma");
    expect(variants).toContain("suma");
    expect(variants).toContain("sooma");
    expect(variants).toContain("souma");
    // One rule at a time, no combinatorial blow-up.
    expect(variants.length).toBeLessThanOrEqual(6);
  });

  it("builds a multi-line keywords file, all lines labeled as the phrase", () => {
    const wide = parseTokenVocabulary(
      ["▁SU", "MA", "▁SO", "O", "U", "▁S", "M", "A"].map((p, i) => `${p} ${String(i)}`).join("\n"),
    );
    const file = buildKeywordsFile("suma", wide);
    expect(file).not.toBeNull();
    const lines = (file as string).trim().split("\n");
    expect(lines[0]).toBe("▁SU MA :2.0 @suma");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.endsWith("@suma")).toBe(true);
  });

  it("skips variants that do not encode, and nulls when none do", () => {
    const narrow = new Set(["▁SU", "MA"]);
    expect(buildKeywordsFile("suma", narrow)).toBe("▁SU MA :2.0 @suma\n");
    expect(buildKeywordsFile("xyzzy", new Set(["▁SU"]))).toBeNull();
  });
});

/* ------------------------------ PCM conversion ---------------------------- */

describe("pcm16ToFloat32", () => {
  it("converts little-endian int16 to [-1, 1] floats", () => {
    const bytes = new Uint8Array(6);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, 0, true);
    view.setInt16(2, 32767, true);
    view.setInt16(4, -32768, true);
    const samples = pcm16ToFloat32(bytes);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBeCloseTo(1, 3);
    expect(samples[2]).toBe(-1);
  });

  it("ignores a trailing odd byte", () => {
    expect(pcm16ToFloat32(new Uint8Array(5)).length).toBe(2);
  });

  it("respects a subarray's byte offset", () => {
    const backing = new Uint8Array(8);
    new DataView(backing.buffer).setInt16(4, 16384, true);
    const samples = pcm16ToFloat32(backing.subarray(4, 6));
    expect(samples.length).toBe(1);
    expect(samples[0]).toBeCloseTo(0.5, 3);
  });
});

describe("pcm16ToWav", () => {
  it("writes a valid mono 16-bit WAV header around the samples", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const wav = pcm16ToWav(pcm, 16_000);
    const view = new DataView(wav.buffer);
    const ascii = (offset: number, length: number): string =>
      String.fromCharCode(...wav.subarray(offset, offset + length));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(4, true)).toBe(36 + 4); // RIFF size
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000); // sample rate
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint32(40, true)).toBe(4); // data size
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });
});

describe("resamplePcm16", () => {
  function pcm(samples: number[]): Uint8Array {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((s, i) => view.setInt16(i * 2, s, true));
    return bytes;
  }
  function samples(bytes: Uint8Array): number[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: bytes.byteLength / 2 }, (_, i) =>
      view.getInt16(i * 2, true),
    );
  }

  it("is the identity at equal rates", () => {
    const input = pcm([0, 100, -100]);
    expect(resamplePcm16(input, 24_000, 24_000)).toBe(input);
  });

  it("doubles the sample count from 24k to 48k, interpolating between", () => {
    const out = samples(resamplePcm16(pcm([0, 1000]), 24_000, 48_000));
    expect(out.length).toBe(4);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(1000);
    // Interior points sit between the endpoints, in order.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
    }
  });

  it("halves from 48k to 24k, keeping the endpoints", () => {
    const out = samples(resamplePcm16(pcm([0, 250, 500, 750]), 48_000, 24_000));
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(750);
  });
});

/* ------------------------------ endpointing -------------------------------- */

/** A frame of constant |amplitude| — RMS is amplitude/32768. */
function frame(amplitude: number, sampleCount = 320): Uint8Array {
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < sampleCount; i++) view.setInt16(i * 2, amplitude, true);
  return bytes;
}

describe("frameRms", () => {
  it("measures normalized energy and survives empty frames", () => {
    expect(frameRms(frame(0))).toBe(0);
    expect(frameRms(frame(3277))).toBeCloseTo(0.1, 2);
    expect(frameRms(new Uint8Array(0))).toBe(0);
  });
});

describe("UtteranceDetector", () => {
  const voiced = (): Uint8Array => frame(3000); // ~0.09 RMS, well over 0.015
  const quiet = (): Uint8Array => frame(100); // ~0.003, well under

  it("starts after sustained voice and finishes after the silence hangover", () => {
    const detector = new UtteranceDetector({ startFrames: 2, endFrames: 3 });
    expect(detector.feed(quiet()).kind).toBe("none");
    expect(detector.feed(voiced()).kind).toBe("none");
    expect(detector.feed(voiced()).kind).toBe("started");
    expect(detector.feed(voiced()).kind).toBe("none");
    expect(detector.feed(quiet()).kind).toBe("none");
    expect(detector.feed(quiet()).kind).toBe("none");
    const finished = detector.feed(quiet());
    expect(finished.kind).toBe("finished");
    if (finished.kind === "finished") {
      // The two trigger frames + 1 voiced + 3 quiet; the pre-roll quiet frame
      // may ride along at the front, never dropped speech.
      expect(finished.frames.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("keeps pre-roll so the first syllable survives the gate", () => {
    const detector = new UtteranceDetector({
      startFrames: 2,
      endFrames: 2,
      preRollFrames: 2,
    });
    detector.feed(quiet());
    detector.feed(voiced());
    expect(detector.feed(voiced()).kind).toBe("started");
    detector.feed(quiet());
    const finished = detector.feed(quiet());
    expect(finished.kind).toBe("finished");
    if (finished.kind === "finished") {
      // Both voiced trigger frames are in the utterance.
      const energies = finished.frames.map(frameRms);
      expect(energies.filter((e) => e > 0.05).length).toBe(2);
    }
  });

  it("a cough shorter than startFrames never starts an utterance", () => {
    const detector = new UtteranceDetector({ startFrames: 3 });
    expect(detector.feed(voiced()).kind).toBe("none");
    expect(detector.feed(voiced()).kind).toBe("none");
    expect(detector.feed(quiet()).kind).toBe("none");
    expect(detector.feed(voiced()).kind).toBe("none");
  });

  it("cuts a runaway utterance at maxFrames", () => {
    const detector = new UtteranceDetector({ startFrames: 1, maxFrames: 6 });
    expect(detector.feed(voiced()).kind).toBe("started");
    let finished = 0;
    for (let i = 0; i < 5; i++) {
      if (detector.feed(voiced()).kind === "finished") finished++;
    }
    expect(finished).toBe(1);
    // …and the detector is armed again afterwards.
    expect(detector.feed(voiced()).kind).toBe("started");
  });

  it("reset abandons a half-captured utterance", () => {
    const detector = new UtteranceDetector({ startFrames: 1, endFrames: 2 });
    expect(detector.feed(voiced()).kind).toBe("started");
    detector.reset();
    expect(detector.feed(quiet()).kind).toBe("none");
    expect(detector.feed(quiet()).kind).toBe("none");
  });
});

/* --------------------------- narration scheduling -------------------------- */

describe("extractSentences", () => {
  it("splits on terminators followed by whitespace, keeping the tail", () => {
    expect(extractSentences("Done. Opening the tab now. And th")).toEqual({
      sentences: ["Done.", "Opening the tab now."],
      rest: "And th",
    });
  });

  it("does not split decimals or a terminator still at the buffer edge", () => {
    expect(extractSentences("It costs 3.50 dollars.")).toEqual({
      sentences: [],
      rest: "It costs 3.50 dollars.",
    });
  });

  it("treats newlines as boundaries and honors trailing quotes", () => {
    expect(extractSentences('He said "done!" then left.\nNext')).toEqual({
      sentences: ['He said "done!"', "then left."],
      rest: "Next",
    });
  });
});

describe("NarrationQueue", () => {
  it("speaks a sentence announcing the current action (one-call lag)", () => {
    const queue = new NarrationQueue();
    queue.pushDelta("Scrolling to find the item. ");
    queue.noteToolCall(); // the scroll itself
    const { segment, dropped } = queue.takeNext();
    expect(segment?.text).toBe("Scrolling to find the item.");
    expect(dropped).toEqual([]);
  });

  it("drops narration two or more tool calls behind", () => {
    const queue = new NarrationQueue();
    queue.pushDelta("Scrolling to find the item. ");
    queue.noteToolCall();
    queue.noteToolCall();
    const { segment, dropped } = queue.takeNext();
    expect(segment).toBeNull();
    expect(dropped).toEqual(["Scrolling to find the item."]);
  });

  it("a newer step's sentence supersedes an older one still queued", () => {
    const queue = new NarrationQueue();
    queue.pushDelta("Adding it to the cart. ");
    queue.noteToolCall();
    queue.pushDelta("Wrong item, trying again. ");
    const { segment, dropped } = queue.takeNext();
    expect(segment?.text).toBe("Wrong item, trying again.");
    expect(dropped).toEqual(["Adding it to the cart."]);
  });

  it("same-step sentences never supersede each other", () => {
    const queue = new NarrationQueue();
    queue.pushDelta("First thought. Second thought. ");
    expect(queue.takeNext().segment?.text).toBe("First thought.");
    expect(queue.takeNext().segment?.text).toBe("Second thought.");
  });

  it("drain keeps only the answer — text after the last tool call", () => {
    const queue = new NarrationQueue();
    queue.pushDelta("Let me try once more. ");
    queue.noteToolCall();
    queue.pushDelta("Done — the TV is in your cart");
    queue.finish(); // flushes the unterminated tail
    const { segments, dropped } = queue.drain();
    expect(segments.map((s) => s.text)).toEqual(["Done — the TV is in your cart"]);
    expect(dropped).toEqual(["Let me try once more."]);
  });

  it("finish flushes nothing when the buffer is blank", () => {
    const queue = new NarrationQueue();
    queue.pushDelta("  ");
    queue.finish();
    expect(queue.drain().segments).toEqual([]);
  });

  it("reports how many sentences are pending", () => {
    const queue = new NarrationQueue();
    expect(queue.pending).toBe(0);
    queue.pushDelta("One. Two. And a tail");
    expect(queue.pending).toBe(2);
  });
});

describe("narrator", () => {
  it("compresses a tool call into one event line, capping huge inputs", () => {
    expect(narratorEvent("list_tabs", {})).toBe("list_tabs");
    expect(narratorEvent("click", { text: "Add to Cart" })).toBe(
      'click {"text":"Add to Cart"}',
    );
    const huge = narratorEvent("type_text", { text: "x".repeat(500) });
    expect(huge.length).toBeLessThan(160);
    expect(huge.endsWith("…")).toBe(true);
  });

  it("prompt carries the request, the spoken line, the events, and the SAY contract", () => {
    const prompt = narratorPrompt({
      userRequest: "add the TV to my cart",
      spoken: "On it.",
      events: ["click {\"text\":\"Add to Cart\"}"],
    });
    expect(prompt).toContain("add the TV to my cart");
    expect(prompt).toContain("Said aloud so far: On it.");
    expect(prompt).toContain('click {"text":"Add to Cart"}');
    expect(prompt).toContain("ONE spoken sentence");
    expect(prompt).toContain("SAY: <the sentence>");
    const silent = narratorPrompt({ userRequest: "x", spoken: "", events: [] });
    expect(silent).toContain("Nothing has been said aloud yet");
  });

  it("parses the SAY line, preferring the last one", () => {
    expect(parseNarratorReply("SAY: Checking your cart now.")).toBe(
      "Checking your cart now.",
    );
    expect(
      parseNarratorReply(
        'The plan says "SAY: something".\nSAY: Draft one.\nSAY: Adding the TV to your cart.',
      ),
    ).toBe("Adding the TV to your cart.");
  });

  it("accepts a bare short single-line reply and strips quotes", () => {
    expect(parseNarratorReply('"Opening Amazon now."')).toBe("Opening Amazon now.");
  });

  it("refuses reasoning leaks: multi-line prose without a SAY line", () => {
    const leaked =
      "The user is working with a browser assistant that's shopping on Amazon.\nI need to say what it's doing in one sentence under twelve words.\nLet me make sure I don't repeat";
    expect(parseNarratorReply(leaked)).toBeNull();
  });

  it("refuses empty, think-tag-only, and overlong replies", () => {
    expect(parseNarratorReply("")).toBeNull();
    expect(parseNarratorReply("<think>hmm what to say</think>")).toBeNull();
    expect(parseNarratorReply(`SAY: ${"very long ".repeat(30)}`)).toBeNull();
  });
});

describe("concatFrames", () => {
  it("concatenates in order", () => {
    const joined = concatFrames([
      new Uint8Array([1, 2]),
      new Uint8Array([]),
      new Uint8Array([3]),
    ]);
    expect([...joined]).toEqual([1, 2, 3]);
  });
});

/* -------------------------------- settings -------------------------------- */

describe("voice settings", () => {
  it("falls back wholesale on garbage", () => {
    expect(parseVoiceSettings("not json")).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(parseVoiceSettings("[1]" )).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it("parses field-by-field and never enables by accident", () => {
    const parsed = parseVoiceSettings(
      JSON.stringify({
        enabled: "yes", // not a boolean ⇒ off
        wakeWord: "Hey Suma!!",
        model: "  ",
        sttModel: "openai/whisper-1",
        ttsProvider: "polly", // unknown ⇒ default
        voice: "custom-clone-id",
      }),
    );
    expect(parsed.enabled).toBe(false);
    // Unnormalizable phrase falls back to the default.
    expect(parsed.wakeWord).toBe(DEFAULT_WAKE_WORD);
    expect(parsed.model).toBe(DEFAULT_VOICE_MODEL);
    expect(parsed.sttModel).toBe("openai/whisper-1");
    expect(parsed.ttsProvider).toBe(DEFAULT_VOICE_TTS_PROVIDER);
    expect(parsed.voice).toBe("custom-clone-id");
  });

  it("migrates a pre-AI-SDK voice.json off its Gemini Live values", () => {
    // A real file from the previous build (Gemini model id, Live voice name).
    const parsed = parseVoiceSettings(
      JSON.stringify({
        enabled: true,
        wakeWordEnabled: true,
        wakeWord: "suma",
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        voice: "Puck",
        apiKey: "",
      }),
    );
    expect(parsed.enabled).toBe(true);
    expect(parsed.model).toBe(DEFAULT_VOICE_MODEL);
    expect(parsed.voice).toBe(DEFAULT_VOICE_TTS_VOICE);
    // A gateway id and a non-Gemini voice pass through untouched.
    const kept = parseVoiceSettings(
      JSON.stringify({ model: "openai/gpt-4o-mini", voice: "clone-abc" }),
    );
    expect(kept.model).toBe("openai/gpt-4o-mini");
    expect(kept.voice).toBe("clone-abc");
  });

  it("merges patches, dropping invalid wake words, providers, and blanks", () => {
    const merged = mergeVoiceSettings(DEFAULT_VOICE_SETTINGS, {
      enabled: true,
      wakeWord: "hey suma",
      model: "",
      sttModel: "  ",
      voice: "  clone-1  ",
    });
    expect(merged.enabled).toBe(true);
    expect(merged.wakeWord).toBe("hey suma");
    expect(merged.model).toBe(DEFAULT_VOICE_MODEL);
    expect(merged.sttModel).toBe(DEFAULT_VOICE_STT_MODEL);
    expect(merged.voice).toBe("clone-1");

    const rejected = mergeVoiceSettings(merged, {
      wakeWord: "123!",
      ttsProvider: "nope" as never,
    });
    expect(rejected.wakeWord).toBe("hey suma");
    expect(rejected.ttsProvider).toBe(DEFAULT_VOICE_TTS_PROVIDER);
  });

  it("reports both credential provenances, never material", () => {
    const info = voiceSettingsInfo(DEFAULT_VOICE_SETTINGS, "stored", "unset");
    expect(info.keyState).toBe("stored");
    expect(info.ttsKeyState).toBe("unset");
    expect(info.voice).toBe(DEFAULT_VOICE_TTS_VOICE);
    expect(JSON.stringify(info)).not.toContain("apiKey");
  });
});

/* ------------------------- credential precedence -------------------------- */

/**
 * The REAL VoiceService (it has no runtime Electron dependency — the browser
 * tools reach Electron only through injected deps and type-only imports).
 *
 * Precedence is the security-relevant part, and it is the CHAT sidebar's
 * chain now: a vended proxy silently overriding a key the user supplied
 * would bill the wrong account, and a "vended" state offered while signed
 * out would promise access that cannot be delivered.
 */
describe("VoiceService credential precedence", () => {
  const browser = {
    spaces: { activeSpaceId: "s1" },
    tabs: { list: () => [] },
  } as unknown as BrowserToolDeps;

  function build(opts: {
    env?: NodeJS.ProcessEnv;
    stored?: string;
    vendedAvailable?: boolean;
  }): VoiceService {
    const dir = mkdtempSync(path.join(tmpdir(), "suma-voice-test-"));
    return new VoiceService({
      userDataDir: dir,
      browser,
      chatToolSettings: () => ({ model: "m", tools: {} }),
      emit: {
        status: () => undefined,
        transcript: () => undefined,
        audioOut: () => undefined,
        interrupted: () => undefined,
      },
      storedApiKey: () => opts.stored ?? null,
      ...(opts.vendedAvailable === true
        ? {
            vendedGatewayAvailable: () => true,
            vendedGatewayCredentials: () =>
              Promise.resolve({ baseUrl: "https://cp.example", token: "t" }),
          }
        : {}),
      ttsApiKey: () => "bland-key",
      ttsKeyState: () => "stored",
      env: opts.env ?? {},
    });
  }

  it("prefers an explicit env key over a stored key and the vended proxy", () => {
    const service = build({
      env: { AI_GATEWAY_API_KEY: "env-key" },
      stored: "stored-key",
      vendedAvailable: true,
    });
    expect(service.settings().keyState).toBe("env");
    service.stop();
  });

  it("accepts VERCEL_AI_GATEWAY_API_KEY as an alias", () => {
    const service = build({ env: { VERCEL_AI_GATEWAY_API_KEY: "env-key" } });
    expect(service.settings().keyState).toBe("env");
    service.stop();
  });

  it("prefers the user's own stored gateway key over the vended proxy", () => {
    const service = build({ stored: "stored-key", vendedAvailable: true });
    expect(service.settings().keyState).toBe("stored");
    service.stop();
  });

  it("falls back to vended when signed in with no key of its own", () => {
    const service = build({ vendedAvailable: true });
    expect(service.settings().keyState).toBe("vended");
    service.stop();
  });

  it("is unset when signed out with no key, and never leaks a key", () => {
    const service = build({});
    expect(service.settings().keyState).toBe("unset");

    const withKey = build({ stored: "super-secret-key" });
    expect(JSON.stringify(withKey.settings())).not.toContain("super-secret-key");
    service.stop();
    withKey.stop();
  });

  it("treats a blank env value as absent rather than as a key", () => {
    const service = build({
      env: { AI_GATEWAY_API_KEY: "   " },
      vendedAvailable: true,
    });
    expect(service.settings().keyState).toBe("vended");
    service.stop();
  });

  it("surfaces the TTS key provenance beside the model's", () => {
    const service = build({ vendedAvailable: true });
    expect(service.settings().ttsKeyState).toBe("stored");
    service.stop();
  });
});

/* ------------------------------ system prompt ----------------------------- */

describe("voiceSystemInstruction", () => {
  it("names the wake word and keeps the guardrails", () => {
    const prompt = voiceSystemInstruction("suma");
    expect(prompt).toContain('"suma"');
    expect(prompt).toContain("Never enter passwords");
    expect(prompt).toContain("untrusted");
    // Everything it writes is spoken; the prompt must say so.
    expect(prompt).toContain("text-to-speech");
  });
});
