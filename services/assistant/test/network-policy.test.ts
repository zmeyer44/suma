import { describe, expect, it } from "vitest";
import {
  SafeBrowserNetworkPolicy,
  isBlockedAddress,
} from "../src/browser/network-policy";

describe("safe browser network policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "[::1]",
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "2002:7f00:1::",
  ])("blocks private address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it("allows an exact origin override without weakening other hosts", async () => {
    const policy = new SafeBrowserNetworkPolicy({
      allowedOrigins: ["http://127.0.0.1:43123"],
    });
    await expect(
      policy.assertAllowed("http://127.0.0.1:43123/test"),
    ).resolves.toBeUndefined();
    await expect(
      policy.assertAllowed("http://127.0.0.1:43124/test"),
    ).rejects.toThrow("blocks address");
  });

  it("rejects URLs containing inline credentials", async () => {
    const policy = new SafeBrowserNetworkPolicy();
    await expect(
      policy.assertAllowed("https://token@example.com/"),
    ).rejects.toThrow("credentials");
  });

  it("recognizes bracketed IPv6 literals before DNS resolution", async () => {
    const policy = new SafeBrowserNetworkPolicy();
    await expect(policy.assertAllowed("http://[::1]/private")).rejects.toThrow(
      "blocks address",
    );
    await expect(
      policy.assertAllowed("http://[::ffff:7f00:1]/private"),
    ).rejects.toThrow("blocks address");
  });
});
