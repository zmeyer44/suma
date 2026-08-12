/**
 * The suma://files privileged page (§8.1): what the scheme will serve, and
 * the IPC contract it is allowed to speak.
 *
 * The traversal guard is the load-bearing part — a privileged scheme that can
 * be walked out of with `..` would hand any file on disk a trusted origin.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFilesProtocolHandler,
  FILES_CSP,
  FILES_URL,
  filesBundleCandidates,
  placeholderHtml,
  resolveBundleFile,
  resolveFilesBundle,
} from "../src/main/files/bundle";
import { contentTypeFor } from "../src/main/files/mime";
import { parseDownloadPolicy } from "../src/main/files/prefs";
import {
  EVENT_CHANNELS,
  FILES_EVENT_CHANNELS,
  FILES_INVOKE_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
} from "../src/shared/ipc";

const BUNDLE = "/opt/suma/files/dist";

describe("resolveBundleFile", () => {
  it("serves index.html for the page root", () => {
    const lookup = resolveBundleFile(BUNDLE, FILES_URL);
    expect(lookup).toMatchObject({ ok: true, filePath: `${BUNDLE}/index.html` });
  });

  it("serves bundle assets with their content type", () => {
    const lookup = resolveBundleFile(BUNDLE, "suma://files/assets/index-abc.js");
    expect(lookup).toMatchObject({
      ok: true,
      filePath: `${BUNDLE}/assets/index-abc.js`,
      contentType: "text/javascript; charset=utf-8",
    });
  });

  it("refuses a percent-encoded escape from the bundle directory", () => {
    // URL parsing collapses dot segments before we ever see them — but an
    // encoded SLASH hides the whole `../../` from that normalization, and then
    // only this guard stands between the request and the filesystem.
    expect(resolveBundleFile(BUNDLE, "suma://files/%2e%2e%2f%2e%2e%2fetc/passwd")).toEqual({
      ok: false,
      status: 403,
    });
    expect(resolveBundleFile(BUNDLE, "suma://files/assets%2f..%2f..%2f..%2fid_rsa")).toEqual({
      ok: false,
      status: 403,
    });
  });

  it("never resolves a path outside the bundle, however the URL is written", () => {
    for (const url of [
      "suma://files/../../../etc/passwd",
      "suma://files/assets/../../../../root/.ssh/id_rsa",
      "suma://files/./assets/../index.html",
      "suma://files//etc/passwd",
    ]) {
      const lookup = resolveBundleFile(BUNDLE, url);
      if (lookup.ok) expect(lookup.filePath.startsWith(`${BUNDLE}/`)).toBe(true);
      else expect([403, 404]).toContain(lookup.status);
    }
  });

  it("serves nothing for any other suma:// host", () => {
    expect(resolveBundleFile(BUNDLE, "suma://settings/index.html")).toEqual({
      ok: false,
      status: 404,
    });
  });

  it("rejects a NUL-bearing path", () => {
    expect(resolveBundleFile(BUNDLE, "suma://files/a%00b.js")).toEqual({ ok: false, status: 404 });
  });
});

describe("bundle discovery", () => {
  it("looks beside the built main bundle for apps/files/dist", () => {
    const candidates = filesBundleCandidates("/repo/apps/desktop/out/main", "/app/Resources");
    expect(candidates).toContain("/repo/apps/files/dist");
    expect(candidates).toContain("/app/Resources/files");
  });

  it("says plainly that the bundle is missing, and how to build it", () => {
    const html = placeholderHtml(["/repo/apps/files/dist"]);
    expect(html).toContain("isn't built yet");
    expect(html).toContain("pnpm --filter @suma/files build");
    expect(html).toContain("/repo/apps/files/dist");
  });

  /**
   * The real thing, when the sibling app has been built: `apps/files` is a
   * separate workspace package, so this is skipped rather than failed when
   * `dist/` is absent — the placeholder path above covers that case.
   */
  const built = resolveFilesBundle(filesBundleCandidates(path.resolve(process.cwd(), "out/main")));
  it.skipIf(built.dir === null)("serves the built apps/files bundle", async () => {
    const handler = createFilesProtocolHandler(built);
    const page = await handler(new Request(`${FILES_URL}?device=abc`));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain('id="root"');
    expect((await handler(new Request("suma://files/assets/nope.js"))).status).toBe(404);
  });

  it("keeps the page under a no-remote-code CSP", () => {
    expect(FILES_CSP).toContain("default-src 'none'");
    expect(FILES_CSP).toContain("script-src 'self'");
    expect(FILES_CSP).not.toContain("unsafe-eval");
    expect(FILES_CSP).toContain("frame-ancestors 'none'");
  });
});

describe("content types", () => {
  it("maps the extensions the bundle and previews use", () => {
    expect(contentTypeFor("/a/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/a/style.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/a/logo.SVG")).toBe("image/svg+xml");
    expect(contentTypeFor("/a/noextension")).toBeNull();
  });
});

describe("download policy preference (§8.6 alwaysLocal)", () => {
  it("defaults to allowing cloud routing and only honours an explicit true", () => {
    expect(parseDownloadPolicy("{}").alwaysLocal).toBe(false);
    expect(parseDownloadPolicy("not json").alwaysLocal).toBe(false);
    expect(parseDownloadPolicy('{"downloadsAlwaysLocal":"yes"}').alwaysLocal).toBe(false);
    expect(parseDownloadPolicy('{"downloadsAlwaysLocal":true}').alwaysLocal).toBe(true);
  });
});

describe("IPC contract", () => {
  // Compile-time cross-check: the typed maps and the runtime allowlists are
  // the preload's security boundary, so drift between them must not compile.
  type MissingInvoke = Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>;
  type ExtraInvoke = Exclude<(typeof INVOKE_CHANNELS)[number], InvokeChannel>;
  type MissingEvent = Exclude<EventChannel, (typeof EVENT_CHANNELS)[number]>;
  type ExtraEvent = Exclude<(typeof EVENT_CHANNELS)[number], EventChannel>;
  const channelsInSync: [MissingInvoke, ExtraInvoke, MissingEvent, ExtraEvent] extends
    [never, never, never, never]
    ? true
    : false = true;

  it("keeps the channel maps and the allowlist arrays in sync", () => {
    expect(channelsInSync).toBe(true);
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length);
  });

  it("gives the Files page only the files/transfers channels", () => {
    // Spelled out rather than derived, so ADDING a channel to the Files page
    // is a deliberate edit here and not something a refactor can do quietly.
    expect([...FILES_INVOKE_CHANNELS].sort()).toEqual([
      // Device names for the transfers list — no device credentials.
      "files:context",
      "files:delete",
      "files:download",
      "files:list",
      "files:quota",
      // Bounded read backing inline preview (§8.6 "browse, preview").
      "files:read",
      "files:stat",
      "files:upload",
      "transfers:cancel",
      "transfers:list",
    ]);
    expect([...FILES_EVENT_CHANNELS].sort()).toEqual([
      "files:changed",
      // Real per-chunk upload progress, rather than a spinner that lies.
      "files:uploadProgress",
      "transfers:updated",
    ]);
    for (const channel of FILES_INVOKE_CHANNELS) expect(INVOKE_CHANNELS).toContain(channel);
    for (const channel of FILES_EVENT_CHANNELS) expect(EVENT_CHANNELS).toContain(channel);
    // Nothing from the browser chrome leaks into the privileged page's bridge.
    expect(FILES_INVOKE_CHANNELS as ReadonlyArray<string>).not.toContain("tabs:navigate");
    expect(FILES_INVOKE_CHANNELS as ReadonlyArray<string>).not.toContain("credentials:fill");
  });
});
