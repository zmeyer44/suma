/**
 * RelayAgentClient — the AgentLink an AWAY device uses in local compute
 * mode: one WebSocket to the control plane's relay (`/v1/relay/agent`),
 * piped to the home Mac's in-app agent bridge.
 *
 * Unlike TcpAgentClient (one TCP socket per channel), every channel rides
 * this ONE socket — mux frames name their channel, so the wire needs no
 * more. Each binary WS message carries whole frames (encodeFrame bytes);
 * a FrameDecoder still guards against coalescing.
 *
 * FIFO discipline is inherited wholesale: ctl responses match the pending
 * head by expected type (CTL_RESPONSE_TYPE — shared with TcpAgentClient),
 * everything else fans out as an event; vfs responses pop their queue in
 * order, and any vfs desync hard-resets the WHOLE socket — there is no
 * per-channel socket to sacrifice here.
 *
 * Close codes from the relay:
 *   4404  home Mac offline — retry on a slow fixed cadence; `nudge()` (from
 *         the /v1/machine poll seeing homeOnline flip) retries immediately.
 *   4000  replaced (home side only — never seen here in practice).
 *   1008  this device was revoked — keep the slow cadence; the next auth
 *         refresh either heals it or signs the account out.
 */

import type { Duplex } from "node:stream";
import { clearTimeout, setTimeout } from "node:timers";
import {
  LOCAL_HOME_ROOT,
  parseCtlResponse,
  parseVfsResponse,
  type AgentCtlRequest,
  type AgentCtlResponse,
  type VfsRequest,
  type VfsResponse,
} from "@suma/protocol";
import WebSocket from "ws";
import {
  CTL_RESPONSE_TYPE,
  encodeFrame,
  FrameDecoder,
  type AgentLink,
  type PtyChannel,
} from "./agent-client";

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Home offline: a fixed, patient cadence — homeOnline flips nudge() anyway. */
const HOME_OFFLINE_RETRY_MS = 15_000;
/** Upgrade refused (401/403/409): token refresh or role change heals it. */
const REJECTED_RETRY_MS = 30_000;

export const CLOSE_HOME_OFFLINE = 4404;

interface PendingCtl {
  expected: AgentCtlResponse["t"];
  resolve: (response: AgentCtlResponse) => void;
  reject: (err: Error) => void;
}

export interface RelayClientOptions {
  /** Control plane base ("http://127.0.0.1:8790" or https) — ws(s) derived. */
  controlUrl: string;
  /** Current device token; re-read on every dial so refreshes heal auth. */
  token: () => Promise<string | null>;
  /** Test seam (voice/tts-realtime.ts pattern). */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
}

export class RelayAgentClient implements AgentLink {
  readonly kind = "remote" as const;

  private ws: WebSocket | null = null;
  private up = false;
  private stopped = false;
  private backoffMs = BACKOFF_START_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly pendingCtl: PendingCtl[] = [];
  private readonly pendingVfs: Array<{
    resolve: (response: VfsResponse) => void;
    reject: (err: Error) => void;
  }> = [];
  private readonly ptyListeners = new Map<string, Set<(data: Buffer) => void>>();
  private readonly connectionListeners = new Set<(up: boolean) => void>();
  private readonly ctlEventListeners = new Set<(event: AgentCtlResponse) => void>();

  constructor(private readonly options: RelayClientOptions) {
    void this.connect();
  }

  connected(): boolean {
    return this.up;
  }

  onConnectionChanged(listener: (up: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  onCtlEvent(listener: (event: AgentCtlResponse) => void): () => void {
    this.ctlEventListeners.add(listener);
    return () => this.ctlEventListeners.delete(listener);
  }

  async ctl(request: AgentCtlRequest): Promise<AgentCtlResponse | null> {
    const ws = this.requireUp();
    const expected = CTL_RESPONSE_TYPE[request.t];
    ws.send(encodeFrame("ctl", JSON.stringify(request)));
    if (expected === undefined) return null;
    return new Promise<AgentCtlResponse>((resolve, reject) => {
      this.pendingCtl.push({ expected, resolve, reject });
    });
  }

  async vfs(request: VfsRequest): Promise<VfsResponse> {
    const ws = this.requireUp();
    ws.send(encodeFrame("vfs", JSON.stringify(request)));
    return new Promise<VfsResponse>((resolve, reject) => {
      this.pendingVfs.push({ resolve, reject });
    });
  }

  vfsRootLabel(): string {
    return LOCAL_HOME_ROOT;
  }

  openPty(ptyId: string, onData: (data: Buffer) => void): PtyChannel {
    const channel = `pty/${ptyId}`;
    let listeners = this.ptyListeners.get(channel);
    if (listeners === undefined) {
      listeners = new Set();
      this.ptyListeners.set(channel, listeners);
    }
    listeners.add(onData);
    // Announce with an empty frame — the bridge subscribes this conn to the
    // pty's output on it, exactly like the Rust agent's per-channel socket.
    if (this.up && this.ws !== null) {
      this.ws.send(encodeFrame(channel, Buffer.alloc(0)));
    }
    return {
      write: (data) => {
        if (this.up && this.ws !== null && data.length > 0) {
          this.ws.send(encodeFrame(channel, data));
        }
      },
      // Local unsubscribe only: the mux has no unsubscribe frame. The bridge
      // keeps pumping until this conn closes — bounded and known (plan R4).
      close: () => {
        listeners.delete(onData);
      },
    };
  }

  forward(_port: number, socket: Duplex): void {
    // fwd/<port> is not relayed in this phase — matching the Rust agent,
    // where the channel is parsed but unwired. Honest failure over silence.
    socket.destroy(new Error("port forwarding is not available over the relay yet"));
  }

  /** homeOnline flipped true — skip the backoff and dial now. */
  nudge(): void {
    if (this.stopped || this.up) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.backoffMs = BACKOFF_START_MS;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close(1000);
    this.ws = null;
    this.setUp(false);
    this.failAll(new Error("relay client stopped"));
  }

  /* ------------------------------ internals ------------------------------ */

  private requireUp(): WebSocket {
    if (this.stopped || !this.up || this.ws === null) {
      throw new Error("your computer is unreachable right now — reconnecting");
    }
    return this.ws;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.ws !== null) return;
    let token: string | null = null;
    try {
      token = await this.options.token();
    } catch {
      token = null;
    }
    if (this.stopped) return;
    if (token === null) {
      this.scheduleReconnect(REJECTED_RETRY_MS);
      return;
    }
    const url = `${this.options.controlUrl.replace(/^http/, "ws")}/v1/relay/agent`;
    const factory =
      this.options.wsFactory ??
      ((wsUrl: string, headers: Record<string, string>) => new WebSocket(wsUrl, { headers }));
    let ws: WebSocket;
    try {
      ws = factory(url, { authorization: `Bearer ${token}` });
    } catch {
      this.scheduleReconnect(this.nextBackoff());
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.backoffMs = BACKOFF_START_MS;
      this.setUp(true);
    });
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.ws !== ws || !isBinary) return;
      this.onBytes(toBuffer(data));
    });
    ws.on("unexpected-response", (_req, res) => {
      // 401/403/409 pre-upgrade — the socket never opens.
      if (this.ws === ws) {
        this.ws = null;
        this.scheduleReconnect(
          res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 409
            ? REJECTED_RETRY_MS
            : this.nextBackoff(),
        );
      }
      ws.terminate();
    });
    ws.on("error", () => {
      // close follows; nothing to do here beyond preventing an unhandled
      // error event from killing the process.
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setUp(false);
      this.failAll(new Error("relay connection lost"));
      if (this.stopped) return;
      this.scheduleReconnect(
        code === CLOSE_HOME_OFFLINE ? HOME_OFFLINE_RETRY_MS : this.nextBackoff(),
      );
    });
  }

  private onBytes(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.resetSocket("undecodable relay frame");
      return;
    }
    for (const frame of frames) {
      if (frame.channel === "ctl") {
        this.onCtlFrame(frame.payload);
      } else if (frame.channel === "vfs") {
        this.onVfsFrame(frame.payload);
      } else if (frame.channel.startsWith("pty/")) {
        const listeners = this.ptyListeners.get(frame.channel);
        if (listeners !== undefined) {
          for (const listener of listeners) listener(frame.payload);
        }
      }
      // Unknown channels: dropped, matching TcpAgentClient's per-socket rule.
    }
  }

  private onCtlFrame(payload: Buffer): void {
    let response: AgentCtlResponse;
    try {
      response = parseCtlResponse(payload.toString("utf8"));
    } catch {
      return; // unknown/garbled frame — never crash the session over it
    }
    const head = this.pendingCtl[0];
    if (head !== undefined && response.t === head.expected) {
      this.pendingCtl.shift();
      head.resolve(response);
      return;
    }
    if (head !== undefined && response.t === "error") {
      this.pendingCtl.shift();
      head.resolve(response);
      return;
    }
    for (const listener of this.ctlEventListeners) listener(response);
  }

  private onVfsFrame(payload: Buffer): void {
    const head = this.pendingVfs.shift();
    if (head === undefined) {
      this.resetSocket("vfs frame with nothing pending");
      return;
    }
    let response: VfsResponse;
    try {
      response = parseVfsResponse(payload.toString("utf8"));
    } catch {
      head.reject(new Error("unparseable vfs response — relay reset"));
      this.resetSocket("unparseable vfs response");
      return;
    }
    head.resolve(response);
  }

  /** A desync is unrecoverable by inspection — drop the socket, reject all,
   *  reconnect. (One socket carries everything, so everything resets.) */
  private resetSocket(_reason: string): void {
    const ws = this.ws;
    this.ws = null;
    this.setUp(false);
    this.failAll(new Error("relay connection reset"));
    ws?.terminate();
    if (!this.stopped) this.scheduleReconnect(this.nextBackoff());
  }

  private failAll(err: Error): void {
    for (const pending of this.pendingCtl.splice(0)) pending.reject(err);
    for (const pending of this.pendingVfs.splice(0)) pending.reject(err);
  }

  private setUp(up: boolean): void {
    if (this.up === up) return;
    this.up = up;
    for (const listener of this.connectionListeners) listener(up);
  }

  private nextBackoff(): number {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    return delay;
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delayMs);
    this.retryTimer.unref();
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
