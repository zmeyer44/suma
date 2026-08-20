/**
 * Onboarding step derivation, kept pure so the wizard's flow — which steps
 * exist and which one is showing — is unit-testable without React.
 *
 * The computer step exists only on the create-account path against a real
 * control plane: the choice rides the signup POST, so it must precede it.
 * Linked devices inherit the account's compute mode, and local-only mode
 * (no control plane) has no computer to choose.
 *
 * Signup credentials are deliberately short-lived, so the credential step
 * comes immediately after signup. Cloud provisioning can take longer than a
 * bootstrap token's lifetime; waiting for the VM first would leave enrollment
 * holding an expired token. Once this Mac is secured, the wizard holds on the
 * provisioning step until the machine and its agent link are reachable.
 */

export type OnboardingStep =
  | "account"
  | "computer"
  | "provisioning"
  | "credential"
  | "recovery";

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
  /** The account's compute mode once signup answered. null = unknown, which
   *  the enrollment contract says to treat as cloud. */
  computeMode: "cloud" | "local" | null;
  /** Cloud only: the VM is running and the agent link is connected. */
  machineReady: boolean;
}

/**
 * The rail's segments. Provisioning is deliberately NOT one of them: it is
 * background work between securing this Mac and revealing the recovery code,
 * so the wizard maps it onto the credential segment rather than inflating the
 * step count.
 */
export function onboardingSteps(
  state: Pick<OnboardingFlowState, "localOnly" | "accountMode">,
): OnboardingStep[] {
  const hasComputerStep = !state.localOnly && state.accountMode === "create";
  return hasComputerStep
    ? ["account", "computer", "credential", "recovery"]
    : ["account", "credential", "recovery"];
}

export function deriveOnboardingStep(
  state: OnboardingFlowState,
): OnboardingStep | null {
  if (state.authState === "unenrolled") {
    const computerOffered = !state.localOnly && state.accountMode === "create";
    return computerOffered && state.accountConfirmed ? "computer" : "account";
  }
  if (!state.credentialDone) return "credential";
  // Provision only while this mount still owns the just-created recovery
  // code. That distinguishes unfinished signup from an enrolled device whose
  // machine is merely sleeping on a later launch, which must not resurrect
  // onboarding.
  if (
    !state.localOnly &&
    state.accountMode === "create" &&
    state.computeMode !== "local" &&
    state.recoveryCodeShowing &&
    !state.machineReady
  ) {
    return "provisioning";
  }
  if (state.recoveryCodeShowing) return "recovery";
  return null;
}
