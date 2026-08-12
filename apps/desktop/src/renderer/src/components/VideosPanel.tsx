/**
 * The Videos panel (⌘⇧V) — the saved-videos library, a right-edge sibling of
 * the Saves panel with the same content-hole mechanics (see SavesPanel.tsx /
 * ChatSidebar.tsx for the slide/resize choreography).
 *
 * A save is triggered three ways — double-tapping Shift on a YouTube/X video
 * page, right-clicking a video ("Save Video to Suma"), or this panel's
 * header button on the active tab — and every one lands here as a live card:
 * download progress, then cloud upload, then a playable item. Clicking a
 * ready card opens the floating PIP player (VideoPip.tsx) so the video plays
 * on while the user keeps browsing.
 */

import { useEffect, useRef, useState } from "react";
import {
  CloudOff,
  CloudUpload,
  Film,
  LoaderCircle,
  MonitorDown,
  Play,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  canonicalVideoUrl,
  matchesVideosQuery,
  type SavedVideo,
} from "../../../shared/videos";
import { cn } from "../lib/cn";
import { agoLabel, formatBytes, formatTime } from "../lib/format";
import {
  VIDEOS_DEFAULT_WIDTH,
  VIDEOS_MAX_WIDTH,
  VIDEOS_MIN_WIDTH,
} from "../lib/videos";
import { selectActiveTab, useSumaStore } from "../store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Marker, MarkerContent, MarkerIcon } from "./ui/marker";

/** Slide durations — MUST match `.chat-slide` in styles.css (shared class). */
const OPEN_MS = 220;
const CLOSE_MS = 160;

const KEY_STEP = 24;
const HANDLE_W = 7;

/** Same mechanism as the saves handle — see ChatSidebar.ResizeHandle for why
 *  `setPaneResizing` is load-bearing. Only the store setters differ. */
function ResizeHandle({ width }: { width: number }) {
  const setVideosWidth = useSumaStore((s) => s.setVideosWidth);
  const setPaneResizing = useSumaStore((s) => s.setPaneResizing);
  const resizing = useSumaStore((s) => s.paneResizing);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    setPaneResizing(true);
    let raf = 0;
    let pendingX = e.clientX;
    const apply = (): void => {
      raf = 0;
      setVideosWidth(window.innerWidth - pendingX);
    };
    const onMove = (ev: PointerEvent): void => {
      pendingX = ev.clientX;
      if (raf === 0) raf = requestAnimationFrame(apply);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf !== 0) cancelAnimationFrame(raf);
      setPaneResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setVideosWidth(width + (e.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP));
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize videos panel"
        aria-valuenow={width}
        aria-valuemin={VIDEOS_MIN_WIDTH}
        aria-valuemax={VIDEOS_MAX_WIDTH}
        tabIndex={0}
        title="Drag to resize — double-click to reset"
        style={{ width: HANDLE_W, left: -Math.round(HANDLE_W / 2) }}
        onPointerDown={onPointerDown}
        onDoubleClick={() => setVideosWidth(VIDEOS_DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
        className="group absolute inset-y-0 z-10 cursor-col-resize outline-none"
      >
        <div
          className={cn(
            "mx-auto h-full w-[2px] rounded-full transition-colors",
            resizing
              ? "bg-accent/60"
              : "bg-transparent group-hover:bg-ink/25 group-focus-visible:bg-accent/50",
          )}
        />
      </div>
      {resizing ? <div className="fixed inset-0 z-50 cursor-col-resize" /> : null}
    </>
  );
}

function SourceBadge({ source }: { source: SavedVideo["source"] }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-ink/8 px-1.5 py-0.5 text-[10px] font-medium text-muted">
      <Film className="size-2.5" aria-hidden="true" />
      {source === "youtube" ? "YouTube" : "X"}
    </span>
  );
}

/** The card's poster; hides itself while the thumbnail is missing/broken. */
function Poster({ item }: { item: SavedVideo }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.id, item.hasThumbnail]);
  if (!item.hasThumbnail || failed) {
    return (
      <span className="flex aspect-video w-full items-center justify-center rounded-md bg-ink/8">
        <Film className="size-5 text-ink/25" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="relative block w-full">
      <img
        src={`suma-video://thumb/${item.id}`}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className="aspect-video w-full rounded-md bg-ink/8 object-cover"
      />
      {item.duration !== null ? (
        <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 py-px font-mono text-[9.5px] tabular-nums text-white">
          {formatTime(item.duration)}
        </span>
      ) : null}
      {item.state === "ready" || item.state === "uploading" ? (
        <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover/card:opacity-100">
          <span className="flex size-9 items-center justify-center rounded-full bg-black/60">
            <Play className="size-4 text-white" fill="currentColor" aria-hidden="true" />
          </span>
        </span>
      ) : null}
    </span>
  );
}

function StatusLine({ item }: { item: SavedVideo }) {
  if (item.state === "failed") {
    return (
      <span className="line-clamp-2 text-[10.5px] leading-snug text-danger">
        {item.error ?? "Download failed."}
      </span>
    );
  }
  if (item.state === "queued" || item.state === "downloading") {
    return (
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-[10.5px] text-muted">
          <LoaderCircle className="size-3 shrink-0 animate-spin text-accent" aria-hidden="true" />
          <span className="truncate">
            {item.progressLabel === "" ? "Downloading…" : item.progressLabel}
          </span>
        </span>
        <span className="h-1 w-full overflow-hidden rounded-full bg-ink/8">
          <span
            className="block h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${String(Math.round(item.progress * 100))}%` }}
          />
        </span>
      </span>
    );
  }
  if (item.state === "uploading") {
    return (
      <span className="flex items-center gap-1.5 text-[10.5px] text-muted">
        <CloudUpload className="size-3 shrink-0 text-accent" aria-hidden="true" />
        <span className="truncate">{item.progressLabel}</span>
      </span>
    );
  }
  // Ready, but mid-hydration: first play on this device streams the cloud
  // copy into the local cache (videos-service ensureLocalMedia), and the
  // label is the only signal the fetch is running.
  if (item.progressLabel.startsWith("Fetching")) {
    return (
      <span className="flex items-center gap-1.5 text-[10.5px] text-muted">
        <LoaderCircle className="size-3 shrink-0 animate-spin text-accent" aria-hidden="true" />
        <span className="truncate">{item.progressLabel}</span>
      </span>
    );
  }
  // Ready: where the durable copy lives.
  return (
    <span className="flex items-center gap-1.5 text-[10.5px] text-faint">
      {item.cloudPath !== null ? (
        <CloudUpload className="size-3 shrink-0" aria-hidden="true" />
      ) : (
        <CloudOff className="size-3 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">
        {item.cloudPath !== null ? "In your cloud files" : "On this Mac only"}
        {item.sizeBytes !== null ? ` · ${formatBytes(item.sizeBytes)}` : ""}
      </span>
    </span>
  );
}

function VideoCard({ item }: { item: SavedVideo }) {
  const playVideo = useSumaStore((s) => s.playVideo);
  const retryVideo = useSumaStore((s) => s.retryVideo);
  const removeVideo = useSumaStore((s) => s.removeVideo);
  const playable = item.state === "ready" || item.state === "uploading";

  return (
    <div
      className={cn(
        "group/card flex w-full flex-col gap-1.5 rounded-lg border border-hairline bg-ink/3 p-2 text-left transition-colors",
        playable && "hover:border-ink/20 hover:bg-ink/8",
      )}
    >
      <button
        type="button"
        disabled={!playable}
        onClick={() => void playVideo(item.id)}
        aria-label={playable ? `Play ${item.title}` : item.title}
        className={cn("block w-full", playable && "cursor-pointer")}
      >
        <Poster item={item} />
      </button>
      <span className="flex items-center gap-1.5">
        <SourceBadge source={item.source} />
        <span className="ml-auto shrink-0 text-[10px] text-faint">
          {agoLabel(item.savedAtMs)}
        </span>
      </span>
      <span className="truncate text-[12.5px] font-medium text-text" title={item.title}>
        {item.title}
      </span>
      {item.author !== null ? (
        <span className="truncate text-[11px] text-muted">{item.author}</span>
      ) : null}
      <StatusLine item={item} />
      <span className="flex items-center gap-0.5">
        {playable ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void playVideo(item.id)}
            className="gap-1 text-[10.5px]"
          >
            <Play className="size-3" fill="currentColor" aria-hidden="true" />
            Play
          </Button>
        ) : null}
        {item.state === "failed" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void retryVideo(item.id)}
            className="gap-1 text-[10.5px]"
          >
            <RotateCcw className="size-3" aria-hidden="true" />
            Retry
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          title="Remove video"
          aria-label="Remove video"
          className="ml-auto hover:text-danger"
          onClick={() => void removeVideo(item.id)}
        >
          <Trash2 className="size-3" aria-hidden="true" />
        </Button>
      </span>
    </div>
  );
}

export function VideosPanel() {
  const open = useSumaStore((s) => s.videosOpen);
  const width = useSumaStore((s) => s.videosWidth);
  const setVideosOpen = useSumaStore((s) => s.setVideosOpen);
  const videos = useSumaStore((s) => s.videos);
  const saveVideo = useSumaStore((s) => s.saveVideo);
  const activeTab = useSumaStore(selectActiveTab);

  const [query, setQuery] = useState("");

  // The header save button lights up only when the active tab IS a video page.
  const activeVideoUrl =
    activeTab === null ? null : canonicalVideoUrl(activeTab.url);

  // Same mount/expand choreography as the saves panel (see SavesPanel.tsx).
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [animating, setAnimating] = useState(false);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (open) {
      setMounted(true);
      setAnimating(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      const settle = window.setTimeout(() => setAnimating(false), OPEN_MS + 60);
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        window.clearTimeout(settle);
      };
    }
    setAnimating(true);
    setExpanded(false);
    const settle = window.setTimeout(() => {
      setMounted(false);
      setAnimating(false);
    }, CLOSE_MS);
    return () => window.clearTimeout(settle);
  }, [open]);

  if (!mounted) return null;

  const filtered = videos.filter((item) => matchesVideosQuery(item, query));

  return (
    <aside
      aria-label="Videos"
      inert={open ? undefined : true}
      data-closing={open ? undefined : ""}
      style={{ width: expanded ? width : 0 }}
      className={cn("no-drag relative h-full shrink-0", animating && "chat-slide")}
    >
      <ResizeHandle width={width} />

      <div className="h-full w-full overflow-hidden">
        <div
          style={{ width }}
          className="flex h-full flex-col border-l border-chrome-edge bg-chrome"
        >
          <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-hairline px-2.5">
            <Film className="size-3 text-accent" aria-hidden="true" />
            <span className="text-[12px] font-medium text-text">Videos</span>
            {videos.length > 0 ? (
              <span className="text-[10.5px] text-faint">{videos.length}</span>
            ) : null}
            <span className="ml-auto flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                title={
                  activeVideoUrl !== null
                    ? "Save this video (double-tap Shift)"
                    : "Open a YouTube or X video to save it"
                }
                aria-label="Save this video"
                disabled={activeVideoUrl === null || activeTab === null}
                onClick={() => {
                  if (activeTab !== null) void saveVideo(activeTab.url);
                }}
              >
                <MonitorDown className="size-3" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Close videos (⌘⇧V)"
                aria-label="Close videos"
                onClick={() => setVideosOpen(false)}
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </span>
          </header>

          <div className="shrink-0 border-b border-hairline p-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-hairline bg-bg/60 px-2 py-1 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
              <Search className="size-3 shrink-0 text-faint" aria-hidden="true" />
              <Input
                variant="bare"
                value={query}
                placeholder="Search videos — title, channel…"
                aria-label="Search videos"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Chords belong to the window (⌘⇧V to close, ⌘T, …).
                  if (e.metaKey || e.ctrlKey || e.altKey) return;
                  e.stopPropagation();
                }}
                className="flex-1 py-0.5 text-[12px]"
              />
              {query !== "" ? (
                <button
                  type="button"
                  title="Clear search"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="cursor-pointer rounded p-0.5 text-faint hover:bg-ink/8 hover:text-text"
                >
                  <X className="size-2.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {videos.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <Film className="size-5 text-ink/25" aria-hidden="true" />
                <p className="text-[12px] text-muted">
                  Double-tap <kbd className="rounded bg-ink/8 px-1">Shift</kbd> on a
                  YouTube or X video — or right-click it — to save it for later.
                </p>
                <p className="text-[11px] text-faint">
                  Saved videos are kept in your cloud files and play in a floating
                  window while you keep browsing.
                </p>
              </div>
            ) : filtered.length === 0 ? (
              <Marker variant="separator" className="mt-4">
                <MarkerIcon>
                  <Search className="size-3" aria-hidden="true" />
                </MarkerIcon>
                <MarkerContent>Nothing matches this search</MarkerContent>
              </Marker>
            ) : (
              <div className="flex flex-col gap-1.5 p-2">
                {filtered.map((item) => (
                  <VideoCard key={item.id} item={item} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
