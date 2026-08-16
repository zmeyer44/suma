/**
 * SwitchableAgentLink — an AgentLink whose target can change at runtime.
 *
 * The desktop learns its VM's address from the control plane (`/v1/machine`
 * reports `agentAddress`, set by the sandbox provider at provision time),
 * and that answer arrives only after auth — long after the services holding
 * the link were constructed. This wrapper lets them hold one stable link
 * while the transport underneath is swapped from the local simulator to the
 * real agent the moment the address is known.
 *
 * `SUMA_AGENT_URL` remains the explicit override: a link constructed as
 * pinned never switches, so a dev pointing at `fly proxy` (or a test rig)
 * cannot be silently retargeted by a control-plane answer.
 *
 * Honest limitation: swapping drops whatever the old transport carried —
 * open pty channels die and are not re-opened here. The swap happens at
 * auth time, before real terminals exist; a mid-session swap surfaces as a
 * disconnect, which the terminal UI already knows how to show.
 */

import type { Duplex } from "node:stream";
import type { AgentCtlRequest, AgentCtlResponse, VfsRequest, VfsResponse } from "@suma/protocol";
import { TcpAgentClient, type AgentLink, type PtyChannel } from "./agent-client";

export class SwitchableAgentLink implements AgentLink {
  private inner: AgentLink;
  private targetUrl: string | null;
  private readonly connectionListeners = new Set<(up: boolean) => void>();
  private readonly ctlEventListeners = new Set<(event: AgentCtlResponse) => void>();
  private innerUnsubs: Array<() => void> = [];

  constructor(
    initial: AgentLink,
    /** URL the initial link dials, when it dials one (marks it pinned-capable). */
    initialUrl: string | null,
    /** True when initial came from SUMA_AGENT_URL — never retarget. */
    private readonly pinned: boolean,
  ) {
    this.inner = initial;
    this.targetUrl = initialUrl;
    this.wireInner();
  }

  get kind(): "remote" | "simulated" {
    return this.inner.kind;
  }

  /**
   * Point the link at a real agent (idempotent per URL). No-op when pinned
   * by SUMA_AGENT_URL or already targeting this URL.
   */
  setTarget(url: string): void {
    if (this.pinned || url === this.targetUrl) return;
    const previous = this.inner;
    for (const unsub of this.innerUnsubs.splice(0)) unsub();
    previous.stop();
    this.targetUrl = url;
    this.inner = new TcpAgentClient(url);
    this.wireInner();
    // The swap itself is a connectivity event: the new transport starts
    // down and announces itself when the socket opens.
    for (const listener of this.connectionListeners) listener(this.inner.connected());
  }

  connected(): boolean {
    return this.inner.connected();
  }

  onConnectionChanged(listener: (up: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  onCtlEvent(listener: (event: AgentCtlResponse) => void): () => void {
    this.ctlEventListeners.add(listener);
    return () => this.ctlEventListeners.delete(listener);
  }

  ctl(request: AgentCtlRequest): Promise<AgentCtlResponse | null> {
    return this.inner.ctl(request);
  }

  openPty(ptyId: string, onData: (data: Buffer) => void): PtyChannel {
    return this.inner.openPty(ptyId, onData);
  }

  forward(port: number, socket: Duplex): void {
    this.inner.forward(port, socket);
  }

  vfs(request: VfsRequest): Promise<VfsResponse> {
    return this.inner.vfs(request);
  }

  vfsRootLabel(): string {
    return this.inner.vfsRootLabel();
  }

  stop(): void {
    for (const unsub of this.innerUnsubs.splice(0)) unsub();
    this.inner.stop();
  }

  /* ------------------------------ internals ------------------------------ */

  private wireInner(): void {
    this.innerUnsubs.push(
      this.inner.onConnectionChanged((up) => {
        for (const listener of this.connectionListeners) listener(up);
      }),
      this.inner.onCtlEvent((event) => {
        for (const listener of this.ctlEventListeners) listener(event);
      }),
    );
  }
}
