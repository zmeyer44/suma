/**
 * VoiceLiveSession — one live conversation with Gemini over the Live API
 * (bidirectional WebSocket): mic audio in, spoken replies out, tool calls
 * executed against the live browser in between.
 *
 * This runs in MAIN for the same reasons the chat agent loop does: the API
 * key stays out of the renderers, and the tools need the tab
 * WebContentsViews. The renderer's only involvement is PCM bytes in both
 * directions.
 *
 * Lifetime: constructed per conversation (wake word or ⌥Space), closed by
 * the user, an idle timeout, or the server. All callbacks funnel to
 * VoiceService, which owns the state machine — this class only speaks the
 * protocol.
 */

import { GoogleGenAI, Modality, type Session } from "@google/genai";
import {
  toFunctionErrorResponse,
  toFunctionResponse,
  type VoiceTool,
} from "./voice-core";

/** A handshake slower than this is not coming (setup normally lands <2 s). */
const CONNECT_TIMEOUT_MS = 15_000;

export interface VoiceLiveSessionOpts {
  apiKey: string;
  model: string;
  /** Prebuilt voice name (shared/voice.ts VOICE_VOICES). */
  voice: string;
  systemInstruction: string;
  tools: VoiceTool[];
  callbacks: {
    /** One chunk of 24 kHz PCM16 reply audio. */
    onAudio: (data: Uint8Array) => void;
    /** Live captions; `text` is the full line so far (main accumulates). */
    onTranscript: (role: "user" | "assistant", text: string) => void;
    /** The user talked over the reply — flush any buffered playback. */
    onInterrupted: () => void;
    /** A tool ran (HUD activity + idle-timer food). */
    onToolActivity: (name: string) => void;
    /** The session is over; `error` is user-readable, null on clean close. */
    onClosed: (error: string | null) => void;
  };
}

export class VoiceLiveSession {
  private session: Session | null = null;
  private closed = false;
  /** onClosed must fire exactly once — onerror and onclose both race here. */
  private finished = false;
  /** Caption accumulators — the Live API streams transcription in fragments. */
  private userLine = "";
  private assistantLine = "";
  /** Resolved by the server's setupComplete; connect() waits on it so a
   *  returned session is ALWAYS ready for audio (no ready-callback race). */
  private readySettle: { resolve: () => void; reject: (err: Error) => void } | null =
    null;

  private constructor(private readonly opts: VoiceLiveSessionOpts) {}

  static async connect(opts: VoiceLiveSessionOpts): Promise<VoiceLiveSession> {
    const live = new VoiceLiveSession(opts);
    const ready = new Promise<void>((resolve, reject) => {
      live.readySettle = { resolve, reject };
    });
    // A rejected key can close the socket before the SDK's connect promise
    // settles — in fact the SDK's promise never settles at all in that case
    // (observed: bad key ⇒ onclose fires, connect() hangs forever). So the
    // handshake is a race: the socket + setupComplete against the close
    // handler's rejection against a hard timeout. Pre-attach consumers so
    // no branch's rejection is ever "unhandled" in the gaps.
    ready.catch(() => undefined);
    const ai = new GoogleGenAI({ apiKey: opts.apiKey });
    const sessionPromise = ai.live.connect({
      model: opts.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: opts.systemInstruction,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } },
        },
        // Both directions transcribed so the HUD can caption the exchange.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools:
          opts.tools.length === 0
            ? undefined
            : [
                {
                  functionDeclarations: opts.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.parametersJsonSchema,
                  })),
                },
              ],
      },
      callbacks: {
        onmessage: (message) => live.handleMessage(message),
        onerror: (event: { message?: string }) =>
          live.finish(event.message ?? "voice connection error"),
        onclose: (event: { reason?: string } | undefined) =>
          live.finish((event?.reason ?? "") || "the voice session ended"),
      },
    });
    sessionPromise.then(
      (session) => {
        live.session = session;
        // The race below may already have failed (timeout, early close) —
        // a socket nobody owns must not stay open.
        if (live.closed) session.close();
      },
      () => undefined,
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("the voice session took too long to connect")),
        CONNECT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([Promise.all([sessionPromise, ready]), timeout]);
    } catch (err) {
      // Silence any late callbacks; the caller only ever sees this throw.
      live.finished = true;
      live.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return live;
  }

  /** Forward one mic frame (16 kHz PCM16). Safe to call after close. */
  sendAudio(frame: Uint8Array): void {
    if (this.closed || this.session === null) return;
    try {
      this.session.sendRealtimeInput({
        audio: {
          data: Buffer.from(frame).toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      });
    } catch {
      // A send racing the socket closing loses harmlessly; onclose reports.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session?.close();
    } catch {
      // Already gone.
    }
  }

  /* -------------------------------- protocol ------------------------------ */

  private handleMessage(message: {
    setupComplete?: unknown;
    serverContent?: {
      modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
      inputTranscription?: { text?: string };
      outputTranscription?: { text?: string };
      interrupted?: boolean;
      turnComplete?: boolean;
    };
    toolCall?: {
      functionCalls?: Array<{
        id?: string;
        name?: string;
        args?: Record<string, unknown>;
      }>;
    };
  }): void {
    if (this.closed) return;
    const { callbacks } = this.opts;
    if (message.setupComplete !== undefined && this.readySettle !== null) {
      this.readySettle.resolve();
      this.readySettle = null;
    }

    const content = message.serverContent;
    if (content !== undefined) {
      if (content.interrupted === true) {
        this.assistantLine = "";
        callbacks.onInterrupted();
      }
      const heard = content.inputTranscription?.text;
      if (typeof heard === "string" && heard !== "") {
        this.userLine += heard;
        callbacks.onTranscript("user", this.userLine.trim());
      }
      const said = content.outputTranscription?.text;
      if (typeof said === "string" && said !== "") {
        this.assistantLine += said;
        callbacks.onTranscript("assistant", this.assistantLine.trim());
      }
      for (const part of content.modelTurn?.parts ?? []) {
        const data = part.inlineData?.data;
        if (typeof data === "string" && data !== "") {
          callbacks.onAudio(new Uint8Array(Buffer.from(data, "base64")));
        }
      }
      // A finished turn ends both caption lines; the next exchange starts
      // fresh instead of growing one endless paragraph.
      if (content.turnComplete === true) {
        this.userLine = "";
        this.assistantLine = "";
      }
    }

    const calls = message.toolCall?.functionCalls;
    if (calls !== undefined && calls.length > 0) {
      void this.runToolCalls(calls);
    }
  }

  /**
   * Execute tool calls and answer them. Sequential on purpose: browser tools
   * mutate shared state (the active tab), and the model's plans assume its
   * calls happen in order.
   */
  private async runToolCalls(
    calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>,
  ): Promise<void> {
    for (const call of calls) {
      const name = call.name ?? "";
      const tool = this.opts.tools.find((entry) => entry.name === name);
      this.opts.callbacks.onToolActivity(name);
      let response: Record<string, unknown>;
      if (tool === undefined) {
        response = { error: `unknown tool "${name}"` };
      } else {
        try {
          response = toFunctionResponse(await tool.execute(call.args ?? {}));
        } catch (err) {
          // The model sees the failure and recovers, chat-tools style.
          response = toFunctionErrorResponse(err);
        }
      }
      if (this.closed || this.session === null) return;
      try {
        this.session.sendToolResponse({
          functionResponses: [{ id: call.id, name, response }],
        });
      } catch {
        return; // Socket raced shut; onclose handles the rest.
      }
    }
  }

  private finish(error: string | null): void {
    // A close() the service asked for is not an error, whatever reason the
    // socket reports afterwards.
    const deliberate = this.closed;
    this.closed = true;
    if (this.finished) return;
    this.finished = true;
    // A session that dies during the handshake fails connect() rather than
    // reporting a close the caller never saw open.
    if (this.readySettle !== null) {
      this.readySettle.reject(
        new Error(error ?? "the voice session closed before it was ready"),
      );
      this.readySettle = null;
      return;
    }
    this.opts.callbacks.onClosed(deliberate ? null : error);
  }
}
