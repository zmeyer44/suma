import { describe, expect, it } from "vitest";
import type { ContentBounds } from "../src/shared/ipc";
import {
  canonicalVideoUrl,
  matchesVideosQuery,
  type SavedVideo,
} from "../src/shared/videos";
import {
  buildPositionRecord,
  buildVideoSidecar,
  buildYtDlpArgs,
  clampPipBounds,
  cloudPathFor,
  defaultPipBounds,
  findMediaFile,
  findThumbnailFile,
  mediaContentType,
  metaCloudPathFor,
  parsePositionRecord,
  parseRangeHeader,
  parseSavedVideosFile,
  parseYtDlpLine,
  PIP_MARGIN,
  PIP_MIN_WIDTH,
  pipHeightFor,
  positionCloudPathFor,
  sanitizeSavedVideo,
  savedVideoFromSidecar,
  splitStreamLines,
  videoIdFromMetaPath,
} from "../src/main/videos/videos-core";
import { resolveVideoRequest } from "../src/main/videos/video-protocol";

/* ------------------------------ URL detection ------------------------------ */

describe("canonicalVideoUrl", () => {
  it("canonicalizes the youtu.be short form", () => {
    expect(canonicalVideoUrl("https://youtu.be/abc123XYZ")).toEqual({
      url: "https://www.youtube.com/watch?v=abc123XYZ",
      source: "youtube",
    });
  });

  it("strips tracking params and timestamps from watch URLs", () => {
    expect(
      canonicalVideoUrl(
        "https://www.youtube.com/watch?v=abc123XYZ&t=45s&list=PL123&si=track",
      ),
    ).toEqual({
      url: "https://www.youtube.com/watch?v=abc123XYZ",
      source: "youtube",
    });
  });

  it("handles shorts, live, embed, and subdomains", () => {
    for (const url of [
      "https://www.youtube.com/shorts/abc123XYZ",
      "https://youtube.com/live/abc123XYZ",
      "https://m.youtube.com/watch?v=abc123XYZ",
      "https://www.youtube.com/embed/abc123XYZ",
    ]) {
      expect(canonicalVideoUrl(url)?.url).toBe(
        "https://www.youtube.com/watch?v=abc123XYZ",
      );
    }
  });

  it("normalizes twitter.com to x.com status URLs", () => {
    expect(
      canonicalVideoUrl("https://twitter.com/someone/status/1234567890?s=20"),
    ).toEqual({ url: "https://x.com/someone/status/1234567890", source: "x" });
    expect(
      canonicalVideoUrl("https://x.com/someone/status/1234567890/video/1"),
    ).toEqual({ url: "https://x.com/someone/status/1234567890", source: "x" });
  });

  it("collapses duplicate spellings to one canonical form", () => {
    const a = canonicalVideoUrl("https://youtu.be/abc123XYZ");
    const b = canonicalVideoUrl(
      "https://www.youtube.com/watch?v=abc123XYZ&t=45",
    );
    expect(a?.url).toBe(b?.url);
  });

  it("rejects non-video pages on the same hosts", () => {
    expect(canonicalVideoUrl("https://www.youtube.com/")).toBeNull();
    expect(canonicalVideoUrl("https://www.youtube.com/@channel")).toBeNull();
    expect(canonicalVideoUrl("https://x.com/someone")).toBeNull();
    expect(canonicalVideoUrl("https://x.com/home")).toBeNull();
  });

  it("rejects other sites, schemes, and junk", () => {
    expect(canonicalVideoUrl("https://vimeo.com/12345")).toBeNull();
    expect(canonicalVideoUrl("suma://settings")).toBeNull();
    expect(canonicalVideoUrl("not a url")).toBeNull();
    // Host merely containing the site name must not match.
    expect(canonicalVideoUrl("https://notyoutube.com/watch?v=abc123XYZ")).toBeNull();
    expect(canonicalVideoUrl("https://youtube.com.evil.example/watch?v=abc")).toBeNull();
  });
});

/* ------------------------------ line protocol ------------------------------ */

describe("parseYtDlpLine", () => {
  it("parses progress lines into fraction + label", () => {
    const event = parseYtDlpLine("WL_PROGRESS\t 42.3%\t1.20MiB/s\t00:31");
    expect(event).toEqual({
      kind: "progress",
      fraction: 0.423,
      label: "42.3% · 1.20MiB/s · ETA 00:31",
    });
  });

  it("drops NA speed/eta fields from the label and clamps the fraction", () => {
    const event = parseYtDlpLine("WL_PROGRESS\t100.0%\tNA\tNA");
    expect(event).toEqual({ kind: "progress", fraction: 1, label: "100.0%" });
  });

  it("parses metadata with JSON-encoded fields (tabs and quotes survive)", () => {
    const title = JSON.stringify('A "quoted"\ttitle');
    const event = parseYtDlpLine(`WL_META\t${title}\t"Channel"\t123.5`);
    expect(event).toEqual({
      kind: "meta",
      title: 'A "quoted" title',
      author: "Channel",
      duration: 123.5,
    });
  });

  it("treats null/NA metadata fields as absent", () => {
    const event = parseYtDlpLine('WL_META\t"T"\tnull\tNA');
    expect(event).toEqual({ kind: "meta", title: "T", author: null, duration: null });
  });

  it("parses the done line with its shifted field offset", () => {
    const event = parseYtDlpLine(
      'WL_DONE\t"/tmp/media/abc.mp4"\t"T"\t"A"\t60',
    );
    expect(event).toEqual({
      kind: "done",
      filepath: "/tmp/media/abc.mp4",
      title: "T",
      author: "A",
      duration: 60,
    });
  });

  it("ignores ordinary yt-dlp chatter", () => {
    expect(parseYtDlpLine("[download] Destination: x.mp4")).toBeNull();
    expect(parseYtDlpLine("")).toBeNull();
  });
});

describe("splitStreamLines", () => {
  it("buffers partial lines across chunks", () => {
    const first = splitStreamLines("", "WL_PROGRESS\t10%\tA\tB\nWL_PRO");
    expect(first.lines).toEqual(["WL_PROGRESS\t10%\tA\tB"]);
    expect(first.pending).toBe("WL_PRO");
    const second = splitStreamLines(first.pending, "GRESS\t20%\tC\tD\n");
    expect(second.lines).toEqual(["WL_PROGRESS\t20%\tC\tD"]);
    expect(second.pending).toBe("");
  });

  it("handles CRLF and drops blank lines", () => {
    const { lines } = splitStreamLines("", "a\r\n\r\nb\n");
    expect(lines).toEqual(["a", "b"]);
  });
});

/* ------------------------------ argument vector ----------------------------- */

describe("buildYtDlpArgs", () => {
  it("uses the merged format and thumbnail conversion when ffmpeg exists", () => {
    const args = buildYtDlpArgs({
      url: "https://www.youtube.com/watch?v=abc",
      id: "id-1",
      destDir: "/cache",
      ffmpegDir: "/opt/homebrew/bin",
    });
    expect(args).toContain("--merge-output-format");
    expect(args).toContain("--ffmpeg-location");
    expect(args[args.length - 1]).toBe("https://www.youtube.com/watch?v=abc");
    expect(args).toContain("id-1.%(ext)s");
    expect(args).toContain("--no-playlist");
  });

  it("falls back to a pre-merged single format without ffmpeg", () => {
    const args = buildYtDlpArgs({
      url: "https://x.com/a/status/1",
      id: "id-2",
      destDir: "/cache",
      ffmpegDir: null,
    });
    expect(args).not.toContain("--merge-output-format");
    expect(args).not.toContain("--ffmpeg-location");
    expect(args[args.indexOf("--format") + 1]).toBe("b[ext=mp4]/best");
  });
});

/* -------------------------------- media files ------------------------------- */

describe("media file discovery", () => {
  const files = ["a1.mp4", "a1.jpg", "b2.webm", "c3.webp", "unrelated.txt"];

  it("finds video and thumbnail files by id", () => {
    expect(findMediaFile("a1", files)).toBe("a1.mp4");
    expect(findMediaFile("b2", files)).toBe("b2.webm");
    expect(findMediaFile("c3", files)).toBeNull();
    expect(findThumbnailFile("a1", files)).toBe("a1.jpg");
    expect(findThumbnailFile("c3", files)).toBe("c3.webp");
  });

  it("maps extensions to content types", () => {
    expect(mediaContentType("a.mp4")).toBe("video/mp4");
    expect(mediaContentType("a.webm")).toBe("video/webm");
    expect(mediaContentType("a.jpg")).toBe("image/jpeg");
    expect(mediaContentType("weird.bin")).toBe("application/octet-stream");
  });

  it("builds readable, collision-safe cloud paths", () => {
    expect(cloudPathFor("My Great Video!", "abcdef12-3456", "mp4")).toBe(
      "/Videos/my-great-video-abcdef12.mp4",
    );
    expect(cloudPathFor("", "abcdef12", "mp4")).toBe("/Videos/abcdef12.mp4");
    expect(cloudPathFor("日本語のみ", "abcdef12", "mp4")).toBe(
      "/Videos/abcdef12.mp4",
    );
  });
});

/* ------------------------------ range requests ------------------------------ */

describe("parseRangeHeader", () => {
  it("resolves open-ended, bounded, and suffix ranges", () => {
    expect(parseRangeHeader("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRangeHeader("bytes=-25", 100)).toEqual({ start: 75, end: 99 });
  });

  it("clamps ends past the file and refuses nonsense", () => {
    expect(parseRangeHeader("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRangeHeader("bytes=200-", 100)).toBeNull();
    expect(parseRangeHeader("bytes=20-10", 100)).toBeNull();
    expect(parseRangeHeader(null, 100)).toBeNull();
    expect(parseRangeHeader("chunks=1-2", 100)).toBeNull();
    expect(parseRangeHeader("bytes=-", 100)).toBeNull();
  });
});

describe("resolveVideoRequest", () => {
  const files = ["vid-1.mp4", "vid-1.jpg"];

  it("resolves media and thumb URLs to cache files", () => {
    expect(resolveVideoRequest("suma-video://media/vid-1", files)).toEqual({
      filename: "vid-1.mp4",
    });
    expect(resolveVideoRequest("suma-video://thumb/vid-1", files)).toEqual({
      filename: "vid-1.jpg",
    });
  });

  it("refuses traversal, unknown kinds, and unknown ids", () => {
    expect(resolveVideoRequest("suma-video://media/../secrets", files)).toBeNull();
    expect(resolveVideoRequest("suma-video://media/vid%2F..%2Fx", files)).toBeNull();
    expect(resolveVideoRequest("suma-video://other/vid-1", files)).toBeNull();
    expect(resolveVideoRequest("suma-video://media/nope", files)).toBeNull();
  });
});

/* -------------------------------- PIP layout -------------------------------- */

describe("PIP layout", () => {
  const hole: ContentBounds = { x: 0, y: 48, width: 1200, height: 700 };

  it("places a fresh player bottom-right, 16:9, inside the hole", () => {
    const bounds = defaultPipBounds(hole);
    expect(bounds.width).toBe(480);
    expect(bounds.height).toBe(pipHeightFor(480));
    expect(bounds.x + bounds.width).toBe(hole.x + hole.width - PIP_MARGIN);
    expect(bounds.y + bounds.height).toBe(hole.y + hole.height - PIP_MARGIN);
  });

  it("clamps a dragged player back inside the hole", () => {
    const clamped = clampPipBounds(
      { x: -500, y: -500, width: 480, height: 270 },
      hole,
    );
    expect(clamped.x).toBe(hole.x + PIP_MARGIN);
    expect(clamped.y).toBe(hole.y + PIP_MARGIN);
  });

  it("enforces the minimum width and keeps the aspect on resize", () => {
    const clamped = clampPipBounds({ x: 20, y: 60, width: 50, height: 28 }, hole);
    expect(clamped.width).toBe(PIP_MIN_WIDTH);
    expect(clamped.height).toBe(pipHeightFor(PIP_MIN_WIDTH));
  });

  it("shrinks to fit a short content hole without breaking aspect", () => {
    const short: ContentBounds = { x: 0, y: 48, width: 1200, height: 220 };
    const bounds = defaultPipBounds(short);
    expect(bounds.height).toBeLessThanOrEqual(short.height - PIP_MARGIN * 2);
    expect(Math.abs(bounds.width / bounds.height - 16 / 9)).toBeLessThan(0.02);
  });
});

/* -------------------------------- persistence ------------------------------- */

describe("saved-video persistence", () => {
  const ready = {
    id: "abc-123",
    url: "https://www.youtube.com/watch?v=abc",
    source: "youtube",
    title: "T",
    author: "A",
    duration: 60,
    state: "ready",
    progress: 1,
    progressLabel: "Saved to cloud",
    error: null,
    cloudPath: "/Videos/t-abc.mp4",
    hasThumbnail: true,
    sizeBytes: 1000,
    playbackPosition: 12,
    savedAtMs: 5,
  };

  it("round-trips a ready item", () => {
    const parsed = parseSavedVideosFile(JSON.stringify({ items: [ready] }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "abc-123",
      state: "ready",
      cloudPath: "/Videos/t-abc.mp4",
      playbackPosition: 12,
    });
  });

  it("loads items persisted mid-download as failed with a retry hint", () => {
    const parsed = parseSavedVideosFile(
      JSON.stringify({ items: [{ ...ready, state: "downloading" }] }),
    );
    expect(parsed[0]?.state).toBe("failed");
    expect(parsed[0]?.error).toContain("Interrupted");
  });

  it("drops malformed rows and unparseable files", () => {
    expect(sanitizeSavedVideo(null)).toBeNull();
    expect(sanitizeSavedVideo({ id: "x" })).toBeNull();
    expect(sanitizeSavedVideo({ ...ready, id: "../evil" })).toBeNull();
    expect(sanitizeSavedVideo({ ...ready, source: "vimeo" })).toBeNull();
    expect(parseSavedVideosFile("not json")).toEqual([]);
    expect(parseSavedVideosFile("[]")).toEqual([]);
  });
});

/* ------------------------------ cloud sidecars ------------------------------ */

describe("cloud sidecars (cross-device library)", () => {
  const item = {
    id: "abc-123",
    url: "https://www.youtube.com/watch?v=abc",
    source: "youtube" as const,
    title: "T",
    author: "A",
    duration: 60,
    state: "ready" as const,
    progress: 1,
    progressLabel: "Saved to cloud",
    error: null,
    cloudPath: "/Videos/t-abc.mp4",
    hasThumbnail: true,
    sizeBytes: 1000,
    playbackPosition: 12,
    positionAtMs: 99,
    savedAtMs: 5,
  };

  it("round-trips an item through its sidecar as a cloud-only entry", () => {
    const decoded = savedVideoFromSidecar(buildVideoSidecar(item));
    expect(decoded).toMatchObject({
      id: "abc-123",
      url: item.url,
      source: "youtube",
      title: "T",
      author: "A",
      duration: 60,
      state: "ready",
      cloudPath: "/Videos/t-abc.mp4",
      sizeBytes: 1000,
      savedAtMs: 5,
    });
    // Nothing is cached on the reading device yet: the poster hydrates
    // separately, and claiming one now would render a broken image.
    expect(decoded?.hasThumbnail).toBe(false);
    expect(decoded?.progressLabel).toBe("In your cloud files");
  });

  it("rejects sidecars without a cloud copy, and junk", () => {
    expect(savedVideoFromSidecar(buildVideoSidecar({ ...item, cloudPath: null }))).toBeNull();
    expect(savedVideoFromSidecar("not json")).toBeNull();
    expect(savedVideoFromSidecar("{}")).toBeNull();
  });

  it("round-trips a position record, refusing junk", () => {
    expect(positionCloudPathFor("abc-123")).toBe("/Videos/.positions/abc-123.json");
    const json = buildPositionRecord({ id: "abc-123", position: 42.5, updatedAtMs: 1000 });
    expect(parsePositionRecord(json)).toEqual({ position: 42.5, updatedAtMs: 1000 });
    expect(parsePositionRecord("not json")).toBeNull();
    expect(parsePositionRecord("{}")).toBeNull();
    expect(parsePositionRecord('{"position":-1,"updatedAtMs":5}')).toBeNull();
    expect(parsePositionRecord('{"position":3,"updatedAtMs":0}')).toBeNull();
    expect(parsePositionRecord('{"position":"3","updatedAtMs":5}')).toBeNull();
  });

  it("maps meta paths to ids and back, refusing traversal", () => {
    expect(metaCloudPathFor("abc-123")).toBe("/Videos/.meta/abc-123.json");
    expect(videoIdFromMetaPath("/Videos/.meta/abc-123.json")).toBe("abc-123");
    expect(videoIdFromMetaPath("/Videos/.meta/../../etc.json")).toBeNull();
    expect(videoIdFromMetaPath("/Videos/clip.mp4")).toBeNull();
    expect(videoIdFromMetaPath("/Videos/.meta/x.txt")).toBeNull();
  });
});

/* --------------------------------- search ----------------------------------- */

describe("matchesVideosQuery", () => {
  const item: SavedVideo = {
    id: "1",
    url: "https://www.youtube.com/watch?v=abc",
    source: "youtube",
    title: "Rust for TypeScript developers",
    author: "Good Channel",
    duration: 60,
    state: "ready",
    progress: 1,
    progressLabel: "",
    error: null,
    cloudPath: null,
    hasThumbnail: false,
    sizeBytes: null,
    playbackPosition: 0,
    positionAtMs: 0,
    savedAtMs: 0,
  };

  it("matches every term across title, author, url, and source", () => {
    expect(matchesVideosQuery(item, "rust channel")).toBe(true);
    expect(matchesVideosQuery(item, "youtube")).toBe(true);
    expect(matchesVideosQuery(item, "")).toBe(true);
    expect(matchesVideosQuery(item, "rust python")).toBe(false);
  });
});
