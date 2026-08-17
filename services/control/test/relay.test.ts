/**
 * RelayRegistry — the pure piping core. FakeSocket records what the relay
 * does to each side; no ws, no network.
 */

import { describe, expect, it } from "vitest";
import {
  CLOSE_HOME_OFFLINE,
  CLOSE_REPLACED,
  RelayRegistry,
  type RelaySocket,
} from "../src/relay.js";

class FakeSocket implements RelaySocket {
  readonly sent: Array<string | Uint8Array> = [];
  readonly closes: Array<{ code: number; reason?: string }> = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

function registry(): RelayRegistry {
  let n = 0;
  return new RelayRegistry({ connId: () => `conn000${(n += 1)}` });
}

const frame = (text: string): Uint8Array => Buffer.from(text, "utf8");

describe("RelayRegistry", () => {
  it("pipes client → home with an 8-byte conn prefix, and home → client without it", () => {
    const r = registry();
    const home = new FakeSocket();
    const away = new FakeSocket();
    r.attachHome("u1", home);
    const conn = r.attachClient("u1", away);
    expect(conn).toBe("conn0001");
    expect(home.sent[0]).toBe(JSON.stringify({ t: "open", conn: "conn0001" }));

    r.clientMessage("u1", "conn0001", frame("hello-agent"));
    const enveloped = home.sent[1] as Uint8Array;
    expect(Buffer.from(enveloped.subarray(0, 8)).toString("ascii")).toBe("conn0001");
    expect(Buffer.from(enveloped.subarray(8)).toString("utf8")).toBe("hello-agent");

    r.homeMessage("u1", Buffer.concat([Buffer.from("conn0001"), frame("hello-away")]));
    expect(Buffer.from(away.sent[0] as Uint8Array).toString("utf8")).toBe("hello-away");
  });

  it("drops unknown conns and short binaries silently", () => {
    const r = registry();
    const home = new FakeSocket();
    r.attachHome("u1", home);
    r.homeMessage("u1", Buffer.concat([Buffer.from("ghost123"), frame("x")]));
    r.homeMessage("u1", Buffer.from("shorty"));
    r.homeMessage("u1", "not json at all");
    r.clientMessage("u1", "neverwas", frame("x"));
    expect(home.sent).toHaveLength(0);
  });

  it("no home ⇒ client is closed 4404 and returns null", () => {
    const r = registry();
    const away = new FakeSocket();
    expect(r.attachClient("u1", away)).toBeNull();
    expect(away.closes).toEqual([{ code: CLOSE_HOME_OFFLINE, reason: "home-offline" }]);
    expect(r.homeOnline("u1")).toBe(false);
  });

  it("newest home wins: old socket 4000, its clients 4404, presence stays up", () => {
    const r = registry();
    const oldHome = new FakeSocket();
    const away = new FakeSocket();
    r.attachHome("u1", oldHome);
    r.attachClient("u1", away);

    const newHome = new FakeSocket();
    r.attachHome("u1", newHome);
    expect(oldHome.closes).toEqual([{ code: CLOSE_REPLACED, reason: "replaced" }]);
    expect(away.closes).toEqual([{ code: CLOSE_HOME_OFFLINE, reason: "home-offline" }]);
    expect(r.homeOnline("u1")).toBe(true);

    // A stale close event from the REPLACED socket must not evict the new one.
    r.detachHome("u1", oldHome);
    expect(r.homeOnline("u1")).toBe(true);
  });

  it("home drop closes every away client 4404 and flips presence", () => {
    const r = registry();
    const home = new FakeSocket();
    const away1 = new FakeSocket();
    const away2 = new FakeSocket();
    r.attachHome("u1", home);
    r.attachClient("u1", away1);
    r.attachClient("u1", away2);
    r.detachHome("u1", home);
    expect(away1.closes[0]?.code).toBe(CLOSE_HOME_OFFLINE);
    expect(away2.closes[0]?.code).toBe(CLOSE_HOME_OFFLINE);
    expect(r.homeOnline("u1")).toBe(false);
  });

  it("client detach tells home; home can force-drop one client", () => {
    const r = registry();
    const home = new FakeSocket();
    const away = new FakeSocket();
    r.attachHome("u1", home);
    r.attachClient("u1", away);

    r.detachClient("u1", "conn0001");
    expect(home.sent.at(-1)).toBe(JSON.stringify({ t: "close", conn: "conn0001" }));

    const away2 = new FakeSocket();
    r.attachClient("u1", away2); // conn0002
    r.homeMessage("u1", JSON.stringify({ t: "close", conn: "conn0002" }));
    expect(away2.closes).toEqual([{ code: 1000, reason: "closed by home" }]);
    // And its frames no longer route.
    r.clientMessage("u1", "conn0002", frame("late"));
    expect(
      home.sent.filter((s) => typeof s !== "string" && s.byteLength > 0),
    ).toHaveLength(0);
  });

  it("users are isolated: one user's home never sees another's clients", () => {
    const r = registry();
    const home1 = new FakeSocket();
    r.attachHome("u1", home1);
    const away = new FakeSocket();
    expect(r.attachClient("u2", away)).toBeNull(); // u2 has no home
    expect(home1.sent).toHaveLength(0);
  });
});
