/**
 * ControlClient — typed fetch wrapper over the Suma control plane
 * (services/control; SUMA_CONTROL_URL, default http://localhost:8787).
 *
 * Token model: the dev control plane issues structured bearers —
 * `hbr_dev_<userId>` at signup (bootstrap) and `hbr_dev_<userId>.<deviceId>`
 * at device enrollment (device-bound; dies with revocation). The client holds
 * the current token, schedules a proactive refresh at exp - 60 s (live only
 * once control mints exp-bearing signed JWTs — dev bearers carry no exp), and
 * drops the token on any 401 so the UI can surface re-enrollment.
 */

import { clearTimeout, setTimeout } from "node:timers";
import {
  refreshDelayMs,
  shouldRefreshToken,
  tokenExpSeconds,
} from "./auth-token";

export const DEFAULT_CONTROL_URL = "http://localhost:8787";

/**
 * The hosted control plane packaged builds talk to. A `.app` launched from
 * Finder inherits no shell environment, so SUMA_CONTROL_URL is never set
 * there — without this a shipped build reported itself local-only and hid
 * the "Link this Mac" path in onboarding (§8.2). SUMA_CONTROL_URL still wins
 * when it IS set, so dev runs and the e2e harness are unaffected.
 */
export const PROD_CONTROL_URL = "https://api.sumabrowser.com";

export interface ControlUser {
  id: string;
  email: string;
  displayName: string | null;
  /** Where the account's computer lives; absent on older control planes. */
  computeMode?: "cloud" | "local";
}

export interface ControlSpace {
  id: string;
  name: string;
  color: string;
  position: number;
  egressPolicy: "suma-ip" | "direct";
}

export interface ControlDevice {
  id: string;
  name: string;
  platform: string;
  enrolledAt?: string;
  lastSeenAt?: string | null;
  revokedAt: string | null;
  revoked?: boolean;
}

export interface ControlWrapper {
  id: string;
  spaceId: string;
  kind:
    | "passkey-prf"
    | "recovery-code"
    | "hardware-key"
    | "kms"
    | "enrollment-code";
  credentialId: string;
  salt: string;
  wrapped: string;
}

export interface ControlRevokeResponse {
  device: ControlDevice;
  stoppedFutureAccess: boolean;
  purgeOnReconnect: boolean;
  cannotInvalidateThirdPartySessions: boolean;
  affectedOrigins: Array<{
    domain: string;
    label: string;
    remoteLogoutUrl?: string;
  }>;
}

export interface DeviceTokenResponse {
  deviceToken: string;
  exp: number;
  credentialKind?: "device-key" | "webauthn";
}

/* ---- Phase 2: compute lifecycle, Job Mode, audit (PRD §8.5, §8.7) ---- */

export interface ControlMachine {
  id: string;
  state: string;
  region: string;
  cpuKind: string;
  cpus: number;
  memoryMb: number;
  /** host:port of the in-VM agent, set by the sandbox provider at provision
   *  time; null until a real provider has reported one. */
  agentAddress?: string | null;
  lastTransitionAt: string | null;
}

export interface ControlMachineEvent {
  id: string;
  machineId: string;
  fromState: string;
  toState: string;
  reconstructed: boolean;
  detail: string | null;
  createdAt: string;
}

export interface ControlLifecycle {
  verdict: unknown;
  explanation: string;
  wouldSuspendAt: string | null;
}

export interface ControlAuditEvent {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  actorDeviceId: string | null;
  createdAt: string;
  /** Server-side human summary (Phase-2 control); absent on older deploys. */
  summary?: string;
}

export class ControlClient {
  private token: string | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  /** Full device-login proof, set by AuthService — used when a token refresh
   *  is rejected (e.g. the token lapsed while offline) to re-mint from scratch. */
  private reauth: (() => Promise<string | null>) | null = null;
  /** In-flight proof, so concurrent 401s share one device-login. */
  private reauthInFlight: Promise<string | null> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onUnauthorized?: () => void,
  ) {}

  setReauth(fn: (() => Promise<string | null>) | null): void {
    this.reauth = fn;
  }

  get url(): string {
    return this.baseUrl;
  }

  setToken(token: string | null): void {
    this.token = token;
    this.scheduleRefresh();
  }

  /** Current device token for the hub edge; refreshes first when due. */
  async getToken(): Promise<string | null> {
    const token = this.token;
    if (token !== null) {
      const exp = tokenExpSeconds(token);
      if (exp !== null && shouldRefreshToken(exp, Date.now() / 1000))
        await this.refresh();
    }
    return this.token;
  }

  /* ------------------------------ endpoints ------------------------------ */

  async signup(
    email: string,
    displayName?: string,
    inviteCode?: string,
    computeMode?: "cloud" | "local",
  ): Promise<{
    user: ControlUser;
    space: ControlSpace;
    bootstrapToken?: string;
  }> {
    const body: {
      email: string;
      displayName?: string;
      inviteCode?: string;
      computeMode?: "cloud" | "local";
    } = {
      email,
    };
    if (displayName !== undefined && displayName.length > 0)
      body.displayName = displayName;
    if (inviteCode !== undefined && inviteCode.length > 0)
      body.inviteCode = inviteCode;
    if (computeMode !== undefined) body.computeMode = computeMode;
    const out = await this.request<{
      user: ControlUser;
      space: ControlSpace;
      bootstrapToken?: string;
    }>("POST", "/v1/accounts", body);
    // Prefer the signed bootstrap token (unforgeable, short-lived); fall back
    // to the unsigned dev stub for a control plane without a signing key.
    this.setToken(out.bootstrapToken ?? `hbr_dev_${out.user.id}`);
    return out;
  }

  /** Account overview — also carries plane discovery (hubUrl). */
  async me(): Promise<{
    user: ControlUser;
    spaces: ControlSpace[];
    machine: ControlMachine | null;
    deviceCount: number;
    /** ws endpoint of the deployed session hub; null = no hub (loopback sync). */
    hubUrl?: string | null;
  }> {
    return this.request("GET", "/v1/me");
  }

  /**
   * Register a second-device enrollment code. The code is generated and hashed
   * on THIS device — the server sees only the hash and the sealed key wrappers
   * it cannot open (§8.2 key transfer). Returns when the record is stored.
   */
  async mintEnrollmentCode(payload: {
    codeHash: string;
    wrapSalt?: string;
    wrappers?: Array<{ credentialId: string; wrapped: string }>;
  }): Promise<{ expiresAt: string }> {
    return this.request<{ expiresAt: string }>(
      "POST",
      "/v1/devices/enrollment-code",
      payload,
    );
  }

  /** Trade an enrollment code for the account's signed bootstrap token and the
   *  sealed key wrappers (§8.2). Public route; the caller unwraps locally. */
  async redeemEnrollmentCode(code: string): Promise<{
    user: ControlUser;
    bootstrapToken: string;
    wrapSalt?: string;
    wrappers?: Array<{ credentialId: string; wrapped: string }>;
  }> {
    const out = await this.requestNoReauth<{
      user: ControlUser;
      bootstrapToken: string;
      wrapSalt?: string;
      wrappers?: Array<{ credentialId: string; wrapped: string }>;
    }>("POST", "/v1/auth/enrollment-code/redeem", { code });
    this.setToken(out.bootstrapToken);
    return out;
  }

  /**
   * One-time challenge for a device-credential/device-login proof (§8.2).
   *
   * `noReauth`: this call and `deviceLogin` below ARE the re-auth proof. Letting
   * them trigger another one would recurse into the proof that is already
   * running.
   */
  async deviceChallenge(controlDeviceId: string): Promise<string> {
    return (
      await this.requestNoReauth<{ challenge: string }>(
        "POST",
        "/v1/auth/device-challenge",
        {
          deviceId: controlDeviceId,
        },
      )
    ).challenge;
  }

  /** Register this device's Ed25519 identity key as a login credential and
   *  receive the first signed device token (§8.2 device-key path). Public
   *  route — self-authenticating via the proof signature. */
  async registerDeviceCredential(args: {
    deviceId: string;
    devicePublicKey: string;
    signature: string;
  }): Promise<DeviceTokenResponse> {
    return this.requestNoReauth<DeviceTokenResponse>(
      "POST",
      "/v1/auth/device-credential",
      args,
    );
  }

  /** Prove possession of the enrolled device key and mint a signed token. */
  async deviceLogin(args: {
    deviceId: string;
    signature: string;
  }): Promise<DeviceTokenResponse> {
    return this.requestNoReauth<DeviceTokenResponse>(
      "POST",
      "/v1/auth/device-login",
      args,
    );
  }

  async enrollDevice(args: {
    name: string;
    platform: string;
    devicePublicKey: string;
  }): Promise<{
    device: ControlDevice;
    hubToken: string;
    /** Absent on control planes predating local compute mode. */
    isHomeMachine?: boolean;
  }> {
    const out = await this.request<{
      device: ControlDevice;
      hubToken: string;
      isHomeMachine?: boolean;
    }>("POST", "/v1/devices/enroll", args);
    this.setToken(out.hubToken);
    return out;
  }

  async listDevices(): Promise<ControlDevice[]> {
    return (
      await this.request<{ devices: ControlDevice[] }>("GET", "/v1/devices")
    ).devices;
  }

  /**
   * A single-use Gemini Live token for one voice conversation, minted from
   * the operator's key inside the control plane (services/control's
   * /v1/ai/voice/token). This is the voice assistant's equivalent of the
   * chat sidebar's vended gateway: no Gemini key is ever stored on, or sent
   * to, this Mac. Short-lived and single-use, so it is fetched per session
   * and never cached.
   */
  async mintVoiceToken(model: string): Promise<{
    token: string;
    expiresAt: string;
  }> {
    return this.request<{ token: string; expiresAt: string }>(
      "POST",
      "/v1/ai/voice/token",
      { model },
    );
  }

  async renameDevice(deviceId: string, name: string): Promise<ControlDevice> {
    return (
      await this.request<{ device: ControlDevice }>(
        "PATCH",
        `/v1/devices/${encodeURIComponent(deviceId)}`,
        { name },
      )
    ).device;
  }

  async revokeDevice(
    deviceId: string,
    reason?: string,
  ): Promise<ControlRevokeResponse> {
    return this.request<ControlRevokeResponse>(
      "POST",
      `/v1/devices/${encodeURIComponent(deviceId)}/revoke`,
      reason === undefined ? {} : { reason },
    );
  }

  async listSpaces(): Promise<ControlSpace[]> {
    return (await this.request<{ spaces: ControlSpace[] }>("GET", "/v1/spaces"))
      .spaces;
  }

  async createSpace(args: {
    name: string;
    color: string;
    egressPolicy?: "suma-ip" | "direct";
  }): Promise<ControlSpace> {
    return (
      await this.request<{ space: ControlSpace }>("POST", "/v1/spaces", args)
    ).space;
  }

  async patchSpace(
    spaceId: string,
    patch: Partial<
      Pick<ControlSpace, "name" | "color" | "position" | "egressPolicy">
    >,
  ): Promise<ControlSpace> {
    return (
      await this.request<{ space: ControlSpace }>(
        "PATCH",
        `/v1/spaces/${encodeURIComponent(spaceId)}`,
        patch,
      )
    ).space;
  }

  async listWrappers(spaceId: string): Promise<ControlWrapper[]> {
    return (
      await this.request<{ wrappers: ControlWrapper[] }>(
        "GET",
        `/v1/spaces/${encodeURIComponent(spaceId)}/wrappers`,
      )
    ).wrappers;
  }

  async putWrapper(
    spaceId: string,
    wrapper: {
      kind: ControlWrapper["kind"];
      credentialId: string;
      salt: string;
      wrapped: string;
    },
  ): Promise<ControlWrapper> {
    return (
      await this.request<{ wrapper: ControlWrapper }>(
        "POST",
        `/v1/spaces/${encodeURIComponent(spaceId)}/wrappers`,
        wrapper,
      )
    ).wrapper;
  }

  /* ---------------- Phase 2: machine / Job Mode / audit ------------------ */

  async getMachine(): Promise<{
    /** Absent on control planes that predate compute modes (⇒ cloud). */
    mode?: "cloud" | "local";
    machine: ControlMachine | null;
    events: ControlMachineEvent[];
    /** Local mode: the one enrolled device that owns the computer seat. */
    homeDeviceId?: string | null;
  }> {
    return this.request<{
      mode?: "cloud" | "local";
      machine: ControlMachine | null;
      events: ControlMachineEvent[];
      homeDeviceId?: string | null;
    }>("GET", "/v1/machine");
  }

  /** Phase-2 route; null when the deployed control plane predates it. */
  async getMachineLifecycle(): Promise<ControlLifecycle | null> {
    return this.requestOptional<ControlLifecycle>(
      "GET",
      "/v1/machine/lifecycle",
    );
  }

  async transitionMachine(
    to: string,
    opts?: { reconstructed?: boolean; detail?: string },
  ): Promise<{ machine: ControlMachine; event: ControlMachineEvent }> {
    return this.request<{
      machine: ControlMachine;
      event: ControlMachineEvent;
    }>("POST", "/v1/machine/transition", { to, ...opts });
  }

  async boostMachine(memoryMb: number): Promise<{ machine: ControlMachine }> {
    return this.request<{ machine: ControlMachine }>(
      "POST",
      "/v1/machine/boost",
      { memoryMb },
    );
  }

  /** Job Mode (§8.5) — pins the machine awake. Null when the Phase-2 route
   *  is not deployed yet; the agent-side flag is still set in that case. */
  async setJobMode(
    ptyId: string,
    enabled: boolean,
  ): Promise<{ verdict: unknown } | null> {
    return this.requestOptional<{ verdict: unknown }>(
      "POST",
      "/v1/machine/job-mode",
      {
        ptyId,
        enabled,
      },
    );
  }

  async listAudit(limit: number): Promise<ControlAuditEvent[]> {
    return (
      await this.request<{ events: ControlAuditEvent[] }>(
        "GET",
        `/v1/audit?limit=${limit}`,
      )
    ).events;
  }

  /* ------------------------------ internals ------------------------------ */

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const token = this.token;
    if (token === null) return;
    const exp = tokenExpSeconds(token);
    if (exp === null) return; // dev bearers never expire
    this.refreshTimer = setTimeout(
      () => {
        this.refreshTimer = null;
        void this.refresh();
      },
      refreshDelayMs(exp, Date.now()),
    );
    this.refreshTimer.unref();
  }

  /**
   * Re-mint the signed device token ahead of exp (§8.2). Tries
   * POST /v1/auth/token/refresh with the current bearer (valid unexpired
   * token → new token). If that is rejected — the token lapsed while offline,
   * or the device was revoked — fall back to a full device-login proof via
   * the injected reauth. Only a proof failure clears the token and surfaces
   * onUnauthorized (revocation); a network error keeps the current token so a
   * transient outage doesn't log the user out.
   */
  private async refresh(): Promise<void> {
    const token = this.token;
    if (token === null) return;
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/v1/auth/token/refresh`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: "{}",
        },
      );
      if (res.ok) {
        const out = (await res.json()) as DeviceTokenResponse;
        this.setToken(out.deviceToken);
        return;
      }
      if (res.status === 401 && this.reauth !== null) {
        const fresh = await this.reauth();
        if (fresh !== null) {
          this.setToken(fresh);
          return;
        }
        this.setToken(null);
        this.onUnauthorized?.();
      }
      // Non-401 (server error) — keep the current token and retry next cycle.
    } catch {
      // Network error: keep the token; the WS layer handles offline state.
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const out = await this.send<T>(method, path, body, false);
    if (out === null)
      throw new Error(`control: unexpected empty response (${method} ${path})`);
    return out;
  }

  /** Like request(), but never re-authenticates — for the auth primitives the
   *  proof itself is made of (they are public, self-authenticating routes). */
  private async requestNoReauth<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const out = await this.send<T>(method, path, body, false, false);
    if (out === null)
      throw new Error(`control: unexpected empty response (${method} ${path})`);
    return out;
  }

  /** Like request(), but a 404 resolves null — for Phase-2 routes that may
   *  not be deployed yet (the client must degrade, not break Phase 1). */
  private async requestOptional<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    return this.send<T>(method, path, body, true);
  }

  /**
   * One device-login proof at a time, shared by every caller waiting on it. A
   * burst of parallel 401s (the Files page alone fires list + quota +
   * transfers) must mint one token, not one each.
   */
  private async reauthOnce(): Promise<string | null> {
    const proof = this.reauth;
    if (proof === null) return null;
    if (this.reauthInFlight === null) {
      const attempt = (async (): Promise<string | null> => {
        try {
          return await proof();
        } catch {
          return null;
        }
      })();
      this.reauthInFlight = attempt;
      void attempt.finally(() => {
        if (this.reauthInFlight === attempt) this.reauthInFlight = null;
      });
    }
    return this.reauthInFlight;
  }

  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    missingOk: boolean,
    allowReauth = true,
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token !== null) headers["authorization"] = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `control plane unreachable at ${this.baseUrl} (${String(err)})`,
      );
    }
    if (missingOk && res.status === 404) return null;
    if (res.status === 401) {
      // A rejected token is not the same as a revoked device. The scheduled
      // pre-expiry refresh cannot cover a token the server stops accepting
      // early — key rotation, a clock skew, or one that lapsed while the app
      // was closed — and without this the client sat permanently unauthorized
      // with no way for the user to sign in again (§8.2). Prove possession of
      // the device key once and retry; only a failed proof means revoked.
      if (allowReauth && this.reauth !== null) {
        const fresh = await this.reauthOnce();
        if (fresh !== null) {
          this.setToken(fresh);
          // `allowReauth: false` — one retry, never a loop.
          return this.send<T>(method, path, body, missingOk, false);
        }
      }
      this.setToken(null);
      this.onUnauthorized?.();
      throw new Error(`control: unauthorized (${method} ${path})`);
    }
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const parsed = (await res.json()) as {
          error?: unknown;
          explanation?: unknown;
        };
        // A structured refusal ships its own user-facing sentence (e.g. the
        // §11 invite gate) — surface it instead of a bare code.
        if (typeof parsed.explanation === "string") detail = parsed.explanation;
        else if (typeof parsed.error === "string")
          detail = `${res.status} ${parsed.error}`;
      } catch {
        // non-JSON error body — the status code is enough
      }
      throw new Error(`control: ${detail} (${method} ${path})`);
    }
    return (await res.json()) as T;
  }
}
