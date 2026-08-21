/**
 * Files / VFS contract (PRD §8.6, V1 = M-3 Lite).
 *
 * The load-bearing rule in this file is the eligibility check for handing a
 * download to the cloud. v1.0 proposed a "sealed one-shot request" that
 * shipped the user's URL and Cookie header into the VM to be decrypted there;
 * §8.6 deletes it, because "memory-only, single-use, audited" are application
 * properties, not security boundaries, when the attacker controls the
 * decrypting environment — and the user can root their own VM.
 *
 * So the cloud fetch path is only ever offered for requests that carry no
 * credential at all: a public URL, or a presigned one whose authorization is
 * already baked into the query string by the origin. Anything that would need
 * a cookie, an Authorization header, or client TLS auth stays on this Mac.
 * `cloudFetchEligibility` is that decision, and it fails closed.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Cloud-fetch eligibility (§8.6 — the I-1 boundary for downloads)
 * ------------------------------------------------------------------ */

/** Threshold above which a download is worth handing to the cloud (§8.6). */
export const CLOUD_FETCH_MIN_BYTES = 50 * 1024 * 1024;

export type CloudFetchVerdict =
  | { eligible: true; reason: "public" | "presigned" }
  | { eligible: false; reason: CloudFetchRefusal; explanation: string };

export type CloudFetchRefusal =
  | "not_http"
  | "credentialed_request"
  | "userinfo_in_url"
  | "private_host"
  | "too_small"
  | "policy_local_only";

/**
 * What the browser knows about a download it is about to start. The presence
 * of ANY of the credential fields disqualifies the cloud path — the VM must
 * never be handed something it could replay as the user.
 */
export interface DownloadContext {
  url: string;
  /** Bytes, when the server declared a length; null when unknown. */
  totalBytes: number | null;
  /** True when the request would carry cookies for its origin. */
  hasCookies: boolean;
  /** True when an Authorization header (or equivalent) would be sent. */
  hasAuthHeader: boolean;
  /** True when the origin required client-certificate authentication. */
  usesClientCert: boolean;
  /** User setting: always keep downloads on this Mac. */
  alwaysLocal: boolean;
}

/**
 * Query parameters that identify a link as an object-storage presigned URL:
 * scoped to one object, carrying its own expiry, and authorized by the origin
 * that minted it. Forwarding such a link forwards no authority its holder
 * does not already have over that one object.
 *
 * These are deliberately vendor-specific. An earlier version also accepted
 * generic `token` / `sig` / `signature`, which was backwards: `?access_token=`
 * is how many APIs still accept an OAuth BEARER token, so the very parameter
 * that should disqualify a URL was being read as evidence it was safe.
 */
const PRESIGNED_MARKERS: ReadonlyArray<string> = [
  "x-amz-signature",
  "x-amz-credential",
  "x-goog-signature",
  "x-goog-credential",
  "se", // Azure SAS expiry
  "sp", // Azure SAS permissions
];

/** Azure SAS is only a SAS when the signature travels with the version+expiry. */
function isAzureSas(params: URLSearchParams): boolean {
  return params.has("sig") && params.has("sv") && (params.has("se") || params.has("sp"));
}

function isPresigned(url: URL): boolean {
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) params.append(k.toLowerCase(), v);
  if (isAzureSas(params)) return true;
  for (const key of params.keys()) {
    if (PRESIGNED_MARKERS.includes(key)) return true;
  }
  return false;
}

/**
 * Query parameters that carry an account-level bearer credential rather than
 * per-object authority. A URL holding one of these is as sensitive as an
 * Authorization header, so it can never be handed to the compute plane —
 * §8.6 sanctions "presigned URLs plus deliberately scoped short-lived
 * download tokens", and nothing here can tell a scoped download token from an
 * unscoped account token, so the unscoped-looking ones stay local.
 */
const BEARER_QUERY_KEYS: ReadonlyArray<string> = [
  "access_token",
  "accesstoken",
  "auth",
  "auth_token",
  "authtoken",
  "api_key",
  "apikey",
  "bearer",
  "id_token",
  "jwt",
  "key",
  "password",
  "private_token",
  "refresh_token",
  "secret",
  "session",
  "session_id",
  "sessionid",
  "token",
];

function hasBearerQueryCredential(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    const k = key.toLowerCase();
    if (BEARER_QUERY_KEYS.includes(k)) return true;
  }
  return false;
}

/**
 * Reject the same private space the egress gateway and the agent refuse (no
 * SSRF pivot). This mirrors `check_target_host` in `agent/src/fetch.rs` —
 * keep the two in step: the agent is the last line, but a browser-side check
 * that is quietly weaker means the control plane accepts transfers only the
 * agent will reject, which reads as a flaky product rather than a refusal.
 */
function isPrivateV4(a: number, b: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h === "0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return isPrivateV4(Number(v4[1]), Number(v4[2]));
  // IPv4-mapped/compatible IPv6 reaches exactly the same address, so classify
  // it by the embedded v4 rather than waving it through as "some other IPv6".
  // Both spellings matter: authors write `::ffff:169.254.169.254`, but URL
  // parsing normalizes it to the hextet form `::ffff:a9fe:a9fe`.
  const dotted = /^::(?:ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dotted) return isPrivateV4(Number(dotted[1]), Number(dotted[2]));
  const hextet = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hextet) {
    const high = Number.parseInt(hextet[1] as string, 16);
    return isPrivateV4(high >> 8, high & 0xff);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  if (h.includes(":")) return false; // other IPv6 literals are public
  return !h.includes(".");
}

/**
 * May this download be handed to the cloud fetcher? Fails closed: anything
 * unrecognized stays local, because the cost of being wrong is shipping a
 * credential into an environment the user can root.
 */
export function cloudFetchEligibility(ctx: DownloadContext): CloudFetchVerdict {
  if (ctx.alwaysLocal) {
    return {
      eligible: false,
      reason: "policy_local_only",
      explanation: "Downloads are set to stay on this Mac.",
    };
  }
  let url: URL;
  try {
    url = new URL(ctx.url);
  } catch {
    return {
      eligible: false,
      reason: "not_http",
      explanation: "Only http(s) downloads can be fetched in the cloud.",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      eligible: false,
      reason: "not_http",
      explanation: "Only http(s) downloads can be fetched in the cloud.",
    };
  }
  // `https://user:pass@host/...` is a credential in the URL itself.
  if (url.username !== "" || url.password !== "") {
    return {
      eligible: false,
      reason: "userinfo_in_url",
      explanation: "This link embeds a username or password, so it stays on this Mac.",
    };
  }
  if (ctx.hasCookies || ctx.hasAuthHeader || ctx.usesClientCert) {
    return {
      eligible: false,
      reason: "credentialed_request",
      explanation:
        "This download is authenticated, so Suma fetches it on this Mac. " +
        "Suma never sends your credentials to your cloud machine.",
    };
  }
  // A credential in the query string is still a credential, even though no
  // header carries it. Checked AFTER the presigned test would have matched,
  // so an Azure SAS (`sig` + `sv` + `se`) is not mistaken for a bearer token.
  if (!isPresigned(url) && hasBearerQueryCredential(url)) {
    return {
      eligible: false,
      reason: "credentialed_request",
      explanation:
        "This link carries an access token, so Suma fetches it on this Mac. " +
        "Suma never sends your credentials to your cloud machine.",
    };
  }
  if (isPrivateHost(url.hostname)) {
    return {
      eligible: false,
      reason: "private_host",
      explanation: "This address is on your local network, which your cloud machine cannot reach.",
    };
  }
  if (ctx.totalBytes !== null && ctx.totalBytes < CLOUD_FETCH_MIN_BYTES) {
    return {
      eligible: false,
      reason: "too_small",
      explanation: "Small downloads are faster straight to this Mac.",
    };
  }
  return { eligible: true, reason: isPresigned(url) ? "presigned" : "public" };
}

/* ------------------------------------------------------------------ *
 * File entries, manifests, transfers
 * ------------------------------------------------------------------ */

export const fileEntrySchema = z.object({
  id: z.string().min(1),
  /** POSIX-ish path within the user's Suma Files space. */
  path: z.string().min(1).max(4096),
  sizeBytes: z.number().int().nonnegative(),
  /** BLAKE3 of the whole file, hex. */
  fileHash: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string().max(255).nullable(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const chunkRefSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});

export const manifestSchema = z.object({
  fileHash: z.string().regex(/^[0-9a-f]{64}$/),
  totalBytes: z.number().int().nonnegative(),
  chunks: z.array(chunkRefSchema),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const TRANSFER_STATES = [
  "queued",
  "fetching",
  "storing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

/** A cloud fetch in flight, visible on every device (§5 M-3 Lite). */
export const transferSchema = z.object({
  id: z.string().min(1),
  url: z.string().max(8192),
  destPath: z.string().max(4096),
  state: z.enum(TRANSFER_STATES),
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  /** Which device asked for it — shown so a second Mac knows where it came from. */
  originDeviceId: z.string().nullable(),
  error: z.string().max(500).nullable(),
  startedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});
export type Transfer = z.infer<typeof transferSchema>;

/* ------------------------------------------------------------------ *
 * Quota (§8.6: Pro 100 GB, soft-block at limit)
 * ------------------------------------------------------------------ */

export const PRO_QUOTA_BYTES = 100 * 1024 * 1024 * 1024;

export interface QuotaState {
  usedBytes: number;
  limitBytes: number;
}

export interface QuotaVerdict {
  allowed: boolean;
  /** Soft block: existing files stay readable; new writes are refused. */
  softBlocked: boolean;
  usedBytes: number;
  limitBytes: number;
  explanation: string;
}

/**
 * Soft-block semantics: at the limit Suma refuses NEW bytes but never
 * deletes or hides what is already stored — losing a user's data to a quota
 * would be a far worse failure than refusing an upload.
 */
export function checkQuota(state: QuotaState, incomingBytes: number): QuotaVerdict {
  const projected = state.usedBytes + incomingBytes;
  const softBlocked = state.usedBytes >= state.limitBytes;
  const allowed = projected <= state.limitBytes;
  return {
    allowed,
    softBlocked,
    usedBytes: state.usedBytes,
    limitBytes: state.limitBytes,
    explanation: allowed
      ? "Within your Files quota."
      : `This would put you over your ${Math.round(state.limitBytes / 1024 ** 3)} GB Files quota. ` +
        "Existing files stay available; free up space to add more.",
  };
}

/* ------------------------------------------------------------------ *
 * VFS channel messages (Appendix C `vfs`)
 * ------------------------------------------------------------------ */

export const vfsRequestSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("vfs.list"), path: z.string().max(4096) }),
  z.object({ t: z.literal("vfs.stat"), path: z.string().max(4096) }),
  z.object({ t: z.literal("vfs.read"), path: z.string().max(4096), offset: z.number().int().nonnegative(), length: z.number().int().positive().max(64 * 1024 * 1024) }),
  z.object({ t: z.literal("vfs.write"), path: z.string().max(4096), dataB64: z.string() }),
  z.object({ t: z.literal("vfs.append"), path: z.string().max(4096), dataB64: z.string() }),
  z.object({ t: z.literal("vfs.delete"), path: z.string().max(4096), recursive: z.boolean().optional() }),
  z.object({ t: z.literal("vfs.mkdir"), path: z.string().max(4096) }),
  z.object({ t: z.literal("vfs.tree"), path: z.string().max(4096) }),
  z.object({ t: z.literal("vfs.rename"), from: z.string().max(4096), to: z.string().max(4096) }),
]);
export type VfsRequest = z.infer<typeof vfsRequestSchema>;

export function parseVfsRequest(raw: string): VfsRequest {
  return vfsRequestSchema.parse(JSON.parse(raw));
}

export const vfsKindSchema = z.enum(["file", "dir", "other"]);
export type VfsKind = z.infer<typeof vfsKindSchema>;

export const vfsEntrySchema = z.object({
  name: z.string(),
  path: z.string(), // normalized, always rooted ("/a/b")
  kind: vfsKindSchema,
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number().int().nonnegative(),
});
export type VfsEntry = z.infer<typeof vfsEntrySchema>;

/**
 * Mirror of `VfsResponse` in agent/src/vfs.rs — the agent leads this shape;
 * any change lands there first and here in the same commit. `error.code` is
 * an open string so newer agent codes degrade to a message, not a parse
 * failure on old desktops.
 */
export const vfsResponseSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("vfs.listing"), path: z.string(), entries: z.array(vfsEntrySchema), truncated: z.boolean() }),
  z.object({ t: z.literal("vfs.info"), entry: vfsEntrySchema }),
  z.object({ t: z.literal("vfs.data"), path: z.string(), offset: z.number().int().nonnegative(), dataB64: z.string(), eof: z.boolean() }),
  z.object({ t: z.literal("vfs.wrote"), path: z.string(), sizeBytes: z.number().int().nonnegative() }),
  z.object({ t: z.literal("vfs.deleted"), path: z.string() }),
  z.object({ t: z.literal("vfs.created"), path: z.string() }),
  z.object({ t: z.literal("vfs.renamed"), from: z.string(), to: z.string() }),
  z.object({ t: z.literal("vfs.paths"), path: z.string(), paths: z.array(z.string()), truncated: z.boolean() }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type VfsResponse = z.infer<typeof vfsResponseSchema>;

export function parseVfsResponse(raw: string): VfsResponse {
  return vfsResponseSchema.parse(JSON.parse(raw));
}

/** Which agent capability each vfs op requires (mirror of vfs.rs `required_capability`). */
export const VFS_CAPABILITY: Record<VfsRequest["t"], "fs.read" | "fs.write"> = {
  "vfs.list": "fs.read",
  "vfs.stat": "fs.read",
  "vfs.read": "fs.read",
  "vfs.tree": "fs.read",
  "vfs.write": "fs.write",
  "vfs.append": "fs.write",
  "vfs.delete": "fs.write",
  "vfs.mkdir": "fs.write",
  "vfs.rename": "fs.write",
};

/* Caps shared with the agent (vfs.rs) and the sim (local-vfs.ts). Read/write
 * are bounded by base64 expansion fitting the 16 MiB mux frame. */
export const VFS_MAX_READ_BYTES = 8 * 1024 * 1024;
export const VFS_MAX_WRITE_BYTES = 8 * 1024 * 1024;
export const VFS_MAX_LIST_ENTRIES = 5_000;
export const VFS_MAX_TREE_ENTRIES = 10_000;
export const VFS_MAX_TREE_DEPTH = 12;
/** Keep in step with SKIPPED_DIRS in agent/src/vfs.rs and local-vfs.ts. */
export const VFS_TREE_SKIPPED_DIRS: ReadonlyArray<string> = [
  ".git", ".hg", ".svn", ".suma", "node_modules", ".pnpm-store", ".npm",
  ".cache", ".cargo", ".rustup", ".Trash", "Library",
];
export const VFS_TREE_SKIPPED_FILES: ReadonlyArray<string> = [".DS_Store"];

/**
 * Only `~/cloud` is cloud-native (JuiceFS-backed, canonical in R2). `$HOME`
 * is a Fly NVMe volume with snapshots — do NOT present the whole home
 * directory as having one canonical cloud location (§8.6 terminology).
 */
export const CLOUD_ROOT = "~/cloud";

/** Display form of the LOCAL-mode shared root — the home Mac's dedicated
 *  folder, the local counterpart of [`CLOUD_ROOT`]. */
export const LOCAL_HOME_ROOT = "~/Suma";

/** Reject traversal and absolute escapes before any path reaches the agent. */
export function normalizeVfsPath(path: string): string | null {
  if (path.length === 0 || path.length > 4096) return null;
  if (path.includes("\0")) return null;
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null; // escapes the root
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}
