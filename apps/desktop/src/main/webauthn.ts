/**
 * WebAuthnService — passkey sign-in wiring (PRD §4 Assisted continuity,
 * §8.1 credential management).
 *
 * Two responsibilities:
 *
 *  1. **Enable the macOS platform authenticator.** `app.configureWebAuthn`
 *     points Chromium's Touch ID authenticator at a keychain access group.
 *     Without it, `navigator.credentials.get()` fails with `NotAllowedError`
 *     on macOS — which is exactly the "passkey auth isn't working" symptom.
 *  2. **Own the account picker.** When a discoverable-credential request
 *     matches several passkeys, Electron fires `select-webauthn-account` and
 *     the ceremony stays pending until we answer. Electron ships no UI for
 *     this, so Suma shows its own in-window picker; if no listener answers,
 *     the page gets `NotAllowedError`.
 *
 * The callback contract is strict: invoke it exactly once. Every path here —
 * user choice, cancel, timeout, renderer gone — funnels through `settle()`.
 */

import { app, type Session, type WebAuthnAccount } from "electron";
import { clearTimeout, setTimeout } from "node:timers";
import { randomUUID } from "node:crypto";
import type { PasskeyAccountRequest, PasskeyStatus } from "../shared/ipc";
import { planPasskeySupport, toAccountChoices, type PasskeyPlan } from "./webauthn-policy";

/** How long the picker waits before cancelling the ceremony. */
const PICKER_TIMEOUT_MS = 120_000;

interface PendingRequest {
  respond: (credentialId: string | null) => void;
  timer: NodeJS.Timeout;
}

export interface WebAuthnServiceDeps {
  /** Push the picker to the chrome renderer. */
  emitRequest: (request: PasskeyAccountRequest) => void;
  /** Withdraw a picker that timed out or whose frame went away. */
  emitCancelled: (requestId: string) => void;
  /** Bring the shell forward — the picker is useless behind another window. */
  focusShell: () => void;
}

export class WebAuthnService {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly plan: PasskeyPlan;

  constructor(private readonly deps: WebAuthnServiceDeps) {
    this.plan = planPasskeySupport({
      platform: process.platform,
      packaged: app.isPackaged,
      // Present only on Electron ≥ 41; older runtimes have no platform
      // authenticator at all on macOS.
      hasConfigureWebAuthn: typeof app.configureWebAuthn === "function",
      teamId: process.env["SUMA_APPLE_TEAM_ID"],
      bundleId: process.env["SUMA_BUNDLE_ID"] ?? "com.sumabrowser.app",
    });

    if (this.plan.support === "available" && this.plan.keychainAccessGroup !== undefined) {
      app.configureWebAuthn({
        touchID: {
          keychainAccessGroup: this.plan.keychainAccessGroup,
          // macOS renders: "Suma" is trying to <reason>. $1 is the RP id.
          promptReason: "sign you in to $1",
        },
      });
    }
  }

  status(): PasskeyStatus {
    return { support: this.plan.support, detail: this.plan.detail };
  }

  /** Attach the account-picker handler to a space session. */
  attachToSession(ses: Session): void {
    ses.on("select-webauthn-account", (_event, details, callback) => {
      this.offerAccounts(details.relyingPartyId, details.accounts, callback);
    });
  }

  /** Resolve a picker from the renderer's choice (null ⇒ user cancelled). */
  chooseAccount(requestId: string, credentialId: string | null): void {
    this.pending.get(requestId)?.respond(credentialId);
  }

  /** Cancel every outstanding ceremony (shutdown). */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.pending.get(requestId)?.respond(null);
    }
  }

  private offerAccounts(
    relyingPartyId: string,
    accounts: WebAuthnAccount[],
    callback: (credentialId?: string | null) => void,
  ): void {
    const choices = toAccountChoices(accounts, relyingPartyId);
    // A single credential needs no picker — answering immediately keeps the
    // ceremony to one Touch ID prompt, which is the Arc-like feel.
    if (choices.length === 1 && choices[0] !== undefined) {
      callback(choices[0].credentialId);
      return;
    }
    if (choices.length === 0) {
      callback(null);
      return;
    }

    const requestId = randomUUID();
    let settled = false;
    const settle = (credentialId: string | null): void => {
      if (settled) return;
      settled = true;
      const entry = this.pending.get(requestId);
      if (entry !== undefined) clearTimeout(entry.timer);
      this.pending.delete(requestId);
      callback(credentialId);
    };

    const timer = setTimeout(() => {
      this.deps.emitCancelled(requestId);
      settle(null);
    }, PICKER_TIMEOUT_MS);
    timer.unref();

    this.pending.set(requestId, { respond: settle, timer });
    this.deps.focusShell();
    this.deps.emitRequest({ requestId, relyingPartyId, accounts: choices });
  }
}
