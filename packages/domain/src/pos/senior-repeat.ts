/**
 * T-575 (bible row 462, DEF-843) - was this senior/PWD card number already used at this store? docs/tasks/575-pos-repeat-senior-id-warning.md as amended 13 Nov 2026.
 *
 * Two readers of one question, both against `statutory_discount_records` (which keeps the BIR card number; `pos_events` is scrubbed by T-572):
 *   - `checkSeniorIdRepeat`: the payment screen asks it when the ID box loses focus. Answers { used, lastReceiptNo, lastAt }, never the holder's name. Read-only.
 *   - `earlierUsesOfCard`: `completeSale` asks it for each diner after writing the statutory rows, and records the manager's trail (`pos.senior_id_repeat`).
 * The warning never blocks a sale. The window is the org-wide rule `pos.senior_id_repeat_days` (1 = the same business day); the comparison is ALWAYS the same store.
 */
import { addDays, parseBusinessDate } from '@shareat/core/datetime';
import { authorize, type Actor } from '@shareat/auth';
import { statutoryDiscountsRepo, type Tx } from '@shareat/db';
import { readSeniorIdRepeatDays } from '../business-rules/pos-rules';
import { refuse } from '../shared/refusal';
import { businessDateOf, requireContext, type PosDeps } from './shared';

export interface SeniorIdCheck {
  /** How many earlier uses of this card in the window (live register rows). */
  used: number;
  /** The printed number of the most recent one, or null when there is none. */
  lastReceiptNo: string | null;
  /** When the most recent one was made (ISO), or null when there is none. */
  lastAt: string | null;
}

const NONE: SeniorIdCheck = { used: 0, lastReceiptNo: null, lastAt: null };
/** The register's own cap on a card number (POS_STATUTORY_HOLDER_RULES.idNumber): a longer one can never match a row. */
const MAX_ID_LENGTH = 60;

/** The register rows of this store that used `idNumber` in the window ending on `businessDate`, newest first. `excludeInvoiceNumber` leaves the sale being written out of its own answer. */
export async function earlierUsesOfCard(tx: Tx, orgId: string, storeId: string, idNumber: string, businessDate: string, excludeInvoiceNumber?: string): Promise<statutoryDiscountsRepo.PriorIdUse[]> {
  const days = await readSeniorIdRepeatDays(tx, orgId, businessDate);
  return statutoryDiscountsRepo.listPriorIdUses(tx, orgId, {
    storeId, idNumber, from: addDays(parseBusinessDate(businessDate), -(days - 1)), to: businessDate, ...(excludeInvoiceNumber !== undefined ? { excludeInvoiceNumber } : {}),
  });
}

/** `record_sale` at the store, on a live pairing of it (a phone is refused). */
export async function checkSeniorIdRepeat(tx: Tx, actor: Actor, input: { storeId: string; pairingId: string | null; idNumber: string }, deps?: PosDeps): Promise<SeniorIdCheck> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  await requireContext(tx, actor, input.storeId, input.pairingId, false);
  if (typeof input.idNumber !== 'string') throw refuse('pos: card number is not text', 'Enter the senior or PWD card number.');
  const idNumber = input.idNumber.trim();
  if (idNumber === '') return NONE;
  if (idNumber.length > MAX_ID_LENGTH) throw refuse('pos: card number too long', 'The senior or PWD card number is too long.');
  const today = await businessDateOf(tx, actor.orgId, input.storeId, deps);
  const uses = await earlierUsesOfCard(tx, actor.orgId, input.storeId, idNumber, today);
  const last = uses[0];
  return last ? { used: uses.length, lastReceiptNo: last.invoiceNumber, lastAt: last.at.toISOString() } : NONE;
}
