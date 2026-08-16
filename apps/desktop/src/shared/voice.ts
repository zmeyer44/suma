/**
 * Voice assistant contract — shared by main (which listens, transcribes,
 * runs the agent, and speaks) and the renderer (which captures the
 * microphone, plays replies, and renders the HUD + settings page).
 *
 * WHERE THE PIECES LIVE, and why (the TTS/chat split, §8.1):
 *
 *  - The WAKE-WORD engine and the AGENT SESSION run in MAIN. The wake word
 *    is an on-device keyword spotter (sherpa-onnx, a native module only main
 *    can load); the agent session is the chat sidebar's own AI SDK loop —
 *    utterances are endpointed on-device, transcribed through the AI
 *    Gateway, answered by streamText with the sidebar's browser tools, and
 *    spoken through a realtime TTS provider (Bland today). Every credential
 *    involved stays in main; the tools need the tab WebContentsViews only
 *    main holds.
 *
 *  - AUDIO I/O happens in the chrome renderer (the tool rail's voice row):
 *    main has no getUserMedia and no speakers. Mic frames cross IPC inward
 *    as 16 kHz PCM16; reply audio crosses outward as 24 kHz PCM16. Frames,
 *    never credentials.
 *
 *  - Settings persist in MAIN (`voice.json`), device-local like tts.json.
 *    The renderer sees VoiceSettingsInfo, which reports where each
 *    credential came from, never a key. Model access rides the same
 *    key chain as the chat sidebar (env → stored gateway key → vended);
 *    the TTS provider's key is the one Settings → Voice & audio stores.
 *
 * Pure and dependency-free: both processes import it, so the settings page
 * cannot offer a knob main does not enforce.
 */

/* --------------------------------- models -------------------------------- */

export interface VoiceModelOption {
  id: string;
  label: string;
  hint?: string;
}

/**
 * Curated gateway model ids (`provider/model`, the chat sidebar's spelling).
 * Voice wants the fast end of the catalog: a spoken exchange dies at
 * chat-grade latency, so the defaults lean small. Free-typing another id is
 * allowed, same as the chat model picker — a model launched tomorrow needs
 * no release. Verified against the live gateway catalog 2026-08-15.
 */
export const VOICE_MODELS: readonly VoiceModelOption[] = [
  {
    id: "google/gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    hint: "fast, reliable tool use",
  },
  {
    id: "zai/glm-5.2-fast",
    label: "GLM 5.2 Fast",
    hint: "fastest tokens (170+/s)",
  },
  {
    id: "anthropic/claude-opus-5",
    label: "Claude Opus 5",
    hint: "most capable, slower",
  },
  {
    id: "anthropic/claude-opus-5-fast",
    label: "Claude Opus 5 Fast",
    hint: "most capable, faster",
  },
  {
    id: "openai/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    hint: "newest from OpenAI",
  },
];

export const DEFAULT_VOICE_MODEL = VOICE_MODELS[0]!.id;

/**
 * The gateway transcription model utterances go through. Persisted (and
 * hand-editable in voice.json) but deliberately not a settings-page knob
 * yet — one STT model that works beats a picker nobody asked for.
 */
export const DEFAULT_VOICE_STT_MODEL = "openai/gpt-4o-mini-transcribe";

/**
 * The narrator: an ultra-fast gateway model that composes one-line spoken
 * progress updates from tool events when the AGENT model works silently
 * (thinking-heavy models often call a dozen tools without a word). Same
 * persistence story as sttModel — hand-editable, no settings knob yet.
 */
export const DEFAULT_VOICE_NARRATOR_MODEL = "zai/glm-5.2-fast";

/* ----------------------------- TTS providers ------------------------------ */

/**
 * The realtime speech providers the voice can answer through. Bland is the
 * first; the session-side interface (main/voice/tts-realtime.ts) is written
 * for more. These are distinct from shared/tts.ts's read-aloud providers:
 * read-aloud renders a finished clip, the voice needs text streamed in and
 * PCM streamed out mid-sentence.
 */
export const VOICE_TTS_PROVIDERS = ["bland"] as const;
export type VoiceTtsProviderId = (typeof VOICE_TTS_PROVIDERS)[number];

export function isVoiceTtsProviderId(
  value: unknown,
): value is VoiceTtsProviderId {
  return (
    typeof value === "string" &&
    (VOICE_TTS_PROVIDERS as readonly string[]).includes(value)
  );
}

export const DEFAULT_VOICE_TTS_PROVIDER: VoiceTtsProviderId = "bland";

/** Bland's universal built-in voice id (Karen) — every account can speak it;
 *  the settings page fetches the account's real list over `tts:voices`. */
export const DEFAULT_VOICE_TTS_VOICE = "29158307-9893-4149-8a75-bc9ce313d64e";

/* ------------------------------ audio format ------------------------------ */

/** What the mic capture must deliver and the wake word / endpointer consume. */
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
/** What main guarantees on the reply wire (resampling the provider when it
 *  answers in anything else) and the renderer schedules for playback. */
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000;

/* -------------------------------- settings ------------------------------- */

export const DEFAULT_WAKE_WORD = "suma";

/** What main persists (voice.json). No credentials live here anymore: the
 *  gateway key chain is the chat sidebar's, the TTS key is tts.json's. */
export interface VoiceSettings {
  /** Master switch — off by default: a browser must not listen unasked. */
  enabled: boolean;
  /** Hands-free trigger ("Suma, …"). Off ⇒ push-to-talk (⌥Space) only. */
  wakeWordEnabled: boolean;
  /** The trigger phrase, matched on-device. Letters and spaces only. */
  wakeWord: string;
  /** Gateway model id for the agent loop. */
  model: string;
  /** Gateway model id for transcription. */
  sttModel: string;
  /** Gateway model id for spoken progress updates during silent runs. */
  narratorModel: string;
  ttsProvider: VoiceTtsProviderId;
  /** The TTS provider's voice id. */
  voice: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  wakeWordEnabled: true,
  wakeWord: DEFAULT_WAKE_WORD,
  model: DEFAULT_VOICE_MODEL,
  sttModel: DEFAULT_VOICE_STT_MODEL,
  narratorModel: DEFAULT_VOICE_NARRATOR_MODEL,
  ttsProvider: DEFAULT_VOICE_TTS_PROVIDER,
  voice: DEFAULT_VOICE_TTS_VOICE,
};

export const VOICE_SETTINGS_FILENAME = "voice.json";

/**
 * Where the model credential comes from — status line, never the key. The
 * chain is the chat sidebar's, verbatim: env gateway key, then the stored
 * Vercel key from Settings → Voice & audio, then "vended" — model access
 * through the signed-in control plane's gateway proxy, keyless on this
 * machine. Mirrors ChatKeyState (shared/chat.ts).
 */
export type VoiceKeyState = "env" | "stored" | "vended" | "unset";

/** Whether the TTS provider has a key (tts.json's, surfaced read-only). */
export type VoiceTtsKeyState = "env" | "stored" | "unset";

/** The renderer-facing view of the settings — no key material. */
export interface VoiceSettingsInfo {
  enabled: boolean;
  wakeWordEnabled: boolean;
  wakeWord: string;
  model: string;
  sttModel: string;
  narratorModel: string;
  ttsProvider: VoiceTtsProviderId;
  voice: string;
  keyState: VoiceKeyState;
  ttsKeyState: VoiceTtsKeyState;
}

export interface VoiceSettingsPatch {
  enabled?: boolean;
  wakeWordEnabled?: boolean;
  wakeWord?: string;
  model?: string;
  sttModel?: string;
  narratorModel?: string;
  ttsProvider?: VoiceTtsProviderId;
  voice?: string;
}

/* ------------------------- legacy-value migration -------------------------- */

/**
 * The pre-2026-08-15 voice.json spoke Gemini Live: `model` was a bare Gemini
 * id and `voice` a prebuilt Live voice name. Fed to the new pipeline those
 * become live failures — Bland answers "voice not found" for "Puck", the
 * gateway rejects a model id with no provider prefix — so the parser
 * migrates them to the defaults instead of preserving them faithfully.
 */
const LEGACY_GEMINI_VOICES: ReadonlySet<string> = new Set([
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Zephyr",
]);

/** Gateway ids are always `provider/model`; a bare id is a Gemini leftover. */
function migrateModel(value: string, fallback: string): string {
  return value.includes("/") ? value : fallback;
}

function migrateVoice(value: string): string {
  return LEGACY_GEMINI_VOICES.has(value) ? DEFAULT_VOICE_TTS_VOICE : value;
}

/**
 * A wake word the on-device spotter can be armed with: one to four plain
 * words. (The spotter encodes it into BPE tokens; punctuation and digits have
 * no tokens to encode into.)
 */
export function normalizeWakeWord(value: string): string | null {
  const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;
  if (!words.every((word) => /^[a-z]+$/.test(word))) return null;
  return words.join(" ");
}

/** Parse persisted settings; anything malformed falls back field-by-field. */
export function parseVoiceSettings(raw: string): VoiceSettings {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
  if (typeof data !== "object" || data === null) {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
  const record = data as Record<string, unknown>;
  const text = (key: keyof VoiceSettings, fallback: string): string =>
    typeof record[key] === "string" && (record[key] as string).trim() !== ""
      ? (record[key] as string).trim()
      : fallback;
  return {
    enabled: record["enabled"] === true,
    wakeWordEnabled: record["wakeWordEnabled"] !== false,
    wakeWord:
      normalizeWakeWord(text("wakeWord", DEFAULT_WAKE_WORD)) ??
      DEFAULT_WAKE_WORD,
    model: migrateModel(
      text("model", DEFAULT_VOICE_MODEL),
      DEFAULT_VOICE_MODEL,
    ),
    sttModel: migrateModel(
      text("sttModel", DEFAULT_VOICE_STT_MODEL),
      DEFAULT_VOICE_STT_MODEL,
    ),
    narratorModel: migrateModel(
      text("narratorModel", DEFAULT_VOICE_NARRATOR_MODEL),
      DEFAULT_VOICE_NARRATOR_MODEL,
    ),
    ttsProvider: isVoiceTtsProviderId(record["ttsProvider"])
      ? record["ttsProvider"]
      : DEFAULT_VOICE_TTS_PROVIDER,
    voice: migrateVoice(text("voice", DEFAULT_VOICE_TTS_VOICE)),
  };
}

/** Apply a renderer patch. Invalid values are dropped, not errors — the
 *  reply always shows what was really stored. */
export function mergeVoiceSettings(
  current: VoiceSettings,
  patch: VoiceSettingsPatch,
): VoiceSettings {
  const next: VoiceSettings = { ...current };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.wakeWordEnabled === "boolean") {
    next.wakeWordEnabled = patch.wakeWordEnabled;
  }
  if (typeof patch.wakeWord === "string") {
    const normalized = normalizeWakeWord(patch.wakeWord);
    if (normalized !== null) next.wakeWord = normalized;
  }
  if (typeof patch.model === "string" && patch.model.trim() !== "") {
    next.model = patch.model.trim();
  }
  if (typeof patch.sttModel === "string" && patch.sttModel.trim() !== "") {
    next.sttModel = patch.sttModel.trim();
  }
  if (
    typeof patch.narratorModel === "string" &&
    patch.narratorModel.trim() !== ""
  ) {
    next.narratorModel = patch.narratorModel.trim();
  }
  if (isVoiceTtsProviderId(patch.ttsProvider)) {
    next.ttsProvider = patch.ttsProvider;
  }
  if (typeof patch.voice === "string" && patch.voice.trim() !== "") {
    next.voice = patch.voice.trim();
  }
  return next;
}

export function voiceSettingsInfo(
  settings: VoiceSettings,
  keyState: VoiceKeyState,
  ttsKeyState: VoiceTtsKeyState,
): VoiceSettingsInfo {
  return {
    enabled: settings.enabled,
    wakeWordEnabled: settings.wakeWordEnabled,
    wakeWord: settings.wakeWord,
    model: settings.model,
    sttModel: settings.sttModel,
    narratorModel: settings.narratorModel,
    ttsProvider: settings.ttsProvider,
    voice: settings.voice,
    keyState,
    ttsKeyState,
  };
}

/* --------------------------------- status -------------------------------- */

/**
 * The assistant's lifecycle, as the HUD renders it:
 *
 *   off ── enable ──► listening ── wake word / ⌥Space ──► connecting ──► active
 *                        ▲                                                │
 *                        └───────────── session ends ─────────────────────┘
 *
 * "listening" means armed (wake word or push-to-talk), NOT in a
 * conversation; nothing leaves this Mac in that state. Audio only flows out
 * while "connecting"/"active" — and then only the utterances the endpointer
 * carves out, to the transcription model.
 */
export type VoicePhase = "off" | "listening" | "connecting" | "active";

/** The wake-word engine's own readiness, shown on the settings page. */
export type WakeWordState =
  | "off" // disabled in settings
  | "downloading" // fetching the on-device model (first enable)
  | "ready"
  | "unavailable"; // native module or model failed to load — push-to-talk still works

export interface VoiceStatus {
  phase: VoicePhase;
  wakeWord: WakeWordState;
  /** The last failure worth showing (bad key, session dropped); null when
   *  healthy. Cleared on the next successful state change. */
  error: string | null;
}

export const VOICE_STATUS_OFF: VoiceStatus = {
  phase: "off",
  wakeWord: "off",
  error: null,
};

/* ------------------------------ wire events ------------------------------- */

/**
 * A live-caption line for the HUD. Lines REPLACE the previous line for the
 * same role — main accumulates the agent's streamed text (and delivers each
 * utterance's transcription whole), so the renderer never reassembles text.
 */
export interface VoiceTranscriptEvent {
  role: "user" | "assistant";
  text: string;
}

/** One chunk of reply audio: 16-bit little-endian PCM at 24 kHz, mono. */
export interface VoiceAudioOutEvent {
  data: Uint8Array;
}

/** Mic frames inward: 16-bit little-endian PCM at 16 kHz, mono. */
export interface VoiceAudioInArgs {
  data: Uint8Array;
}
