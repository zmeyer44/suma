import { describe, expect, it } from "vitest";
import type { AgentCtlRequest, AgentCtlResponse, ListeningPort } from "@suma/protocol";
import type { PortForwardInfo } from "../src/shared/ipc";
import type { AgentLink, PtyChannel } from "../src/main/compute/agent-client";
import { PortsService } from "../src/main/compute/ports-service";
import {
  forwardRefusal,
  parseLsofListeners,
  presentPorts,
  RESERVED_LOCAL_PORTS,
} from "../src/main/compute/ports-state";
import { LOCAL_PROXY_PORT } from "../src/main/egress/egress-service";

describe("presentPorts", () => {
  it("maps listeners to sorted PortForwardInfo with localhost URLs", () => {
    const infos = presentPorts(
      [
        { port: 8080, process: "python3", loopback: false },
        { port: 3000, process: "node", loopback: true },
      ],
      new Set([3000]),
    );
    expect(infos).toEqual([
      {
        port: 3000,
        process: "node",
        forwarded: true,
        localUrl: "http://localhost:3000",
        loopback: true,
      },
      {
        port: 8080,
        process: "python3",
        forwarded: false,
        localUrl: "http://localhost:8080",
        loopback: false,
      },
    ]);
  });

  it("reflects the forwarded set only", () => {
    const infos = presentPorts([{ port: 5173, process: "vite", loopback: true }], new Set());
    expect(infos[0]?.forwarded).toBe(false);
  });

  it("carries the agent's loopback flag through unchanged", () => {
    const infos = presentPorts(
      [
        { port: 3000, process: "node", loopback: true },
        { port: 8080, process: "python3", loopback: false },
      ],
      new Set(),
    );
    expect(infos.map((p) => p.loopback)).toEqual([true, false]);
  });
});

describe("forwardRefusal (PRD §9 I-3 — no browser-plane port reaches compute)", () => {
  it("reserves sumad's local CONNECT proxy port", () => {
    expect(RESERVED_LOCAL_PORTS.has(LOCAL_PROXY_PORT)).toBe(true);
    const reason = forwardRefusal(LOCAL_PROXY_PORT, { loopback: true });
    expect(reason).toContain(`Port ${LOCAL_PROXY_PORT}`);
    expect(reason).toMatch(/reserved/i);
  });

  it("refuses a reserved port however the agent reports it", () => {
    for (const listener of [undefined, { loopback: true }, { loopback: false }]) {
      expect(forwardRefusal(LOCAL_PROXY_PORT, listener)).not.toBeNull();
    }
  });

  it("allows an ordinary loopback listener, and unknown ports", () => {
    expect(forwardRefusal(3000, { loopback: true })).toBeNull();
    expect(forwardRefusal(3000, undefined)).toBeNull();
  });

  it("allows a listener bound beyond loopback — dev servers routinely do", () => {
    // `vite --host`, `next dev -H 0.0.0.0` and published Docker ports all bind
    // every interface. It is the user's own machine and their own port; only
    // reserved local ports are a security question.
    expect(forwardRefusal(8080, { loopback: false })).toBeNull();
  });
});

describe("PortsService forward refusal and flag plumbing", () => {
  /**
   * In-process stand-in for the agent link. `kind: "simulated"` keeps
   * setForward off the real net.Server path, so these stay pure — a refused
   * forward must never get as far as binding anything either way.
   */
  class StubLink implements AgentLink {
    readonly kind = "simulated" as const;

    constructor(private readonly ports: ListeningPort[]) {}

    connected(): boolean {
      return true;
    }
    onConnectionChanged(): () => void {
      return () => undefined;
    }
    onCtlEvent(): () => void {
      return () => undefined;
    }
    async ctl(request: AgentCtlRequest): Promise<AgentCtlResponse | null> {
      return request.t === "ports.list" ? { t: "ports", ports: this.ports } : null;
    }
    openPty(): PtyChannel {
      return { write: () => undefined, close: () => undefined };
    }
    forward(): void {
      throw new Error("the stub link never forwards");
    }
    async vfs(): Promise<never> {
      throw new Error("the stub link has no filesystem");
    }
    vfsRootLabel(): string {
      return "/stub";
    }
    stop(): void {
      /* nothing to stop */
    }
  }

  /** A service that has polled the stub agent once, with its timer stopped. */
  async function polledService(ports: ListeningPort[]): Promise<{
    service: PortsService;
    emitted: PortForwardInfo[][];
  }> {
    const emitted: PortForwardInfo[][] = [];
    const service = new PortsService({
      link: new StubLink(ports),
      emit: (list) => emitted.push(list),
    });
    service.start();
    await new Promise((resolve) => setImmediate(resolve));
    service.stop(); // clears the poll timer; the polled list is retained
    return { service, emitted };
  }

  it("never emits the main-process-only loopback flag to the renderer", async () => {
    const { emitted } = await polledService([{ port: 3000, process: "node", loopback: true }]);
    expect(emitted.at(-1)).toEqual([
      { port: 3000, process: "node", forwarded: false, localUrl: "http://localhost:3000" },
    ]);
  });

  it("refuses to forward sumad's proxy port and binds nothing", async () => {
    const { service } = await polledService([
      { port: LOCAL_PROXY_PORT, process: "sneaky-workload", loopback: true },
    ]);
    await expect(service.setForward(LOCAL_PROXY_PORT, true)).rejects.toThrow(/reserved/i);
    expect(service.list().find((p) => p.port === LOCAL_PROXY_PORT)?.forwarded).toBe(false);
  });

  it("refuses an unreported port that is reserved", async () => {
    const { service } = await polledService([]);
    await expect(service.setForward(LOCAL_PROXY_PORT, true)).rejects.toThrow(/reserved/i);
  });

  it("forwards a non-loopback listener rather than blocking a common dev setup", async () => {
    const { service } = await polledService([{ port: 8080, process: "python3", loopback: false }]);
    const info = await service.setForward(8080, true);
    expect(info.forwarded).toBe(true);
    expect(service.list().find((p) => p.port === 8080)?.forwarded).toBe(true);
    service.stop();
  });

  it("forwards a loopback listener and keeps the flag out of the IPC shape", async () => {
    const { service } = await polledService([{ port: 3000, process: "node", loopback: true }]);
    const info = await service.setForward(3000, true);
    expect(info).toEqual({
      port: 3000,
      process: "node",
      forwarded: true,
      localUrl: "http://localhost:3000",
    });
    service.stop();
  });

  it("still lets an already-forwarded port be turned off", async () => {
    const { service } = await polledService([{ port: 3000, process: "node", loopback: true }]);
    await service.setForward(3000, true);
    expect((await service.setForward(3000, false)).forwarded).toBe(false);
    service.stop();
  });
});

describe("parseLsofListeners", () => {
  const OUTPUT = [
    "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    "node    41123 zach   23u  IPv4 0x1234      0t0  TCP 127.0.0.1:3000 (LISTEN)",
    "node    41123 zach   24u  IPv6 0x5678      0t0  TCP [::1]:3000 (LISTEN)",
    "python3  9021 zach    3u  IPv4 0x9abc      0t0  TCP *:8080 (LISTEN)",
    "weird    1111 zach    9u  IPv4 0xdead      0t0  TCP 10.0.0.5:noport (LISTEN)",
  ].join("\n");

  it("parses one entry per port with loopback detection", () => {
    const ports = parseLsofListeners(OUTPUT).sort((a, b) => a.port - b.port);
    expect(ports).toEqual([
      { port: 3000, process: "node", loopback: true },
      { port: 8080, process: "python3", loopback: false },
    ]);
  });

  it("returns empty for empty or garbled output", () => {
    expect(parseLsofListeners("")).toEqual([]);
    expect(parseLsofListeners("COMMAND PID\nshort line")).toEqual([]);
  });
});
