/**
 * Live-record partition for spaces that have already hydrated (PRD §8.3).
 *
 * After first hydration, remote cookie records are normally staged behind the
 * explicit Sync control so a broadcast can't disturb a site mid-use. Rotating-
 * auth origins invert that trade-off: the server retires the previous cookie
 * generation on every rotation, so a staged record means this device is now
 * holding dead credentials and will be signed out on its next request — the
 * "running site" staging protects is precisely the one staleness kills. Those
 * records must be applied the moment they arrive; everything else keeps the
 * stage-for-explicit-Sync behavior.
 */

import type { CookieRecordWire } from "@suma/protocol";
import type { SpaceSyncEngine } from "@suma/sync-engine";

export type LivePartitionEngine = Pick<
  SpaceSyncEngine,
  "inspectRemoteIdentity" | "getOriginPolicyFor"
>;

export interface LivePartition {
  /** Rotating-auth records — apply now; staleness is a server-side logout. */
  autoApply: CookieRecordWire[];
  /** Everything else — stage for the explicit Sync control. */
  stage: CookieRecordWire[];
}

export async function partitionLiveRecords(
  engine: LivePartitionEngine,
  records: readonly CookieRecordWire[],
): Promise<LivePartition> {
  const autoApply: CookieRecordWire[] = [];
  const stage: CookieRecordWire[] = [];
  for (const record of records) {
    // Sealed records don't reveal their origin; inspection decrypts the
    // identity without mutating engine or browser state. A record this device
    // cannot open or verify is staged — the pull path will judge it again.
    const identity = await engine.inspectRemoteIdentity(record);
    if (identity !== null) {
      const view = engine.getOriginPolicyFor(identity.hostKey);
      if (view.policy.rotatingAuth && view.synced) {
        autoApply.push(record);
        continue;
      }
    }
    stage.push(record);
  }
  return { autoApply, stage };
}
