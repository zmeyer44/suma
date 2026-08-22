/**
 * External-assistant identity and policy control.
 *
 * Device routes mint/revoke links and edit policy. Service routes accept only
 * the assistant-plane shared secret and are deliberately disjoint from device
 * and VM capability credentials. The public channel gateway resolves a link
 * for every inbound message, so revocation and feature removal bite at once.
 */

import { createHash, randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  TERMINAL_CAPABILITIES,
  type Capability,
  type MachineState,
} from "@suma/protocol";
import {
  ASSISTANT_TOOL_GROUP_IDS,
  assistantToolGroupDefaultEnabled,
  isAssistantToolGroupId,
  type AssistantToolGroupId,
} from "@suma/assistant-core";
import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import {
  assistantLinkCodes,
  assistantBrowserTickets,
  assistantPolicies,
  auditEvents,
  channelLinks,
  machineEvents,
  machines,
  users,
} from "./db/schema.js";
import { mintCapabilityToken } from "./capabilities.js";
import { secretEquals } from "./gateway.js";
import type { SigningKeys } from "./keys-provider.js";
import type { SandboxProvider } from "./providers/sandbox.js";

export const ASSISTANT_FEATURE = "assistant";
export const ASSISTANT_SERVICE_TOKEN_ENV = "ASSISTANT_SERVICE_TOKEN";

const LINK_CODE_TTL_MS = 10 * 60_000;
const BROWSER_TICKET_TTL_MS = 5 * 60_000;
const LINK_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

export const ASSISTANT_SERVICE_PATHS: ReadonlySet<string> = new Set([
  "/v1/assistant/link-redeem",
  "/v1/assistant/links/resolve",
  "/v1/assistant/links/revoke",
  "/v1/assistant/machine-session",
  "/v1/assistant/browser-session-redeem",
]);

export interface AssistantControlOptions {
  serviceToken: string | null;
  defaultModel: string;
  publicUrl?: string | null;
}

export const ASSISTANT_DISABLED: AssistantControlOptions = {
  serviceToken: null,
  defaultModel: DEFAULT_MODEL,
  publicUrl: null,
};

export function assistantOptionsFromEnv(
  env: Record<string, string | undefined>,
): AssistantControlOptions {
  return {
    serviceToken: env[ASSISTANT_SERVICE_TOKEN_ENV]?.trim() || null,
    defaultModel: env["SUMA_ASSISTANT_MODEL"]?.trim() || DEFAULT_MODEL,
    publicUrl: assistantPublicUrl(env["SUMA_ASSISTANT_PUBLIC_URL"]),
  };
}

function assistantPublicUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SUMA_ASSISTANT_PUBLIC_URL must be an HTTP(S) URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("SUMA_ASSISTANT_PUBLIC_URL must not contain credentials");
  }
  if (
    url.protocol === "http:" &&
    !new Set(["127.0.0.1", "[::1]", "localhost"]).has(url.hostname)
  ) {
    throw new Error(
      "SUMA_ASSISTANT_PUBLIC_URL must use HTTPS outside loopback development",
    );
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function bearerAssistantService(
  options: AssistantControlOptions,
): MiddlewareHandler<AuthEnv> {
  return async (context, next) => {
    if (options.serviceToken === null) {
      return context.json(
        { error: "unavailable", reason: "assistant_auth_unconfigured" },
        503,
      );
    }
    const header = context.req.header("authorization");
    const token = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : null;
    if (token === null || !secretEquals(token, options.serviceToken)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}

const channelIdentitySchema = z.object({
  channel: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  accountId: z.string().trim().min(1).max(256),
  externalUserId: z.string().trim().min(1).max(512),
});

const redeemSchema = channelIdentitySchema.extend({
  code: z.string().trim().min(4).max(64),
  displayName: z.string().trim().min(1).max(256).optional(),
});

const machineSessionSchema = z.object({
  userId: z.string().uuid(),
  linkId: z.string().uuid(),
});

const browserTicketRedeemSchema = z.object({
  ticket: z.string().trim().min(32).max(256),
});

const policyPatchSchema = z
  .object({
    model: z.string().trim().min(1).max(200).optional(),
    enabledToolGroups: z
      .array(z.string().refine(isAssistantToolGroupId, "unknown tool group"))
      .max(ASSISTANT_TOOL_GROUP_IDS.length)
      .optional(),
    maxSteps: z.number().int().min(1).max(80).optional(),
    dailyWakeMinutes: z.number().int().min(0).max(1_440).optional(),
    autoSuspendMinutes: z.number().int().min(1).max(120).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "empty patch",
  });

export interface RemoteAssistantPolicy {
  model: string;
  enabledToolGroups: AssistantToolGroupId[];
  maxSteps: number;
  dailyWakeMinutes: number;
  autoSuspendMinutes: number;
  updatedAt: string | null;
}

function defaultEnabledToolGroups(): AssistantToolGroupId[] {
  return ASSISTANT_TOOL_GROUP_IDS.filter(assistantToolGroupDefaultEnabled);
}

function defaultPolicy(options: AssistantControlOptions): RemoteAssistantPolicy {
  return {
    model: options.defaultModel,
    enabledToolGroups: defaultEnabledToolGroups(),
    maxSteps: 40,
    dailyWakeMinutes: 120,
    autoSuspendMinutes: 10,
    updatedAt: null,
  };
}

async function policyFor(
  db: Db,
  userId: string,
  options: AssistantControlOptions,
): Promise<RemoteAssistantPolicy> {
  const [row] = await db
    .select()
    .from(assistantPolicies)
    .where(eq(assistantPolicies.userId, userId));
  if (row === undefined) return defaultPolicy(options);
  return {
    model: row.model,
    enabledToolGroups: row.enabledToolGroups.filter(isAssistantToolGroupId),
    maxSteps: row.maxSteps,
    dailyWakeMinutes: row.dailyWakeMinutes,
    autoSuspendMinutes: row.autoSuspendMinutes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assistantEnabled(db: Db, userId: string): Promise<boolean> {
  const [user] = await db
    .select({ features: users.features })
    .from(users)
    .where(eq(users.id, userId));
  return user?.features.includes(ASSISTANT_FEATURE) ?? false;
}

function hashLinkCode(code: string): string {
  return createHash("sha256").update(canonicalLinkCode(code)).digest("hex");
}

function canonicalLinkCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function createLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (byte) =>
    LINK_CODE_ALPHABET.charAt(byte % LINK_CODE_ALPHABET.length),
  ).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function hashBrowserTicket(ticket: string): string {
  return createHash("sha256")
    .update("assistant-browser-session\0")
    .update(ticket)
    .digest("hex");
}

function browserSessionUploadUrl(publicUrl: string): string {
  const base = new URL(publicUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL("v1/browser-sessions/import", base).href;
}

async function audit(
  db: Db,
  userId: string,
  type: string,
  payload: Record<string, unknown>,
  actorDeviceId?: string | null,
): Promise<void> {
  await db.insert(auditEvents).values({
    userId,
    type,
    payload,
    actorDeviceId: actorDeviceId ?? null,
  });
}

export function assistantRoutes(
  db: Db,
  options: AssistantControlOptions,
  resources: {
    sandbox: SandboxProvider;
    getSigning(): Promise<SigningKeys>;
  },
): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();

  routes.post("/channels/link-code", async (context) => {
    const userId = context.get("userId");
    if (!(await assistantEnabled(db, userId))) {
      return context.json(
        { error: "feature_required", feature: ASSISTANT_FEATURE },
        403,
      );
    }
    if (options.serviceToken === null) {
      return context.json(
        { error: "unavailable", reason: "assistant_auth_unconfigured" },
        503,
      );
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = createLinkCode();
      const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
      const [inserted] = await db
        .insert(assistantLinkCodes)
        .values({ codeHash: hashLinkCode(code), userId, expiresAt })
        .onConflictDoNothing()
        .returning({ codeHash: assistantLinkCodes.codeHash });
      if (inserted !== undefined) {
        await audit(
          db,
          userId,
          "assistant.link_code_created",
          { expiresAt: expiresAt.toISOString() },
          context.get("deviceId"),
        );
        return context.json({ code, expiresAt: expiresAt.toISOString() }, 201);
      }
    }
    return context.json({ error: "code_generation_failed" }, 500);
  });

  routes.get("/channels/links", async (context) => {
    const userId = context.get("userId");
    if (!(await assistantEnabled(db, userId))) {
      return context.json(
        { error: "feature_required", feature: ASSISTANT_FEATURE },
        403,
      );
    }
    const links = await db
      .select()
      .from(channelLinks)
      .where(eq(channelLinks.userId, userId))
      .orderBy(desc(channelLinks.createdAt), desc(channelLinks.id));
    return context.json({ links });
  });

  routes.post("/assistant/browser-session-ticket", async (context) => {
    const userId = context.get("userId");
    if (!(await assistantEnabled(db, userId))) {
      return context.json(
        { error: "feature_required", feature: ASSISTANT_FEATURE },
        403,
      );
    }
    if (options.serviceToken === null || options.publicUrl == null) {
      return context.json(
        { error: "unavailable", reason: "assistant_browser_unconfigured" },
        503,
      );
    }
    const [link] = await db
      .select({ id: channelLinks.id })
      .from(channelLinks)
      .where(eq(channelLinks.userId, userId))
      .limit(1);
    if (link === undefined) {
      return context.json({ error: "no_linked_channels" }, 409);
    }
    const now = new Date();
    await db
      .delete(assistantBrowserTickets)
      .where(lte(assistantBrowserTickets.expiresAt, now));
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + BROWSER_TICKET_TTL_MS);
    await db.insert(assistantBrowserTickets).values({
      ticketHash: hashBrowserTicket(ticket),
      userId,
      expiresAt,
    });
    await audit(
      db,
      userId,
      "assistant.browser_session_ticket_created",
      { expiresAt: expiresAt.toISOString() },
      context.get("deviceId"),
    );
    return context.json(
      {
        ticket,
        expiresAt: expiresAt.toISOString(),
        uploadUrl: browserSessionUploadUrl(options.publicUrl),
      },
      201,
    );
  });

  routes.delete("/channels/links/:linkId", async (context) => {
    const userId = context.get("userId");
    if (!(await assistantEnabled(db, userId))) {
      return context.json(
        { error: "feature_required", feature: ASSISTANT_FEATURE },
        403,
      );
    }
    const [deleted] = await db
      .delete(channelLinks)
      .where(
        and(
          eq(channelLinks.id, context.req.param("linkId")),
          eq(channelLinks.userId, userId),
        ),
      )
      .returning();
    if (deleted === undefined) return context.json({ error: "not_found" }, 404);
    await audit(
      db,
      userId,
      "assistant.channel_unlinked",
      {
        linkId: deleted.id,
        channel: deleted.channel,
        accountId: deleted.accountId,
      },
      context.get("deviceId"),
    );
    return context.json({ deleted: true });
  });

  routes.get("/assistant/policy", async (context) => {
    const userId = context.get("userId");
    if (!(await assistantEnabled(db, userId))) {
      return context.json(
        { error: "feature_required", feature: ASSISTANT_FEATURE },
        403,
      );
    }
    return context.json({ policy: await policyFor(db, userId, options) });
  });

  routes.patch(
    "/assistant/policy",
    zValidator("json", policyPatchSchema),
    async (context) => {
      const userId = context.get("userId");
      if (!(await assistantEnabled(db, userId))) {
        return context.json(
          { error: "feature_required", feature: ASSISTANT_FEATURE },
          403,
        );
      }
      const current = await policyFor(db, userId, options);
      const patch = context.req.valid("json");
      const enabledToolGroups = patch.enabledToolGroups === undefined
        ? current.enabledToolGroups
        : [...new Set(patch.enabledToolGroups)];
      const next = {
        userId,
        model: patch.model ?? current.model,
        enabledToolGroups,
        maxSteps: patch.maxSteps ?? current.maxSteps,
        dailyWakeMinutes: patch.dailyWakeMinutes ?? current.dailyWakeMinutes,
        autoSuspendMinutes:
          patch.autoSuspendMinutes ?? current.autoSuspendMinutes,
        updatedAt: new Date(),
      };
      await db
        .insert(assistantPolicies)
        .values(next)
        .onConflictDoUpdate({
          target: assistantPolicies.userId,
          set: {
            model: next.model,
            enabledToolGroups: next.enabledToolGroups,
            maxSteps: next.maxSteps,
            dailyWakeMinutes: next.dailyWakeMinutes,
            autoSuspendMinutes: next.autoSuspendMinutes,
            updatedAt: next.updatedAt,
          },
        });
      await audit(
        db,
        userId,
        "assistant.policy_updated",
        {
          enabledToolGroups: next.enabledToolGroups,
          maxSteps: next.maxSteps,
          dailyWakeMinutes: next.dailyWakeMinutes,
          autoSuspendMinutes: next.autoSuspendMinutes,
        },
        context.get("deviceId"),
      );
      return context.json({ policy: await policyFor(db, userId, options) });
    },
  );

  routes.post(
    "/assistant/browser-session-redeem",
    zValidator("json", browserTicketRedeemSchema),
    async (context) => {
      const { ticket } = context.req.valid("json");
      const now = new Date();
      const [redeemed] = await db
        .update(assistantBrowserTickets)
        .set({ redeemedAt: now })
        .where(
          and(
            eq(assistantBrowserTickets.ticketHash, hashBrowserTicket(ticket)),
            isNull(assistantBrowserTickets.redeemedAt),
            gt(assistantBrowserTickets.expiresAt, now),
          ),
        )
        .returning({ userId: assistantBrowserTickets.userId });
      if (redeemed === undefined) {
        return context.json({ error: "invalid_or_expired_ticket" }, 401);
      }
      if (!(await assistantEnabled(db, redeemed.userId))) {
        return context.json(
          { error: "feature_required", feature: ASSISTANT_FEATURE },
          403,
        );
      }
      await audit(
        db,
        redeemed.userId,
        "assistant.browser_session_ticket_redeemed",
        {},
      );
      return context.json({ userId: redeemed.userId });
    },
  );

  routes.post(
    "/assistant/machine-session",
    zValidator("json", machineSessionSchema),
    async (context) => {
      const { userId, linkId } = context.req.valid("json");
      const [link] = await db
        .select({ id: channelLinks.id })
        .from(channelLinks)
        .where(
          and(eq(channelLinks.id, linkId), eq(channelLinks.userId, userId)),
        );
      if (link === undefined || !(await assistantEnabled(db, userId))) {
        return context.json({ error: "not_linked" }, 404);
      }
      const policy = await policyFor(db, userId, options);
      const caps = capabilitiesFor(policy.enabledToolGroups);
      if (caps.length === 0) {
        return context.json({ error: "computer_tools_disabled" }, 403);
      }
      const [machine] = await db
        .select()
        .from(machines)
        .where(eq(machines.userId, userId));
      if (machine === undefined) {
        return context.json({ error: "local_compute_not_supported" }, 409);
      }
      if (machine.agentAddress === null) {
        return context.json({ error: "agent_address_unavailable" }, 409);
      }
      let state = machine.state as MachineState;
      if (state === "suspended") {
        if (policy.dailyWakeMinutes === 0) {
          return context.json({ error: "wake_budget_exhausted" }, 429);
        }
        const now = new Date();
        const [resuming] = await db
          .update(machines)
          .set({ state: "resuming", updatedAt: now, lastTransitionAt: now })
          .where(and(eq(machines.id, machine.id), eq(machines.state, "suspended")))
          .returning({ id: machines.id });
        if (resuming !== undefined) {
          try {
            await resources.sandbox.resume(machine.id);
          } catch (error) {
            await db
              .update(machines)
              .set({ state: "error", updatedAt: new Date() })
              .where(eq(machines.id, machine.id));
            throw error;
          }
          await db.insert(machineEvents).values({
            machineId: machine.id,
            fromState: "suspended",
            toState: "resuming",
            reconstructed: false,
            detail: "woken by linked assistant",
          });
        }
        state = "resuming";
      }
      if (state !== "running" && state !== "resuming") {
        return context.json({ error: "machine_unavailable", state }, 409);
      }
      const keys = await resources.getSigning();
      const minted = await mintCapabilityToken(
        keys.signingKey,
        machine.id,
        userId,
        caps,
        Math.floor(Date.now() / 1_000),
      );
      await audit(db, userId, "assistant.machine_session_minted", {
        linkId,
        machineId: machine.id,
        caps,
        jti: minted.claims.jti,
        state,
      });
      return context.json({
        agentAddress: machine.agentAddress,
        capabilityToken: minted.token,
        exp: minted.claims.exp,
        caps,
        state,
      });
    },
  );

  routes.post(
    "/assistant/link-redeem",
    zValidator("json", redeemSchema),
    async (context) => {
      const body = context.req.valid("json");
      const now = new Date();
      const result = await db.transaction(async (tx) => {
        const [linkCode] = await tx
          .select()
          .from(assistantLinkCodes)
          .where(
            and(
              eq(assistantLinkCodes.codeHash, hashLinkCode(body.code)),
              isNull(assistantLinkCodes.redeemedAt),
              gt(assistantLinkCodes.expiresAt, now),
            ),
          );
        if (linkCode === undefined) return { kind: "invalid" } as const;
        if (!(await assistantEnabled(tx, linkCode.userId))) {
          return { kind: "disabled" } as const;
        }

        const identity = and(
          eq(channelLinks.channel, body.channel),
          eq(channelLinks.accountId, body.accountId),
          eq(channelLinks.externalUserId, body.externalUserId),
        );
        const [existing] = await tx.select().from(channelLinks).where(identity);
        if (existing !== undefined && existing.userId !== linkCode.userId) {
          return { kind: "conflict" } as const;
        }
        const [inserted] = existing === undefined
          ? await tx
              .insert(channelLinks)
              .values({
                userId: linkCode.userId,
                channel: body.channel,
                accountId: body.accountId,
                externalUserId: body.externalUserId,
                displayName: body.displayName ?? null,
              })
              .onConflictDoNothing()
              .returning()
          : [existing];
        if (inserted === undefined) return { kind: "conflict" } as const;
        await tx
          .update(assistantLinkCodes)
          .set({ redeemedAt: now })
          .where(eq(assistantLinkCodes.codeHash, linkCode.codeHash));
        return { kind: "linked", link: inserted } as const;
      });

      if (result.kind === "invalid") {
        return context.json({ error: "invalid_or_expired_code" }, 401);
      }
      if (result.kind === "disabled") {
        return context.json(
          { error: "feature_required", feature: ASSISTANT_FEATURE },
          403,
        );
      }
      if (result.kind === "conflict") {
        return context.json({ error: "identity_already_linked" }, 409);
      }
      await audit(db, result.link.userId, "assistant.channel_linked", {
        linkId: result.link.id,
        channel: result.link.channel,
        accountId: result.link.accountId,
      });
      return context.json(
        {
          link: result.link,
          policy: await policyFor(db, result.link.userId, options),
        },
        201,
      );
    },
  );

  routes.post(
    "/assistant/links/resolve",
    zValidator("json", channelIdentitySchema),
    async (context) => {
      const body = context.req.valid("json");
      const [link] = await db
        .select({
          id: channelLinks.id,
          userId: channelLinks.userId,
          channel: channelLinks.channel,
          accountId: channelLinks.accountId,
          externalUserId: channelLinks.externalUserId,
          displayName: channelLinks.displayName,
          createdAt: channelLinks.createdAt,
          features: users.features,
        })
        .from(channelLinks)
        .innerJoin(users, eq(users.id, channelLinks.userId))
        .where(
          and(
            eq(channelLinks.channel, body.channel),
            eq(channelLinks.accountId, body.accountId),
            eq(channelLinks.externalUserId, body.externalUserId),
          ),
        );
      if (link === undefined || !link.features.includes(ASSISTANT_FEATURE)) {
        return context.json({ error: "not_linked" }, 404);
      }
      const { features: _features, ...publicLink } = link;
      return context.json({
        link: publicLink,
        policy: await policyFor(db, link.userId, options),
      });
    },
  );

  routes.post(
    "/assistant/links/revoke",
    zValidator("json", channelIdentitySchema),
    async (context) => {
      const body = context.req.valid("json");
      const [deleted] = await db
        .delete(channelLinks)
        .where(
          and(
            eq(channelLinks.channel, body.channel),
            eq(channelLinks.accountId, body.accountId),
            eq(channelLinks.externalUserId, body.externalUserId),
          ),
        )
        .returning();
      if (deleted === undefined) {
        return context.json({ error: "not_linked" }, 404);
      }
      await audit(db, deleted.userId, "assistant.channel_unlinked", {
        linkId: deleted.id,
        channel: deleted.channel,
        accountId: deleted.accountId,
        source: "channel",
      });
      return context.json({ deleted: true });
    },
  );

  return routes;
}

function capabilitiesFor(groups: AssistantToolGroupId[]): Capability[] {
  const enabled = new Set(groups);
  const caps = new Set<Capability>();
  if (enabled.has("terminal")) {
    for (const cap of TERMINAL_CAPABILITIES) caps.add(cap);
  }
  if (enabled.has("files") || enabled.has("memory")) {
    caps.add("fs.read");
    caps.add("fs.write");
  }
  return [...caps];
}
