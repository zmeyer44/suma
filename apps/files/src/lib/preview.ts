/**
 * Preview-type selection (§8.6: "text/image inline; everything else gets a
 * type + size"). Pure; unit-tested.
 *
 * The plan is decided before any bytes are requested, and it carries the byte
 * budget with it — the UI never reads a whole file just to decide it cannot
 * show it.
 */

export type PreviewKind = "text" | "image" | "none";

export type PreviewSkipReason = "unsupported" | "too_large" | "empty";

export interface PreviewSubject {
  path: string;
  contentType: string | null;
  sizeBytes: number;
}

export interface PreviewPlan {
  kind: PreviewKind;
  /** Human type name, always present: "PNG image", "Markdown", "ZIP archive". */
  typeLabel: string;
  /** Bytes to request from the bridge; 0 when nothing will be read. */
  readBytes: number;
  /** True when the preview shows only the head of a longer file. */
  truncated: boolean;
  /** Why there is no inline preview; null when there is one. */
  reason: PreviewSkipReason | null;
}

/** Enough to read a config file or a log head without hauling the whole file. */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

/** Images are all-or-nothing — a partial image decodes to garbage. */
export const IMAGE_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;

interface TypeInfo {
  label: string;
  kind: PreviewKind;
  /** Rendered MIME for the <img> blob, when kind === "image". */
  mime?: string;
}

/**
 * Extension table. SVG is deliberately typed as *text*: it is text, and
 * putting untrusted markup into an image element on a privileged page buys
 * nothing but risk.
 */
const BY_EXTENSION: Readonly<Record<string, TypeInfo>> = {
  txt: { label: "Plain text", kind: "text" },
  log: { label: "Log file", kind: "text" },
  md: { label: "Markdown", kind: "text" },
  markdown: { label: "Markdown", kind: "text" },
  json: { label: "JSON", kind: "text" },
  jsonl: { label: "JSON Lines", kind: "text" },
  yaml: { label: "YAML", kind: "text" },
  yml: { label: "YAML", kind: "text" },
  toml: { label: "TOML", kind: "text" },
  ini: { label: "INI config", kind: "text" },
  csv: { label: "CSV data", kind: "text" },
  tsv: { label: "TSV data", kind: "text" },
  xml: { label: "XML", kind: "text" },
  svg: { label: "SVG image (shown as text)", kind: "text" },
  html: { label: "HTML source", kind: "text" },
  css: { label: "CSS source", kind: "text" },
  js: { label: "JavaScript source", kind: "text" },
  mjs: { label: "JavaScript source", kind: "text" },
  cjs: { label: "JavaScript source", kind: "text" },
  ts: { label: "TypeScript source", kind: "text" },
  tsx: { label: "TypeScript source", kind: "text" },
  jsx: { label: "JavaScript source", kind: "text" },
  rs: { label: "Rust source", kind: "text" },
  py: { label: "Python source", kind: "text" },
  go: { label: "Go source", kind: "text" },
  rb: { label: "Ruby source", kind: "text" },
  sh: { label: "Shell script", kind: "text" },
  zsh: { label: "Shell script", kind: "text" },
  sql: { label: "SQL", kind: "text" },
  env: { label: "Environment file", kind: "text" },
  patch: { label: "Patch", kind: "text" },
  diff: { label: "Patch", kind: "text" },

  png: { label: "PNG image", kind: "image", mime: "image/png" },
  jpg: { label: "JPEG image", kind: "image", mime: "image/jpeg" },
  jpeg: { label: "JPEG image", kind: "image", mime: "image/jpeg" },
  gif: { label: "GIF image", kind: "image", mime: "image/gif" },
  webp: { label: "WebP image", kind: "image", mime: "image/webp" },
  avif: { label: "AVIF image", kind: "image", mime: "image/avif" },
  bmp: { label: "Bitmap image", kind: "image", mime: "image/bmp" },
  ico: { label: "Icon", kind: "image", mime: "image/x-icon" },

  pdf: { label: "PDF document", kind: "none" },
  zip: { label: "ZIP archive", kind: "none" },
  gz: { label: "Gzip archive", kind: "none" },
  tgz: { label: "Gzip archive", kind: "none" },
  tar: { label: "Tar archive", kind: "none" },
  dmg: { label: "Disk image", kind: "none" },
  pkg: { label: "Installer package", kind: "none" },
  mp4: { label: "MP4 video", kind: "none" },
  mov: { label: "QuickTime video", kind: "none" },
  mkv: { label: "Matroska video", kind: "none" },
  webm: { label: "WebM video", kind: "none" },
  mp3: { label: "MP3 audio", kind: "none" },
  wav: { label: "WAV audio", kind: "none" },
  flac: { label: "FLAC audio", kind: "none" },
  parquet: { label: "Parquet data", kind: "none" },
  sqlite: { label: "SQLite database", kind: "none" },
};

/** Content types that are text even though their subtype is not "text/*". */
const TEXTUAL_APPLICATION_TYPES: ReadonlyArray<string> = [
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/ecmascript",
  "application/x-ndjson",
  "application/x-sh",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "image/svg+xml",
];

const IMAGE_MIMES: ReadonlyArray<string> = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
];

/** Lowercased extension without the dot; "" when there is none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Strip parameters: "text/plain; charset=utf-8" → "text/plain". */
function baseMime(contentType: string | null): string {
  if (contentType === null) return "";
  const semi = contentType.indexOf(";");
  return (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

function fromContentType(contentType: string | null): TypeInfo | null {
  const mime = baseMime(contentType);
  if (mime.length === 0) return null;
  if (mime === "image/svg+xml") return { label: "SVG image (shown as text)", kind: "text" };
  if (IMAGE_MIMES.includes(mime)) {
    const subtype = mime.slice(mime.indexOf("/") + 1).replace(/^(x-|vnd\.microsoft\.)/, "");
    return { label: `${subtype.toUpperCase()} image`, kind: "image", mime };
  }
  if (mime.startsWith("text/")) {
    const subtype = mime.slice(5);
    return { label: subtype === "plain" ? "Plain text" : `${subtype.toUpperCase()} text`, kind: "text" };
  }
  if (TEXTUAL_APPLICATION_TYPES.includes(mime)) return { label: mime, kind: "text" };
  if (mime.startsWith("video/")) return { label: `${mime.slice(6).toUpperCase()} video`, kind: "none" };
  if (mime.startsWith("audio/")) return { label: `${mime.slice(6).toUpperCase()} audio`, kind: "none" };
  if (mime === "application/pdf") return { label: "PDF document", kind: "none" };
  return null;
}

/**
 * Resolve a type. The declared content type wins when it is recognized —
 * it came from the uploader, whereas an extension is only a hint — and the
 * extension table is the fallback.
 */
function resolveType(subject: PreviewSubject): TypeInfo {
  const declared = fromContentType(subject.contentType);
  if (declared !== null) return declared;
  const byExtension = BY_EXTENSION[extensionOf(subject.path)];
  if (byExtension !== undefined) return byExtension;
  const mime = baseMime(subject.contentType);
  if (mime.length > 0 && mime !== "application/octet-stream") return { label: mime, kind: "none" };
  return { label: "Binary file", kind: "none" };
}

/** Human type name for a file, whether or not it can be previewed. */
export function describeType(subject: PreviewSubject): string {
  return resolveType(subject).label;
}

/** MIME to hand the <img> blob; null when the file is not an inline image. */
export function imageMimeFor(subject: PreviewSubject): string | null {
  const info = resolveType(subject);
  return info.kind === "image" ? (info.mime ?? "application/octet-stream") : null;
}

/** Decide what (if anything) to render inline, and how many bytes that needs. */
export function planPreview(subject: PreviewSubject): PreviewPlan {
  const info = resolveType(subject);
  const size = Math.max(0, subject.sizeBytes);

  if (size === 0) {
    return { kind: "none", typeLabel: info.label, readBytes: 0, truncated: false, reason: "empty" };
  }
  if (info.kind === "text") {
    const readBytes = Math.min(size, TEXT_PREVIEW_MAX_BYTES);
    return {
      kind: "text",
      typeLabel: info.label,
      readBytes,
      truncated: size > TEXT_PREVIEW_MAX_BYTES,
      reason: null,
    };
  }
  if (info.kind === "image") {
    if (size > IMAGE_PREVIEW_MAX_BYTES) {
      return {
        kind: "none",
        typeLabel: info.label,
        readBytes: 0,
        truncated: false,
        reason: "too_large",
      };
    }
    return { kind: "image", typeLabel: info.label, readBytes: size, truncated: false, reason: null };
  }
  return { kind: "none", typeLabel: info.label, readBytes: 0, truncated: false, reason: "unsupported" };
}

/** One sentence explaining a `kind: "none"` plan. */
export function skipExplanation(plan: PreviewPlan): string {
  switch (plan.reason) {
    case "empty":
      return "This file is empty.";
    case "too_large":
      return "Too large to preview here — download it to open it.";
    case "unsupported":
      return "No inline preview for this type — download it to open it.";
    case null:
      return "";
  }
}
