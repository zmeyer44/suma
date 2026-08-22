import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, TcpAgentClient } from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe("agent capability handshake", () => {
  it("authenticates ctl and every additional mux connection before data", async () => {
    const channelsByConnection: string[][] = [];
    const server = net.createServer((socket) => {
      const seen: string[] = [];
      channelsByConnection.push(seen);
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          seen.push(frame.channel);
          if (frame.channel === "auth") {
            expect(frame.payload.toString("utf8")).toBe("signed-capability-token");
            socket.write(encodeFrame("auth", "ok"));
          } else if (frame.channel === "ctl") {
            socket.write(
              encodeFrame("ctl", JSON.stringify({ t: "ports", ports: [] })),
            );
          } else if (frame.channel === "vfs") {
            socket.write(
              encodeFrame(
                "vfs",
                JSON.stringify({
                  t: "vfs.info",
                  entry: {
                    name: "note.txt",
                    path: "/note.txt",
                    kind: "file",
                    sizeBytes: 1,
                    modifiedAtMs: 1,
                  },
                }),
              ),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    const client = new TcpAgentClient(`tcp://127.0.0.1:${String(port)}`, {
      capabilityToken: "signed-capability-token",
    });
    cleanups.push(() => client.stop());

    await new Promise<void>((resolve) => {
      const unsubscribe = client.onConnectionChanged((up) => {
        if (!up) return;
        unsubscribe();
        resolve();
      });
    });
    await expect(client.ctl({ t: "ports.list" })).resolves.toEqual({
      t: "ports",
      ports: [],
    });
    await expect(client.vfs({ t: "vfs.stat", path: "/note.txt" })).resolves.toMatchObject({
      t: "vfs.info",
    });

    expect(channelsByConnection).toHaveLength(2);
    expect(channelsByConnection[0]).toEqual(["auth", "ctl"]);
    expect(channelsByConnection[1]).toEqual(["auth", "vfs"]);
  });
});
