import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jsonSchema, tool, type ToolSet } from "ai";
import type { BrowserToolDeps } from "../src/main/chat/chat-tools";
import { VoiceService } from "../src/main/voice/voice-service";
import { VOICE_SETTINGS_FILENAME } from "../src/shared/voice";
import {
  DEFAULT_VOICE_MODEL,
  DEFAULT_VOICE_SETTINGS,
  DEFAULT_WAKE_WORD,
  mergeVoiceSettings,
  normalizeWakeWord,
  parseVoiceSettings,
  voiceSettingsInfo,
} from "../src/shared/voice";
import {
  adaptToolsForVoice,
  buildKeywordsFile,
  encodeKeyword,
  keywordsFileContents,
  parseTokenVocabulary,
  pcm16ToFloat32,
  toFunctionErrorResponse,
  toFunctionResponse,
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

/* ----------------------------- tool adaptation ---------------------------- */

function demoTools(): ToolSet {
  return {
    open_tab: tool({
      description: "Open a tab.",
      inputSchema: jsonSchema<{ url?: string }>({
        type: "object",
        properties: { url: { type: "string" } },
        additionalProperties: false,
      }),
      execute: ({ url }) => Promise.resolve({ tabId: "t1", url: url ?? "" }),
    }),
    read_page: tool({
      description: "Read a page.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: () => Promise.resolve("Weather tomorrow: sunny."),
    }),
    screenshot: tool({
      description: "Capture pixels.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: () => Promise.resolve({ data: "…" }),
    }),
  };
}

describe("adaptToolsForVoice", () => {
  it("carries name, description, and the raw JSON schema", () => {
    const adapted = adaptToolsForVoice(demoTools());
    const openTab = adapted.find((t) => t.name === "open_tab");
    expect(openTab).toBeDefined();
    expect(openTab?.description).toBe("Open a tab.");
    expect(openTab?.parametersJsonSchema).toMatchObject({
      type: "object",
      properties: { url: { type: "string" } },
    });
  });

  it("excludes screenshot — a Live function response cannot carry an image", () => {
    const names = adaptToolsForVoice(demoTools()).map((t) => t.name);
    expect(names).toEqual(["open_tab", "read_page"]);
  });

  it("executes through to the underlying tool", async () => {
    const adapted = adaptToolsForVoice(demoTools());
    const openTab = adapted.find((t) => t.name === "open_tab");
    await expect(openTab?.execute({ url: "https://example.com" })).resolves.toEqual({
      tabId: "t1",
      url: "https://example.com",
    });
  });
});

describe("function responses", () => {
  it("passes objects through and wraps everything else", () => {
    expect(toFunctionResponse({ ok: true })).toEqual({ ok: true });
    expect(toFunctionResponse("text")).toEqual({ result: "text" });
    expect(toFunctionResponse([1, 2])).toEqual({ result: [1, 2] });
    expect(toFunctionResponse(undefined)).toEqual({ result: null });
  });

  it("shapes errors so the model can recover", () => {
    expect(toFunctionErrorResponse(new Error("no active tab"))).toEqual({
      error: "no active tab",
    });
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
        apiKey: "k",
      }),
    );
    expect(parsed.enabled).toBe(false);
    // Unnormalizable phrase falls back to the default.
    expect(parsed.wakeWord).toBe(DEFAULT_WAKE_WORD);
    expect(parsed.model).toBe(DEFAULT_VOICE_MODEL);
    expect(parsed.apiKey).toBe("k");
  });

  it("merges patches, dropping invalid wake words and blank models", () => {
    const merged = mergeVoiceSettings(DEFAULT_VOICE_SETTINGS, {
      enabled: true,
      wakeWord: "hey suma",
      model: "",
      apiKey: "  key  ",
    });
    expect(merged.enabled).toBe(true);
    expect(merged.wakeWord).toBe("hey suma");
    expect(merged.model).toBe(DEFAULT_VOICE_MODEL);
    expect(merged.apiKey).toBe("key");

    const rejected = mergeVoiceSettings(merged, { wakeWord: "123!" });
    expect(rejected.wakeWord).toBe("hey suma");
  });

  it("reports settings without the key, only its provenance", () => {
    const info = voiceSettingsInfo(
      { ...DEFAULT_VOICE_SETTINGS, apiKey: "secret" },
      "stored",
    );
    expect(info.keyState).toBe("stored");
    expect("apiKey" in info).toBe(false);
  });

  it("carries the vended provenance without inventing a key", () => {
    const info = voiceSettingsInfo({ ...DEFAULT_VOICE_SETTINGS }, "vended");
    expect(info.keyState).toBe("vended");
    expect(JSON.stringify(info)).not.toContain("apiKey");
  });
});

/* ------------------------- credential precedence -------------------------- */

/**
 * The REAL VoiceService (it has no runtime Electron dependency — the browser
 * tools reach Electron only through injected deps and type-only imports).
 *
 * Precedence is the security-relevant part: a vended token silently
 * overriding a key the user pasted would bill the wrong account, and a
 * "vended" state offered while signed out would promise access that cannot
 * be delivered.
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
    if (opts.stored !== undefined) {
      writeFileSync(
        path.join(dir, VOICE_SETTINGS_FILENAME),
        JSON.stringify({ apiKey: opts.stored }),
      );
    }
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
      ...(opts.vendedAvailable === true
        ? {
            vendedTokenAvailable: () => true,
            vendedToken: () => Promise.resolve({ token: "auth_tokens/x" }),
          }
        : {}),
      env: opts.env ?? {},
    });
  }

  it("prefers an explicit env key over a stored key and a vended token", () => {
    const service = build({
      env: { GEMINI_API_KEY: "env-key" },
      stored: "stored-key",
      vendedAvailable: true,
    });
    expect(service.settings().keyState).toBe("env");
    service.stop();
  });

  it("accepts GOOGLE_API_KEY as an alias", () => {
    const service = build({ env: { GOOGLE_API_KEY: "env-key" } });
    expect(service.settings().keyState).toBe("env");
    service.stop();
  });

  it("prefers the user's own stored key over a vended token", () => {
    const service = build({ stored: "stored-key", vendedAvailable: true });
    expect(service.settings().keyState).toBe("stored");
    service.stop();
  });

  it("falls back to vended when signed in with no key of its own", () => {
    const service = build({ vendedAvailable: true });
    expect(service.settings().keyState).toBe("vended");
    service.stop();
  });

  it("is unset when signed out with no key, and never leaks the key", () => {
    const service = build({});
    expect(service.settings().keyState).toBe("unset");

    const withKey = build({ stored: "super-secret-key" });
    expect(JSON.stringify(withKey.settings())).not.toContain("super-secret-key");
    service.stop();
    withKey.stop();
  });

  it("treats a blank env value as absent rather than as a key", () => {
    const service = build({ env: { GEMINI_API_KEY: "   " }, vendedAvailable: true });
    expect(service.settings().keyState).toBe("vended");
    service.stop();
  });
});

/* ------------------------------ system prompt ----------------------------- */

describe("voiceSystemInstruction", () => {
  it("names the wake word and keeps the credential guardrail", () => {
    const prompt = voiceSystemInstruction("suma");
    expect(prompt).toContain('"suma"');
    expect(prompt).toContain("Never enter passwords");
    expect(prompt).toContain("untrusted");
  });
});
