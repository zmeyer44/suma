/**
 * The voice assistant's home: the TOP row of the tool rail (SideRail).
 *
 * This row replaced the floating overlay HUD (VoiceHud), and it inherits the
 * HUD's real job: it OWNS the microphone and the speakers for the whole
 * feature (lib/voice-audio.ts). Main runs the wake word and the live model,
 * but only a renderer can capture audio — while the assistant is enabled this
 * row ships mic frames inward over `voice:audio` and schedules the reply
 * chunks from `voice:audioOut`. The chrome document qualifies as the owner
 * for the same reasons the overlay did: it is always alive, and the rail
 * column sits OUTSIDE the content hole, so the listening indicator is always
 * visible — a mic the user can always see, never one they forgot about.
 *
 * The row is a four-bar visualizer sized to the collapsed rail, with one
 * mode per phase:
 *
 *   listening   → calm CSS breathing, muted — armed, nothing leaves the Mac
 *   connecting  → faster staggered wave, accent — waking up
 *   active      → LIVE bars, accent: an rAF loop reads 4 voice-frequency
 *                 bands off an AnalyserNode — the mic's while you speak, the
 *                 reply stream's while Suma speaks — and drives the bars by
 *                 mutating transforms directly, no React re-render per frame
 *   error       → static, danger
 *
 * Expanded (rail hover) the same row grows a status label — live captions
 * while the conversation runs — and the ⌥Space hint. Phase "off" renders
 * nothing; the rail starts at the AI chat row exactly as before.
 */

import { useEffect, useRef, useState } from "react";
import type { VoiceSettingsInfo, VoiceStatus } from "../../../shared/voice";
import { cn } from "../lib/cn";
import { VoiceCapture, VoicePlayback } from "../lib/voice-audio";

/** The capture phases — mic open, frames flowing inward. */
function capturing(phase: VoiceStatus["phase"]): boolean {
  return phase === "listening" || phase === "connecting" || phase === "active";
}

const BAR_COUNT = 4;

/** Voice-band edges (Hz) for the live bars — roughly pitch, vowel energy,
 *  consonant body, and sibilance, so speech moves all four differently. */
const BANDS: ReadonlyArray<readonly [number, number]> = [
  [85, 300],
  [300, 800],
  [800, 1800],
  [1800, 4500],
];

/** Band → bar position, center-weighted: the low band carries most speech
 *  energy, so it lands mid-row instead of pinning the leftmost bar. */
const BAR_BAND = [3, 1, 0, 2] as const;

/** Floor scale for a silent bar — a resting dot, never a vanished one. */
const BAR_FLOOR = 0.22;

function readBands(
  analyser: AnalyserNode,
  buf: Uint8Array<ArrayBuffer>,
  out: number[],
): void {
  analyser.getByteFrequencyData(buf);
  const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
  for (let b = 0; b < BANDS.length; b++) {
    const [lo, hi] = BANDS[b]!;
    const start = Math.max(1, Math.floor(lo / hzPerBin));
    const end = Math.min(buf.length, Math.ceil(hi / hzPerBin));
    let sum = 0;
    for (let i = start; i < end; i++) sum += buf[i]!;
    const avg = end > start ? sum / (end - start) / 255 : 0;
    // Gentle gain: conversational speech reaches full-scale bars without
    // requiring a shout.
    out[b] = Math.min(1, avg * 1.9);
  }
}

export function RailVoice({
  expanded,
  railWidth,
  slide,
}: {
  expanded: boolean;
  railWidth: number;
  slide: number;
}) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [settings, setSettings] = useState<VoiceSettingsInfo | null>(null);
  const [captions, setCaptions] = useState<{ user: string; assistant: string }>({
    user: "",
    assistant: "",
  });
  const [speaking, setSpeaking] = useState(false);
  const [micError, setMicError] = useState(false);

  const captureRef = useRef<VoiceCapture | null>(null);
  const playbackRef = useRef<VoicePlayback | null>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!window.suma) return;
    const suma = window.suma;
    const capture = new VoiceCapture();
    const playback = new VoicePlayback();
    captureRef.current = capture;
    playbackRef.current = playback;
    playback.onSpeakingChange = setSpeaking;

    const sendFrame = (pcm: Uint8Array): void => {
      void suma.invoke("voice:audio", { data: pcm }).catch(() => undefined);
    };

    const applyStatus = (next: VoiceStatus): void => {
      setStatus(next);
      if (capturing(next.phase)) {
        if (!capture.running) {
          capture.start(sendFrame).then(
            () => setMicError(false),
            () => setMicError(true),
          );
        }
      } else {
        capture.stop();
        playback.flush();
      }
      // A fresh conversation starts with clean captions.
      if (next.phase === "connecting") setCaptions({ user: "", assistant: "" });
      // Settings may have changed alongside (wake word phrase, enable) —
      // cheap refresh keyed off status pushes rather than a second channel.
      void suma
        .invoke("voice:settings", undefined)
        .then(setSettings)
        .catch(() => undefined);
    };

    const offStatus = suma.on("voice:statusChanged", applyStatus);
    const offTranscript = suma.on("voice:transcript", ({ role, text }) => {
      setCaptions((prev) => ({ ...prev, [role]: text }));
    });
    const offAudio = suma.on("voice:audioOut", ({ data }) => playback.play(data));
    const offInterrupted = suma.on("voice:interrupted", () => playback.flush());

    // Pull on mount — pushes sent before this surface existed are gone.
    void suma
      .invoke("voice:status", undefined)
      .then(applyStatus)
      .catch(() => undefined);

    return () => {
      offStatus();
      offTranscript();
      offAudio();
      offInterrupted();
      capture.stop();
      playback.dispose();
      captureRef.current = null;
      playbackRef.current = null;
    };
  }, []);

  const active = status?.phase === "active";

  // The live loop: only while a conversation runs. Bars are driven by
  // writing transforms straight onto the elements — 60 fps without touching
  // React. The source flips per frame: reply audio while it is playing
  // (echo cancellation mutes the mic of it anyway), the mic otherwise.
  useEffect(() => {
    if (!active) return;
    const bars = barRefs.current;
    const buf = new Uint8Array(128);
    const bands = [0, 0, 0, 0];
    const levels = [0, 0, 0, 0];
    let raf = 0;
    const step = (): void => {
      raf = requestAnimationFrame(step);
      const playback = playbackRef.current;
      const capture = captureRef.current;
      const analyser =
        playback !== null && playback.speaking && playback.analyser !== null
          ? playback.analyser
          : (capture?.analyser ?? null);
      if (analyser === null) return;
      readBands(analyser, buf, bands);
      for (let i = 0; i < BAR_COUNT; i++) {
        const target = bands[BAR_BAND[i]!]!;
        const current = levels[i]!;
        // Fast attack, slower release — bars snap up with speech and settle
        // down instead of flickering.
        levels[i] = current + (target - current) * (target > current ? 0.5 : 0.16);
        const bar = bars[i];
        if (bar !== null && bar !== undefined) {
          bar.style.transform = `scaleY(${BAR_FLOOR + (1 - BAR_FLOOR) * levels[i]!})`;
        }
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      // Back to resting dots — the CSS modes own the transform again.
      for (const bar of bars) {
        if (bar !== null && bar !== undefined) bar.style.transform = "";
      }
    };
  }, [active]);

  if (status === null || status.phase === "off") return null;

  const wakeWord = settings?.wakeWord ?? "suma";
  const wakeReady = status.wakeWord === "ready";
  const busy = status.phase === "connecting";
  const failed = micError || status.error !== null;

  const label = micError
    ? "Microphone unavailable"
    : status.error !== null
      ? status.error
      : busy
        ? "Connecting…"
        : active
          ? speaking
            ? "Suma is speaking"
            : captions.assistant !== "" || captions.user !== ""
              ? captions.assistant !== ""
                ? captions.assistant
                : captions.user
              : "Listening…"
          : status.wakeWord === "downloading"
            ? "Preparing wake word…"
            : wakeReady
              ? `Say “${titleCase(wakeWord)}” or tap`
              : "Tap to talk";

  const mode = failed ? "error" : active ? "live" : busy ? "connecting" : "idle";

  const toggle = (): void => {
    if (!window.suma || busy) return;
    void window.suma
      .invoke(active ? "voice:stop" : "voice:start", undefined)
      .catch(() => undefined);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={expanded ? undefined : label}
      aria-label={active ? "End the voice conversation" : "Talk to Suma"}
      className="group relative flex h-8 w-full cursor-pointer items-center outline-none disabled:cursor-default"
    >
      <span
        className="rail-pill pointer-events-none absolute inset-y-0 left-1 rounded-lg group-hover:bg-ink/8 group-focus-visible:bg-ink/8 group-focus-visible:ring-2 group-focus-visible:ring-accent/50"
        style={{ right: expanded ? 4 : slide + 4 }}
      />
      <span
        className={cn(
          "flex shrink-0 items-center justify-center transition-colors",
          mode === "error"
            ? "text-danger"
            : mode === "idle"
              ? "text-muted group-hover:text-text group-focus-visible:text-text"
              : "text-accent",
        )}
        style={{ width: railWidth }}
      >
        <span className="voice-bars flex h-4 items-center gap-[2.5px]" data-mode={mode}>
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <span
              key={i}
              ref={(el) => {
                barRefs.current[i] = el;
              }}
              className="voice-bar h-full w-[3px] rounded-full bg-current"
              style={{ "--bar": i } as React.CSSProperties}
            />
          ))}
        </span>
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left text-[12.5px] transition-colors",
          failed
            ? "text-danger"
            : active || busy
              ? "text-text"
              : "text-muted group-hover:text-text group-focus-visible:text-text",
        )}
      >
        {label}
      </span>
      <span className="shrink-0 pr-3.5 font-mono text-[10.5px] text-faint transition-colors group-hover:text-muted group-focus-visible:text-muted">
        ⌥Space
      </span>
    </button>
  );
}

function titleCase(phrase: string): string {
  return phrase
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
