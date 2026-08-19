/**
 * Onboarding step derivation, kept pure so the wizard's flow — which steps
 * exist and which one is showing — is unit-testable without React.
 *
 * The computer step exists only on the create-account path against a real
 * control plane: the choice rides the signup POST, so it must precede it.
 * Linked devices inherit the account's compute mode, and local-only mode
 * (no control plane) has no computer to choose.
 *
 * The provisioning step is the cloud path's gate: signup kicked off a VM
 * build, and letting the user finish setup before that VM is reachable
 * strands them in an app whose computer isn't there yet (every workspace
 * call fails with "suma-agent unreachable"). The wizard holds on this step —
 * showing live progress — until the machine is running AND the agent link is
 * actually connected, and only then moves on.
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
 * the tail of the computer step ("Create my computer" → watch it being
 * created), so the wizard maps it onto the computer segment rather than
 * inflating the step count.
 */
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
  if (!state.credentialDone) {
    // The cloud gate — scoped to the create path (a linked Mac joins a
    // machine that already exists; local modes have no VM to wait for) and
    // to setups still awaiting their credential: once enrollment finished,
    // a disconnected machine is the app's suspend/wake story, and must not
    // resurrect the wizard on launch.
    if (
      !state.localOnly &&
      state.accountMode === "create" &&
      state.computeMode !== "local" &&
      !state.machineReady
    ) {
      return "provisioning";
    }
    return "credential";
  }
  if (state.recoveryCodeShowing) return "recovery";
  return null;
}
