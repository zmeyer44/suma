import { describe, expect, it } from "vitest";
import {
  blandCloseMessage,
  blandEndOfTurnMessage,
  blandInitMessage,
  blandSpeakMessage,
  parseBlandServerMessage,
} from "../src/main/voice/tts-realtime-core";
import { VOICE_OUTPUT_SAMPLE_RATE } from "../src/shared/voice";

/* ----------------------------- client messages ----------------------------- */

describe("bland client messages", () => {
  it("init asks for raw PCM16 at the reply wire's rate", () => {
    expect(JSON.parse(blandInitMessage("voice-1"))).toEqual({
      type: "init",
      voice: "voice-1",
      audio: {
        encoding: "pcm_s16le",
        sample_rate: VOICE_OUTPUT_SAMPLE_RATE,
      },
    });
  });

  it("speak carries the delta verbatim under its context", () => {
    expect(JSON.parse(blandSpeakMessage("turn", " word, "))).toEqual({
      type: "speak",
      context_id: "turn",
      text: " word, ",
    });
  });

  it("end_of_turn and close are bare control frames", () => {
    expect(JSON.parse(blandEndOfTurnMessage("turn"))).toEqual({
      type: "end_of_turn",
      context_id: "turn",
    });
    expect(JSON.parse(blandCloseMessage())).toEqual({ type: "close" });
  });
});

/* ----------------------------- server messages ----------------------------- */

describe("parseBlandServerMessage", () => {
  it("reads the negotiated rate from ready, nested or flat", () => {
    expect(
      parseBlandServerMessage(
        JSON.stringify({ type: "ready", audio: { sample_rate: 48_000 } }),
      ),
    ).toEqual({ type: "ready", sampleRate: 48_000 });
    expect(
      parseBlandServerMessage(JSON.stringify({ type: "ready", sample_rate: 24_000 })),
    ).toEqual({ type: "ready", sampleRate: 24_000 });
  });

  it("nulls a ready without a usable rate — the caller assumes its request", () => {
    expect(parseBlandServerMessage(JSON.stringify({ type: "ready" }))).toEqual({
      type: "ready",
      sampleRate: null,
    });
    expect(
      parseBlandServerMessage(
        JSON.stringify({ type: "ready", audio: { sample_rate: "fast" } }),
      ),
    ).toEqual({ type: "ready", sampleRate: null });
  });

  it("passes utterance_end and done through", () => {
    expect(parseBlandServerMessage('{"type":"utterance_end"}').type).toBe(
      "utterance_end",
    );
    expect(parseBlandServerMessage('{"type":"done"}').type).toBe("done");
  });

  it("relays error messages and substitutes for blank ones", () => {
    expect(
      parseBlandServerMessage(
        JSON.stringify({ type: "error", code: "x", message: " bad voice " }),
      ),
    ).toEqual({ type: "error", message: "bad voice" });
    expect(parseBlandServerMessage('{"type":"error"}')).toEqual({
      type: "error",
      message: "the speech service reported an error",
    });
  });

  it("classifies known bookkeeping frames as ignored, not unknown", () => {
    expect(
      parseBlandServerMessage('{"type":"utterance_start","context_id":"turn"}')
        .type,
    ).toBe("ignored");
  });

  it("never throws on junk — unknown shapes become 'other'", () => {
    expect(parseBlandServerMessage("not json").type).toBe("other");
    expect(parseBlandServerMessage("null").type).toBe("other");
    expect(parseBlandServerMessage('{"type":"telemetry"}').type).toBe("other");
    expect(parseBlandServerMessage('"ready"').type).toBe("other");
  });
});
