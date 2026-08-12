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

export class PortsService {
  /** Forwarded ports; the server is null for simulated-agent forwards. */
  private readonly forwards = new Map<number, net.Server | null>();
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

  async setForward(port: number, enabled: boolean): Promise<PortForwardInfo> {
    const active = this.forwards.has(port);
    if (enabled && !active) {
      const refusal = forwardRefusal(
        port,
        this.states().find((state) => state.port === port),
      );
      if (refusal !== null) throw new Error(refusal);
      if (this.deps.link.kind === "simulated") {
        this.forwards.set(port, null);
      } else {
        this.forwards.set(port, await this.listen(port));
      }
    } else if (!enabled && active) {
      this.forwards.get(port)?.close();
      this.forwards.delete(port);
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
    for (const server of this.forwards.values()) server?.close();
    this.forwards.clear();
  }

  /* ------------------------------ internals ------------------------------ */

  /** The full port list, `loopback` flag included — never leaves main. */
  private states(): PortState[] {
    return presentPorts(this.latest, new Set(this.forwards.keys()));
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

  private listen(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.deps.link.forward(port, socket));
      server.once("error", (err) => {
        reject(
          new Error(`could not listen on localhost:${port} — ${err.message}. Is something already using it?`),
        );
      });
      server.listen(port, "127.0.0.1", () => resolve(server));
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
