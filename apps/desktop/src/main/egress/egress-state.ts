/**
 * Pure egress-plane plumbing (PRD §8.4): stored per-space config → the
 * SpaceEgressConfig the shared policy module consumes, config + gateway
 * health → the EgressStatus the renderer shows, and the reset-on-reconnect
 * rule for "browse direct for now". Electron-free so vitest covers the rules.
 *
 * `@suma/egress-policy` is the source of truth for routing decisions. It is
 * not in the desktop app's dependency manifest (frozen this phase), so it is
 * imported by workspace path rather than reimplemented.
 */

import { readFileSync } from "node:fs";
import {
  defaultSpaceEgress,
  type GatewayState,
  type SpaceEgressConfig,
} from "../../../../../packages/egress-policy/src/index";
import type { EgressStatus } from "../../shared/ipc";

/** The slice of SpaceEgressConfig persisted in the workspace store. Policy
 *  itself lives on SpaceMeta (synced, §8.3); the temporary direct override is
 *  deliberately in-memory only — restart must fail closed, never direct. */
export interface StoredSpaceEgress {
  siteBypass: string[];
  mediaBypass: boolean;
}

export function buildSpaceEgressConfig(
  spaceId: string,
  policy: "suma-ip" | "direct",
  stored: StoredSpaceEgress | null,
  temporaryDirectOverride: boolean,
): SpaceEgressConfig {
  const base = defaultSpaceEgress(spaceId);
  return {
    spaceId,
    policy,
    siteBypass: stored === null ? [...base.siteBypass] : [...stored.siteBypass],
    mediaBypass: stored === null ? base.mediaBypass : stored.mediaBypass,
    temporaryDirectOverride,
  };
}

/** Config + gateway health → the renderer-visible egress state (§8.4, §8.7). */
export function egressStatusFor(
  config: SpaceEgressConfig,
  gateway: GatewayState,
  vpnActive: boolean,
  quicDisabledAtStartup = true,
): EgressStatus {
  // Configured for the identity IP but unroutable this run: proxying now
  // would leak over QUIC (see mayProxyThisRun).
  const restartRequired = config.policy === "suma-ip" && !quicDisabledAtStartup;
  return {
    spaceId: config.spaceId,
    policy: config.policy,
    gateway,
    temporaryDirectOverride: config.temporaryDirectOverride,
    mediaBypass: config.mediaBypass,
    siteBypass: [...config.siteBypass],
    // Not "failing closed" when the reason is a pending restart — the space
    // simply isn't proxied yet, and restartRequired says so explicitly.
    failClosed:
      config.policy === "suma-ip" &&
      !restartRequired &&
      gateway === "down" &&
      !config.temporaryDirectOverride,
    vpnActive,
    restartRequired,
  };
}

/**
 * §8.4: "browse direct for now" resets when the gateway comes back — it is
 * deliberately not sticky, so a temporary outage can never silently turn into
 * a permanent direct-browsing downgrade.
 */
export function shouldResetOverrides(previous: GatewayState, next: GatewayState): boolean {
  return previous === "down" && next === "up";
}

/** §10 failure-matrix rollup for PlaneHealth.egressPlane. */
export function egressPlaneState(
  statuses: ReadonlyArray<EgressStatus>,
): "ok" | "down" | "bypassed" {
  if (statuses.some((status) => status.failClosed)) return "down";
  if (statuses.some((status) => status.policy === "suma-ip" && status.temporaryDirectOverride)) {
    return "bypassed";
  }
  return "ok";
}

/** Pure core of the startup QUIC decision, split out for tests. */
export function parsedWorkspaceHasProxiedSpace(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  const spaces = (parsed as { spaces?: unknown }).spaces;
  if (!Array.isArray(spaces)) return false;
  return spaces.some(
    (space: unknown) =>
      typeof space === "object" &&
      space !== null &&
      (space as { egressPolicy?: unknown }).egressPolicy === "suma-ip",
  );
}

/**
 * Does any persisted space browse via the identity IP? Decides the startup
 * `--disable-quic` switch (§8.4 QUIC leak guard), which must be appended
 * before app ready — before any store or service exists — so this reads the
 * raw workspace file directly.
 */
export function workspaceHasProxiedSpace(workspacePath: string): boolean {
  try {
    return parsedWorkspaceHasProxiedSpace(JSON.parse(readFileSync(workspacePath, "utf8")));
  } catch {
    return false;
  }
}

/**
 * May this space be proxied during THIS run?
 *
 * `--disable-quic` can only be appended before app ready, so a space switched
 * to the identity IP mid-session would otherwise be proxied while QUIC is
 * still live — and Chromium races HTTP/3 over UDP straight past a CONNECT
 * proxy, exposing the real IP for exactly the space the user just asked to
 * protect. Rather than proxy with a known leak, the switch is persisted and
 * takes effect on the next launch (§8.4 QUIC leak guard).
 */
export function mayProxyThisRun(quicDisabledAtStartup: boolean): boolean {
  return quicDisabledAtStartup;
}

export const RESTART_REQUIRED_EXPLANATION =
  "Saved. This space starts using your Suma identity IP the next time you open Suma — " +
  "Suma won't route it now because it can't disable QUIC mid-session, and doing so would " +
  "leak your real IP over UDP.";
