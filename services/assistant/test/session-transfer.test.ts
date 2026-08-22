import { describe, expect, it } from "vitest";
import { parseBrowserStorageState } from "../src/browser/session-transfer";

describe("browser session handoff", () => {
  it("accepts cookie and local-storage state from a trusted desktop", () => {
    expect(
      parseBrowserStorageState({
        cookies: [
          {
            name: "session",
            value: "secret",
            domain: "example.com",
            path: "/",
          },
        ],
        origins: [
          {
            origin: "https://example.com",
            localStorage: [{ name: "account", value: "one" }],
          },
        ],
      }),
    ).toMatchObject({ cookies: [{ name: "session" }] });
  });

  it("rejects malformed origins and oversized collections", () => {
    expect(() =>
      parseBrowserStorageState({
        cookies: [],
        origins: [{ origin: "file:///tmp/account", localStorage: [] }],
      }),
    ).toThrow("HTTP(S) origin");
    expect(() =>
      parseBrowserStorageState({ cookies: new Array(2_001).fill({}), origins: [] }),
    ).toThrow("cookie list");
  });
});
