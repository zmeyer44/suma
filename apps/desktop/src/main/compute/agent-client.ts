/**
 * Client for suma-agent's mux protocol (PRD Appendix C, §8.5).
 *
 * Product path: sumad holds one QUIC connection to the agent and each mux
 * channel (`ctl`, `pty/<id>`, `fwd/<port>`, `vfs`, `log` — @suma/protocol
 * agent.ts) is its own stream. This TCP client is the wire stand-in until the
 * QUIC daemon lands: one TCP connection per channel, and every frame — not
 * just the first — names the channel it belongs to, exactly as the agent
 * decodes it (agent/src/mux.rs, mirrored by sidecar/src/agent_client.rs):
 *
 *   frame := u32 total ‖ u16 channel_len ‖ channel ‖ payload   (big-endian)
 *   total  = 2 + channel_len + payload_len   (the u32 itself is not counted)
 *
 * The agent routes every frame by its own channel name, so one connection per
 * channel remains valid — it simply carries frames that all name the same
 * channel. On `ctl`, each frame carries exactly one JSON AgentCtlRequest
 * (client→agent) or AgentCtlResponse (agent→client); on `pty/<id>` and
 * `fwd/<port>` frames carry raw bytes. The ctl connection reconnects with
 * exponential backoff.
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";
import { parseCtlResponse, type AgentCtlRequest, type AgentCtlResponse } from "@suma/protocol";

/* ------------------------------------------------------------------ *
 * Framing (pure, unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Ceiling on a single frame — a corrupt length prefix must not OOM us. Mirrors
 * MAX_FRAME_LEN in agent/src/mux.rs and bounds the same quantity the agent
 * bounds: `total` (channel length prefix + channel + payload), not the payload
 * alone. Encoding above it would produce a frame the agent refuses to read.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** The u16 channel-length prefix — also the smallest legal `total`. */
const CHANNEL_LEN_BYTES = 2;

/** Longest channel name the u16 length prefix can describe. */
const MAX_CHANNEL_BYTES = 0xffff;

export interface AgentFrame {
  /** Wire channel name: "ctl" | "pty/<id>" | "fwd/<port>" | "vfs" | "log". */
  channel: string;
  payload: Buffer;
}

export function encodeFrame(channel: string, payload: Uint8Array | string): Buffer {
  const name = Buffer.from(channel, "utf8");
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  if (name.byteLength > MAX_CHANNEL_BYTES) {
    throw new Error(`channel name of ${name.byteLength} bytes exceeds the u16 length prefix`);
  }
  const total = CHANNEL_LEN_BYTES + name.byteLength + body.byteLength;
  if (total > MAX_FRAME_BYTES) {
    throw new Error(`frame of ${total} bytes exceeds the ${MAX_FRAME_BYTES} cap`);
  }
  const frame = Buffer.allocUnsafe(4 + total);
  frame.writeUInt32BE(total, 0);
  frame.writeUInt16BE(name.byteLength, 4);
  name.copy(frame, 4 + CHANNEL_LEN_BYTES);
  body.copy(frame, 4 + CHANNEL_LEN_BYTES + name.byteLength);
  return frame;
}

/** Rejects the same malformed channel names the agent rejects. */
const channelUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Incremental frame decoder; push() returns every completed frame. */
export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): AgentFrame[] {
    this.buffered = this.buffered.byteLength === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const frames: AgentFrame[] = [];
    while (this.buffered.byteLength >= 4) {
      const total = this.buffered.readUInt32BE(0);
      if (total < CHANNEL_LEN_BYTES || total > MAX_FRAME_BYTES) {
        throw new Error(`frame length ${total} out of bounds`);
      }
      if (this.buffered.byteLength < 4 + total) break;
      const body = this.buffered.subarray(4, 4 + total);
      const channelLen = body.readUInt16BE(0);
      if (CHANNEL_LEN_BYTES + channelLen > total) {
        throw new Error(`channel length ${channelLen} exceeds the ${total}-byte frame`);
      }
      frames.push({
        channel: decodeChannel(body.subarray(CHANNEL_LEN_BYTES, CHANNEL_LEN_BYTES + channelLen)),
        payload: body.subarray(CHANNEL_LEN_BYTES + channelLen),
      });
      this.buffered = this.buffered.subarray(4 + total);
    }
    return frames;
  }
}

function decodeChannel(bytes: Buffer): string {
  try {
    return channelUtf8.decode(bytes);
  } catch {
    throw new Error("channel name is not valid UTF-8");
  }
}

/* ------------------------------------------------------------------ *
 * The link interface (implemented by TcpAgentClient and SimAgent)
 * ------------------------------------------------------------------ */

export interface PtyChannel {
  write(data: string): void;
  close(): void;
}

export interface AgentLink {
  readonly kind: "remote" | "simulated";
  connected(): boolean;
  onConnectionChanged(listener: (up: boolean) => void): () => void;
  /**
   * One ctl request/response exchange. Resolves null for the fire-and-forget
   * operations (pty.resize, pty.kill) that have no response frame. Protocol
   * errors come back as the `error` response — callers decide what throws.
   */
  ctl(request: AgentCtlRequest): Promise<AgentCtlResponse | null>;
  /** Unsolicited ctl events (pty.exited, fetch.progress …). */
  onCtlEvent(listener: (event: AgentCtlResponse) => void): () => void;
  /** Open the pty byte channel; agent output (and attach replay) hits onData. */
  openPty(ptyId: string, onData: (data: Buffer) => void): PtyChannel;
  /** Pipe one local socket over the agent's fwd/<port> channel. */
  forward(port: number, socket: Duplex): void;
  stop(): void;
}

/** The control channel's wire name (@suma/protocol agent.ts `parseChannel`). */
const CTL_CHANNEL = "ctl";

/** Response frame type each ctl request awaits; absent ⇒ fire-and-forget. */
const CTL_RESPONSE_TYPE: Partial<Record<AgentCtlRequest["t"], AgentCtlResponse["t"]>> = {
  "pty.spawn": "pty.spawned",
  "pty.attach": "pty.attached",
  "pty.list": "pty.listing",
  "job.set": "job.ack",
  "ports.list": "ports",
  "fetch.public": "fetch.done",
};

interface PendingCtl {
  expected: AgentCtlResponse["t"];
  resolve: (response: AgentCtlResponse) => void;
  reject: (err: Error) => void;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function parseAgentUrl(url: string): { host: string; port: number } {
  const stripped = url.replace(/^tcp:\/\//, "");
  const colon = stripped.lastIndexOf(":");
  const port = colon >= 0 ? Number.parseInt(stripped.slice(colon + 1), 10) : Number.NaN;
  if (colon < 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SUMA_AGENT_URL must look like tcp://host:port (got "${url}")`);
  }
  return { host: stripped.slice(0, colon), port };
}

export class TcpAgentClient implements AgentLink {
  readonly kind = "remote" as const;

  private readonly host: string;
  private readonly port: number;
  private ctlSocket: net.Socket | null = null;
  private up = false;
  private backoffMs = BACKOFF_START_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly pending: PendingCtl[] = [];
  private readonly connectionListeners = new Set<(up: boolean) => void>();
  private readonly ctlEventListeners = new Set<(event: AgentCtlResponse) => void>();

  constructor(url: string) {
    const { host, port } = parseAgentUrl(url);
    this.host = host;
    this.port = port;
    this.connectCtl();
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
    const socket = this.ctlSocket;
    if (!this.up || socket === null) {
      throw new Error("suma-agent unreachable — the machine may be waking or offline");
    }
    const expected = CTL_RESPONSE_TYPE[request.t];
    socket.write(encodeFrame(CTL_CHANNEL, JSON.stringify(request)));
    if (expected === undefined) return null;
    return new Promise<AgentCtlResponse>((resolve, reject) => {
      this.pending.push({ expected, resolve, reject });
    });
  }

  openPty(ptyId: string, onData: (data: Buffer) => void): PtyChannel {
    const channel = `pty/${ptyId}`;
    const socket = this.openChannel();
    // Announce the channel with an empty frame. One TCP connection per channel
    // means the agent cannot know this socket wants pty/<id> until a frame
    // names it, and waiting for the first keystroke would lose the shell's
    // prompt. An empty payload carries no input, so this only subscribes.
    socket.write(encodeFrame(channel, Buffer.alloc(0)));
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      let frames: AgentFrame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.channel === channel) onData(frame.payload);
      }
    });
    return {
      write: (data) => {
        if (!socket.destroyed) socket.write(encodeFrame(channel, data));
      },
      close: () => socket.destroy(),
    };
  }

  forward(port: number, local: Duplex): void {
    const channel = `fwd/${port}`;
    const socket = this.openChannel();
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      let frames: AgentFrame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.channel === channel) local.write(frame.payload);
      }
    });
    local.on("data", (chunk: Buffer) => {
      if (!socket.destroyed) socket.write(encodeFrame(channel, chunk));
    });
    const closeBoth = (): void => {
      socket.destroy();
      local.destroy();
    };
    socket.on("close", closeBoth);
    socket.on("error", closeBoth);
    local.on("close", closeBoth);
    local.on("error", closeBoth);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ctlSocket?.destroy();
    this.failPending(new Error("agent client stopped"));
  }

  /* ------------------------------ internals ------------------------------ */

  /**
   * A connection for one channel. There is no handshake frame: every frame
   * carries its own channel name, so the agent routes correctly from the
   * first byte.
   */
  private openChannel(): net.Socket {
    const socket = net.connect(this.port, this.host);
    socket.on("error", () => socket.destroy());
    return socket;
  }

  private connectCtl(): void {
    if (this.stopped) return;
    const socket = net.connect(this.port, this.host);
    this.ctlSocket = socket;
    const decoder = new FrameDecoder();
    socket.on("connect", () => {
      this.backoffMs = BACKOFF_START_MS;
      this.setUp(true);
    });
    socket.on("data", (chunk) => {
      let frames: AgentFrame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      // Frames for another channel are not ours to interpret — the pty/fwd
      // pumps own theirs (mirrors sidecar/src/agent_client.rs).
      for (const frame of frames) {
        if (frame.channel === CTL_CHANNEL) this.onCtlFrame(frame.payload);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.ctlSocket === socket) this.ctlSocket = null;
      this.setUp(false);
      this.failPending(new Error("suma-agent connection lost"));
      this.scheduleReconnect();
    });
  }

  private onCtlFrame(frame: Buffer): void {
    let response: AgentCtlResponse;
    try {
      response = parseCtlResponse(frame.toString("utf8"));
    } catch {
      return; // unknown/garbled frame — never crash the session over it
    }
    const head = this.pending[0];
    if (head !== undefined && response.t === head.expected) {
      this.pending.shift();
      head.resolve(response);
      return;
    }
    if (head !== undefined && response.t === "error") {
      this.pending.shift();
      head.resolve(response);
      return;
    }
    for (const listener of this.ctlEventListeners) listener(response);
  }

  private failPending(err: Error): void {
    for (const pending of this.pending.splice(0)) pending.reject(err);
  }

  private setUp(up: boolean): void {
    if (this.up === up) return;
    this.up = up;
    for (const listener of this.connectionListeners) listener(up);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connectCtl();
    }, this.backoffMs);
    this.retryTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }
}
