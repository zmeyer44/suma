/**
 * Vended inference (default API keys, without shipping a key).
 *
 * The desktop's assistant talks to the Vercel AI Gateway. Users can bring
 * their own gateway key; accounts get one by default through THIS route
 * instead: a metered passthrough proxy at /v1/ai/gateway/* that swaps the
 * caller's device token for the operator's upstream key. The upstream key
 * exists only in the control plane's environment — it never reaches a client,
 * so rotating it is an env change, not an app release, and revoking a device
 * (or removing the account feature) cuts that user's inference off with it.
 *
 * Admission is three gates, in order:
 *   1. device auth  — the standard bearer middleware (app.ts) runs first;
 *   2. entitlement  — the account must carry the "inference" feature
 *                     (in DEFAULT_ACCOUNT_FEATURES for new signups; an
 *                     operator can strip it per account);
 *   3. rate         — a per-user daily request cap, counted from the same
 *                     usage rows the cost accounting reads.
 *
 * With no AI_GATEWAY_API_KEY configured the routes answer 404, never open —
 * the same closed-by-default posture as the invite admin route.
 *
 * Metering records one row per proxied request: path, model (parsed from the
 * request body), upstream status, and token counts when the upstream response
 * is plain JSON carrying a usage block. Streamed (SSE) responses pass through
 * untouched and record null token counts — parsing usage out of the stream is
 * a follow-up; the request count is what the daily cap enforces today.
 */

import { Hono } from "hono";
import { and, count, eq, gte } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { inferenceUsage, users } from "./db/schema.js";
import type { AuthEnv } from "./auth.js";

/** The account feature flag gating vended inference. */
export const INFERENCE_FEATURE = "inference";

export interface InferenceOptions {
  /** Base URL of the AI gateway requests are forwarded to. */
  upstreamUrl: string;
  /** The operator's gateway key. Null closes the routes (404). */
  apiKey: string | null;
  /** Proxied requests allowed per user per UTC day. */
  dailyRequestCap: number;
}

export const INFERENCE_UPSTREAM_ENV = "AI_GATEWAY_UPSTREAM_URL";
export const INFERENCE_KEY_ENV = "AI_GATEWAY_API_KEY";
export const INFERENCE_CAP_ENV = "AI_DAILY_REQUEST_CAP";

const DEFAULT_UPSTREAM = "https://ai-gateway.vercel.sh";
const DEFAULT_DAILY_CAP = 500;

/** For unit tests and embedded use; deployed entrypoints read the env. */
export const INFERENCE_DISABLED: InferenceOptions = {
  upstreamUrl: DEFAULT_UPSTREAM,
  apiKey: null,
  dailyRequestCap: DEFAULT_DAILY_CAP,
};

export function inferenceOptionsFromEnv(
  env: Record<string, string | undefined>,
): InferenceOptions {
  const cap = Number(env[INFERENCE_CAP_ENV]);
  return {
    upstreamUrl: env[INFERENCE_UPSTREAM_ENV] ?? DEFAULT_UPSTREAM,
    apiKey: env[INFERENCE_KEY_ENV]?.trim() || null,
    dailyRequestCap:
      Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_DAILY_CAP,
  };
}

/** Request headers that must not be forwarded: identity, addressing, and
 * framing belong to each hop. Everything else (content-type, accept, the AI
 * SDK's protocol headers) passes through untouched. */
const REQUEST_HEADER_DENYLIST = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "proxy-authorization",
  "te",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

/** Response headers not forwarded: fetch already decoded the body, so the
 * upstream's framing/encoding headers would misdescribe what we send. */
const RESPONSE_HEADER_DENYLIST = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const utcDayStart = (): Date => {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return day;
};

/** Best-effort token accounting from an OpenAI- or Anthropic-shaped usage
 * block. Anything unrecognized records null rather than guessing. */
function parseUsage(payload: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage;
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = usage?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  };
  return {
    inputTokens: pick("prompt_tokens", "input_tokens", "inputTokens"),
    outputTokens: pick("completion_tokens", "output_tokens", "outputTokens"),
  };
}

/**
 * Routes mounted at /v1/ai (device auth already applied by the caller's
 * middleware). GET /status reports availability; ALL /gateway/* proxies.
 */
export function inferenceRoutes(
  db: Db,
  options: InferenceOptions,
): Hono<AuthEnv> {
  const ai = new Hono<AuthEnv>();

  const features = async (userId: string): Promise<ReadonlyArray<string>> => {
    const [user] = await db
      .select({ features: users.features })
      .from(users)
      .where(eq(users.id, userId));
    return user?.features ?? [];
  };

  const requestsToday = async (userId: string): Promise<number> => {
    const [row] = await db
      .select({ n: count() })
      .from(inferenceUsage)
      .where(
        and(
          eq(inferenceUsage.userId, userId),
          gte(inferenceUsage.createdAt, utcDayStart()),
        ),
      );
    return row?.n ?? 0;
  };

  // Discovery: lets a client decide whether "signed in" means "has inference"
  // before it tries a model call — and shows the meter against the cap.
  ai.get("/status", async (c) => {
    const userId = c.get("userId");
    const enabled = (await features(userId)).includes(INFERENCE_FEATURE);
    const vending = options.apiKey !== null;
    return c.json({
      vending,
      enabled,
      available: vending && enabled,
      dailyRequestCap: options.dailyRequestCap,
      requestsToday: await requestsToday(userId),
    });
  });

  ai.all("/gateway/*", async (c) => {
    // Unconfigured is indistinguishable from absent — same as admin/invites.
    if (options.apiKey === null) return c.json({ error: "not_found" }, 404);
    if (c.req.method !== "GET" && c.req.method !== "POST") {
      return c.json({ error: "method_not_allowed" }, 405);
    }

    const userId = c.get("userId");
    if (!(await features(userId)).includes(INFERENCE_FEATURE)) {
      return c.json(
        { error: "feature_required", feature: INFERENCE_FEATURE },
        403,
      );
    }

    const used = await requestsToday(userId);
    if (used >= options.dailyRequestCap) {
      return c.json(
        {
          error: "rate_limited",
          explanation: `Daily inference allowance (${options.dailyRequestCap} requests) reached — resets at midnight UTC.`,
        },
        429,
      );
    }

    // "/v1/ai/gateway/v1/chat/completions" → upstream "/v1/chat/completions".
    const mountPrefix = c.req.path.slice(
      0,
      c.req.path.indexOf("/gateway/") + "/gateway".length,
    );
    const rest = c.req.path.slice(mountPrefix.length) || "/";
    const target = new URL(options.upstreamUrl.replace(/\/+$/, "") + rest);
    target.search = new URL(c.req.url).search;

    const headers = new Headers();
    for (const [name, value] of c.req.raw.headers) {
      if (!REQUEST_HEADER_DENYLIST.has(name.toLowerCase())) {
        headers.set(name, value);
      }
    }
    headers.set("authorization", `Bearer ${options.apiKey}`);

    // Prompt payloads are small; buffering sidesteps duplex streaming and
    // lets metering read the model id from the request.
    const requestBody =
      c.req.method === "POST" ? await c.req.arrayBuffer() : undefined;
    let model: string | null = null;
    if (requestBody !== undefined) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(requestBody)) as {
          model?: unknown;
        };
        if (typeof parsed.model === "string") model = parsed.model.slice(0, 200);
      } catch {
        // Non-JSON body (audio, multipart) — fine, model stays unknown.
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: c.req.method,
        headers,
        body: requestBody,
      });
    } catch {
      return c.json({ error: "bad_gateway" }, 502);
    }

    // Plain JSON responses are buffered so token usage can be recorded;
    // anything else (SSE streams above all) passes through as a stream.
    const contentType = upstream.headers.get("content-type") ?? "";
    let body: BodyInit | null = upstream.body;
    let usage = { inputTokens: null as number | null, outputTokens: null as number | null };
    if (contentType.includes("application/json")) {
      const text = await upstream.text();
      body = text;
      try {
        usage = parseUsage(JSON.parse(text));
      } catch {
        // Malformed JSON from upstream — forward it anyway, meter the request.
      }
    }

    await db.insert(inferenceUsage).values({
      userId,
      deviceId: c.get("deviceId"),
      path: rest,
      model,
      status: upstream.status,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      if (!RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) {
        responseHeaders.set(name, value);
      }
    }
    return new Response(body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  });

  return ai;
}
