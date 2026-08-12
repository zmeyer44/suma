/**
 * The honest device-revocation contract (PRD §8.2): revocation kills Suma
 * certs and DO sessions within 60 s, but it CANNOT invalidate third-party
 * sessions already copied to an offline stolen machine. The response says so
 * explicitly and points at each origin's own remote-logout controls.
 */

import { SEED_CORPUS } from "@suma/config";

export interface AffectedOrigin {
  domain: string;
  label: string;
  remoteLogoutUrl?: string;
}

const REMOTE_LOGOUT_URLS: Readonly<Record<string, string>> = {
  "github.com": "https://github.com/settings/sessions",
  "google.com": "https://myaccount.google.com/device-activity",
  "slack.com": "https://my.slack.com/account/settings#sessions",
};

/** Tier-1 synced origins — the sessions a stolen device may still hold. */
export function affectedOriginsOnRevoke(): AffectedOrigin[] {
  return SEED_CORPUS.filter((o) => o.syncTier === 1).map((o) => {
    const remoteLogoutUrl = REMOTE_LOGOUT_URLS[o.domain];
    return remoteLogoutUrl
      ? { domain: o.domain, label: o.label, remoteLogoutUrl }
      : { domain: o.domain, label: o.label };
  });
}

/* ------------------------------------------------------------------ *
 * Hub propagation (Phase 1): live sockets must die ≤ 60 s (PRD §8.2)
 * ------------------------------------------------------------------ */

/** Reads SESSIONHUB_ADMIN_URL and SESSIONHUB_ADMIN_TOKEN. */
export type SessionHubEnv = Record<string, string | undefined>;

/**
 * Resolves true when the hub acknowledged, false when no hub is configured;
 * throws on delivery failure (the caller enqueues a revocation_outbox row).
 */
export type HubRevocationNotifier = (userId: string, deviceId: string) => Promise<boolean>;

export async function notifyHubRevocation(
  env: SessionHubEnv,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const url = env["SESSIONHUB_ADMIN_URL"];
  const token = env["SESSIONHUB_ADMIN_TOKEN"];
  if (!url || !token) return false;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId, deviceId }),
  });
  if (!res.ok) throw new Error(`hub revocation endpoint responded ${res.status}`);
  return true;
}

export function envHubNotifier(env: SessionHubEnv): HubRevocationNotifier {
  return (userId, deviceId) => notifyHubRevocation(env, userId, deviceId);
}
