import { type NextRequest } from "next/server";

/**
 * GET /r/:code — the short link people actually share. Lands the visitor on
 * the waitlist panel with the referral attached; the join API decides whether
 * the code is real, so a mistyped link still reaches a working form.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const target = new URL("/", request.url);
  if (/^[a-z0-9]{1,32}$/i.test(code)) {
    target.searchParams.set("ref", code.toLowerCase());
  }
  target.hash = "access";
  return Response.redirect(target, 307);
}
