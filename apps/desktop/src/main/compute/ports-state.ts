/**
 * Pure port-list plumbing (PRD §8.5 port-forwarding chips): the agent's
 * `ports` ctl response → PortForwardInfo for the renderer, plus the lsof
 * parser the simulated agent uses to detect local listeners.
 */

import type { ListeningPort } from "@suma/protocol";
import type { PortForwardInfo } from "../../shared/ipc";
import { LOCAL_PROXY_PORT } from "../egress/egress-service";

/**
 * PortForwardInfo plus the agent's `loopback` ("safe to forward") flag. The
 * shared IPC type carries no field for it, so it stays inside the main
 * process: PortsService decides refusals with it and strips it before the
 * renderer ever sees a port list.
 */
export interface PortState extends PortForwardInfo {
  /** Agent-reported: the listener is bound to loopback only inside the VM. */
  loopback: boolean;
}

/**
 * Local ports another Suma plane owns on 127.0.0.1, and who owns them.
 * Forwarding one would bind it to the VM and hand the compute plane traffic
 * that belongs to a different plane: with sumad down, a workload listening
 * on the CONNECT proxy port would receive every proxied CONNECT the browser
 * makes — plane contamination the compute plane must never be able to cause
 * (PRD §9 I-3).
 */
export const RESERVED_LOCAL_PORTS: ReadonlyMap<number, string> = new Map([
  [LOCAL_PROXY_PORT, "sumad's local CONNECT proxy"],
]);

/**
 * Why this port may not be forwarded to this Mac, or null when it may be.
 * Pure: `listener` is the port's entry from the agent's list, absent when the
 * agent has not reported a listener on it.
 */
export function forwardRefusal(
  port: number,
  listener: { loopback: boolean } | undefined,
): string | null {
  const owner = RESERVED_LOCAL_PORTS.get(port);
  if (owner !== undefined) {
    return `Port ${port} is reserved on this Mac for ${owner}. Forwarding it would point the browser's proxied traffic into the machine, which would then see every site the browser connects to.`;
  }
  // A listener bound to 0.0.0.0 rather than loopback is NOT refused: dev
  // servers routinely bind every interface (`vite --host`, `next dev -H
  // 0.0.0.0`, any published Docker port), and it is the user's own machine
  // and their own port. The agent's `loopback` flag is a UI hint for a future
  // "already reachable inside the machine" note, not grounds to block a
  // workflow the target user depends on.
  void listener;
  return null;
}

export function presentPorts(
  ports: ReadonlyArray<ListeningPort>,
  forwarded: ReadonlySet<number>,
): PortState[] {
  return [...ports]
    .sort((a, b) => a.port - b.port)
    .map((port) => ({
      port: port.port,
      process: port.process,
      forwarded: forwarded.has(port.port),
      localUrl: `http://localhost:${port.port}`,
      loopback: port.loopback,
    }));
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN` output into ListeningPort entries.
 * One entry per port; a port bound on any non-loopback address reports
 * loopback: false (an already-exposed listener is not "safe to forward").
 */
export function parseLsofListeners(output: string): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const line of output.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 9) continue;
    const command = columns[0];
    const name = columns[8];
    if (command === undefined || name === undefined) continue;
    const colon = name.lastIndexOf(":");
    if (colon < 0) continue;
    const port = Number.parseInt(name.slice(colon + 1), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const host = name.slice(0, colon).toLowerCase();
    const loopback = host.startsWith("127.") || host === "[::1]" || host === "localhost";
    const existing = byPort.get(port);
    if (existing === undefined) {
      byPort.set(port, { port, process: command, loopback });
    } else if (!loopback) {
      existing.loopback = false;
    }
  }
  return [...byPort.values()];
}
