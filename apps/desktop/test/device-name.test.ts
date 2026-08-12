import { describe, expect, it } from "vitest";
import { friendlyPlatform, suggestedDeviceName } from "../src/main/device-name";

describe("suggestedDeviceName", () => {
  it("prefers the macOS Computer Name", () => {
    expect(
      suggestedDeviceName({
        computerName: "Claudius’s MacBook Pro",
        hostname: "claudius-macbook-pro.local",
        platform: "darwin",
      }),
    ).toBe("Claudius’s MacBook Pro");
  });

  it("turns a hostname into a readable fallback", () => {
    expect(
      suggestedDeviceName({
        computerName: null,
        hostname: "office-macbook-air.local",
        platform: "darwin",
      }),
    ).toBe("office macbook air");
  });

  it("uses a platform fallback for localhost", () => {
    expect(
      suggestedDeviceName({ hostname: "localhost", platform: "darwin" }),
    ).toBe("My Mac");
  });
});

describe("friendlyPlatform", () => {
  it("maps runtime platform identifiers to UI labels", () => {
    expect(friendlyPlatform("darwin")).toBe("macOS");
    expect(friendlyPlatform("win32")).toBe("Windows");
  });
});
