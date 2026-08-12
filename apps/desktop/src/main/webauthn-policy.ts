/**
 * Passkey (WebAuthn) support policy. Pure — imported by unit tests; no
 * Electron here.
 *
 * Background, stated honestly because it decides what the product can claim
 * (PRD §4 Assisted mode, §8.1 credential management):
 *
 * Electron did not implement the browser side of WebAuthn on macOS until
 * `app.configureWebAuthn({ touchID })` shipped (Electron 41/42). On that API,
 * credentials live in the Secure Enclave under a **keychain access group**,
 * and macOS only honors the group if the same value appears in the app's
 * `keychain-access-groups` code-signing entitlement. So passkeys work in a
 * signed, correctly-entitled build — and cannot work in an unsigned local
 * `electron-vite dev` run, no matter what the code does.
 *
 * Suma therefore decides support at runtime and tells the truth about it,
 * rather than letting a ceremony fail silently with `NotAllowedError`.
 */

export type PasskeySupport =
  /** Platform authenticator configured; Touch ID ceremonies should work. */
  | "available"
  /** Build is not signed/entitled for the keychain access group. */
  | "unsigned-build"
  /** This Electron/platform has no platform authenticator. */
  | "unsupported-platform";

export interface PasskeyEnvironment {
  platform: string;
  /** app.isPackaged — dev runs are unsigned. */
  packaged: boolean;
  /** Does the Electron runtime expose app.configureWebAuthn? */
  hasConfigureWebAuthn: boolean;
  /** Apple Team ID, from the build environment. */
  teamId: string | undefined;
  bundleId: string;
}

export interface PasskeyPlan {
  support: PasskeySupport;
  /** Set when support === "available": the group to configure and entitle. */
  keychainAccessGroup?: string;
  /** User-facing explanation; shown in settings and on assisted reauth. */
  detail: string;
}

/**
 * The keychain access group Apple's tooling expects for a browser storing
 * WebAuthn credentials: `<TEAM_ID>.<BUNDLE_ID>.webauthn`.
 */
export function keychainAccessGroupFor(teamId: string, bundleId: string): string {
  return `${teamId}.${bundleId}.webauthn`;
}

export function planPasskeySupport(env: PasskeyEnvironment): PasskeyPlan {
  if (env.platform !== "darwin") {
    return {
      support: "unsupported-platform",
      detail: "Suma's platform authenticator is macOS-only in V1.",
    };
  }
  if (!env.hasConfigureWebAuthn) {
    return {
      support: "unsupported-platform",
      detail:
        "This Electron runtime has no platform authenticator. Passkey sign-in falls back to a password or security key.",
    };
  }
  if (!env.packaged || env.teamId === undefined || env.teamId.length === 0) {
    return {
      support: "unsigned-build",
      detail:
        "Touch ID passkeys need a signed build whose keychain-access-groups entitlement matches. In a development run, sign in with a password or a security key.",
    };
  }
  return {
    support: "available",
    keychainAccessGroup: keychainAccessGroupFor(env.teamId, env.bundleId),
    // Stated plainly because it contradicts the usual passkey mental model:
    // Secure-Enclave credentials do not sync through iCloud Keychain, so a
    // passkey enrolled here is Device-bound in §4 terms — another Mac must
    // enroll its own, and Suma must not imply otherwise.
    detail:
      "Touch ID is ready on this Mac. Passkeys enrolled here stay on this Mac — they are not synced through iCloud Keychain, so another Mac enrolls its own.",
  };
}

/** One account offered during a discoverable-credential ceremony. */
export interface PasskeyAccountChoice {
  credentialId: string;
  name: string;
  detail: string;
}

/**
 * Shape the account list for the picker: prefer the human identifier
 * (`name`, typically an email), fall back to `displayName`, then to a
 * truncated credential id so an entry is never blank.
 */
export function toAccountChoices(
  accounts: ReadonlyArray<{ credentialId: string; name?: string; displayName?: string }>,
  relyingPartyId: string,
): PasskeyAccountChoice[] {
  return accounts.map((account) => {
    const primary = account.name ?? account.displayName ?? `Passkey ${account.credentialId.slice(0, 8)}`;
    const secondary =
      account.displayName !== undefined && account.displayName !== primary
        ? `${account.displayName} · ${relyingPartyId}`
        : relyingPartyId;
    return { credentialId: account.credentialId, name: primary, detail: secondary };
  });
}
