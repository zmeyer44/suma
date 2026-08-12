/**
 * Generates the DMG installer background (build/background.png + @2x) with
 * gpt-image-2 through the Vercel AI Gateway, then sizes it for the 660x400
 * installer window electron-builder.yml declares.
 *
 * One-shot asset script in the spirit of build-icons.mjs: run by hand, output
 * committed. Requires AI_GATEWAY_API_KEY (read from the repo-root .env if not
 * already in the environment) and ImageMagick (`magick`).
 *
 *   node scripts/generate-dmg-background.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateway, generateImage } from "ai";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "..", "build");
const repoRoot = path.join(here, "..", "..", "..");

// The installer window is 660x400 points; ship a 2x raster for retina and
// derive the 1x from it. dmg-builder folds background.png + background@2x.png
// into one HiDPI tiff at build time.
const WINDOW = { width: 660, height: 400 };

for (const key of ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"]) {
  if (process.env[key]) break;
  const envFile = path.join(repoRoot, ".env");
  if (!existsSync(envFile)) continue;
  const match = readFileSync(envFile, "utf8").match(
    new RegExp(`^${key}=(.+)$`, "m"),
  );
  if (match) process.env[key] = match[1].trim();
}

// The prompt draws only the ground: Finder composites the real app icon and
// the Applications alias on top at the positions in electron-builder.yml, so
// the image needs an arrow between two clear landing spots, nothing else.
const PROMPT = `A macOS DMG disk-image installer window background, 3:2 landscape, flat minimal vector style.

Ground: a warm off-white bone paper color (#F3F1EA), completely flat, with an extremely subtle light-gray graph-paper grid of thin lines (barely visible, around 4% opacity, square cells).

Composition: left third and right third are empty open space (real icons will be placed there later — do not draw any icons, folders, or app logos). Dead center, a single bold horizontal arrow pointing to the right, drawn in a deep royal blue (#4353D9), geometric and squared-off, like a technical wayfinding arrow. The arrow is the only strong element.

At the top center, small uppercase text "DRAG TO APPLICATIONS" in a clean condensed industrial sans-serif, letter-spaced wide, in the same royal blue. Nothing else. No other text, no icons, no shadows, no gradients, no borders, no window chrome.

Style: Swiss technical editorial, precise, calm, professional software installer. Flat color only.`;

async function main() {
  console.log("Generating DMG background with openai/gpt-image-2…");
  const { image } = await generateImage({
    model: gateway.imageModel("openai/gpt-image-2"),
    prompt: PROMPT,
    size: "1536x1024",
  });

  const raw = path.join(buildDir, "background-raw.png");
  writeFileSync(raw, image.uint8Array);
  console.log(`Wrote ${raw}`);

  const at2x = path.join(buildDir, "background@2x.png");
  const at1x = path.join(buildDir, "background.png");
  const size2x = `${WINDOW.width * 2}x${WINDOW.height * 2}`;
  // 3:2 source → 33:20 window: fill the window and crop the overflow evenly.
  execFileSync("magick", [
    raw,
    "-resize",
    `${size2x}^`,
    "-gravity",
    "center",
    "-extent",
    size2x,
    at2x,
  ]);
  execFileSync("magick", [
    at2x,
    "-resize",
    `${WINDOW.width}x${WINDOW.height}`,
    at1x,
  ]);
  unlinkSync(raw);
  console.log(`Wrote ${at1x} and ${at2x}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
