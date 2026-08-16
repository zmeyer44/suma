/**
 * Control-plane HTTP API (PRD §7). Hono app factory; the db handle is
 * injected so tests run the same app against PGlite.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  max,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { z } from "zod";
import {
  CLOUD_FETCH_MIN_BYTES,
  DEFAULT_IDLE_SUSPEND_MS,
  DEFAULT_MACHINE_SPEC,
  DEVICE_TOKEN_TTL_SECONDS,
  MACHINE_STATES,
  PRO_QUOTA_BYTES,
  TRANSFER_STATES,
  canTransition,
  capabilitySchema,
  checkQuota,
  cloudFetchEligibility,
  decideSuspend,
  explainVerdict,
  fromBase64,
  hourlyRateUsd,
  importPublicKeyRaw,
  manifestSchema,
  signDeviceToken,
  verifyDeviceToken,
  type Manifest,
  type MachineSpec,
  type MachineState,
  type QuotaState,
  type SuspendVerdict,
} from "@suma/protocol";
import type { Db } from "./db/client.js";
import { createHash } from "node:crypto";
import {
  auditEvents,
  chunks,
  devices,
  enrollmentCodes,
  fileChunks,
  files,
  invites,
  keyWrappers,
  machineActivity,
  machineEvents,
  machines,
  passkeys,
  revocationOutbox,
  spaces,
  transfers,
  usageSamples,
  users,
} from "./db/schema.js";
import {
  bearerAuth,
  deviceLoginSigningBytes,
  hubTokenFor,
  type AuthEnv,
} from "./auth.js";
import {
  DEFAULT_ACCOUNT_FEATURES,
  agentReportRefusal,
  bearerAgent,
  mintCapabilityToken,
  refusedCaps,
  transferReportRefusal,
} from "./capabilities.js";
import {
  ACTIVE_TRANSFER_STATES,
  MAX_PATH_LENGTH,
  MAX_TRANSFER_BYTES,
  canTransferTransition,
  chunkObjectKey,
  distinctChunks,
  fileEntryView,
  isTerminalTransfer,
  missingChunkRefs,
  normalizeFilePath,
  normalizePrefix,
  redactTransferUrl,
  transferView,
  validateManifest,
} from "./files.js";
import {
  PRESIGN_TTL_SECONDS,
  StubObjectStore,
  type ObjectStore,
} from "./providers/object-store.js";
import { bearerGateway, secretEquals } from "./gateway.js";
import {
  generateInviteCode,
  INVITES_DISABLED,
  type InviteOptions,
} from "./invites.js";
import { estimateMonthlyCost } from "./billing.js";
import {
  INFERENCE_DISABLED,
  inferenceRoutes,
  type InferenceOptions,
} from "./inference.js";
import {
  ABUSE_LIMITS,
  checkActiveTransfers,
  checkBoost,
  egressThrottled,
} from "./abuse.js";
import { summarize } from "./audit-format.js";
import {
  affectedOriginsOnRevoke,
  envHubNotifier,
  type HubRevocationNotifier,
} from "./revocation.js";
import { flushRevocationOutbox } from "./outbox.js";
import {
  StubSandboxProvider,
  type SandboxProvider,
} from "./providers/sandbox.js";
import { getSigningKeys, type SigningKeys } from "./keys-provider.js";
import {
  ChallengeStore,
  beginLogin,
  beginRegistration,
  finishLogin,
  finishRegistration,
  rpConfigFromEnv,
} from "./webauthn.js";
import { setRecoveryWrapper } from "./recovery.js";

const DEFAULT_SPACE_NAME = "Personal";
const DEFAULT_SPACE_COLOR = "#3B82F6";

const ED25519_PUBLIC_KEY_BYTES = 32;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ *
 * Bounds on reported numbers (§9)
 *
 * Everything below is named by a caller the threat model treats as hostile:
 * the agent runs inside a VM the user can root, and even the gateway is a
 * remote writer. An unbounded figure corrupts the §11 cost meter and the §9
 * egress throttle just as effectively as a forged one, so each field is
 * clamped to something physically possible and out-of-range values are
 * REFUSED (400) rather than stored.
 * ------------------------------------------------------------------ */

/** A sample covers at most one day, and a day holds at most 24 h of awake time. */
const MAX_SAMPLE_AWAKE_MS = DAY_MS;
/**
 * ~1 Gbps sustained for 24 h ≈ 10.8 TB. No honest daily egress sample can
 * exceed the gateway link's line rate; 11 TB leaves the rounding above it.
 */
const MAX_SAMPLE_PROXIED_BYTES = 11e12;
/** §8.6 quotas are 100 GB/user; 10 TB is three orders of magnitude of headroom. */
const MAX_SAMPLE_STORAGE_GB = 10_000;
/**
 * Tolerance for clocks that disagree — resumed machines can wake with skewed
 * clocks (§8.5), so a slightly future-dated period start is honest. Beyond
 * it, a future timestamp is a weapon: it never leaves the throttle's 24 h
 * window and never ages out of the summary.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/**
 * Oldest sample the meter accepts. The summary window tops out at 90 days,
 * so anything older can never be billed — it can only bloat the table.
 */
const MAX_SAMPLE_BACKFILL_MS = 90 * DAY_MS;
/**
 * The agent's cumulative awake counter. A machine awake for longer than the
 * longest window the meter ever reports over is reporting a corrupt counter.
 */
const MAX_ACCRUED_AWAKE_MS = 90 * DAY_MS;

/** True when an epoch-ms field is dated further into the future than clocks explain. */
const isFutureDated = (epochMs: number, nowMs: number): boolean =>
  epochMs > nowMs + MAX_CLOCK_SKEW_MS;

function base64String(
  byteLength?: number,
  maxChars?: number,
): z.ZodEffects<z.ZodString, string, string> {
  const base = maxChars === undefined ? z.string() : z.string().max(maxChars);
  return base.refine(
    (s) => {
      try {
        const decoded = fromBase64(s);
        return byteLength === undefined || decoded.length === byteLength;
      } catch {
        return false;
      }
    },
    byteLength === undefined
      ? "must be base64"
      : `must be base64 of ${byteLength} bytes`,
  );
}

/** Second-device enrollment codes are short-lived by design (§8.2). */
const ENROLLMENT_CODE_TTL_MS = 10 * 60 * 1000;

function hashEnrollmentCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

const signupSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(200).optional(),
  homeRegion: z.string().min(2).max(16).optional(),
  /** Required in deployments where the invite gate is on (§11). */
  inviteCode: z.string().min(1).max(128).optional(),
  /** "cloud" (default) provisions a VM; "local" records that the user
   *  dedicated their first Mac as the computer — no VM is created. */
  computeMode: z.enum(["cloud", "local"]).optional(),
});

const mintInvitesSchema = z.object({
  count: z.number().int().min(1).max(100).default(1),
  /** Bind the codes to one redeemer's email (case-insensitive). */
  email: z.string().email().max(320).optional(),
  note: z.string().min(1).max(500).optional(),
});

const enrollSchema = z.object({
  name: z.string().min(1).max(200),
  platform: z.string().min(1).max(64),
  devicePublicKey: base64String(ED25519_PUBLIC_KEY_BYTES, 512),
  // Accepted but unverified in the initial phase (Secure Enclave attestation TODO).
  attestation: z.string().optional(),
});

const renameDeviceSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
const revokeSchema = z.object({
  reason: z.string().min(1).max(200).optional(),
});

const egressPolicySchema = z.enum(["suma-ip", "direct"]);

const createSpaceSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().min(1).max(32),
  egressPolicy: egressPolicySchema.optional(),
});

const patchSpaceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    color: z.string().min(1).max(32).optional(),
    position: z.number().int().min(0).max(100000).optional(),
    egressPolicy: egressPolicySchema.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "empty patch");

const wrapperSchema = z.object({
  kind: z.enum([
    "passkey-prf",
    "recovery-code",
    "hardware-key",
    "kms",
    "enrollment-code",
  ]),
  credentialId: z.string().min(1).max(512),
  salt: base64String(undefined, 1024).default(""),
  wrapped: base64String(undefined, 16384),
});

const transitionSchema = z.object({
  to: z.enum(MACHINE_STATES),
  reconstructed: z.boolean().optional(),
  detail: z.string().min(1).max(200).optional(),
  // Explicit user override of the §8.5 suspend guard. Auto-suspend callers
  // must never set this.
  force: z.boolean().optional(),
});

const EPOCH_MS_MAX = 1e15;

const processTreeSchema = z.object({
  ptyId: z.string().min(1).max(128),
  command: z.string().max(4096),
  shellOnly: z.boolean(),
  suspendOptIn: z.boolean(),
  jobMode: z.boolean(),
});

const activityReportSchema = z.object({
  clientsAttached: z.number().int().min(0).max(10000),
  processes: z.array(processTreeSchema).max(500),
  activeTransfers: z.number().int().min(0).max(10000),
  /** Epoch milliseconds of the last client interaction. */
  lastInteractionAt: z.number().int().min(0).max(EPOCH_MS_MAX),
  awakeMsAccrued: z.number().int().min(0).max(MAX_ACCRUED_AWAKE_MS),
});

const jobModeSchema = z.object({
  ptyId: z.string().min(1).max(128),
  enabled: z.boolean(),
});

const capabilityRequestSchema = z.object({
  caps: z.array(capabilitySchema).min(1).max(32),
});

// Boost is a stop/start resize to 4–8 GB (§8.5).
const boostSchema = z.object({
  memoryMb: z.union([z.literal(4096), z.literal(8192)]).default(4096),
});

/**
 * A usage sample reported BY THE AGENT — i.e. from inside the user's VM,
 * which §9 assumes hostile. It may only carry what the compute plane is
 * actually the source of truth for: awake time and storage.
 *
 * `proxiedBytes` and `source` are parsed rather than stripped ON PURPOSE, so
 * the route can refuse them explicitly (403) instead of silently discarding
 * them: a mis-wired agent must fail loudly, and an attempt to forge the
 * egress signal must be visible rather than look like a success.
 */
const agentUsageSampleSchema = z.object({
  /** Epoch milliseconds at the start of the sampled period. */
  periodStart: z.number().int().min(0).max(EPOCH_MS_MAX),
  awakeMs: z.number().int().min(0).max(MAX_SAMPLE_AWAKE_MS),
  storageGb: z.number().min(0).max(MAX_SAMPLE_STORAGE_GB),
  proxiedBytes: z.number().optional(),
  source: z.enum(["agent", "gateway"]).optional(),
});

/**
 * A usage sample reported BY THE EGRESS GATEWAY (I-3): a separate plane with
 * its own network identity that runs no user code. It names the user whose
 * traffic it proxied — it has no capability token and no machine binding, so
 * the route resolves the machine from the account (§8.8: one VM per account).
 */
const gatewayUsageSampleSchema = z.object({
  userId: z.string().uuid(),
  /** Epoch milliseconds at the start of the sampled period. */
  periodStart: z.number().int().min(0).max(EPOCH_MS_MAX),
  proxiedBytes: z.number().int().min(0).max(MAX_SAMPLE_PROXIED_BYTES),
});

const usageSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

const wrapperListQuerySchema = z.object({
  kind: z
    .enum([
      "passkey-prf",
      "recovery-code",
      "hardware-key",
      "kms",
      "enrollment-code",
    ])
    .optional(),
});

const recoverySchema = z.object({
  saltB64: base64String(undefined, 1024),
  wrappedB64: base64String(undefined, 16384),
});

const idParamSchema = z.object({ id: z.string().uuid() });
const wrapperParamSchema = z.object({
  id: z.string().uuid(),
  wrapperId: z.string().uuid(),
});

/* ------------------------------------------------------------------ *
 * Files (§8.6)
 * ------------------------------------------------------------------ */

const CHUNK_HASH_RE = /^[0-9a-f]{64}$/;

const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH);

/**
 * `.strict()` on every Files write body is load-bearing, not tidiness. Zod
 * would otherwise STRIP an unknown key, so a client that tried to attach
 * `headers`, `cookie`, or `authorization` to a transfer would get a 201 and
 * silently lose it. §8.6 requires that path to not exist; an explicit 400 says
 * so out loud instead of pretending the request was honoured.
 */
const createFromManifestSchema = z
  .object({
    path: pathSchema,
    contentType: z.string().max(255).optional(),
    manifest: manifestSchema,
  })
  .strict();

const completeUploadSchema = z.object({ fileId: z.string().uuid() }).strict();

const filesListQuerySchema = z.object({
  prefix: z.string().max(MAX_PATH_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Keyset cursor: the path of the last entry on the previous page.
  cursor: z.string().max(MAX_PATH_LENGTH).optional(),
});

const statQuerySchema = z.object({ path: pathSchema });

const chunkParamSchema = z.object({ hash: z.string().regex(CHUNK_HASH_RE) });

/**
 * Everything a cloud fetch needs, and nothing that could carry a credential.
 * There is no header field, no cookie field, and no place to put one — §8.6
 * deleted the sealed one-shot request, and the shape of this schema is where
 * that deletion is enforced.
 */
const createTransferSchema = z
  .object({
    url: z.string().max(8192),
    destPath: pathSchema,
    /** What the origin declared, when the browser saw a Content-Length. */
    totalBytes: z.number().int().min(0).max(MAX_TRANSFER_BYTES).optional(),
  })
  .strict();

const transfersListQuerySchema = z.object({
  state: z.enum(TRANSFER_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * A progress report from the AGENT — i.e. from inside the user's VM, which §9
 * assumes hostile. Bounded exactly like the Phase 2 usage samples: every
 * figure is clamped to something physically possible, and out-of-range values
 * are REFUSED rather than stored.
 */
const transferProgressSchema = z
  .object({
    transferId: z.string().uuid(),
    state: z.enum(TRANSFER_STATES),
    receivedBytes: z.number().int().min(0).max(MAX_TRANSFER_BYTES),
    totalBytes: z.number().int().min(0).max(MAX_TRANSFER_BYTES).optional(),
    error: z.string().max(500).optional(),
  })
  .strict();

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Keyset cursor: the id of the last entry on the previous page.
  cursor: z.string().uuid().optional(),
  type: z.string().min(1).max(100).optional(),
});

const ED25519_SIGNATURE_BYTES = 64;

const deviceChallengeSchema = z.object({ deviceId: z.string().uuid() });

const deviceCredentialSchema = z.object({
  deviceId: z.string().uuid(),
  devicePublicKey: base64String(ED25519_PUBLIC_KEY_BYTES, 512),
  signature: base64String(ED25519_SIGNATURE_BYTES, 512),
});

const deviceLoginSchema = z.object({
  deviceId: z.string().uuid(),
  signature: base64String(ED25519_SIGNATURE_BYTES, 512),
});

const registrationCredentialSchema = z.object({
  id: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: z.string().min(1).max(65536),
    attestationObject: z.string().min(1).max(65536),
  }),
  clientExtensionResults: z
    .object({ prf: z.object({ enabled: z.boolean().optional() }).optional() })
    .optional(),
});

const webauthnRegisterFinishSchema = z.object({
  credential: registrationCredentialSchema,
  deviceId: z.string().uuid().optional(),
  label: z.string().min(1).max(200).optional(),
});

const assertionCredentialSchema = z.object({
  id: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: z.string().min(1).max(65536),
    authenticatorData: z.string().min(1).max(65536),
    signature: z.string().min(1).max(4096),
    userHandle: z.string().max(1024).optional(),
  }),
});

const webauthnLoginBeginSchema = z.object({ userId: z.string().uuid() });

const webauthnLoginFinishSchema = z.object({
  userId: z.string().uuid(),
  deviceId: z.string().uuid(),
  credential: assertionCredentialSchema,
});

// Unauthenticated /v1 routes: login and its preludes cannot require a token,
// JWKS is public key material, refresh does its own token verification.
const PUBLIC_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/v1/auth/jwks",
  "/v1/auth/enrollment-code/redeem",
  "/v1/auth/device-challenge",
  "/v1/auth/device-credential",
  "/v1/auth/device-login",
  "/v1/auth/token/refresh",
  "/v1/auth/webauthn/login/begin",
  "/v1/auth/webauthn/login/finish",
]);

// Agent-facing routes, authenticated by a capability token (bearerAgent) —
// never by a device/user credential, and vice versa (I-2).
const AGENT_PATHS: ReadonlySet<string> = new Set([
  "/v1/machine/activity",
  "/v1/usage/sample",
  "/v1/files/transfers/progress",
]);

// Gateway-facing routes, authenticated by the egress-gateway shared secret
// (bearerGateway) — reachable from neither the VM nor a user device (I-3).
const GATEWAY_PATHS: ReadonlySet<string> = new Set(["/v1/usage/egress"]);

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * How stale the agent's last snapshot may be before the control plane stops
 * believing it. Deliberately far shorter than DEFAULT_IDLE_SUSPEND_MS: a
 * snapshot only describes the moment it was taken, so a machine whose agent
 * stopped reporting must become UNKNOWN before its frozen snapshot can age
 * into "idle_shell" and suspend work that started after the last report.
 */
export const ACTIVITY_SNAPSHOT_STALE_AFTER_MS = 2 * 60_000;

/**
 * The verdict for "the control plane cannot see what this machine is doing"
 * — no snapshot yet, or one too old to trust. It is not a protocol
 * SuspendVerdict reason (@suma/protocol is frozen, and decideSuspend only
 * ever answers about a snapshot it was handed), so it is modelled here — and
 * it is keep-awake by construction, which is §8.5's rule: any doubt keeps the
 * machine awake, because wrongly suspending silently stops the user's work
 * while wrongly staying awake only costs money the meter makes visible.
 */
const ACTIVITY_UNKNOWN = {
  suspend: false,
  reason: "activity_unknown",
} as const;

type LifecycleVerdict = SuspendVerdict | typeof ACTIVITY_UNKNOWN;

const ACTIVITY_UNKNOWN_EXPLANATION =
  "Waiting for the machine to report in — staying awake until it does.";

function explainLifecycle(verdict: LifecycleVerdict): string {
  return verdict.reason === "activity_unknown"
    ? ACTIVITY_UNKNOWN_EXPLANATION
    : explainVerdict(verdict);
}

/** The PTY that pinned the machine awake, when the verdict names one. */
function verdictPtyId(verdict: LifecycleVerdict): string | undefined {
  return "ptyId" in verdict ? verdict.ptyId : undefined;
}

function activityVerdict(
  activity: typeof machineActivity.$inferSelect,
  nowMs: number,
): LifecycleVerdict {
  // Freshness first: idleMs is measured from lastInteractionAt, which keeps
  // growing while nobody is reporting. Without this check a snapshot taken
  // while the machine was idle eventually says "suspend" no matter what the
  // machine has been doing since.
  if (
    nowMs - activity.lastReportAt.getTime() >
    ACTIVITY_SNAPSHOT_STALE_AFTER_MS
  ) {
    return ACTIVITY_UNKNOWN;
  }
  return decideSuspend({
    clientsAttached: activity.clientsAttached,
    processes: activity.processes,
    idleMs: Math.max(0, nowMs - activity.lastInteractionAt.getTime()),
    activeTransfers: activity.activeTransfers,
    idleSuspendAfterMs: DEFAULT_IDLE_SUSPEND_MS,
  });
}

/** The verdict for a machine, treating a missing snapshot as unknown. */
function lifecycleVerdict(
  activity: typeof machineActivity.$inferSelect | undefined,
  nowMs: number,
): LifecycleVerdict {
  return activity === undefined
    ? ACTIVITY_UNKNOWN
    : activityVerdict(activity, nowMs);
}

export function createApp(
  db: Db,
  sandbox: SandboxProvider = new StubSandboxProvider(),
  signing?: SigningKeys,
  notifier?: HubRevocationNotifier,
  objects: ObjectStore = new StubObjectStore(),
  // Default OFF for unit tests and embedded use. DEPLOYED entrypoints
  // (server.ts, dev-server.ts) must pass inviteOptionsFromEnv, where the
  // gate defaults ON (§11: invitation-only beta).
  inviteOptions: InviteOptions = INVITES_DISABLED,
  // Vended inference (src/inference.ts). Default CLOSED (no upstream key);
  // deployed entrypoints pass inferenceOptionsFromEnv.
  inferenceOptions: InferenceOptions = INFERENCE_DISABLED,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  const rp = rpConfigFromEnv(process.env);
  const signingPromise = signing
    ? Promise.resolve(signing)
    : getSigningKeys(process.env);
  const notifyHub = notifier ?? envHubNotifier(process.env);
  const challenges = new ChallengeStore();

  const deviceChallengeKey = (deviceId: string): string => `device:${deviceId}`;
  const webauthnRegisterKey = (userId: string): string =>
    `webauthn-register:${userId}`;
  const webauthnLoginKey = (userId: string): string =>
    `webauthn-login:${userId}`;

  const mintDeviceToken = async (
    userId: string,
    deviceId: string,
  ): Promise<{ deviceToken: string; exp: number }> => {
    const keys = await signingPromise;
    const iat = nowSeconds();
    const exp = iat + DEVICE_TOKEN_TTL_SECONDS;
    return {
      deviceToken: await signDeviceToken(keys.signingKey, {
        sub: userId,
        did: deviceId,
        iat,
        exp,
        jti: crypto.randomUUID(),
      }),
      exp,
    };
  };

  const activeDevice = async (userId: string, deviceId: string) => {
    const [device] = await db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.id, deviceId),
          eq(devices.userId, userId),
          isNull(devices.revokedAt),
        ),
      );
    return device;
  };

  type DeviceProofResult =
    | { ok: true; device: typeof devices.$inferSelect }
    | { ok: false; reason: string };

  // Proof of possession of the enrolled device identity key: an Ed25519
  // signature over deviceLoginSigningBytes(deviceId, one-time challenge).
  const verifyDeviceProof = async (
    deviceId: string,
    signatureB64: string,
  ): Promise<DeviceProofResult> => {
    const challenge = challenges.take(deviceChallengeKey(deviceId));
    if (!challenge) return { ok: false, reason: "challenge_expired" };
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId));
    if (!device) return { ok: false, reason: "unknown_device" };
    if (device.revokedAt) return { ok: false, reason: "device_revoked" };
    const publicKey = await importPublicKeyRaw(
      fromBase64(device.devicePublicKey),
    );
    const valid = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      fromBase64(signatureB64) as BufferSource,
      deviceLoginSigningBytes(deviceId, challenge) as BufferSource,
    );
    if (!valid) return { ok: false, reason: "bad_signature" };
    return { ok: true, device };
  };

  const audit = async (
    userId: string,
    type: string,
    payload: Record<string, unknown>,
    actorDeviceId?: string,
  ): Promise<void> => {
    await db
      .insert(auditEvents)
      .values({ userId, type, payload, actorDeviceId: actorDeviceId ?? null });
  };

  const ownedSpace = async (userId: string, spaceId: string) => {
    const [space] = await db
      .select()
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.userId, userId)));
    return space;
  };

  app.get("/healthz", (c) => c.json({ ok: true }));

  const v1 = new Hono<AuthEnv>();
  const auth = bearerAuth(db, () => signingPromise);
  const agentAuth = bearerAgent(db, () => signingPromise);
  const gatewayAuth = bearerGateway(process.env);

  v1.use("*", async (c, next) => {
    const isSignup = c.req.path === "/v1/accounts" && c.req.method === "POST";
    if (
      isSignup ||
      c.req.path === "/v1/healthz" ||
      PUBLIC_AUTH_PATHS.has(c.req.path)
    ) {
      return next();
    }
    // Operator-facing: authenticates itself against the invite admin secret,
    // never against device credentials.
    if (c.req.path === "/v1/admin/invites") return next();
    // Agent routes accept ONLY capability tokens; gateway routes ONLY the
    // egress-gateway secret; everything else ONLY device/user credentials.
    // The three families never cross (I-2, I-3).
    if (AGENT_PATHS.has(c.req.path)) return agentAuth(c, next);
    if (GATEWAY_PATHS.has(c.req.path)) return gatewayAuth(c, next);
    return auth(c, next);
  });

  v1.get("/healthz", (c) => c.json({ ok: true }));

  // Not real JWKS: a single raw Ed25519 public key, base64 — exactly what the
  // session hub operator copies into CONTROL_PUBLIC_KEY.
  v1.get("/auth/jwks", async (c) => {
    const keys = await signingPromise;
    return c.json({
      alg: "EdDSA",
      format: "raw-ed25519-base64",
      publicKey: keys.publicKeyBase64(),
    });
  });

  // Issued without a device lookup so callers cannot probe enrollment.
  v1.post(
    "/auth/device-challenge",
    zValidator("json", deviceChallengeSchema),
    (c) => {
      const { deviceId } = c.req.valid("json");
      return c.json({
        challenge: challenges.issue(deviceChallengeKey(deviceId)),
      });
    },
  );

  // Registers the device's enrolled Ed25519 identity key as a login
  // credential — the default path for headless desktop enrollment. Proof of
  // possession makes this self-authenticating.
  v1.post(
    "/auth/device-credential",
    zValidator("json", deviceCredentialSchema),
    async (c) => {
      const body = c.req.valid("json");
      const proof = await verifyDeviceProof(body.deviceId, body.signature);
      if (!proof.ok)
        return c.json({ error: "unauthorized", reason: proof.reason }, 401);
      if (proof.device.devicePublicKey !== body.devicePublicKey) {
        return c.json({ error: "unauthorized", reason: "key_mismatch" }, 401);
      }
      await audit(
        proof.device.userId,
        "auth.device_credential_registered",
        { deviceId: proof.device.id },
        proof.device.id,
      );
      const token = await mintDeviceToken(proof.device.userId, proof.device.id);
      return c.json({ ...token, credentialKind: "device-key" }, 201);
    },
  );

  v1.post(
    "/auth/device-login",
    zValidator("json", deviceLoginSchema),
    async (c) => {
      const body = c.req.valid("json");
      const proof = await verifyDeviceProof(body.deviceId, body.signature);
      if (!proof.ok)
        return c.json({ error: "unauthorized", reason: proof.reason }, 401);
      const token = await mintDeviceToken(proof.device.userId, proof.device.id);
      return c.json({ ...token, credentialKind: "device-key" });
    },
  );

  // Silent re-mint of the 10-minute token: a still-valid device token, or a
  // fresh device-login proof. Refused once the device is revoked.
  v1.post("/auth/token/refresh", async (c) => {
    const header = c.req.header("Authorization");
    const bearer = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : null;
    if (bearer && bearer.split(".").length === 3) {
      const keys = await signingPromise;
      const result = await verifyDeviceToken(
        keys.verifyKey,
        bearer,
        nowSeconds(),
      );
      if (!result.ok)
        return c.json({ error: "unauthorized", reason: result.reason }, 401);
      const device = await activeDevice(result.claims.sub, result.claims.did);
      if (!device)
        return c.json(
          { error: "unauthorized", reason: "device_not_active" },
          401,
        );
      return c.json(
        await mintDeviceToken(result.claims.sub, result.claims.did),
      );
    }
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = deviceLoginSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        { error: "unauthorized", reason: "missing_credentials" },
        401,
      );
    const proof = await verifyDeviceProof(
      parsed.data.deviceId,
      parsed.data.signature,
    );
    if (!proof.ok)
      return c.json({ error: "unauthorized", reason: proof.reason }, 401);
    return c.json(await mintDeviceToken(proof.device.userId, proof.device.id));
  });

  v1.post("/auth/webauthn/register/begin", async (c) => {
    const userId = c.get("userId");
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return c.json({ error: "not_found" }, 404);
    const challenge = challenges.issue(webauthnRegisterKey(userId));
    return c.json(
      beginRegistration(
        { id: user.id, email: user.email, displayName: user.displayName },
        rp,
        challenge,
      ),
    );
  });

  v1.post(
    "/auth/webauthn/register/finish",
    zValidator("json", webauthnRegisterFinishSchema),
    async (c) => {
      const userId = c.get("userId");
      const body = c.req.valid("json");
      const challenge = challenges.take(webauthnRegisterKey(userId));
      if (!challenge) return c.json({ error: "challenge_expired" }, 400);
      const result = await finishRegistration(rp, challenge, body.credential);
      if (!result.ok)
        return c.json(
          { error: "registration_rejected", reason: result.reason },
          400,
        );

      const [existing] = await db
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(eq(passkeys.id, result.credentialId));
      if (existing) return c.json({ error: "credential_exists" }, 409);
      const [passkey] = await db
        .insert(passkeys)
        .values({
          id: result.credentialId,
          userId,
          publicKey: result.publicKeyCose,
          prfCapable: result.prfCapable,
          signCount: result.signCount,
          label: body.label ?? null,
        })
        .returning();
      if (!passkey) return c.json({ error: "internal" }, 500);
      await audit(userId, "auth.passkey_registered", {
        credentialId: passkey.id,
        prfCapable: passkey.prfCapable,
      });

      // Device tokens are device-bound; without an enrolled device to bind to
      // (pure browser registration) the response carries no token.
      let token: { deviceToken: string; exp: number } | null = null;
      if (body.deviceId !== undefined) {
        const device = await activeDevice(userId, body.deviceId);
        if (!device) return c.json({ error: "unknown_device" }, 400);
        token = await mintDeviceToken(userId, device.id);
      }
      return c.json(
        { passkey, credentialKind: "webauthn", ...(token ?? {}) },
        201,
      );
    },
  );

  // Unauthenticated by nature; options are issued even for unknown users or
  // empty credential lists so the route cannot be used to probe accounts.
  v1.post(
    "/auth/webauthn/login/begin",
    zValidator("json", webauthnLoginBeginSchema),
    async (c) => {
      const { userId } = c.req.valid("json");
      const rows = await db
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(eq(passkeys.userId, userId));
      const challenge = challenges.issue(webauthnLoginKey(userId));
      return c.json(
        beginLogin(
          rows.map((r) => r.id),
          rp,
          challenge,
        ),
      );
    },
  );

  v1.post(
    "/auth/webauthn/login/finish",
    zValidator("json", webauthnLoginFinishSchema),
    async (c) => {
      const { userId, deviceId, credential } = c.req.valid("json");
      const challenge = challenges.take(webauthnLoginKey(userId));
      if (!challenge)
        return c.json(
          { error: "unauthorized", reason: "challenge_expired" },
          401,
        );
      const [passkey] = await db
        .select()
        .from(passkeys)
        .where(
          and(eq(passkeys.id, credential.id), eq(passkeys.userId, userId)),
        );
      if (!passkey)
        return c.json(
          { error: "unauthorized", reason: "unknown_credential" },
          401,
        );
      const result = await finishLogin(
        rp,
        challenge,
        { publicKey: passkey.publicKey, signCount: passkey.signCount },
        credential,
      );
      if (!result.ok)
        return c.json({ error: "unauthorized", reason: result.reason }, 401);
      const device = await activeDevice(userId, deviceId);
      if (!device)
        return c.json(
          { error: "unauthorized", reason: "device_not_active" },
          401,
        );
      await db
        .update(passkeys)
        .set({ signCount: result.signCount, lastUsedAt: new Date() })
        .where(eq(passkeys.id, passkey.id));
      const token = await mintDeviceToken(userId, device.id);
      return c.json({ ...token, credentialKind: "webauthn" });
    },
  );

  v1.post("/accounts", zValidator("json", signupSchema), async (c) => {
    const body = c.req.valid("json");
    const email = body.email.toLowerCase();
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (existing) return c.json({ error: "email_taken" }, 409);

    // §11: invitation-only beta. The single UPDATE ... WHERE unredeemed is
    // the claim — two racing signups with the same code cannot both pass.
    let claimedInvite: string | null = null;
    if (inviteOptions.required) {
      if (body.inviteCode === undefined) {
        return c.json(
          {
            error: "invite_required",
            explanation:
              "Suma's beta is invitation-only — signing up needs an invite code.",
          },
          403,
        );
      }
      const [claimed] = await db
        .update(invites)
        .set({ redeemedAt: new Date() })
        .where(
          and(
            eq(invites.code, body.inviteCode),
            isNull(invites.redeemedAt),
            or(isNull(invites.email), eq(invites.email, email)),
          ),
        )
        .returning({ code: invites.code });
      if (!claimed) {
        return c.json(
          {
            error: "invite_invalid",
            explanation:
              "That invite code is unknown, already used, or was issued to a different email.",
          },
          403,
        );
      }
      claimedInvite = claimed.code;
    }

    const releaseInvite = async (): Promise<void> => {
      if (claimedInvite !== null) {
        await db
          .update(invites)
          .set({ redeemedAt: null })
          .where(eq(invites.code, claimedInvite));
      }
    };

    const computeMode = body.computeMode ?? "cloud";
    const [user] = await db
      .insert(users)
      .values({
        email,
        displayName: body.displayName ?? null,
        homeRegion: body.homeRegion ?? "iad",
        features: [...DEFAULT_ACCOUNT_FEATURES],
        computeMode,
      })
      .returning();
    if (!user) {
      await releaseInvite();
      return c.json({ error: "internal" }, 500);
    }
    if (claimedInvite !== null) {
      await db
        .update(invites)
        .set({ redeemedByUserId: user.id })
        .where(eq(invites.code, claimedInvite));
      await audit(user.id, "invite.redeemed", { code: claimedInvite });
    }

    const [space] = await db
      .insert(spaces)
      .values({
        userId: user.id,
        name: DEFAULT_SPACE_NAME,
        color: DEFAULT_SPACE_COLOR,
        position: 0,
        egressPolicy: "direct",
      })
      .returning();

    // Local mode: the user's first Mac IS the computer — no machines row,
    // nothing to provision. The home device is recorded at enrollment.
    let machine = null;
    if (computeMode === "cloud") {
      const [inserted] = await db
        .insert(machines)
        .values({
          userId: user.id,
          state: "provisioning",
          region: user.homeRegion,
          cpuKind: DEFAULT_MACHINE_SPEC.cpuKind,
          cpus: DEFAULT_MACHINE_SPEC.cpus,
          memoryMb: DEFAULT_MACHINE_SPEC.memoryMb,
        })
        .returning();
      if (!inserted) return c.json({ error: "internal" }, 500);
      machine = inserted;

      const provisioned = await sandbox.provision({
        userId: user.id,
        machineId: machine.id,
        region: machine.region,
        spec: DEFAULT_MACHINE_SPEC,
      });
      if (provisioned.agentAddress !== null) {
        const [addressed] = await db
          .update(machines)
          .set({ agentAddress: provisioned.agentAddress })
          .where(eq(machines.id, machine.id))
          .returning();
        if (addressed) Object.assign(machine, addressed);
      }
    }
    if (!space) return c.json({ error: "internal" }, 500);
    await audit(user.id, "account.created", { email: user.email, computeMode });

    // Signed bootstrap token (did = sub): unforgeable from a known userId,
    // lets the first device enroll before it has a device credential. The
    // unsigned `hbr_dev_` stub still works against a dev control plane (no env
    // signing key) for tests/local use.
    const boot = await mintDeviceToken(user.id, user.id);
    return c.json(
      { user, space, machine, bootstrapToken: boot.deviceToken },
      201,
    );
  });

  // Operator-only invite minting (§11). Same plane-to-plane shared-secret
  // pattern as the egress gateway; with no secret configured the route is
  // CLOSED (404), never open.
  v1.post(
    "/admin/invites",
    zValidator("json", mintInvitesSchema),
    async (c) => {
      const secret = inviteOptions.adminToken;
      if (secret === null || secret.length === 0)
        return c.json({ error: "not_found" }, 404);
      const header = c.req.header("Authorization");
      const token = header?.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : null;
      if (token === null || !secretEquals(token, secret)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      const body = c.req.valid("json");
      const rows = Array.from({ length: body.count }, () => ({
        code: generateInviteCode(),
        email: body.email?.toLowerCase() ?? null,
        note: body.note ?? null,
      }));
      await db.insert(invites).values(rows);
      return c.json(
        { invites: rows.map((r) => ({ code: r.code, email: r.email })) },
        201,
      );
    },
  );

  v1.get("/me", async (c) => {
    const userId = c.get("userId");
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return c.json({ error: "not_found" }, 404);
    const userSpaces = await db
      .select()
      .from(spaces)
      .where(eq(spaces.userId, userId))
      .orderBy(spaces.position);
    const [machine] = await db
      .select()
      .from(machines)
      .where(eq(machines.userId, userId));
    const [active] = await db
      .select({ n: count() })
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
    return c.json({
      user,
      spaces: userSpaces,
      machine: machine ?? null,
      deviceCount: active?.n ?? 0,
      // Session-plane discovery (§7): the ws endpoint of the deployed hub,
      // e.g. wss://suma-sessionhub.<acct>.workers.dev/v1/hub/ws. Null when
      // the operator hasn't deployed one — clients stay on loopback sync.
      hubUrl: process.env["SUMA_HUB_PUBLIC_URL"] ?? null,
    });
  });

  // ---------------------------------------------------------------- //
  // Second-device enrollment codes (§8.2). An authenticated session mints
  // a short-lived single-use code; a fresh device redeems it for the same
  // signed bootstrap token a signup would get, then enrolls normally.
  // Possession of an enrolled device is what grants enrollment — the
  // stepping stone to the §9 approval-notification flow.
  // ---------------------------------------------------------------- //

  // The minting device generates the code and hashes it locally — the server
  // stores only the hash (never the plaintext) plus the sealed key wrappers
  // it can't open. `code` never crosses this route.
  v1.post(
    "/devices/enrollment-code",
    zValidator(
      "json",
      z.object({
        codeHash: z.string().length(64),
        wrapSalt: base64String(undefined, 1024).optional(),
        wrappers: z
          .array(
            z.object({
              credentialId: z.string().min(1).max(512),
              wrapped: base64String(undefined, 16384),
            }),
          )
          .max(64)
          .optional(),
      }),
    ),
    async (c) => {
      const userId = c.get("userId");
      const body = c.req.valid("json");
      const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MS);
      await db.insert(enrollmentCodes).values({
        codeHash: body.codeHash,
        userId,
        expiresAt,
        wrapSalt: body.wrapSalt ?? null,
        wrappers: body.wrappers ?? null,
      });
      await audit(
        userId,
        "device.enrollment_code_minted",
        {
          expiresAt: expiresAt.toISOString(),
          wrappedSecrets: body.wrappers?.length ?? 0,
        },
        c.get("deviceId") ?? undefined,
      );
      return c.json({ expiresAt: expiresAt.toISOString() }, 201);
    },
  );

  v1.post(
    "/auth/enrollment-code/redeem",
    zValidator("json", z.object({ code: z.string().min(4).max(128) })),
    async (c) => {
      const { code } = c.req.valid("json");
      // Conditional write on unredeemed+unexpired: two racing redeems of one
      // code cannot both pass, and the loser learns nothing it didn't know.
      // Clear the wrappers in the same write — they are single-use with the code.
      const [claimed] = await db
        .update(enrollmentCodes)
        .set({ redeemedAt: new Date() })
        .where(
          and(
            eq(enrollmentCodes.codeHash, hashEnrollmentCode(code)),
            isNull(enrollmentCodes.redeemedAt),
            gt(enrollmentCodes.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!claimed) return c.json({ error: "invalid_or_expired_code" }, 401);
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, claimed.userId));
      if (!user) return c.json({ error: "invalid_or_expired_code" }, 401);
      // Same shape as signup's bootstrap (did = sub): enough authority to run
      // the normal device-enrollment flow, nothing more.
      const boot = await mintDeviceToken(user.id, user.id);
      // The wrappers ride back once, then are purged so a leaked DB backup
      // taken after redemption holds nothing (they were opaque anyway).
      const wrapSalt = claimed.wrapSalt;
      const wrappers = claimed.wrappers;
      await db
        .update(enrollmentCodes)
        .set({ wrapSalt: null, wrappers: null })
        .where(eq(enrollmentCodes.codeHash, claimed.codeHash));
      await audit(user.id, "device.enrollment_code_redeemed", {});
      return c.json({
        user,
        bootstrapToken: boot.deviceToken,
        ...(wrapSalt !== null && wrappers !== null
          ? { wrapSalt, wrappers }
          : {}),
      });
    },
  );

  v1.post("/devices/enroll", zValidator("json", enrollSchema), async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");
    const [existing] = await db
      .select()
      .from(devices)
      .where(eq(devices.devicePublicKey, body.devicePublicKey));
    if (existing) {
      return c.json(
        {
          error: existing.revokedAt
            ? "device_revoked"
            : "device_already_enrolled",
        },
        409,
      );
    }
    const [device] = await db
      .insert(devices)
      .values({
        userId,
        name: body.name,
        platform: body.platform,
        devicePublicKey: body.devicePublicKey,
      })
      .returning();
    if (!device) return c.json({ error: "internal" }, 500);
    // Local compute mode: the first enrolled device becomes the home
    // machine. The isNull guard makes it first-wins — a racing second
    // enroll cannot steal the seat.
    let isHomeMachine = false;
    const [claimed] = await db
      .update(users)
      .set({ homeDeviceId: device.id })
      .where(
        and(
          eq(users.id, userId),
          eq(users.computeMode, "local"),
          isNull(users.homeDeviceId),
        ),
      )
      .returning({ id: users.id });
    if (claimed) {
      isHomeMachine = true;
      await audit(userId, "device.homeMachine", { deviceId: device.id }, device.id);
    }
    await audit(
      userId,
      "device.enrolled",
      { deviceId: device.id, name: device.name },
      device.id,
    );
    // Device-bound token: dies with the device on revocation (see auth.ts).
    return c.json(
      { device, hubToken: hubTokenFor(userId, device.id), isHomeMachine },
      201,
    );
  });

  v1.get("/devices", async (c) => {
    const userId = c.get("userId");
    const rows = await db
      .select()
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(devices.enrolledAt);
    return c.json({
      devices: rows.map((d) => ({ ...d, revoked: d.revokedAt !== null })),
    });
  });

  v1.patch(
    "/devices/:id",
    zValidator("param", idParamSchema),
    zValidator("json", renameDeviceSchema),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const { name } = c.req.valid("json");
      const [device] = await db
        .update(devices)
        .set({ name })
        .where(
          and(
            eq(devices.id, id),
            eq(devices.userId, userId),
            isNull(devices.revokedAt),
          ),
        )
        .returning();
      if (!device) return c.json({ error: "not_found" }, 404);
      await audit(userId, "device.renamed", { deviceId: id, name }, id);
      return c.json({ device: { ...device, revoked: false } });
    },
  );

  v1.post(
    "/devices/:id/revoke",
    zValidator("param", idParamSchema),
    zValidator("json", revokeSchema),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const [device] = await db
        .select()
        .from(devices)
        .where(and(eq(devices.id, id), eq(devices.userId, userId)));
      if (!device) return c.json({ error: "not_found" }, 404);

      let revoked = device;
      let hubNotified = false;
      if (!device.revokedAt) {
        const [row] = await db
          .update(devices)
          .set({ revokedAt: new Date(), revocationReason: reason ?? null })
          .where(eq(devices.id, id))
          .returning();
        if (row) revoked = row;
        await audit(userId, "device.revoked", {
          deviceId: id,
          reason: reason ?? null,
        });

        // Propagate to the session plane so live sockets die ≤ 60 s
        // (PRD §8.2). Anything not delivered right now is durably queued and
        // retried by the outbox drain (below + the server's periodic loop) —
        // a single failed HTTP call must never leave a revoked device syncing.
        try {
          hubNotified = await notifyHub(userId, id);
        } catch (err) {
          console.error(`hub revocation notify failed for device ${id}:`, err);
        }
        if (!hubNotified) {
          await db
            .insert(revocationOutbox)
            .values({ userId, deviceId: id, attempts: 0 });
        }
        // Opportunistically drain the backlog (also retries this row).
        await flushRevocationOutbox(db, notifyHub);
      }

      // The honest contract (PRD §8.2): Suma access dies within 60 s, but
      // third-party sessions already on the device can only be killed at the
      // origin — the response owns that instead of implying remote wipe.
      // controlPlaneAccessRevoked covers this API (device-bound tokens 401
      // from now on); hubNotified reports the SessionHub propagation above.
      return c.json({
        device: revoked,
        controlPlaneAccessRevoked: true,
        stoppedFutureAccess: true,
        purgeOnReconnect: true,
        cannotInvalidateThirdPartySessions: true,
        affectedOrigins: affectedOriginsOnRevoke(),
        hubNotified,
      });
    },
  );

  v1.get("/spaces", async (c) => {
    const userId = c.get("userId");
    const rows = await db
      .select()
      .from(spaces)
      .where(eq(spaces.userId, userId))
      .orderBy(spaces.position);
    return c.json({ spaces: rows });
  });

  v1.post("/spaces", zValidator("json", createSpaceSchema), async (c) => {
    const userId = c.get("userId");
    const body = c.req.valid("json");
    const [row] = await db
      .select({ m: max(spaces.position) })
      .from(spaces)
      .where(eq(spaces.userId, userId));
    const position = (row?.m ?? -1) + 1;
    const [space] = await db
      .insert(spaces)
      .values({
        userId,
        name: body.name,
        color: body.color,
        position,
        egressPolicy: body.egressPolicy ?? "direct",
      })
      .returning();
    if (!space) return c.json({ error: "internal" }, 500);
    return c.json({ space }, 201);
  });

  v1.patch(
    "/spaces/:id",
    zValidator("param", idParamSchema),
    zValidator("json", patchSpaceSchema),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const space = await ownedSpace(userId, id);
      if (!space) return c.json({ error: "not_found" }, 404);

      const [updated] = await db
        .update(spaces)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.position !== undefined ? { position: body.position } : {}),
          ...(body.egressPolicy !== undefined
            ? { egressPolicy: body.egressPolicy }
            : {}),
        })
        .where(eq(spaces.id, id))
        .returning();
      if (!updated) return c.json({ error: "internal" }, 500);

      if (
        body.egressPolicy !== undefined &&
        body.egressPolicy !== space.egressPolicy
      ) {
        await audit(userId, "space.updated", {
          spaceId: id,
          egressPolicy: { from: space.egressPolicy, to: body.egressPolicy },
        });
      }
      return c.json({ space: updated });
    },
  );

  v1.post(
    "/spaces/:id/wrappers",
    zValidator("param", idParamSchema),
    zValidator("json", wrapperSchema),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const space = await ownedSpace(userId, id);
      if (!space) return c.json({ error: "not_found" }, 404);

      const [existing] = await db
        .select({ id: keyWrappers.id })
        .from(keyWrappers)
        .where(
          and(
            eq(keyWrappers.spaceId, id),
            eq(keyWrappers.kind, body.kind),
            eq(keyWrappers.credentialId, body.credentialId),
          ),
        );
      const [wrapper] = await db
        .insert(keyWrappers)
        .values({
          userId,
          spaceId: id,
          kind: body.kind,
          credentialId: body.credentialId,
          salt: body.salt,
          wrapped: body.wrapped,
        })
        .onConflictDoUpdate({
          target: [
            keyWrappers.spaceId,
            keyWrappers.kind,
            keyWrappers.credentialId,
          ],
          set: { salt: body.salt, wrapped: body.wrapped },
        })
        .returning();
      if (!wrapper) return c.json({ error: "internal" }, 500);
      await audit(
        userId,
        existing ? "keys.wrapper_rotated" : "keys.wrapper_added",
        {
          spaceId: id,
          kind: body.kind,
          credentialId: body.credentialId,
        },
      );
      return c.json({ wrapper });
    },
  );

  v1.get(
    "/spaces/:id/wrappers",
    zValidator("param", idParamSchema),
    zValidator("query", wrapperListQuerySchema),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const { kind } = c.req.valid("query");
      const space = await ownedSpace(userId, id);
      if (!space) return c.json({ error: "not_found" }, 404);
      const rows = await db
        .select()
        .from(keyWrappers)
        .where(
          kind === undefined
            ? eq(keyWrappers.spaceId, id)
            : and(eq(keyWrappers.spaceId, id), eq(keyWrappers.kind, kind)),
        )
        .orderBy(keyWrappers.createdAt);
      return c.json({ wrappers: rows });
    },
  );

  // Stores the recovery-code wrapper: salt + wrapped root secret only — KEK
  // derivation and unwrap are client-side (PRD §8.2).
  v1.post(
    "/spaces/:id/recovery",
    zValidator("param", idParamSchema),
    zValidator("json", recoverySchema),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const space = await ownedSpace(userId, id);
      if (!space) return c.json({ error: "not_found" }, 404);
      const wrapper = await setRecoveryWrapper(
        db,
        userId,
        id,
        body.saltB64,
        body.wrappedB64,
      );
      if (!wrapper) return c.json({ error: "internal" }, 500);
      await audit(userId, "keys.recovery_set", { spaceId: id });
      return c.json({ wrapper });
    },
  );

  v1.delete(
    "/spaces/:id/wrappers/:wrapperId",
    zValidator("param", wrapperParamSchema),
    async (c) => {
      const userId = c.get("userId");
      const { id, wrapperId } = c.req.valid("param");
      const [deleted] = await db
        .delete(keyWrappers)
        .where(
          and(
            eq(keyWrappers.id, wrapperId),
            eq(keyWrappers.spaceId, id),
            eq(keyWrappers.userId, userId),
          ),
        )
        .returning();
      if (!deleted) return c.json({ error: "not_found" }, 404);
      await audit(userId, "keys.wrapper_removed", {
        wrapperId,
        spaceId: id,
        kind: deleted.kind,
        credentialId: deleted.credentialId,
      });
      return c.json({ deleted: true });
    },
  );

  v1.get("/machine", async (c) => {
    const userId = c.get("userId");
    const [machine] = await db
      .select()
      .from(machines)
      .where(eq(machines.userId, userId));
    if (!machine) {
      // Local mode has no machines row by design — answer 200 with the mode
      // so the desktop can tell "your Mac is the computer" from "control
      // plane down" (a real 404 stays a cloud-mode bug signal).
      const [user] = await db
        .select({
          computeMode: users.computeMode,
          homeDeviceId: users.homeDeviceId,
        })
        .from(users)
        .where(eq(users.id, userId));
      if (user && user.computeMode === "local") {
        return c.json({
          mode: "local",
          machine: null,
          events: [],
          homeDeviceId: user.homeDeviceId,
        });
      }
      return c.json({ error: "not_found" }, 404);
    }
    const events = await db
      .select()
      .from(machineEvents)
      .where(eq(machineEvents.machineId, machine.id))
      .orderBy(desc(machineEvents.createdAt))
      .limit(20);
    return c.json({ mode: "cloud", machine, events });
  });

  v1.post(
    "/machine/transition",
    zValidator("json", transitionSchema),
    async (c) => {
      const userId = c.get("userId");
      const body = c.req.valid("json");
      const [machine] = await db
        .select()
        .from(machines)
        .where(eq(machines.userId, userId));
      if (!machine) return c.json({ error: "not_found" }, 404);

      const from = machine.state as MachineState;
      if (!canTransition(from, body.to)) {
        return c.json({ error: "illegal_transition", from, to: body.to }, 422);
      }

      // The §8.5 suspend guard: while the agent's last snapshot shows real work
      // (non-shell process, Job Mode, attached client, transfer), suspending is
      // refused — the promise is enforced, not advisory. `force: true` is the
      // explicit user override; auto-suspend callers must never send it.
      //
      // A machine with NO snapshot (or a stale one) is refused too. The guard
      // must not be inert on the exact machines it knows least about: nothing
      // shipped creates the snapshot row yet, so "no snapshot ⇒ allow" meant a
      // live build could be auto-suspended with no refusal at all. §8.5's rule
      // is that doubt keeps the machine awake, and the user can always say so
      // explicitly with force.
      if (body.to === "suspending" && body.force !== true) {
        const [activity] = await db
          .select()
          .from(machineActivity)
          .where(eq(machineActivity.machineId, machine.id));
        const verdict = lifecycleVerdict(activity, Date.now());
        if (!verdict.suspend) {
          const ptyId = verdictPtyId(verdict);
          return c.json(
            {
              error: "would_interrupt_work",
              reason: verdict.reason,
              ...(ptyId !== undefined ? { ptyId } : {}),
            },
            409,
          );
        }
      }

      // Cold boot loses the process, never the context (§8.5): the wake-up
      // transition is always a reconstruction, whatever the caller says, so the
      // client can surface the "restored from cold start" notice.
      const reconstructed =
        (from === "cold_booting" && body.to === "running") ||
        (body.reconstructed ?? false);

      // Conditional write on the from-state we validated against: if a
      // concurrent transition moved the machine in between, zero rows match
      // and the caller gets a 409 instead of a silently illegal jump.
      const now = new Date();
      const [updated] = await db
        .update(machines)
        .set({ state: body.to, updatedAt: now, lastTransitionAt: now })
        .where(and(eq(machines.id, machine.id), eq(machines.state, from)))
        .returning();
      if (!updated)
        return c.json({ error: "conflict", from, to: body.to }, 409);
      const [event] = await db
        .insert(machineEvents)
        .values({
          machineId: machine.id,
          fromState: from,
          toState: body.to,
          reconstructed,
          detail: body.detail ?? null,
        })
        .returning();
      if (!event) return c.json({ error: "internal" }, 500);

      const spec: MachineSpec = {
        cpuKind: machine.cpuKind as MachineSpec["cpuKind"],
        cpus: machine.cpus,
        memoryMb: machine.memoryMb,
      };
      switch (body.to) {
        case "provisioning": {
          const provisioned = await sandbox.provision({
            userId,
            machineId: machine.id,
            region: machine.region,
            spec,
          });
          if (provisioned.agentAddress !== null) {
            await db
              .update(machines)
              .set({ agentAddress: provisioned.agentAddress })
              .where(eq(machines.id, machine.id));
          }
          break;
        }
        case "suspending":
          await sandbox.suspend(machine.id);
          break;
        case "resuming":
          await sandbox.resume(machine.id);
          break;
        case "cold_booting":
          await sandbox.coldBoot(machine.id);
          break;
        default:
          break;
      }

      await audit(userId, "machine.transition", {
        machineId: machine.id,
        from,
        to: body.to,
        reconstructed,
        ...(body.to === "suspending" ? { force: body.force ?? false } : {}),
      });
      return c.json({ machine: updated, event });
    },
  );

  // ---------------------------------------------------------------- //
  // Phase 2: process-aware lifecycle (§8.5)
  // ---------------------------------------------------------------- //

  // Agent-authenticated (capability token): the agent reports its activity
  // snapshot and learns whether it may suspend right now.
  v1.post(
    "/machine/activity",
    zValidator("json", activityReportSchema),
    async (c) => {
      const agent = c.get("agent");
      const refusal = agentReportRefusal(agent.caps);
      if (refusal)
        return c.json({ error: "capability_refused", reason: refusal }, 403);
      const body = c.req.valid("json");
      const now = new Date();
      // A future-dated interaction would freeze idleMs at zero and pin the
      // machine awake (and its cost) forever — clock skew only explains minutes.
      if (isFutureDated(body.lastInteractionAt, now.getTime())) {
        return c.json(
          {
            error: "out_of_range",
            field: "lastInteractionAt",
            reason: "in_future",
          },
          400,
        );
      }
      const values = {
        clientsAttached: body.clientsAttached,
        processes: body.processes,
        activeTransfers: body.activeTransfers,
        lastInteractionAt: new Date(body.lastInteractionAt),
        awakeMsAccrued: body.awakeMsAccrued,
        lastReportAt: now,
      };
      const [activity] = await db
        .insert(machineActivity)
        .values({ machineId: agent.machineId, ...values })
        .onConflictDoUpdate({ target: machineActivity.machineId, set: values })
        .returning();
      if (!activity) return c.json({ error: "internal" }, 500);
      return c.json({ verdict: activityVerdict(activity, now.getTime()) });
    },
  );

  // What the UI's VM pill and "why is this awake?" affordance read. A machine
  // that has never reported is an ANSWER, not an error: it is being kept
  // awake, and the pill says why rather than going blank.
  v1.get("/machine/lifecycle", async (c) => {
    const userId = c.get("userId");
    const [machine] = await db
      .select()
      .from(machines)
      .where(eq(machines.userId, userId));
    if (!machine) return c.json({ error: "not_found" }, 404);
    const [activity] = await db
      .select()
      .from(machineActivity)
      .where(eq(machineActivity.machineId, machine.id));
    const verdict = lifecycleVerdict(activity, Date.now());
    // Suspend-eligible (now or after the grace period): when it will happen.
    // Pinned awake — or unreported — means no scheduled suspend.
    const wouldSuspendAt =
      activity !== undefined &&
      (verdict.suspend || verdict.reason === "within_idle_grace")
        ? activity.lastInteractionAt.getTime() + DEFAULT_IDLE_SUSPEND_MS
        : null;
    return c.json({
      verdict,
      explanation: explainLifecycle(verdict),
      wouldSuspendAt,
      // Lets the UI distinguish "never reported" from "reported a while ago".
      reportedAt: activity?.lastReportAt ?? null,
    });
  });

  // Job Mode (§8.5): "keep running" pins the machine awake with a visible
  // cost meter. A user action, so device-authenticated and audited.
  v1.post("/machine/job-mode", zValidator("json", jobModeSchema), async (c) => {
    const userId = c.get("userId");
    const { ptyId, enabled } = c.req.valid("json");
    const [machine] = await db
      .select()
      .from(machines)
      .where(eq(machines.userId, userId));
    if (!machine) return c.json({ error: "not_found" }, 404);
    const [activity] = await db
      .select()
      .from(machineActivity)
      .where(eq(machineActivity.machineId, machine.id));
    if (!activity) return c.json({ error: "no_activity_reported" }, 404);
    if (!activity.processes.some((p) => p.ptyId === ptyId)) {
      return c.json({ error: "unknown_pty" }, 404);
    }
    const processes = activity.processes.map((p) =>
      p.ptyId === ptyId ? { ...p, jobMode: enabled } : p,
    );
    const [updated] = await db
      .update(machineActivity)
      .set({ processes })
      .where(eq(machineActivity.machineId, machine.id))
      .returning();
    if (!updated) return c.json({ error: "internal" }, 500);
    await audit(
      userId,
      "job.mode_changed",
      { machineId: machine.id, ptyId, enabled },
      c.get("deviceId") ?? undefined,
    );
    const verdict = activityVerdict(updated, Date.now());
    return c.json({ verdict, explanation: explainLifecycle(verdict) });
  });

  // ---------------------------------------------------------------- //
  // Phase 2: agent capability tokens (I-2)
  // ---------------------------------------------------------------- //

  v1.post(
    "/machine/capability-token",
    zValidator("json", capabilityRequestSchema),
    async (c) => {
      const userId = c.get("userId");
      const caps = [...new Set(c.req.valid("json").caps)];
      const [machine] = await db
        .select()
        .from(machines)
        .where(eq(machines.userId, userId));
      if (!machine) return c.json({ error: "not_found" }, 404);
      const [user] = await db
        .select({ features: users.features })
        .from(users)
        .where(eq(users.id, userId));
      const refused = refusedCaps(caps, user?.features ?? []);
      if (refused.length > 0) {
        return c.json({ error: "capability_refused", caps: refused }, 403);
      }
      const keys = await signingPromise;
      const minted = await mintCapabilityToken(
        keys.signingKey,
        machine.id,
        userId,
        caps,
        nowSeconds(),
      );
      await audit(
        userId,
        "capability.minted",
        { machineId: machine.id, caps, jti: minted.claims.jti },
        c.get("deviceId") ?? undefined,
      );
      return c.json({ token: minted.token, exp: minted.claims.exp, caps }, 201);
    },
  );

  // ---------------------------------------------------------------- //
  // Phase 2: usage metering (§11) and abuse controls (§9)
  // ---------------------------------------------------------------- //

  /** Shared range check for a sample's period, refused (400) rather than stored. */
  const periodStartRefusal = (
    periodStart: number,
    nowMs: number,
  ): string | null => {
    if (isFutureDated(periodStart, nowMs)) return "in_future";
    if (periodStart < nowMs - MAX_SAMPLE_BACKFILL_MS) return "too_old";
    return null;
  };

  // Agent-authenticated (capability token): append a COMPUTE/STORAGE sample.
  //
  // I-3: the compute plane is never the source of truth for egress. Proxied
  // bytes drive the §9 throttle the gateway acts on, so accepting them from
  // inside the user's VM would let one POST from a rooted machine throttle
  // that user's browser traffic and corrupt their cost figures. Egress comes
  // from POST /usage/egress (gateway plane) only.
  v1.post(
    "/usage/sample",
    zValidator("json", agentUsageSampleSchema),
    async (c) => {
      const agent = c.get("agent");
      const refusal = agentReportRefusal(agent.caps);
      if (refusal)
        return c.json({ error: "capability_refused", reason: refusal }, 403);
      const body = c.req.valid("json");
      if (body.proxiedBytes !== undefined || body.source === "gateway") {
        return c.json(
          {
            error: "egress_not_agent_reportable",
            reason:
              "Proxied egress is metered by the gateway plane, not by the machine agent.",
          },
          403,
        );
      }
      const nowMs = Date.now();
      const outOfRange = periodStartRefusal(body.periodStart, nowMs);
      if (outOfRange) {
        return c.json(
          { error: "out_of_range", field: "periodStart", reason: outOfRange },
          400,
        );
      }
      const [sample] = await db
        .insert(usageSamples)
        .values({
          userId: agent.userId,
          machineId: agent.machineId,
          periodStart: new Date(body.periodStart),
          awakeMs: body.awakeMs,
          proxiedBytes: 0,
          storageGb: body.storageGb,
          source: "agent",
        })
        .returning();
      if (!sample) return c.json({ error: "internal" }, 500);
      return c.json({ sample }, 201);
    },
  );

  // Gateway-authenticated (shared secret): append an EGRESS sample. The
  // `source` is set by the route, never by the body — nothing the agent can
  // send reaches this branch, which is what makes the split hold (I-3).
  v1.post(
    "/usage/egress",
    zValidator("json", gatewayUsageSampleSchema),
    async (c) => {
      if (c.get("gateway") === undefined)
        return c.json({ error: "unauthorized" }, 401);
      const body = c.req.valid("json");
      const nowMs = Date.now();
      const outOfRange = periodStartRefusal(body.periodStart, nowMs);
      if (outOfRange) {
        return c.json(
          { error: "out_of_range", field: "periodStart", reason: outOfRange },
          400,
        );
      }
      // §8.8: one machine per account, so the account identifies the machine.
      const [machine] = await db
        .select()
        .from(machines)
        .where(eq(machines.userId, body.userId));
      if (!machine) return c.json({ error: "not_found" }, 404);
      const [sample] = await db
        .insert(usageSamples)
        .values({
          userId: body.userId,
          machineId: machine.id,
          periodStart: new Date(body.periodStart),
          awakeMs: 0,
          proxiedBytes: body.proxiedBytes,
          storageGb: 0,
          source: "gateway",
        })
        .returning();
      if (!sample) return c.json({ error: "internal" }, 500);
      return c.json({ sample }, 201);
    },
  );

  // The §11 cost meter: aggregated line items plus the gateway's throttle
  // signal (egress caps are enforced by the gateway acting on `throttled`).
  v1.get(
    "/usage/summary",
    zValidator("query", usageSummaryQuerySchema),
    async (c) => {
      const userId = c.get("userId");
      const { days } = c.req.valid("query");
      const [machine] = await db
        .select()
        .from(machines)
        .where(eq(machines.userId, userId));
      if (!machine) return c.json({ error: "not_found" }, 404);
      const nowMs = Date.now();
      const since = new Date(nowMs - days * DAY_MS);
      const rows = await db
        .select()
        .from(usageSamples)
        .where(
          and(
            eq(usageSamples.userId, userId),
            gte(usageSamples.periodStart, since),
          ),
        )
        .orderBy(usageSamples.periodStart, usageSamples.createdAt);
      // Each plane contributes only the figures it is the source of truth for:
      // compute/storage from the agent, egress from the gateway. A row that
      // came from compute counts for ZERO bytes even if it somehow carries
      // some — defence in depth behind the 403 on POST /usage/sample (I-3).
      let awakeMs = 0;
      let storageGb = 0;
      let proxiedBytes = 0;
      let lastDayProxiedBytes = 0;
      for (const row of rows) {
        if (row.source === "gateway") {
          proxiedBytes += row.proxiedBytes;
          if (row.periodStart.getTime() >= nowMs - DAY_MS)
            lastDayProxiedBytes += row.proxiedBytes;
          continue;
        }
        awakeMs += row.awakeMs;
        // Storage is a level, not a total: the newest agent reading wins.
        storageGb = row.storageGb;
      }
      return c.json({
        days,
        totals: { awakeMs, proxiedBytes, storageGb },
        hourlyRateUsd: hourlyRateUsd(machine.memoryMb, machine.cpus),
        estimate: estimateMonthlyCost(
          { memoryMb: machine.memoryMb, cpus: machine.cpus },
          { awakeMs, proxiedBytes },
        ),
        throttled: egressThrottled(lastDayProxiedBytes),
      });
    },
  );

  // Boost (§8.5 stop/start resize) behind the §9 per-day cap.
  v1.post("/machine/boost", zValidator("json", boostSchema), async (c) => {
    const userId = c.get("userId");
    const { memoryMb } = c.req.valid("json");
    const [machine] = await db
      .select()
      .from(machines)
      .where(eq(machines.userId, userId));
    if (!machine) return c.json({ error: "not_found" }, 404);
    const from = machine.state as MachineState;
    if (!canTransition(from, "boosting")) {
      return c.json({ error: "illegal_transition", from, to: "boosting" }, 422);
    }

    const [row] = await db
      .select({ n: count() })
      .from(machineEvents)
      .where(
        and(
          eq(machineEvents.machineId, machine.id),
          eq(machineEvents.toState, "boosting"),
          gte(machineEvents.createdAt, new Date(Date.now() - DAY_MS)),
        ),
      );
    const boostsToday = row?.n ?? 0;
    const check = checkBoost(boostsToday);
    if (!check.allowed) {
      await audit(
        userId,
        "abuse.limit_hit",
        {
          limit: check.limit,
          reason: check.reason,
          count: boostsToday,
          max: ABUSE_LIMITS.maxBoostsPerDay,
        },
        c.get("deviceId") ?? undefined,
      );
      return c.json(
        { error: "abuse_limit", limit: check.limit, reason: check.reason },
        429,
      );
    }

    const now = new Date();
    const [updated] = await db
      .update(machines)
      .set({
        state: "boosting",
        memoryMb,
        updatedAt: now,
        lastTransitionAt: now,
      })
      .where(and(eq(machines.id, machine.id), eq(machines.state, from)))
      .returning();
    if (!updated)
      return c.json({ error: "conflict", from, to: "boosting" }, 409);
    const [event] = await db
      .insert(machineEvents)
      .values({
        machineId: machine.id,
        fromState: from,
        toState: "boosting",
        detail: `boost to ${memoryMb} MB`,
      })
      .returning();
    if (!event) return c.json({ error: "internal" }, 500);
    await sandbox.updateSpec(machine.id, {
      cpuKind: machine.cpuKind as MachineSpec["cpuKind"],
      cpus: machine.cpus,
      memoryMb,
    });
    await audit(
      userId,
      "machine.boosted",
      { machineId: machine.id, memoryMb },
      c.get("deviceId") ?? undefined,
    );
    return c.json({ machine: updated, event });
  });

  // ---------------------------------------------------------------- //
  // Phase 3: Files, chunk manifests, transfers, quota (§8.6)
  // ---------------------------------------------------------------- //

  /**
   * Every Files mutation reads state and then writes based on it — the quota,
   * a chunk's reference count, the number of transfers in flight. Read and
   * write must therefore happen inside ONE transaction holding ONE lock, or
   * two overlapping requests each act on a picture the other has already
   * invalidated: two deletes both decrement a shared chunk to zero and destroy
   * bytes a third file still names, and N concurrent creates each pass a quota
   * check none of them would pass afterwards.
   *
   * The lock is the account's own `users` row, taken FIRST and always, so the
   * ordering is total and there is nothing to deadlock against. It serializes
   * one account's writes and no one else's.
   */
  const lockAccount = async (tx: Db, userId: string): Promise<void> => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
  };

  /**
   * Bytes this account is responsible for: every DISTINCT chunk still
   * referenced by one of its files, counted once. Deduplication is therefore
   * visible in the quota — storing the same content at two paths costs what it
   * costs on disk, not twice.
   */
  const quotaState = async (tx: Db, userId: string): Promise<QuotaState> => {
    const [row] = await tx
      .select({ used: sum(chunks.sizeBytes) })
      .from(chunks)
      .where(and(eq(chunks.userId, userId), gt(chunks.refCount, 0)));
    return { usedBytes: Number(row?.used ?? 0), limitBytes: PRO_QUOTA_BYTES };
  };

  /** Postgres LIKE metacharacters in a user-supplied prefix. */
  const escapeLike = (value: string): string =>
    value.replace(/[\\%_]/g, "\\$&");

  /** Multi-row inserts stay under the driver's bind-parameter ceiling. */
  const inBatches = <T>(rows: ReadonlyArray<T>, size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += size)
      out.push(rows.slice(i, i + size));
    return out;
  };

  const ownedFile = async (tx: Db, userId: string, fileId: string) => {
    const [file] = await tx
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId)));
    return file;
  };

  const distinctFileHashes = async (
    tx: Db,
    fileId: string,
  ): Promise<string[]> => {
    const rows = await tx
      .selectDistinct({ hash: fileChunks.hash })
      .from(fileChunks)
      .where(eq(fileChunks.fileId, fileId));
    return rows.map((r) => r.hash);
  };

  /**
   * Drop a file's manifest rows and answer which distinct chunks it named. The
   * reference release is a separate step (`releaseHashes`) because a REPLACE
   * must take the new manifest's references BEFORE giving up the old ones —
   * see the create-from-manifest route.
   */
  const detachFileChunks = async (
    tx: Db,
    fileId: string,
  ): Promise<string[]> => {
    const hashes = await distinctFileHashes(tx, fileId);
    await tx.delete(fileChunks).where(eq(fileChunks.fileId, fileId));
    return hashes;
  };

  /**
   * Drop one claim on each of these chunks and answer the hashes that reached
   * zero references. A chunk survives as long as any other file of this user
   * still names it, so releasing one file can never orphan or prematurely
   * delete chunks a sibling shares.
   *
   * The decrement and the removal are one conditional DELETE ... RETURNING, so
   * the rows this transaction actually removed are exactly the objects it may
   * delete — a concurrent release cannot see the same zero and delete twice,
   * and (with `lockAccount` held) cannot decrement the same claim twice.
   * The objects themselves go after the commit; see `deleteOrphanObjects`.
   */
  const releaseHashes = async (
    tx: Db,
    userId: string,
    hashes: ReadonlyArray<string>,
  ): Promise<string[]> => {
    if (hashes.length === 0) return [];
    const owned = and(
      eq(chunks.userId, userId),
      inArray(chunks.hash, [...hashes]),
    );
    await tx
      .update(chunks)
      .set({ refCount: sql`GREATEST(${chunks.refCount} - 1, 0)` })
      .where(owned);
    const orphans = await tx
      .delete(chunks)
      .where(and(owned, eq(chunks.refCount, 0)))
      .returning({ hash: chunks.hash });
    return orphans.map((o) => o.hash);
  };

  /**
   * Remove the bytes of chunks no file references any more.
   *
   * Deliberately AFTER the transaction commits: an object store has no
   * rollback, so deleting inside a transaction that later aborts would destroy
   * data the surviving rows still promise. The recheck closes the opposite
   * window — if a manifest posted in between has re-claimed the hash, its row
   * is fresh (`storedAt` null) and the object is not ours to delete.
   */
  const deleteOrphanObjects = async (
    userId: string,
    hashes: ReadonlyArray<string>,
  ): Promise<void> => {
    if (hashes.length === 0) return;
    const reclaimed = new Set(
      (await ownedChunks(db, userId, hashes)).map((row) => row.hash),
    );
    for (const hash of hashes) {
      if (reclaimed.has(hash)) continue;
      await objects.delete(chunkObjectKey(userId, hash));
    }
  };

  /** Record a manifest's chunk rows and take one reference per distinct chunk. */
  const attachChunks = async (
    tx: Db,
    userId: string,
    fileId: string,
    manifest: Manifest,
  ): Promise<void> => {
    for (const group of inBatches(distinctChunks(manifest), 500)) {
      await tx
        .insert(chunks)
        .values(
          group.map((chunk) => ({
            userId,
            hash: chunk.hash,
            sizeBytes: chunk.length,
            refCount: 1,
          })),
        )
        .onConflictDoUpdate({
          target: [chunks.userId, chunks.hash],
          set: { refCount: sql`${chunks.refCount} + 1` },
        });
    }
    const rows = manifest.chunks.map((chunk, idx) => ({
      fileId,
      idx,
      hash: chunk.hash,
      offset: chunk.offset,
      length: chunk.length,
    }));
    for (const group of inBatches(rows, 1000))
      await tx.insert(fileChunks).values(group);
  };

  /** The chunk rows this user already has for the named hashes. */
  const ownedChunks = async (
    tx: Db,
    userId: string,
    hashes: ReadonlyArray<string>,
  ) => {
    if (hashes.length === 0) return [];
    const rows = [];
    for (const group of inBatches(hashes, 1000)) {
      rows.push(
        ...(await tx
          .select()
          .from(chunks)
          .where(and(eq(chunks.userId, userId), inArray(chunks.hash, group)))),
      );
    }
    return rows;
  };

  const quotaBody = (verdict: ReturnType<typeof checkQuota>) => ({
    error: "quota_exceeded",
    softBlocked: verdict.softBlocked,
    usedBytes: verdict.usedBytes,
    limitBytes: verdict.limitBytes,
    explanation: verdict.explanation,
  });

  const accountFeatures = async (
    userId: string,
  ): Promise<ReadonlyArray<string>> => {
    const [user] = await db
      .select({ features: users.features })
      .from(users)
      .where(eq(users.id, userId));
    return user?.features ?? [];
  };

  // Create-from-manifest: the client chunked the file locally and says what it
  // is made of; the control plane records that and answers with the chunks it
  // does NOT already hold, so only those are uploaded (dedup).
  v1.post(
    "/files/manifest",
    zValidator("json", createFromManifestSchema),
    async (c) => {
      const userId = c.get("userId");
      const body = c.req.valid("json");
      const path = normalizeFilePath(body.path);
      if (!path.ok)
        return c.json({ error: "invalid_path", reason: path.reason }, 400);
      const badManifest = validateManifest(body.manifest);
      if (badManifest)
        return c.json({ error: "invalid_manifest", reason: badManifest }, 400);

      const wanted = distinctChunks(body.manifest);
      const wantedHashes = wanted.map((chunk) => chunk.hash);

      const outcome = await db.transaction(async (tx) => {
        await lockAccount(tx, userId);

        // Only chunks with no row yet add to the quota: the rest are already
        // counted, which is what makes a re-upload of shared content free. When
        // this write replaces a path, the outgoing file's bytes still count here
        // — conservative on purpose, since the release below must not happen
        // until the write is known to be allowed.
        const known = new Set(
          (await ownedChunks(tx, userId, wantedHashes)).map((row) => row.hash),
        );
        const incoming = wanted
          .filter((chunk) => !known.has(chunk.hash))
          .reduce((total, chunk) => total + chunk.length, 0);
        const verdict = checkQuota(await quotaState(tx, userId), incoming);
        if (!verdict.allowed)
          return { kind: "quota" as const, verdict, incoming };

        const now = new Date();
        const [existing] = await tx
          .select()
          .from(files)
          .where(and(eq(files.userId, userId), eq(files.path, path.path)));
        let file;
        if (existing) {
          [file] = await tx
            .update(files)
            .set({
              sizeBytes: body.manifest.totalBytes,
              fileHash: body.manifest.fileHash,
              contentType: body.contentType ?? null,
              completedAt: null,
              updatedAt: now,
            })
            .where(eq(files.id, existing.id))
            .returning();
        } else {
          [file] = await tx
            .insert(files)
            .values({
              userId,
              path: path.path,
              sizeBytes: body.manifest.totalBytes,
              fileHash: body.manifest.fileHash,
              contentType: body.contentType ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
        }
        if (!file) return { kind: "internal" as const };

        // ACQUIRE BEFORE RELEASE. A new version of a file usually shares chunks
        // with the one it replaces. Releasing first would take those shared
        // chunks to zero references, delete their rows AND their bytes, and the
        // re-insert below would then quietly re-create the rows as un-stored —
        // so the answer "nothing to upload" would be a lie and the previous
        // version's data would already be gone. Taking the new references first
        // means a reused chunk never reaches zero and never leaves the bucket.
        const releasing = existing
          ? await detachFileChunks(tx, existing.id)
          : [];
        await attachChunks(tx, userId, file.id, body.manifest);
        const orphans = await releaseHashes(tx, userId, releasing);

        // `missing` is read back from the POST-mutation rows, so it describes
        // the bucket as it will actually be when the client starts uploading —
        // not as it was before this request rearranged the references.
        const after = await ownedChunks(tx, userId, wantedHashes);
        const stored = new Set(
          after.filter((row) => row.storedAt !== null).map((row) => row.hash),
        );
        return {
          kind: "ok" as const,
          file,
          verdict,
          orphans,
          created: existing === undefined,
          missing: missingChunkRefs(body.manifest, (hash) => stored.has(hash)),
        };
      });

      if (outcome.kind === "internal")
        return c.json({ error: "internal" }, 500);
      if (outcome.kind === "quota") {
        await audit(
          userId,
          "files.quota_blocked",
          {
            path: path.path,
            incomingBytes: outcome.incoming,
            usedBytes: outcome.verdict.usedBytes,
          },
          c.get("deviceId") ?? undefined,
        );
        return c.json(quotaBody(outcome.verdict), 413);
      }
      await deleteOrphanObjects(userId, outcome.orphans);

      return c.json(
        {
          file: fileEntryView(outcome.file),
          complete: false,
          missing: outcome.missing,
          quota: {
            usedBytes: outcome.verdict.usedBytes,
            limitBytes: outcome.verdict.limitBytes,
          },
        },
        outcome.created ? 201 : 200,
      );
    },
  );

  // Complete-upload: confirm every chunk's bytes really are in the object
  // store before the file counts as readable. A manifest is a promise; this is
  // the receipt, and a listing must never show one as the other.
  v1.post(
    "/files/complete",
    zValidator("json", completeUploadSchema),
    async (c) => {
      const userId = c.get("userId");
      const { fileId } = c.req.valid("json");
      const file = await ownedFile(db, userId, fileId);
      if (!file) return c.json({ error: "not_found" }, 404);

      // The HEADs are network round trips, so they happen BEFORE the
      // transaction: holding this account's write lock while waiting on the
      // bucket would stall every other write it makes.
      const rows = await ownedChunks(
        db,
        userId,
        await distinctFileHashes(db, file.id),
      );
      const confirmed: string[] = [];
      const missing: string[] = [];
      const rejected: Array<{
        hash: string;
        declaredBytes: number;
        storedBytes: number;
      }> = [];
      for (const row of rows) {
        if (row.storedAt !== null) continue;
        const key = chunkObjectKey(userId, row.hash);
        const head = await objects.head(key);
        // An absent object is simply missing: the client has not uploaded it.
        if (head === null) {
          missing.push(row.hash);
          continue;
        }
        // A size that disagrees with the manifest is worse than missing. The
        // bytes at that key cannot hash to the chunk address they are filed
        // under, so no file will ever reassemble from them — and left in place
        // they are storage the account is paying for (the quota is charged from
        // the DECLARED length) with nothing that can ever read them. Declining
        // to mark it stored is not enough; the object goes.
        if (head.sizeBytes !== row.sizeBytes) {
          await objects.delete(key);
          rejected.push({
            hash: row.hash,
            declaredBytes: row.sizeBytes,
            storedBytes: head.sizeBytes,
          });
          missing.push(row.hash);
          continue;
        }
        confirmed.push(row.hash);
      }
      if (rejected.length > 0) {
        await audit(
          userId,
          "files.chunk_rejected",
          {
            fileId: file.id,
            path: file.path,
            count: rejected.length,
            // Bounded: a manifest may declare thousands of chunks, and an audit
            // payload is not the place to enumerate all of them.
            chunks: rejected.slice(0, 20),
          },
          c.get("deviceId") ?? undefined,
        );
      }

      const result = await db.transaction(async (tx) => {
        for (const group of inBatches(confirmed, 1000)) {
          // `storedAt IS NULL` keeps this from overwriting an earlier, honest
          // confirmation with a later timestamp.
          await tx
            .update(chunks)
            .set({ storedAt: new Date() })
            .where(
              and(
                eq(chunks.userId, userId),
                inArray(chunks.hash, group),
                isNull(chunks.storedAt),
              ),
            );
        }
        if (missing.length > 0) return { kind: "missing" as const, missing };
        // Re-read the file's chunk set inside the transaction: a replace that
        // landed while the HEADs were in flight swapped the manifest under this
        // call, and a file may only be called complete when the chunks it names
        // RIGHT NOW are all stored.
        const current = await ownedFile(tx, userId, fileId);
        if (!current) return { kind: "gone" as const };
        const unstored = (
          await ownedChunks(
            tx,
            userId,
            await distinctFileHashes(tx, current.id),
          )
        )
          .filter((row) => row.storedAt === null)
          .map((row) => row.hash);
        if (unstored.length > 0)
          return { kind: "missing" as const, missing: unstored };
        const now = new Date();
        const [updated] = await tx
          .update(files)
          .set({ completedAt: now, updatedAt: now })
          .where(eq(files.id, current.id))
          .returning();
        return updated
          ? { kind: "ok" as const, file: updated }
          : { kind: "gone" as const };
      });

      if (result.kind === "gone") return c.json({ error: "not_found" }, 404);
      if (result.kind === "missing") {
        return c.json(
          { error: "chunks_missing", missing: result.missing },
          409,
        );
      }
      await audit(
        userId,
        "files.uploaded",
        {
          fileId: result.file.id,
          path: result.file.path,
          sizeBytes: result.file.sizeBytes,
        },
        c.get("deviceId") ?? undefined,
      );
      return c.json({ file: fileEntryView(result.file), complete: true });
    },
  );

  v1.get("/files/quota", async (c) => {
    const userId = c.get("userId");
    const state = await quotaState(db, userId);
    const verdict = checkQuota(state, 0);
    const [row] = await db
      .select({ n: count() })
      .from(files)
      .where(eq(files.userId, userId));
    return c.json({
      usedBytes: state.usedBytes,
      limitBytes: state.limitBytes,
      softBlocked: verdict.softBlocked,
      explanation: verdict.explanation,
      fileCount: row?.n ?? 0,
    });
  });

  v1.get("/files/stat", zValidator("query", statQuerySchema), async (c) => {
    const userId = c.get("userId");
    const path = normalizeFilePath(c.req.valid("query").path);
    if (!path.ok)
      return c.json({ error: "invalid_path", reason: path.reason }, 400);
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), eq(files.path, path.path)));
    if (!file) return c.json({ error: "not_found" }, 404);
    const [row] = await db
      .select({ n: count() })
      .from(fileChunks)
      .where(eq(fileChunks.fileId, file.id));
    return c.json({
      file: fileEntryView(file),
      complete: file.completedAt !== null,
      chunkCount: row?.n ?? 0,
    });
  });

  // The stored chunk list for one file, in order. Reading a file back needs
  // this: the client presigns each chunk, verifies its BLAKE3, and assembles.
  // Without it the manifest is write-only and both preview and hydration are
  // impossible — the rows existed but nothing served them.
  v1.get("/files/manifest", zValidator("query", statQuerySchema), async (c) => {
    const userId = c.get("userId");
    const path = normalizeFilePath(c.req.valid("query").path);
    if (!path.ok)
      return c.json({ error: "invalid_path", reason: path.reason }, 400);
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, userId), eq(files.path, path.path)));
    if (!file) return c.json({ error: "not_found" }, 404);
    // An incomplete file has chunks the store may not hold yet; handing back a
    // manifest for it would produce a confusing "missing chunk" mid-assembly.
    if (file.completedAt === null) return c.json({ error: "incomplete" }, 409);
    const rows = await db
      .select({
        hash: fileChunks.hash,
        offset: fileChunks.offset,
        length: fileChunks.length,
      })
      .from(fileChunks)
      .where(eq(fileChunks.fileId, file.id))
      .orderBy(fileChunks.idx);
    return c.json({
      manifest: {
        fileHash: file.fileHash,
        totalBytes: file.sizeBytes,
        chunks: rows.map((r) => ({
          hash: r.hash,
          offset: r.offset,
          length: r.length,
        })),
      },
    });
  });

  // Presigned PUT for one chunk. Only for a chunk this user has DECLARED in a
  // manifest, and only while it is still missing: without both conditions the
  // route would hand out write access to arbitrary keys in the bucket.
  //
  // The grant is also bounded by SIZE, not only by key. The quota is charged
  // from the length the manifest declared, so a URL that accepted any body
  // would let a client declare 4 MiB and store gigabytes against it — and
  // never call `complete`, where the size is checked. `presignPut` signs the
  // content length, so the bucket refuses the oversized body itself.
  v1.post(
    "/files/chunks/:hash/upload-url",
    zValidator("param", chunkParamSchema),
    async (c) => {
      const userId = c.get("userId");
      const { hash } = c.req.valid("param");
      const [chunk] = await db
        .select()
        .from(chunks)
        .where(and(eq(chunks.userId, userId), eq(chunks.hash, hash)));
      if (!chunk) return c.json({ error: "not_found" }, 404);
      const verdict = checkQuota(await quotaState(db, userId), 0);
      if (verdict.softBlocked) return c.json(quotaBody(verdict), 413);
      if (chunk.storedAt !== null) {
        return c.json({
          hash,
          alreadyStored: true,
          sizeBytes: chunk.sizeBytes,
        });
      }
      const upload = await objects.presignPut(
        chunkObjectKey(userId, hash),
        PRESIGN_TTL_SECONDS,
        chunk.sizeBytes,
      );
      return c.json({
        hash,
        alreadyStored: false,
        sizeBytes: chunk.sizeBytes,
        upload,
      });
    },
  );

  // Presigned GET for one chunk — the hydration path. Scoped to the caller's
  // own chunks, so a hash learned elsewhere reads nothing.
  v1.get(
    "/files/chunks/:hash/download-url",
    zValidator("param", chunkParamSchema),
    async (c) => {
      const userId = c.get("userId");
      const { hash } = c.req.valid("param");
      const [chunk] = await db
        .select()
        .from(chunks)
        .where(and(eq(chunks.userId, userId), eq(chunks.hash, hash)));
      if (!chunk || chunk.storedAt === null)
        return c.json({ error: "not_found" }, 404);
      const download = await objects.presignGet(
        chunkObjectKey(userId, hash),
        PRESIGN_TTL_SECONDS,
      );
      return c.json({ hash, sizeBytes: chunk.sizeBytes, download });
    },
  );

  // ---------------------------------------------------------------- //
  // Transfers (§8.6 cloud fetch). Registered before /files/:id so the
  // literal segments always win.
  // ---------------------------------------------------------------- //

  // What every other device polls: M-3 requires a transfer's progress and
  // completion to be visible everywhere, not only on the Mac that started it.
  v1.get(
    "/files/transfers",
    zValidator("query", transfersListQuerySchema),
    async (c) => {
      const userId = c.get("userId");
      const { state, limit } = c.req.valid("query");
      const rows = await db
        .select()
        .from(transfers)
        .where(
          state === undefined
            ? eq(transfers.userId, userId)
            : and(eq(transfers.userId, userId), eq(transfers.state, state)),
        )
        .orderBy(desc(transfers.startedAt), desc(transfers.id))
        .limit(limit);
      return c.json({ transfers: rows.map(transferView) });
    },
  );

  /**
   * Queue a cloud fetch. The eligibility decision is made client-side (the
   * browser is the only place that knows whether the request would carry
   * cookies or a client certificate), but the URL-shaped half of
   * `cloudFetchEligibility` is re-run HERE so a caller cannot skip it.
   *
   * The credential flags are passed as false because there is nothing else
   * they could be: this API has no field that can carry a cookie, a header, or
   * a certificate, and adding one is exactly what §8.6 forbids. The schema is
   * `.strict()`, so an attempt to send one is a 400 rather than a silent drop.
   */
  v1.post(
    "/files/transfers",
    zValidator("json", createTransferSchema),
    async (c) => {
      const userId = c.get("userId");
      const body = c.req.valid("json");
      const destPath = normalizeFilePath(body.destPath);
      if (!destPath.ok)
        return c.json({ error: "invalid_path", reason: destPath.reason }, 400);

      if (!(await accountFeatures(userId)).includes("cloud-fetch")) {
        return c.json(
          { error: "feature_required", feature: "cloud-fetch" },
          403,
        );
      }

      // `null` means "the origin declared no length", which is the only thing
      // that may skip the 50 MiB floor — a DECLARED size below it is refused
      // here exactly as it is in the browser.
      const declaredBytes = body.totalBytes ?? null;
      const eligibility = cloudFetchEligibility({
        url: body.url,
        totalBytes: declaredBytes,
        hasCookies: false,
        hasAuthHeader: false,
        usesClientCert: false,
        alwaysLocal: false,
      });
      if (!eligibility.eligible) {
        return c.json(
          {
            error: "not_eligible",
            reason: eligibility.reason,
            explanation: eligibility.explanation,
          },
          422,
        );
      }

      const totalBytes = declaredBytes ?? 0;
      // An unknown length is not a free one. Charging the quota check zero made
      // it a check every account passes, so a client that simply omitted
      // `totalBytes` could queue transfers with no admission control at all.
      // Cloud fetch only ever handles downloads above the floor, so an
      // undeclared transfer is admitted against exactly that much headroom —
      // the smallest figure it could honestly turn out to be.
      const admissionBytes = declaredBytes ?? CLOUD_FETCH_MIN_BYTES;

      const outcome = await db.transaction(async (tx) => {
        await lockAccount(tx, userId);
        const verdict = checkQuota(
          await quotaState(tx, userId),
          admissionBytes,
        );
        if (!verdict.allowed) return { kind: "quota" as const, verdict };

        // Admission is per-account, not per-request: the quota only bites once
        // the bytes have landed, so without a cap on transfers IN FLIGHT a
        // client can queue an unbounded amount of work (and egress) against a
        // quota none of it has spent yet.
        const [row] = await tx
          .select({ n: count() })
          .from(transfers)
          .where(
            and(
              eq(transfers.userId, userId),
              inArray(transfers.state, [...ACTIVE_TRANSFER_STATES]),
            ),
          );
        const active = row?.n ?? 0;
        const check = checkActiveTransfers(active);
        if (!check.allowed) return { kind: "abuse" as const, check, active };

        const [transfer] = await tx
          .insert(transfers)
          .values({
            userId,
            url: body.url,
            destPath: destPath.path,
            state: "queued",
            receivedBytes: 0,
            totalBytes,
            originDeviceId: c.get("deviceId"),
          })
          .returning();
        return transfer
          ? { kind: "ok" as const, transfer }
          : { kind: "internal" as const };
      });

      if (outcome.kind === "internal")
        return c.json({ error: "internal" }, 500);
      if (outcome.kind === "quota") {
        await audit(
          userId,
          "files.quota_blocked",
          {
            path: destPath.path,
            incomingBytes: admissionBytes,
            usedBytes: outcome.verdict.usedBytes,
          },
          c.get("deviceId") ?? undefined,
        );
        return c.json(quotaBody(outcome.verdict), 413);
      }
      if (outcome.kind === "abuse") {
        await audit(
          userId,
          "abuse.limit_hit",
          {
            limit: outcome.check.limit,
            reason: outcome.check.reason,
            count: outcome.active,
            max: ABUSE_LIMITS.maxActiveTransfers,
          },
          c.get("deviceId") ?? undefined,
        );
        return c.json(
          {
            error: "abuse_limit",
            limit: outcome.check.limit,
            reason: outcome.check.reason,
          },
          429,
        );
      }
      // Host only, never the URL: a presigned link IS the authorization, and an
      // audit trail that stored one would hand it to every reader of the trail.
      await audit(
        userId,
        "transfer.created",
        {
          transferId: outcome.transfer.id,
          host: new URL(body.url).hostname,
          destPath: outcome.transfer.destPath,
          eligibility: eligibility.reason,
        },
        c.get("deviceId") ?? undefined,
      );
      return c.json(
        { transfer: transferView(outcome.transfer), eligibility },
        201,
      );
    },
  );

  // Agent-authenticated progress. The caller is inside the user's VM, so every
  // number is bounded and every illegal move is refused rather than stored.
  v1.post(
    "/files/transfers/progress",
    zValidator("json", transferProgressSchema),
    async (c) => {
      const agent = c.get("agent");
      const refusal = transferReportRefusal(agent.caps);
      if (refusal)
        return c.json({ error: "capability_refused", reason: refusal }, 403);
      const body = c.req.valid("json");
      const [transfer] = await db
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.id, body.transferId),
            eq(transfers.userId, agent.userId),
          ),
        );
      if (!transfer) return c.json({ error: "not_found" }, 404);

      const from = transfer.state as (typeof TRANSFER_STATES)[number];
      if (isTerminalTransfer(from)) {
        return c.json({ error: "transfer_terminal", state: from }, 409);
      }
      if (!canTransferTransition(from, body.state)) {
        return c.json(
          { error: "illegal_transition", from, to: body.state },
          409,
        );
      }
      // A total the creating device took from Content-Length is fixed: letting
      // the VM restate it would let a transfer redefine the quota it was
      // admitted against.
      if (
        body.totalBytes !== undefined &&
        transfer.totalBytes > 0 &&
        body.totalBytes !== transfer.totalBytes
      ) {
        return c.json(
          {
            error: "out_of_range",
            field: "totalBytes",
            reason: "total_changed",
          },
          400,
        );
      }
      const totalBytes =
        transfer.totalBytes > 0 ? transfer.totalBytes : (body.totalBytes ?? 0);
      // Progress is a counter, not a gauge: a decrease is a corrupt report.
      if (body.receivedBytes < transfer.receivedBytes) {
        return c.json(
          {
            error: "out_of_range",
            field: "receivedBytes",
            reason: "decreased",
          },
          400,
        );
      }
      if (totalBytes > 0 && body.receivedBytes > totalBytes) {
        return c.json(
          {
            error: "out_of_range",
            field: "receivedBytes",
            reason: "exceeds_total",
          },
          400,
        );
      }

      const [updated] = await db
        .update(transfers)
        .set({
          state: body.state,
          receivedBytes: body.receivedBytes,
          totalBytes,
          error: body.error ?? null,
          updatedAt: new Date(),
          // The stored URL is kept only while the fetch can still use it. Once
          // the transfer stops moving, what remains is a link that may be
          // bearer authority over someone else's object, sitting in a row with
          // no expiry — so it is truncated to the part the UI needs.
          ...(isTerminalTransfer(body.state)
            ? { url: redactTransferUrl(transfer.url) }
            : {}),
        })
        // Conditional on the state we validated against, so two concurrent
        // reports cannot interleave into an illegal move.
        .where(and(eq(transfers.id, transfer.id), eq(transfers.state, from)))
        .returning();
      if (!updated)
        return c.json({ error: "conflict", from, to: body.state }, 409);
      return c.json({ transfer: transferView(updated) });
    },
  );

  v1.post(
    "/files/transfers/:id/cancel",
    zValidator("param", idParamSchema),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const [transfer] = await db
        .select()
        .from(transfers)
        .where(and(eq(transfers.id, id), eq(transfers.userId, userId)));
      if (!transfer) return c.json({ error: "not_found" }, 404);
      const from = transfer.state as (typeof TRANSFER_STATES)[number];
      if (isTerminalTransfer(from))
        return c.json({ error: "transfer_terminal", state: from }, 409);
      const [updated] = await db
        .update(transfers)
        // Terminal: the URL has no further use, so it stops being stored whole.
        .set({
          state: "cancelled",
          url: redactTransferUrl(transfer.url),
          updatedAt: new Date(),
        })
        .where(and(eq(transfers.id, id), eq(transfers.state, from)))
        .returning();
      if (!updated)
        return c.json({ error: "conflict", from, to: "cancelled" }, 409);
      await audit(
        userId,
        "transfer.cancelled",
        { transferId: id, destPath: updated.destPath, from },
        c.get("deviceId") ?? undefined,
      );
      return c.json({ transfer: transferView(updated) });
    },
  );

  v1.get("/files", zValidator("query", filesListQuerySchema), async (c) => {
    const userId = c.get("userId");
    const { prefix, limit, cursor } = c.req.valid("query");
    const normalized = prefix === undefined ? "/" : normalizePrefix(prefix);
    if (normalized === null)
      return c.json({ error: "invalid_path", reason: "traversal" }, 400);
    const rows = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.userId, userId),
          // A prefix matches the entry itself or anything beneath it — never a
          // sibling that merely starts with the same characters.
          normalized === "/"
            ? undefined
            : or(
                eq(files.path, normalized),
                like(files.path, `${escapeLike(normalized)}/%`),
              ),
          cursor === undefined ? undefined : gt(files.path, cursor),
        ),
      )
      .orderBy(files.path)
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      files: page.map((row) => ({
        ...fileEntryView(row),
        complete: row.completedAt !== null,
      })),
      nextCursor: rows.length > limit && last !== undefined ? last.path : null,
    });
  });

  v1.delete("/files/:id", zValidator("param", idParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    // Read the file, release its chunks and remove the row in ONE transaction
    // under the account lock. Two overlapping deletes of the same file would
    // otherwise both read its manifest and both decrement, taking a chunk that
    // a SIBLING file still references from two claims to zero — deleting the
    // row, deleting the bytes, and silently breaking the other file. Here the
    // second delete finds no row and answers 404, which is the truth.
    const outcome = await db.transaction(async (tx) => {
      await lockAccount(tx, userId);
      const file = await ownedFile(tx, userId, id);
      if (!file) return null;
      const orphans = await releaseHashes(
        tx,
        userId,
        await detachFileChunks(tx, file.id),
      );
      await tx.delete(files).where(eq(files.id, file.id));
      return { file, orphans };
    });
    if (!outcome) return c.json({ error: "not_found" }, 404);
    await deleteOrphanObjects(userId, outcome.orphans);
    await audit(
      userId,
      "files.deleted",
      {
        fileId: outcome.file.id,
        path: outcome.file.path,
        sizeBytes: outcome.file.sizeBytes,
      },
      c.get("deviceId") ?? undefined,
    );
    return c.json({ deleted: true, path: outcome.file.path });
  });

  // Operator observability for failed hub deliveries. Real operator auth is
  // TODO — any authenticated caller can read the queue in this phase.
  v1.get("/admin/revocation-outbox", async (c) => {
    const rows = await db
      .select()
      .from(revocationOutbox)
      .orderBy(desc(revocationOutbox.createdAt), desc(revocationOutbox.id));
    return c.json({ outbox: rows });
  });

  // Audit trail (§8.7): newest first, keyset-paginated. The cursor is the id
  // of the last entry on the previous page; the row-value subquery compares
  // against that row's exact stored (created_at, id) so microsecond-precision
  // timestamps never skip or duplicate entries. A stale/foreign cursor id
  // yields an empty page, not an error. `events` (raw rows) predates Phase 2
  // and is kept for existing consumers; `entries` carries the server-built
  // human summaries the UI renders verbatim.
  v1.get("/audit", zValidator("query", auditQuerySchema), async (c) => {
    const userId = c.get("userId");
    const { limit, cursor, type } = c.req.valid("query");
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, userId),
          type === undefined ? undefined : eq(auditEvents.type, type),
          cursor === undefined
            ? undefined
            : sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (SELECT ${auditEvents.createdAt}, ${auditEvents.id} FROM ${auditEvents} WHERE ${auditEvents.id} = ${cursor})`,
        ),
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined ? last.id : null;
    return c.json({
      events: page,
      entries: page.map((e) => ({
        id: e.id,
        type: e.type,
        createdAt: e.createdAt,
        actorDeviceId: e.actorDeviceId,
        summary: summarize(e.type, e.payload ?? null),
      })),
      nextCursor,
    });
  });

  // Vended inference (src/inference.ts): /v1/ai/status and the metered
  // /v1/ai/gateway/* proxy. Mounted like every other /v1 route, so the
  // device-auth middleware above runs first.
  v1.route("/ai", inferenceRoutes(db, inferenceOptions));

  app.route("/v1", v1);
  return app;
}
