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
    expect(
      onboardingSteps({ localOnly: false, accountMode: "create" }),
    ).toEqual(["account", "computer", "credential", "recovery"]);
  });

  it("link flow and local-only skip it — the rail count stays honest", () => {
    expect(onboardingSteps({ localOnly: false, accountMode: "link" })).toEqual([
      "account",
      "credential",
      "recovery",
    ]);
    expect(onboardingSteps({ localOnly: true, accountMode: "create" })).toEqual(
      ["account", "credential", "recovery"],
    );
  });
});

describe("deriveOnboardingStep", () => {
  it("stays on account until the form is confirmed, then shows computer", () => {
    expect(deriveOnboardingStep(state())).toBe("account");
    expect(deriveOnboardingStep(state({ accountConfirmed: true }))).toBe(
      "computer",
    );
  });

  it("never shows computer on the link or local-only paths", () => {
    expect(
      deriveOnboardingStep(
        state({ accountMode: "link", accountConfirmed: true }),
      ),
    ).toBe("account");
    expect(
      deriveOnboardingStep(state({ localOnly: true, accountConfirmed: true })),
    ).toBe("account");
  });

  it("a restart between confirm and signup resumes at account", () => {
    // accountConfirmed is component-local state; a fresh mount starts false.
    expect(deriveOnboardingStep(state({ accountConfirmed: false }))).toBe(
      "account",
    );
  });

  it("post-signup flow secures the device before waiting for its machine", () => {
    expect(deriveOnboardingStep(state({ authState: "signed-up" }))).toBe(
      "credential",
    );
    expect(
      deriveOnboardingStep(
        state({
          authState: "enrolled",
          credentialDone: false,
          machineReady: true,
        }),
      ),
    ).toBe("credential");
    expect(
      deriveOnboardingStep(
        state({
          authState: "enrolled",
          credentialDone: true,
          recoveryCodeShowing: true,
        }),
      ),
    ).toBe("provisioning");
    expect(
      deriveOnboardingStep(
        state({
          authState: "enrolled",
          credentialDone: true,
          recoveryCodeShowing: true,
          machineReady: true,
        }),
      ),
    ).toBe("recovery");
    expect(
      deriveOnboardingStep(
        state({ authState: "enrolled", credentialDone: true }),
      ),
    ).toBeNull();
  });

  it("never gates local compute, local-only, or linked devices on a VM", () => {
    expect(
      deriveOnboardingStep(
        state({
          authState: "enrolled",
          credentialDone: true,
          recoveryCodeShowing: true,
          computeMode: "local",
        }),
      ),
    ).toBe("recovery");
    expect(
      deriveOnboardingStep(
        state({
          authState: "enrolled",
          credentialDone: true,
          recoveryCodeShowing: true,
          localOnly: true,
          computeMode: null,
        }),
      ),
    ).toBe("recovery");
    expect(
      deriveOnboardingStep(
        state({
          authState: "enrolled",
          credentialDone: true,
          recoveryCodeShowing: true,
          accountMode: "link",
        }),
      ),
    ).toBe("recovery");
  });

  it("a finished setup never resurrects the wizard over a sleeping machine", () => {
    expect(
      deriveOnboardingStep(
        state({
          authState: "enrolled",
          credentialDone: true,
          machineReady: false,
        }),
      ),
    ).toBeNull();
  });
});
