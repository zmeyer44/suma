import { describe, expect, it } from "vitest";
import { decideDial } from "../src/main/sync/transport";

/**
 * §8.2: an ENROLLED device whose token is revoked/expired (getToken → null)
 * must NOT dial the prod hub tokenless and loop reconnecting. It goes offline
 * and waits ("await-auth"). Tokenless dialing stays valid only for
 * local/unenrolled/dev mode.
 */
describe("decideDial (§8.2 enrolled + null token)", () => {
  it("dials authenticated whenever a token is present", () => {
    expect(decideDial("hbr_dev_abc", true)).toBe("dial");
    expect(decideDial("hbr_dev_abc", false)).toBe("dial");
  });

  it("dials tokenless only when auth is NOT required (local/dev hub)", () => {
    expect(decideDial(null, false)).toBe("dial-tokenless");
    expect(decideDial("", false)).toBe("dial-tokenless");
  });

  it("awaits auth (offline, no reconnect storm) when enrolled but tokenless", () => {
    expect(decideDial(null, true)).toBe("await-auth");
    expect(decideDial("", true)).toBe("await-auth");
  });
});
