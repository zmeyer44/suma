/**
 * WebSocket face of the home-machine relay (src/relay.ts holds the pure
 * piping logic; this file is the only one that imports `ws`).
 *
 *   GET /v1/relay/home   — the user's HOME device only (users.home_device_id)
 *   GET /v1/relay/agent  — any OTHER non-revoked device of the same user
 *
 * Auth happens BEFORE the upgrade completes: token from the Authorization
 * header (the desktop's `ws` client can set headers) or `?access_token=`
 * (deleted immediately — it must never reach a log line), verified by the
 * same `authenticateToken` the HTTP routes use. Refusals are raw HTTP
 * status responses on the socket, which `ws` clients surface as
 * `unexpected-server-response`.
 *
 * SECURITY (read before touching): a non-home device token admitted here
 * gets the FULL agent protocol against the home Mac — including pty.spawn,
 * i.e. a shell as the home user. That is the intended power of an enrolled
 * device (it is what the home Mac itself has); the guards are the ones
 * enrollment already implies — short-lived signed tokens, revocation
 * checked at upgrade AND re-checked on every heartbeat tick below, and the
 * §8.2 enrollment ceremony gating device creation. Bootstrap (user-scoped)
 * tokens are refused outright. The relay itself is a trusted middleman:
 * TLS terminates here and frames are plaintext to this process — no E2E
 * yet, stated in the plan.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateToken } from "./auth.js";
import type { Db } from "./db/client.js";
import { devices, users } from "./db/schema.js";
import type { SigningKeys } from "./keys-provider.js";
import { RelayRegistry, type RelaySocket } from "./relay.js";

const HOME_PATH = "/v1/relay/home";
const AGENT_PATH = "/v1/relay/agent";

/** Mux frame cap (agent MAX_FRAME_LEN) + envelope slack. */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024 + 64;

/** Heartbeat: ping every 30 s; a peer that misses two is gone. Each tick
 *  also re-checks revocation — a revoked device must not ride a live socket
 *  past the next tick (close 1008). */
const HEARTBEAT_MS = 30_000;

export interface RelayServerDeps {
  db: Db;
  registry: RelayRegistry;
  getSigning: () => Promise<SigningKeys>;
}

export function attachRelay(server: Server, deps: RelayServerDeps): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(wss, deps, request, socket, head).catch(() => {
      socket.destroy();
    });
  });
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

async function handleUpgrade(
  wss: WebSocketServer,
  deps: RelayServerDeps,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://relay.invalid");
  const pathname = url.pathname;
  if (pathname !== HOME_PATH && pathname !== AGENT_PATH) {
    socket.destroy(); // not ours — no other upgrade endpoints exist
    return;
  }

  // Token: header first; ?access_token= second (deleted before anything
  // else can see the URL — the sessionhub convention).
  const header = request.headers.authorization;
  const queryToken = url.searchParams.get("access_token");
  url.searchParams.delete("access_token");
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : queryToken;

  const identity = await authenticateToken(deps.db, token, await deps.getSigning());
  if (identity === null) {
    reject(socket, 401, "Unauthorized");
    return;
  }
  if (identity.deviceId === null) {
    // Relay endpoints are device-bound by definition; a bootstrap token has
    // no device to be.
    reject(socket, 403, "Forbidden");
    return;
  }

  const [user] = await deps.db
    .select({ computeMode: users.computeMode, homeDeviceId: users.homeDeviceId })
    .from(users)
    .where(eq(users.id, identity.userId));
  if (!user || user.computeMode !== "local" || user.homeDeviceId === null) {
    reject(socket, 409, "Conflict"); // no home computer exists for this account
    return;
  }
  const isHome = identity.deviceId === user.homeDeviceId;
  if (pathname === HOME_PATH && !isHome) {
    reject(socket, 403, "Forbidden");
    return;
  }
  if (pathname === AGENT_PATH && isHome) {
    // The home Mac talks to its in-process agent directly, never the relay.
    reject(socket, 403, "Forbidden");
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    if (pathname === HOME_PATH) {
      wireHome(deps, identity.userId, identity.deviceId as string, ws);
    } else {
      wireClient(deps, identity.userId, identity.deviceId as string, ws);
    }
  });
}

/** Adapt a `ws` socket to the registry's minimal surface. */
function asRelaySocket(ws: WebSocket): RelaySocket {
  return {
    send: (data) => {
      // 64 MiB of unread backlog means the peer stalled; cutting it protects
      // this process's memory, and both ends know how to reconnect.
      if (ws.bufferedAmount > 64 * 1024 * 1024) {
        ws.close(1013, "backpressure");
        return;
      }
      ws.send(data);
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

function startHeartbeat(deps: RelayServerDeps, deviceId: string, ws: WebSocket): void {
  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
    // Revocation re-check: upgrade-time auth is not enough for a socket
    // that can live for days.
    void deps.db
      .select({ revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .then(([device]) => {
        if (!device || device.revokedAt !== null) ws.close(1008, "revoked");
      })
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  timer.unref();
  ws.on("close", () => clearInterval(timer));
}

function wireHome(
  deps: RelayServerDeps,
  userId: string,
  deviceId: string,
  ws: WebSocket,
): void {
  const socket = asRelaySocket(ws);
  deps.registry.attachHome(userId, socket);
  startHeartbeat(deps, deviceId, ws);
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    const buffer = toBuffer(data);
    deps.registry.homeMessage(userId, isBinary ? buffer : buffer.toString("utf8"));
  });
  ws.on("close", () => deps.registry.detachHome(userId, socket));
  ws.on("error", () => ws.terminate());
}

function wireClient(
  deps: RelayServerDeps,
  userId: string,
  deviceId: string,
  ws: WebSocket,
): void {
  const conn = deps.registry.attachClient(userId, asRelaySocket(ws));
  if (conn === null) return; // already closed 4404 (home offline)
  startHeartbeat(deps, deviceId, ws);
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (!isBinary) return; // the away leg has no text protocol
    deps.registry.clientMessage(userId, conn, toBuffer(data));
  });
  ws.on("close", () => deps.registry.detachClient(userId, conn));
  ws.on("error", () => ws.terminate());
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
