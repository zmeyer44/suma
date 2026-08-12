import { type NextRequest } from "next/server";

import {
  getStatus,
  isPlausibleEmail,
  joinWaitlist,
  normalizeEmail,
} from "@/lib/waitlist-store";

/**
 * POST /api/waitlist  { email, ref? } — join the line (idempotent per email).
 * GET  /api/waitlist?code=…          — refresh a spot by referral code.
 *
 * Lookups are keyed by code, never email, and never return the email — codes
 * travel in referral links, so a leaked code must only leak a queue position.
 */

/**
 * Per-IP sliding windows, in-process. Enough to blunt a casual script; a real
 * flood is the CDN's problem, not this handler's.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_JOINS_PER_WINDOW = 10;
const MAX_READS_PER_WINDOW = 120;

const hits = new Map<string, number[]>();

function allow(key: string, limit: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  // The map only grows while a window is active; sweep it once it is large.
  if (hits.size > 10_000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
    }
  }
  return true;
}

function clientKey(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"
  );
}

export async function POST(request: NextRequest) {
  if (!allow(`join:${clientKey(request)}`, MAX_JOINS_PER_WINDOW)) {
    return Response.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  const { email: rawEmail, ref } = (body ?? {}) as {
    email?: unknown;
    ref?: unknown;
  };
  if (typeof rawEmail !== "string") {
    return Response.json({ error: "Email is required." }, { status: 400 });
  }
  const email = normalizeEmail(rawEmail);
  if (!isPlausibleEmail(email)) {
    return Response.json(
      { error: "That doesn't look like an email address." },
      { status: 400 },
    );
  }
  const refCode =
    typeof ref === "string" && ref.length <= 32 ? ref : null;

  try {
    const { status, alreadyJoined, inviteCode } = await joinWaitlist(
      email,
      refCode,
    );
    // inviteCode rides only on the email-bearing POST — the GET below, which
    // anyone holding a shared referral link can call, never includes it.
    return Response.json({ ...status, alreadyJoined, inviteCode });
  } catch {
    return Response.json(
      { error: "Something went wrong on our end." },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  if (!allow(`read:${clientKey(request)}`, MAX_READS_PER_WINDOW)) {
    return Response.json({ error: "Too many requests." }, { status: 429 });
  }

  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 32) {
    return Response.json({ error: "A code is required." }, { status: 400 });
  }

  const status = await getStatus(code);
  if (!status) {
    return Response.json({ error: "Unknown code." }, { status: 404 });
  }
  return Response.json(status);
}
