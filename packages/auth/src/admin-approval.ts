/**
 * verifyAdminApproval - the server-side check behind every Tier P danger button (T-412).
 * docs/tasks/412-confirm-destructive-tiers.md "How the server verifies a Tier P action"; bible row 329, row 196.
 *
 * ⭐ NO CLIENT FLAG IS EVER TRUSTED. The PIN is the ONLY value the form supplies; `storeId` is the store of the RECORD, loaded
 * by the action in its own read; `actor` comes from `resolveActor`. A wrong PIN is a `miss` on the ACTOR's own bucket (T-416: 5 per person per
 * rolling 24 h, never a store's sign-in budget; `runChargedPinLookup` is the sequence `signInWithPin` runs), committed on its
 * own so it survives the throw.
 *
 * ⛔ Authority is computed IN FULL on every path (no short-circuit), so what a refusal costs does not say why it refused:
 *   isAdmin   = the PIN's owner holds an unrevoked admin / super_admin role in the actor's org;
 *   adminless = the org has no active administrator at all;
 *   fallback  = adminless AND the owner holds the action's capability (row 196: an org with no administrator is run by its
 *               elevated manager, whose PIN then counts).
 * Allowed iff the PIN is right AND the owner may sign in to the org (`personMaySignInToOrg`) AND is not a terminal AND
 * (isAdmin OR fallback). EVERY failure reads ADMIN_PIN_REFUSED, one sentence, so the message
 * is not an oracle for "right PIN, wrong person".
 */
import type { Tx } from '@shareat/db';
import { sessionsRepo, accessRepo, pinAttemptsRepo } from '@shareat/db';
import type { Actor } from './authorize';
import { can } from './authorize';
import type { Capability } from './capabilities';
import { AuthenticationError } from './errors';
import { isValidPinFormat, pinLookupHash, verifyPin } from './credentials';
import { DUMMY_SCRYPT_HASH, runChargedPinLookup } from './sessions';

/** The ONE refusal sentence for every approval failure (the stopped / paused sentences of the sign-in door are unchanged). */
export const ADMIN_PIN_REFUSED = 'That PIN cannot approve this. An administrator must enter their own PIN.';

export interface AdminApprovalInput {
  actor: Actor;
  /** The RECORD's store. NULL only for an organisation-level action (it charges the organisation's own bucket). */
  storeId: string | null;
  pin: string;
  capability: Capability;
  deviceId?: string;
}

export async function verifyAdminApproval(tx: Tx | null, input: AdminApprovalInput): Promise<{ approverPersonId: string }> {
  const { actor, storeId, pin, capability } = input;
  return runChargedPinLookup(
    tx,
    // T-416: the PERSON's bucket - never the record's store, never the org's.
    { orgId: actor.orgId, bucket: { actor: actor.personId }, ...(input.deviceId ? { deviceId: input.deviceId } : {}) },
    async (lookupTx) => {
      if (!isValidPinFormat(pin)) throw new AuthenticationError(ADMIN_PIN_REFUSED);
      const credential = await sessionsRepo.findActiveCredentialByLookupHash(lookupTx, pinLookupHash(actor.orgId, pin));
      if (!credential || credential.kind !== 'pin' || !credential.secretHash) {
        await verifyPin(pin, DUMMY_SCRYPT_HASH);
        throw new AuthenticationError(ADMIN_PIN_REFUSED);
      }
      // ⛔ All of these run whatever the first answers - the matched path costs the same on every outcome.
      const verified = await verifyPin(pin, credential.secretHash);
      const owner: Actor = { personId: credential.personId, orgId: actor.orgId };
      const isAdmin = await accessRepo.personIsActiveAdmin(lookupTx, actor.orgId, credential.personId);
      const adminless = !(await accessRepo.hasActiveAdmin(lookupTx, actor.orgId));
      const fallback = adminless && (await can(lookupTx, owner, capability, storeId ? { storeId } : {}));
      // Audit M3 / M4: the PIN's owner must still be allowed to sign in to the org (T-407) and must not be a terminal.
      const maySignIn = await accessRepo.personMaySignInToOrg(lookupTx, credential.personId, actor.orgId);
      const isTerminal = await accessRepo.personIsTerminal(lookupTx, actor.orgId, credential.personId);
      if (!(verified && maySignIn && !isTerminal && (isAdmin || fallback))) throw new AuthenticationError(ADMIN_PIN_REFUSED);
      return { approverPersonId: credential.personId };
    },
    { dailyMissBudget: pinAttemptsRepo.APPROVAL_DAILY_MISS_CAP, stopAutoReopenMinutes: pinAttemptsRepo.APPROVAL_CAP_AUTO_LIFT_MINUTES },
  );
}
