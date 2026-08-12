/**
 * Text-to-speech contract — shared by main (which synthesizes) and the
 * renderer (which plays and configures it).
 *
 * WHERE THE PIECES LIVE, and why:
 *
 *  - SYNTHESIS settings (provider, per-provider voice, API keys) live in MAIN,
 *    in `tts.json` beside workspace.json. They have to: main is the process
 *    that calls the provider, and an API key must never be handed to the
 *    renderer — so `tts:speak` carries text, not credentials, and the key never
 *    crosses IPC in either direction (see TtsSettingsInfo, which reports only
 *    whether a key EXISTS). Device-local rather than synced, like the download
 *    routing preference: one Mac's ElevenLabs key is not the account's.
 *
 *  - PLAYBACK settings (speed, volume) live beside the renderer's other
 *    presentation state (localStorage, like the theme and the split ratios).
 *    They are applied to the audio element, so main has no use for them and
 *    reading them must not cost an IPC round trip at play time.
 *
 * Pure and dependency-free on purpose: both processes import it, so a provider
 * cannot be added to the settings page without main knowing how to speak it.
 */

export type TtsProviderId =
  | "system"
  | "openai"
  | "elevenlabs"
  | "vercel"
  | "bland";

export const TTS_PROVIDER_IDS: readonly TtsProviderId[] = [
  "system",
  "openai",
  "elevenlabs",
  "vercel",
  "bland",
];

export function isTtsProviderId(value: unknown): value is TtsProviderId {
  return (
    typeof value === "string" &&
    (TTS_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/** The providers that need a credential — i.e. every remote one. */
export type TtsKeyProvider = "openai" | "elevenlabs" | "vercel" | "bland";

export const TTS_KEY_PROVIDERS: readonly TtsKeyProvider[] = [
  "openai",
  "elevenlabs",
  "vercel",
  "bland",
];

export function isTtsKeyProvider(value: unknown): value is TtsKeyProvider {
  return (
    typeof value === "string" &&
    (TTS_KEY_PROVIDERS as readonly string[]).includes(value)
  );
}

export const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
export const ELEVENLABS_SPEECH_MODEL = "eleven_multilingual_v2";

/**
 * Vercel AI Gateway — one key for many providers' models, which is the point of
 * having it here alongside the direct providers: a team that already routes its
 * model traffic through the gateway (billing, budgets, usage in one place)
 * should not have to hand Suma a second, provider-direct key to get speech.
 *
 * Speech is a documented REST endpoint of its own — NOT the OpenAI-compatible
 * `/v1/chat/completions` surface — and it answers with base64 audio inside JSON
 * rather than raw bytes. See tts-core.ts's `vercelSpeechRequest`.
 * https://vercel.com/docs/ai-gateway/modalities/text-to-speech
 */
export const VERCEL_SPEECH_URL = "https://ai-gateway.vercel.sh/v4/ai/speech-model";

export interface TtsModelOption {
  id: string;
  label: string;
  hint?: string;
}

/**
 * The gateway's speech catalog. Vercel's docs are explicit that text to speech
 * "supports OpenAI speech models only" for now, so this lists the two they
 * document rather than guessing at ids the gateway would reject.
 */
export const VERCEL_SPEECH_MODELS: readonly TtsModelOption[] = [
  { id: "openai/tts-1", label: "tts-1", hint: "fast" },
  { id: "openai/tts-1-hd", label: "tts-1-hd", hint: "higher fidelity" },
];

/**
 * Bland's speech models. btts-3 is their current generation; btts-2 is kept
 * selectable because a cloned voice made against it is the voice its owner
 * auditioned, and switching generations changes how it sounds.
 */
export const BLAND_SPEECH_MODELS: readonly TtsModelOption[] = [
  { id: "btts-3", label: "btts-3", hint: "current" },
  { id: "btts-2", label: "btts-2", hint: "previous generation" },
];

export interface TtsProviderInfo {
  id: TtsProviderId;
  label: string;
  /** Two words at most — this is what the dock puts before the voice name. */
  short: string;
  /** Shown under the provider picker on the Voice & audio page. */
  blurb: string;
  /** Whether synthesis leaves this Mac (and therefore needs a key). */
  remote: boolean;
  /** The one model this provider always uses, when it is not selectable. */
  model: string | null;
  /** Selectable models; only the gateway and Bland have more than one. */
  models?: readonly TtsModelOption[];
  /**
   * Whether the real voice list has to be ASKED for rather than shipped —
   * this Mac's installed `say` voices, or the voices on a Bland account
   * (cloned and library ones are not knowable in advance). `staticVoices` is
   * the fallback for these, not the whole truth.
   */
  liveVoices?: boolean;
}

export const TTS_PROVIDERS: readonly TtsProviderInfo[] = [
  {
    id: "system",
    label: "macOS voice",
    short: "macOS",
    blurb:
      "This Mac's built-in speech synthesis. Free, offline, and nothing leaves the machine.",
    remote: false,
    model: null,
    liveVoices: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    short: "OpenAI",
    blurb: `Natural speech via ${OPENAI_SPEECH_MODEL}. The text is sent to OpenAI and needs an API key.`,
    remote: true,
    model: OPENAI_SPEECH_MODEL,
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    short: "ElevenLabs",
    blurb: `Studio-grade voices via ${ELEVENLABS_SPEECH_MODEL}. The text is sent to ElevenLabs and needs an API key.`,
    remote: true,
    model: ELEVENLABS_SPEECH_MODEL,
  },
  {
    id: "vercel",
    label: "Vercel AI Gateway",
    short: "Vercel",
    blurb:
      "OpenAI speech models behind your gateway key, so this reading shows up in the same usage and budget as the rest of your model traffic.",
    remote: true,
    model: null,
    models: VERCEL_SPEECH_MODELS,
  },
  {
    id: "bland",
    label: "Bland",
    short: "Bland",
    blurb:
      "Conversational voices built for realtime speech, including any voice you have cloned on your Bland account. The text is sent to Bland and needs an API key.",
    remote: true,
    model: null,
    models: BLAND_SPEECH_MODELS,
    liveVoices: true,
  },
];

export function ttsProviderInfo(id: TtsProviderId): TtsProviderInfo {
  return TTS_PROVIDERS.find((p) => p.id === id) ?? TTS_PROVIDERS[0]!;
}

export interface TtsVoice {
  /** What the provider is asked for: a `say` voice name or a voice id. */
  id: string;
  label: string;
  /** BCP-47-ish locale for `say` voices; a one-word character hint otherwise. */
  hint?: string;
}

/** gpt-4o-mini-tts's built-in voices. */
export const OPENAI_VOICES: readonly TtsVoice[] = [
  { id: "alloy", label: "Alloy", hint: "neutral" },
  { id: "ash", label: "Ash", hint: "warm" },
  { id: "ballad", label: "Ballad", hint: "wistful" },
  { id: "coral", label: "Coral", hint: "bright" },
  { id: "echo", label: "Echo", hint: "steady" },
  { id: "fable", label: "Fable", hint: "expressive" },
  { id: "nova", label: "Nova", hint: "friendly" },
  { id: "onyx", label: "Onyx", hint: "deep" },
  { id: "sage", label: "Sage", hint: "calm" },
  { id: "shimmer", label: "Shimmer", hint: "light" },
  { id: "verse", label: "Verse", hint: "narration" },
];

/** ElevenLabs premade library voices — stable public ids, no account setup. */
export const ELEVENLABS_VOICES: readonly TtsVoice[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel", hint: "narration" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah", hint: "soft" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi", hint: "strong" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni", hint: "well-rounded" },
  { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh", hint: "deep" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam", hint: "narration" },
];

/**
 * Bland's three built-in voices — the ones every organization has, by the ids
 * their docs publish. Everything else on a Bland account (clones, voices added
 * from the public library) is account-specific, so main asks `/v1/voices` for
 * the real list and this stands in when there is no key yet or the call fails.
 */
export const BLAND_VOICES: readonly TtsVoice[] = [
  { id: "29158307-9893-4149-8a75-bc9ce313d64e", label: "Karen", hint: "deadpan" },
  { id: "1d4dc605-071b-4eee-81b3-099b2894d0d1", label: "Matthew", hint: "mature" },
  { id: "2f29fdbb-c55e-4add-9c7c-93437ebf379d", label: "River", hint: "playful" },
];

/**
 * The catalogs known without asking anything. `system` is empty here because
 * its voices are whatever this Mac has installed — main enumerates them
 * (`tts:voices`) rather than shipping a list that would be wrong on any Mac
 * with a downloaded voice. Bland's entry is a floor rather than a list: its
 * built-ins are universal, and main adds the account's own on top.
 */
export function staticVoices(provider: TtsProviderId): readonly TtsVoice[] {
  // The gateway's speech models ARE OpenAI's, so they take OpenAI's voices.
  if (provider === "openai" || provider === "vercel") return OPENAI_VOICES;
  if (provider === "elevenlabs") return ELEVENLABS_VOICES;
  if (provider === "bland") return BLAND_VOICES;
  return [];
}

/** Settings main persists. The keys are here; they are NEVER sent out. */
export interface TtsSettings {
  provider: TtsProviderId;
  /** Per provider, so switching engines keeps each pick. */
  voices: Record<TtsProviderId, string>;
  /** Per provider too, and empty for the providers whose model is fixed. */
  models: Record<TtsProviderId, string>;
  apiKeys: Record<TtsKeyProvider, string>;
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  provider: "system",
  voices: {
    system: "",
    openai: "nova",
    elevenlabs: "21m00Tcm4TlvDq8ikWAM",
    vercel: "nova",
    bland: "29158307-9893-4149-8a75-bc9ce313d64e",
  },
  models: {
    system: "",
    openai: "",
    elevenlabs: "",
    vercel: "openai/tts-1",
    bland: "btts-3",
  },
  apiKeys: { openai: "", elevenlabs: "", vercel: "", bland: "" },
};

/** The model a provider will actually be asked for: its pick, or its fixed one. */
export function resolvedModel(
  provider: TtsProviderId,
  models: Partial<Record<TtsProviderId, string>>,
): string | null {
  const info = ttsProviderInfo(provider);
  if (info.models === undefined) return info.model;
  const chosen = models[provider]?.trim() ?? "";
  if (chosen !== "") return chosen;
  return info.models[0]?.id ?? null;
}

/**
 * Where a provider's credential came from. "env" means an environment variable
 * supplied it, which is worth SAYING rather than showing an empty field the
 * user would try to fill: the app is already able to speak.
 */
export type TtsKeyState = "unset" | "stored" | "env";

/** What the renderer is allowed to know about the settings — no key material. */
export interface TtsSettingsInfo {
  provider: TtsProviderId;
  voices: Record<TtsProviderId, string>;
  models: Record<TtsProviderId, string>;
  keys: Record<TtsKeyProvider, TtsKeyState>;
  /** False off macOS: there is no `say`, so the local provider cannot run. */
  systemVoiceAvailable: boolean;
}

export interface TtsSettingsPatch {
  provider?: TtsProviderId;
  voices?: Partial<Record<TtsProviderId, string>>;
  models?: Partial<Record<TtsProviderId, string>>;
  /** "" clears a stored key; omitted leaves it untouched. */
  apiKeys?: Partial<Record<TtsKeyProvider, string>>;
}

/** One synthesized clip, ready to be wrapped in a Blob by the renderer. */
export interface TtsClip {
  data: Uint8Array;
  /** So the renderer's Blob carries a type Chromium can decode. */
  mimeType: string;
  provider: TtsProviderId;
  /** Human-readable, for the dock: "OpenAI · Nova". */
  voiceLabel: string;
  /** Text was longer than the provider accepts and was cut at a sentence. */
  truncated: boolean;
}

/**
 * Providers cap a single request (OpenAI and Bland both at 4096 characters);
 * the local `say` has no such limit but a ten-minute utterance is not what
 * anyone meant by "read this back". One cap for all of them, applied after
 * stripping, so the same text produces the same clip whichever provider is
 * selected.
 */
export const MAX_TTS_CHARS = 4000;

export const TTS_SPEED_MIN = 0.5;
export const TTS_SPEED_MAX = 2;
export const TTS_SPEED_STEP = 0.25;
export const TTS_SPEED_DEFAULT = 1;

/** The speeds the dock's speed control cycles through. */
export const TTS_SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return TTS_SPEED_DEFAULT;
  return Math.min(Math.max(value, TTS_SPEED_MIN), TTS_SPEED_MAX);
}

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}

/** "1.25×", "1×" — trailing zeros dropped so the dock's chip stays narrow. */
export function speedLabel(speed: number): string {
  return `${speed.toFixed(2).replace(/\.?0+$/, "")}×`;
}

/**
 * Flatten markdown-ish text into something worth hearing: code blocks become a
 * spoken placeholder, links speak their label, and formatting symbols drop
 * away. Without this, an assistant answer reads back as "asterisk asterisk
 * important asterisk asterisk".
 */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\|/g, " ")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A one-line dock/MediaSession title from a body of text. */
export function speechTitle(text: string, max = 72): string {
  const line = stripForSpeech(text).split("\n").find((l) => l.trim() !== "") ?? "";
  const trimmed = line.trim();
  return trimmed.length > max
    ? `${trimmed.slice(0, max - 1).trimEnd()}…`
    : trimmed;
}

export const TTS_PREVIEW_TEXT =
  "This is how the reading voice will sound. Hand me an answer and I will read it back to you.";
