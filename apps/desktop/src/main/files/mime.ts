/** Extension → content type, for the suma://files bundle and uploads. */

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
  zip: "application/zip",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  csv: "text/csv; charset=utf-8",
};

/** Null when the extension is unknown — callers decide their own default. */
export function contentTypeFor(pathname: string): string | null {
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return null;
  return TYPES[pathname.slice(dot + 1).toLowerCase()] ?? null;
}
