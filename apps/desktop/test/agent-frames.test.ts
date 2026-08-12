import { describe, expect, it } from "vitest";
import {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_BYTES,
  parseAgentUrl,
} from "../src/main/compute/agent-client";

describe("mux framing (agent/src/mux.rs wire format, Appendix C)", () => {
  /**
   * The same byte vector pinned by `frame_byte_layout_is_pinned` in both
   * agent/src/mux.rs and sidecar/src/agent_client.rs. All three must agree on
   * the wire, byte for byte — if one moves, all three move.
   */
  it("encodes the exact bytes the agent decodes", () => {
    expect([...encodeFrame("ctl", "{}")]).toEqual([
      0, 0, 0, 7, 0, 3, 0x63, 0x74, 0x6c, 0x7b, 0x7d,
    ]);
  });

  it("counts total as channel_len + channel + payload, big-endian", () => {
    const frame = encodeFrame("pty/t-1", "ls\n");
    expect(frame.readUInt32BE(0)).toBe(2 + "pty/t-1".length + "ls\n".length);
    expect(frame.readUInt16BE(4)).toBe("pty/t-1".length);
    expect(frame.subarray(6, 6 + 7).toString("utf8")).toBe("pty/t-1");
    expect(frame.subarray(13).toString("utf8")).toBe("ls\n");
    // The u32 itself is not counted in `total`.
    expect(frame.byteLength).toBe(4 + frame.readUInt32BE(0));
  });

  it("round-trips every channel and byte-exact payloads", () => {
    const binary = Buffer.from([0x00, 0x9f, 0x92, 0x96, 0x0a]); // not UTF-8
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      Buffer.concat([
        encodeFrame("ctl", '{"t":"ports.list"}'),
        encodeFrame("pty/t-1", binary),
        encodeFrame("fwd/3000", ""),
        encodeFrame("log", "boot"),
      ]),
    );
    expect(frames.map((f) => f.channel)).toEqual(["ctl", "pty/t-1", "fwd/3000", "log"]);
    expect(frames[0]?.payload.toString("utf8")).toBe('{"t":"ports.list"}');
    expect(frames[1]?.payload.equals(binary)).toBe(true);
    expect(frames[2]?.payload.byteLength).toBe(0);
    expect(frames[3]?.payload.toString("utf8")).toBe("boot");
  });

  it("reassembles frames split across arbitrary chunk boundaries", () => {
    const whole = Buffer.concat([encodeFrame("pty/abc", "hello"), encodeFrame("ctl", "{}")]);
    for (const step of [1, 3, 7]) {
      const decoder = new FrameDecoder();
      const out: Array<[string, string]> = [];
      for (let i = 0; i < whole.byteLength; i += step) {
        for (const frame of decoder.push(whole.subarray(i, i + step))) {
          out.push([frame.channel, frame.payload.toString("utf8")]);
        }
      }
      expect(out).toEqual([
        ["pty/abc", "hello"],
        ["ctl", "{}"],
      ]);
    }
  });

  it("yields nothing until a frame is complete, then exactly that frame", () => {
    const whole = encodeFrame("ctl", '{"t":"ports.list"}');
    const decoder = new FrameDecoder();
    expect(decoder.push(whole.subarray(0, 3))).toEqual([]); // partial length prefix
    expect(decoder.push(whole.subarray(3, 6))).toEqual([]); // length + partial header
    expect(decoder.push(whole.subarray(6, whole.byteLength - 1))).toEqual([]); // short a byte
    const frames = decoder.push(whole.subarray(whole.byteLength - 1));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.channel).toBe("ctl");
    expect(frames[0]?.payload.toString("utf8")).toBe('{"t":"ports.list"}');
  });

  it("rejects the frames the agent rejects", () => {
    // total below the 2-byte channel-length header, and total above the cap.
    for (const total of [0, 1, MAX_FRAME_BYTES + 1]) {
      const bogus = Buffer.alloc(4);
      bogus.writeUInt32BE(total, 0);
      expect(() => new FrameDecoder().push(bogus)).toThrow(/out of bounds/);
    }
    // channel_len that runs past the end of the frame.
    const overrun = Buffer.alloc(4 + 4);
    overrun.writeUInt32BE(4, 0);
    overrun.writeUInt16BE(9, 4);
    expect(() => new FrameDecoder().push(overrun)).toThrow(/exceeds the 4-byte frame/);
    // channel bytes that are not UTF-8.
    const garbled = Buffer.concat([Buffer.from([0, 0, 0, 4, 0, 2]), Buffer.from([0xff, 0xfe])]);
    expect(() => new FrameDecoder().push(garbled)).toThrow(/not valid UTF-8/);
  });

  it("refuses to encode frames the agent would refuse to read", () => {
    const oversized = Buffer.alloc(MAX_FRAME_BYTES - 2); // + "ctl" + header ⇒ over the cap
    expect(() => encodeFrame("ctl", oversized)).toThrow(/exceeds the/);
    expect(() => encodeFrame("x".repeat(0x10000), "")).toThrow(/u16 length prefix/);
    // Exactly at the cap is legal.
    expect(encodeFrame("ctl", Buffer.alloc(MAX_FRAME_BYTES - 5)).readUInt32BE(0)).toBe(
      MAX_FRAME_BYTES,
    );
  });
});

describe("parseAgentUrl", () => {
  it("accepts tcp://host:port and bare host:port", () => {
    expect(parseAgentUrl("tcp://vm.internal:9000")).toEqual({ host: "vm.internal", port: 9000 });
    expect(parseAgentUrl("127.0.0.1:4321")).toEqual({ host: "127.0.0.1", port: 4321 });
  });

  it("rejects missing or out-of-range ports", () => {
    expect(() => parseAgentUrl("tcp://nohost")).toThrow(/host:port/);
    expect(() => parseAgentUrl("host:0")).toThrow(/host:port/);
    expect(() => parseAgentUrl("host:70000")).toThrow(/host:port/);
  });
});
