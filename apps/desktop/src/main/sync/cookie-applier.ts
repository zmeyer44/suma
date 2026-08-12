/**
 * ElectronCookieApplier — applies engine-accepted records to a space
 * session's cookie store (PRD §8.3 hydration/apply path). The engine calls
 * this only for records that won conflict resolution.
 */

import type { Session } from "electron";
import type { Cause, CookieIdentity, CookiePlain } from "@suma/protocol";
import type { CookieApplier } from "@suma/sync-engine";
import { collateralFor, lostCollateral, restoreDetailsFor } from "./collateral";
import { removeTargetFor, setDetailsForPlain } from "./cookie-map";

export class ElectronCookieApplier implements CookieApplier {
  constructor(
    private readonly session: Session,
    private readonly disabled: (host: string, name: string) => boolean = () => false,
  ) {}

  canApply(plain: CookiePlain): boolean {
    return !this.disabled(plain.identity.hostKey, plain.identity.name);
  }

  async apply(plain: CookiePlain, _cause: Cause): Promise<void> {
    if (!this.canApply(plain)) return;
    if (plain.deleted || plain.attributes === null) {
      await this.removeSurgically(plain.identity);
      return;
    }
    const details = setDetailsForPlain(plain);
    try {
      await this.session.cookies.set(details);
    } catch (err) {
      // Chromium silently refuses cookies whose reconstructed url/attributes
      // don't satisfy its rules (__Host-/__Secure- prefixes, SameSite=None
      // without Secure, domain/url mismatch). That refusal is exactly a
      // logged-out site on this device, so surface it instead of swallowing.
      console.warn(
        `[suma cookie-sync] FAILED to set ${plain.identity.hostKey} ${plain.identity.name} ` +
          `(url=${details.url} secure=${details.secure} sameSite=${details.sameSite}): ${String(err)}`,
      );
      throw err;
    }
    console.log(`[suma cookie-sync] applied ${plain.identity.hostKey} ${plain.identity.name}`);
  }

  /**
   * cookies.remove(url, name) cannot disambiguate cookies sharing a name
   * across host-only vs domain scope or across paths, so it may take out
   * siblings of the tombstoned cookie. Snapshot the name's cookies first,
   * remove, then re-set any non-target cookie that disappeared.
   */
  private async removeSurgically(identity: CookieIdentity): Promise<void> {
    const target = removeTargetFor(identity);
    const before = await this.session.cookies.get({ name: identity.name });
    const collateral = collateralFor(identity, before);
    await this.session.cookies.remove(target.url, target.name);
    if (collateral.length === 0) return;
    const after = await this.session.cookies.get({ name: identity.name });
    for (const lost of lostCollateral(collateral, after)) {
      await this.session.cookies.set(restoreDetailsFor(identity.spaceId, lost));
    }
  }
}
