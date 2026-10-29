/**
 * verifyPosManagerApproval - the server-side check behind every POS v2 money action (refund, tender correction, unpaid-session void).
 * docs/tasks/424-pos-v2-server-approvals.md Ruling 5 + S5. Modelled line for line on `verifyAdminApproval` (`admin-approval.ts`, T-412).
 *
 * NO CLIENT FLAG IS EVER TRUSTED. The only values a request supplies are the PIN and (through `resolvePosTerminalLink`) a device id;
 * the ERP store, the terminal person and the bucket all come from Postgres (`pos_terminal_links`), never from Firestore.
 *
 * A wrong PIN is a `miss` on the TERMINAL PERSON's own bucket `{ actor: terminalPersonId }` (T-416: 5 per person per rolling 24 h) -
 * never a store's sign-in budget, never the manager's own. Committed on its own so it survives the throw.
 *
 * Authority is computed IN FULL on every path (no short-circuit), so what a refusal costs does not say why it refused. Allowed iff:
 *   the PIN is right AND its owner may sign in to the org AND is not a terminal AND (is an active admin OR holds
 *   `approve_pos_correction` AT `erpStoreId`) AND `terminalPersonId` is a terminal person credentialed to `erpStoreId`.
 * EVERY failure reads POS_APPROVAL_REFUSED - one sentence, so the message is not an oracle for "right PIN, wrong person".
 * A capped terminal reads the T-416 cap for EVERY attempt, but its sentence names the STORE MANAGER (a terminal has no user page).
 */
import type { Tx } from '@shareat/db';
import { sessionsRepo, accessRepo, pinAttemptsRepo, posTerminalLinksRepo, franchiseRepo } from '@shareat/db';
import type { Actor } from './authorize';
import { can } from './authorize';
import { AuthenticationError } from './errors';
import { isValidPinFormat, pinLookupHash, verifyPin } from './credentials';
import { APPROVAL_PIN_CAPPED, DUMMY_SCRYPT_HASH, runChargedPinLookup } from './sessions';

/** The ONE refusal sentence for every approval failure. */
export const POS_APPROVAL_REFUSED = 'That PIN cannot approve this. Ask a store manager.';

/**
 * A terminal has no user page of its own to point at, so the T-416 cap sentence tells the person at the counter to go to the STORE MANAGER, and says
 * the two ways out that are true today: the cap lifts itself after 24 hours, and an administrator can clear it in ERP (`manage_users`).
 */
export const POS_APPROVAL_PIN_CAPPED =
  'Too many wrong manager PINs from this tablet today. Tell your store manager: it clears itself after 24 hours, or an administrator can clear it in ERP.';

export const POS_TERMINAL_NOT_REGISTERED = 'This tablet is not registered for approvals yet. Ask an administrator to register it.';

export interface PosApprovalInput {
  orgId: string;
  /** The ERP store (resolved from the terminal link, never from the request). */
  erpStoreId: string;
  pin: string;
  /** The terminal person the tablet is linked to (resolved from the terminal link). */
  terminalPersonId: string;
  deviceId?: string;
}

export async function verifyPosManagerApproval(tx: Tx | null, input: PosApprovalInput): Promise<{ approverPersonId: string }> {
  const { orgId, erpStoreId, pin, terminalPersonId } = input;
  try {
    return await runChargedPinLookup(
      tx,
      { orgId, bucket: { actor: terminalPersonId }, ...(input.deviceId ? { deviceId: input.deviceId } : {}) },
      async (lookupTx) => {
        if (!isValidPinFormat(pin)) throw new AuthenticationError(POS_APPROVAL_REFUSED);
        const credential = await sessionsRepo.findActiveCredentialByLookupHash(lookupTx, pinLookupHash(orgId, pin));
        if (!credential || credential.kind !== 'pin' || !credential.secretHash) {
          await verifyPin(pin, DUMMY_SCRYPT_HASH);
          throw new AuthenticationError(POS_APPROVAL_REFUSED);
        }
        // All of these run whatever the first answers - the matched path costs the same on every outcome.
        const verified = await verifyPin(pin, credential.secretHash);
        const owner: Actor = { personId: credential.personId, orgId };
        const isAdmin = await accessRepo.personIsActiveAdmin(lookupTx, orgId, credential.personId);
        const holdsCapability = await can(lookupTx, owner, 'approve_pos_correction', { storeId: erpStoreId });
        const maySignIn = await accessRepo.personMaySignInToOrg(lookupTx, credential.personId, orgId);
        const ownerIsTerminal = await accessRepo.personIsTerminal(lookupTx, orgId, credential.personId);
        const terminalOk = await posTerminalLinksRepo.terminalIsCredentialedToStore(lookupTx, orgId, terminalPersonId, erpStoreId);
        if (!(verified && maySignIn && !ownerIsTerminal && terminalOk && (isAdmin || holdsCapability))) {
          throw new AuthenticationError(POS_APPROVAL_REFUSED);
        }
        // T-398 S6c: break-glass log, only after every check passed, in this lookup transaction; the PIN OWNER is the person logged.
        await franchiseRepo.logBreakGlassApprovalAsApprover(lookupTx, credential.personId, 'approve_pos_correction', erpStoreId);
        return { approverPersonId: credential.personId };
      },
      { dailyMissBudget: pinAttemptsRepo.APPROVAL_DAILY_MISS_CAP, stopAutoReopenMinutes: pinAttemptsRepo.APPROVAL_CAP_AUTO_LIFT_MINUTES },
    );
  } catch (err) {
    if (err instanceof AuthenticationError && err.message === APPROVAL_PIN_CAPPED) throw new AuthenticationError(POS_APPROVAL_PIN_CAPPED);
    throw err;
  }
}
