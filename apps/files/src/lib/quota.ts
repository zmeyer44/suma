/**
 * Quota presentation on top of the frozen `checkQuota` (§8.6: Pro 100 GB,
 * soft-block at the limit). Pure; unit-tested.
 *
 * Soft block means: new bytes are refused, nothing already stored is deleted
 * or hidden. Every string here has to keep saying that, because a user who
 * believes a full Files space starts dropping data will delete things in a
 * panic that they did not need to delete.
 */

import { checkQuota, type QuotaState } from "@suma/protocol";
import { formatBytes } from "./format";

export type QuotaTone = "ok" | "warn" | "danger";

export interface QuotaSummary {
  usedBytes: number;
  limitBytes: number;
  /** 0..1, clamped. */
  fraction: number;
  /** "78%". */
  percentLabel: string;
  /** "78 GB of 100 GB". */
  usageLabel: string;
  tone: QuotaTone;
  /** At or over the limit: writes refused, reads untouched. */
  softBlocked: boolean;
  /** Headline sentence; "" when there is nothing worth saying. */
  note: string;
}

/** Above this share of the limit the meter starts warning. */
const WARN_FRACTION = 0.9;

export function summarizeQuota(state: QuotaState): QuotaSummary {
  const limitBytes = Math.max(0, state.limitBytes);
  const usedBytes = Math.max(0, state.usedBytes);
  const verdict = checkQuota({ usedBytes, limitBytes }, 0);
  const fraction = limitBytes > 0 ? Math.min(1, usedBytes / limitBytes) : 1;

  const tone: QuotaTone = verdict.softBlocked ? "danger" : fraction >= WARN_FRACTION ? "warn" : "ok";
  const note = verdict.softBlocked
    ? "Files is full. Everything already here stays available — free up space to add more."
    : tone === "warn"
      ? "Almost full."
      : "";

  return {
    usedBytes,
    limitBytes,
    fraction,
    percentLabel: `${Math.round(fraction * 100)}%`,
    usageLabel: `${formatBytes(usedBytes)} of ${formatBytes(limitBytes)}`,
    tone,
    softBlocked: verdict.softBlocked,
    note,
  };
}

export interface UploadAdmission {
  allowed: boolean;
  /** "" when allowed — the caller has nothing to tell the user. */
  message: string;
}

/**
 * Pre-flight for an upload, so a doomed upload is refused before its bytes are
 * read off disk. The control plane checks again and is authoritative; this is
 * courtesy, not enforcement.
 */
export function admitUpload(state: QuotaState, incomingBytes: number): UploadAdmission {
  const verdict = checkQuota(state, Math.max(0, incomingBytes));
  return { allowed: verdict.allowed, message: verdict.allowed ? "" : verdict.explanation };
}
