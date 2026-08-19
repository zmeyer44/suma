import { describe, expect, it } from "vitest";
import {
  deriveOnboardingStep,
  onboardingSteps,
  type OnboardingFlowState,
} from "../src/renderer/src/lib/onboarding-steps";

function state(over: Partial<OnboardingFlowState> = {}): OnboardingFlowState {
  return {
    authState: "unenrolled",
    credentialDone: false,
    recoveryCodeShowing: false,
    accountConfirmed: false,
    localOnly: false,
    accountMode: "create",
    computeMode: "cloud",
    machineReady: false,
    ...over,
  };
}

describe("onboardingSteps", () => {
  it("create flow against a control plane gets the computer step", () => {
    expect(onboardingSteps({ localOnly: false, accountMode: "create" })).toEqual([
      "account",
      "computer",
      "credential",
      "recovery",
    ]);
  });

  it("link flow and local-only skip it — the rail count stays honest", () => {
    expect(onboardingSteps({ localOnly: false, accountMode: "link" })).toEqual([
      "account",
      "credential",
      "recovery",
    ]);
    expect(onboardingSteps({ localOnly: true, accountMode: "create" })).toEqual([
      "account",
      "credential",
      "recovery",
    ]);
  });
});

describe("deriveOnboardingStep", () => {
  it("stays on account until the form is confirmed, then shows computer", () => {
    expect(deriveOnboardingStep(state())).toBe("account");
    expect(deriveOnboardingStep(state({ accountConfirmed: true }))).toBe("computer");
  });

  it("never shows computer on the link or local-only paths", () => {
    expect(
      deriveOnboardingStep(state({ accountMode: "link", accountConfirmed: true })),
    ).toBe("account");
    expect(
      deriveOnboardingStep(state({ localOnly: true, accountConfirmed: true })),
    ).toBe("account");
  });

  it("a restart between confirm and signup resumes at account", () => {
    // accountConfirmed is component-local state; a fresh mount starts false.
    expect(deriveOnboardingStep(state({ accountConfirmed: false }))).toBe("account");
  });

  it("post-signup flow once the machine is ready: credential, recovery, done", () => {
    expect(
      deriveOnboardingStep(state({ authState: "signed-up", machineReady: true })),
    ).toBe("credential");
    expect(
      deriveOnboardingStep(
        state({ authState: "enrolled", credentialDone: false, machineReady: true }),
      ),
    ).toBe("credential");
    expect(
      deriveOnboardingStep(
        state({ authState: "enrolled", credentialDone: true, recoveryCodeShowing: true }),
      ),
    ).toBe("recovery");
    expect(
      deriveOnboardingStep(state({ authState: "enrolled", credentialDone: true })),
    ).toBeNull();
  });

  it("a cloud signup holds on provisioning until the machine is reachable", () => {
    expect(deriveOnboardingStep(state({ authState: "signed-up" }))).toBe("provisioning");
    // Unknown compute mode is cloud per the enrollment contract.
    expect(
      deriveOnboardingStep(state({ authState: "signed-up", computeMode: null })),
    ).toBe("provisioning");
    // The gate survives a restart mid-onboarding: enrolled but credential
    // still pending re-derives provisioning while the machine is down.
    expect(
      deriveOnboardingStep(state({ authState: "enrolled", credentialDone: false })),
    ).toBe("provisioning");
    expect(
      deriveOnboardingStep(state({ authState: "signed-up", machineReady: true })),
    ).toBe("credential");
  });

  it("never gates local compute, local-only, or linked devices on a VM", () => {
    expect(
      deriveOnboardingStep(state({ authState: "signed-up", computeMode: "local" })),
    ).toBe("credential");
    expect(
      deriveOnboardingStep(
        state({ authState: "signed-up", localOnly: true, computeMode: null }),
      ),
    ).toBe("credential");
    expect(
      deriveOnboardingStep(state({ authState: "signed-up", accountMode: "link" })),
    ).toBe("credential");
  });

  it("a finished setup never resurrects the wizard over a sleeping machine", () => {
    expect(
      deriveOnboardingStep(
        state({ authState: "enrolled", credentialDone: true, machineReady: false }),
      ),
    ).toBeNull();
  });
});
