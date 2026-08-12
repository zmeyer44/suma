/**
 * Text-to-speech core (§8.1 Voice & audio). The load-bearing claims are about
 * CREDENTIALS — a key must never leave main, and an environment-supplied key
 * must outrank a stale stored one — and about the shapes the three providers
 * are actually asked in.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  blandSpeechRequest,
  blandVoicesRequest,
  decodeBase64AudioResponse,
  elevenLabsSpeechRequest,
  envApiKey,
  mergeTtsSettings,
  openaiSpeechRequest,
  parseBlandVoices,
  parseSayVoices,
  parseTtsSettings,
  providerErrorMessage,
  resolveApiKey,
  sayArgs,
  truncateForSpeech,
  ttsSettingsInfo,
  vercelSpeechRequest,
  voiceLabel,
} from "../src/main/audio/tts-core";
import { TtsService } from "../src/main/audio/tts-service";
import {
  BLAND_VOICES,
  DEFAULT_TTS_SETTINGS,
  MAX_TTS_CHARS,
  resolvedModel,
  speechTitle,
  stripForSpeech,
  type TtsSettings,
} from "../src/shared/tts";

function settings(
  patch: {
    provider?: TtsSettings["provider"];
    voices?: Partial<TtsSettings["voices"]>;
    models?: Partial<TtsSettings["models"]>;
    apiKeys?: Partial<TtsSettings["apiKeys"]>;
  } = {},
): TtsSettings {
  return {
    provider: patch.provider ?? "system",
    voices: { ...DEFAULT_TTS_SETTINGS.voices, ...patch.voices },
    models: { ...DEFAULT_TTS_SETTINGS.models, ...patch.models },
    apiKeys: { openai: "", elevenlabs: "", vercel: "", bland: "", ...patch.apiKeys },
  };
}

describe("settings file", () => {
  it("fills every missing field from the defaults", () => {
    expect(parseTtsSettings("{}")).toEqual(DEFAULT_TTS_SETTINGS);
  });

  /* The file is hand-editable — it is where a key goes if the user would
     rather not type it into a text field — so a typo must not cost them their
     provider choice. */
  it("falls back to the defaults for malformed JSON instead of throwing", () => {
    expect(parseTtsSettings("{not json")).toEqual(DEFAULT_TTS_SETTINGS);
  });

  it("keeps a known provider and rejects an unknown one", () => {
    expect(parseTtsSettings('{"provider":"elevenlabs"}').provider).toBe("elevenlabs");
    expect(parseTtsSettings('{"provider":"robot"}').provider).toBe("system");
  });

  it("merges a patch field-by-field, leaving unmentioned voices alone", () => {
    const next = mergeTtsSettings(settings({ voices: { openai: "nova" } }), {
      provider: "openai",
      voices: { elevenlabs: "abc123" },
    });
    expect(next.provider).toBe("openai");
    expect(next.voices.openai).toBe("nova");
    expect(next.voices.elevenlabs).toBe("abc123");
  });

  it("stores a trimmed key, and treats an empty string as 'remove it'", () => {
    const stored = mergeTtsSettings(settings(), {
      apiKeys: { openai: "  sk-test  " },
    });
    expect(stored.apiKeys.openai).toBe("sk-test");
    expect(mergeTtsSettings(stored, { apiKeys: { openai: "" } }).apiKeys.openai).toBe("");
  });

  it("leaves the other provider's key untouched when one is written", () => {
    const all = settings({
      apiKeys: { openai: "sk-a", elevenlabs: "el-b", vercel: "vck-c" },
    });
    expect(mergeTtsSettings(all, { apiKeys: { openai: "sk-new" } }).apiKeys).toEqual({
      openai: "sk-new",
      elevenlabs: "el-b",
      vercel: "vck-c",
      bland: "",
    });
  });
});

describe("credentials", () => {
  it("reads either env var name, preferring the SUMA-prefixed one", () => {
    expect(envApiKey("openai", { OPENAI_API_KEY: "plain" })).toBe("plain");
    expect(
      envApiKey("openai", { SUMA_OPENAI_API_KEY: "suma", OPENAI_API_KEY: "plain" }),
    ).toBe("suma");
    expect(envApiKey("openai", { OPENAI_API_KEY: "   " })).toBeNull();
    expect(envApiKey("elevenlabs", {})).toBeNull();
  });

  /* A deployment that supplies the key through the environment should not be
     silently overridden by a value someone once pasted into the field. */
  it("lets the environment outrank a stored key", () => {
    const stored = settings({ apiKeys: { openai: "stored" } });
    expect(resolveApiKey("openai", stored, {})).toBe("stored");
    expect(resolveApiKey("openai", stored, { OPENAI_API_KEY: "from-env" })).toBe("from-env");
  });

  /* VERCEL_GATEWAY_API_KEY is what this app documents; AI_GATEWAY_API_KEY is
     what Vercel's own docs and the AI SDK use, so a machine already set up for
     the gateway needs no second variable. */
  it("accepts either spelling of the Vercel gateway key, app name first", () => {
    expect(envApiKey("vercel", { VERCEL_GATEWAY_API_KEY: "vck" })).toBe("vck");
    expect(envApiKey("vercel", { AI_GATEWAY_API_KEY: "sdk" })).toBe("sdk");
    expect(envApiKey("vercel", { VERCEL_AI_GATEWAY_API_KEY: "alt" })).toBe("alt");
    expect(
      envApiKey("vercel", { VERCEL_GATEWAY_API_KEY: "vck", AI_GATEWAY_API_KEY: "sdk" }),
    ).toBe("vck");
    expect(envApiKey("vercel", { OPENAI_API_KEY: "wrong-provider" })).toBeNull();
  });

  it("reads the Bland key from either spelling", () => {
    expect(envApiKey("bland", { BLAND_API_KEY: "org_x" })).toBe("org_x");
    expect(
      envApiKey("bland", { SUMA_BLAND_API_KEY: "suma", BLAND_API_KEY: "org_x" }),
    ).toBe("suma");
    expect(envApiKey("bland", {})).toBeNull();
  });

  it("keeps each provider's key to itself", () => {
    const env = { VERCEL_GATEWAY_API_KEY: "vck", OPENAI_API_KEY: "sk" };
    expect(resolveApiKey("vercel", settings(), env)).toBe("vck");
    expect(resolveApiKey("openai", settings(), env)).toBe("sk");
    expect(resolveApiKey("elevenlabs", settings(), env)).toBeNull();
    expect(resolveApiKey("bland", settings(), env)).toBeNull();
  });

  it("reports the ABSENCE or PRESENCE of a key, never the key itself", () => {
    const info = ttsSettingsInfo(
      settings({ apiKeys: { openai: "sk-secret", elevenlabs: "", vercel: "vck-secret" } }),
      { ELEVENLABS_API_KEY: "el-secret" },
      "darwin",
    );
    expect(info.keys).toEqual({
      openai: "stored",
      elevenlabs: "env",
      vercel: "stored",
      bland: "unset",
    });
    for (const secret of ["sk-secret", "el-secret", "vck-secret"]) {
      expect(JSON.stringify(info)).not.toContain(secret);
    }
  });

  it("marks the macOS voice unavailable off macOS", () => {
    expect(ttsSettingsInfo(settings(), {}, "darwin").systemVoiceAvailable).toBe(true);
    expect(ttsSettingsInfo(settings(), {}, "win32").systemVoiceAvailable).toBe(false);
  });
});

describe("the settings file on disk", () => {
  function tmpService(): { service: TtsService; file: string } {
    const dir = path.join(tmpdir(), `suma-tts-${randomUUID()}`);
    return {
      service: new TtsService({ userDataDir: dir, env: {}, platform: "darwin" }),
      file: path.join(dir, "tts.json"),
    };
  }

  it("round-trips a provider choice without ever handing back the key", () => {
    const { service, file } = tmpService();
    const info = service.updateSettings({
      provider: "openai",
      voices: { openai: "sage" },
      apiKeys: { openai: "sk-secret" },
    });
    expect(info.provider).toBe("openai");
    expect(info.voices.openai).toBe("sage");
    expect(info.keys.openai).toBe("stored");
    expect(JSON.stringify(info)).not.toContain("sk-secret");

    // Persisted for the next launch, and readable only by this user.
    expect(readFileSync(file, "utf8")).toContain("sk-secret");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const reopened = new TtsService({
      userDataDir: path.dirname(file),
      env: {},
      platform: "darwin",
    });
    expect(reopened.settings().voices.openai).toBe("sage");

    // The gateway's model is remembered per provider, like its voice.
    const withModel = reopened.updateSettings({
      provider: "vercel",
      models: { vercel: "openai/tts-1-hd" },
    });
    expect(withModel.models.vercel).toBe("openai/tts-1-hd");
    expect(withModel.voices.openai).toBe("sage");
  });

  it("refuses to speak with a provider that has no key, before any network call", async () => {
    const { service } = tmpService();
    service.updateSettings({ provider: "elevenlabs" });
    await expect(
      service.speak({ requestId: "r1", text: "hello" }),
    ).rejects.toThrow(/needs an API key/);

    service.updateSettings({ provider: "vercel" });
    await expect(
      service.speak({ requestId: "r2", text: "hello" }),
    ).rejects.toThrow(/Vercel AI Gateway needs an API key/);

    service.updateSettings({ provider: "bland" });
    await expect(
      service.speak({ requestId: "r3", text: "hello" }),
    ).rejects.toThrow(/Bland needs an API key/);
  });

  it("refuses empty text rather than synthesizing silence", async () => {
    const { service } = tmpService();
    await expect(
      service.speak({ requestId: "r1", text: "   \n  " }),
    ).rejects.toThrow(/nothing to read aloud/);
  });
});

/**
 * Bland's voices are an ACCOUNT's, not a catalog — the built-ins plus whatever
 * that key has cloned — so the list is fetched. Every failure has to land on
 * the shipped built-ins: a picker with three working voices beats an empty one.
 */
describe("Bland's voice list", () => {
  function blandService(fetchImpl: typeof fetch, apiKey = "org_x"): TtsService {
    const service = new TtsService({
      userDataDir: path.join(tmpdir(), `suma-tts-${randomUUID()}`),
      env: {},
      platform: "darwin",
      fetchImpl,
    });
    service.updateSettings({ provider: "bland", apiKeys: { bland: apiKey } });
    return service;
  }

  function reply(body: unknown, ok = true): typeof fetch {
    return (() =>
      Promise.resolve({
        ok,
        status: ok ? 200 : 401,
        text: () => Promise.resolve(JSON.stringify(body)),
      })) as unknown as typeof fetch;
  }

  it("asks the account, with the key in a bearer header", async () => {
    const calls: Array<{ url: string; headers: unknown }> = [];
    const fetchImpl = ((url: string, init: { headers: unknown }) => {
      calls.push({ url, headers: init.headers });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({ voices: [{ id: "clone-1", name: "mine" }] })),
      });
    }) as unknown as typeof fetch;

    const service = blandService(fetchImpl);
    expect(await service.voices("bland")).toEqual([{ id: "clone-1", label: "Mine" }]);
    expect(calls[0]?.url).toBe("https://api.bland.ai/v1/voices");
    expect(calls[0]?.headers).toEqual({ authorization: "Bearer org_x" });

    // Cached for the process: the picker reopening must not re-ask.
    await service.voices("bland");
    expect(calls).toHaveLength(1);
  });

  it("never calls out without a key, and offers the built-ins instead", async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.reject(new Error("should not be called"));
    }) as unknown as typeof fetch;
    const service = blandService(fetchImpl, "");
    expect((await service.voices("bland")).map((v) => v.label)).toEqual([
      "Karen",
      "Matthew",
      "River",
    ]);
    expect(called).toBe(false);
  });

  it("falls back to the built-ins when the key is rejected or the call fails", async () => {
    const rejected = blandService(reply({ error: { message: "bad key" } }, false));
    expect(await rejected.voices("bland")).toEqual([...BLAND_VOICES]);

    const offline = blandService(
      (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    );
    expect(await offline.voices("bland")).toEqual([...BLAND_VOICES]);

    // A 200 carrying nothing usable is a failure too, not an empty picker.
    const empty = blandService(reply({ voices: [] }));
    expect(await empty.voices("bland")).toEqual([...BLAND_VOICES]);
  });

  /* A different key is a different account, and therefore different clones. */
  it("drops the cached list when the key changes", async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ voices: [{ id: `clone-${String(calls)}`, name: "mine" }] }),
          ),
      });
    }) as unknown as typeof fetch;

    const service = blandService(fetchImpl);
    expect((await service.voices("bland"))[0]?.id).toBe("clone-1");
    service.updateSettings({ apiKeys: { bland: "org_other" } });
    expect((await service.voices("bland"))[0]?.id).toBe("clone-2");
  });
});

describe("say(1)", () => {
  /* Voice names contain spaces and parentheses, so the columns split on the RUN
     of spaces before the locale — not on whitespace. */
  it("parses names with spaces and suffixes out of `say -v ?`", () => {
    const voices = parseSayVoices(
      [
        "Albert              en_US    # Hello! My name is Albert.",
        "Bad News            en_US    # Hello! My name is Bad News.",
        "Ava (Premium)       en_US    # Hello! My name is Ava.",
        "Amélie              fr_CA    # Bonjour!",
        "",
        "not a voice line",
      ].join("\n"),
    );
    expect(voices.map((v) => v.id)).toEqual([
      "Albert",
      "Bad News",
      "Ava (Premium)",
      "Amélie",
    ]);
    expect(voices[1]?.hint).toBe("en-US");
  });

  it("drops duplicates so a voice cannot appear twice in the picker", () => {
    const voices = parseSayVoices("Alice  it_IT  # Ciao\nAlice  it_IT  # Ciao");
    expect(voices).toHaveLength(1);
  });

  /* Text goes through a FILE, never argv: text starting with a dash would be
     parsed as a flag, and a long answer can exceed the argv limit outright. */
  it("renders to a WAV Chromium can decode, reading the text from a file", () => {
    const args = sayArgs({ voice: "Samantha", textFile: "/tmp/in.txt", outFile: "/tmp/o.wav" });
    expect(args).toEqual([
      "-v",
      "Samantha",
      "-f",
      "/tmp/in.txt",
      "--file-format=WAVE",
      "--data-format=LEI16@22050",
      "-o",
      "/tmp/o.wav",
    ]);
    expect(args).not.toContain("hello");
  });

  it("omits -v entirely for the system default voice", () => {
    expect(sayArgs({ voice: "  ", textFile: "/tmp/i", outFile: "/tmp/o" })).not.toContain("-v");
  });
});

describe("remote providers", () => {
  it("asks OpenAI for mp3 with the key in the Authorization header", () => {
    const req = openaiSpeechRequest({ text: "hi", voice: "nova", apiKey: "sk-x" });
    expect(req.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(req.headers["authorization"]).toBe("Bearer sk-x");
    expect(JSON.parse(req.body)).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "nova",
      input: "hi",
      response_format: "mp3",
    });
  });

  /* The gateway's speech endpoint is its own shape, not an OpenAI-compatible
     one: the model rides in a header, the text field is `text`, and the audio
     comes back base64 inside JSON.
     https://vercel.com/docs/ai-gateway/modalities/text-to-speech */
  it("sends the Vercel gateway the model in a header and the text as `text`", () => {
    const req = vercelSpeechRequest({
      text: "hi",
      voice: "nova",
      model: "openai/tts-1-hd",
      apiKey: "vck_x",
    });
    expect(req.url).toBe("https://ai-gateway.vercel.sh/v4/ai/speech-model");
    expect(req.headers["authorization"]).toBe("Bearer vck_x");
    expect(req.headers["ai-model-id"]).toBe("openai/tts-1-hd");
    // Without these the live gateway refuses with "Unsupported gateway
    // protocol version" regardless of the key — Vercel's cURL example omits
    // them, so they are asserted here rather than trusted to stay by accident.
    expect(req.headers["ai-gateway-protocol-version"]).toBe("0.0.1");
    expect(req.headers["ai-gateway-auth-method"]).toBe("api-key");
    expect(req.headers["ai-speech-model-specification-version"]).toBe("4");
    expect(JSON.parse(req.body)).toEqual({
      text: "hi",
      voice: "nova",
      outputFormat: "mp3",
    });
    expect(req.responseKind).toBe("base64-json");
  });

  it("reads the direct providers as bytes and the gateway as base64 JSON", () => {
    expect(openaiSpeechRequest({ text: "a", voice: "nova", apiKey: "k" }).responseKind).toBe(
      "audio-bytes",
    );
    expect(
      elevenLabsSpeechRequest({ text: "a", voice: "v", apiKey: "k" }).responseKind,
    ).toBe("audio-bytes");
  });

  it("decodes the gateway's base64 audio", () => {
    const audio = Buffer.from([1, 2, 3, 250]).toString("base64");
    expect(decodeBase64AudioResponse(JSON.stringify({ audio, warnings: [] }))).toEqual(
      new Uint8Array([1, 2, 3, 250]),
    );
  });

  /* A 200 with no `audio` field is a real failure mode — a model that took the
     request and produced nothing — and must not read as an empty clip. */
  it("refuses a gateway reply that carries no audio", () => {
    expect(() => decodeBase64AudioResponse('{"warnings":["no voice"]}')).toThrow(
      /no audio/,
    );
    expect(() => decodeBase64AudioResponse('{"audio":""}')).toThrow(/no audio/);
    expect(() => decodeBase64AudioResponse("not json")).toThrow(/malformed/);
  });

  it("resolves the gateway model from the settings, falling back to the first", () => {
    expect(resolvedModel("vercel", { vercel: "openai/tts-1-hd" })).toBe("openai/tts-1-hd");
    expect(resolvedModel("vercel", { vercel: "  " })).toBe("openai/tts-1");
    expect(resolvedModel("vercel", {})).toBe("openai/tts-1");
    // A provider with a fixed model ignores the record entirely.
    expect(resolvedModel("openai", { openai: "ignored" })).toBe("gpt-4o-mini-tts");
    expect(resolvedModel("system", {})).toBeNull();
  });

  it("puts the ElevenLabs voice in the path, escaped, and the key in xi-api-key", () => {
    const req = elevenLabsSpeechRequest({ text: "hi", voice: "a/b c", apiKey: "el-x" });
    expect(req.url).toContain("/v1/text-to-speech/a%2Fb%20c?");
    expect(req.url).toContain("output_format=mp3_44100_128");
    expect(req.headers["xi-api-key"]).toBe("el-x");
    expect(JSON.parse(req.body)).toEqual({
      text: "hi",
      model_id: "eleven_multilingual_v2",
    });
  });

  /* Bland's OpenAI-compatible endpoint, not their native /v2/tts: it answers
     with mp3 where /v2/tts emits PCM or WAV, so the clip needs no new decode
     path in the player. https://docs.bland.ai/api-v2/post/audio-speech */
  it("asks Bland for mp3 on the OpenAI-compatible endpoint", () => {
    const req = blandSpeechRequest({
      text: "hi",
      voice: "29158307-9893-4149-8a75-bc9ce313d64e",
      model: "btts-3",
      apiKey: "org_x",
    });
    expect(req.url).toBe("https://api.bland.ai/v2/audio/speech");
    expect(req.headers["authorization"]).toBe("Bearer org_x");
    expect(JSON.parse(req.body)).toEqual({
      model: "btts-3",
      input: "hi",
      voice: "29158307-9893-4149-8a75-bc9ce313d64e",
      response_format: "mp3",
    });
    expect(req.responseKind).toBe("audio-bytes");
  });

  it("defaults Bland to the current generation, and remembers a switch", () => {
    expect(resolvedModel("bland", {})).toBe("btts-3");
    expect(resolvedModel("bland", { bland: "btts-2" })).toBe("btts-2");
    expect(resolvedModel("bland", { bland: " " })).toBe("btts-3");
  });

  it("sends the Bland key as a bearer token when listing voices", () => {
    expect(blandVoicesRequest("org_x")).toEqual({
      url: "https://api.bland.ai/v1/voices",
      headers: { authorization: "Bearer org_x" },
    });
  });

  /* It is `id` — NOT the `voice_id` beside it — that synthesis takes: "Pass any
     `id` from that response as `voice`". Getting this backwards would send a
     UUID the speech endpoint rejects. https://docs.bland.ai/tts/quickstart */
  it("takes the voice `id`, not the `voice_id`, out of the voices reply", () => {
    const voices = parseBlandVoices(
      JSON.stringify({
        voices: [
          {
            id: "d4610ec1-933d-44c9-a05f-53df2437808d",
            voice_id: "5134ee24-7d14-49a4-8aff-2215d295b6cc",
            name: "maya",
            description: "Young American Female",
            tags: ["english", "soft"],
          },
        ],
      }),
    );
    expect(voices).toEqual([
      {
        id: "d4610ec1-933d-44c9-a05f-53df2437808d",
        label: "Maya",
        hint: "Young American Female",
      },
    ]);
  });

  /* The descriptions below are Karen's and River's verbatim from the live
     account. Karen's first clause carries her character; River's ("A light") is
     too short to say anything, so width wins over grammar there — a hint of "A
     light…" beside a name is worse than none. A voice with no description at
     all (Matthew, live) falls back to a tag. */
  it("shortens a sentence-long description into a hint, and falls back to a tag", () => {
    const voices = parseBlandVoices(
      JSON.stringify({
        voices: [
          {
            id: "a",
            name: "Karen",
            description:
              "A mature female with a General American accent, nasal and deadpan, with a moderate pace, for customer support and IVR prompts.",
          },
          {
            id: "b",
            name: "River",
            description:
              "A light, playful voice with a moderate pace, for podcasts and advertisements.",
          },
          { id: "c", name: "Maya", description: "Young American Female" },
          { id: "d", name: "Matthew", tags: ["Beige Clone V3", "cloned"] },
        ],
      }),
    );
    const hint = (id: string): string | undefined =>
      voices.find((v) => v.id === id)?.hint;
    expect(hint("a")).toBe("A mature female with a General American…");
    expect(hint("b")).toBe("A light, playful voice with a moderate…");
    expect(hint("c")).toBe("Young American Female");
    expect(hint("d")).toBe("Beige Clone V3");
    for (const voice of voices) {
      expect(voice.hint?.length).toBeLessThanOrEqual(41);
    }
  });

  /* A row that cannot be spoken is worse than a shorter list. */
  it("skips voices with no id, and never lists one twice", () => {
    const voices = parseBlandVoices(
      JSON.stringify({
        voices: [{ name: "no id" }, { id: "a", name: "One" }, { id: "a", name: "Again" }],
      }),
    );
    expect(voices.map((v) => v.id)).toEqual(["a"]);
    expect(voices[0]?.label).toBe("One");
  });

  /* A real account answers with the whole shared library — ~1000 voices — so
     the three every account can speak with go first, and the rest sort so the
     picker's typeahead lands somewhere predictable. */
  it("pins Bland's built-ins above the library, and alphabetizes the rest", () => {
    const voices = parseBlandVoices(
      JSON.stringify({
        voices: [
          { id: "zz", name: "zeta" },
          { id: "2f29fdbb-c55e-4add-9c7c-93437ebf379d", name: "River" },
          { id: "aa", name: "alpha" },
          { id: "29158307-9893-4149-8a75-bc9ce313d64e", name: "Karen" },
        ],
      }),
    );
    expect(voices.map((v) => v.label)).toEqual(["Karen", "River", "Alpha", "Zeta"]);
  });

  it("reads a malformed or voiceless reply as no voices rather than throwing", () => {
    expect(parseBlandVoices("not json")).toEqual([]);
    expect(parseBlandVoices("{}")).toEqual([]);
    expect(parseBlandVoices('{"voices":"soon"}')).toEqual([]);
  });

  /* "Incorrect API key provided" tells the user exactly what to fix, where
     "OpenAI returned 401" does not — so the provider's own words win. */
  it("relays the provider's message out of either error shape", () => {
    expect(
      providerErrorMessage("openai", 401, '{"error":{"message":"Incorrect API key provided"}}'),
    ).toBe("OpenAI: Incorrect API key provided");
    expect(
      providerErrorMessage("elevenlabs", 422, '{"detail":{"message":"voice_not_found"}}'),
    ).toBe("ElevenLabs: voice_not_found");
    expect(providerErrorMessage("elevenlabs", 401, '{"detail":"Unauthorized"}')).toBe(
      "ElevenLabs: Unauthorized",
    );
    expect(
      providerErrorMessage(
        "bland",
        400,
        '{"error":{"code":"invalid_voice","message":"Voice not found"}}',
      ),
    ).toBe("Bland: Voice not found");
    // The body a rejected Bland key really comes back with.
    expect(
      providerErrorMessage(
        "bland",
        401,
        '{"data":null,"errors":[{"error":"AUTH_FAILURE","message":"Unauthorized"}]}',
      ),
    ).toBe("Bland: Unauthorized");
  });

  it("falls back to an actionable line when the body says nothing", () => {
    expect(providerErrorMessage("openai", 401, "<html>")).toMatch(/rejected the API key/);
    expect(providerErrorMessage("openai", 429, "")).toMatch(/rate-limiting/);
    expect(providerErrorMessage("openai", 500, "")).toMatch(/HTTP 500/);
  });
});

describe("the text", () => {
  it("flattens markdown into something worth hearing", () => {
    expect(stripForSpeech("**bold** and `code`")).toBe("bold and code");
    expect(stripForSpeech("```js\nconst x = 1;\n```")).toBe("Code block omitted.");
    expect(stripForSpeech("see [the docs](https://example.com)")).toBe("see the docs");
    expect(stripForSpeech("## Heading\n- one\n- two")).toBe("Heading\none\ntwo");
    expect(stripForSpeech("go to https://example.com/x now")).toBe("go to link now");
  });

  it("titles a track from its first non-empty line, elided", () => {
    expect(speechTitle("## Hello there\nmore")).toBe("Hello there");
    expect(speechTitle("\n\nsecond line wins")).toBe("second line wins");
    expect(speechTitle("x".repeat(100)).endsWith("…")).toBe(true);
  });

  it("leaves text within the cap exactly as it was", () => {
    expect(truncateForSpeech("short")).toEqual({ text: "short", truncated: false });
  });

  /* A truncated clip should end on a full thought instead of mid-word. */
  it("cuts an over-long body at the last sentence that fits", () => {
    const long = `${"a".repeat(MAX_TTS_CHARS - 10)}. ${"b".repeat(200)}`;
    const cut = truncateForSpeech(long);
    expect(cut.truncated).toBe(true);
    expect(cut.text.endsWith(".")).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(MAX_TTS_CHARS);
  });

  it("falls back to a word boundary when there is no sentence to cut at", () => {
    const cut = truncateForSpeech(`${"word ".repeat(20)}tail`, 40);
    expect(cut.truncated).toBe(true);
    expect(cut.text.endsWith("word")).toBe(true);
  });
});

describe("voice labels", () => {
  it("names the provider and the voice for the dock", () => {
    expect(voiceLabel("openai", "nova")).toBe("OpenAI · Nova");
    expect(voiceLabel("elevenlabs", "21m00Tcm4TlvDq8ikWAM")).toBe("ElevenLabs · Rachel");
    expect(voiceLabel("system", "Samantha", [{ id: "Samantha", label: "Samantha" }])).toBe(
      "macOS · Samantha",
    );
    // The gateway's speech models ARE OpenAI's, so they take OpenAI's voices.
    expect(voiceLabel("vercel", "shimmer")).toBe("Vercel · Shimmer");
  });

  /* Bland's built-ins label without a network call; a clone needs the fetched
     list, which is consulted first and falls back to them. */
  it("names a Bland clone from the fetched list and a built-in without one", () => {
    expect(voiceLabel("bland", "29158307-9893-4149-8a75-bc9ce313d64e")).toBe(
      "Bland · Karen",
    );
    expect(voiceLabel("bland", "clone-1", [{ id: "clone-1", label: "My Voice" }])).toBe(
      "Bland · My Voice",
    );
    expect(
      voiceLabel("bland", "29158307-9893-4149-8a75-bc9ce313d64e", [
        { id: "clone-1", label: "My Voice" },
      ]),
    ).toBe("Bland · Karen");
  });

  /* Each provider's fetched list is for ITS provider only — passing the `say`
     voices while speaking OpenAI must not cost Nova her name. */
  it("does not look a voice up in another provider's fetched list", () => {
    expect(voiceLabel("openai", "nova", [{ id: "Samantha", label: "Samantha" }])).toBe(
      "OpenAI · Nova",
    );
  });

  /* An uninstalled voice named in a hand-edited settings file still labels as
     itself rather than disappearing. */
  it("labels an unknown voice as itself, and an empty one as the default", () => {
    expect(voiceLabel("system", "Gone")).toBe("macOS · Gone");
    expect(voiceLabel("system", "")).toBe("macOS · Default voice");
  });
});
