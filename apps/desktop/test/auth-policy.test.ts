import { describe, expect, it } from "vitest";
import { classifyPermission, permissionPromptText } from "../src/main/permission-policy";
import {
  keychainAccessGroupFor,
  planPasskeySupport,
  toAccountChoices,
  type PasskeyEnvironment,
} from "../src/main/webauthn-policy";

describe("permission policy", () => {
  it("grants the Storage Access API — federated sign-in depends on it", () => {
    expect(classifyPermission("storage-access", true)).toBe("grant");
    expect(classifyPermission("top-level-storage-access", true)).toBe("grant");
  });

  it("grants sanitized clipboard writes for MFA backup codes", () => {
    expect(classifyPermission("clipboard-sanitized-write", true)).toBe("grant");
  });

  it("still prompts for camera, mic, and screen share", () => {
    expect(classifyPermission("media", true)).toBe("prompt");
    expect(classifyPermission("display-capture", true)).toBe("prompt");
    expect(permissionPromptText("display-capture")).toContain("screen");
    expect(permissionPromptText("media")).toContain("camera");
  });

  it("fails closed for everything else", () => {
    for (const permission of [
      "geolocation",
      "notifications",
      "midiSysex",
      "openExternal",
      "unknown",
      "fileSystem",
      "window-management",
    ]) {
      expect(classifyPermission(permission, true), permission).toBe("deny");
    }
  });

  it("denies any request it cannot attribute to a tab or popup in the space", () => {
    for (const permission of ["storage-access", "media", "clipboard-sanitized-write"]) {
      expect(classifyPermission(permission, false), permission).toBe("deny");
    }
  });
});

const env = (patch: Partial<PasskeyEnvironment> = {}): PasskeyEnvironment => ({
  platform: "darwin",
  packaged: true,
  hasConfigureWebAuthn: true,
  teamId: "ABCDE12345",
  bundleId: "com.sumabrowser.app",
  ...patch,
});

describe("passkey support plan", () => {
  it("is available in a signed macOS build on a capable runtime", () => {
    const plan = planPasskeySupport(env());
    expect(plan.support).toBe("available");
    expect(plan.keychainAccessGroup).toBe("ABCDE12345.com.sumabrowser.app.webauthn");
  });

  it("reports an unsigned dev run honestly instead of failing mid-ceremony", () => {
    expect(planPasskeySupport(env({ packaged: false })).support).toBe("unsigned-build");
    expect(planPasskeySupport(env({ teamId: undefined })).support).toBe("unsigned-build");
    expect(planPasskeySupport(env({ teamId: "" })).support).toBe("unsigned-build");
  });

  it("reports runtimes and platforms without a platform authenticator", () => {
    expect(planPasskeySupport(env({ hasConfigureWebAuthn: false })).support).toBe(
      "unsupported-platform",
    );
    expect(planPasskeySupport(env({ platform: "win32" })).support).toBe("unsupported-platform");
  });

  it("never claims availability without a keychain access group", () => {
    for (const patch of [{ packaged: false }, { platform: "linux" }, { hasConfigureWebAuthn: false }]) {
      const plan = planPasskeySupport(env(patch));
      expect(plan.keychainAccessGroup).toBeUndefined();
      expect(plan.detail.length).toBeGreaterThan(0);
    }
  });

  it("builds the group Apple's tooling expects", () => {
    expect(keychainAccessGroupFor("TEAM1", "com.example.app")).toBe("TEAM1.com.example.app.webauthn");
  });
});

describe("passkey account choices", () => {
  it("prefers the human identifier and falls back sensibly", () => {
    const choices = toAccountChoices(
      [
        { credentialId: "aaa", name: "ada@example.com", displayName: "Ada Lovelace" },
        { credentialId: "bbb", displayName: "Grace Hopper" },
        { credentialId: "ccc0123456789" },
      ],
      "github.com",
    );
    expect(choices[0]).toEqual({
      credentialId: "aaa",
      name: "ada@example.com",
      detail: "Ada Lovelace · github.com",
    });
    expect(choices[1]?.name).toBe("Grace Hopper");
    expect(choices[1]?.detail).toBe("github.com");
    expect(choices[2]?.name).toBe("Passkey ccc01234");
  });

  it("never produces a blank entry", () => {
    for (const choice of toAccountChoices([{ credentialId: "x" }], "rp.example")) {
      expect(choice.name.trim().length).toBeGreaterThan(0);
      expect(choice.detail.trim().length).toBeGreaterThan(0);
    }
  });
});
