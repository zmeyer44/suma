/**
 * Agent capability tokens (I-2, PRD §8.5). Minted with the SAME EdDSA signing
 * keys as device tokens (keys-provider.ts) and the same compact-JWS shape,
 * but with a DIFFERENT header `typ` so the two token families are
 * structurally disjoint: a capability token lives inside the user's VM —
 * attacker-reachable by construction — so it must NEVER authenticate a
 * device/user route, and a device token must never drive the agent plane.
 * `@suma/protocol` owns the claims shape (CapabilityClaims); it is frozen,
 * so the JWS glue lives here rather than beside signDeviceToken.
 */

import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import {
  CAPABILITIES,
  CAPABILITY_TOKEN_TTL_SECONDS,
  TERMINAL_CAPABILITIES,
  fromBase64,
  fromUtf8,
  toBase64,
  utf8,
  type Capability,
  type CapabilityClaims,
} from "@suma/protocol";
import type { Db } from "./db/client.js";
import { machines } from "./db/schema.js";
import type { SigningKeys } from "./keys-provider.js";
import type { AuthEnv } from "./auth.js";

function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

// `typ` differs from the device-token header ("JWT") on purpose: verification
// on either side rejects the other family before any claim is even read.
const CAPABILITY_JWS_HEADER = base64url(
  utf8(JSON.stringify({ alg: "EdDSA", typ: "suma-cap+jws" })),
);

export async function signCapabilityToken(
  signingKey: CryptoKey,
  claims: CapabilityClaims,
): Promise<string> {
  const payload = base64url(utf8(JSON.stringify(claims)));
  const signingInput = `${CAPABILITY_JWS_HEADER}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", signingKey, utf8(signingInput) as BufferSource),
  );
  return `${signingInput}.${base64url(sig)}`;
}

export interface MintedCapabilityToken {
  token: string;
  claims: CapabilityClaims;
}

export async function mintCapabilityToken(
  signingKey: CryptoKey,
  machineId: string,
  userId: string,
  caps: ReadonlyArray<Capability>,
  nowSeconds: number,
): Promise<MintedCapabilityToken> {
  const claims: CapabilityClaims = {
    mid: machineId,
    sub: userId,
    caps: [...caps],
    iat: nowSeconds,
    exp: nowSeconds + CAPABILITY_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  };
  return { token: await signCapabilityToken(signingKey, claims), claims };
}

export type CapabilityVerifyResult =
  | { ok: true; claims: CapabilityClaims }
  | { ok: false; reason: "malformed" | "not_capability_token" | "bad_signature" | "expired" };

function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as ReadonlyArray<string>).includes(value);
}

function parseClaims(payload: string): CapabilityClaims | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fromUtf8(base64urlDecode(payload)));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c["mid"] !== "string" ||
    typeof c["sub"] !== "string" ||
    typeof c["jti"] !== "string" ||
    typeof c["iat"] !== "number" ||
    typeof c["exp"] !== "number" ||
    !Array.isArray(c["caps"]) ||
    !c["caps"].every(isCapability)
  ) {
    return null;
  }
  return {
    mid: c["mid"],
    sub: c["sub"],
    jti: c["jti"],
    iat: c["iat"],
    exp: c["exp"],
    caps: c["caps"],
  };
}

/** Mirrors verifyDeviceToken's contract, including the small exp clock skew. */
export async function verifyCapabilityToken(
  verifyKey: CryptoKey,
  token: string,
  nowSeconds: number,
  clockSkewSeconds = 30,
): Promise<CapabilityVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, sig] = parts as [string, string, string];
  if (header !== CAPABILITY_JWS_HEADER) return { ok: false, reason: "not_capability_token" };
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "Ed25519",
      verifyKey,
      base64urlDecode(sig) as BufferSource,
      utf8(`${header}.${payload}`) as BufferSource,
    );
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  const claims = parseClaims(payload);
  if (!claims) return { ok: false, reason: "malformed" };
  if (claims.exp + clockSkewSeconds < nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/**
 * Account feature flag each non-terminal capability is gated on (§8.6:
 * cloud fetch and the Files app are plan features, not baseline terminal
 * abilities). Everything else a token can name is in TERMINAL_CAPABILITIES.
 */
export const CAPABILITY_FEATURE: Readonly<Partial<Record<Capability, string>>> = {
  "fetch.public": "cloud-fetch",
  "fs.read": "files",
  "fs.write": "files",
};

/**
 * Features every new account gets (PRD §6: cloud fetch and the Files tab are
 * V1 scope, not a staged experiment).
 *
 * `users.features` defaults to `'{}'` in the schema and NOTHING grants an entry
 * — there is no admin route, no CLI, no signup default. That made every
 * feature-gated route dead for every account that has ever existed: a cloud
 * fetch 403'd with `feature_required` for a user who had no way to acquire the
 * feature. Granting the V1 set at signup is what makes the shipped scope
 * reachable; the gate itself stays, so a genuinely staged feature can be added
 * here later by simply leaving it out.
 */
export const DEFAULT_ACCOUNT_FEATURES: ReadonlyArray<string> = [
  "cloud-fetch",
  "files",
  // Vended inference (src/inference.ts): default-on so a fresh account can
  // talk to the assistant without bringing a key; strip it per account to
  // cut a user off without touching their devices.
  "inference",
];

/** Caps the caller may not have: not terminal, and no matching account feature. */
export function refusedCaps(
  caps: ReadonlyArray<Capability>,
  features: ReadonlyArray<string>,
): Capability[] {
  return caps.filter((cap) => {
    if (TERMINAL_CAPABILITIES.includes(cap)) return false;
    const feature = CAPABILITY_FEATURE[cap];
    return feature === undefined || !features.includes(feature);
  });
}

/**
 * Authorization for the control-plane reporting routes the agent calls
 * (`/v1/machine/activity`, `/v1/usage/sample`). `bearerAgent` proves WHICH
 * machine is calling; this says WHAT that token is allowed to be — otherwise
 * "any valid capability token" is the whole authorization story, and the
 * narrowest token a user can hold ends up as powerful as the widest.
 *
 * @suma/protocol is frozen and CAPABILITIES deliberately names no
 * control-plane operation (the list is agent-side abilities: pty, ports,
 * fetch, fs, log), so there is no `usage.report` cap to require. The
 * defensible rule with the names that exist: reporting is a baseline
 * terminal-session function, so the caller must present a plain
 * terminal-scoped token — every cap in TERMINAL_CAPABILITIES, nothing else.
 * A token minted for the feature-gated `fs.*`/`fetch.public` grants (§8.6) is
 * a different, broader grant issued for a different job, and must not double
 * as a metering identity.
 */
export function agentReportRefusal(caps: ReadonlyArray<Capability>): string | null {
  if (caps.length === 0) return "capability token grants nothing";
  const extra = caps.filter((cap) => !TERMINAL_CAPABILITIES.includes(cap));
  if (extra.length > 0) return `not a terminal-scoped token: ${extra.join(", ")}`;
  return null;
}

/**
 * Authorization for the transfer-progress route (§8.6). Moving a cloud fetch's
 * state is the reporting half of `fetch.public`, so the caller must hold that
 * cap — a plain terminal token, which every session has, must not be able to
 * mark another job complete or failed. The cap is itself feature-gated at mint
 * time (CAPABILITY_FEATURE), so the plan check rides along.
 */
export function transferReportRefusal(caps: ReadonlyArray<Capability>): string | null {
  return caps.includes("fetch.public") ? null : "capability token does not grant fetch.public";
}

/**
 * Bearer auth for agent-facing routes. Accepts ONLY a capability token bound
 * to an existing machine owned by the token's subject; every other credential
 * — device JWT, dev stub, garbage — is 401. The failure reason is not echoed
 * per-branch beyond what verification returns: the caller is the VM.
 */
export function bearerAgent(
  db: Db,
  getSigning: () => Promise<SigningKeys>,
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const signing = await getSigning();
    const result = await verifyCapabilityToken(signing.verifyKey, token, Math.floor(Date.now() / 1000));
    if (!result.ok) return c.json({ error: "unauthorized", reason: result.reason }, 401);
    const [machine] = await db
      .select({ id: machines.id, userId: machines.userId })
      .from(machines)
      .where(eq(machines.id, result.claims.mid));
    if (!machine || machine.userId !== result.claims.sub) {
      return c.json({ error: "unauthorized", reason: "machine_binding" }, 401);
    }
    c.set("agent", { machineId: machine.id, userId: machine.userId, caps: result.claims.caps });
    return next();
  };
}
