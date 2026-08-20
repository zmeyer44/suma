/**
 * suma:// policy (PRD §8.1 "Privileged pages").
 *
 * Most privileged surfaces (settings, migration, and — Phase 2 — the
 * terminal, egress controls, and audit trail) are RENDERER ROUTES — overlays
 * inside the chrome WebContentsView — not suma:// documents, so there is
 * nothing to serve for them. To be explicit about the §8.1 posture: the
 * terminal is NOT a separate hardened WebContents; it renders inside the
 * chrome view, which runs no site content, ships no remote code, and cannot be
 * navigated to by tabs (guard (b) below).
 *
 * Phase 3 adds the first real suma:// document — `suma://files`, the Files
 * app (§8.6) — which IS a separate hardened WebContents with its own session
 * (files/files-window.ts) and is served by guard (d).
 *
 * This module keeps the scheme privileged and unreachable from site content:
 *   (a) the scheme is reserved as standard+secure so nothing else can claim
 *       or spoof it later,
 *   (b) tabs refuse suma:// navigation outright (tab-policy.ts guards
 *       will-navigate/will-redirect — site content can never navigate into
 *       privileged UI),
 *   (c) in dev, a CSP is injected for the chrome view's session because the
 *       Vite dev server sends none (packaged builds load local files and the
 *       renderer ships no remote code),
 *   (d) suma://files is served — under a strict CSP, from the built bundle
 *       only — on the Files page's OWN session, so no site session can reach
 *       the handler at all.
 */

import { protocol, type Session } from "electron";
import { createFilesProtocolHandler, type FilesBundle } from "./files/bundle";

/** Must run before app ready. */
export function registerSumaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "suma", privileges: { standard: true, secure: true } },
    // Saved-video playback (videos/video-protocol.ts): streamed into the PIP
    // and chrome views' <video>/<img> elements, so it needs stream + fetch
    // privileges. Handled only on the default session — space sessions never
    // get a handler, so site content has nothing to reach.
    {
      scheme: "suma-video",
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
      },
    },
    // IDE audio playback (workspace-media.ts): the same posture, over the
    // workspace instead of the media cache — every request re-resolves against
    // the root and must sniff as audio before a byte is served.
    {
      scheme: "suma-workspace",
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

/**
 * Byte-identical to the meta CSP in renderer/index.html (test/csp-parity
 * asserts this). Header and meta INTERSECT, so the meta — present in dev too,
 * since Vite serves the same index.html — already enforces the production
 * policy; a header any looser can never take effect, it can only mislead the
 * reader into believing dev allows something prod blocks. Keeping the header
 * equal to the meta means a renderer change that needs a new source fails in
 * dev exactly as it would in a shipped build. Vite's HMR websocket is
 * same-origin (ws://localhost:5173 from http://localhost:5173), which CSP3's
 * 'self' covers, so dev needs no extra allowance.
 */
export const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: suma-video:",
  "media-src 'self' blob: data: suma-video: suma-workspace:",
].join("; ");

/**
 * Serve suma://files from the Files page's session (§8.6). Registered on
 * that session alone: space sessions never get a handler for this scheme, so
 * site content has nothing to reach even if it could name the URL.
 */
export function installFilesProtocol(ses: Session, bundle: FilesBundle): void {
  ses.protocol.handle("suma", createFilesProtocolHandler(bundle));
}

/** Dev-only CSP injection for the chrome view (spec: §8.1). */
export function installChromeCsp(ses: Session): void {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl === undefined || devUrl.length === 0) return;
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [DEV_CSP],
      },
    });
  });
}
