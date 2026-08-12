import type { NextRequest } from "next/server";

/**
 * GET /download/macos — 302 to the current macOS build.
 *
 * The button on /download points here rather than at a file, so the page
 * never has to know a version number. Point SUMA_MAC_DMG_URL at the release
 * bucket in production; without it, this falls back to a DMG served from
 * public/downloads (gitignored — drop the artifact from
 * `pnpm --filter @suma/desktop dist:mac` there for local testing).
 */
const FALLBACK_DMG = "/downloads/Suma-0.1.0-arm64.dmg";

export function GET(request: NextRequest) {
  const target = process.env.SUMA_MAC_DMG_URL ?? FALLBACK_DMG;
  return Response.redirect(new URL(target, request.url), 302);
}
