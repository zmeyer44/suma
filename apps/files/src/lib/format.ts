/**
 * Pure display formatters. No DOM access — unit-tested in vitest's node
 * environment.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Human byte count on a 1024 base.
 *
 * Binary, not decimal, on purpose: `checkQuota` derives its "100 GB" wording
 * from `limitBytes / 1024 ** 3`, so a decimal formatter would render the same
 * `PRO_QUOTA_BYTES` as "107.4 GB" and make the quota meter disagree with the
 * sentence printed right next to it.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${rounded.replace(/\.0$/, "")} ${BYTE_UNITS[unit]}`;
}

/** "1 file" / "4 files" — avoids a pluralization library for two words. */
export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export interface Progress {
  /** 0..1 when the total is known, null when it is not. */
  fraction: number | null;
  /** "1.2 MB of 3.4 MB", or just the received count when no total is known. */
  label: string;
  /** "42%" or "" when indeterminate. */
  percentLabel: string;
}

export function progressOf(receivedBytes: number, totalBytes: number): Progress {
  const received = Math.max(0, receivedBytes);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return { fraction: null, label: formatBytes(received), percentLabel: "" };
  }
  const fraction = Math.min(1, received / totalBytes);
  return {
    fraction,
    label: `${formatBytes(received)} of ${formatBytes(totalBytes)}`,
    percentLabel: `${Math.round(fraction * 100)}%`,
  };
}

/** Compact relative time: "just now", "4m ago", "2h ago", "3d ago". */
export function agoLabel(ms: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Last path segment, or the path itself when it has none. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Whatever an unknown thrown value can honestly be called. */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return fallback;
}
