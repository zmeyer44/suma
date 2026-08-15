/**
 * Pure halves of the realtime TTS layer: the provider contract the agent
 * session speaks, and Bland's wire protocol (message builders + parser) —
 * no sockets, so every branch is testable (the tts-core.ts pattern).
 *
 * Realtime TTS is its own thing, distinct from shared/tts.ts's read-aloud
 * providers: read-aloud takes finished text and returns a finished clip; the
 * voice assistant needs to stream text in AS THE AGENT PRODUCES IT and get
 * PCM back mid-sentence, or every answer starts with dead air.
 */

import { VOICE_OUTPUT_SAMPLE_RATE } from "../../shared/voice";

/* ------------------------------ the contract ------------------------------- */

/**
 * One assistant turn's speech stream. The session sends text deltas exactly
 * as streamText yields them; the provider buffers, detects sentence
 * boundaries, and streams PCM back through `onAudio` — 24 kHz 16-bit mono
 * (the reply wire's contract; implementations resample when their provider
 * negotiates something else).
 */
export interface RealtimeTtsTurn {
  /** One text delta, verbatim (spaces and punctuation intact). */
  sendText(delta: string): void;
  /** All text sent; flush whatever is buffered and finish the stream. */
  finish(): void;
  /** Barge-in / teardown: stop synthesizing NOW, drop everything queued. */
  cancel(): void;
}

export interface RealtimeTtsTurnCallbacks {
  /** One chunk of 24 kHz PCM16 reply audio. */
  onAudio: (pcm: Uint8Array) => void;
  /** Synthesis finished cleanly — every byte for this turn has been
   *  delivered. Not called after cancel(). */
  onDone: () => void;
  /** The turn failed; user-readable. The turn is dead after this. */
  onError: (message: string) => void;
}

/** A configured provider: one `speak` per assistant turn. */
export interface RealtimeTtsProvider {
  /** Resolves once the provider is ready to take text (socket open and
   *  format negotiated), so time-to-first-token isn't spent handshaking. */
  speak(callbacks: RealtimeTtsTurnCallbacks): Promise<RealtimeTtsTurn>;
}

/* ----------------------------- Bland's protocol ---------------------------- */

export const BLAND_TTS_WSS_URL = "wss://api.bland.ai/v2/tts/ws";

/** What we ask Bland for: raw PCM16 at the reply wire's rate, so the common
 *  case ships bytes straight through with no resample. */
export const BLAND_PCM_ENCODING = "pcm_s16le";

export function blandInitMessage(voice: string): string {
  return JSON.stringify({
    type: "init",
    voice,
    audio: {
      encoding: BLAND_PCM_ENCODING,
      sample_rate: VOICE_OUTPUT_SAMPLE_RATE,
    },
  });
}

export function blandSpeakMessage(contextId: string, text: string): string {
  return JSON.stringify({ type: "speak", context_id: contextId, text });
}

export function blandEndOfTurnMessage(contextId: string): string {
  return JSON.stringify({ type: "end_of_turn", context_id: contextId });
}

export function blandCloseMessage(): string {
  return JSON.stringify({ type: "close" });
}

/** The control messages the session acts on. "ignored" is a frame we KNOW
 *  and deliberately skip (utterance_start bookkeeping); "other" is a frame
 *  we have never seen — the implementation logs those, so protocol drift
 *  surfaces instead of vanishing. */
export type BlandServerMessage =
  | { type: "ready"; sampleRate: number | null }
  | { type: "utterance_end" }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "ignored" }
  | { type: "other" };

/**
 * Parse one TEXT frame from Bland (binary frames are audio and never come
 * here). Defensive like every parser of remote bytes in this codebase:
 * unknown shapes become "other", never throws.
 */
export function parseBlandServerMessage(raw: string): BlandServerMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { type: "other" };
  }
  if (typeof data !== "object" || data === null) return { type: "other" };
  const record = data as Record<string, unknown>;
  switch (record["type"]) {
    case "ready": {
      // The ack echoes the negotiated format; trust it over what we asked
      // for. Shapes seen in the wild vary ({audio: {sample_rate}} and flat),
      // so both are read and absence is null (caller assumes its request).
      const audio =
        typeof record["audio"] === "object" && record["audio"] !== null
          ? (record["audio"] as Record<string, unknown>)
          : {};
      const rate = audio["sample_rate"] ?? record["sample_rate"];
      return {
        type: "ready",
        sampleRate:
          typeof rate === "number" && Number.isFinite(rate) && rate > 0
            ? rate
            : null,
      };
    }
    case "utterance_end":
      return { type: "utterance_end" };
    case "utterance_start":
      return { type: "ignored" };
    case "done":
      return { type: "done" };
    case "error": {
      const message = record["message"];
      return {
        type: "error",
        message:
          typeof message === "string" && message.trim() !== ""
            ? message.trim()
            : "the speech service reported an error",
      };
    }
    default:
      return { type: "other" };
  }
}
