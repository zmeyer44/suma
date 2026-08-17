/**
 * HomeAgentBridge — the HOME Mac's half of local-mode multi-device access.
 *
 * Keeps one persistent outbound WebSocket to the control plane's relay
 * (`/v1/relay/home`) and serves the agent protocol from the in-process
 * SimAgent (node-pty shells + LocalVfs at ~/Suma), one logical connection
 * per relay conn id — a reimplementation of agent/src/main.rs's
 * per-connection frame loop, minus the transport:
 *
 *   ctl frame   → sim.ctl → response frame (throws become {"t":"error"});
 *                 the conn also gets the sim's unsolicited events fanned out
 *   vfs frame   → sim.vfs, awaited SEQUENTIALLY per conn (the vfs wire has
 *                 no request ids — order is the correlation)
 *   pty/<id>    → first frame subscribes via sim.openPty; payload bytes are
 *                 shell input; output pumps back as pty/<id> frames
 *
 * Conn isolation is strict: A's pty subscriptions and event fan-out never
 * touch B, and closing A tears down exactly A's listeners.
 *
 * Security: whoever the relay admits (non-revoked enrolled devices of this
 * account — the control plane's check) gets everything this bridge serves,
 * INCLUDING shells as this user. That is the product's promise for the
 * user's own devices, and exactly what the home Mac itself has.
 */

import path from "node:path";
import os from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { parseCtlRequest, parseVfsRequest, type AgentCtlRequest } from "@suma/protocol";
import WebSocket from "ws";
import { encodeFrame, FrameDecoder, type PtyChannel } from "./agent-client";
import type { SimAgent } from "./sim-agent";

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const CONN_ID_BYTES = 8;

interface ConnState {
  decoder: FrameDecoder;
  /** ptyId → live channel into the sim, for teardown + input routing. */
  ptys: Map<string, PtyChannel>;
  unsubCtlEvents: () => void;
  /** Serializes ctl requests — the away client's pending queue is FIFO. */
  ctlTail: Promise<void>;
  /** Serializes this conn's vfs requests — order IS the correlation. */
  vfsTail: Promise<void>;
}

export interface HomeBridgeOptions {
  controlUrl: string;
  token: () => Promise<string | null>;
  sim: SimAgent;
  /** Overridable for tests — `~/x` in a spawn cwd expands against this. */
  homedir?: () => string;
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
}

export class HomeAgentBridge {
  private ws: WebSocket | null = null;
  private started = false;
  private connectedNow = false;
  private backoffMs = BACKOFF_START_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly conns = new Map<string, ConnState>();

  constructor(private readonly options: HomeBridgeOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.backoffMs = BACKOFF_START_MS;
    void this.connect();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const conn of this.conns.keys()) this.teardownConn(conn);
    this.ws?.close(1000);
    this.ws = null;
    this.connectedNow = false;
  }

  connected(): boolean {
    return this.connectedNow;
  }

  /* ------------------------------ transport ------------------------------ */

  private async connect(): Promise<void> {
    if (!this.started || this.ws !== null) return;
    let token: string | null = null;
    try {
      token = await this.options.token();
    } catch {
      token = null;
    }
    if (!this.started) return;
    if (token === null) {
      this.scheduleReconnect();
      return;
    }
    const url = `${this.options.controlUrl.replace(/^http/, "ws")}/v1/relay/home`;
    const factory =
      this.options.wsFactory ??
      ((wsUrl: string, headers: Record<string, string>) => new WebSocket(wsUrl, { headers }));
    let ws: WebSocket;
    try {
      ws = factory(url, { authorization: `Bearer ${token}` });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.backoffMs = BACKOFF_START_MS;
      this.connectedNow = true;
    });
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.ws !== ws) return;
      const buffer = toBuffer(data);
      if (isBinary) this.onBinary(buffer);
      else this.onControl(buffer.toString("utf8"));
    });
    ws.on("unexpected-response", (_req, _res) => {
      if (this.ws === ws) {
        this.ws = null;
        this.connectedNow = false;
        this.scheduleReconnect();
      }
      ws.terminate();
    });
    ws.on("error", () => {
      // close follows.
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connectedNow = false;
      // Every conn's state lived against this socket generation.
      for (const conn of this.conns.keys()) this.teardownConn(conn);
      if (this.started) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.backoffMs);
    this.retryTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  /* ------------------------------ relay wire ------------------------------ */

  private onControl(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const message = parsed as { t?: unknown; conn?: unknown };
    if (typeof message.conn !== "string") return;
    if (message.t === "open") {
      this.conns.set(message.conn, {
        decoder: new FrameDecoder(),
        ptys: new Map(),
        // Per-conn event fan-out: pty.exited, vfs.changed, fetch.* — the
        // same events an in-process listener gets, isolated per client.
        unsubCtlEvents: this.options.sim.onCtlEvent((event) => {
          this.sendFrame(message.conn as string, "ctl", JSON.stringify(event));
        }),
        ctlTail: Promise.resolve(),
        vfsTail: Promise.resolve(),
      });
    } else if (message.t === "close") {
      this.teardownConn(message.conn);
    }
  }

  private onBinary(data: Buffer): void {
    if (data.byteLength < CONN_ID_BYTES) return;
    const conn = data.subarray(0, CONN_ID_BYTES).toString("ascii");
    const state = this.conns.get(conn);
    if (state === undefined) return; // races a close — dropped
    let frames;
    try {
      frames = state.decoder.push(data.subarray(CONN_ID_BYTES));
    } catch {
      // A conn that desyncs its framing is beyond repair: drop it and tell
      // the relay so the away client reconnects fresh.
      this.teardownConn(conn);
      this.ws?.send(JSON.stringify({ t: "close", conn }));
      return;
    }
    for (const frame of frames) {
      if (frame.channel === "ctl") {
        this.enqueueCtl(conn, frame.payload);
      } else if (frame.channel === "vfs") {
        this.enqueueVfs(conn, frame.payload);
      } else if (frame.channel.startsWith("pty/")) {
        this.handlePty(conn, frame.channel, frame.payload);
      }
      // fwd/log: unwired, dropped — mirroring the Rust agent.
    }
  }

  /* ------------------------------ channels ------------------------------ */

  private enqueueCtl(conn: string, payload: Buffer): void {
    const state = this.conns.get(conn);
    if (state === undefined) return;
    state.ctlTail = state.ctlTail
      .catch(() => undefined)
      .then(async () => {
        if (!this.conns.has(conn)) return;
        await this.handleCtl(conn, payload);
      });
  }

  private async handleCtl(conn: string, payload: Buffer): Promise<void> {
    let request: AgentCtlRequest;
    try {
      request = parseCtlRequest(payload.toString("utf8"));
    } catch (err) {
      this.sendFrame(
        conn,
        "ctl",
        JSON.stringify({
          t: "error",
          code: "bad_request",
          message: `unparseable ctl payload: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      return;
    }
    // `~/…` cwds expand against THIS Mac's home — the away device composes
    // "~/Suma/<space folder>" without knowing the home Mac's username
    // (same convention the Rust agent applies in pty.rs).
    if (request.t === "pty.spawn" && typeof request.cwd === "string") {
      const home = (this.options.homedir ?? os.homedir)();
      if (request.cwd === "~") request = { ...request, cwd: home };
      else if (request.cwd.startsWith("~/")) {
        request = { ...request, cwd: path.join(home, request.cwd.slice(2)) };
      }
    }
    try {
      const response = await this.options.sim.ctl(request);
      if (response !== null) {
        this.sendFrame(conn, "ctl", JSON.stringify(response));
      }
    } catch (err) {
      // sim.ctl throws when the seat moved mid-flight (requireAvailable).
      this.sendFrame(
        conn,
        "ctl",
        JSON.stringify({
          t: "error",
          code: "unavailable",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private enqueueVfs(conn: string, payload: Buffer): void {
    const state = this.conns.get(conn);
    if (state === undefined) return;
    state.vfsTail = state.vfsTail.then(async () => {
      // Re-read: the conn may have closed while queued.
      if (!this.conns.has(conn)) return;
      let response;
      try {
        response = await this.options.sim.vfs(parseVfsRequest(payload.toString("utf8")));
      } catch (err) {
        response = {
          t: "error" as const,
          code: "unavailable",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      this.sendFrame(conn, "vfs", JSON.stringify(response));
    });
  }

  private handlePty(conn: string, channel: string, payload: Buffer): void {
    const state = this.conns.get(conn);
    if (state === undefined) return;
    const ptyId = channel.slice("pty/".length);
    let pty = state.ptys.get(ptyId);
    if (pty === undefined) {
      // First frame subscribes (empty payload = pure subscribe, same as the
      // Rust agent's empty-frame convention). Output pumps back per conn.
      pty = this.options.sim.openPty(ptyId, (data) => {
        this.sendFrame(conn, channel, data);
      });
      state.ptys.set(ptyId, pty);
    }
    if (payload.byteLength > 0) {
      pty.write(payload.toString("utf8"));
    }
  }

  /* ------------------------------ plumbing ------------------------------ */

  private sendFrame(conn: string, channel: string, payload: Uint8Array | string): void {
    const ws = this.ws;
    if (ws === null || !this.conns.has(conn)) return;
    ws.send(Buffer.concat([Buffer.from(conn, "ascii"), encodeFrame(channel, payload)]));
  }

  private teardownConn(conn: string): void {
    const state = this.conns.get(conn);
    if (state === undefined) return;
    this.conns.delete(conn);
    for (const pty of state.ptys.values()) pty.close();
    state.unsubCtlEvents();
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
