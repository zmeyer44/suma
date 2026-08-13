/**
 * Voice assistant audio I/O — the renderer half of the voice pipeline.
 *
 * This runs in the OVERLAY surface (the floating view that hosts the audio
 * player), which is always alive and layered above the pages: main cannot
 * touch a microphone or a speaker, so the HUD does, and ships raw PCM over
 * IPC in both directions (shared/voice.ts spells the formats).
 *
 * Capture: getUserMedia → a 16 kHz AudioContext (Chromium resamples the mic
 * for us) → a ScriptProcessorNode delivering ~128 ms Float32 blocks →
 * PCM16 bytes → `voice:audio`. ScriptProcessor is deprecated but chosen
 * deliberately: an AudioWorklet needs its module fetched by URL, which
 * drags the chrome CSP and the dev-server asset story into what is a
 * fixed 8-invokes-per-second pipe; the deprecated node does this job with
 * zero moving parts. Revisit if Chromium ever actually removes it.
 *
 * Playback: reply chunks are 24 kHz PCM16. Each becomes an AudioBuffer
 * scheduled back-to-back on a cursor (`nextStartTime`), which turns the
 * chunk stream into gapless speech; a barge-in flush stops every scheduled
 * source and resets the cursor.
 */

import { VOICE_INPUT_SAMPLE_RATE, VOICE_OUTPUT_SAMPLE_RATE } from "../../../shared/voice";

/** ~128 ms at 16 kHz — the IPC frame size (and the wake-word feed size). */
const CAPTURE_BLOCK_SIZE = 2048;

export class VoiceCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private starting = false;

  get running(): boolean {
    return this.context !== null || this.starting;
  }

  /** Idempotent. Rejects when the mic is denied — the caller surfaces it. */
  async start(onFrame: (pcm: Uint8Array) => void): Promise<void> {
    if (this.running) return;
    this.starting = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true, // the assistant must not wake itself
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      // A stop() that raced the permission prompt wins.
      if (!this.starting) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const context = new AudioContext({ sampleRate: VOICE_INPUT_SAMPLE_RATE });
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(CAPTURE_BLOCK_SIZE, 1, 1);
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        const pcm = new Uint8Array(samples.length * 2);
        const view = new DataView(pcm.buffer);
        for (let i = 0; i < samples.length; i++) {
          const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
          view.setInt16(i * 2, Math.round(clamped * 32767), true);
        }
        onFrame(pcm);
      };
      source.connect(processor);
      // A ScriptProcessor only pulls while connected to the destination; the
      // zero gain keeps the mic out of the speakers.
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(context.destination);

      this.stream = stream;
      this.context = context;
      this.processor = processor;
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.starting = false;
    if (this.processor !== null) this.processor.onaudioprocess = null;
    this.processor = null;
    if (this.stream !== null) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
    if (this.context !== null) void this.context.close().catch(() => undefined);
    this.context = null;
  }
}

export class VoicePlayback {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private readonly scheduled = new Set<AudioBufferSourceNode>();
  /** Fires on every busy/idle flip — the HUD's "speaking" indicator. */
  onSpeakingChange: ((speaking: boolean) => void) | null = null;

  get speaking(): boolean {
    return this.scheduled.size > 0;
  }

  /** Schedule one PCM16 chunk right after whatever is already queued. */
  play(pcm: Uint8Array): void {
    if (pcm.byteLength < 2) return;
    if (this.context === null) {
      this.context = new AudioContext({ sampleRate: VOICE_OUTPUT_SAMPLE_RATE });
      this.nextStartTime = 0;
    }
    const context = this.context;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const samples = new Float32Array(Math.floor(pcm.byteLength / 2));
    for (let i = 0; i < samples.length; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }
    const buffer = context.createBuffer(1, samples.length, VOICE_OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const wasSpeaking = this.speaking;
    this.scheduled.add(source);
    source.onended = () => {
      this.scheduled.delete(source);
      if (!this.speaking) this.onSpeakingChange?.(false);
    };
    const startAt = Math.max(context.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    if (!wasSpeaking) this.onSpeakingChange?.(true);
  }

  /** Barge-in (or session end): silence everything scheduled, immediately. */
  flush(): void {
    for (const source of [...this.scheduled]) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
    this.scheduled.clear();
    this.nextStartTime = 0;
    this.onSpeakingChange?.(false);
  }

  dispose(): void {
    this.flush();
    if (this.context !== null) void this.context.close().catch(() => undefined);
    this.context = null;
  }
}
