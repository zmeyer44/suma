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

  it("post-signup flow is unchanged: credential, then recovery, then done", () => {
    expect(deriveOnboardingStep(state({ authState: "signed-up" }))).toBe("credential");
    expect(
      deriveOnboardingStep(state({ authState: "enrolled", credentialDone: false })),
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
});
