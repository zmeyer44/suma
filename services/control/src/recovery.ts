/**
 * Recovery-code wrapper storage (PRD §8.2). The control plane stores only the
 * PBKDF2 salt and the wrapped root secret — KEK derivation and unwrap happen
 * client-side, so the server never sees the recovery code or any key.
 */

import type { Db } from "./db/client.js";
import { keyWrappers } from "./db/schema.js";

export const RECOVERY_WRAPPER_KIND = "recovery-code";
/** One recovery wrapper per space: a fixed label, not a WebAuthn id. */
export const RECOVERY_CREDENTIAL_ID = "recovery";

export async function setRecoveryWrapper(
  db: Db,
  userId: string,
  spaceId: string,
  saltB64: string,
  wrappedB64: string,
): Promise<typeof keyWrappers.$inferSelect | undefined> {
  const [wrapper] = await db
    .insert(keyWrappers)
    .values({
      userId,
      spaceId,
      kind: RECOVERY_WRAPPER_KIND,
      credentialId: RECOVERY_CREDENTIAL_ID,
      salt: saltB64,
      wrapped: wrappedB64,
    })
    .onConflictDoUpdate({
      target: [keyWrappers.spaceId, keyWrappers.kind, keyWrappers.credentialId],
      set: { salt: saltB64, wrapped: wrappedB64 },
    })
    .returning();
  return wrapper;
}
