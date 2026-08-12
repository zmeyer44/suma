/**
 * Certificate-error handling (PRD §8.1 certificate-error UI).
 *
 * Phase 1 FAILS CLOSED: the load is always rejected — no click-through, and
 * deliberately NO override IPC channel exists. The renderer only shows a
 * banner from `security:certError`. A click-through would let one mistyped
 * proxy or captive portal read authenticated sessions Suma exists to
 * protect; revisit only with a scoped, expiring exception design.
 */

import { app } from "electron";
import type { CertErrorInfo } from "../shared/ipc";

export function hostForUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function registerCertificateErrorHandler(emit: (info: CertErrorInfo) => void): void {
  app.on("certificate-error", (_event, _webContents, url, error, _certificate, callback) => {
    // Never event.preventDefault(): Chromium's default distrust stands, and
    // the explicit callback(false) keeps the rejection unambiguous.
    callback(false);
    emit({ host: hostForUrl(url), url, error, atMs: Date.now() });
  });
}
