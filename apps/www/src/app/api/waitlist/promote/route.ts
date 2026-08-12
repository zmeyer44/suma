import { type NextRequest } from "next/server";

import {
  findByEmail,
  listNextInLine,
  markInvited,
  normalizeEmail,
  type PromotionCandidate,
} from "@/lib/waitlist-store";

/**
 * Operator-only bridge from the waitlist to the control plane's invite gate.
 *
 *   GET  /api/waitlist/promote?count=5   — preview who is next in line
 *   POST /api/waitlist/promote           — { count } or { emails: [...] }
 *
 * POST mints one email-bound invite per person through the control plane's
 * POST /v1/admin/invites, then records the code here so the waitlist ticket
 * can hand it to its owner. Same closed-by-default posture as the control
 * plane's admin route: without WAITLIST_ADMIN_TOKEN configured this route is
 * 404, never open. Configuration:
 *
 *   WAITLIST_ADMIN_TOKEN  bearer secret for this route
 *   SUMA_CONTROL_URL      control plane base URL (e.g. https://api.…)
 *   INVITE_ADMIN_TOKEN    control's invite-minting secret
 */

const MAX_BATCH = 50;

function unauthorized(request: NextRequest): Response | null {
  const secret = process.env.WAITLIST_ADMIN_TOKEN;
  if (!secret) return Response.json({ error: "not_found" }, { status: 404 });
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : null;
  if (token !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function mintInvite(
  email: string,
): Promise<{ code: string } | { error: string }> {
  const controlUrl = process.env.SUMA_CONTROL_URL;
  const adminToken = process.env.INVITE_ADMIN_TOKEN;
  if (!controlUrl || !adminToken) {
    return {
      error: "SUMA_CONTROL_URL and INVITE_ADMIN_TOKEN must be configured",
    };
  }
  try {
    const response = await fetch(
      `${controlUrl.replace(/\/$/, "")}/v1/admin/invites`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ count: 1, email, note: "waitlist promotion" }),
      },
    );
    if (!response.ok) {
      return { error: `control plane responded ${response.status}` };
    }
    const data = (await response.json()) as { invites?: { code?: string }[] };
    const code = data.invites?.[0]?.code;
    return typeof code === "string" ? { code } : { error: "malformed control response" };
  } catch {
    return { error: "control plane unreachable" };
  }
}

export async function GET(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;

  const raw = Number(request.nextUrl.searchParams.get("count") ?? 10);
  const count = Math.min(MAX_BATCH, Math.max(1, Math.floor(raw) || 10));
  return Response.json({ next: await listNextInLine(count) });
}

export async function POST(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;

  let body: { count?: unknown; emails?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  let candidates: PromotionCandidate[];
  if (Array.isArray(body.emails)) {
    if (body.emails.length > MAX_BATCH) {
      return Response.json(
        { error: `At most ${MAX_BATCH} emails per call.` },
        { status: 400 },
      );
    }
    const notFound: string[] = [];
    candidates = [];
    for (const raw of body.emails) {
      if (typeof raw !== "string") continue;
      const found = await findByEmail(normalizeEmail(raw));
      if (found) candidates.push(found);
      else notFound.push(raw);
    }
    if (candidates.length === 0) {
      return Response.json(
        { error: "No matching uninvited entries.", notFound },
        { status: 400 },
      );
    }
  } else {
    const count = Math.min(MAX_BATCH, Math.max(1, Math.floor(Number(body.count)) || 0));
    if (count === 0) {
      return Response.json(
        { error: "Provide `count` or `emails`." },
        { status: 400 },
      );
    }
    candidates = await listNextInLine(count);
  }

  const promoted: { email: string; inviteCode: string }[] = [];
  const failed: { email: string; error: string }[] = [];
  for (const candidate of candidates) {
    const minted = await mintInvite(candidate.email);
    if ("error" in minted) {
      failed.push({ email: candidate.email, error: minted.error });
      continue;
    }
    // A lost race (someone else promoted them mid-batch) leaves an unredeemed
    // spare invite on the control plane; report it rather than hide it.
    if (!(await markInvited(candidate.email, minted.code))) {
      failed.push({ email: candidate.email, error: "already invited" });
      continue;
    }
    promoted.push({ email: candidate.email, inviteCode: minted.code });
  }

  return Response.json(
    { promoted, failed },
    { status: failed.length > 0 && promoted.length === 0 ? 502 : 200 },
  );
}
