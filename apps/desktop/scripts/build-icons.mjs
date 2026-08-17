/**
 * Regenerate the app icon rasters from `build/icon.svg`.
 *
 * NOT part of `pnpm build` — run this by hand when `build/icon.svg` changes to
 * refresh the committed dev/production Dock raster and the local bundle icon:
 *
 *   node scripts/build-icons.mjs
 *
 * Requires ImageMagick (`brew install imagemagick`) for the SVG raster and
 * macOS `iconutil` for the .icns. Both are checked up front rather than
 * failing halfway with a broken iconset on disk.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "..", "build");
const svg = path.join(buildDir, "icon.svg");
const png = path.join(buildDir, "icon.png");
const icns = path.join(buildDir, "icon.icns");
const iconset = path.join(buildDir, "icon.iconset");

/** The sizes `iconutil` expects; anything missing makes it refuse the set. */
const ICONSET = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

function requireTool(bin, hint) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
  } catch {
    console.error(`error: ${bin} not found — ${hint}`);
    process.exit(1);
  }
}

if (!existsSync(svg)) {
  console.error(`error: ${svg} not found`);
  process.exit(1);
}
requireTool("magick", "install ImageMagick (brew install imagemagick)");
requireTool("iconutil", "this script needs macOS");

// High density first, then downsample: rasterizing straight to 1024 makes
// ImageMagick's SVG renderer hint the curves onto the target grid and the
// graticule's thin holes close up.
execFileSync("magick", [
  "-background", "none",
  "-density", "600",
  svg,
  "-resize", "1024x1024",
  "-depth", "8",
  "-strip",
  `PNG24:${png}`,
]);

rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const [size, name] of ICONSET) {
  execFileSync("magick", [
    png,
    "-resize", `${size}x${size}`,
    path.join(iconset, name),
  ]);
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
rmSync(iconset, { recursive: true, force: true });

console.log(`wrote ${path.relative(process.cwd(), png)}`);
console.log(`wrote ${path.relative(process.cwd(), icns)}`);
