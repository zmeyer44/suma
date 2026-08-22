/**
 * suma-agent mux protocol (PRD Appendix C, §8.5).
 *
 * Channels: `ctl` (spawn/resize/kill PTY, list ports, fetch, fs ops — all
 * under capability tokens), `pty/<id>`, `fwd/<port>`, `vfs`, `log`.
 *
 * The agent runs inside the user's VM with a NEAR-ZERO-PRIVILEGE machine
 * credential (I-2): it cannot enroll or impersonate devices, cannot write to
 * the session plane (no path exists — I-1), and cannot touch the identity
 * gateway (I-3). Everything it is allowed to do is named explicitly by a
 * capability token, so rooting the VM grants nothing beyond the VM.
 */

import { z } from "zod";
import { manifestSchema } from "./files.js";

/* ------------------------------------------------------------------ *
 * Capability tokens (I-2)
 * ------------------------------------------------------------------ */

/**
 * The complete set of operations a machine credential can be granted. There
 * is deliberately no capability for device enrollment, session records, key
 * material, or egress configuration — those planes are unreachable from the
 * VM by construction, and the absence of a name for them is the point.
 */
export const CAPABILITIES = [
  "pty.spawn",
  "pty.io",
  "pty.resize",
  "pty.kill",
  "ports.list",
  "ports.forward",
  "fetch.public",
  "fs.read",
  "fs.write",
  "log.read",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Capabilities a normal interactive terminal session needs. */
export const TERMINAL_CAPABILITIES: ReadonlyArray<Capability> = [
  "pty.spawn",
  "pty.io",
  "pty.resize",
  "pty.kill",
  "ports.list",
  "ports.forward",
  "log.read",
];

export const capabilitySchema = z.enum(CAPABILITIES);

/**
 * Claims inside an agent capability token. Deliberately narrow: bound to one
 * machine, one user, a short window, and an explicit capability list.
 */
export interface CapabilityClaims {
  /** Machine id this token is valid for — a token cannot roam machines. */
  mid: string;
  /** Owning user id (routing/audit only; grants nothing on its own). */
  sub: string;
  caps: Capability[];
  iat: number;
  exp: number;
  jti: string;
}

/** Capability tokens are short-lived; the agent is re-issued them on demand. */
export const CAPABILITY_TOKEN_TTL_SECONDS = 300;

export function hasCapability(claims: CapabilityClaims, cap: Capability): boolean {
  return claims.caps.includes(cap);
}

/**
 * Check a capability token against the operation being attempted. Returns the
 * reason for refusal, or null when allowed — callers must fail closed.
 */
export function checkCapability(
  claims: CapabilityClaims,
  machineId: string,
  cap: Capability,
  nowSeconds: number,
): string | null {
  if (claims.mid !== machineId) return "token is bound to a different machine";
  if (claims.exp < nowSeconds) return "capability token expired";
  if (!hasCapability(claims, cap)) return `capability ${cap} not granted`;
  return null;
}

/* ------------------------------------------------------------------ *
 * Channels
 * ------------------------------------------------------------------ */

export type AgentChannelKind = "auth" | "ctl" | "pty" | "fwd" | "vfs" | "log";

/**
 * Parse a mux channel name (`ctl`, `pty/<id>`, `fwd/<port>[/<streamId>]`,
 * `vfs`, `log`).
 *
 * The fwd port is parsed STRICTLY (decimal digits only, whole segment) —
 * matching the Rust parser, which always was strict. The optional streamId
 * gives a forward stream identity on transports where one connection
 * carries many streams (the relay); over per-connection TCP the bare form
 * suffices because the connection IS the stream.
 */
export function parseChannel(
  name: string,
): { kind: AgentChannelKind; id?: string; port?: number } | null {
  if (name === "auth" || name === "ctl" || name === "vfs" || name === "log") {
    return { kind: name };
  }
  const slash = name.indexOf("/");
  if (slash < 0) return null;
  const head = name.slice(0, slash);
  const rest = name.slice(slash + 1);
  if (head === "pty") return rest.length > 0 ? { kind: "pty", id: rest } : null;
  if (head === "fwd") {
    const idSlash = rest.indexOf("/");
    const portPart = idSlash < 0 ? rest : rest.slice(0, idSlash);
    const streamId = idSlash < 0 ? undefined : rest.slice(idSlash + 1);
    if (!/^\d+$/.test(portPart)) return null;
    const port = Number.parseInt(portPart, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (streamId !== undefined && streamId.length === 0) return null;
    return streamId === undefined
      ? { kind: "fwd", port }
      : { kind: "fwd", port, id: streamId };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * ctl messages
 * ------------------------------------------------------------------ */

export const ptySpawnSchema = z.object({
  t: z.literal("pty.spawn"),
  /** Client-chosen id so a reattach can name the PTY it wants. */
  ptyId: z.string().min(1).max(128),
  cwd: z.string().max(4096).optional(),
  command: z.string().max(4096).optional(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  env: z.record(z.string().max(4096)).optional(),
});

export const ptyResizeSchema = z.object({
  t: z.literal("pty.resize"),
  ptyId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export const ptyKillSchema = z.object({
  t: z.literal("pty.kill"),
  ptyId: z.string().min(1),
  signal: z.enum(["TERM", "KILL", "INT"]).optional(),
});

/**
 * Reattach to an existing PTY. The agent answers with whether the process was
 * RESUMED (still alive) or RECONSTRUCTED (cold boot lost it; scrollback, cwd
 * and history are restored from disk) — the UI must surface which (§8.5).
 */
export const ptyAttachSchema = z.object({
  t: z.literal("pty.attach"),
  ptyId: z.string().min(1),
  /** Resume scrollback from this byte offset; 0 replays the whole buffer. */
  sinceByte: z.number().int().nonnegative().optional(),
  /** Optional target grid. New agents apply it before capturing tmux replay;
   * older agents safely ignore these additive fields. */
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
});

/** Job Mode: mark this PTY's workload as "keep running" (§8.5). */
export const jobModeSchema = z.object({
  t: z.literal("job.set"),
  ptyId: z.string().min(1),
  enabled: z.boolean(),
  label: z.string().max(200).optional(),
});

/**
 * Enumerate the agent's PTY sessions — live ones and persisted contexts a
 * cold boot left behind. This is what lets a SECOND device discover sessions
 * it did not create (§8.5 M-2: same terminal tab on the other Mac): ptyIds
 * live only in each desktop's in-memory registry, so without a list the
 * agent's sessions are unreachable from anywhere but the spawning device.
 */
export const ptyListSchema = z.object({ t: z.literal("pty.list") });

export const portsListSchema = z.object({ t: z.literal("ports.list") });

/**
 * A URL safe to place in a request line. `z.string().url()` is not enough:
 * WHATWG parsing TOLERATES raw CR/LF and hands the string back unmodified, so
 * a URL carrying `\r\n` smuggles headers (or a whole second request) into any
 * client that formats a request by interpolation. Reject rather than
 * sanitize — a URL containing a control character is never legitimate, and
 * percent-encoded `%0d%0a` still passes because it is not an injection.
 *
 * The agent enforces the same rule again before it opens a socket; this is
 * the shared contract's half of that check.
 */
const safeRequestUrl = z
  .string()
  .max(8192)
  .url()
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  .refine((u) => !/[\u0000-\u0020\u007f]/.test(u), {
    message: "URL must not contain control characters or spaces",
  });

export const fetchPublicSchema = z.object({
  t: z.literal("fetch.public"),
  /** Stable correlation id for this fetch (normally the Files transfer UUID). */
  fetchId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  /** Public or presigned URL only — no credentials ever cross into the VM (§8.6). */
  url: safeRequestUrl,
  destPath: z.string().max(4096),
});

/**
 * Cancel a running (or queued) background fetch. Fire-and-forget, like
 * pty.kill: there is no response frame — confirmation is the existing
 * `fetch.failed` event carrying [`FETCH_CANCELLED_ERROR`]. Unknown ids and
 * double-cancels are silent no-ops.
 */
export const fetchCancelSchema = z.object({
  t: z.literal("fetch.cancel"),
  fetchId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});

/**
 * The exact `fetch.failed.error` string a cancelled fetch reports — every
 * implementation (Rust agent, SimAgent) emits this verbatim, and the
 * desktop matches on it to show "cancelled" rather than "failed".
 */
export const FETCH_CANCELLED_ERROR = "cancelled by the user";

export const agentCtlRequestSchema = z.discriminatedUnion("t", [
  ptySpawnSchema,
  ptyResizeSchema,
  ptyKillSchema,
  ptyAttachSchema,
  jobModeSchema,
  ptyListSchema,
  portsListSchema,
  fetchPublicSchema,
  fetchCancelSchema,
]);
export type AgentCtlRequest = z.infer<typeof agentCtlRequestSchema>;

/** Capability required by each ctl operation — the agent's authorization table. */
export const CTL_CAPABILITY: Readonly<Record<AgentCtlRequest["t"], Capability>> = {
  "pty.spawn": "pty.spawn",
  "pty.resize": "pty.resize",
  "pty.kill": "pty.kill",
  "pty.attach": "pty.io",
  // Listing reveals what attach would reveal (cwd, command), so it requires
  // what attach requires.
  "pty.list": "pty.io",
  "job.set": "pty.spawn",
  "ports.list": "ports.list",
  "fetch.public": "fetch.public",
  // Cancelling is scoped by the same grant that starts a fetch.
  "fetch.cancel": "fetch.public",
};

export type PtyRestoreKind = "resumed" | "reconstructed";

/** One entry in a `pty.listing` response. */
export interface PtySessionEntry {
  ptyId: string;
  cwd: string;
  /** The spawn command, when one was given (interactive shells have none). */
  command?: string;
  /** Live process vs. persisted context only — what attach would report. */
  live: boolean;
}

export interface ListeningPort {
  port: number;
  /** Process command that opened it, best-effort. */
  process: string;
  /** Bound to loopback only — safe to forward. */
  loopback: boolean;
}

export const agentCtlResponseSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("pty.spawned"), ptyId: z.string() }),
  z.object({
    t: z.literal("pty.attached"),
    ptyId: z.string(),
    /** Whether the live process survived, or only its context did (§8.5). */
    restore: z.enum(["resumed", "reconstructed"]),
    scrollbackBytes: z.number().int().nonnegative(),
    cwd: z.string(),
  }),
  z.object({ t: z.literal("pty.exited"), ptyId: z.string(), code: z.number().int() }),
  z.object({
    t: z.literal("pty.listing"),
    sessions: z.array(
      z.object({
        ptyId: z.string(),
        cwd: z.string(),
        command: z.string().optional(),
        live: z.boolean(),
      }),
    ),
  }),
  z.object({ t: z.literal("job.ack"), ptyId: z.string(), enabled: z.boolean() }),
  z.object({
    t: z.literal("ports"),
    ports: z.array(
      z.object({ port: z.number().int(), process: z.string(), loopback: z.boolean() }),
    ),
  }),
  /**
   * `fetch.started` is the TERMINAL response to a `fetch.public` request —
   * the fetch itself runs as a background task on the agent. Everything
   * after it (`fetch.progress`, `fetch.done`, `fetch.failed`) arrives as an
   * UNSOLICITED event, matched to the request by `fetchId`.
   *
   * FIFO invariant: the ctl client resolves its pending head on the expected
   * response type OR on any `error` frame — so an unsolicited event must
   * NEVER use `t: "error"`. Async failures are the typed `fetch.failed`.
   */
  z.object({
    t: z.literal("fetch.started"),
    fetchId: z.string(),
    url: z.string(),
    path: z.string(),
  }),
  z.object({
    t: z.literal("fetch.progress"),
    fetchId: z.string(),
    url: z.string(),
    received: z.number(),
    total: z.number(),
  }),
  z.object({
    t: z.literal("fetch.done"),
    fetchId: z.string(),
    url: z.string(),
    path: z.string(),
    bytes: z.number(),
    /** Chunk manifest of the fetched file (§8.6) — the agent computes it so
     *  the control plane can record content addresses without re-reading. */
    manifest: manifestSchema.optional(),
  }),
  z.object({
    t: z.literal("fetch.failed"),
    fetchId: z.string(),
    url: z.string(),
    path: z.string(),
    error: z.string(),
  }),
  /**
   * Unsolicited-only: something under the agent's Files root changed (a
   * shell wrote a file, a fetch landed). `paths` lists rooted wire paths
   * when the emitter knows them and they are few; absent means "something
   * changed — re-list". Never a response to any request.
   */
  z.object({ t: z.literal("vfs.changed"), paths: z.array(z.string()).optional() }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type AgentCtlResponse = z.infer<typeof agentCtlResponseSchema>;

export function parseCtlRequest(raw: string): AgentCtlRequest {
  return agentCtlRequestSchema.parse(JSON.parse(raw));
}

export function parseCtlResponse(raw: string): AgentCtlResponse {
  return agentCtlResponseSchema.parse(JSON.parse(raw));
}

/** Scrollback retained per PTY (§8.5) — persists independently of the memory snapshot. */
export const PTY_SCROLLBACK_LINES = 100_000;
