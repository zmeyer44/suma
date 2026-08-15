import type { WaitlistStatus } from "@/lib/waitlist-store";

/**
 * The two waitlist forms on the page — the hero capture and the closing
 * section — share one stored spot and announce a join on one event, so a
 * sign-up in either place opens the ticket in both.
 */

/** Your spot, remembered locally so a return visit reopens the ticket. */
export const WAITLIST_STORAGE_KEY = "suma.waitlist";
/** A referral code seen on arrival, held for the length of the visit. */
export const WAITLIST_REF_KEY = "suma.waitlist.ref";
/** Fired on `window` with a `WaitlistJoined` detail after a successful join. */
export const WAITLIST_JOINED_EVENT = "suma:waitlist:joined";

export type WaitlistJoined = WaitlistStatus & {
  email: string;
  alreadyJoined: boolean;
  inviteCode: string | null;
};
