/**
 * The app icon (PRD §8.1 shell).
 *
 * The artwork is `build/icon.svg` — the site favicon's tile refitted to the
 * macOS icon grid — rasterized to `build/icon.png` and `build/icon.icns` by
 * `scripts/build-icons.mjs`.
 *
 * Finder, Spotlight, and the pre-launch Dock icon use the bundle's .icns.
 * macOS reserves an outer safe area around that asset, though, while a runtime
 * Dock image fills its slot. We therefore install the same full-bleed PNG at
 * runtime in both development and production. Both are generated from the
 * same SVG, so this is presentation-specific, not two independent sources.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { nativeImage, type App } from "electron";

/**
 * Where the 1024px raster can be, in order:
 *   1. `<app>/build/icon.png` relative to the built main bundle
 *      (`apps/desktop/out/main`) — a dev run.
 *   2. `<resources>/icon.png` in a packaged app.
 */
export function appIconCandidates(
  mainDirname: string,
  resourcesPath?: string,
): string[] {
  const candidates: string[] = [
    path.resolve(mainDirname, "../../build/icon.png"),
  ];
  if (resourcesPath !== undefined && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, "icon.png"));
  }
  return candidates;
}

/** First candidate that is actually on disk, or null. */
export function resolveAppIcon(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Give development and production the same full-bleed Dock icon. Silent when
 * there is nothing to set: a missing raster costs a wrong icon, and refusing
 * to boot over cosmetics would be the worse failure.
 */
export function applyDockIcon(
  electronApp: App,
  mainDirname: string,
  resourcesPath?: string,
): void {
  if (process.platform !== "darwin") return;
  const iconPath = resolveAppIcon(
    appIconCandidates(
      mainDirname,
      electronApp.isPackaged ? resourcesPath : undefined,
    ),
  );
  if (iconPath === null) return;
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return;
  electronApp.dock?.setIcon(image);
}
