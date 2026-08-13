/**
 * The voice assistant HUD — the "Suma is listening" surface, rendered as a
 * row of the floating overlay panel (OverlayStack), above every page.
 *
 * This component is more than a display: it OWNS the microphone and the
 * speakers for the whole feature (lib/voice-audio.ts). Main runs the wake
 * word and the live model, but only a renderer can capture audio — so while
 * the assistant is enabled, this row captures mic frames and ships them
 * inward over `voice:audio`, and schedules the reply chunks that come back
 * as `voice:audioOut`. The overlay view is the right owner because it is
 * always alive (the audio player pattern) and always visible above pages —
 * a listening indicator that can hide behind a tab would be a microphone
 * the user forgot about.
 *
 * Three looks, by phase:
 *   listening  → a slim pill: mic mark + "Suma" (tap = start talking)
 *   connecting → the pill, busy
 *   active     → a card: live captions, speaking indicator, end button
 * Phase "off" renders nothing (and the mic is released).
 */

import { useEffect, useState } from "react";
import { AudioLines, LoaderCircle, Mic, X } from "lucide-react";
import type { VoiceSettingsInfo, VoiceStatus } from "../../../shared/voice";
import { cn } from "../lib/cn";
import { VoiceCapture, VoicePlayback } from "../lib/voice-audio";
import { Button } from "./ui/button";

/** The capture phases — mic open, frames flowing inward. */
function capturing(phase: VoiceStatus["phase"]): boolean {
  return phase === "listening" || phase === "connecting" || phase === "active";
}

export function VoiceHud() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [settings, setSettings] = useState<VoiceSettingsInfo | null>(null);
  const [captions, setCaptions] = useState<{ user: string; assistant: string }>({
    user: "",
    assistant: "",
  });
  const [speaking, setSpeaking] = useState(false);
  const [micError, setMicError] = useState(false);

  useEffect(() => {
    if (!window.suma) return;
    const suma = window.suma;
    const capture = new VoiceCapture();
    const playback = new VoicePlayback();
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
    };
  }, []);

  if (status === null || status.phase === "off") return null;

  const wakeWord = settings?.wakeWord ?? "suma";
  const wakeReady = status.wakeWord === "ready";
  const active = status.phase === "active";
  const busy = status.phase === "connecting";

  const start = (): void => {
    if (!window.suma) return;
    void window.suma.invoke("voice:start", undefined).catch(() => undefined);
  };
  const stop = (): void => {
    if (!window.suma) return;
    void window.suma.invoke("voice:stop", undefined).catch(() => undefined);
  };

  const pillLabel = micError
    ? "Microphone unavailable"
    : status.error !== null
      ? status.error
      : busy
        ? "Connecting…"
        : status.wakeWord === "downloading"
          ? "Preparing wake word…"
          : wakeReady
            ? `Say “${titleCase(wakeWord)}” or tap`
            : "Tap to talk (⌥Space)";

  // The caption the card leads with: the reply once there is one, otherwise
  // what the assistant heard so far.
  const caption =
    captions.assistant !== "" ? captions.assistant : captions.user;

  return (
    <div
      data-overlay-item
      className="flex min-h-0 min-w-0 flex-col items-end overflow-hidden"
    >
      {active ? (
        <div className="save-preview-card w-80 p-2.5">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-full",
                speaking ? "bg-accent/20 text-accent" : "bg-ink/10 text-text",
              )}
            >
              {speaking ? (
                <AudioLines className="size-4" aria-hidden />
              ) : (
                <Mic className="size-4 animate-pulse" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-text">
                {speaking ? "Suma is speaking" : "Suma is listening"}
              </div>
              <div className="truncate text-xs text-text/60">
                {caption === "" ? "Ask anything — I can work the browser." : caption}
              </div>
            </div>
            <Button
              variant="soft"
              size="icon"
              aria-label="End the voice conversation"
              onClick={stop}
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={busy}
          aria-label="Talk to Suma"
          className={cn(
            "flex max-w-72 items-center gap-2 px-3 py-2 text-left",
            "text-xs text-text/80 transition-colors hover:text-text",
          )}
        >
          {busy ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
          ) : (
            <Mic
              className={cn(
                "size-3.5 shrink-0",
                micError || status.error !== null ? "text-danger" : "text-accent",
              )}
              aria-hidden
            />
          )}
          <span className="truncate">{pillLabel}</span>
        </button>
      )}
    </div>
  );
}

function titleCase(phrase: string): string {
  return phrase
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
