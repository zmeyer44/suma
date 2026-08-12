import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { generateInviteCode, inviteOptionsFromEnv } from "../src/invites.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";

/**
 * PRD §11: "Beta is invitation-only and paid. No free tier at launch." These
 * cover the invitation half — signup consumes a single-use operator-minted
 * code. (Payment verification is a billing follow-up; invites are V1's only
 * admission control.)
 */

const ADMIN_TOKEN = "test-admin-secret";

let db: Db;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  app = createApp(db, new StubSandboxProvider(), undefined, undefined, undefined, {
    required: true,
    adminToken: ADMIN_TOKEN,
  });
});

function jsonInit(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

let emailCounter = 0;
function nextEmail(): string {
  return `invitee-${emailCounter++}@example.com`;
}

async function mintInvite(body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.request("/v1/admin/invites", jsonInit("POST", body, ADMIN_TOKEN));
  expect(res.status).toBe(201);
  const parsed = (await res.json()) as { invites: Array<{ code: string }> };
  const code = parsed.invites[0]?.code;
  expect(code).toBeDefined();
  return code as string;
}

describe("invite-gated signup (§11)", () => {
  it("refuses signup without a code, and explains", async () => {
    const res = await app.request("/v1/accounts", jsonInit("POST", { email: nextEmail() }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; explanation: string };
    expect(body.error).toBe("invite_required");
    expect(body.explanation).toContain("invitation-only");
  });

  it("refuses an unknown code", async () => {
    const res = await app.request(
      "/v1/accounts",
      jsonInit("POST", { email: nextEmail(), inviteCode: "sm-inv-nosuchcode" }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("invite_invalid");
  });

  it("admits a valid code exactly once and records the redemption", async () => {
    const code = await mintInvite({ note: "design partner #1" });
    const email = nextEmail();
    const ok = await app.request("/v1/accounts", jsonInit("POST", { email, inviteCode: code }));
    expect(ok.status).toBe(201);
    const { user } = (await ok.json()) as { user: { id: string } };

    const [row] = await db.select().from(schema.invites).where(eq(schema.invites.code, code));
    expect(row?.redeemedByUserId).toBe(user.id);
    expect(row?.redeemedAt).not.toBeNull();

    // Single-use: the same code cannot admit a second account.
    const again = await app.request(
      "/v1/accounts",
      jsonInit("POST", { email: nextEmail(), inviteCode: code }),
    );
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: string }).error).toBe("invite_invalid");

    // The redemption is on the account's audit trail.
    const [event] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.type, "invite.redeemed"));
    expect(event?.userId).toBe(user.id);
  });

  it("honours an email-bound invite for that email only", async () => {
    const email = nextEmail();
    const code = await mintInvite({ email });

    const wrong = await app.request(
      "/v1/accounts",
      jsonInit("POST", { email: nextEmail(), inviteCode: code }),
    );
    expect(wrong.status).toBe(403);

    // The failed attempt must not burn the invite for its intended owner.
    const right = await app.request("/v1/accounts", jsonInit("POST", { email, inviteCode: code }));
    expect(right.status).toBe(201);
  });

  it("does not burn an invite on an email collision", async () => {
    const email = nextEmail();
    const first = await mintInvite();
    await app.request("/v1/accounts", jsonInit("POST", { email, inviteCode: first }));

    const second = await mintInvite();
    const dup = await app.request("/v1/accounts", jsonInit("POST", { email, inviteCode: second }));
    expect(dup.status).toBe(409); // email_taken — checked before the claim

    const fresh = await app.request(
      "/v1/accounts",
      jsonInit("POST", { email: nextEmail(), inviteCode: second }),
    );
    expect(fresh.status).toBe(201);
  });
});

describe("invite minting (operator route)", () => {
  it("requires the admin secret", async () => {
    const anonymous = await app.request("/v1/admin/invites", jsonInit("POST", { count: 1 }));
    expect(anonymous.status).toBe(401);
    const wrong = await app.request("/v1/admin/invites", jsonInit("POST", { count: 1 }, "nope"));
    expect(wrong.status).toBe(401);
  });

  it("mints the requested number of distinct codes", async () => {
    const res = await app.request("/v1/admin/invites", jsonInit("POST", { count: 5 }, ADMIN_TOKEN));
    expect(res.status).toBe(201);
    const { invites } = (await res.json()) as { invites: Array<{ code: string }> };
    expect(invites).toHaveLength(5);
    expect(new Set(invites.map((i) => i.code)).size).toBe(5);
    for (const { code } of invites) {
      expect(code).toMatch(/^sm-inv-[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
    }
  });

  it("is CLOSED (404), never open, when no admin token is configured", async () => {
    const closed = createApp(db, new StubSandboxProvider(), undefined, undefined, undefined, {
      required: true,
      adminToken: null,
    });
    const res = await closed.request("/v1/admin/invites", jsonInit("POST", { count: 1 }, "anything"));
    expect(res.status).toBe(404);
  });
});

describe("inviteOptionsFromEnv (deployed default is GATED)", () => {
  it("defaults the gate ON with no env at all", () => {
    expect(inviteOptionsFromEnv({})).toEqual({ required: true, adminToken: null });
  });

  it("opens only on an explicit 0/false", () => {
    expect(inviteOptionsFromEnv({ SUMA_INVITES_REQUIRED: "0" }).required).toBe(false);
    expect(inviteOptionsFromEnv({ SUMA_INVITES_REQUIRED: "false" }).required).toBe(false);
    expect(inviteOptionsFromEnv({ SUMA_INVITES_REQUIRED: "1" }).required).toBe(true);
    expect(inviteOptionsFromEnv({ SUMA_INVITES_REQUIRED: "yes" }).required).toBe(true);
  });

  it("generateInviteCode sticks to the unambiguous alphabet (no 0/O/1/l/I/o/i)", () => {
    for (let i = 0; i < 20; i += 1) {
      const code = generateInviteCode();
      expect(code).toMatch(/^sm-inv-[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
    }
  });
});
