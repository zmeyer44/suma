/**
 * Pure text-to-speech logic: settings parsing, credential resolution, `say`
 * argv, voice-list parsing, and the remote providers' request shapes.
 *
 * No processes, no network, no Electron — tts-service.ts owns all of that, and
 * the unit tests exercise this file directly (the same split as
 * credentials-core.ts / credentials.ts).
 */

import {
  BLAND_VOICES,
  DEFAULT_TTS_SETTINGS,
  ELEVENLABS_SPEECH_MODEL,
  isTtsProviderId,
  MAX_TTS_CHARS,
  OPENAI_SPEECH_MODEL,
  staticVoices,
  ttsProviderInfo,
  TTS_KEY_PROVIDERS,
  TTS_PROVIDER_IDS,
  VERCEL_SPEECH_URL,
  type TtsKeyProvider,
  type TtsProviderId,
  type TtsSettings,
  type TtsSettingsInfo,
  type TtsSettingsPatch,
  type TtsVoice,
} from "../../shared/tts";

export const TTS_SETTINGS_FILENAME = "tts.json";

/* --------------------------- settings on disk --------------------------- */

function stringRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A malformed or partial file resolves to the defaults for the fields it does
 * not carry rather than failing: this file is hand-editable (it is where an API
 * key goes if the user would rather not type it into a text field), so a typo
 * in it must not cost them their provider choice.
 */
export function parseTtsSettings(raw: string): TtsSettings {
  let parsed: Record<string, unknown>;
  try {
    parsed = stringRecord(JSON.parse(raw));
  } catch {
    return structuredCloneSettings(DEFAULT_TTS_SETTINGS);
  }
  const voicesIn = stringRecord(parsed["voices"]);
  const modelsIn = stringRecord(parsed["models"]);
  const keysIn = stringRecord(parsed["apiKeys"]);
  const voices = { ...DEFAULT_TTS_SETTINGS.voices };
  const models = { ...DEFAULT_TTS_SETTINGS.models };
  for (const id of TTS_PROVIDER_IDS) {
    const voice = voicesIn[id];
    if (typeof voice === "string") voices[id] = voice;
    const model = modelsIn[id];
    if (typeof model === "string") models[id] = model;
  }
  const apiKeys = { ...DEFAULT_TTS_SETTINGS.apiKeys };
  for (const id of TTS_KEY_PROVIDERS) {
    const key = keysIn[id];
    apiKeys[id] = typeof key === "string" ? key : "";
  }
  return {
    provider: isTtsProviderId(parsed["provider"])
      ? parsed["provider"]
      : DEFAULT_TTS_SETTINGS.provider,
    voices,
    models,
    apiKeys,
  };
}

function structuredCloneSettings(settings: TtsSettings): TtsSettings {
  return {
    provider: settings.provider,
    voices: { ...settings.voices },
    models: { ...settings.models },
    apiKeys: { ...settings.apiKeys },
  };
}

/** Apply a renderer patch. Unmentioned fields survive; `""` clears a key. */
export function mergeTtsSettings(
  prev: TtsSettings,
  patch: TtsSettingsPatch,
): TtsSettings {
  const next = structuredCloneSettings(prev);
  if (patch.provider !== undefined && isTtsProviderId(patch.provider)) {
    next.provider = patch.provider;
  }
  for (const id of TTS_PROVIDER_IDS) {
    const voice = patch.voices?.[id];
    if (typeof voice === "string") next.voices[id] = voice;
    const model = patch.models?.[id];
    if (typeof model === "string") next.models[id] = model.trim();
  }
  for (const id of TTS_KEY_PROVIDERS) {
    const key = patch.apiKeys?.[id];
    if (typeof key === "string") next.apiKeys[id] = key.trim();
  }
  return next;
}

/* ---------------------------- credentials ------------------------------- */

/**
 * Environment wins over the stored key, in this order. A deployment that
 * supplies the key through the environment should not be silently overridden
 * by a value someone once pasted into the settings field — and the page says
 * which one is in force ("Supplied by the environment").
 */
export const TTS_KEY_ENV_VARS: Record<TtsKeyProvider, readonly string[]> = {
  openai: ["SUMA_OPENAI_API_KEY", "OPENAI_API_KEY"],
  elevenlabs: ["SUMA_ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY"],
  bland: ["SUMA_BLAND_API_KEY", "BLAND_API_KEY"],
  // VERCEL_GATEWAY_API_KEY first because that is what this app asks for;
  // AI_GATEWAY_API_KEY is the name Vercel's own docs and the AI SDK use, so a
  // machine already set up for the gateway needs no second variable.
  vercel: [
    "SUMA_VERCEL_GATEWAY_API_KEY",
    "VERCEL_GATEWAY_API_KEY",
    "AI_GATEWAY_API_KEY",
    "VERCEL_AI_GATEWAY_API_KEY",
  ],
};

export type TtsEnv = Record<string, string | undefined>;

export function envApiKey(
  provider: TtsKeyProvider,
  env: TtsEnv,
): string | null {
  for (const name of TTS_KEY_ENV_VARS[provider]) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

export function resolveApiKey(
  provider: TtsKeyProvider,
  settings: TtsSettings,
  env: TtsEnv,
): string | null {
  const fromEnv = envApiKey(provider, env);
  if (fromEnv !== null) return fromEnv;
  const stored = settings.apiKeys[provider].trim();
  return stored === "" ? null : stored;
}

/** The renderer-safe projection: whether a key exists, never what it is. */
export function ttsSettingsInfo(
  settings: TtsSettings,
  env: TtsEnv,
  platform: string,
): TtsSettingsInfo {
  const keys = {} as TtsSettingsInfo["keys"];
  for (const provider of TTS_KEY_PROVIDERS) {
    keys[provider] =
      envApiKey(provider, env) !== null
        ? "env"
        : settings.apiKeys[provider].trim() === ""
          ? "unset"
          : "stored";
  }
  return {
    provider: settings.provider,
    voices: { ...settings.voices },
    models: { ...settings.models },
    keys,
    systemVoiceAvailable: platform === "darwin",
  };
}

/* ------------------------------- the text ------------------------------- */

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

/**
 * Cut over-long text at the last sentence boundary that fits, so a truncated
 * clip ends on a full thought instead of mid-word. Falls back to a word
 * boundary, then to a hard cut for text with neither.
 */
export function truncateForSpeech(
  text: string,
  max = MAX_TTS_CHARS,
): TruncatedText {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const sentence = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
    head.lastIndexOf("\n"),
  );
  if (sentence > max * 0.5) {
    return { text: head.slice(0, sentence + 1).trim(), truncated: true };
  }
  const space = head.lastIndexOf(" ");
  const cut = space > max * 0.5 ? head.slice(0, space) : head;
  return { text: cut.trim(), truncated: true };
}

/* ---------------------------- macOS `say` ------------------------------- */

/**
 * `say -v ?` prints `Name  locale  # example sentence`, where the name itself
 * may contain spaces ("Bad News") and parentheses ("Ava (Premium)") — so the
 * columns are split on the RUN of spaces before the locale, not on whitespace.
 * A line that does not match that shape is skipped rather than guessed at.
 */
export function parseSayVoices(stdout: string): TtsVoice[] {
  const voices: TtsVoice[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^(\S.*?)\s{2,}([A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*)\s*(?:#.*)?$/.exec(
      line.trimEnd(),
    );
    if (match === null) continue;
    const id = match[1]!.trim();
    const locale = match[2]!;
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    voices.push({ id, label: id, hint: locale.replace("_", "-") });
  }
  return voices;
}

/**
 * `say` reads the text from a FILE, never from argv: text that begins with a
 * dash would otherwise be parsed as a flag, and a long answer can exceed the
 * argv limit outright. WAVE/16-bit PCM because that is what Chromium's audio
 * decoder is guaranteed to take — `say`'s default AIFF is not.
 */
export function sayArgs(opts: {
  voice: string;
  textFile: string;
  outFile: string;
}): string[] {
  const args: string[] = [];
  if (opts.voice.trim() !== "") args.push("-v", opts.voice.trim());
  args.push(
    "-f",
    opts.textFile,
    "--file-format=WAVE",
    "--data-format=LEI16@22050",
    "-o",
    opts.outFile,
  );
  return args;
}

export const SAY_LIST_ARGS: readonly string[] = ["-v", "?"];
export const SYSTEM_AUDIO_MIME = "audio/wav";
export const REMOTE_AUDIO_MIME = "audio/mpeg";

/* --------------------------- remote providers --------------------------- */

export interface SpeechRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /**
   * How to read a 2xx response. Both direct providers stream the file itself;
   * the Vercel gateway answers with JSON carrying base64 audio, so the service
   * has to know which before it touches the body.
   */
  responseKind: "audio-bytes" | "base64-json";
}

export const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

export function openaiSpeechRequest(opts: {
  text: string;
  voice: string;
  apiKey: string;
}): SpeechRequest {
  return {
    url: OPENAI_SPEECH_URL,
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_SPEECH_MODEL,
      voice: opts.voice,
      input: opts.text,
      response_format: "mp3",
    }),
    responseKind: "audio-bytes",
  };
}

/**
 * The gateway negotiates on headers, and it is strict about them: without
 * `ai-gateway-protocol-version` it answers 4xx "Unsupported gateway protocol
 * version" no matter how good the key is (confirmed against the live endpoint).
 * Vercel's cURL example omits these three; `@ai-sdk/gateway` sends them, and
 * they are what the service actually contracts on.
 */
const AI_GATEWAY_PROTOCOL_VERSION = "0.0.1";
const AI_SPEECH_MODEL_SPEC_VERSION = "4";

/**
 * Vercel AI Gateway's speech endpoint. Four things make it its own shape rather
 * than an OpenAI-compatible call: the model travels in an `ai-model-id` HEADER
 * (not the body), the text field is `text` (not `input`), the protocol and
 * model-spec versions are negotiated in headers, and the audio comes back
 * base64-encoded inside JSON — Vercel documents that streaming audio out is not
 * supported.
 */
export function vercelSpeechRequest(opts: {
  text: string;
  voice: string;
  model: string;
  apiKey: string;
}): SpeechRequest {
  return {
    url: VERCEL_SPEECH_URL,
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "ai-gateway-protocol-version": AI_GATEWAY_PROTOCOL_VERSION,
      // An API key, never an OIDC token: Suma is a desktop app, not a Vercel
      // deployment, so there is no ambient identity for the gateway to trust.
      "ai-gateway-auth-method": "api-key",
      "ai-speech-model-specification-version": AI_SPEECH_MODEL_SPEC_VERSION,
      "ai-model-id": opts.model,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: opts.text,
      voice: opts.voice,
      outputFormat: "mp3",
    }),
    responseKind: "base64-json",
  };
}

/**
 * Pull the audio out of the gateway's `{ audio, warnings }` reply. A 200 with
 * no `audio` field is a real failure mode (a model that accepted the request
 * but produced nothing), and it has to read as one rather than as an empty clip.
 */
export function decodeBase64AudioResponse(body: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("The Vercel AI Gateway returned a malformed response.");
  }
  const audio = stringRecord(parsed)["audio"];
  if (typeof audio !== "string" || audio === "") {
    throw new Error("The Vercel AI Gateway returned no audio for that text.");
  }
  return new Uint8Array(Buffer.from(audio, "base64"));
}

export function elevenLabsSpeechRequest(opts: {
  text: string;
  voice: string;
  apiKey: string;
}): SpeechRequest {
  const voice = encodeURIComponent(opts.voice);
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
    method: "POST",
    headers: {
      "xi-api-key": opts.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: ELEVENLABS_SPEECH_MODEL,
    }),
    responseKind: "audio-bytes",
  };
}

export const BLAND_SPEECH_URL = "https://api.bland.ai/v2/audio/speech";
export const BLAND_VOICES_URL = "https://api.bland.ai/v1/voices";

/**
 * Bland's OpenAI-compatible speech endpoint rather than their native `/v2/tts`,
 * for one reason that matters here: it answers with mp3 (their own endpoint
 * emits raw PCM or WAV), which is the same thing every other remote provider in
 * this file returns, so the dock's player needs no new decode path. `voice`
 * takes any id from `/v1/voices` — a built-in, a clone, or a library voice.
 * https://docs.bland.ai/api-v2/post/audio-speech
 */
export function blandSpeechRequest(opts: {
  text: string;
  voice: string;
  model: string;
  apiKey: string;
}): SpeechRequest {
  return {
    url: BLAND_SPEECH_URL,
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      input: opts.text,
      voice: opts.voice,
      response_format: "mp3",
    }),
    responseKind: "audio-bytes",
  };
}

export interface VoicesRequest {
  url: string;
  headers: Record<string, string>;
}

export function blandVoicesRequest(apiKey: string): VoicesRequest {
  return {
    url: BLAND_VOICES_URL,
    headers: { authorization: `Bearer ${apiKey}` },
  };
}

/** A description long enough to be a sentence is not a picker hint. */
const MAX_VOICE_HINT = 40;
/** Below this a clause says nothing on its own — River's is "A light". */
const MIN_VOICE_CLAUSE = 16;

function voiceHint(description: unknown, tags: unknown): string | undefined {
  if (typeof description === "string" && description.trim() !== "") {
    // Most descriptions are already hint-shaped ("Young American Female") and
    // pass through whole. The long ones are sentences, and their first clause
    // usually IS the characterful part ("A mature female with a General
    // American accent, nasal and deadpan, …") — unless it is too short to mean
    // anything, in which case width wins over grammar.
    const text = description.trim().replace(/\s+/g, " ");
    const clause = text.split(/[,.;]/)[0]?.trim() ?? "";
    const head = clause.length >= MIN_VOICE_CLAUSE ? clause : text;
    if (head.length <= MAX_VOICE_HINT) {
      return head.length < text.length ? `${head}…` : head;
    }
    const cut = head.slice(0, MAX_VOICE_HINT).lastIndexOf(" ");
    return `${(cut > 0 ? head.slice(0, cut) : head.slice(0, MAX_VOICE_HINT)).trim()}…`;
  }
  if (Array.isArray(tags)) {
    const tag = tags.find((t) => typeof t === "string" && t.trim() !== "");
    if (typeof tag === "string") return tag.trim();
  }
  return undefined;
}

/**
 * `/v1/voices` answers `{ voices: [{ id, name, description, tags }] }`, and it
 * is `id` — not the `voice_id` beside it — that `voice` takes when synthesizing
 * ("Pass any `id` from that response as `voice`"). An entry without one is
 * skipped rather than guessed at: a picker row that cannot speak is worse than
 * a shorter list. Names come back lowercase ("maya"), so they are cased for
 * display only — the id is what gets sent.
 *
 * ORDER is load-bearing here in a way it is not for the other providers: a real
 * account answers with the whole shared library, which is on the order of a
 * thousand voices. The three built-ins are pinned to the top (one of them is
 * the default, and they are the ones every account can speak with), and the
 * rest go alphabetically so the picker's typeahead lands somewhere predictable.
 */
export function parseBlandVoices(body: string): TtsVoice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = stringRecord(parsed)["voices"];
  if (!Array.isArray(list)) return [];
  const voices: TtsVoice[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const record = stringRecord(entry);
    const id = record["id"];
    if (typeof id !== "string" || id.trim() === "" || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    const label = name === "" ? id : name.charAt(0).toUpperCase() + name.slice(1);
    const hint = voiceHint(record["description"], record["tags"]);
    voices.push(hint === undefined ? { id, label } : { id, label, hint });
  }
  const builtIn = BLAND_VOICES.map((voice) => voice.id);
  return voices.sort((a, b) => {
    const rankA = builtIn.indexOf(a.id);
    const rankB = builtIn.indexOf(b.id);
    if (rankA !== rankB) {
      if (rankA === -1) return 1;
      if (rankB === -1) return -1;
      return rankA - rankB;
    }
    return a.label.localeCompare(b.label);
  });
}

/**
 * Turn a provider's error body into one line worth showing in a toast. The
 * remote providers all answer with JSON, in a handful of different shapes, and
 * all of them are worth relaying verbatim — "Incorrect API key provided" tells
 * the user exactly what to fix, where "OpenAI returned 401" does not.
 */
export function providerErrorMessage(
  provider: TtsProviderId,
  status: number,
  body: string,
): string {
  const label = ttsProviderInfo(provider).label;
  const detail = extractErrorDetail(body);
  if (detail !== null) return `${label}: ${detail}`;
  if (status === 401 || status === 403) {
    return `${label} rejected the API key — check it under Settings → Voice & audio.`;
  }
  if (status === 429) return `${label} is rate-limiting this key. Try again shortly.`;
  return `${label} could not synthesize the text (HTTP ${status}).`;
}

function extractErrorDetail(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    // OpenAI: { error: { message } }. ElevenLabs: { detail: { message } |
    // string }. Bland speaks both { error: { message } } and, confirmed
    // against the live endpoint on a rejected key, { data: null, errors: [{
    // error, message }] } — so the first entry of an `errors` array counts too.
    const errors = record["errors"];
    const candidates: unknown[] = [
      stringRecord(record["error"])["message"],
      stringRecord(record["detail"])["message"],
      Array.isArray(errors) ? stringRecord(errors[0])["message"] : undefined,
      record["detail"],
      record["message"],
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim() !== "") {
        return candidate.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * "OpenAI · Nova", "macOS · Samantha" — what the dock shows under the title.
 * `liveVoices` is the fetched list for the providers that have one (`say -v ?`,
 * a Bland account's voices) when it has been read; it is consulted FIRST and
 * the shipped catalog stands behind it, so a Bland clone labels by name while
 * its built-ins still label without a network call. A voice in neither (an
 * uninstalled voice named in a hand-edited settings file) still labels as
 * itself rather than disappearing.
 */
export function voiceLabel(
  provider: TtsProviderId,
  voiceId: string,
  liveVoices: readonly TtsVoice[] = [],
): string {
  const info = ttsProviderInfo(provider);
  const prefix = info.short;
  const catalog =
    info.liveVoices === true
      ? [...liveVoices, ...staticVoices(provider)]
      : staticVoices(provider);
  const found = catalog.find((v) => v.id === voiceId);
  const name = found?.label ?? (voiceId.trim() === "" ? "Default voice" : voiceId);
  return `${prefix} · ${name}`;
}
