/**
 * EgressService — the egress:* IPC surface (PRD §8.4, §8.7). Applies the
 * shared @suma/egress-policy rules to every space session via
 * session.setProxy, tracks gateway health, fails closed when the gateway is
 * unreachable, and watches for challenge status codes to SUGGEST a per-site
 * bypass — never to apply one silently.
 *
 * Fail-closed mechanics: proxied spaces point at sumad's localhost CONNECT
 * proxy. When the gateway (or the daemon) is down, that port refuses
 * connections, so proxied traffic is blocked at the network stack — the
 * honest default when SUMA_EGRESS_URL is unset. The one-click
 * "browse direct for now" override is in-memory only and resets the moment
 * the gateway health probe comes back up (§8.4 — deliberately not sticky).
 *
 * QUIC note (§8.4): a CONNECT proxy tunnels TCP only; Chromium would race
 * HTTP/3 over UDP straight past it and leak the real IP. main/index.ts
 * appends --disable-quic before app ready whenever any persisted space is
 * proxied; a space switched to suma-ip mid-run gets the switch at next
 * launch (surfaced in the egress settings copy).
 */

import { clearInterval, setInterval } from "node:timers";
import type { OnCompletedListenerDetails, Session } from "electron";
import { normalizedHost } from "@suma/protocol";
import {
  decideEgress,
  proxyConfigFor,
  suggestBypassOnChallenge,
  type GatewayState,
  type NetworkContext,
  type SpaceEgressConfig,
} from "../../../../../packages/egress-policy/src/index";
import type { EgressDecisionInfo, EgressStatus } from "../../shared/ipc";
import type { SpaceManager } from "../spaces";
import type { WorkspaceStore } from "../workspace-store";
import {
  buildSpaceEgressConfig,
  egressPlaneState,
  egressStatusFor,
  mayProxyThisRun,
  shouldResetOverrides,
} from "./egress-state";

/** sumad's localhost CONNECT proxy (sidecar/src/main.rs LOCAL_PROXY_ADDR). */
export const LOCAL_PROXY_PORT = 7890;

const HEALTH_PROBE_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
const CHALLENGE_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);

export interface EgressDeps {
  spaces: SpaceManager;
  store: WorkspaceStore;
  /** SUMA_EGRESS_URL; null ⇒ gateway reported down, proxied spaces fail closed. */
  egressUrl: string | null;
  /**
   * Whether `--disable-quic` was appended before app ready. When false, no
   * space may be proxied this run: a CONNECT proxy tunnels TCP only, so
   * Chromium would race HTTP/3 over UDP past it and leak the real IP (§8.4).
   */
  quicDisabledAtStartup: boolean;
  emitChanged: (status: EgressStatus) => void;
  emitBypassSuggested: (suggestion: { spaceId: string; host: string; reason: string }) => void;
  fetchImpl?: typeof fetch;
}

export class EgressService {
  private gateway: GatewayState = "down";
  /** Space ids with an active "browse direct for now" (in-memory by design). */
  private readonly overrides = new Set<string>();
  /** `${spaceId}|${host}` pairs already suggested — suggest once, not per request. */
  private readonly suggested = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: EgressDeps) {}

  /** SpaceManager session hook — proxy rules + challenge watcher per session. */
  attachTo(ses: Session, spaceId: string): void {
    this.sessions.set(spaceId, ses);
    void this.applyProxy(spaceId);
    ses.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (details) =>
      this.onRequestCompleted(spaceId, details),
    );
  }

  status(spaceId: string): EgressStatus {
    return egressStatusFor(
      this.configFor(spaceId),
      this.gateway,
      false,
      this.deps.quicDisabledAtStartup,
    );
  }

  statuses(): EgressStatus[] {
    return this.deps.spaces.list().map((space) => this.status(space.id));
  }

  async setPolicy(spaceId: string, policy: "suma-ip" | "direct"): Promise<EgressStatus> {
    this.deps.spaces.update(spaceId, { egressPolicy: policy });
    if (policy === "direct") this.overrides.delete(spaceId);
    await this.applyProxy(spaceId);
    const status = this.status(spaceId);
    this.deps.emitChanged(status);
    return status;
  }

  /** §8.4 one-click escape hatch after the fail-closed banner. */
  async browseDirectForNow(spaceId: string): Promise<EgressStatus> {
    this.overrides.add(spaceId);
    await this.applyProxy(spaceId);
    const status = this.status(spaceId);
    this.deps.emitChanged(status);
    return status;
  }

  async setSiteBypass(spaceId: string, host: string, bypass: boolean): Promise<EgressStatus> {
    const normalized = normalizedHost(host);
    const stored = this.deps.store.egressConfig(spaceId) ?? { siteBypass: [], mediaBypass: true };
    const siteBypass = stored.siteBypass.filter((h) => h !== normalized);
    if (bypass) siteBypass.push(normalized);
    this.deps.store.setEgressConfig(spaceId, { ...stored, siteBypass });
    await this.applyProxy(spaceId);
    const status = this.status(spaceId);
    this.deps.emitChanged(status);
    return status;
  }

  /** §8.7: the routing decision for a host, explained — via decideEgress. */
  explain(spaceId: string, host: string): EgressDecisionInfo {
    const decision = decideEgress(host, this.configFor(spaceId), this.net());
    return { host: normalizedHost(host), route: decision.route, explanation: decision.explanation };
  }

  /** §10 failure-matrix rollup for PlaneHealth.egressPlane. */
  planeState(): "ok" | "down" | "bypassed" {
    return egressPlaneState(this.statuses());
  }

  start(): void {
    if (this.timer !== null) return;
    void this.probe();
    this.timer = setInterval(() => void this.probe(), HEALTH_PROBE_MS);
    this.timer.unref();
    // Space metadata can change under us (rename, policy sync from another
    // device) — reapply and republish rather than trusting our last apply.
    this.deps.spaces.onChanged(() => void this.reapplyAll(false));
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private configFor(spaceId: string): SpaceEgressConfig {
    return buildSpaceEgressConfig(
      spaceId,
      this.deps.spaces.get(spaceId)?.egressPolicy ?? "direct",
      this.deps.store.egressConfig(spaceId),
      this.overrides.has(spaceId),
    );
  }

  private net(): NetworkContext {
    // Corporate-VPN route detection is not implemented in this phase, so it
    // is reported honestly as absent rather than guessed.
    return { gateway: this.gateway, vpnRoutes: [], vpnActive: false };
  }

  private async applyProxy(spaceId: string): Promise<void> {
    const ses = this.sessions.get(spaceId);
    if (ses === undefined) return;
    const config = this.configFor(spaceId);
    // A space switched to the identity IP after startup cannot be routed this
    // run: --disable-quic only applies before app ready, and proxying with
    // QUIC live would leak the real IP over UDP for exactly the space the
    // user just asked to protect. Persist the choice, browse direct until the
    // next launch, and say so via status().restartRequired (§8.4).
    if (config.policy === "suma-ip" && !mayProxyThisRun(this.deps.quicDisabledAtStartup)) {
      await ses.setProxy({ proxyRules: "direct://", proxyBypassRules: "" });
      return;
    }
    // The temporary override routes the whole space direct while the gateway
    // is down; proxyConfigFor covers every other case (including fail-closed:
    // proxy rules at a dead local port block at the network stack).
    const chromium =
      config.policy === "suma-ip" && config.temporaryDirectOverride && this.gateway === "down"
        ? { proxyRules: "direct://", proxyBypassRules: "" }
        : proxyConfigFor(config, LOCAL_PROXY_PORT, this.net());
    await ses.setProxy({
      proxyRules: chromium.proxyRules,
      proxyBypassRules: chromium.proxyBypassRules,
    });
  }

  private async reapplyAll(emitAll: boolean): Promise<void> {
    for (const spaceId of this.sessions.keys()) await this.applyProxy(spaceId);
    if (emitAll) for (const status of this.statuses()) this.deps.emitChanged(status);
  }

  private onRequestCompleted(spaceId: string, details: OnCompletedListenerDetails): void {
    if (details.resourceType !== "mainFrame") return;
    if (!CHALLENGE_STATUSES.has(details.statusCode)) return;
    let host: string;
    try {
      host = new URL(details.url).hostname;
    } catch {
      return;
    }
    const suggestion = suggestBypassOnChallenge(host, details.statusCode, this.configFor(spaceId));
    if (suggestion === null) return;
    const key = `${spaceId}|${suggestion.host}`;
    if (this.suggested.has(key)) return;
    this.suggested.add(key);
    // Suggestion only — silently moving a site off the identity IP would
    // undermine the promise the space policy makes (§8.4).
    this.deps.emitBypassSuggested({ spaceId, host: suggestion.host, reason: suggestion.reason });
  }

  private async probe(): Promise<void> {
    const next = await this.probeGateway();
    if (next === this.gateway) return;
    if (shouldResetOverrides(this.gateway, next)) this.overrides.clear();
    this.gateway = next;
    await this.reapplyAll(true);
  }

  private async probeGateway(): Promise<GatewayState> {
    if (this.deps.egressUrl === null) return "down";
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(
        `${this.deps.egressUrl.replace(/\/+$/, "")}/healthz`,
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
      return res.ok ? "up" : "down";
    } catch {
      return "down";
    }
  }
}
