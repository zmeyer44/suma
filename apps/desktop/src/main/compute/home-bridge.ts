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

import net from "node:net";
import path from "node:path";
import os from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import {
  parseChannel,
  parseCtlRequest,
  parseVfsRequest,
  type AgentCtlRequest,
} from "@suma/protocol";
import WebSocket from "ws";
import { encodeFrame, FrameDecoder, type PtyChannel } from "./agent-client";
import { forwardRefusal } from "./ports-state";
import type { SimAgent } from "./sim-agent";

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const CONN_ID_BYTES = 8;

interface ConnState {
  decoder: FrameDecoder;
  /** ptyId → live channel into the sim, for teardown + input routing. */
  ptys: Map<string, PtyChannel>;
  /** fwd channel string → the loopback socket it dials on the home Mac. */
  fwds: Map<string, net.Socket>;
  unsubCtlEvents: () => void;
  /** Serializes ctl requests — the away client's pending queue is FIFO. */
  ctlTail: Promise<void>;
  /** Serializes this conn's vfs requests — order IS the correlation. */
  vfsTail: Promise<void>;
}

/** Per-conn forward-stream ceiling — a defensive cap on an away device
 *  opening unbounded loopback dials on the home Mac. */
const MAX_FWD_PER_CONN = 256;

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
        fwds: new Map(),
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
      } else if (frame.channel.startsWith("fwd/")) {
        this.handleFwd(conn, frame.channel, frame.payload);
      }
      // log: unwired, dropped — mirroring the Rust agent.
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

  /**
   * A port-forward frame. OPEN (empty, unknown stream) dials `127.0.0.1:port`
   * on THIS Mac; DATA is bytes; CLOSE (empty on a known stream) destroys it.
   * The home Mac is the trust boundary: an away device must not reach
   * reserved local ports (sumad's proxy), and cannot open unbounded dials.
   */
  private handleFwd(conn: string, channel: string, payload: Buffer): void {
    const state = this.conns.get(conn);
    if (state === undefined) return;
    const existing = state.fwds.get(channel);
    if (existing !== undefined) {
      if (payload.byteLength === 0) {
        // CLOSE from the away side: delete before destroy so the socket's
        // own close handler does not echo a CLOSE back.
        state.fwds.delete(channel);
        existing.destroy();
      } else {
        existing.write(payload);
      }
      return;
    }
    if (payload.byteLength > 0) return; // DATA racing a close — drop
    // OPEN. Parse the port; the relay grammar guarantees a stream id here.
    const parsed = parseChannel(channel);
    if (parsed === null || parsed.kind !== "fwd" || parsed.id === undefined) return;
    const port = parsed.port as number;
    // Refuse reserved local ports and enforce the per-conn cap: closing the
    // stream (empty frame) is the away client's dial-refused signal.
    if (forwardRefusal(port, undefined) !== null || state.fwds.size >= MAX_FWD_PER_CONN) {
      this.sendFrame(conn, channel, Buffer.alloc(0));
      return;
    }
    const socket = net.connect(port, "127.0.0.1");
    // Map-first: Node buffers pre-connect writes, so DATA racing the dial is
    // safe, and a close during connect still finds the entry to clean up.
    state.fwds.set(channel, socket);
    socket.on("data", (chunk: Buffer) => this.sendFrame(conn, channel, chunk));
    const closeStream = (): void => {
      // Doubles as the dial-refused path: connect errors surface as
      // 'error' then 'close'.
      if (state.fwds.delete(channel)) {
        this.sendFrame(conn, channel, Buffer.alloc(0));
      }
    };
    socket.on("close", closeStream);
    socket.on("error", closeStream);
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
    for (const socket of state.fwds.values()) socket.destroy();
    state.unsubCtlEvents();
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
