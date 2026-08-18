/**
 * PortsService with a remote link: enabling a forward opens a local listener
 * that pipes each accepted socket over link.forward; DISABLING it must sever
 * live connections, not just stop accepting (server.close() alone leaves
 * piped sockets running).
 */

import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCtlRequest, AgentCtlResponse } from "@suma/protocol";
import type { AgentLink, PtyChannel } from "../src/main/compute/agent-client";
import { PortsService } from "../src/main/compute/ports-service";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** An in-process echo "agent": every forwarded socket echoes what it gets. */
class EchoLink implements AgentLink {
  readonly kind = "remote" as const;
  readonly forwarded: net.Socket[] = [];

  connected(): boolean {
    return true;
  }
  onConnectionChanged(): () => void {
    return () => undefined;
  }
  onCtlEvent(): () => void {
    return () => undefined;
  }
  async ctl(_request: AgentCtlRequest): Promise<AgentCtlResponse | null> {
    return { t: "ports", ports: [] };
  }
  openPty(): PtyChannel {
    return { write: () => undefined, close: () => undefined };
  }
  forward(_port: number, socket: import("node:stream").Duplex): void {
    this.forwarded.push(socket as net.Socket);
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  }
  async vfs(): Promise<never> {
    throw new Error("no vfs in this stub");
  }
  vfsRootLabel(): string {
    return "~/cloud";
  }
  stop(): void {}
}

/** A free ephemeral port number (bind then release). */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("PortsService forward lifecycle", () => {
  it("enables an echo forward and severs live connections on disable", async () => {
    const link = new EchoLink();
    const service = new PortsService({ link, emit: () => undefined });
    cleanups.push(() => service.stop());
    const port = await freePort();

    await service.setForward(port, true);
    const socket = await connect(port);
    cleanups.push(() => socket.destroy());

    // Round-trips through the listener → link.forward echo.
    const echoed = await new Promise<Buffer>((resolve) => {
      socket.once("data", resolve);
      socket.write(Buffer.from("ping"));
    });
    expect(echoed.toString("utf8")).toBe("ping");

    // Disabling severs the LIVE connection (the bug fix): the client socket
    // ends, and the port becomes re-listenable.
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    await service.setForward(port, false);
    await closed;
    expect(socket.destroyed).toBe(true);

    // The port is free again — enable/disable did not leak the listener.
    await service.setForward(port, true);
    await service.setForward(port, false);
  });

  it("stop() destroys live forwarded sockets", async () => {
    const link = new EchoLink();
    const service = new PortsService({ link, emit: () => undefined });
    const port = await freePort();
    await service.setForward(port, true);
    const socket = await connect(port);
    cleanups.push(() => socket.destroy());
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    service.stop();
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});

describe("PortsService.ensureForward (loopback navigation)", () => {
  /** EchoLink whose agent reports a controllable listener list. */
  class ReportingLink extends EchoLink {
    ports: Array<{ port: number; process: string; loopback: boolean }> = [];
    override async ctl(
      _request: AgentCtlRequest,
    ): Promise<AgentCtlResponse | null> {
      return { t: "ports", ports: this.ports };
    }
  }

  it("forwards a port the agent reports and round-trips traffic", async () => {
    const link = new ReportingLink();
    const service = new PortsService({ link, emit: () => undefined });
    cleanups.push(() => service.stop());
    const port = await freePort();
    link.ports = [{ port, process: "node", loopback: true }];

    // Concurrent asset requests during one navigation share a single attempt.
    const results = await Promise.all([
      service.ensureForward(port),
      service.ensureForward(port),
    ]);
    expect(results).toEqual([true, true]);
    expect(service.list().find((p) => p.port === port)?.forwarded).toBe(true);

    const socket = await connect(port);
    cleanups.push(() => socket.destroy());
    const echoed = await new Promise<Buffer>((resolve) => {
      socket.once("data", resolve);
      socket.write(Buffer.from("ping"));
    });
    expect(echoed.toString("utf8")).toBe("ping");
  });

  it("refuses ports the agent does not report as listening", async () => {
    const link = new ReportingLink();
    const service = new PortsService({ link, emit: () => undefined });
    cleanups.push(() => service.stop());
    const port = await freePort();
    expect(await service.ensureForward(port)).toBe(false);
    // The port stays free — no listener was bound for an unserved port.
    await service.setForward(port, true);
    await service.setForward(port, false);
  });

  it("yields to a genuinely local server already on the port", async () => {
    const link = new ReportingLink();
    const service = new PortsService({ link, emit: () => undefined });
    cleanups.push(() => service.stop());
    const local = net.createServer();
    const port = await new Promise<number>((resolve) =>
      local.listen(0, "127.0.0.1", () =>
        resolve((local.address() as net.AddressInfo).port),
      ),
    );
    cleanups.push(() => local.close());
    link.ports = [{ port, process: "node", loopback: true }];
    expect(await service.ensureForward(port)).toBe(false);
  });
});
