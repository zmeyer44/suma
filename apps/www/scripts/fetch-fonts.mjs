/**
 * Puts the display-face woff2 files in src/fonts/ before next runs.
 *
 * Industry is a commercially licensed typeface, so the real files are not in
 * the repository. `next/font/local` needs them on disk at build time, which
 * leaves two sources:
 *
 *  - FONTS_BASE_URL set (the deployment): each file is fetched from
 *    `${FONTS_BASE_URL}/<name>`, sent with `Authorization: Bearer $FONTS_TOKEN`
 *    when a token is set. Private R2/S3 bucket, Vercel Blob — anything that
 *    serves the four files over HTTPS works.
 *
 *  - FONTS_BASE_URL unset (a contributor checkout): the committed fallback —
 *    Saira, SIL OFL, see fallback/OFL.txt — is copied into place under the
 *    Industry filenames. Saira ships as a variable font, so one file serves
 *    every weight; the @font-face weight descriptor pins the axis.
 *
 * `.fonts-source` records which source produced the current files, so a
 * checkout that built with the fallback upgrades itself the first time it
 * runs with credentials (and vice versa) instead of skipping forever.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "fonts");
const FALLBACK = path.join(FONTS_DIR, "fallback", "Saira-Variable.woff2");
const MARKER = path.join(FONTS_DIR, ".fonts-source");

const FILES = [
  "Industry-SemiBold.woff2",
  "Industry-Bold.woff2",
  "Industry-ExtraBold.woff2",
  "Industry-Black.woff2",
];

const baseUrl = process.env.FONTS_BASE_URL?.replace(/\/$/, "");
const current = existsSync(MARKER) ? readFileSync(MARKER, "utf8").trim() : null;
const missing = FILES.filter((name) => !existsSync(path.join(FONTS_DIR, name)));

mkdirSync(FONTS_DIR, { recursive: true });

if (baseUrl) {
  // Re-fetch when anything is missing, or when what's on disk is known to be
  // the fallback — a checkout that built without credentials upgrades itself
  // the first time it runs with them.
  if (missing.length === 0 && current === "remote") process.exit(0);
  const headers = process.env.FONTS_TOKEN
    ? { authorization: `Bearer ${process.env.FONTS_TOKEN}` }
    : {};
  for (const name of FILES) {
    const url = `${baseUrl}/${name}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error(`fetch-fonts: ${url} → ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    writeFileSync(path.join(FONTS_DIR, name), Buffer.from(await response.arrayBuffer()));
  }
  writeFileSync(MARKER, "remote\n");
  console.log(`fetch-fonts: fetched ${FILES.length} files from FONTS_BASE_URL`);
} else {
  // The fallback only ever fills gaps: files already on disk (a checkout that
  // has the real faces) are never overwritten with the stand-in.
  if (missing.length === 0) process.exit(0);
  for (const name of missing) copyFileSync(FALLBACK, path.join(FONTS_DIR, name));
  writeFileSync(MARKER, "fallback\n");
  console.log(
    `fetch-fonts: FONTS_BASE_URL unset — filled ${missing.length} missing file(s) with the open fallback face (Saira, OFL) in place of Industry.`,
  );
}
