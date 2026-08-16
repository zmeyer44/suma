/**
 * VoiceAgentSession — one conversation with the assistant, driven by the
 * SAME AI SDK harness as the chat sidebar (streamText + the browser
 * ToolSet), with speech at both ends:
 *
 *   mic frames ──► UtteranceDetector ──► gateway transcription ──► streamText
 *        (16 kHz PCM16)     (on-device)        (one utterance)    (agent loop,
 *                                                                  browser tools)
 *                                                                      │ text deltas
 *   renderer playback ◄── RealtimeTtsTurn (Bland, …) ◄─────────────────┘
 *        (24 kHz PCM16)
 *
 * This replaces the Gemini Live socket: the model brain is now whatever
 * gateway model the user picked (the chat picker's spelling), the tools are
 * the chat sidebar's own ToolSet verbatim — no adaptation layer — and the
 * voice is a swappable realtime TTS provider.
 *
 * Turn-taking rules, which are the whole feel of the feature:
 *  - An utterance ends after a breath of silence; then it is transcribed,
 *    answered, and spoken. An empty transcription (a cough, a door) is
 *    dropped silently — the session just keeps listening.
 *  - The user talking OVER the reply is a barge-in: the running turn is
 *    aborted (agent and TTS both), playback is flushed via onInterrupted,
 *    and what they said becomes the start of the next utterance.
 *  - History accumulates across turns (the AI SDK's response messages, tool
 *    calls included), so "click the second one" works.
 *
 * Lifetime: constructed per conversation (wake word or ⌥Space), closed by
 * the user, an idle timeout, or a fatal error. All state changes funnel to
 * VoiceService, which owns the phase machine — this class owns one
 * conversation's audio-to-audio loop.
 */

import {
  experimental_transcribe,
  generateText,
  NoTranscriptGeneratedError,
  stepCountIs,
  streamText,
  type createGateway,
  type ModelMessage,
  type ToolSet,
} from "ai";
import {
  VOICE_INPUT_SAMPLE_RATE,
  VOICE_OUTPUT_SAMPLE_RATE,
} from "../../shared/voice";
import type { RealtimeTtsProvider, RealtimeTtsTurn } from "./tts-realtime-core";
import {
  concatFrames,
  frameRms,
  NarrationQueue,
  narratorEvent,
  narratorPrompt,
  parseNarratorReply,
  pcm16ToWav,
  UtteranceDetector,
  VOICE_ACK_PHRASES,
} from "./voice-core";

/** Same leash as the chat sidebar: a turn may take a while, not forever. */
const MAX_STEPS = 16;

/** An "utterance" shorter than this is a cough, not a command (~0.4 s). */
const MIN_UTTERANCE_BYTES = Math.floor(VOICE_INPUT_SAMPLE_RATE * 0.4) * 2;

/** Synthesis lagging the final text by more than this is stuck, not slow. */
const TTS_FINISH_TIMEOUT_MS = 30_000;

/**
 * While the assistant is thinking or its reply is still playing, an
 * utterance only counts as the USER once it shows this many consecutive
 * voiced frames (~0.6 s of sustained speech). Echo cancellation upstream is
 * good but not perfect: the mic hears wisps of the reply and room noise,
 * and the idle gate's quarter second turned those into barge-ins that cut
 * the answer off and spawned "I didn't catch that" turns (observed live:
 * a 1.5 s blip transcribing to "E"). Real talking-over passes this easily;
 * blips never assemble the run.
 */
const BARGE_IN_VOICED_FRAMES = 5;
const BARGE_IN_RMS = 0.015;

/** A transcript this short is echo residue, not a command. */
const MIN_TRANSCRIPT_CHARS = 2;

/**
 * Narration pacing: the next queued sentence is handed to the TTS this far
 * before the current playback runs out (covers synthesis latency, keeps
 * sentences near-gapless), checked on this cadence. See NarrationQueue for
 * why sentences are held back at all.
 */
const SPEECH_LEAD_MS = 800;
const SPEECH_PUMP_MS = 250;

/** A turn silent this long (or at its first tool call, whichever comes
 *  first) gets a canned acknowledgment — model narration is optional,
 *  hearing SOMETHING is not. */
const ACK_DEADLINE_MS = 2_500;

/** The narrator model steps in once this many tool calls have run with the
 *  voice idle and nothing queued — before that, silence reads as working. */
const NARRATOR_MIN_EVENTS = 3;
/** A narrator slower than this has missed its moment. Sized for a
 *  thinking-tuned model that reasons before its SAY line. */
const NARRATOR_TIMEOUT_MS = 4_000;

export type Gateway = ReturnType<typeof createGateway>;

export interface VoiceAgentSessionOpts {
  /** The AI Gateway provider, already bound to the right credential
   *  (explicit key or the control plane's proxy) by VoiceService. */
  gateway: Gateway;
  /** Gateway model id for the agent loop ("google/gemini-2.5-flash"). */
  model: string;
  /** Gateway model id for transcription. */
  sttModel: string;
  /** Ultra-fast gateway model for spoken progress lines during silent runs. */
  narratorModel: string;
  /** The chat sidebar's browser tools, already permission-filtered. */
  tools: ToolSet;
  systemInstruction: string;
  tts: RealtimeTtsProvider;
  callbacks: {
    /** One chunk of 24 kHz PCM16 reply audio. */
    onAudio: (data: Uint8Array) => void;
    /** Caption lines; `text` is the full line so far for that role. */
    onTranscript: (role: "user" | "assistant", text: string) => void;
    /** Barge-in — the renderer must drop scheduled playback immediately. */
    onInterrupted: () => void;
    /** Conversation progress (idle-timer food). */
    onActivity: () => void;
    /** The session is over; `error` is user-readable, null on clean close. */
    onClosed: (error: string | null) => void;
  };
}

export class VoiceAgentSession {
  private readonly detector = new UtteranceDetector();
  private readonly history: ModelMessage[] = [];
  /** A turn in flight, or null while listening for the next utterance. */
  private turn: { controller: AbortController; generation: number } | null =
    null;
  private generation = 0;
  private closed = false;
  /** Estimated wall-clock end of the renderer's reply playback — main only
   *  ships chunks, so it models the player: each chunk extends the clock by
   *  its own duration. While this is in the future, the room contains the
   *  assistant's own voice and the strict barge-in gate applies. */
  private speakingUntil = 0;
  /** Consecutive voiced frames of a strict-mode utterance still proving it
   *  is the user; null when nothing needs proving. */
  private bargeRun: number | null = null;
  /** Whether the utterance being collected has earned a turn. */
  private validated = false;
  /** Rotates the canned acknowledgments so back-to-back turns don't chant. */
  private ackCount = 0;
  /** One narrator failure disables it for the session — a progress line is
   *  garnish, and a broken narrator must not log-spam every turn. */
  private narratorBroken = false;

  constructor(private readonly opts: VoiceAgentSessionOpts) {}

  /** One mic frame (16 kHz PCM16). The endpointer decides everything else. */
  acceptAudio(frame: Uint8Array): void {
    if (this.closed) return;
    // Strict mode: the assistant is thinking or audibly speaking, so an
    // utterance must prove itself (sustained voice) before it interrupts
    // anything or becomes a turn. Idle mode: every utterance is the user.
    const strict = this.turn !== null || Date.now() < this.speakingUntil;
    const event = this.detector.feed(frame);

    if (event.kind === "started") {
      this.opts.callbacks.onActivity();
      if (strict) {
        this.bargeRun = 0;
        this.validated = false;
      } else {
        this.validated = true;
      }
      return;
    }

    if (event.kind === "none") {
      if (this.bargeRun === null || this.validated) return;
      // Mid-utterance in strict mode: count consecutive voiced frames.
      if (frameRms(frame) >= BARGE_IN_RMS) {
        this.bargeRun += 1;
        if (this.bargeRun >= BARGE_IN_VOICED_FRAMES) {
          this.validated = true;
          this.bargeRun = null;
          console.log("suma voice: barge-in — sustained speech over the reply");
          this.speakingUntil = 0;
          if (this.turn !== null) this.abortTurn();
          else this.opts.callbacks.onInterrupted(); // just flush playback
        }
      } else {
        this.bargeRun = 0;
      }
      return;
    }

    // finished — one utterance.
    this.bargeRun = null;
    this.opts.callbacks.onActivity();
    if (!this.validated) {
      // A strict-mode utterance that never sustained voice: the reply's own
      // echo or room noise. Dropped BEFORE transcription — it must not cut
      // playback, start a turn, or cost an STT call.
      console.log("suma voice: dropping unvalidated utterance (echo/noise)");
      return;
    }
    this.validated = false;
    if (this.turn !== null) return; // abort raced the ending; let it settle
    const controller = new AbortController();
    const generation = ++this.generation;
    this.turn = { controller, generation };
    void this.runTurn(event.frames, controller, generation);
  }

  /** Teardown (user toggle, idle timeout, service shutdown). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortTurn();
    this.detector.reset();
  }

  /* -------------------------------- turns -------------------------------- */

  /** Abort the in-flight turn (barge-in or teardown): agent and TTS both. */
  private abortTurn(): void {
    const turn = this.turn;
    if (turn === null) return;
    this.turn = null;
    this.generation++;
    this.speakingUntil = 0; // playback is about to be flushed
    turn.controller.abort();
    if (!this.closed) this.opts.callbacks.onInterrupted();
  }

  private live(generation: number): boolean {
    return !this.closed && this.generation === generation;
  }

  private async runTurn(
    frames: Uint8Array[],
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    const { callbacks } = this.opts;
    let ttsTurn: RealtimeTtsTurn | null = null;
    // Which stage the turn died in — the difference between "transcription
    // failed" and an opaque error is most of the debugging.
    let stage = "transcription";
    try {
      const pcm = concatFrames(frames);
      if (pcm.byteLength < MIN_UTTERANCE_BYTES) return;
      const seconds = pcm.byteLength / 2 / VOICE_INPUT_SAMPLE_RATE;
      console.log(
        `suma voice: utterance captured (${seconds.toFixed(1)}s), transcribing via ${this.opts.sttModel}`,
      );

      /* ------------------------------- hear ------------------------------ */

      let heard = "";
      try {
        const transcription = await experimental_transcribe({
          model: this.opts.gateway.transcription(this.opts.sttModel),
          audio: pcm16ToWav(pcm, VOICE_INPUT_SAMPLE_RATE),
          abortSignal: controller.signal,
        });
        heard = transcription.text.trim();
      } catch (err) {
        // "No transcript generated" is the SDK's spelling of silence — the
        // model looked at the audio and heard nothing worth writing. That is
        // a dropped utterance, not a dead session (observed live: an echo
        // blip ended the whole conversation through this path).
        if (NoTranscriptGeneratedError.isInstance(err)) {
          console.log("suma voice: no transcript generated — dropping the utterance");
          return;
        }
        throw err;
      }
      if (!this.live(generation)) return;
      // Noise that transcribes to (nearly) nothing is dropped without a
      // word — the alternative is the assistant answering every door slam.
      if (heard.length < MIN_TRANSCRIPT_CHARS) {
        console.log(
          `suma voice: transcription too thin (${JSON.stringify(heard)}) — dropping the utterance`,
        );
        return;
      }
      console.log(`suma voice: heard ${JSON.stringify(heard)}`);
      callbacks.onTranscript("user", heard);
      callbacks.onActivity();
      this.history.push({ role: "user", content: heard });

      /* ------------------------- think and speak -------------------------- */

      // TTS settles by callback, not by turn method returns; one promise per
      // turn so "wait until every byte arrived" is awaitable below.
      let settleTts!: { resolve: () => void; reject: (err: Error) => void };
      const ttsDone = new Promise<void>((resolve, reject) => {
        settleTts = { resolve, reject };
      });
      ttsDone.catch(() => undefined); // pre-attach: rejection may race the loop

      // The socket opens WHILE the model thinks — by the first text delta
      // the provider is usually ready and speech starts mid-first-sentence.
      const ttsReady = this.opts.tts.speak({
        onAudio: (audio) => {
          if (!this.live(generation)) return;
          // Advance the playback clock by this chunk's duration — the
          // renderer schedules chunks back-to-back, so main's estimate of
          // "the speakers are saying our words until T" stays honest.
          const chunkMs =
            (audio.byteLength / 2 / VOICE_OUTPUT_SAMPLE_RATE) * 1_000;
          this.speakingUntil =
            Math.max(this.speakingUntil, Date.now()) + chunkMs;
          callbacks.onAudio(audio);
          callbacks.onActivity();
        },
        onDone: () => settleTts.resolve(),
        onError: (message) => settleTts.reject(new Error(message)),
      });
      ttsReady.catch(() => undefined);

      stage = "agent";
      console.log(`suma voice: running agent turn via ${this.opts.model}`);
      const result = streamText({
        model: this.opts.gateway.languageModel(this.opts.model),
        system: this.opts.systemInstruction,
        messages: [...this.history],
        tools: this.opts.tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: controller.signal,
      });

      stage = "speech connect";
      ttsTurn = await ttsReady;
      stage = "agent";
      if (!this.live(generation)) {
        ttsTurn.cancel();
        return;
      }

      // The agent runs at tool speed, the voice at talking speed. Sentences
      // are held in the narration queue and pumped to the TTS one at a
      // time, each as the previous one finishes playing — at which moment
      // anything the intervening tool calls made stale is dropped instead
      // of narrating a past the user already watched happen.
      const narration = new NarrationQueue();
      let spoken = "";
      // Tool calls since the voice last said anything — the narrator's raw
      // material, and the ack's trigger. Any speech resets the window.
      let unspokenEvents: string[] = [];
      let narratorInFlight = false;
      let streamDone = false;
      const speakSegment = (text: string): void => {
        spoken = spoken === "" ? text : `${spoken} ${text}`;
        unspokenEvents = [];
        ttsTurn?.speakStatement(text);
        callbacks.onTranscript("assistant", spoken);
      };
      const logDropped = (dropped: string[]): void => {
        for (const text of dropped) {
          console.log(`suma voice: skipping stale narration ${JSON.stringify(text)}`);
        }
      };
      // Guaranteed acknowledgment: prompt-based narration is model-dependent
      // (thinking-heavy models run a dozen tools without a word), so if the
      // agent has said nothing by its first tool call — or by the deadline —
      // a canned phrase goes out. The wake word must never feel ignored.
      const maybeAck = (): void => {
        if (!this.live(generation) || streamDone) return;
        if (spoken !== "" || narration.pending > 0) return;
        const phrase =
          VOICE_ACK_PHRASES[this.ackCount++ % VOICE_ACK_PHRASES.length]!;
        console.log(`suma voice: acknowledging silently-working model ("${phrase}")`);
        speakSegment(phrase);
      };
      const ackTimer = setTimeout(maybeAck, ACK_DEADLINE_MS);
      // The narrator: with the voice idle, nothing queued, and several tool
      // calls unaccounted for, an ultra-fast model turns those events into
      // one spoken status line. Fire-and-forget with a hard deadline — by
      // the time a slow narrator answers, its line is about the past.
      const maybeNarrate = (): void => {
        if (this.narratorBroken || narratorInFlight || streamDone) return;
        if (unspokenEvents.length < NARRATOR_MIN_EVENTS) return;
        narratorInFlight = true;
        const events = [...unspokenEvents];
        void generateText({
          model: this.opts.gateway.languageModel(this.opts.narratorModel),
          prompt: narratorPrompt({ userRequest: heard, spoken, events }),
          // Generous on purpose: a thinking-tuned narrator reasons BEFORE
          // its SAY line, and a cap that lands mid-reasoning produced a
          // reply that was ALL reasoning. The parser keeps only the SAY
          // line, so the extra budget costs pennies, not correctness.
          maxOutputTokens: 800,
          abortSignal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(NARRATOR_TIMEOUT_MS),
          ]),
        })
          .then((update) => {
            narratorInFlight = false;
            if (!this.live(generation) || streamDone) return;
            // Real model text always outranks the narrator.
            if (narration.pending > 0) return;
            const line = parseNarratorReply(update.text);
            if (line === null) {
              console.log(
                `suma voice: narrator reply unusable — skipped (${JSON.stringify(update.text.slice(0, 200))})`,
              );
              return;
            }
            console.log(`suma voice: narrator: ${JSON.stringify(line)}`);
            speakSegment(line);
          })
          .catch((err: unknown) => {
            narratorInFlight = false;
            if (controller.signal.aborted) return;
            // A timeout is a slow moment, not a broken narrator — the next
            // gap gets another chance. Real errors (bad model id, auth)
            // would repeat forever, so they disable it for the session.
            const name = err instanceof Error ? err.name : "";
            if (name === "TimeoutError" || name === "AbortError") {
              console.log("suma voice: narrator missed its window (timeout)");
              return;
            }
            this.narratorBroken = true;
            console.error(
              "suma voice: narrator failed (disabled for this session):",
              err,
            );
          });
      };
      const pump = (): void => {
        if (!this.live(generation)) return;
        if (Date.now() < this.speakingUntil - SPEECH_LEAD_MS) return;
        const { segment, dropped } = narration.takeNext();
        logDropped(dropped);
        if (segment !== null) speakSegment(segment.text);
        else maybeNarrate();
      };
      const pumpTimer = setInterval(pump, SPEECH_PUMP_MS);

      try {
        for await (const part of result.fullStream) {
          if (!this.live(generation)) return;
          switch (part.type) {
            case "text-delta":
              narration.pushDelta(part.text);
              break;
            case "tool-call":
              console.log(`suma voice: tool ${part.toolName} called`);
              narration.noteToolCall();
              unspokenEvents.push(narratorEvent(part.toolName, part.input));
              maybeAck();
              callbacks.onActivity();
              break;
            case "error":
              throw part.error instanceof Error
                ? part.error
                : new Error(String(part.error));
            default:
              break;
          }
        }
      } finally {
        streamDone = true;
        clearTimeout(ackTimer);
        clearInterval(pumpTimer);
      }
      if (!this.live(generation)) return;

      // Run over: the remaining fresh sentences ARE the answer — spoken as
      // ONE statement (gapless prosody beats pacing now that nothing can
      // go stale under them).
      narration.finish();
      const { segments, dropped } = narration.drain();
      logDropped(dropped);
      if (segments.length > 0) {
        speakSegment(segments.map((segment) => segment.text).join(" "));
      }

      // The conversation's memory: the SDK's own response messages, tool
      // calls and results included, exactly as the chat sidebar would keep
      // them — "the second link" has an antecedent next turn.
      this.history.push(...(await result.response).messages);

      if (spoken === "") {
        // A tool-only turn with no words; nothing to synthesize.
        console.log("suma voice: turn produced no text — nothing to speak");
        ttsTurn.cancel();
        return;
      }
      stage = "speech";
      console.log(
        `suma voice: reply spoken (${String(spoken.length)} chars), finishing speech`,
      );
      ttsTurn.finish();
      const timeout = setTimeout(() => {
        settleTts.reject(new Error("the speech service stalled mid-reply"));
        ttsTurn?.cancel();
      }, TTS_FINISH_TIMEOUT_MS);
      try {
        await ttsDone;
      } finally {
        clearTimeout(timeout);
      }
      console.log("suma voice: turn complete");
      callbacks.onActivity();
    } catch (err) {
      ttsTurn?.cancel();
      // An abort is a barge-in or teardown, already handled by whoever
      // aborted; anything else ends the session with a reason on screen.
      if (controller.signal.aborted || !this.live(generation)) return;
      // The full error (stack, response body, cause chain) belongs in the
      // terminal; the HUD line gets the stage + message.
      console.error(`suma voice: turn failed during ${stage}:`, err);
      this.closed = true;
      const detail = err instanceof Error ? err.message : String(err);
      callbacks.onClosed(`${stage} failed: ${detail}`);
    } finally {
      // A turn that lost its liveness mid-flight (barge-in, teardown)
      // returns from anywhere above — its speech socket must not linger.
      if (!this.live(generation)) ttsTurn?.cancel();
      if (this.turn?.generation === generation) this.turn = null;
    }
  }
}
