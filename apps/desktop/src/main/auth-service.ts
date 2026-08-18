/**
 * AuthService — the `auth:*` IPC surface (PRD §8.2 enrollment/recovery/
 * revocation). The default flow is the DEVICE-KEY credential path: signup,
 * then registerDeviceCredential (the Ed25519 identity in device.ts becomes
 * the enrolled credential) — after which the WsTransport gets a real hub
 * token. WebAuthn cannot run in the main process and control has no
 * begin/finish endpoints yet, so auth:passkeyBegin/Finish report the honest
 * fallback and the device-key path stays authoritative.
 *
 * With no SUMA_CONTROL_URL (and no controlUrl passed to signup) the
 * service runs in local-only mode: status stays unenrolled, sync keeps the
 * LoopbackTransport, and everything works offline with no control plane.
 */

import {
  deriveKekFromPassphrase,
  deriveKekFromRecoveryCode,
  deviceLoginSigningBytes,
  exportPublicKeyRaw,
  fromBase64,
  generateEnrollmentCode,
  generateRecoveryCode,
  toBase64,
  unwrapRootSecret,
  wrapRootSecret,
} from "@suma/protocol";
import type {
  EnrollmentStatus,
  PasskeyStatus,
  RevocationReceipt,
} from "../shared/ipc";
import { ControlClient, DEFAULT_CONTROL_URL } from "./control-client";
import type { DeviceStore } from "./device";
import { WORKSPACE_PSEUDO_SPACE_ID } from "./sync/workspace-map";
import type { WorkspaceStore } from "./workspace-store";

/**
 * Recovery wrappers anchor to the account's default control-plane space (the
 * control API scopes wrappers per space it owns), while `credentialId`
 * carries which LOCAL space's root secret is wrapped — the AAD binds the
 * wrapped bytes to that local space id.
 */
const RECOVERY_CREDENTIAL_PREFIX = "recovery:";
const RECOVERY_SALT_BYTES = 16;
/** credentialId prefix for a secret carried by an enrollment code (§8.2). */
const ENROLLMENT_CREDENTIAL_PREFIX = "enroll:";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface AuthDeps {
  device: DeviceStore;
  store: WorkspaceStore;
  /** SUMA_CONTROL_URL; null = local-only until signup passes a controlUrl. */
  controlUrl: string | null;
  emitChanged: (status: EnrollmentStatus) => void;
  /** Token changes require a clean hub reconnect (§8.2). */
  onTokenChanged: () => void;
  /** The control plane told us where the session hub lives (§7 discovery). */
  onHubUrl?: (url: string) => void;
  /** Friendly default derived from this machine's Computer Name. */
  suggestedDeviceName: string;
  /** Real platform-authenticator support, from the WebAuthn service. */
  passkeySupport?: () => PasskeyStatus;
  fetchImpl?: typeof fetch;
}

export class AuthService {
  private client: ControlClient | null = null;
  /** Set when this device joined via an enrollment code: its secrets came
   *  from the linking device, so enroll must not overwrite the account's
   *  recovery wrappers with a fresh random-secret code (§8.2). */
  private linkedViaCode = false;

  constructor(private readonly deps: AuthDeps) {
    const enrollment = deps.device.enrollment();
    const url = enrollment.controlUrl ?? deps.controlUrl;
    if (url !== null) {
      this.client = this.buildClient(url);
      this.client.setToken(enrollment.authToken);
      // An already-enrolled device restored at startup may hold a signed token
      // that lapsed while the app was closed — wire reauth so the client can
      // re-mint it from a fresh device-login proof (§8.2).
      if (
        enrollment.state === "enrolled" &&
        enrollment.controlDeviceId !== null
      ) {
        this.wireReauth(this.client, enrollment.controlDeviceId);
        // Restored enrolled session: ask where the session hub lives so sync
        // can leave the loopback stub. Fire-and-forget — resolves long after
        // bootstrap has finished wiring the services.
        void this.refreshHubUrl();
      }
    }
  }

  /** Fetch /v1/me for plane discovery; quiet on failure (offline start). */
  private async refreshHubUrl(): Promise<void> {
    try {
      const me = await this.client?.me();
      const hubUrl = me?.hubUrl;
      if (typeof hubUrl === "string" && hubUrl.length > 0)
        this.deps.onHubUrl?.(hubUrl);
      // Backfill the compute mode for linked devices and records written
      // before modes existed (null = unknown, treated as cloud meanwhile).
      const mode = me?.user.computeMode;
      if (
        (mode === "cloud" || mode === "local") &&
        this.deps.device.enrollment().computeMode !== mode
      ) {
        this.deps.device.setEnrollment({ computeMode: mode });
        this.notifyChanged();
      }
    } catch {
      // Control unreachable — the next enroll/startup will retry.
    }
  }

  /** Ed25519 device-login proof over the control-issued challenge (§8.2). */
  private async signChallenge(
    controlDeviceId: string,
    challenge: string,
  ): Promise<string> {
    const sig = await crypto.subtle.sign(
      "Ed25519",
      this.deps.device.identity.privateKey,
      deviceLoginSigningBytes(controlDeviceId, challenge) as BufferSource,
    );
    return toBase64(new Uint8Array(sig));
  }

  /** Give the client a way to re-mint a token from a full device-login proof. */
  private wireReauth(client: ControlClient, controlDeviceId: string): void {
    client.setReauth(async () => {
      try {
        const challenge = await client.deviceChallenge(controlDeviceId);
        const signature = await this.signChallenge(controlDeviceId, challenge);
        const out = await client.deviceLogin({
          deviceId: controlDeviceId,
          signature,
        });
        this.deps.device.setEnrollment({ authToken: out.deviceToken });
        return out.deviceToken;
      } catch {
        return null; // offline or revoked — client decides how to surface it
      }
    });
  }

  /** Device token for the WsTransport; null while unenrolled/local-only. */
  async getToken(): Promise<string | null> {
    return this.client === null ? null : this.client.getToken();
  }

  /** Authenticated control client for the Phase-2 services (machine status,
   *  Job Mode, audit trail); null in local-only mode. Re-read per call — it
   *  appears the moment signup configures a control plane. */
  controlClient(): ControlClient | null {
    return this.client;
  }

  status(): EnrollmentStatus {
    const e = this.deps.device.enrollment();
    return {
      state: e.state,
      // The CONFIGURED control plane, not just the enrolled one: before
      // signup the enrollment record has no URL, but the UI must already
      // know a control plane exists (it gates the §11 invite-code field and
      // the "running locally" copy on exactly this).
      controlUrl: e.controlUrl ?? this.deps.controlUrl,
      email: e.email,
      displayName: e.displayName ?? null,
      userId: e.userId,
      deviceId: this.deps.device.deviceId,
      deviceName: e.deviceName,
      suggestedDeviceName: this.deps.suggestedDeviceName,
      passkeyRegistered: e.credentialKind !== null,
      credentialKind: e.credentialKind,
      computeMode: e.computeMode ?? null,
    };
  }

  async signup(args: {
    email: string;
    displayName?: string;
    controlUrl?: string;
    /** §11: required against a control plane with the invite gate on. */
    inviteCode?: string;
    /** Onboarding's computer choice; omitted ⇒ the control plane's default (cloud). */
    computeMode?: "cloud" | "local";
  }): Promise<EnrollmentStatus> {
    const url = args.controlUrl ?? this.deps.controlUrl ?? DEFAULT_CONTROL_URL;
    this.client = this.buildClient(url);
    const out = await this.client.signup(
      args.email,
      args.displayName,
      args.inviteCode,
      args.computeMode,
    );
    this.deps.device.setEnrollment({
      state: "signed-up",
      controlUrl: url,
      email: out.user.email,
      displayName: out.user.displayName,
      userId: out.user.id,
      computeMode: out.user.computeMode ?? args.computeMode ?? "cloud",
      isHomeMachine: null,
      // Persist the SIGNED bootstrap token when the server minted one: a
      // control plane with env signing keys rejects the hbr_dev_ stub, so
      // storing the stub here stranded any restart between signup and enroll.
      authToken: out.bootstrapToken ?? `hbr_dev_${out.user.id}`,
    });
    this.notifyChanged();
    return this.status();
  }

  /**
   * Mint a code an about-to-enroll second device signs in with (§8.2). The
   * code is generated HERE and only its hash is sent up; the account's space +
   * workspace secrets are sealed under a KEK derived from the code, so the
   * linked device gets real key material end-to-end and the server, holding
   * only ciphertext + hash, can never open a session.
   */
  async mintEnrollmentCode(): Promise<{ code: string; expiresAt: string }> {
    const client = this.requireClient();
    const code = generateEnrollmentCode();
    const salt = new Uint8Array(RECOVERY_SALT_BYTES);
    crypto.getRandomValues(salt);
    const kek = await deriveKekFromPassphrase(code, salt);
    const localSpaceIds = [
      ...this.deps.store.spaces().map((space) => space.id),
      WORKSPACE_PSEUDO_SPACE_ID,
    ];
    const wrappers: Array<{ credentialId: string; wrapped: string }> = [];
    for (const localSpaceId of localSpaceIds) {
      const secret =
        localSpaceId === WORKSPACE_PSEUDO_SPACE_ID
          ? this.deps.device.workspaceSecret()
          : this.deps.device.spaceRootSecret(localSpaceId);
      wrappers.push({
        credentialId: `${ENROLLMENT_CREDENTIAL_PREFIX}${localSpaceId}`,
        wrapped: toBase64(await wrapRootSecret(kek, secret, localSpaceId)),
      });
    }
    const { expiresAt } = await client.mintEnrollmentCode({
      codeHash: await sha256Hex(code),
      wrapSalt: toBase64(salt),
      wrappers,
    });
    return { code, expiresAt };
  }

  /**
   * Fresh-device sign-in from an enrollment code minted on an already-
   * enrolled device. Installs the transferred space/workspace secrets so the
   * device can open synced records, then leaves it in "signed-up" state for
   * the normal `enroll()` flow to complete the credential (§8.2).
   */
  async signinWithCode(args: {
    code: string;
    controlUrl?: string;
  }): Promise<EnrollmentStatus> {
    const url = args.controlUrl ?? this.deps.controlUrl ?? DEFAULT_CONTROL_URL;
    this.client = this.buildClient(url);
    const code = args.code.trim();
    const redeemed = await this.client.redeemEnrollmentCode(code);

    // Install the transferred secrets BEFORE anything derives keys, so the
    // sync engine never seals under a fresh random stand-in (§8.2 gap fix).
    if (redeemed.wrapSalt !== undefined && redeemed.wrappers !== undefined) {
      const kek = await deriveKekFromPassphrase(
        code,
        fromBase64(redeemed.wrapSalt),
      );
      for (const wrapper of redeemed.wrappers) {
        if (!wrapper.credentialId.startsWith(ENROLLMENT_CREDENTIAL_PREFIX))
          continue;
        const localSpaceId = wrapper.credentialId.slice(
          ENROLLMENT_CREDENTIAL_PREFIX.length,
        );
        try {
          const secret = await unwrapRootSecret(
            kek,
            fromBase64(wrapper.wrapped),
            localSpaceId,
          );
          if (localSpaceId === WORKSPACE_PSEUDO_SPACE_ID) {
            this.deps.device.setWorkspaceSecret(secret);
          } else {
            this.deps.device.setSpaceRootSecret(localSpaceId, secret);
          }
        } catch {
          // A tampered/mismatched wrapper — skip it; enroll still proceeds.
        }
      }
      this.linkedViaCode = true;
    }

    this.deps.device.setEnrollment({
      state: "signed-up",
      controlUrl: url,
      email: redeemed.user.email,
      displayName: redeemed.user.displayName,
      userId: redeemed.user.id,
      computeMode: redeemed.user.computeMode ?? null,
      isHomeMachine: null,
      authToken: redeemed.bootstrapToken,
    });
    this.notifyChanged();
    return this.status();
  }

  /** Enroll this device's key as the account credential (§8.2 device-key path). */
  async enroll(name: string): Promise<EnrollmentStatus> {
    const client = this.requireClient();
    const enrollment = this.deps.device.enrollment();
    if (enrollment.state === "enrolled" && enrollment.authToken !== null) {
      return this.status(); // idempotent — already enrolled
    }
    const devicePublicKey = toBase64(
      await exportPublicKeyRaw(this.deps.device.identity.publicKey),
    );
    const { device, isHomeMachine } = await client.enrollDevice({
      name,
      platform: process.platform,
      devicePublicKey,
    });
    // Register the device's identity key as a login credential and mint the
    // first SIGNED device token (§8.2). This is the token the hub verifies
    // against CONTROL_PUBLIC_KEY; the dev-stub hubToken from /devices/enroll is
    // only a fallback for a hub running without a configured public key.
    const challenge = await client.deviceChallenge(device.id);
    const signature = await this.signChallenge(device.id, challenge);
    let authToken: string;
    try {
      const cred = await client.registerDeviceCredential({
        deviceId: device.id,
        devicePublicKey,
        signature,
      });
      authToken = cred.deviceToken;
      this.wireReauth(client, device.id);
    } catch {
      // A control plane without the signed-token routes (older deploy) still
      // works via the device-bound dev stub.
      authToken = `hbr_dev_${enrollment.userId ?? ""}.${device.id}`;
    }
    client.setToken(authToken);
    this.deps.device.setEnrollment({
      state: "enrolled",
      deviceName: name,
      credentialKind: "device-key",
      controlDeviceId: device.id,
      authToken,
      isHomeMachine:
        enrollment.computeMode === "local" && typeof isHomeMachine === "boolean"
          ? isHomeMachine
          : null,
    });
    // A code-linked device already shares the account's secrets and its
    // recovery code (minted by the linking device). Re-uploading here would
    // overwrite the account's workspace recovery wrapper (fixed credentialId)
    // with this device's copy under a new code and mislead the user with a
    // second "recovery code" — so skip it entirely (§8.2 clobber fix).
    const recoveryCode = this.linkedViaCode
      ? null
      : await this.uploadRecoveryWrappers(client);
    this.notifyChanged();
    // Enrollment complete — discover the session hub so sync goes live.
    void this.refreshHubUrl();
    // The recovery code appears ONLY in this response — shown once (§8.2).
    return recoveryCode === null
      ? this.status()
      : { ...this.status(), recoveryCode };
  }

  async registerDeviceCredential(): Promise<EnrollmentStatus> {
    return this.enroll(
      this.deps.device.enrollment().deviceName ?? this.deps.suggestedDeviceName,
    );
  }

  /**
   * The account-passkey ceremony runs in the renderer (navigator.credentials
   * lives there) against the control plane's /v1/auth/webauthn routes. What
   * gates it is the platform authenticator itself: Touch ID credentials live
   * in the Secure Enclave under a keychain access group that macOS only honors
   * in a signed, entitled build, so an unsigned dev run genuinely cannot
   * complete a ceremony (see webauthn-policy.ts).
   *
   * Rather than hand the renderer options that would fail mid-ceremony with
   * NotAllowedError, report the real runtime support signal and let the wizard
   * fall back to the device-key credential — which is the authoritative path
   * in V1 either way (§8.2).
   */
  passkeyBegin(): { options: unknown } {
    const support = this.deps.passkeySupport?.() ?? {
      support: "unsupported-platform" as const,
      detail: "Passkey support has not been determined on this device.",
    };
    return {
      options: {
        available: false,
        fallback: "device-key",
        support: support.support,
        message: `${support.detail} Suma is using this Mac's device key instead.`,
      },
    };
  }

  passkeyFinish(_credential: unknown): EnrollmentStatus {
    return this.status(); // device-key path stays authoritative
  }

  /** Recover space root secrets on a fresh device from the recovery code (§8.2). */
  async recoverKeys(
    recoveryCode: string,
  ): Promise<{ spacesRecovered: number }> {
    const client = this.requireClient();
    const kekCache = new Map<string, CryptoKey>();
    let spacesRecovered = 0;
    let sawWrapper = false;
    let workspaceRecovered = false;
    for (const space of await client.listSpaces()) {
      for (const wrapper of await client.listWrappers(space.id)) {
        if (wrapper.kind !== "recovery-code") continue;
        if (!wrapper.credentialId.startsWith(RECOVERY_CREDENTIAL_PREFIX))
          continue;
        sawWrapper = true;
        const localSpaceId = wrapper.credentialId.slice(
          RECOVERY_CREDENTIAL_PREFIX.length,
        );
        try {
          let kek = kekCache.get(wrapper.salt);
          if (kek === undefined) {
            kek = await deriveKekFromRecoveryCode(
              recoveryCode,
              fromBase64(wrapper.salt),
            );
            kekCache.set(wrapper.salt, kek);
          }
          const secret = await unwrapRootSecret(
            kek,
            fromBase64(wrapper.wrapped),
            localSpaceId,
          );
          if (localSpaceId === WORKSPACE_PSEUDO_SPACE_ID) {
            this.deps.device.setWorkspaceSecret(secret);
            workspaceRecovered = true;
          } else {
            this.deps.device.setSpaceRootSecret(localSpaceId, secret);
            spacesRecovered += 1;
          }
        } catch {
          // Wrong code or a wrapper from a rotated secret — skip this wrapper.
        }
      }
    }
    if (sawWrapper && spacesRecovered === 0) {
      throw new Error("that recovery code did not unlock any space keys");
    }
    // The account workspace secret just changed under the running sync service.
    // Reuse the token-changed bridge (→ SyncService.refreshAuth) so it
    // re-derives the workspace key and re-dials; otherwise the live service
    // keeps sealing/opening with the fresh device's stale stand-in key and
    // workspace metadata never converges until restart (§8.2).
    if (workspaceRecovered) this.deps.onTokenChanged();
    return { spacesRecovered };
  }

  async revoke(deviceId: string, reason?: string): Promise<RevocationReceipt> {
    const client = this.requireClient();
    const out = await client.revokeDevice(deviceId, reason);
    // The §8.2 honest contract passes through verbatim — the UI shows it as-is.
    return {
      deviceId: out.device.id,
      stoppedFutureAccess: out.stoppedFutureAccess,
      purgeOnReconnect: out.purgeOnReconnect,
      cannotInvalidateThirdPartySessions:
        out.cannotInvalidateThirdPartySessions,
      affectedOrigins: out.affectedOrigins,
    };
  }

  async renameDevice(deviceId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error("device name must not be empty");
    const client = this.requireClient();
    const renamed = await client.renameDevice(deviceId, trimmed);
    const enrollment = this.deps.device.enrollment();
    if (enrollment.controlDeviceId === renamed.id) {
      this.deps.device.setEnrollment({ deviceName: renamed.name });
      this.notifyChanged();
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private buildClient(url: string): ControlClient {
    return new ControlClient(url, this.deps.fetchImpl ?? fetch, () => {
      // 401: the token is dead (revocation or expiry) — drop it and surface
      // the change; the user re-enrolls from the UI.
      this.deps.device.setEnrollment({ authToken: null });
      this.notifyChanged();
    });
  }

  private requireClient(): ControlClient {
    if (this.client === null) {
      throw new Error(
        "no control plane configured — set SUMA_CONTROL_URL or pass controlUrl to auth:signup (local-only mode)",
      );
    }
    return this.client;
  }

  /**
   * One recovery code wraps every local space secret + the workspace secret.
   * Null when the upload fails — enrollment stands, but no code is shown, so
   * the user is never handed a code that cannot recover anything.
   */
  private async uploadRecoveryWrappers(
    client: ControlClient,
  ): Promise<string | null> {
    try {
      const controlSpaces = await client.listSpaces();
      const anchor =
        controlSpaces[0] ??
        (await client.createSpace({ name: "Personal", color: "#3B82F6" }));
      const code = generateRecoveryCode();
      const salt = new Uint8Array(RECOVERY_SALT_BYTES);
      crypto.getRandomValues(salt);
      const kek = await deriveKekFromRecoveryCode(code, salt);
      const localSpaceIds = [
        ...this.deps.store.spaces().map((space) => space.id),
        WORKSPACE_PSEUDO_SPACE_ID,
      ];
      for (const localSpaceId of localSpaceIds) {
        const secret =
          localSpaceId === WORKSPACE_PSEUDO_SPACE_ID
            ? this.deps.device.workspaceSecret()
            : this.deps.device.spaceRootSecret(localSpaceId);
        await client.putWrapper(anchor.id, {
          kind: "recovery-code",
          credentialId: `${RECOVERY_CREDENTIAL_PREFIX}${localSpaceId}`,
          salt: toBase64(salt),
          wrapped: toBase64(await wrapRootSecret(kek, secret, localSpaceId)),
        });
      }
      return code;
    } catch (err) {
      console.error("suma auth: recovery wrapper upload failed", err);
      return null;
    }
  }

  private notifyChanged(): void {
    this.deps.emitChanged(this.status());
    this.deps.onTokenChanged();
  }
}
