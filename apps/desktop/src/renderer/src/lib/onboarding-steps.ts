/**
 * Onboarding step derivation, kept pure so the wizard's flow — which steps
 * exist and which one is showing — is unit-testable without React.
 *
 * The computer step exists only on the create-account path against a real
 * control plane: the choice rides the signup POST, so it must precede it.
 * Linked devices inherit the account's compute mode, and local-only mode
 * (no control plane) has no computer to choose.
 */

export type OnboardingStep = "account" | "computer" | "credential" | "recovery";

export interface OnboardingFlowState {
  authState: "unenrolled" | "signed-up" | "enrolled";
  /** A registered login credential exists (device key or passkey). */
  credentialDone: boolean;
  /** The shown-once recovery code is being displayed. */
  recoveryCodeShowing: boolean;
  /** The account form validated and the user continued past it. */
  accountConfirmed: boolean;
  /** No control plane configured. */
  localOnly: boolean;
  accountMode: "create" | "link";
}

export function onboardingSteps(
  state: Pick<OnboardingFlowState, "localOnly" | "accountMode">,
): OnboardingStep[] {
  const hasComputerStep = !state.localOnly && state.accountMode === "create";
  return hasComputerStep
    ? ["account", "computer", "credential", "recovery"]
    : ["account", "credential", "recovery"];
}

export function deriveOnboardingStep(state: OnboardingFlowState): OnboardingStep | null {
  if (state.authState === "unenrolled") {
    const computerOffered = !state.localOnly && state.accountMode === "create";
    return computerOffered && state.accountConfirmed ? "computer" : "account";
  }
  if (!state.credentialDone) return "credential";
  if (state.recoveryCodeShowing) return "recovery";
  return null;
}
