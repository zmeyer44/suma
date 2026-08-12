/**
 * Saved videos — the YouTube/X video-saving contract, shared by main (which
 * downloads, uploads to cloud storage, and streams playback) and the renderer
 * (which browses the library and drives the floating PIP player).
 *
 * A saved video is downloaded ON THIS MAC with yt-dlp (YouTube and X media
 * URLs are credentialed/ephemeral, so a server-side fetch can never see what
 * the tab sees), kept in a local media cache for playback, and uploaded to
 * the account's cloud files (R2-backed, §8.6) for durability. Like the TTS
 * and saves contracts this file is pure and dependency-free on purpose: both
 * processes import it.
 */

/** Where a video came from — the only two sites the save gesture recognizes. */
export type SavedVideoSource = "youtube" | "x";

/**
 * queued → downloading → uploading → ready, or failed anywhere along the way
 * (retryable). "uploading" is already watchable: the local file is complete,
 * only the cloud copy is still in flight.
 */
export type SavedVideoState =
  | "queued"
  | "downloading"
  | "uploading"
  | "ready"
  | "failed";

export interface SavedVideo {
  id: string;
  /** Canonical source URL (see canonicalVideoUrl) — the dedup key. */
  url: string;
  source: SavedVideoSource;
  /** yt-dlp %(title)s; the URL host until metadata arrives. */
  title: string;
  /** yt-dlp %(uploader)s — the channel / account name. */
  author: string | null;
  /** Seconds; null until known. */
  duration: number | null;
  state: SavedVideoState;
  /** 0..1 download progress; 1 once the file is on disk. */
  progress: number;
  /** Human progress line — "42% · 1.2MiB/s · ETA 00:31", "Uploading…". */
  progressLabel: string;
  error: string | null;
  /** Cloud-files path once uploaded ("/Videos/…"), null while local-only. */
  cloudPath: string | null;
  /** Whether a poster frame was captured (served via suma-video://thumb/id). */
  hasThumbnail: boolean;
  sizeBytes: number | null;
  /** Resume point, seconds. */
  playbackPosition: number;
  /**
   * When the resume point was last written (ms epoch) — the cross-device
   * tiebreaker: a cloud position record newer than this wins, an older one is
   * ignored. Sync bookkeeping; the UI never shows it.
   */
  positionAtMs: number;
  savedAtMs: number;
}

/* ------------------------------ URL detection ------------------------------ */

export interface VideoUrlInfo {
  /** Canonical form — one spelling per video, whatever the user pasted. */
  url: string;
  source: SavedVideoSource;
}

/**
 * Recognize (and canonicalize) a YouTube or X video URL. Ported from
 * Replay's URLIntake: youtu.be/ID, youtube.com/watch?v=ID (tracking params
 * and timestamps stripped), youtube.com/shorts/ID, and x.com/twitter.com
 * /user/status/ID. Null for everything else — the gesture falls back to a
 * regular page save.
 */
export function canonicalVideoUrl(rawUrl: string): VideoUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();

  if (host === "youtu.be") {
    const videoId = parsed.pathname.split("/").find((part) => part !== "");
    if (videoId !== undefined && videoId !== "") {
      return youtubeInfo(videoId);
    }
    return null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const queryId = parsed.searchParams.get("v");
    const parts = parsed.pathname.split("/").filter((part) => part !== "");
    const pathId =
      (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") &&
      parts.length > 1
        ? parts[1]
        : null;
    const videoId = queryId ?? pathId;
    if (videoId !== null && videoId !== undefined && videoId !== "") {
      return youtubeInfo(videoId);
    }
    return null;
  }

  if (
    host === "x.com" ||
    host.endsWith(".x.com") ||
    host === "twitter.com" ||
    host.endsWith(".twitter.com")
  ) {
    const parts = parsed.pathname.split("/").filter((part) => part !== "");
    const statusIndex = parts.indexOf("status");
    if (statusIndex > 0 && parts.length > statusIndex + 1) {
      const user = parts[statusIndex - 1];
      const statusId = parts[statusIndex + 1]?.match(/^\d+/)?.[0];
      if (user !== undefined && statusId !== undefined && statusId !== "") {
        return {
          url: `https://x.com/${user}/status/${statusId}`,
          source: "x",
        };
      }
    }
    return null;
  }
  return null;
}

function youtubeInfo(videoId: string): VideoUrlInfo | null {
  // IDs are URL-safe base64ish; refuse anything that smells like a path.
  if (!/^[\w-]{5,}$/.test(videoId)) return null;
  return {
    url: `https://www.youtube.com/watch?v=${videoId}`,
    source: "youtube",
  };
}

/* --------------------------------- PIP relay -------------------------------- */

/**
 * Everything the floating PIP view needs to draw and play — pushed by main as
 * `videoPip:state` and pulled on (re)mount via `videoPip:requestState`. The
 * PIP view OWNS playback (the <video> element lives there); main only tells
 * it what to load and where to resume.
 */
export interface VideoPipState {
  /** Null ⇒ nothing loaded — the view is hidden. */
  videoId: string | null;
  title: string;
  author: string | null;
  /** suma-video://media/<id> — streamed with Range support from main. */
  mediaUrl: string | null;
  /** Resume point, seconds. */
  position: number;
}

export const EMPTY_PIP_STATE: VideoPipState = {
  videoId: null,
  title: "",
  author: null,
  mediaUrl: null,
  position: 0,
};

/** One tap (or drag edge) in the PIP view, applied by main. */
export type VideoPipCommand =
  /** Close the player; `ended` distinguishes natural end (position resets). */
  | { command: "close"; ended?: boolean }
  /** Open the video's source page in a tab and close the player. */
  | { command: "openSource" }
  /** Periodic resume-point report while playing. */
  | { command: "position"; value: number };

/* --------------------------------- limits ---------------------------------- */

export const MAX_SAVED_VIDEOS = 500;
export const MAX_VIDEO_TITLE_CHARS = 300;
export const MAX_VIDEO_AUTHOR_CHARS = 120;
export const MAX_VIDEO_ERROR_CHARS = 500;

/* --------------------------------- search ---------------------------------- */

/** The panel's search — same substring-per-term contract as saves. */
export function matchesVideosQuery(item: SavedVideo, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t !== "");
  if (terms.length === 0) return true;
  const haystack = [item.title, item.author ?? "", item.url, item.source]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
