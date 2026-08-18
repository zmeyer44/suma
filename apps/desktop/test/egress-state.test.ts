import { describe, expect, it } from "vitest";
import {
  buildSpaceEgressConfig,
  egressPlaneState,
  egressStatusFor,
  mayProxyThisRun,
  parsedWorkspaceHasProxiedSpace,
  shouldResetOverrides,
} from "../src/main/egress/egress-state";

describe("buildSpaceEgressConfig", () => {
  it("starts from the shared defaults when nothing is stored", () => {
    const config = buildSpaceEgressConfig("s1", "suma-ip", null, false);
    expect(config).toEqual({
      spaceId: "s1",
      policy: "suma-ip",
      siteBypass: [],
      mediaBypass: true,
      checkoutBypass: true,
      detectedCheckoutHosts: [],
      temporaryDirectOverride: false,
    });
  });

  it("folds in stored bypasses and the in-memory override", () => {
    const config = buildSpaceEgressConfig(
      "s1",
      "suma-ip",
      { siteBypass: ["bank.example"], mediaBypass: false },
      true,
    );
    expect(config.siteBypass).toEqual(["bank.example"]);
    expect(config.mediaBypass).toBe(false);
    expect(config.temporaryDirectOverride).toBe(true);
  });

  it("reads a workspace stored before checkoutBypass existed as bypass-on", () => {
    // Absent must not read as off: those workspaces would silently break every
    // hosted checkout in a proxied space.
    const config = buildSpaceEgressConfig("s1", "suma-ip", { siteBypass: [], mediaBypass: true }, false);
    expect(config.checkoutBypass).toBe(true);
    expect(
      buildSpaceEgressConfig("s1", "suma-ip", { siteBypass: [], mediaBypass: true, checkoutBypass: false }, false)
        .checkoutBypass,
    ).toBe(false);
  });

  it("carries the session's detected checkout hosts", () => {
    const config = buildSpaceEgressConfig("s1", "suma-ip", null, false, ["buy.maticrobots.com"]);
    expect(config.detectedCheckoutHosts).toEqual(["buy.maticrobots.com"]);
  });
});

describe("egressStatusFor (§8.4 fail-closed matrix)", () => {
  it("fails closed only when proxied + gateway down + no override", () => {
    const proxied = buildSpaceEgressConfig("s1", "suma-ip", null, false);
    expect(egressStatusFor(proxied, "down", false).failClosed).toBe(true);
    expect(egressStatusFor(proxied, "up", false).failClosed).toBe(false);

    const overridden = buildSpaceEgressConfig("s1", "suma-ip", null, true);
    expect(egressStatusFor(overridden, "down", false).failClosed).toBe(false);

    const direct = buildSpaceEgressConfig("s1", "direct", null, false);
    expect(egressStatusFor(direct, "down", false).failClosed).toBe(false);
  });

  it("carries the visible state the controls render", () => {
    const status = egressStatusFor(
      buildSpaceEgressConfig("s1", "suma-ip", { siteBypass: ["cdn.example"], mediaBypass: true }, false),
      "up",
      false,
    );
    expect(status).toEqual({
      spaceId: "s1",
      policy: "suma-ip",
      gateway: "up",
      temporaryDirectOverride: false,
      mediaBypass: true,
      checkoutBypass: true,
      detectedCheckoutHosts: [],
      siteBypass: ["cdn.example"],
      failClosed: false,
      vpnActive: false,
      restartRequired: false,
    });
  });
});

describe("shouldResetOverrides (§8.4: 'browse direct for now' is not sticky)", () => {
  it("resets only on the down → up transition", () => {
    expect(shouldResetOverrides("down", "up")).toBe(true);
    expect(shouldResetOverrides("up", "down")).toBe(false);
    expect(shouldResetOverrides("down", "down")).toBe(false);
    expect(shouldResetOverrides("up", "up")).toBe(false);
  });
});

describe("egressPlaneState (§10 rollup)", () => {
  const status = (policy: "suma-ip" | "direct", override: boolean, gateway: "up" | "down") =>
    egressStatusFor(buildSpaceEgressConfig("s", policy, null, override), gateway, false);

  it("is down when any space fails closed", () => {
    expect(egressPlaneState([status("direct", false, "down"), status("suma-ip", false, "down")])).toBe("down");
  });

  it("is bypassed when a proxied space browses direct by override", () => {
    expect(egressPlaneState([status("suma-ip", true, "down")])).toBe("bypassed");
  });

  it("is ok for direct spaces or a healthy gateway", () => {
    expect(egressPlaneState([status("direct", false, "down")])).toBe("ok");
    expect(egressPlaneState([status("suma-ip", false, "up")])).toBe("ok");
  });
});

describe("parsedWorkspaceHasProxiedSpace (startup --disable-quic key)", () => {
  it("detects a proxied space in the raw workspace file", () => {
    expect(
      parsedWorkspaceHasProxiedSpace({
        spaces: [{ egressPolicy: "direct" }, { egressPolicy: "suma-ip" }],
      }),
    ).toBe(true);
    expect(parsedWorkspaceHasProxiedSpace({ spaces: [{ egressPolicy: "direct" }] })).toBe(false);
    expect(parsedWorkspaceHasProxiedSpace({})).toBe(false);
    expect(parsedWorkspaceHasProxiedSpace(null)).toBe(false);
    expect(parsedWorkspaceHasProxiedSpace("garbage")).toBe(false);
  });
});

describe("QUIC leak guard: a mid-session switch is not silently proxied (§8.4)", () => {
  // --disable-quic can only be appended before app ready. If a space is
  // switched to the identity IP afterwards, proxying it anyway would let
  // Chromium race HTTP/3 over UDP past the CONNECT proxy and expose the real
  // IP for exactly the space the user just asked to protect.
  const proxied = buildSpaceEgressConfig("s", "suma-ip", null, false);

  it("reports restartRequired when QUIC could not be disabled this run", () => {
    const status = egressStatusFor(proxied, "up", false, false);
    expect(status.restartRequired).toBe(true);
    // Not "fail closed" — the space is simply direct until relaunch, and the
    // dedicated flag says so rather than blaming the gateway.
    expect(status.failClosed).toBe(false);
  });

  it("routes normally once QUIC was disabled at startup", () => {
    const status = egressStatusFor(proxied, "up", false, true);
    expect(status.restartRequired).toBe(false);
  });

  it("never reports restartRequired for a direct space", () => {
    const direct = buildSpaceEgressConfig("s", "direct", null, false);
    expect(egressStatusFor(direct, "up", false, false).restartRequired).toBe(false);
  });

  it("mayProxyThisRun gates strictly on the startup switch", () => {
    expect(mayProxyThisRun(true)).toBe(true);
    expect(mayProxyThisRun(false)).toBe(false);
  });
});
