/**
 * Cookie capture — subscribes a space session's cookies-'changed' stream
 * into the sync engine (PRD §8.3 Tier-1 capture).
 *
 * Capture is skipped entirely while the space is hydrating: bulk set()
 * during hydration must never be re-published as user mutations. The
 * engine's per-record echo tags cover any echoes that land after hydration
 * ends.
 */

import type { Cookie, Session } from "electron";
import type { SpaceSyncEngine } from "@suma/sync-engine";
import { attributesForCookie, identityForCookie } from "./cookie-map";

export interface CookieCapture {
  /** Stop observing new Chromium mutations. Already-observed work still drains. */
  detach(): void;
  /** Wait until every cookie event observed before this call has been sealed and
   * handed to the transport (or its offline queue). */
  drain(): Promise<void>;
}

export function attachCookieCapture(
  ses: Session,
  spaceId: string,
  engine: SpaceSyncEngine,
  isHydrating: () => boolean,
  onError: (err: unknown) => void,
  isDisabled: (cookie: Cookie) => boolean = () => false,
): CookieCapture {
  // Chromium commonly emits a whole Set-Cookie response as a burst. The sync
  // engine's rotating-auth lease is per origin, so processing that burst in
  // parallel lets same-origin lease requests race (and used to strand all but
  // one promise until timeout). One queue per space preserves browser order,
  // coalesces naturally behind the first lease grant, and gives workspace URL
  // sync a real drain barrier to await before it publishes a redirect target.
  let queue: Promise<void> = Promise.resolve();
  const listener = (
    _event: unknown,
    cookie: Cookie,
    cause: string,
    removed: boolean,
  ): void => {
    if (isHydrating() || isDisabled(cookie)) return;
    const identity = identityForCookie(spaceId, cookie);
    const attrs = removed ? null : attributesForCookie(cookie);
    // Chromium's cause string passes through untouched — causeForChange in
    // the engine maps it (overwrite-removal halves produce no record).
    queue = queue
      .then(async () => {
        await engine.localChange(identity, attrs, removed, cause);
      })
      .catch((err: unknown) => {
        // Keep the queue usable after one malformed/unpublishable cookie.
        onError(err);
      });
  };
  ses.cookies.on("changed", listener);
  return {
    detach: () => {
      ses.cookies.removeListener("changed", listener);
    },
    drain: async () => {
      await queue;
    },
  };
}
