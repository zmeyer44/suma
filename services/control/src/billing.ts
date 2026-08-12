/**
 * Usage metering money math (PRD §11). All prices come straight from the §11
 * unit-economics table (per active Pro user / month) — nothing invented:
 *
 *   Compute VM (2 GB, resumed hours)   $1.50–3.50   → hourlyRateUsd × hours
 *   Proxied bandwidth (NA/EU)          $0.02/GB
 *   Volume (30 GB NVMe)                ~$4.50 flat
 *   R2 (100 GB + ops; $0 egress)       ~$1.60 flat
 *   Total active                       ≈ $13–17
 *
 * The compute rate itself lives in @suma/protocol (hourlyRateUsd /
 * accruedCostUsd) so the client cost meter and this estimate cannot drift.
 */

import { accruedCostUsd } from "@suma/protocol";

export const EGRESS_USD_PER_GB = 0.02;
export const VOLUME_USD_PER_MONTH = 4.5;
export const R2_USD_PER_MONTH = 1.6;
/** §11 "Total active ≈ $13–17": a Pro plan absorbs up to the upper bound. */
export const PRO_ALLOWANCE_USD = 17;
/** Bandwidth is priced in decimal gigabytes. */
export const BYTES_PER_GB = 1_000_000_000;

export interface MachineRate {
  memoryMb: number;
  cpus: number;
}

export interface UsageTotals {
  awakeMs: number;
  proxiedBytes: number;
}

/** The line items the UI cost meter renders (§11). */
export interface MonthlyCostEstimate {
  computeHours: number;
  computeUsd: number;
  egressGb: number;
  egressUsd: number;
  volumeUsd: number;
  r2Usd: number;
  totalUsd: number;
  withinPlan: boolean;
}

const usd = (n: number): number => Number(n.toFixed(4));

export function estimateMonthlyCost(spec: MachineRate, usage: UsageTotals): MonthlyCostEstimate {
  const computeUsd = accruedCostUsd(spec.memoryMb, spec.cpus, usage.awakeMs);
  const egressGb = usage.proxiedBytes / BYTES_PER_GB;
  const egressUsd = usd(egressGb * EGRESS_USD_PER_GB);
  const totalUsd = usd(computeUsd + egressUsd + VOLUME_USD_PER_MONTH + R2_USD_PER_MONTH);
  return {
    computeHours: usd(usage.awakeMs / 3_600_000),
    computeUsd,
    egressGb: usd(egressGb),
    egressUsd,
    volumeUsd: VOLUME_USD_PER_MONTH,
    r2Usd: R2_USD_PER_MONTH,
    totalUsd,
    withinPlan: totalUsd <= PRO_ALLOWANCE_USD,
  };
}
