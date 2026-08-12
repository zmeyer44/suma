/**
 * Serving the built `apps/files` bundle at `suma://files` (PRD §8.1
 * privileged pages, §8.6 Files).
 *
 * The Files app is a real privileged page — its own hardened WebContents, its
 * own session, no site content — so `suma://files` is a real document
 * origin, not a renderer overlay. That makes two things this module's job:
 * locating the built bundle on disk, and answering requests for it without
 * ever escaping the bundle directory.
 *
 * If the bundle has not been built (apps/files is a separate workspace app and
 * `dist/` only exists after `pnpm --filter @suma/files build`), the page says
 * so plainly. Serving a blank window, or claiming the app is "coming soon",
 * would hide a build step the developer can fix in one command.
 *
 * Verification status, stated rather than assumed: bundle discovery, the
 * traversal guard, the served responses and the placeholder are exercised
 * directly in tests (including against the real `apps/files/dist`). Electron's
 * own `protocol.handle` plumbing around them has NOT been run in this stream —
 * no Electron build or launch was performed here.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contentTypeFor } from "./mime";

/** The one origin this scheme serves. */
export const FILES_HOST = "files";
export const FILES_URL = `suma://${FILES_HOST}/`;

/**
 * Strict CSP for the privileged page: local bundle only, no remote code, no
 * network of its own (everything reaches main through the preload bridge).
 * `style-src` allows inline styles because the bundler injects them.
 */
export const FILES_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface FilesBundle {
  /** Absolute path to the built bundle, or null when it is not on disk. */
  dir: string | null;
  /** Where we looked — shown in the placeholder so the fix is obvious. */
  searched: string[];
}

/**
 * Where the built bundle can be, in order:
 *   1. `<repo>/apps/files/dist` relative to the built main bundle
 *      (`apps/desktop/out/main`), which is how a dev run and a monorepo
 *      checkout find it.
 *   2. `<resources>/files` in a packaged app.
 */
export function filesBundleCandidates(mainDirname: string, resourcesPath?: string): string[] {
  const candidates: string[] = [path.resolve(mainDirname, "../../../files/dist")];
  if (resourcesPath !== undefined && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, "files"));
  }
  return candidates;
}

/** First candidate that actually contains a built index.html. */
export function resolveFilesBundle(candidates: string[]): FilesBundle {
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) return { dir: candidate, searched: candidates };
  }
  return { dir: null, searched: candidates };
}

export type BundleLookup =
  | { ok: true; filePath: string; contentType: string }
  | { ok: false; status: 403 | 404 };

/**
 * Map a suma://files URL to a file inside the bundle. Pure — the traversal
 * guard is the interesting part and is unit-tested: a privileged scheme that
 * can be walked out of with `..` would hand any local file a trusted origin.
 */
export function resolveBundleFile(dir: string, requestUrl: string): BundleLookup {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, status: 404 };
  }
  if (url.hostname !== FILES_HOST) return { ok: false, status: 404 };

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 404 };
  }
  if (pathname.includes("\0")) return { ok: false, status: 404 };

  const relative = pathname.replace(/^\/+/, "");
  const root = path.resolve(dir);
  const target = path.resolve(root, relative.length === 0 ? "index.html" : relative);
  if (target !== root && !target.startsWith(root + path.sep)) return { ok: false, status: 403 };
  return { ok: true, filePath: target, contentType: contentTypeFor(target) ?? "application/octet-stream" };
}

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": FILES_CSP },
  });
}

/**
 * The `protocol.handle` callback for the suma: scheme on the Files session.
 * Only the `files` host is served; everything else 404s, so no other suma://
 * host can be squatted through this handler.
 */
export function createFilesProtocolHandler(bundle: FilesBundle): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (bundle.dir === null) return htmlResponse(placeholderHtml(bundle.searched), 200);
    const lookup = resolveBundleFile(bundle.dir, request.url);
    if (!lookup.ok) {
      return htmlResponse(
        lookup.status === 403 ? "<h1>Forbidden</h1>" : "<h1>Not found</h1>",
        lookup.status,
      );
    }
    try {
      const body = await readFile(lookup.filePath);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          "content-type": lookup.contentType,
          "content-security-policy": FILES_CSP,
          "cache-control": "no-cache",
        },
      });
    } catch {
      // Client-side routes have no file of their own — serve the shell. A
      // missing ASSET (has an extension) is a real 404 and is reported as one.
      if (path.extname(lookup.filePath).length > 0) return htmlResponse("<h1>Not found</h1>", 404);
      try {
        const shell = await readFile(path.join(bundle.dir, "index.html"), "utf8");
        return htmlResponse(shell, 200);
      } catch {
        return htmlResponse(placeholderHtml(bundle.searched), 200);
      }
    }
  };
}

/** Honest placeholder: what is missing, and the command that fixes it. */
export function placeholderHtml(searched: string[]): string {
  const paths = searched.map((dir) => `<li><code>${escapeHtml(dir)}</code></li>`).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Suma Files</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; padding: 48px; background: #0f1115; color: #e6e8ee;
             font: 14px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      p { color: #9aa3b2; max-width: 60ch; }
      code { background: #191c24; border-radius: 6px; padding: 2px 6px; font-size: 12.5px; }
      ul { color: #6f7787; font-size: 12.5px; }
    </style>
  </head>
  <body>
    <h1>The Files app isn't built yet</h1>
    <p>
      <code>suma://files</code> serves the built <code>apps/files</code> bundle. This window is
      the privileged page itself — the page loaded, the bundle did not.
    </p>
    <p>Build it with <code>pnpm --filter @suma/files build</code>, then reopen this window.</p>
    <p>Looked for <code>index.html</code> in:</p>
    <ul>${paths}</ul>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
