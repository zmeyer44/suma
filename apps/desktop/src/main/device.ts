/**
 * Device identity + per-space root secrets (PRD §8.2).
 *
 * TODO(keychain): move the Ed25519 private key and space root secrets out of
 * this chmod-600 JSON file into safeStorage / the Secure Enclave. Phase 1
 * wires passkey-PRF wrappers via the control plane (§8.2 key hierarchy);
 * this file is the unenrolled-first-run stand-in.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  fromBase64,
  generateDeviceKeypair,
  generateSpaceRootSecret,
  toBase64,
} from "@suma/protocol";

/** §8.2 enrollment against the control plane, persisted across restarts. */
export interface EnrollmentState {
  state: "unenrolled" | "signed-up" | "enrolled";
  controlUrl: string | null;
  email: string | null;
  /** The account's display name as the control plane knows it — what the UI
   *  greets the user by. Absent on records written before it was tracked. */
  displayName?: string | null;
  userId: string | null;
  deviceName: string | null;
  credentialKind: "webauthn" | "device-key" | null;
  /** Control-plane device row id (distinct from the local sync deviceId). */
  controlDeviceId: string | null;
  /** Dev bearer for control + hub — the signed-JWT stand-in. TODO(keychain). */
  authToken: string | null;
}

interface DeviceFile {
  deviceId: string;
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
  /** base64 per-space root secrets, keyed by space id. */
  spaceSecrets: Record<string, string>;
  /** base64 account workspace secret sealing workspace metadata docs (§8.3). */
  workspaceSecret?: string;
  enrollment?: EnrollmentState;
}

export interface DeviceIdentity {
  deviceId: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

const UNENROLLED: EnrollmentState = {
  state: "unenrolled",
  controlUrl: null,
  email: null,
  displayName: null,
  userId: null,
  deviceName: null,
  credentialKind: null,
  controlDeviceId: null,
  authToken: null,
};

export class DeviceStore {
  private constructor(
    private readonly filePath: string,
    private readonly file: DeviceFile,
    readonly identity: DeviceIdentity,
  ) {}

  static async load(userDataDir: string): Promise<DeviceStore> {
    mkdirSync(userDataDir, { recursive: true });
    const filePath = path.join(userDataDir, "device.json");
    if (existsSync(filePath)) {
      const file = JSON.parse(readFileSync(filePath, "utf8")) as DeviceFile;
      const privateKey = await crypto.subtle.importKey("jwk", file.privateKeyJwk, "Ed25519", true, [
        "sign",
      ]);
      const publicKey = await crypto.subtle.importKey("jwk", file.publicKeyJwk, "Ed25519", true, [
        "verify",
      ]);
      return new DeviceStore(filePath, file, { deviceId: file.deviceId, publicKey, privateKey });
    }
    const pair = await generateDeviceKeypair();
    const file: DeviceFile = {
      deviceId: randomUUID(),
      privateKeyJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
      publicKeyJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
      spaceSecrets: {},
    };
    const store = new DeviceStore(filePath, file, {
      deviceId: file.deviceId,
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
    });
    store.persist();
    return store;
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  /** Per-space root secret, generated on first use (§8.2 key hierarchy). */
  spaceRootSecret(spaceId: string): Uint8Array {
    const existing = this.file.spaceSecrets[spaceId];
    if (existing !== undefined) return fromBase64(existing);
    const secret = generateSpaceRootSecret();
    this.file.spaceSecrets[spaceId] = toBase64(secret);
    this.persist();
    return secret;
  }

  /** Adopt a recovered space root secret (auth:recoverKeys, §8.2). */
  setSpaceRootSecret(spaceId: string, secret: Uint8Array): void {
    this.file.spaceSecrets[spaceId] = toBase64(secret);
    this.persist();
  }

  /**
   * Per-account workspace secret sealing the globally-synced workspace docs
   * (§8.3) — generated on first use, moved between devices only via recovery
   * wrappers (§8.2), never invented per publish.
   */
  workspaceSecret(): Uint8Array {
    const existing = this.file.workspaceSecret;
    if (existing !== undefined) return fromBase64(existing);
    const secret = generateSpaceRootSecret();
    this.file.workspaceSecret = toBase64(secret);
    this.persist();
    return secret;
  }

  setWorkspaceSecret(secret: Uint8Array): void {
    this.file.workspaceSecret = toBase64(secret);
    this.persist();
  }

  enrollment(): EnrollmentState {
    return { ...UNENROLLED, ...this.file.enrollment };
  }

  setEnrollment(patch: Partial<EnrollmentState>): EnrollmentState {
    this.file.enrollment = { ...this.enrollment(), ...patch };
    this.persist();
    return this.enrollment();
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
