/**
 * Continuity model (PRD §4). Every origin has a continuity mode surfaced in
 * the UI; the supported-origin corpus assigns modes, sync tiers, and the
 * flags that pick conflict strategy (rotating-auth ⇒ origin lease).
 */

export type ContinuityMode = "portable" | "assisted" | "device_bound";

export type SyncTier = 0 | 1 | 2; // 0 = not synced

export interface OriginPolicy {
  /** Registrable domain the policy applies to; matches the host and all subdomains. */
  domain: string;
  /** Human label for the sign-in queue and continuity UI. */
  label: string;
  mode: ContinuityMode;
  syncTier: SyncTier;
  /**
   * Origin uses refresh-token rotation or aggressive session security —
   * cookie writes require the origin lease (single-writer handoff); LWW is
   * reserved for origins where it is provably safe (§8.3).
   */
  rotatingAuth: boolean;
  /** Banks, corporate SSO, user-flagged — excluded from sync unless opted in (§4). */
  sensitive: boolean;
  /** Tier-2 localStorage sync proven necessary for this origin. */
  localStorageSync?: boolean;
  notes?: string;
}

/** Default for origins outside the tested corpus: workspace restores, reauth is one-touch, nothing synced silently. */
export const UNTESTED_ORIGIN_POLICY: OriginPolicy = {
  domain: "",
  label: "Untested origin",
  mode: "assisted",
  syncTier: 0,
  rotatingAuth: false,
  sensitive: false,
};

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Longest-suffix match of a host against corpus policies; returns the
 * untested-origin default when nothing matches.
 */
export function matchOriginPolicy(
  policies: ReadonlyArray<OriginPolicy>,
  host: string,
): OriginPolicy {
  const h = host.toLowerCase().replace(/^\./, "");
  let best: OriginPolicy | undefined;
  for (const p of policies) {
    if (hostMatchesDomain(h, p.domain) && (!best || p.domain.length > best.domain.length)) {
      best = p;
    }
  }
  return best ?? UNTESTED_ORIGIN_POLICY;
}

/** Per-origin continuity metrics tracked by the compatibility pipeline (§4). */
export interface OriginContinuityMetrics {
  domain: string;
  automaticRestoreRate: number;
  assistedReauthRate: number;
  unexpectedChallengeRate: number;
  sessionCorruptionRate: number;
  sampleSize: number;
  measuredAtMs: number;
}
