/**
 * Second-device enrollment codes (§8.2): an authenticated session mints a
 * short-lived single-use code; a fresh device redeems it for a signed
 * bootstrap token and then enrolls through the normal device-key flow.
 */

import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { generateTokenKeypair } from "@suma/protocol";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { createSigningKeys, type SigningKeys } from "../src/keys-provider.js";
import { StubSandboxProvider } from "../src/providers/sandbox.js";

let db: Db;
let app: ReturnType<typeof createApp>;
let signing: SigningKeys;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await ensureSchema(db);
  const pair = await generateTokenKeypair();
  signing = await createSigningKeys(pair.privateKeyPkcs8, pair.publicKeyRaw);
  app = createApp(db, new StubSandboxProvider(), signing);
});

function jsonInit(method: string, body?: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function signup(email: string): Promise<{ userId: string; token: string }> {
  const res = await app.request("/v1/accounts", jsonInit("POST", { email }));
  expect(res.status).toBe(201);
  const out = (await res.json()) as { user: { id: string }; bootstrapToken: string };
  return { userId: out.user.id, token: out.bootstrapToken };
}

const hash = (code: string): string => createHash("sha256").update(code).digest("hex");

/** Mint payload matching the client: server sees only the hash + sealed bytes. */
function mintBody(code: string, wrappers?: Array<{ credentialId: string; wrapped: string }>) {
  return {
    codeHash: hash(code),
    ...(wrappers ? { wrapSalt: Buffer.from("saltsaltsalt").toString("base64"), wrappers } : {}),
  };
}

describe("enrollment codes", () => {
  it("mints (hash only) and redeems into a working bootstrap token", async () => {
    const { userId, token } = await signup("code-flow@example.com");
    const code = "ABCD-EFGH-JKMN";

    const mint = await app.request(
      "/v1/devices/enrollment-code",
      jsonInit("POST", mintBody(code), token),
    );
    expect(mint.status).toBe(201);
    const { expiresAt } = (await mint.json()) as { expiresAt: string };
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    // The plaintext code never reaches the server — only its hash is stored.
    const rows = await db.select().from(schema.enrollmentCodes);
    expect(rows.some((r) => r.codeHash === code)).toBe(false);
    expect(rows.some((r) => r.codeHash === hash(code))).toBe(true);

    const redeem = await app.request("/v1/auth/enrollment-code/redeem", jsonInit("POST", { code }));
    expect(redeem.status).toBe(200);
    const redeemed = (await redeem.json()) as {
      user: { id: string };
      bootstrapToken: string;
    };
    expect(redeemed.user.id).toBe(userId);
    expect(redeemed.bootstrapToken.startsWith("eyJ")).toBe(true); // signed JWS, not a stub

    const me = await app.request("/v1/me", jsonInit("GET", undefined, redeemed.bootstrapToken));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe(userId);
  });

  it("carries sealed key wrappers through redemption, then purges them", async () => {
    const { token } = await signup("keyxfer@example.com");
    const code = "PQRS-TUVW-XYZ2";
    const wrappers = [
      { credentialId: "enroll:__workspace__", wrapped: Buffer.from("sealed-ws").toString("base64") },
      { credentialId: "enroll:space-1", wrapped: Buffer.from("sealed-1").toString("base64") },
    ];
    await app.request("/v1/devices/enrollment-code", jsonInit("POST", mintBody(code, wrappers), token));

    const redeem = await app.request("/v1/auth/enrollment-code/redeem", jsonInit("POST", { code }));
    const body = (await redeem.json()) as {
      wrapSalt?: string;
      wrappers?: Array<{ credentialId: string; wrapped: string }>;
    };
    expect(body.wrappers).toHaveLength(2);
    expect(body.wrappers?.map((w) => w.credentialId).sort()).toEqual([
      "enroll:__workspace__",
      "enroll:space-1",
    ]);
    expect(typeof body.wrapSalt).toBe("string");

    // Purged after the single redemption — a later DB read holds nothing.
    const [row] = await db
      .select()
      .from(schema.enrollmentCodes)
      .where(eq(schema.enrollmentCodes.codeHash, hash(code)));
    expect(row?.wrappers).toBeNull();
    expect(row?.wrapSalt).toBeNull();
  });

  it("codes are single-use", async () => {
    const { token } = await signup("single-use@example.com");
    const code = "1111-2222-3333";
    await app.request("/v1/devices/enrollment-code", jsonInit("POST", mintBody(code), token));

    const first = await app.request("/v1/auth/enrollment-code/redeem", jsonInit("POST", { code }));
    expect(first.status).toBe(200);
    const second = await app.request("/v1/auth/enrollment-code/redeem", jsonInit("POST", { code }));
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ error: "invalid_or_expired_code" });
  });

  it("expired codes are refused", async () => {
    const { userId, token } = await signup("expired@example.com");
    const code = "4444-5555-6666";
    await app.request("/v1/devices/enrollment-code", jsonInit("POST", mintBody(code), token));
    await db
      .update(schema.enrollmentCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.enrollmentCodes.userId, userId));

    const res = await app.request("/v1/auth/enrollment-code/redeem", jsonInit("POST", { code }));
    expect(res.status).toBe(401);
  });

  it("unknown codes and unauthenticated mints are refused", async () => {
    const bogus = await app.request(
      "/v1/auth/enrollment-code/redeem",
      jsonInit("POST", { code: "not-a-real-code" }),
    );
    expect(bogus.status).toBe(401);

    const unauthed = await app.request(
      "/v1/devices/enrollment-code",
      jsonInit("POST", mintBody("7777-8888-9999")),
    );
    expect(unauthed.status).toBe(401);
  });
});
