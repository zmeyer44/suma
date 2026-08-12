/**
 * Videos core — the pure half of the video-saving pipeline (the saves-core
 * pattern): the yt-dlp invocation, its structured-output line protocol, the
 * persisted-item validation, and the PIP layout math. Everything here is
 * testable without Electron, the filesystem, or a subprocess.
 *
 * The download engine design is ported from Replay (a macOS yt-dlp app):
 * rather than scraping yt-dlp's human output, the argument vector defines
 * sentinel lines — WL_META before download, WL_PROGRESS during, WL_DONE after
 * move — with JSON-encoded (%(...)j) fields, so titles containing tabs or
 * quotes survive the pipe.
 */

import type { ContentBounds } from "../../shared/ipc";
import {
  MAX_SAVED_VIDEOS,
  MAX_VIDEO_AUTHOR_CHARS,
  MAX_VIDEO_ERROR_CHARS,
  MAX_VIDEO_TITLE_CHARS,
  type SavedVideo,
  type SavedVideoSource,
  type SavedVideoState,
} from "../../shared/videos";

export const VIDEOS_FILENAME = "videos.json";
/** The local media cache under userData — <id>.<ext> plus <id>.jpg posters. */
export const VIDEOS_DIRNAME = "videos";

/* ------------------------------ yt-dlp arguments ---------------------------- */

const PROGRESS_SENTINEL = "WL_PROGRESS";
const META_SENTINEL = "WL_META";
const DONE_SENTINEL = "WL_DONE";

/**
 * The full yt-dlp argument vector for one download. `ffmpegDir` unlocks the
 * merged bestvideo+bestaudio path (and thumbnail conversion); without it the
 * format falls back to the best single pre-merged mp4, which every YouTube/X
 * video has.
 */
export function buildYtDlpArgs(args: {
  url: string;
  id: string;
  destDir: string;
  ffmpegDir: string | null;
}): string[] {
  const vector = [
    "--ignore-config",
    "--no-playlist",
    "--continue",
    "--part",
    "--newline",
    "--no-color",
    "--paths",
    args.destDir,
    "--output",
    `${args.id}.%(ext)s`,
    "--format",
    args.ffmpegDir !== null
      ? "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]/best"
      : "b[ext=mp4]/best",
    "--write-thumbnail",
    "--progress-template",
    `download:${PROGRESS_SENTINEL}\t%(progress._percent_str)s\t%(progress._speed_str)s\t%(progress._eta_str)s`,
    "--print",
    `before_dl:${META_SENTINEL}\t%(title)j\t%(uploader)j\t%(duration)j`,
    "--print",
    `after_move:${DONE_SENTINEL}\t%(filepath)j\t%(title)j\t%(uploader)j\t%(duration)j`,
  ];
  if (args.ffmpegDir !== null) {
    vector.push(
      "--merge-output-format",
      "mp4",
      "--convert-thumbnails",
      "jpg",
      "--ffmpeg-location",
      args.ffmpegDir,
    );
  }
  vector.push(args.url);
  return vector;
}

/* ------------------------------- line protocol ------------------------------ */

export interface VideoMetadata {
  title: string | null;
  author: string | null;
  duration: number | null;
}

export type YtDlpEvent =
  | { kind: "progress"; fraction: number; label: string }
  | ({ kind: "meta" } & VideoMetadata)
  | ({ kind: "done"; filepath: string } & VideoMetadata);

/** Decode one %(field)j value — JSON fragment, with null/NA tolerated. */
function decodeField(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "NA" || trimmed === "null") return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function asText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, max).trim();
  return text === "" ? null : text;
}

function asSeconds(value: unknown): number | null {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function metadataFrom(fields: string[], offset: number): VideoMetadata {
  return {
    title: asText(decodeField(fields[offset]), MAX_VIDEO_TITLE_CHARS),
    author: asText(decodeField(fields[offset + 1]), MAX_VIDEO_AUTHOR_CHARS),
    duration: asSeconds(decodeField(fields[offset + 2])),
  };
}

/**
 * Parse one line of the merged yt-dlp stdout/stderr stream. Null for
 * everything that is not one of our sentinel lines (yt-dlp's own chatter —
 * the service keeps a tail of those for error reporting).
 */
export function parseYtDlpLine(line: string): YtDlpEvent | null {
  if (line.startsWith(`${PROGRESS_SENTINEL}\t`)) {
    const fields = line.split("\t");
    const percentText = (fields[1] ?? "").replace("%", "").trim();
    const percent = Number.parseFloat(percentText);
    const fraction = Number.isFinite(percent)
      ? Math.min(Math.max(percent / 100, 0), 1)
      : 0;
    const speed = (fields[2] ?? "").trim();
    const eta = (fields[3] ?? "").trim();
    const parts = [
      Number.isFinite(percent) ? `${percent.toFixed(1)}%` : null,
      speed === "" || speed === "NA" ? null : speed,
      eta === "" || eta === "NA" ? null : `ETA ${eta}`,
    ].filter((part): part is string => part !== null);
    return {
      kind: "progress",
      fraction,
      label: parts.length > 0 ? parts.join(" · ") : "Downloading…",
    };
  }
  if (line.startsWith(`${META_SENTINEL}\t`)) {
    return { kind: "meta", ...metadataFrom(line.split("\t"), 1) };
  }
  if (line.startsWith(`${DONE_SENTINEL}\t`)) {
    const fields = line.split("\t");
    const filepath = decodeField(fields[1]);
    if (typeof filepath !== "string" || filepath === "") return null;
    return { kind: "done", filepath, ...metadataFrom(fields, 2) };
  }
  return null;
}

/**
 * Split a chunked byte stream into lines, keeping the trailing partial line
 * buffered. Returns the complete lines and the new remainder.
 */
export function splitStreamLines(
  pending: string,
  chunk: string,
): { lines: string[]; pending: string } {
  const combined = pending + chunk;
  const lines = combined.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  return { lines: lines.filter((line) => line.trim() !== ""), pending: rest };
}

/* ------------------------------ media file names ---------------------------- */

export const VIDEO_EXTENSIONS = ["mp4", "webm", "mkv", "mov", "m4v"] as const;
export const THUMBNAIL_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const;

/** Pick this item's video file out of a directory listing (`<id>.<ext>`). */
export function findMediaFile(
  id: string,
  filenames: string[],
): string | null {
  return matchByExtension(id, filenames, VIDEO_EXTENSIONS);
}

export function findThumbnailFile(
  id: string,
  filenames: string[],
): string | null {
  return matchByExtension(id, filenames, THUMBNAIL_EXTENSIONS);
}

function matchByExtension(
  id: string,
  filenames: string[],
  extensions: readonly string[],
): string | null {
  for (const ext of extensions) {
    const name = `${id}.${ext}`;
    if (filenames.includes(name)) return name;
  }
  return null;
}

/** Content type for the streaming protocol, from the cached file's name. */
export function mediaContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "mov":
      return "video/quicktime";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** A cloud-files destination that stays readable: "/Videos/<slug>-<id>.mp4". */
export function cloudPathFor(title: string, id: string, ext: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const stem = slug === "" ? id : `${slug}-${id.slice(0, 8)}`;
  return `/Videos/${stem}.${ext}`;
}

/* ------------------------------ cloud sidecars ------------------------------ */

/**
 * The cloud layout under the account's files (all R2-backed, §8.6):
 *
 *   /Videos/<slug>-<id8>.mp4      the video itself (cloudPathFor above)
 *   /Videos/.meta/<id>.json       a metadata sidecar — what ANOTHER device
 *                                 needs to show the library card and play
 *   /Videos/.thumbs/<id>.jpg      the poster frame
 *
 * The sidecar is what makes the library cross-device without a sync-engine
 * integration: every device can list /Videos/.meta/, fetch the sidecars it
 * has never seen, and stream the media via the manifest read-back route.
 */
export const VIDEOS_CLOUD_META_PREFIX = "/Videos/.meta/";

export function metaCloudPathFor(id: string): string {
  return `${VIDEOS_CLOUD_META_PREFIX}${id}.json`;
}

export function thumbCloudPathFor(id: string): string {
  return `/Videos/.thumbs/${id}.jpg`;
}

/**
 * Playback positions sync as their own tiny record beside the sidecar —
 * rewritten often (every pause/close), unlike the write-once sidecar, and
 * read back at PLAY time, the one moment freshness matters. Newest
 * `updatedAtMs` wins on both ends.
 */
export function positionCloudPathFor(id: string): string {
  return `/Videos/.positions/${id}.json`;
}

export interface PositionRecord {
  /** Seconds into the video. */
  position: number;
  /** When this position was written (ms epoch) — the last-write-wins stamp. */
  updatedAtMs: number;
}

export function buildPositionRecord(record: PositionRecord & { id: string }): string {
  return JSON.stringify({
    v: 1,
    id: record.id,
    position: record.position,
    updatedAtMs: record.updatedAtMs,
  });
}

export function parsePositionRecord(json: string): PositionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const position = record["position"];
  const updatedAtMs = record["updatedAtMs"];
  if (typeof position !== "number" || !Number.isFinite(position) || position < 0) return null;
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    return null;
  }
  return { position, updatedAtMs };
}

/** "/Videos/.meta/<id>.json" → "<id>"; null for anything else. */
export function videoIdFromMetaPath(path: string): string | null {
  if (!path.startsWith(VIDEOS_CLOUD_META_PREFIX) || !path.endsWith(".json")) {
    return null;
  }
  const id = path.slice(VIDEOS_CLOUD_META_PREFIX.length, -".json".length);
  return /^[\w-]+$/.test(id) ? id : null;
}

/** Serialize the cross-device half of an item. `v` gates future evolution. */
export function buildVideoSidecar(item: SavedVideo): string {
  return JSON.stringify({
    v: 1,
    id: item.id,
    url: item.url,
    source: item.source,
    title: item.title,
    author: item.author,
    duration: item.duration,
    sizeBytes: item.sizeBytes,
    cloudPath: item.cloudPath,
    hasThumbnail: item.hasThumbnail,
    savedAtMs: item.savedAtMs,
  });
}

/**
 * A sidecar another device wrote, decoded into a cloud-only library item:
 * ready (the media is in the store), nothing cached locally yet. Null when
 * the JSON is not a usable sidecar — reconcile just skips it.
 */
export function savedVideoFromSidecar(json: string): SavedVideo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const item = sanitizeSavedVideo(
    typeof parsed === "object" && parsed !== null
      ? { ...(parsed as Record<string, unknown>), state: "ready" }
      : null,
  );
  if (item === null || item.cloudPath === null) return null;
  return {
    ...item,
    // The poster is not on this device yet — reconcile hydrates it and flips
    // this; claiming true now would render broken thumb requests meanwhile.
    hasThumbnail: false,
    progressLabel: "In your cloud files",
  };
}

/* ------------------------------ range requests ------------------------------ */

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Resolve an HTTP Range header against a file size — <video> seeking is
 * nothing but these. Null means "serve the whole file with 200"; a
 * `start >= size` request is out of range and null here too (the caller
 * clamps it to a 416 or a full response; Chromium never sends one for a
 * file it learned the size of).
 */
export function parseRangeHeader(
  header: string | null,
  size: number,
): ByteRange | null {
  if (header === null || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    // Suffix form: last N bytes.
    const suffix = Number.parseInt(endText ?? "", 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number.parseInt(startText ?? "", 10);
  if (!Number.isFinite(start) || start >= size) return null;
  const end =
    endText === ""
      ? size - 1
      : Math.min(Number.parseInt(endText ?? "", 10), size - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/* -------------------------------- PIP layout -------------------------------- */

export const PIP_ASPECT = 16 / 9;
export const PIP_DEFAULT_WIDTH = 480;
export const PIP_MIN_WIDTH = 280;
/** Gap from the content hole's edges. */
export const PIP_MARGIN = 16;

export function pipHeightFor(width: number): number {
  return Math.round(width / PIP_ASPECT);
}

/** Where a fresh PIP lands: bottom-right of the content hole. */
export function defaultPipBounds(hole: ContentBounds): ContentBounds {
  const width = Math.min(
    PIP_DEFAULT_WIDTH,
    Math.max(PIP_MIN_WIDTH, hole.width - PIP_MARGIN * 2),
  );
  const height = pipHeightFor(width);
  return clampPipBounds(
    {
      x: hole.x + hole.width - width - PIP_MARGIN,
      y: hole.y + hole.height - height - PIP_MARGIN,
      width,
      height,
    },
    hole,
  );
}

/**
 * Keep the player inside the content hole (and no larger than it), preserving
 * the 16:9 aspect. Used after drags, resizes, and window/layout changes.
 */
export function clampPipBounds(
  bounds: ContentBounds,
  hole: ContentBounds,
): ContentBounds {
  const maxWidth = Math.max(PIP_MIN_WIDTH, hole.width - PIP_MARGIN * 2);
  const width = Math.round(
    Math.min(Math.max(bounds.width, PIP_MIN_WIDTH), maxWidth),
  );
  let height = pipHeightFor(width);
  // A very short hole caps the height; keep aspect by shrinking width too.
  const maxHeight = Math.max(pipHeightFor(PIP_MIN_WIDTH), hole.height - PIP_MARGIN * 2);
  let finalWidth = width;
  if (height > maxHeight) {
    height = maxHeight;
    finalWidth = Math.round(height * PIP_ASPECT);
  }
  const x = Math.min(
    Math.max(bounds.x, hole.x + PIP_MARGIN),
    Math.max(hole.x + PIP_MARGIN, hole.x + hole.width - finalWidth - PIP_MARGIN),
  );
  const y = Math.min(
    Math.max(bounds.y, hole.y + PIP_MARGIN),
    Math.max(hole.y + PIP_MARGIN, hole.y + hole.height - height - PIP_MARGIN),
  );
  return { x: Math.round(x), y: Math.round(y), width: finalWidth, height };
}

/* -------------------------------- persistence ------------------------------- */

const STATES: readonly SavedVideoState[] = [
  "queued",
  "downloading",
  "uploading",
  "ready",
  "failed",
];

function isSource(value: unknown): value is SavedVideoSource {
  return value === "youtube" || value === "x";
}

/** One stored item, re-validated on load — the file is user-editable disk.
 *  Items persisted mid-flight (queued/downloading/uploading) load as failed
 *  with a retry hint: the process that owned them is gone. */
export function sanitizeSavedVideo(raw: unknown): SavedVideo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  const url = record["url"];
  if (typeof id !== "string" || !/^[\w-]+$/.test(id)) return null;
  if (typeof url !== "string" || url === "") return null;
  if (!isSource(record["source"])) return null;
  const storedState = STATES.includes(record["state"] as SavedVideoState)
    ? (record["state"] as SavedVideoState)
    : "failed";
  const interrupted =
    storedState === "queued" ||
    storedState === "downloading" ||
    storedState === "uploading";
  const title = asText(record["title"], MAX_VIDEO_TITLE_CHARS);
  const error = asText(record["error"], MAX_VIDEO_ERROR_CHARS);
  const sizeBytes = asSeconds(record["sizeBytes"]);
  return {
    id,
    url,
    source: record["source"],
    title: title ?? url,
    author: asText(record["author"], MAX_VIDEO_AUTHOR_CHARS),
    duration: asSeconds(record["duration"]),
    state: interrupted ? "failed" : storedState,
    progress: storedState === "ready" ? 1 : 0,
    progressLabel: storedState === "ready" ? "Saved" : "",
    error: interrupted ? "Interrupted — save again to retry." : error,
    cloudPath:
      typeof record["cloudPath"] === "string" && record["cloudPath"] !== ""
        ? record["cloudPath"]
        : null,
    hasThumbnail: record["hasThumbnail"] === true,
    sizeBytes: sizeBytes === null ? null : Math.round(sizeBytes),
    playbackPosition: asSeconds(record["playbackPosition"]) ?? 0,
    positionAtMs: asSeconds(record["positionAtMs"]) ?? 0,
    savedAtMs:
      typeof record["savedAtMs"] === "number" &&
      Number.isFinite(record["savedAtMs"])
        ? record["savedAtMs"]
        : 0,
  };
}

export function parseSavedVideosFile(json: string): SavedVideo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list =
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>)["items"])
      ? ((parsed as Record<string, unknown>)["items"] as unknown[])
      : [];
  return list
    .flatMap((entry) => {
      const item = sanitizeSavedVideo(entry);
      return item === null ? [] : [item];
    })
    .slice(0, MAX_SAVED_VIDEOS);
}
