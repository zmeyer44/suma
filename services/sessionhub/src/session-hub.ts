/**
 * SessionHub Durable Object — one per user, addressed by
 * `idFromName(userId)`. Thin adapter binding HubCore to DO storage and
 * hibernatable WebSockets; every decision lives in HubCore.
 */

import {
  GATEWAY_COOKIES_PATH,
  GATEWAY_FETCH_PATH,
  type ServerMessage,
} from "@suma/protocol";
import type { Env } from "./index.js";
import { GatewayCore } from "./gateway-core.js";
import {
  CLOSE_REVOKED,
  HubCore,
  hydrateRequestSchema,
  revokeRequestSchema,
  type HubConnection,
  type HubStorage,
} from "./hub-core.js";
import { DEVICE_HEADER, jsonResponse } from "./http.js";

/** Only fixed-size socket identity rides in the hibernation attachment (2KB
 * cap). Declared spaces live in DO storage under a per-connection key. */
interface SocketAttachment {
  deviceId: string | null;
  connectionId?: string;
}

class SocketConnection implements HubConnection {
  deviceId: string | null;
  connectionId: string;
  spaceIds: string[] = [];

  constructor(private readonly ws: WebSocket) {
    const attachment = (ws.deserializeAttachment() ??
      null) as SocketAttachment | null;
    this.deviceId = attachment?.deviceId ?? null;
    // Missing only for sockets hibernated before the per-connection rollout.
    this.connectionId = attachment?.connectionId ?? crypto.randomUUID();
  }

  send(msg: ServerMessage): void {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Socket already gone; presence catches up via webSocketClose.
    }
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // Socket already gone.
    }
  }

  persist(): void {
    const attachment: SocketAttachment = {
      deviceId: this.deviceId,
      connectionId: this.connectionId,
    };
    this.ws.serializeAttachment(attachment);
  }
}

export class SessionHub implements DurableObject {
  private readonly core: HubCore;
  private readonly gateway: GatewayCore;

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    const storage = state.storage;
    const adapter: HubStorage = {
      get: <T>(key: string) => storage.get<T>(key),
      put: <T>(key: string, value: T) => storage.put(key, value),
      delete: (key: string) => storage.delete(key),
      list: <T>(options: { prefix: string }) =>
        storage.list<T>({ prefix: options.prefix }),
    };
    this.core = new HubCore(adapter);
    this.gateway = new GatewayCore(adapter, {
      allowPrivateTargets: env.GATEWAY_DEV_ALLOW_PRIVATE === "1",
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Edge-verified device identity (signed token path); absent in stub mode,
    // where the hello frame binds the deviceId instead.
    const edgeDeviceId = request.headers.get(DEVICE_HEADER);
    if (
      url.pathname === GATEWAY_FETCH_PATH ||
      url.pathname === GATEWAY_COOKIES_PATH
    ) {
      if (edgeDeviceId !== null && (await this.core.isRevoked(edgeDeviceId))) {
        return jsonResponse({ error: "revoked" }, 403);
      }
      return url.pathname === GATEWAY_FETCH_PATH
        ? this.gateway.handleFetch(request)
        : this.gateway.handleCookies(request);
    }
    if (url.pathname === "/v1/hub/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return jsonResponse({ error: "upgrade_required" }, 426);
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const connectionId = crypto.randomUUID();
      // Identity rides in the hibernation attachment rather than in tags: in
      // stub mode it arrives only with the hello frame, after accept.
      this.state.acceptWebSocket(server);
      if (edgeDeviceId !== null && (await this.core.isRevoked(edgeDeviceId))) {
        // Accept-then-close so the client sees the 4003 close code. The
        // attachment stays unbound, keeping webSocketClose a no-op.
        server.serializeAttachment({
          deviceId: null,
          connectionId,
        } satisfies SocketAttachment);
        server.close(CLOSE_REVOKED, "revoked");
        return new Response(null, { status: 101, webSocket: client });
      }
      server.serializeAttachment({
        deviceId: edgeDeviceId,
        connectionId,
      } satisfies SocketAttachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/v1/hub/hydrate" && request.method === "POST") {
      if (edgeDeviceId !== null && (await this.core.isRevoked(edgeDeviceId))) {
        return jsonResponse({ error: "revoked" }, 403);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "malformed" }, 400);
      }
      const parsed = hydrateRequestSchema.safeParse(body);
      if (!parsed.success) return jsonResponse({ error: "malformed" }, 400);
      const { records, watermark } = await this.core.hydrateSpace(
        parsed.data.spaceId,
        parsed.data.sinceHlc,
      );
      return jsonResponse({ records, count: records.length, watermark });
    }
    if (url.pathname === "/v1/admin/revoke" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "malformed" }, 400);
      }
      const parsed = revokeRequestSchema.safeParse(body);
      if (!parsed.success) return jsonResponse({ error: "malformed" }, 400);
      const connections = this.state
        .getWebSockets()
        .map((ws) => new SocketConnection(ws));
      const toClose = await this.core.revokeDevice(
        parsed.data.deviceId,
        connections,
      );
      for (const conn of toClose) conn.close(CLOSE_REVOKED, "revoked");
      return jsonResponse({ ok: true, closed: toClose.length });
    }
    return jsonResponse({ error: "not_found" }, 404);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const sender = new SocketConnection(ws);
    if (typeof message !== "string") {
      sender.send({
        t: "error",
        code: "malformed",
        message: "binary frames unsupported",
      });
      return;
    }
    await this.core.handleMessage(sender, message, this.peersOf(ws));
    sender.persist();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.core.handleClose(new SocketConnection(ws), this.peersOf(ws));
  }

  private peersOf(ws: WebSocket): SocketConnection[] {
    return this.state
      .getWebSockets()
      .filter((peer) => peer !== ws)
      .map((peer) => new SocketConnection(peer));
  }
}
