/**
 * The ONE posting for "a shortage is charged to a person" — T-366 S2, DEF-105.
 *
 * ```
 * Dr  1230  Advances to employees      party_type = 'employee', party_id = the person
 *     Cr  <the account that came up short>   (party: whatever the CALLER says, else none)
 * ```
 *
 * Two callers, one shape: `chargeTillShortage` (a counted till shortage) and
 * `resolveRemittanceVariance` (a handover that came up short). Before this they were two copies of
 * the same Dr/Cr, and only one of them existed — the remittance charge posted nothing (DEF-386).
 *
 * ⛔ **The credit line's party comes from the caller and is never derived here.** The till credits
 * an account whose own line carries no party (HEAD's `till/index.ts` credit line), so it passes
 * none and its posted lines stay byte-identical; the remittance charge passes
 * `money_account` only for a 1140 wallet, which requires one.
 *
 * Idempotency, source type, source id, memo and date are all the caller's: they are what makes a
 * double-click a no-op and what traces the entry to its document (bible §16.1 inv. 4).
 */
import type { Tx } from '@shareat/db';
import { postEntry } from '../ledger/post-entry';

/** 1230 Advances to employees — the receivable a charged shortage creates. */
export const STAFF_SHORTAGE_RECEIVABLE_ACCOUNT = '1230';

export interface StaffShortageChargeInput {
  orgId: string;
  storeId: string;
  /** The person charged — becomes the 1230 line's employee party. */
  personId: string;
  /** Positive money as a decimal string (numeric(14,2)). */
  amount: string;
  /** The account credited — the one that came up short (e.g. '1110'). */
  creditAccountCode: string;
  /** Party on the CREDIT line, when that account requires one (1140 → money_account). */
  creditParty?: { partyType: string; partyId: string };
  entryDate: string;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  memo: string;
  postedBy: string;
}

export async function postStaffShortageCharge(
  tx: Tx,
  input: StaffShortageChargeInput,
): Promise<{ entryId: string; created: boolean }> {
  return postEntry(tx, {
    orgId: input.orgId,
    entryDate: input.entryDate,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    idempotencyKey: input.idempotencyKey,
    memo: input.memo,
    postedBy: input.postedBy,
    lines: [
      {
        accountCode: STAFF_SHORTAGE_RECEIVABLE_ACCOUNT,
        storeId: input.storeId,
        debit: input.amount,
        partyType: 'employee',
        partyId: input.personId,
      },
      {
        accountCode: input.creditAccountCode,
        storeId: input.storeId,
        credit: input.amount,
        ...(input.creditParty
          ? { partyType: input.creditParty.partyType, partyId: input.creditParty.partyId }
          : {}),
      },
    ],
  });
}
