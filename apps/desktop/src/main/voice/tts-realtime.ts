/**
 * Realtime TTS sessions over the network — the impure half of
 * tts-realtime-core.ts. Bland is the first provider; the agent session only
 * ever sees RealtimeTtsProvider, so the next engine is a new class here and
 * a settings enum entry, not a session rewrite.
 *
 * This runs in MAIN for the same reason TtsService does: the API key stays
 * out of the renderers, which only ever see PCM bytes.
 */

import WebSocket from "ws";
import { VOICE_OUTPUT_SAMPLE_RATE } from "../../shared/voice";
import { resamplePcm16 } from "./voice-core";
import {
  blandCloseMessage,
  blandEndOfTurnMessage,
  blandInitMessage,
  blandSpeakMessage,
  BLAND_TTS_WSS_URL,
  parseBlandServerMessage,
  type RealtimeTtsProvider,
  type RealtimeTtsTurn,
  type RealtimeTtsTurnCallbacks,
} from "./tts-realtime-core";

/** A socket that has not opened AND negotiated a format by now is not coming. */
const CONNECT_TIMEOUT_MS = 10_000;

export interface BlandRealtimeTtsOpts {
  apiKey: string;
  /** A Bland voice id — a built-in, a clone, or a library voice. */
  voice: string;
  /** Injected by tests; production uses the real constructor. */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
}

/**
 * One WebSocket per assistant turn, deliberately: barge-in becomes "close
 * the socket" — no cancel protocol to get subtly wrong, no half-flushed
 * context bleeding into the next turn — and the connect cost hides inside
 * the agent's own first-token latency because speak() opens the socket
 * while streamText is still thinking.
 */
export class BlandRealtimeTts implements RealtimeTtsProvider {
  constructor(private readonly opts: BlandRealtimeTtsOpts) {}

  speak(callbacks: RealtimeTtsTurnCallbacks): Promise<RealtimeTtsTurn> {
    const { apiKey, voice } = this.opts;
    const factory =
      this.opts.wsFactory ??
      ((url, headers) => new WebSocket(url, { headers }));

    return new Promise<RealtimeTtsTurn>((resolve, reject) => {
      const ws = factory(BLAND_TTS_WSS_URL, {
        authorization: `Bearer ${apiKey}`,
      });

      let ready = false; // resolved — callbacks own the turn now
      let finished = false; // onDone/onError delivered (or cancelled)
      let sampleRate = VOICE_OUTPUT_SAMPLE_RATE;
      const contextId = "turn";

      const settleReject = (message: string): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(new Error(message));
      };
      const fail = (message: string): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        callbacks.onError(message);
      };
      const done = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        callbacks.onDone();
      };
      const close = (): void => {
        try {
          ws.close();
        } catch {
          // Already gone.
        }
      };

      const timer = setTimeout(() => {
        close();
        settleReject("the speech service took too long to connect");
      }, CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        try {
          ws.send(blandInitMessage(voice));
        } catch {
          // The close handler reports.
        }
      });

      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (finished) return;
        if (isBinary) {
          const pcm = new Uint8Array(
            Array.isArray(data) ? Buffer.concat(data) : (data as Buffer),
          );
          if (pcm.byteLength === 0) return;
          callbacks.onAudio(
            resamplePcm16(pcm, sampleRate, VOICE_OUTPUT_SAMPLE_RATE),
          );
          return;
        }
        const raw = String(data);
        const message = parseBlandServerMessage(raw);
        switch (message.type) {
          case "ready":
            if (ready) return;
            ready = true;
            clearTimeout(timer);
            if (message.sampleRate !== null) sampleRate = message.sampleRate;
            console.log(
              `suma voice tts: bland ready (pcm @ ${String(sampleRate)} Hz)`,
            );
            resolve(turn);
            return;
          case "utterance_end":
          case "done":
            // Every byte for the turn has arrived. Ack and hang up — the
            // one-socket-per-turn design has nothing further to say.
            try {
              ws.send(blandCloseMessage());
            } catch {
              // Closing anyway.
            }
            done();
            close();
            return;
          case "error":
            // The parsed message is what the user sees; the raw frame (which
            // may carry a code or detail the parser doesn't model) goes to
            // the terminal for debugging.
            console.error("suma voice tts: bland error frame:", raw);
            (ready ? fail : settleReject)(message.message);
            close();
            return;
          case "ignored":
            return;
          case "other":
            // Unmodeled control frames are logged, not dropped silently — a
            // protocol change shows up here first.
            console.log("suma voice tts: unhandled bland frame:", raw.slice(0, 500));
            return;
        }
      });

      ws.on("error", (err: Error) => {
        console.error("suma voice tts: socket error:", err);
        const message = `speech connection failed: ${err.message}`;
        (ready ? fail : settleReject)(message);
        close();
      });

      ws.on("close", (code: number, reason: Buffer) => {
        // After done/cancel this is just the hangup; before, it is a failure
        // — audio may be missing — and the code and reason are the diagnosis
        // (4xx-style handshake rejections land here, not on "error").
        if (finished) return;
        const detail = reason.toString().trim();
        const suffix = detail === "" ? "" : `: ${detail}`;
        console.error(
          `suma voice tts: socket closed (code ${String(code)})${suffix}`,
        );
        (ready ? fail : settleReject)(
          `the speech connection closed early (code ${String(code)}${suffix})`,
        );
      });

      const send = (payload: string): void => {
        if (finished || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(payload);
        } catch {
          // The close handler reports.
        }
      };

      const turn: RealtimeTtsTurn = {
        sendText: (delta) => {
          if (delta !== "") send(blandSpeakMessage(contextId, delta));
        },
        finish: () => send(blandEndOfTurnMessage(contextId)),
        cancel: () => {
          // Silence, immediately: mark finished FIRST so the socket's dying
          // gasps (close event, buffered audio) go nowhere.
          finished = true;
          clearTimeout(timer);
          close();
        },
      };
    });
  }
}
