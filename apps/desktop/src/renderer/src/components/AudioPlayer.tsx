/**
 * The floating audio player — the compact, top-right control surface for the
 * chrome's audio engine (lib/audio.ts), rendered inside the transparent
 * overlay VIEW (OverlayStack.tsx / shell-window.ts), never in the chrome.
 *
 * Why here: the chrome renders BELOW the tab views, so any player drawn
 * there is invisible the moment a page is open. This view is layered above
 * every page, which is exactly what "playback keeps going while you browse"
 * needs from its controls. The price is distance: the audio element lives in
 * the chrome renderer, so this component renders a relayed snapshot
 * (`audioOverlay:state`) and answers with commands (`audioOverlay:control`)
 * — it holds no playback state of its own.
 *
 * Like a PiP video, the player can be tucked away: the chevron collapses the
 * card to a small pill hugging the same corner, and tapping the pill brings
 * the card back. Hiding never touches playback, and a fresh playback session
 * (idle → active) un-tucks it so new audio is never invisibly playing.
 * Both card and pill live in permanently-mounted grid cells that animate
 * 0fr↔1fr — the same mechanism as the save-preview cards below it, so the
 * stack always slides, never jumps.
 */

import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  ChevronsLeft,
  ChevronsRight,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { AudioOverlayCommand, AudioOverlayState } from "../../../shared/ipc";
import { speedLabel, TTS_SPEEDS } from "../../../shared/tts";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";

function send(command: AudioOverlayCommand): void {
  if (!window.suma) return;
  void window.suma.invoke("audioOverlay:control", command).catch(() => undefined);
}

/**
 * The scrubber. While the thumb is held, the slider shows the DRAFT position
 * and relayed timeupdates are ignored — otherwise every frame of playback
 * fights the drag and the thumb snaps backwards under the pointer. The seek
 * itself is a command; the new position comes back as state.
 *
 * `onValueCommitted` is what ends the drag: it fires once the pointer is
 * released (and on a keyboard step, and on a track press), which is precisely
 * when a scrub should become a seek.
 */
function Scrubber({ position, duration }: { position: number; duration: number }) {
  const [draft, setDraft] = useState<number | null>(null);

  const seekable = duration > 0;
  const value = draft ?? position;

  return (
    <Slider
      min={0}
      max={seekable ? duration : 1}
      step={0.05}
      value={Math.min(value, seekable ? duration : 1)}
      disabled={!seekable}
      aria-label="Playback position"
      onValueChange={(next) => setDraft(next)}
      onValueCommitted={(next) => {
        send({ command: "seek", value: next });
        setDraft(null);
      }}
      className="min-w-0 flex-1"
    />
  );
}

function statusNote(state: AudioOverlayState): string | null {
  if (state.status === "preparing") return "Generating speech…";
  if (state.status === "error") return state.error ?? "Playback failed.";
  return null;
}

/**
 * One permanently-mounted cell of the floating stack. `open` drives a grid
 * 0fr↔1fr transition on BOTH axes — the same mechanism as the save-preview
 * cards, plus a horizontal collapse so a closed card stops holding the
 * w-fit glass panel at card width around the lone pill (styles.css,
 * .player-cell). `inert` keeps the collapsed half's controls out of reach
 * while it is folded away.
 */
function PlayerCell({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div inert={!open} className={cn("player-cell", open && "player-cell-open")}>
      {/* data-overlay-item lives HERE, on the clipping wrapper, because its
          rect is what actually collapses — the content inside keeps its
          full layout size under overflow-hidden (OverlayStack reads
          visibility off these). */}
      <div
        data-overlay-item
        className="flex min-h-0 min-w-0 flex-col items-end overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}

export function FloatingAudioPlayer() {
  /** The live snapshot — `active` (and so the open/closed cells) reads this. */
  const [state, setState] = useState<AudioOverlayState | null>(null);
  /**
   * The last snapshot that HELD a track — what the card renders. Stopping
   * nulls the live track instantly, and a card that empties before its cell
   * finishes collapsing pops instead of sliding away.
   */
  const [display, setDisplay] = useState<AudioOverlayState | null>(null);
  /** PiP-style tuck: true ⇒ only the pill shows. Playback is untouched. */
  const [hidden, setHidden] = useState(false);
  /** Whether the last snapshot was active, to un-tuck on a fresh session. */
  const wasActive = useRef(false);

  useEffect(() => {
    if (!window.suma) return;
    const suma = window.suma;
    const apply = (next: AudioOverlayState): void => {
      const nowActive = next.status !== "idle" && next.track !== null;
      // A fresh playback session un-tucks the player: audio the user just
      // started must never be invisibly playing behind a pill.
      if (nowActive && !wasActive.current) setHidden(false);
      wasActive.current = nowActive;
      setState(next);
      if (next.track !== null) setDisplay(next);
    };
    const off = suma.on("audioOverlay:state", apply);
    // Pushes sent before this window mounted are gone — pull the snapshot
    // main cached. A live push that raced ahead of the reply wins.
    void suma
      .invoke("audioOverlay:requestState", undefined)
      .then((cached) => {
        if (cached !== null && wasActive.current === false) apply(cached);
      })
      .catch(() => undefined);
    return off;
  }, []);

  const active =
    state !== null && state.status !== "idle" && state.track !== null;
  const track = display?.track ?? null;

  if (display === null || track === null) {
    // Nothing to show and nothing to animate from — render the closed cells
    // so activation transitions instead of popping.
    return (
      <>
        <PlayerCell open={false}>{null}</PlayerCell>
        <PlayerCell open={false}>{null}</PlayerCell>
      </>
    );
  }

  const playing = display.status === "playing";
  const busy = display.status === "preparing";
  const note = statusNote(display);
  const subtitleParts = [track.origin, track.voiceLabel].filter(
    (part): part is string => part !== null && part !== "",
  );
  const queueTag =
    display.queueLength > 1
      ? `${String(display.index + 1)} of ${String(display.queueLength)}`
      : null;
  const subtitle =
    note ?? [...subtitleParts, ...(queueTag === null ? [] : [queueTag])].join(" · ");

  const cardOpen = active && !hidden;
  const pillOpen = active && hidden;

  return (
    <>
      <PlayerCell open={cardOpen}>
        <div
          data-overlay-item
          // A ROW of the shared glass panel (OverlayStack), not a card of
          // its own: the panel's frost and border carry the surface, so
          // this contributes only its content and the slide-in transform.
          className={cn(
            "save-preview-card w-80 p-2.5",
            cardOpen ? "save-preview-card-in" : "save-preview-card-out",
          )}
        >
          <div className="flex items-center gap-2.5">
            <Button
              variant="soft"
              size="icon"
              onClick={() => send({ command: "toggle" })}
              disabled={busy}
              aria-label={playing ? "Pause" : "Play"}
              title={playing ? "Pause" : "Play"}
              className="size-9 rounded-lg"
            >
              {busy ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : playing ? (
                <Pause className="size-4" fill="currentColor" aria-hidden="true" />
              ) : (
                <Play className="size-4" fill="currentColor" aria-hidden="true" />
              )}
            </Button>

            <span className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
              <span className="truncate text-[12px] font-medium text-text">
                {track.title}
              </span>
              {subtitle === "" ? null : (
                <span
                  className={cn(
                    "truncate text-[10px]",
                    display.status === "error" ? "text-danger" : "text-faint",
                  )}
                >
                  {subtitle}
                </span>
              )}
            </span>

            <span className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => send({ command: "previous" })}
                aria-label="Previous"
                title="Previous"
              >
                <SkipBack className="size-3" fill="currentColor" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => send({ command: "next" })}
                disabled={display.index + 1 >= display.queueLength}
                aria-label="Next"
                title="Next"
              >
                <SkipForward className="size-3" fill="currentColor" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => send({ command: "stop" })}
                aria-label="Stop"
                title="Stop"
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </span>
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <Scrubber position={display.position} duration={display.duration} />
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">
              {formatTime(display.position)}
              {display.duration > 0 ? ` / ${formatTime(display.duration)}` : ""}
            </span>
            {/* Cycles rather than opens a menu: a control the size of two
                characters should cost one click; the default lives in
                Settings. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const at = TTS_SPEEDS.indexOf(display.rate);
                send({
                  command: "setRate",
                  value: TTS_SPEEDS[(at + 1) % TTS_SPEEDS.length] ?? 1,
                });
              }}
              aria-label={`Playback speed ${speedLabel(display.rate)}`}
              title="Playback speed"
              className="w-8 px-0 font-mono tabular-nums"
            >
              {speedLabel(display.rate)}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => send({ command: "setMuted", value: !display.muted })}
              aria-label={display.muted ? "Unmute" : "Mute"}
              title={display.muted ? "Unmute" : "Mute"}
            >
              {display.muted ? (
                <VolumeX className="size-3" aria-hidden="true" />
              ) : (
                <Volume2 className="size-3" aria-hidden="true" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => send({ command: "openVoiceSettings" })}
              aria-label="Voice & audio settings"
              title="Voice & audio settings"
            >
              <Mic className="size-3" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setHidden(true)}
              aria-label="Hide player"
              title="Hide player"
            >
              <ChevronsRight className="size-3" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </PlayerCell>

      <PlayerCell open={pillOpen}>
        <button
          type="button"
          data-overlay-item
          onClick={() => setHidden(false)}
          aria-label={`Show audio player — ${track.title}`}
          title={track.title}
          className={cn(
            // The glass panel shrinks to this row when it is the only
            // content, so the pill needs no capsule of its own — the
            // window-fitted panel IS the chip.
            "save-preview-card flex h-8 cursor-pointer items-center gap-1.5 px-3 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 hover:bg-ink/8",
            pillOpen ? "save-preview-card-in" : "save-preview-card-out",
          )}
        >
          <ChevronsLeft className="size-3.5 text-muted" aria-hidden="true" />
          <AudioLines
            className={cn("size-3.5", playing ? "text-accent" : "text-muted")}
            aria-hidden="true"
          />
        </button>
      </PlayerCell>
    </>
  );
}
