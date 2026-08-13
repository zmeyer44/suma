/**
 * Voice assistant contract — shared by main (which listens, connects, and
 * acts) and the renderer (which captures the microphone, plays replies, and
 * renders the HUD + settings page).
 *
 * WHERE THE PIECES LIVE, and why (the TTS/chat split, §8.1):
 *
 *  - The WAKE-WORD engine and the LIVE SESSION run in MAIN. The wake word is
 *    an on-device keyword spotter (sherpa-onnx, a native module only main can
 *    load); the live session is a Gemini Live WebSocket whose API key must
 *    never reach a renderer and whose tool calls need the tab
 *    WebContentsViews only main holds — the exact seam the chat sidebar's
 *    agent loop already uses.
 *
 *  - AUDIO I/O happens in the overlay renderer (the same always-alive view
 *    that hosts the floating audio player): main has no getUserMedia and no
 *    speakers. Mic frames cross IPC inward as 16 kHz PCM16; reply audio
 *    crosses outward as 24 kHz PCM16. Frames, never credentials.
 *
 *  - Settings persist in MAIN (`voice.json`, chmod 600 — it may hold the
 *    Gemini key), device-local like tts.json. The renderer sees
 *    VoiceSettingsInfo, which reports whether a key exists, never the key.
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
 * Curated Gemini Live model ids. The Live API is the one place the assistant
 * speaks AND listens over a single connection with tool calling — no other
 * provider is wired here yet, so these are Gemini ids, not gateway ids.
 * Free-typing another id is allowed, same as the chat model picker.
 */
export const VOICE_MODELS: readonly VoiceModelOption[] = [
  {
    id: "gemini-2.5-flash-native-audio-preview-09-2025",
    label: "Gemini native audio",
    hint: "most natural, best interruption handling",
  },
  {
    id: "gemini-live-2.5-flash-preview",
    label: "Gemini Live Flash",
    hint: "half-cascade, most robust tool calling",
  },
];

export const DEFAULT_VOICE_MODEL = VOICE_MODELS[0]!.id;

/** Gemini Live prebuilt voices (a stable, documented subset). */
export const VOICE_VOICES: ReadonlyArray<{ id: string; label: string; hint?: string }> = [
  { id: "Puck", label: "Puck", hint: "upbeat" },
  { id: "Charon", label: "Charon", hint: "informative" },
  { id: "Kore", label: "Kore", hint: "firm" },
  { id: "Fenrir", label: "Fenrir", hint: "excitable" },
  { id: "Aoede", label: "Aoede", hint: "breezy" },
  { id: "Leda", label: "Leda", hint: "youthful" },
  { id: "Orus", label: "Orus", hint: "firm" },
  { id: "Zephyr", label: "Zephyr", hint: "bright" },
];

export const DEFAULT_VOICE_VOICE = "Puck";

/* ------------------------------ audio format ------------------------------ */

/** What the mic capture must deliver and the wake word / Live API consume. */
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
/** What Gemini Live replies with and the renderer schedules for playback. */
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000;

/* -------------------------------- settings ------------------------------- */

export const DEFAULT_WAKE_WORD = "suma";

/** What main persists (voice.json). The key is here; it is NEVER sent out. */
export interface VoiceSettings {
  /** Master switch — off by default: a browser must not listen unasked. */
  enabled: boolean;
  /** Hands-free trigger ("Suma, …"). Off ⇒ push-to-talk (⌥Space) only. */
  wakeWordEnabled: boolean;
  /** The trigger phrase, matched on-device. Letters and spaces only. */
  wakeWord: string;
  model: string;
  voice: string;
  /** Gemini API key ("" = none stored). */
  apiKey: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  wakeWordEnabled: true,
  wakeWord: DEFAULT_WAKE_WORD,
  model: DEFAULT_VOICE_MODEL,
  voice: DEFAULT_VOICE_VOICE,
  apiKey: "",
};

export const VOICE_SETTINGS_FILENAME = "voice.json";

/** Where the Gemini credential came from — status line, never the key. */
export type VoiceKeyState = "env" | "stored" | "unset";

/** The renderer-facing view of the settings — no key material. */
export interface VoiceSettingsInfo {
  enabled: boolean;
  wakeWordEnabled: boolean;
  wakeWord: string;
  model: string;
  voice: string;
  keyState: VoiceKeyState;
}

export interface VoiceSettingsPatch {
  enabled?: boolean;
  wakeWordEnabled?: boolean;
  wakeWord?: string;
  model?: string;
  voice?: string;
  /** "" clears a stored key; omitted leaves it untouched. */
  apiKey?: string;
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
    model: text("model", DEFAULT_VOICE_MODEL),
    voice: text("voice", DEFAULT_VOICE_VOICE),
    apiKey: typeof record["apiKey"] === "string" ? record["apiKey"] : "",
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
  if (typeof patch.voice === "string" && patch.voice.trim() !== "") {
    next.voice = patch.voice.trim();
  }
  if (typeof patch.apiKey === "string") next.apiKey = patch.apiKey.trim();
  return next;
}

export function voiceSettingsInfo(
  settings: VoiceSettings,
  keyState: VoiceKeyState,
): VoiceSettingsInfo {
  return {
    enabled: settings.enabled,
    wakeWordEnabled: settings.wakeWordEnabled,
    wakeWord: settings.wakeWord,
    model: settings.model,
    voice: settings.voice,
    keyState,
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
 * conversation; nothing leaves this Mac in that state. Audio only flows to
 * the model while "connecting"/"active".
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
 * same role — main accumulates the Live API's incremental transcription
 * chunks so the renderer never has to reassemble text.
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
