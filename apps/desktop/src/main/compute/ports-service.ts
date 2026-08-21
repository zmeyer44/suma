/**
 * PortsService — the ports:* IPC surface (PRD §8.5 port-forwarding chips).
 * Polls the agent's ports.list, maps to PortForwardInfo, and implements
 * ports:forward. With the remote agent a forward is a local TCP listener on
 * the same port proxying each connection over the agent's fwd/<port> channel;
 * with the simulated agent the listener would collide with the very process
 * it forwards (the "VM" is this Mac), so the toggle only marks the port
 * forwarded — localhost already reaches it directly.
 *
 * Forwards are refused rather than silently unsafe (see `forwardRefusal`):
 * ports another Suma plane owns on 127.0.0.1 are never handed to the
 * compute plane (PRD §9 I-3), and neither are listeners the agent reports as
 * bound beyond loopback. The refusal is thrown so the ports:forward IPC
 * handler surfaces it to the user.
 */

import net from "node:net";
import { clearInterval, setInterval } from "node:timers";
import type { ListeningPort } from "@suma/protocol";
import type { PortForwardInfo } from "../../shared/ipc";
import type { AgentLink } from "./agent-client";
import { forwardRefusal, presentPorts, type PortState } from "./ports-state";

const POLL_MS = 4_000;

export interface PortsDeps {
  link: AgentLink;
  emit: (ports: PortForwardInfo[]) => void;
}

/** A live forward: its listener plus the sockets it has accepted, so
 *  disabling the forward can sever connections in flight (server.close()
 *  stops accepting but leaves piped sockets alive). Null server = a
 *  simulated-agent marker forward (no listener). */
interface Forward {
  server: net.Server | null;
  sockets: Set<net.Socket>;
}

export class PortsService {
  private readonly forwards = new Map<number, Forward>();
  private readonly pendingEnsures = new Map<number, Promise<boolean>>();
  private readonly ensureMisses = new Map<number, number>();
  private latest: ListeningPort[] = [];
  private lastEmitted = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PortsDeps) {}

  list(): PortForwardInfo[] {
    // The `loopback` flag is main-process-only — the shared IPC PortForwardInfo
    // has no field for it, so it is dropped here rather than shipped as an
    // undeclared extra property.
    return this.states().map((state) => ({
      port: state.port,
      process: state.process,
      forwarded: state.forwarded,
      localUrl: state.localUrl,
    }));
  }

  /** A fresh listener list right now (the assistant's list_ports): one poll
   *  instead of waiting out the 4 s interval, then the same view list()
   *  serves. Poll failures keep the last-known list, like the interval. */
  async refresh(): Promise<PortForwardInfo[]> {
    await this.poll();
    return this.list();
  }

  async setForward(port: number, enabled: boolean): Promise<PortForwardInfo> {
    const active = this.forwards.has(port);
    if (enabled && !active) {
      const refusal = forwardRefusal(
        port,
        this.states().find((state) => state.port === port),
      );
      if (refusal !== null) throw new Error(refusal);
      if (this.deps.link.kind === "simulated") {
        this.forwards.set(port, { server: null, sockets: new Set() });
      } else {
        this.forwards.set(port, await this.listen(port));
      }
    } else if (!enabled && active) {
      this.closeForward(port);
    }
    this.push(true);
    const info = this.list().find((p) => p.port === port);
    return (
      info ?? {
        port,
        process: "",
        forwarded: this.forwards.has(port),
        localUrl: `http://localhost:${port}`,
      }
    );
  }

  /**
   * Idempotently forward a VM port because the browser is navigating to
   * localhost:<port>. Unlike setForward this never throws: navigation must
   * fall through to Chromium's own connection error, not a forward refusal.
   * Only ports the agent reports as listening are bound — an arbitrary web
   * page fetching http://localhost:<n> must not be able to make Suma open
   * local listeners for ports nothing in the machine serves.
   */
  async ensureForward(port: number): Promise<boolean> {
    if (this.forwards.has(port)) return true;
    // With the simulated agent localhost already IS the workload's host.
    if (this.deps.link.kind === "simulated") return false;
    const pending = this.pendingEnsures.get(port);
    if (pending !== undefined) return pending;
    const attempt = this.tryEnsure(port).finally(() =>
      this.pendingEnsures.delete(port),
    );
    this.pendingEnsures.set(port, attempt);
    return attempt;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const port of [...this.forwards.keys()]) this.closeForward(port);
  }

  /* ------------------------------ internals ------------------------------ */

  /** Stop accepting AND sever every live connection — `server.close()` alone
   *  leaves already-piped sockets running, so a disabled forward would keep
   *  proxying traffic until each side happened to close. */
  private closeForward(port: number): void {
    const forward = this.forwards.get(port);
    if (forward === undefined) return;
    this.forwards.delete(port);
    forward.server?.close();
    for (const socket of forward.sockets) socket.destroy();
  }

  /** The full port list, `loopback` flag included — never leaves main. */
  private states(): PortState[] {
    return presentPorts(this.latest, new Set(this.forwards.keys()));
  }

  private async tryEnsure(port: number): Promise<boolean> {
    // A manual ports:forward toggle may have won while this was queued.
    if (this.forwards.has(port)) return true;
    const find = (): PortState | undefined =>
      this.states().find((state) => state.port === port);
    let state = find();
    if (state === undefined) {
      // The dev server may have started after the last 4s poll — refresh once
      // per poll interval, so a page hammering an unserved localhost port
      // cannot turn every asset request into a ports.list round trip.
      const missedAt = this.ensureMisses.get(port);
      if (missedAt !== undefined && Date.now() - missedAt < POLL_MS)
        return false;
      await this.poll();
      state = find();
      if (state === undefined) {
        this.ensureMisses.set(port, Date.now());
        return false;
      }
    }
    this.ensureMisses.delete(port);
    if (forwardRefusal(port, state) !== null) return false;
    try {
      this.forwards.set(port, await this.listen(port));
    } catch {
      // Most likely a genuinely local server already owns the port; it is
      // exactly what the loopback navigation should reach, so let it win.
      return false;
    }
    this.push(true);
    return true;
  }

  private async poll(): Promise<void> {
    let response;
    try {
      response = await this.deps.link.ctl({ t: "ports.list" });
    } catch {
      return; // agent unreachable — keep the last-known list
    }
    if (response?.t !== "ports") return;
    this.latest = response.ports;
    this.push(false);
  }

  private listen(port: number): Promise<Forward> {
    return new Promise((resolve, reject) => {
      const forward: Forward = { server: null, sockets: new Set() };
      const server = net.createServer((socket) => {
        forward.sockets.add(socket);
        socket.on("close", () => forward.sockets.delete(socket));
        this.deps.link.forward(port, socket);
      });
      server.once("error", (err) => {
        reject(
          new Error(`could not listen on localhost:${port} — ${err.message}. Is something already using it?`),
        );
      });
      server.listen(port, "127.0.0.1", () => {
        forward.server = server;
        resolve(forward);
      });
    });
  }

  private push(force: boolean): void {
    const ports = this.list();
    const encoded = JSON.stringify(ports);
    if (!force && encoded === this.lastEmitted) return;
    this.lastEmitted = encoded;
    this.deps.emit(ports);
  }
}
