/**
 * VideosService — the saved-videos store and the yt-dlp download engine.
 *
 * Lives in MAIN like SavesService and for the same reasons: it spawns
 * subprocesses, owns the media cache on disk, and hands the renderer nothing
 * but finished display items. The pipeline per save:
 *
 *   canonical URL → item written immediately (queued) → yt-dlp subprocess
 *   (progress/metadata via the WL_* sentinel protocol, videos-core.ts) →
 *   file lands in the userData/videos cache → upload to the account's cloud
 *   files (R2-backed, the §8.6 chunk path) → ready.
 *
 * The local cache is the PLAYBACK copy (the suma-video:// protocol streams
 * it into the PIP view); the cloud copy is durability. An upload that cannot
 * happen (signed out, control plane down, file over the upload cap) degrades
 * to a local-only save rather than failing it — the label says so.
 *
 * Items persist to `videos.json` beside saves.json — device-local, atomic
 * tmp+rename writes, erased by sign-out (LOCAL_STATE_FILES + the media dir).
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { UploadProgress } from "../../shared/ipc";
import {
  canonicalVideoUrl,
  MAX_SAVED_VIDEOS,
  MAX_VIDEO_ERROR_CHARS,
  type SavedVideo,
} from "../../shared/videos";
import {
  buildPositionRecord,
  buildVideoSidecar,
  buildYtDlpArgs,
  cloudPathFor,
  findMediaFile,
  findThumbnailFile,
  metaCloudPathFor,
  parsePositionRecord,
  parseSavedVideosFile,
  parseYtDlpLine,
  positionCloudPathFor,
  savedVideoFromSidecar,
  splitStreamLines,
  thumbCloudPathFor,
  videoIdFromMetaPath,
  VIDEOS_CLOUD_META_PREFIX,
  VIDEOS_DIRNAME,
  VIDEOS_FILENAME,
} from "./videos-core";

/** How many yt-dlp processes may run at once; the rest wait for a slot. */
const MAX_CONCURRENT_DOWNLOADS = 2;
/** Progress pushes to the renderer are throttled to this. */
const PROGRESS_EMIT_MS = 250;
/** Tail of non-sentinel yt-dlp output kept for the failure message. */
const RECENT_LINES = 12;

/** Uploads driven by this service carry this uploadId prefix, so the files
 *  progress stream can be teed back into per-video labels (index.ts). */
export const VIDEO_UPLOAD_ID_PREFIX = "video:";

/** In-playback position publishes are throttled to this; pause/close forces. */
const POSITION_PUBLISH_MS = 30_000;

/** How long a play waits on the cloud position check before starting from
 *  the local resume point — freshness is worth a beat, never a stall. */
const POSITION_FETCH_TIMEOUT_MS = 2_500;

export interface VideosServiceDeps {
  userDataDir: string;
  /** The whole collection, newest first — sent on every change. */
  emitUpdated: (items: SavedVideo[]) => void;
  /**
   * Store a finished file in the account's cloud files. Wired to
   * FilesService.upload in index.ts; rejects when the control plane is
   * unreachable or the file is over the upload cap.
   */
  uploadToCloud: (args: {
    path: string;
    contentType: string;
    data: Uint8Array;
    uploadId: string;
  }) => Promise<void>;
  /**
   * The cross-device half (all wired to FilesService in index.ts, all
   * rejecting while signed out): list stored paths under a prefix, reassemble
   * a stored file's bytes (the manifest read-back route), and delete a stored
   * file — so a removed video does not resurrect on the next reconcile.
   */
  listCloudPaths: (prefix: string) => Promise<string[]>;
  downloadFromCloud: (path: string) => Promise<Uint8Array>;
  removeFromCloud: (path: string) => Promise<void>;
  /** Resolve a bundled-or-system binary; null when not installed. */
  findTool?: (name: string) => string | null;
  now?: () => number;
  makeId?: () => string;
}

interface ActiveDownload {
  child: ChildProcessByStdio<null, Readable, Readable>;
  cancelled: boolean;
}

export class VideosService {
  private readonly filePath: string;
  readonly mediaDir: string;
  private readonly deps: VideosServiceDeps;
  private readonly now: () => number;
  private readonly makeId: () => string;
  /** Newest first — the order the panel shows. */
  private items: SavedVideo[];
  private readonly active = new Map<string, ActiveDownload>();
  /** Media files currently being fetched from the cloud (ensureLocalMedia). */
  private readonly hydrating = new Set<string>();
  /** Last cloud position publish per item, for the in-playback throttle. */
  private readonly positionPublishedAtMs = new Map<string, number>();
  private reconciling = false;
  private lastEmitMs = 0;
  private stopped = false;

  constructor(deps: VideosServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.makeId = deps.makeId ?? randomUUID;
    this.filePath = path.join(deps.userDataDir, VIDEOS_FILENAME);
    this.mediaDir = path.join(deps.userDataDir, VIDEOS_DIRNAME);
    mkdirSync(this.mediaDir, { recursive: true });
    this.items = this.read();
  }

  /* ------------------------------ persistence ----------------------------- */

  private read(): SavedVideo[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return parseSavedVideosFile(readFileSync(this.filePath, "utf8"));
    } catch {
      return [];
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2));
    renameSync(tmp, this.filePath);
  }

  private commit(): void {
    this.persist();
    this.emit(true);
  }

  /** Push the list; progress ticks are throttled, state changes never are. */
  private emit(force: boolean): void {
    const at = this.now();
    if (!force && at - this.lastEmitMs < PROGRESS_EMIT_MS) return;
    this.lastEmitMs = at;
    this.deps.emitUpdated(this.list());
  }

  /* -------------------------------- queries ------------------------------- */

  list(): SavedVideo[] {
    return this.items.map((item) => ({ ...item }));
  }

  get(id: string): SavedVideo | null {
    const item = this.items.find((entry) => entry.id === id);
    return item === undefined ? null : { ...item };
  }

  /** Absolute path of the cached media file, or null when not on disk. */
  mediaPathFor(id: string): string | null {
    if (!/^[\w-]+$/.test(id)) return null;
    const name = findMediaFile(id, this.listMediaDir());
    return name === null ? null : path.join(this.mediaDir, name);
  }

  thumbnailPathFor(id: string): string | null {
    if (!/^[\w-]+$/.test(id)) return null;
    const name = findThumbnailFile(id, this.listMediaDir());
    return name === null ? null : path.join(this.mediaDir, name);
  }

  private listMediaDir(): string[] {
    try {
      return readdirSync(this.mediaDir);
    } catch {
      return [];
    }
  }

  /* --------------------------------- save --------------------------------- */

  /**
   * Save the video behind a YouTube/X URL. Returns the item (existing or
   * new) — null when the URL is not a recognized video page. Saving an
   * already-saved video re-announces it; saving a failed one retries it.
   */
  save(rawUrl: string): SavedVideo | null {
    const info = canonicalVideoUrl(rawUrl);
    if (info === null) return null;
    const existing = this.items.find((item) => item.url === info.url);
    if (existing !== undefined) {
      if (existing.state === "failed") this.retry(existing.id);
      return this.get(existing.id);
    }
    const item: SavedVideo = {
      id: this.makeId(),
      url: info.url,
      source: info.source,
      title: hostTitle(info.url),
      author: null,
      duration: null,
      state: "queued",
      progress: 0,
      progressLabel: "Queued",
      error: null,
      cloudPath: null,
      hasThumbnail: false,
      sizeBytes: null,
      playbackPosition: 0,
      positionAtMs: 0,
      savedAtMs: this.now(),
    };
    this.items = [item, ...this.items].slice(0, MAX_SAVED_VIDEOS);
    this.commit();
    this.startNextIfIdle();
    return { ...item };
  }

  retry(id: string): void {
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined || item.state !== "failed") return;
    this.patch(id, {
      state: "queued",
      progress: 0,
      progressLabel: "Queued",
      error: null,
    });
    this.commit();
    this.startNextIfIdle();
  }

  remove(id: string): void {
    const download = this.active.get(id);
    if (download !== undefined) {
      download.cancelled = true;
      download.child.kill();
    }
    const item = this.items.find((entry) => entry.id === id);
    this.items = this.items.filter((entry) => entry.id !== id);
    // Every cached artifact carries the item's id prefix.
    for (const name of this.listMediaDir()) {
      if (name.startsWith(`${id}.`)) {
        rmSync(path.join(this.mediaDir, name), { force: true });
      }
    }
    // The cloud copies go too — with the sidecar gone, no device's reconcile
    // can resurrect the item. Best-effort: offline, the objects linger until
    // a removal while online (a known v1 gap, not data loss).
    if (item !== undefined && item.cloudPath !== null) {
      for (const cloudPath of [
        item.cloudPath,
        metaCloudPathFor(id),
        thumbCloudPathFor(id),
        positionCloudPathFor(id),
      ]) {
        void this.deps.removeFromCloud(cloudPath).catch(() => undefined);
      }
    }
    this.commit();
    this.startNextIfIdle();
  }

  updatePlaybackPosition(id: string, seconds: number): void {
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined || !Number.isFinite(seconds)) return;
    const clamped = Math.max(0, seconds);
    // Sub-second jitter is not worth a disk write.
    if (Math.abs(item.playbackPosition - clamped) < 1) return;
    item.playbackPosition = clamped;
    item.positionAtMs = this.now();
    this.persist();
  }

  /* --------------------------- position syncing ---------------------------- */

  /**
   * Push this item's resume point to its cloud record. Throttled while
   * playback is streaming updates; `force` (pause, close, ended) publishes
   * immediately. Best-effort and quiet — a position is a convenience, and a
   * failed publish must never surface as a playback error.
   */
  publishPosition(id: string, opts: { force?: boolean } = {}): void {
    const item = this.items.find((entry) => entry.id === id);
    // No cloud copy ⇒ no other device can play it ⇒ nothing to sync.
    if (item === undefined || item.cloudPath === null) return;
    const at = this.now();
    const last = this.positionPublishedAtMs.get(id) ?? 0;
    if (opts.force !== true && at - last < POSITION_PUBLISH_MS) return;
    this.positionPublishedAtMs.set(id, at);
    void this.deps
      .uploadToCloud({
        path: positionCloudPathFor(id),
        contentType: "application/json",
        data: new TextEncoder().encode(
          buildPositionRecord({
            id,
            position: item.playbackPosition,
            updatedAtMs: item.positionAtMs > 0 ? item.positionAtMs : at,
          }),
        ),
        uploadId: `${VIDEO_UPLOAD_ID_PREFIX}pos-${id}`,
      })
      .catch(() => undefined);
  }

  /**
   * Adopt a newer resume point another device published — called at play
   * time, when freshness is worth waiting a beat for (bounded by
   * POSITION_FETCH_TIMEOUT_MS, so a slow control plane never stalls play).
   * Older-or-equal records are ignored: this device's own position stands.
   */
  async refreshPositionFromCloud(id: string): Promise<void> {
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined || item.cloudPath === null) return;
    try {
      const bytes = await Promise.race([
        this.deps.downloadFromCloud(positionCloudPathFor(id)),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("position fetch timed out")), POSITION_FETCH_TIMEOUT_MS),
        ),
      ]);
      const record = parsePositionRecord(new TextDecoder().decode(bytes));
      if (record === null || record.updatedAtMs <= item.positionAtMs) return;
      if (this.stopped) return;
      this.patch(id, {
        playbackPosition: record.position,
        positionAtMs: record.updatedAtMs,
      });
      this.persist();
    } catch {
      // Missing record, offline, signed out, slow — the local point stands.
    }
  }

  /** Teardown (sign-out, quit): kill every subprocess in flight. */
  stop(): void {
    this.stopped = true;
    for (const download of this.active.values()) {
      download.cancelled = true;
      download.child.kill();
    }
    this.active.clear();
  }

  /* ------------------------- upload progress relay ------------------------- */

  /** Teed from the files upload stream (index.ts) — real cloud percentages. */
  noteUploadProgress(progress: UploadProgress): void {
    if (!progress.uploadId.startsWith(VIDEO_UPLOAD_ID_PREFIX)) return;
    const id = progress.uploadId.slice(VIDEO_UPLOAD_ID_PREFIX.length);
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined || item.state !== "uploading") return;
    if (progress.state === "uploading" && progress.totalBytes > 0) {
      const pct = Math.round((progress.sentBytes / progress.totalBytes) * 100);
      item.progressLabel = `Uploading to cloud — ${String(pct)}%`;
      this.emit(false);
    }
  }

  /* ------------------------------- downloads ------------------------------- */

  private patch(id: string, changes: Partial<SavedVideo>): void {
    this.items = this.items.map((item) =>
      item.id === id ? { ...item, ...changes } : item,
    );
  }

  private startNextIfIdle(): void {
    if (this.stopped) return;
    while (this.active.size < MAX_CONCURRENT_DOWNLOADS) {
      const next = [...this.items]
        .reverse() // oldest queued first
        .find((item) => item.state === "queued" && !this.active.has(item.id));
      if (next === undefined) return;
      this.startDownload(next.id);
    }
  }

  private startDownload(id: string): void {
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined) return;
    const findTool = this.deps.findTool ?? findSystemTool;
    const ytDlp = findTool("yt-dlp");
    if (ytDlp === null) {
      this.patch(id, {
        state: "failed",
        error:
          "yt-dlp isn't installed — run `brew install yt-dlp`, then retry.",
        progressLabel: "",
      });
      this.commit();
      return;
    }
    const ffmpeg = findTool("ffmpeg");
    const args = buildYtDlpArgs({
      url: item.url,
      id,
      destDir: this.mediaDir,
      ffmpegDir: ffmpeg === null ? null : path.dirname(ffmpeg),
    });

    this.patch(id, {
      state: "downloading",
      progressLabel: "Preparing download…",
    });
    this.commit();

    const child = spawn(ytDlp, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv(),
    });
    const download: ActiveDownload = { child, cancelled: false };
    this.active.set(id, download);

    let pending = "";
    const recent: string[] = [];
    let donePath: string | null = null;
    const consume = (chunk: Buffer): void => {
      const split = splitStreamLines(pending, chunk.toString("utf8"));
      pending = split.pending;
      for (const line of split.lines) {
        const event = parseYtDlpLine(line);
        if (event === null) {
          recent.push(line);
          if (recent.length > RECENT_LINES) recent.shift();
          continue;
        }
        if (event.kind === "progress") {
          this.patch(id, { progress: event.fraction, progressLabel: event.label });
          this.emit(false);
        } else {
          const meta = {
            ...(event.title !== null ? { title: event.title } : {}),
            ...(event.author !== null ? { author: event.author } : {}),
            ...(event.duration !== null ? { duration: event.duration } : {}),
          };
          if (event.kind === "done") donePath = event.filepath;
          this.patch(id, meta);
          this.emit(true);
        }
      }
    };
    child.stdout.on("data", consume);
    child.stderr?.on("data", consume);

    child.on("error", (err) => {
      this.active.delete(id);
      this.finishFailed(id, `Couldn't run yt-dlp — ${err.message}`);
    });
    child.on("close", (code) => {
      this.active.delete(id);
      if (this.stopped) return;
      if (download.cancelled) {
        this.startNextIfIdle();
        return;
      }
      if (code !== 0) {
        const tail = recent.slice(-4).join(" ").slice(0, MAX_VIDEO_ERROR_CHARS);
        this.finishFailed(
          id,
          tail === "" ? `yt-dlp exited with code ${String(code)}` : tail,
        );
        return;
      }
      void this.finishDownloaded(id, donePath);
    });
  }

  private finishFailed(id: string, error: string): void {
    if (this.items.every((item) => item.id !== id)) return;
    this.patch(id, {
      state: "failed",
      error: error.slice(0, MAX_VIDEO_ERROR_CHARS),
      progressLabel: "",
    });
    this.commit();
    this.startNextIfIdle();
  }

  /** The file is on disk: record it, then try the cloud copy. */
  private async finishDownloaded(
    id: string,
    reportedPath: string | null,
  ): Promise<void> {
    const mediaPath =
      reportedPath !== null && existsSync(reportedPath)
        ? reportedPath
        : this.mediaPathFor(id);
    if (mediaPath === null) {
      this.finishFailed(id, "Download finished but no video file was found.");
      return;
    }
    let sizeBytes: number | null = null;
    try {
      sizeBytes = statSync(mediaPath).size;
    } catch {
      // Size is cosmetic.
    }
    this.patch(id, {
      state: "uploading",
      progress: 1,
      progressLabel: "Uploading to cloud…",
      hasThumbnail: this.thumbnailPathFor(id) !== null,
      sizeBytes,
    });
    this.commit();
    this.startNextIfIdle();

    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined) return;
    const ext = path.extname(mediaPath).replace(".", "") || "mp4";
    const cloudPath = cloudPathFor(item.title, id, ext);
    try {
      const data = new Uint8Array(readFileSync(mediaPath));
      await this.deps.uploadToCloud({
        path: cloudPath,
        contentType: ext === "webm" ? "video/webm" : "video/mp4",
        data,
        uploadId: `${VIDEO_UPLOAD_ID_PREFIX}${id}`,
      });
      if (this.stopped || this.items.every((entry) => entry.id !== id)) return;
      this.patch(id, {
        state: "ready",
        cloudPath,
        progressLabel: "Saved to cloud",
      });
      // The cross-device companions: poster + metadata sidecar, so another
      // device's reconcile can show the card and stream the video. Best-effort
      // — the video itself is already durable, and a missing sidecar only
      // means this item stays single-device until something re-writes it.
      void this.uploadCompanions(id).catch(() => undefined);
    } catch (err) {
      if (this.stopped || this.items.every((entry) => entry.id !== id)) return;
      // The video is watchable either way — a failed upload degrades to a
      // local-only save with an honest label, never a failed item.
      const message = err instanceof Error ? err.message : String(err);
      this.patch(id, {
        state: "ready",
        cloudPath: null,
        progressLabel: `Saved on this Mac — cloud upload unavailable (${message.slice(0, 120)})`,
      });
    }
    this.commit();
  }

  private async uploadCompanions(id: string): Promise<void> {
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined || item.cloudPath === null) return;
    const thumbPath = this.thumbnailPathFor(id);
    if (thumbPath !== null) {
      await this.deps.uploadToCloud({
        path: thumbCloudPathFor(id),
        contentType: "image/jpeg",
        data: new Uint8Array(readFileSync(thumbPath)),
        uploadId: `${VIDEO_UPLOAD_ID_PREFIX}thumb-${id}`,
      });
    }
    await this.deps.uploadToCloud({
      path: metaCloudPathFor(id),
      contentType: "application/json",
      data: new TextEncoder().encode(buildVideoSidecar(item)),
      uploadId: `${VIDEO_UPLOAD_ID_PREFIX}meta-${id}`,
    });
  }

  /* ----------------------------- cross-device ------------------------------ */

  /**
   * Pull videos other devices saved into this library: list the cloud
   * sidecars, fetch the ones this device has never seen, and add them as
   * cloud-only ready items (poster hydrated eagerly — it is small; the video
   * itself hydrates on first play). Safe to call any time; quietly a no-op
   * while signed out, mid-flight, or offline.
   */
  async reconcileWithCloud(): Promise<void> {
    if (this.stopped || this.reconciling) return;
    this.reconciling = true;
    try {
      const paths = await this.deps.listCloudPaths(VIDEOS_CLOUD_META_PREFIX);
      const known = new Set(this.items.map((item) => item.id));
      let added = false;
      for (const metaPath of paths) {
        const id = videoIdFromMetaPath(metaPath);
        if (id === null || known.has(id)) continue;
        let item: SavedVideo | null = null;
        try {
          const bytes = await this.deps.downloadFromCloud(metaPath);
          item = savedVideoFromSidecar(new TextDecoder().decode(bytes));
        } catch {
          continue; // one bad sidecar must not sink the reconcile
        }
        if (item === null || item.id !== id) continue;
        if (this.stopped) return;
        this.items = [item, ...this.items].slice(0, MAX_SAVED_VIDEOS);
        known.add(id);
        added = true;
        void this.hydrateThumbnail(id).catch(() => undefined);
      }
      if (added) this.commit();
    } catch {
      // Signed out / offline / control plane without Files — next call retries.
    } finally {
      this.reconciling = false;
    }
  }

  private async hydrateThumbnail(id: string): Promise<void> {
    if (this.thumbnailPathFor(id) !== null) return;
    const bytes = await this.deps.downloadFromCloud(thumbCloudPathFor(id));
    if (this.stopped || this.items.every((entry) => entry.id !== id)) return;
    writeFileSync(path.join(this.mediaDir, `${id}.jpg`), bytes);
    this.patch(id, { hasThumbnail: true });
    this.emit(true);
  }

  /**
   * The playback contract: an absolute path to this video's media file,
   * hydrating the cache from the cloud copy (manifest read-back → verified
   * chunks → reassembled file) when this device has never played it. Throws
   * a user-facing message when neither copy is reachable.
   */
  async ensureLocalMedia(id: string): Promise<string> {
    const cached = this.mediaPathFor(id);
    if (cached !== null) return cached;
    const item = this.items.find((entry) => entry.id === id);
    if (item === undefined) throw new Error("This video is no longer saved.");
    if (item.cloudPath === null) {
      throw new Error(
        "This video's file is missing from this Mac and has no cloud copy — remove it and save again.",
      );
    }
    if (this.hydrating.has(id)) {
      throw new Error("This video is still arriving from your cloud files — try again in a moment.");
    }
    this.hydrating.add(id);
    // The fetch is visible in the panel: ready items surface this label.
    this.patch(id, { progressLabel: "Fetching from your cloud files…" });
    this.emit(true);
    try {
      const bytes = await this.deps.downloadFromCloud(item.cloudPath);
      const ext = path.extname(item.cloudPath).replace(".", "") || "mp4";
      const target = path.join(this.mediaDir, `${id}.${ext}`);
      writeFileSync(target, bytes);
      this.patch(id, {
        progressLabel: "Saved to cloud",
        sizeBytes: bytes.byteLength,
      });
      this.commit();
      return target;
    } catch (err) {
      this.patch(id, { progressLabel: "In your cloud files" });
      this.emit(true);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Couldn't fetch this video from your cloud files — ${message}`);
    } finally {
      this.hydrating.delete(id);
    }
  }
}

/* --------------------------------- helpers --------------------------------- */

function hostTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Bundled tools first (packaged builds ship them under resources/Tools —
 * the Replay layout), then the usual install locations. Electron apps do not
 * inherit the user's shell PATH, so an explicit candidate list beats `which`.
 */
export function findSystemTool(name: string): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? "", "Tools", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const candidate of candidates) {
    try {
      if (candidate !== "" && statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

/** A PATH that lets yt-dlp find ffmpeg and friends on its own. */
function spawnEnv(): NodeJS.ProcessEnv {
  const extra = [
    path.join(process.resourcesPath ?? "", "Tools"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
    .filter((entry) => entry !== "Tools")
    .join(":");
  return { ...process.env, PATH: `${extra}:${process.env["PATH"] ?? ""}` };
}
