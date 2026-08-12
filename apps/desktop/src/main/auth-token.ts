/**
 * Pure device-token refresh scheduling (PRD §8.2 short-lived tokens: expiring
 * tokens are silently re-minted before exp). No I/O — unit tests exercise
 * this directly; ControlClient owns the timers.
 */

import { fromBase64, fromUtf8 } from "@suma/protocol";

/** Re-mint this long before exp (schedule at exp - 60 s per spec §7). */
export const TOKEN_REFRESH_LEEWAY_SECONDS = 60;

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

/**
 * `exp` (epoch seconds) from a compact JWT; null for opaque tokens — the dev
 * control plane's structured `hbr_dev_…` bearers carry no exp and never
 * schedule a refresh.
 */
export function tokenExpSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(fromUtf8(base64urlDecode(parts[1] as string))) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : null;
  } catch {
    return null;
  }
}

/** Should the client refresh now? True once inside the leeway window. */
export function shouldRefreshToken(
  expSeconds: number,
  nowSeconds: number,
  leewaySeconds: number = TOKEN_REFRESH_LEEWAY_SECONDS,
): boolean {
  return nowSeconds >= expSeconds - leewaySeconds;
}

/** Delay until the proactive refresh should fire; 0 when already due. */
export function refreshDelayMs(
  expSeconds: number,
  nowMs: number,
  leewaySeconds: number = TOKEN_REFRESH_LEEWAY_SECONDS,
): number {
  return Math.max(0, (expSeconds - leewaySeconds) * 1000 - nowMs);
}
