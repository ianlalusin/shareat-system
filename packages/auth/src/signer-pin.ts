/**
 * verifySignerPin - the PIN check behind attaching a person's saved signature to a document. T-584 R4 (docs/tasks/584-documents.md s7).
 * Modelled line for line on `verifyAdminApproval` (T-412) and `verifyPosManagerApproval` (T-424): it adds NO new PIN path, only the question
 * "is this PIN, with this Employee ID, the one person who must sign?". It reuses `runChargedPinLookup`, so the lock-out and attempt cap are the
 * ones every other PIN door uses.
 *
 * THE BUCKET. A wrong PIN is a `miss` on the bucket of the person AT THE KEYBOARD (`actor`, T-416: 5 per person per rolling 24 h, auto-lifting),
 * never a store's sign-in budget and never the signer's. It is committed on its own (with `tx = null`) so it survives the throw. The signer
 * need not be the person signed in: an employee is handed the manager's device and types their own Employee ID and PIN.
 *
 * ⛔ Authority is computed IN FULL on every path (no short-circuit), so what a refusal costs does not say why it refused. Allowed iff:
 *   the PIN is right AND it belongs to `expectedPersonId` AND (the person has no staff code on file, or the typed Employee ID is one of theirs)
 *   AND the PIN owner may still sign in to the org AND is not a terminal.
 * EVERY failure reads SIGNER_PIN_REFUSED: one sentence, so the message is not an oracle for "right PIN, wrong person".
 */
import type { Tx } from '@shareat/db';
import { sessionsRepo, accessRepo, pinAttemptsRepo } from '@shareat/db';
import { AuthenticationError } from './errors';
import { isValidPinFormat, pinLookupHash, verifyPin } from './credentials';
import { APPROVAL_PIN_CAPPED, DUMMY_SCRYPT_HASH, runChargedPinLookup } from './sessions';
import { tabletEmployeeIdToStaffCode } from './tablet-employee-id';

/** The ONE refusal sentence for every signing-PIN failure. */
export const SIGNER_PIN_REFUSED = 'That Employee ID and PIN do not match the person who has to sign.';

/** The cap sentence for this door: it names no count, time or person. */
export const SIGNER_PIN_CAPPED =
  'Too many wrong PINs from your account today. An administrator can clear this on your user page, or try again tomorrow.';

export interface SignerPinInput {
  orgId: string;
  /** The person signed in on this device (owns the attempt bucket). */
  actorPersonId: string;
  /** The ONE person whose signature this slot takes, decided by the document, never by the form. */
  expectedPersonId: string;
  /** Every staff code that person has held (upper-case `SE-007`). Empty = they have none, and no Employee ID is checked. */
  acceptedStaffCodes: readonly string[];
  /** What was typed: the number (`7`) or the whole code (`SE-007`). */
  employeeId: string;
  pin: string;
  deviceId?: string;
}

export async function verifySignerPin(tx: Tx | null, input: SignerPinInput): Promise<{ signerPersonId: string }> {
  const { orgId, pin } = input;
  try {
    return await runChargedPinLookup(
      tx,
      { orgId, bucket: { actor: input.actorPersonId }, ...(input.deviceId ? { deviceId: input.deviceId } : {}) },
      async (lookupTx) => {
        if (!isValidPinFormat(pin)) throw new AuthenticationError(SIGNER_PIN_REFUSED);
        const credential = await sessionsRepo.findActiveCredentialByLookupHash(lookupTx, pinLookupHash(orgId, pin));
        if (!credential || credential.kind !== 'pin' || !credential.secretHash) {
          await verifyPin(pin, DUMMY_SCRYPT_HASH);
          throw new AuthenticationError(SIGNER_PIN_REFUSED);
        }
        // All of these run whatever the first answers - the matched path costs the same on every outcome.
        const verified = await verifyPin(pin, credential.secretHash);
        const maySignIn = await accessRepo.personMaySignInToOrg(lookupTx, credential.personId, orgId);
        const isTerminal = await accessRepo.personIsTerminal(lookupTx, orgId, credential.personId);
        const typed = tabletEmployeeIdToStaffCode(input.employeeId) ?? input.employeeId.trim().toUpperCase();
        const idOk = input.acceptedStaffCodes.length === 0 || input.acceptedStaffCodes.includes(typed);
        if (!(verified && credential.personId === input.expectedPersonId && idOk && maySignIn && !isTerminal)) {
          throw new AuthenticationError(SIGNER_PIN_REFUSED);
        }
        return { signerPersonId: credential.personId };
      },
      { dailyMissBudget: pinAttemptsRepo.APPROVAL_DAILY_MISS_CAP, stopAutoReopenMinutes: pinAttemptsRepo.APPROVAL_CAP_AUTO_LIFT_MINUTES },
    );
  } catch (err) {
    if (err instanceof AuthenticationError && err.message === APPROVAL_PIN_CAPPED) throw new AuthenticationError(SIGNER_PIN_CAPPED);
    throw err;
  }
}
