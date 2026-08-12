/**
 * Revocation outbox drain (PRD §8.2). When the session-hub notification at
 * revoke time fails — or the hub wasn't reachable — the revocation is durably
 * queued here and retried until it lands, so a revoked device's live sockets
 * are eventually closed rather than lingering because one HTTP call failed.
 * Drained opportunistically on each revoke and periodically by the server.
 */

import { eq, isNull } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { revocationOutbox } from "./db/schema.js";
import type { HubRevocationNotifier } from "./revocation.js";

/** Stop retrying a single revocation after this many failed deliveries. */
export const MAX_OUTBOX_ATTEMPTS = 20;

export interface OutboxFlushResult {
  delivered: number;
  pending: number;
}

export async function flushRevocationOutbox(
  db: Db,
  notify: HubRevocationNotifier,
): Promise<OutboxFlushResult> {
  const rows = await db.select().from(revocationOutbox).where(isNull(revocationOutbox.deliveredAt));
  let delivered = 0;
  let pending = 0;
  for (const row of rows) {
    if (row.attempts >= MAX_OUTBOX_ATTEMPTS) continue;
    try {
      const ok = await notify(row.userId, row.deviceId);
      if (ok) {
        await db
          .update(revocationOutbox)
          .set({ deliveredAt: new Date() })
          .where(eq(revocationOutbox.id, row.id));
        delivered += 1;
      } else {
        // No hub configured yet — leave the row pending WITHOUT burning an
        // attempt, so it still delivers once a hub is wired up.
        pending += 1;
      }
    } catch {
      await db
        .update(revocationOutbox)
        .set({ attempts: row.attempts + 1 })
        .where(eq(revocationOutbox.id, row.id));
      pending += 1;
    }
  }
  return { delivered, pending };
}

/**
 * Periodic drain loop for the long-running server. Returns a stop function.
 * `now`-free: uses the platform timer; the caller owns lifecycle.
 */
export function startOutboxDrain(
  db: Db,
  notify: HubRevocationNotifier,
  intervalMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    void flushRevocationOutbox(db, notify).catch((err) => {
      console.error("revocation outbox drain failed:", err);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
