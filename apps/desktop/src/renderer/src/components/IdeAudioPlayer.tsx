/**
 * The IDE editor pane's audio view (suma://terminal) — what an .mp3 or .wav
 * opens as, the way an image opens as a picture.
 *
 * Deliberately NOT the floating player (AudioPlayer.tsx): that one is the
 * chrome's single audio engine, playing TTS and page audio ACROSS whatever you
 * browse to next. This is a file you are looking at in an editor tab, so it
 * behaves like one — playback belongs to the open tab and stops when the tab
 * does. The two can play at once; they are different sounds from different
 * places.
 *
 * The <audio> element streams suma-workspace:// (main/workspace-media.ts)
 * rather than holding the track in memory, so seeking is a Range request and
 * a 90-minute file costs no more to open than a 30-second one.
 */

import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceFile } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import { formatBytes, formatTime } from "../lib/format";
import { Slider } from "./ui/slider";

/** "audio/mpeg" → "MP3": the format, in the words a file browser would use. */
const FORMAT_LABELS: Readonly<Record<string, string>> = {
  "audio/mpeg": "MP3",
  "audio/mp4": "M4A",
  "audio/wav": "WAV",
  "audio/flac": "FLAC",
  "audio/ogg": "OGG",
  "audio/aac": "AAC",
};

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function IdeAudioPlayer({
  file,
}: {
  file: Extract<WorkspaceFile, { kind: "audio" }>;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  /** While the thumb is held the slider shows the DRAFT, not playback. */
  const [scrub, setScrub] = useState<number | null>(null);

  // Switching editor tabs unmounts this component, which stops playback. The
  // element is keyed on the path by the caller, so a new file is a new element
  // rather than a src swap mid-play.
  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    setFailed(false);
  }, [file.url]);

  const toggle = (): void => {
    const el = audioRef.current;
    if (el === null) return;
    if (el.paused) void el.play().catch(() => setFailed(true));
    else el.pause();
  };

  const seekable = duration > 0;
  const sliderValue = scrub ?? position;

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-panel p-4">
        <audio
          ref={audioRef}
          src={file.url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onDurationChange={(e) =>
            setDuration(
              Number.isFinite(e.currentTarget.duration)
                ? e.currentTarget.duration
                : 0,
            )
          }
          onError={() => setFailed(true)}
        />

        <p className="truncate text-[13px] text-text" title={file.path}>
          {basename(file.path)}
        </p>
        <p className="mt-0.5 text-[11px] text-faint">
          {[
            FORMAT_LABELS[file.mime] ?? file.mime,
            formatBytes(file.bytes),
          ].join(" · ")}
        </p>

        {failed ? (
          <p className="mt-3 text-[12px] text-warn">
            This file could not be played — the format may not be supported.
          </p>
        ) : (
          <>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                aria-label={playing ? "Pause" : "Play"}
                onClick={toggle}
                className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-accent text-white hover:opacity-90"
              >
                {playing ? (
                  <Pause className="size-3.5 fill-current" aria-hidden="true" />
                ) : (
                  // Optical centering: a triangle's mass sits left of its box.
                  <Play
                    className="size-3.5 translate-x-px fill-current"
                    aria-hidden="true"
                  />
                )}
              </button>
              <Slider
                min={0}
                max={seekable ? duration : 1}
                step={0.05}
                value={Math.min(sliderValue, seekable ? duration : 1)}
                disabled={!seekable}
                aria-label="Playback position"
                onValueChange={(next) => setScrub(next)}
                onValueCommitted={(next) => {
                  const el = audioRef.current;
                  if (el !== null) el.currentTime = next;
                  setPosition(next);
                  setScrub(null);
                }}
                className="min-w-0 flex-1"
              />
              <button
                type="button"
                aria-label={muted ? "Unmute" : "Mute"}
                onClick={() => {
                  const el = audioRef.current;
                  if (el === null) return;
                  el.muted = !el.muted;
                  setMuted(el.muted);
                }}
                className={cn(
                  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-md hover:bg-ink/8",
                  muted ? "text-text" : "text-muted",
                )}
              >
                {muted ? (
                  <VolumeX className="size-3.5" aria-hidden="true" />
                ) : (
                  <Volume2 className="size-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
            <div className="mt-1 flex justify-between text-[11px] tabular-nums text-faint">
              <span>{formatTime(position)}</span>
              <span>{seekable ? formatTime(duration) : "--:--"}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
