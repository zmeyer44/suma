/**
 * Invite gating for signup (PRD §11: "Beta is invitation-only and paid. No
 * free tier at launch" — open signup + egress IPs + VMs is an abuse magnet).
 *
 * V1 implements the INVITATION half: POST /v1/accounts consumes a single-use
 * invite code, minted by an operator through /v1/admin/invites. Payment
 * verification remains a billing-integration follow-up; until it lands,
 * invites are the only admission control and are issued to paying design
 * partners by hand.
 *
 * Deployed entrypoints derive options from the environment, where the gate
 * DEFAULTS ON — an operator must explicitly set SUMA_INVITES_REQUIRED=0
 * (local development) to open signup. Unit tests construct createApp with the
 * gate off and opt in per test.
 */

export interface InviteOptions {
  /** Refuse signup without a valid unredeemed invite code. */
  required: boolean;
  /** Bearer secret for the invite-minting admin route; null closes the route. */
  adminToken: string | null;
}

export const INVITES_REQUIRED_ENV = "SUMA_INVITES_REQUIRED";
export const INVITE_ADMIN_TOKEN_ENV = "INVITE_ADMIN_TOKEN";

/** Gate on unless explicitly disabled ("0"/"false") — fail safe (§3.4). */
export function inviteOptionsFromEnv(env: Record<string, string | undefined>): InviteOptions {
  const raw = env[INVITES_REQUIRED_ENV]?.trim().toLowerCase();
  return {
    required: raw !== "0" && raw !== "false",
    adminToken: env[INVITE_ADMIN_TOKEN_ENV] ?? null,
  };
}

/** For unit tests and explicitly-open local setups. */
export const INVITES_DISABLED: InviteOptions = { required: false, adminToken: null };

/** No 0/O/1/l/I — codes get read over calls and typed by hand. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 12;

export function generateInviteCode(): string {
  // Rejection sampling: 248 = 8 × 31 is the largest multiple of the alphabet
  // size below 256, so accepted bytes map to characters without modulo bias.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = "";
  const raw = new Uint8Array(CODE_LENGTH * 2);
  while (out.length < CODE_LENGTH) {
    crypto.getRandomValues(raw);
    for (const byte of raw) {
      if (byte < limit && out.length < CODE_LENGTH) {
        out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
    }
  }
  return `sm-inv-${out}`;
}
