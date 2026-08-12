/**
 * The app icon (PRD §8.1 shell).
 *
 * The artwork is `build/icon.svg` — the site favicon's tile refitted to the
 * macOS icon grid — rasterized to `build/icon.png` and `build/icon.icns` by
 * `scripts/build-icons.mjs`.
 *
 * A PACKAGED APP DOES NOT GO THROUGH HERE. macOS reads the bundle's .icns via
 * Info.plist before the app runs, which is the only way the icon is right in
 * the Finder, in Spotlight, and in the dock *while the app is still starting*.
 * Setting it from JS as well would leave two sources of truth and paper over a
 * packaging config that was wrong. So this runs in dev only, where there is no
 * bundle and Electron would otherwise show its own default icon.
 *
 * Packaging is not wired up yet (no electron-builder config in the repo); when
 * it is, point it at `build/icon.icns` and nothing here changes.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { nativeImage, type App } from "electron";

/**
 * Where the 1024px raster can be, in order:
 *   1. `<app>/build/icon.png` relative to the built main bundle
 *      (`apps/desktop/out/main`) — a dev run.
 *   2. `<resources>/icon.png` in a packaged app, for platforms that have no
 *      bundle-level icon to read.
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
 * Give a dev run the real dock icon. Silent when there is nothing to set: a
 * missing raster costs a wrong icon, and refusing to boot over cosmetics would
 * be the worse failure.
 */
export function applyDevDockIcon(electronApp: App, mainDirname: string): void {
  if (process.platform !== "darwin" || electronApp.isPackaged) return;
  const iconPath = resolveAppIcon(appIconCandidates(mainDirname));
  if (iconPath === null) return;
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return;
  electronApp.dock?.setIcon(image);
}
