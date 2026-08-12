/**
 * Pure display formatters for the chrome renderer (downloads, presence).
 * No DOM access — unit-tested in vitest's node environment.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human byte count: "0 B", "512 B", "1.2 KB", "3.4 MB", "1.1 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${rounded.replace(/\.0$/, "")} ${BYTE_UNITS[unit]}`;
}

export interface DownloadProgress {
  /** 0..1 when the total is known, null for indeterminate downloads. */
  fraction: number | null;
  /** "1.2 MB of 3.4 MB" | "1.2 MB" when the server sent no length. */
  label: string;
}

export function downloadProgress(receivedBytes: number, totalBytes: number): DownloadProgress {
  const received = Math.max(0, receivedBytes);
  if (totalBytes > 0) {
    return {
      fraction: Math.min(1, received / totalBytes),
      label: `${formatBytes(received)} of ${formatBytes(totalBytes)}`,
    };
  }
  return { fraction: null, label: formatBytes(received) };
}

/** mm:ss, and h:mm:ss past an hour. "0:00" while the duration is unknown. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  if (h === 0) return `${String(m)}:${ss}`;
  return `${String(h)}:${String(m).padStart(2, "0")}:${ss}`;
}

/** Compact relative time: "just now", "4m ago", "2h ago", "3d ago". */
export function agoLabel(ms: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
