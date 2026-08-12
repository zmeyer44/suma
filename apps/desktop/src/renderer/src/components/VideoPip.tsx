/**
 * The floating video player — the page rendered inside the PIP
 * WebContentsView (shell-window.ts, `#video-pip`), layered above the tab
 * views so a saved video keeps playing while the user browses.
 *
 * Unlike the floating audio player this view OWNS playback: the <video>
 * element lives here (streaming suma-video:// from main's media cache), so
 * there is no relay — main only pushes WHAT to play (`videoPip:state`) and
 * this component reports the resume position and the close.
 *
 * Geometry is main's: the view is sized/positioned by ShellWindow, and this
 * page fills it edge-to-edge (the view swallows clicks over its whole rect,
 * which is exactly the video's rect). Dragging works by telling main where
 * the grab started (`videoPip:dragStart`) and when it ended — main follows
 * the cursor itself, because pointer events stop reaching this document the
 * moment the cursor outruns the moving view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  Pause,
  Play,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  EMPTY_PIP_STATE,
  type VideoPipCommand,
  type VideoPipState,
} from "../../../shared/videos";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";

/** How often the resume position goes to main while playing. */
const POSITION_REPORT_MS = 2_000;

const RATES = [1, 1.25, 1.5, 1.75, 2] as const;

function send(command: VideoPipCommand): void {
  if (!window.suma) return;
  void window.suma.invoke("videoPip:control", command).catch(() => undefined);
}

export function VideoPip() {
  const [state, setState] = useState<VideoPipState>(EMPTY_PIP_STATE);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState<number>(1);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [draft, setDraft] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** The load the current <video> element belongs to, for stale seeks. */
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!window.suma) return;
    const suma = window.suma;
    const off = suma.on("videoPip:state", setState);
    void suma
      .invoke("videoPip:requestState", undefined)
      .then(setState)
      .catch(() => undefined);
    return off;
  }, []);

  // Report the resume point while playing, so a closed app remembers.
  useEffect(() => {
    if (!playing || state.videoId === null) return;
    const timer = window.setInterval(() => {
      const el = videoRef.current;
      if (el !== null) send({ command: "position", value: el.currentTime });
    }, POSITION_REPORT_MS);
    return () => window.clearInterval(timer);
  }, [playing, state.videoId]);

  const onLoadedMetadata = useCallback(() => {
    const el = videoRef.current;
    if (el === null) return;
    setDuration(el.duration);
    // Resume where the user left off — but only on this video's first load.
    if (loadedFor.current !== state.videoId) {
      loadedFor.current = state.videoId;
      if (state.position > 1 && state.position < el.duration - 5) {
        el.currentTime = state.position;
      }
    }
  }, [state.videoId, state.position]);

  const beginDrag = (e: React.PointerEvent): void => {
    if (e.button !== 0 || !window.suma) return;
    // Controls handle their own pointers; a drag starts on the video itself.
    void window.suma
      .invoke("videoPip:dragStart", { x: e.clientX, y: e.clientY })
      .catch(() => undefined);
    const end = (): void => {
      window.removeEventListener("pointerup", end);
      void window.suma.invoke("videoPip:pointerEnd", undefined).catch(() => undefined);
    };
    window.addEventListener("pointerup", end);
  };

  const beginResize = (e: React.PointerEvent): void => {
    if (e.button !== 0 || !window.suma) return;
    e.stopPropagation();
    void window.suma.invoke("videoPip:resizeStart", undefined).catch(() => undefined);
    const end = (): void => {
      window.removeEventListener("pointerup", end);
      void window.suma.invoke("videoPip:pointerEnd", undefined).catch(() => undefined);
    };
    window.addEventListener("pointerup", end);
  };

  if (state.videoId === null || state.mediaUrl === null) {
    // Hidden view — render nothing (the view itself is off screen).
    return null;
  }

  const togglePlayback = (): void => {
    const el = videoRef.current;
    if (el === null) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };

  const shownPosition = draft ?? position;

  return (
    <div
      className="group relative h-full w-full overflow-hidden rounded-xl border border-ink/15 bg-black"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {/* The video is the drag surface: grab anywhere, the window follows. */}
      <video
        ref={videoRef}
        src={state.mediaUrl}
        autoPlay
        muted={muted}
        className="h-full w-full cursor-grab object-contain active:cursor-grabbing"
        onPointerDown={beginDrag}
        onClick={(e) => {
          // A plain click toggles playback — but not the tail of a drag.
          if (e.detail === 1) togglePlayback();
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => send({ command: "close", ended: true })}
        onTimeUpdate={(e) => {
          if (draft === null) setPosition(e.currentTarget.currentTime);
        }}
        onLoadedMetadata={onLoadedMetadata}
        onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
      />

      {/* Top bar: title + open-in-tab + close. Hover-only, like AVKit. */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 flex items-center gap-1 bg-gradient-to-b from-black/70 to-transparent px-2 pt-1.5 pb-4 transition-opacity",
          hovered ? "opacity-100" : "opacity-0",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-white/90">
          {state.title}
          {state.author !== null ? (
            <span className="text-white/55"> — {state.author}</span>
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="icon"
          title="Open original page"
          aria-label="Open original page"
          onClick={() => send({ command: "openSource" })}
          className="text-white/80 hover:bg-white/15 hover:text-white"
        >
          <ExternalLink className="size-3" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Close player"
          aria-label="Close player"
          onClick={() => send({ command: "close" })}
          className="text-white/80 hover:bg-white/15 hover:text-white"
        >
          <X className="size-3" aria-hidden="true" />
        </Button>
      </div>

      {/* Bottom transport: play, scrub, time, speed, mute. Hover-only. */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/75 to-transparent px-2 pt-4 pb-1.5 transition-opacity",
          hovered ? "opacity-100" : "opacity-0",
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={togglePlayback}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
          className="text-white hover:bg-white/15"
        >
          {playing ? (
            <Pause className="size-3.5" fill="currentColor" aria-hidden="true" />
          ) : (
            <Play className="size-3.5" fill="currentColor" aria-hidden="true" />
          )}
        </Button>
        <Slider
          min={0}
          max={duration > 0 ? duration : 1}
          step={0.05}
          value={Math.min(shownPosition, duration > 0 ? duration : 1)}
          disabled={duration <= 0}
          aria-label="Playback position"
          onValueChange={(next) => setDraft(next)}
          onValueCommitted={(next) => {
            const el = videoRef.current;
            if (el !== null) el.currentTime = next;
            setPosition(next);
            setDraft(null);
            send({ command: "position", value: next });
          }}
          className="min-w-0 flex-1"
        />
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-white/70">
          {formatTime(shownPosition)}
          {duration > 0 ? ` / ${formatTime(duration)}` : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const el = videoRef.current;
            if (el === null) return;
            const at = RATES.indexOf(rate as (typeof RATES)[number]);
            el.playbackRate = RATES[(at + 1) % RATES.length] ?? 1;
          }}
          aria-label={`Playback speed ${String(rate)}x`}
          title="Playback speed"
          className="w-8 px-0 font-mono text-[10px] tabular-nums text-white/80 hover:bg-white/15"
        >
          {`${String(rate)}x`}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
          className="text-white/80 hover:bg-white/15"
        >
          {muted ? (
            <VolumeX className="size-3" aria-hidden="true" />
          ) : (
            <Volume2 className="size-3" aria-hidden="true" />
          )}
        </Button>
      </div>

      {/* Bottom-right resize grip — aspect-locked, cursor-followed by main. */}
      <div
        role="presentation"
        title="Drag to resize"
        onPointerDown={beginResize}
        className={cn(
          "absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize transition-opacity",
          hovered ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="absolute right-1 bottom-1 size-2 rounded-br border-r-2 border-b-2 border-white/60" />
      </div>
    </div>
  );
}
