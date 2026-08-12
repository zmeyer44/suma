/**
 * Per-user abuse controls (PRD §9: "port-25 block, rate caps, AUP tooling").
 * Pure limit checks — routes count the relevant events and ask; the DB never
 * appears here so every rule is unit-testable. The numeric caps are product
 * knobs to be re-derived from Phase 0 usage data; the STRUCTURE (a hard cap
 * with a human-readable refusal) is the contract.
 */

import { BYTES_PER_GB } from "./billing.js";

export const ABUSE_LIMITS = {
  /** §8.8: one VM and one $HOME per account (also enforced by schema unique). */
  maxConcurrentMachines: 1,
  /** §11 "fair Boost allowance" — each boost is an explicit stop/start. */
  maxBoostsPerDay: 5,
  /** §9 rate caps on proxied egress (the mini-ISP problem). */
  maxProxiedGbPerDay: 20,
  /**
   * Cloud fetches a single account may have in flight at once (§8.6). Each one
   * is work the VM will do and bytes the quota will be charged for, and a
   * transfer whose length the origin never declared is admitted against an
   * estimate — so the number of them has to be bounded by something other than
   * how fast a client can POST.
   */
  maxActiveTransfers: 32,
} as const;

/** §9: outbound SMTP is blocked unconditionally — spam egress is never a knob. */
export const port25Blocked = true;

export type AbuseCheck =
  | { allowed: true }
  | { allowed: false; limit: string; reason: string };

export function checkBoost(boostsInLastDay: number): AbuseCheck {
  if (boostsInLastDay >= ABUSE_LIMITS.maxBoostsPerDay) {
    return {
      allowed: false,
      limit: "boosts_per_day",
      reason: `Boost limit reached: ${boostsInLastDay} boosts in the last 24 hours (max ${ABUSE_LIMITS.maxBoostsPerDay}).`,
    };
  }
  return { allowed: true };
}

export function checkConcurrentMachines(activeMachines: number): AbuseCheck {
  if (activeMachines >= ABUSE_LIMITS.maxConcurrentMachines) {
    return {
      allowed: false,
      limit: "concurrent_machines",
      reason: `Machine limit reached: ${activeMachines} active (max ${ABUSE_LIMITS.maxConcurrentMachines}).`,
    };
  }
  return { allowed: true };
}

export function checkActiveTransfers(activeTransfers: number): AbuseCheck {
  if (activeTransfers >= ABUSE_LIMITS.maxActiveTransfers) {
    return {
      allowed: false,
      limit: "active_transfers",
      reason:
        `Transfer limit reached: ${activeTransfers} already queued or running ` +
        `(max ${ABUSE_LIMITS.maxActiveTransfers}). Existing transfers keep going.`,
    };
  }
  return { allowed: true };
}

/**
 * Egress caps are enforced by the gateway, not here — the usage summary
 * reports `throttled: true` and the gateway acts on it (spec §4).
 */
export function egressThrottled(proxiedBytesInLastDay: number): boolean {
  return proxiedBytesInLastDay > ABUSE_LIMITS.maxProxiedGbPerDay * BYTES_PER_GB;
}
