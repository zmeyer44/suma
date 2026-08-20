/**
 * Cross-device session discovery (§8.5 M-2): a ptyId used to exist only in
 * the spawning desktop's memory, so a second device could never attach. These
 * tests pin the new leg: `pty.list` → TerminalService.discover adopts foreign
 * sessions → attach works on them; plus the SwitchableAgentLink swap that
 * points the desktop at the VM the control plane reports.
 */

import os from "node:os";
import { describe, expect, it } from "vitest";
import type { AgentCtlRequest, AgentCtlResponse } from "@suma/protocol";
import type { Duplex } from "node:stream";
import type { AgentLink, PtyChannel } from "../src/main/compute/agent-client";
import { SwitchableAgentLink } from "../src/main/compute/agent-link-switch";
import { TerminalService } from "../src/main/compute/terminal-service";
import { SimAgent } from "../src/main/compute/sim-agent";

/** Scriptable AgentLink: answers ctl by type, records requests. */
class FakeLink implements AgentLink {
  readonly kind = "remote" as const;
  readonly requests: AgentCtlRequest[] = [];
  readonly operations: string[] = [];
  readonly ctlEventListeners = new Set<(event: AgentCtlResponse) => void>();
  readonly connectionListeners = new Set<(up: boolean) => void>();
  up = true;
  answers: Partial<Record<AgentCtlRequest["t"], AgentCtlResponse>> = {};

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
  ctl(request: AgentCtlRequest): Promise<AgentCtlResponse | null> {
    this.requests.push(request);
    this.operations.push(`ctl:${request.t}`);
    if (!this.up) return Promise.reject(new Error("suma-agent unreachable"));
    return Promise.resolve(this.answers[request.t] ?? null);
  }
  openPty(ptyId: string, _onData: (data: Buffer) => void): PtyChannel {
    this.operations.push(`open:${ptyId}`);
    return { write: () => undefined, close: () => undefined };
  }
  forward(_port: number, _socket: Duplex): void {}
  async vfs(): Promise<never> {
    throw new Error("the fake link has no filesystem");
  }
  vfsRootLabel(): string {
    return "~/cloud";
  }
  stop(): void {}
}

function service(link: AgentLink): TerminalService {
  return new TerminalService({
    link,
    control: () => null,
    emitData: () => undefined,
    emitUpdated: () => undefined,
  });
}

describe("TerminalService.discover", () => {
  it("adopts sessions this device never created, and attach then works on them", async () => {
    const link = new FakeLink();
    link.answers["pty.list"] = {
      t: "pty.listing",
      sessions: [
        { ptyId: "other-device-1", cwd: "/root/project", command: "claude", live: true },
        { ptyId: "cold-boot-leftover", cwd: "/root", live: false },
      ],
    };
    link.answers["pty.attach"] = {
      t: "pty.attached",
      ptyId: "other-device-1",
      restore: "resumed",
      scrollbackBytes: 42,
      cwd: "/root/project",
    };

    const terminals = service(link);
    const list = await terminals.discover();

    expect(list.map((t) => t.ptyId).sort()).toEqual(["cold-boot-leftover", "other-device-1"]);
    const live = list.find((t) => t.ptyId === "other-device-1");
    expect(live).toMatchObject({ title: "claude", cwd: "/root/project", exited: false });
    const dead = list.find((t) => t.ptyId === "cold-boot-leftover");
    expect(dead?.exited).toBe(true);

    // The adopted session is attachable — the whole point of discovery.
    const attached = await terminals.attach("other-device-1");
    expect(attached.restore).toBe("resumed");
  });

  it("keeps local knowledge when re-discovering, marking dead sessions exited", async () => {
    const link = new FakeLink();
    link.answers["pty.spawn"] = { t: "pty.spawned", ptyId: "ignored" };
    const terminals = service(link);
    const created = await terminals.create("/tmp");

    link.answers["pty.list"] = {
      t: "pty.listing",
      sessions: [{ ptyId: created.ptyId, cwd: "/tmp/deeper", live: false }],
    };
    const list = await terminals.discover();
    expect(list).toHaveLength(1);
    // Existing record updated in place — title survives, liveness is honest.
    expect(list[0]).toMatchObject({ title: created.title, cwd: "/tmp/deeper", exited: true });
  });

  it("clears an exited marker when tmux discovery reports the shell live again", async () => {
    const link = new FakeLink();
    link.answers["pty.list"] = {
      t: "pty.listing",
      sessions: [{ ptyId: "tmux-shell", cwd: "/root/project", live: false }],
    };
    const terminals = service(link);
    expect((await terminals.discover())[0]?.exited).toBe(true);

    link.answers["pty.list"] = {
      t: "pty.listing",
      sessions: [{ ptyId: "tmux-shell", cwd: "/root/project", live: true }],
    };
    expect((await terminals.discover())[0]).toMatchObject({
      ptyId: "tmux-shell",
      exited: false,
    });
  });

  it("asks the agent to resume tmux before opening the replay channel", async () => {
    const link = new FakeLink();
    link.answers["pty.list"] = {
      t: "pty.listing",
      sessions: [{ ptyId: "tmux-shell", cwd: "/root/project", live: false }],
    };
    link.answers["pty.attach"] = {
      t: "pty.attached",
      ptyId: "tmux-shell",
      restore: "resumed",
      scrollbackBytes: 42,
      cwd: "/root/project",
    };
    const terminals = service(link);
    await terminals.discover();
    link.operations.length = 0;

    const attached = await terminals.attach("tmux-shell");

    expect(link.operations).toEqual(["ctl:pty.attach", "open:tmux-shell"]);
    expect(attached).toMatchObject({ restore: "resumed", exited: false });
  });

  it("returns the local list when the agent is unreachable", async () => {
    const link = new FakeLink();
    link.up = false;
    const terminals = service(link);
    await expect(terminals.discover()).resolves.toEqual([]);
  });
});

describe("SimAgent pty.list", () => {
  it("mirrors the Rust agent's listing contract", async () => {
    // Explicit temp root: the default is ~/Suma, and a unit test must not
    // plant product folders on the machine running it.
    const sim = new SimAgent({ root: () => os.tmpdir() });
    const spawned = await sim.ctl({ t: "pty.spawn", ptyId: "sim-1", cols: 80, rows: 24 });
    expect(spawned?.t).toBe("pty.spawned");
    const listing = await sim.ctl({ t: "pty.list" });
    if (listing?.t !== "pty.listing") throw new Error(`wrong response: ${listing?.t}`);
    expect(listing.sessions).toHaveLength(1);
    expect(listing.sessions[0]).toMatchObject({ ptyId: "sim-1", live: true });
    sim.stop();
  });
});

describe("SwitchableAgentLink", () => {
  it("forwards events from the inner link and reports its kind", () => {
    const inner = new FakeLink();
    const link = new SwitchableAgentLink(inner, null, false);
    const events: AgentCtlResponse[] = [];
    const ups: boolean[] = [];
    link.onCtlEvent((e) => events.push(e));
    link.onConnectionChanged((up) => ups.push(up));

    for (const listener of inner.ctlEventListeners) {
      listener({ t: "pty.exited", ptyId: "x", code: 0 });
    }
    for (const listener of inner.connectionListeners) listener(false);

    expect(link.kind).toBe("remote");
    expect(events).toEqual([{ t: "pty.exited", ptyId: "x", code: 0 }]);
    expect(ups).toEqual([false]);
  });

  it("never retargets when pinned by SUMA_AGENT_URL", () => {
    const inner = new FakeLink();
    const link = new SwitchableAgentLink(inner, "tcp://pinned:2222", true);
    link.setTarget("tcp://other:2222");
    expect(link.connected()).toBe(true); // still the fake — a real client starts down
    link.stop();
  });

  it("swaps to a TCP client for a new target and tells listeners", () => {
    const inner = new FakeLink();
    const link = new SwitchableAgentLink(inner, null, false);
    const ups: boolean[] = [];
    link.onConnectionChanged((up) => ups.push(up));

    link.setTarget("tcp://127.0.0.1:1");
    expect(link.connected()).toBe(false); // socket not up yet (and never will be)
    expect(ups).toEqual([false]);
    // Old inner's listeners were released — its events no longer propagate.
    for (const listener of inner.connectionListeners) listener(true);
    expect(ups).toEqual([false]);

    // Same URL again is a no-op; a different one would re-dial.
    link.setTarget("tcp://127.0.0.1:1");
    link.stop();
  });
});
