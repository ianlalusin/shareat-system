/**
 * ⭐ T-369 S8 (DEF-551) — what one store owes another when a store's debt is paid out of ANOTHER store's money
 * account. `docs/tasks/369-unwired-money-screens.md` §S8.
 *
 * `balanceOf()` reads a non-1140 money account as `journal_lines.store_id = account.storeId`, so the credit to a
 * safe has to sit at the SAFE's store. Then each store's own lines no longer net to zero: the paying store gave
 * up cash that was not its debt and the owing store's liability was discharged with someone else's money. That
 * is the same fact the channel-settlement loan deduction records (`channel-settlements/index.ts`, "the PAYING
 * store ... is owed (DR 1250) ... the OWNING store ... now owes the paying store instead (CR 2150)"), with the
 * same account pair money-transfers and commissary use. Invariant 6's reciprocal finding already watches
 * Σ1250 = Σ2150.
 *
 * ⚠️ `partyId` on both lines is the OTHER store's CODE, never its database id (`moneyTransfersRepo.storeCodes`).
 */
import { fromCentavos, money, toCentavos } from '@shareat/core/money';
import { moneyTransfersRepo, type Tx } from '@shareat/db';
import { internalFault } from '../shared/refusal-leaf';
import type { PostEntryLine } from './post-entry';

/** Inter-store due-from / due-to, both `requires_party` with `party_type = 'store'`. */
const DUE_FROM_STORE = '1250';
const DUE_TO_STORE = '2150';

export interface InterStoreInput {
  /** The store the debt (or expense) belongs to — its liability/expense lines stay here. */
  owingStoreId: string;
  /** Lines whose money credits already carry their own `storeId` (the account's store). */
  lines: PostEntryLine[];
  /** The entry's memo, quoted in the pair's line memos. */
  memo: string;
}

/**
 * For each store other than `owingStoreId` whose lines net to a credit X, append
 *   DR 1250 at that store (party = the owing store's code) for X, and
 *   CR 2150 at the owing store (party = that store's code) for X,
 * so every store's own lines net to zero again and the org total is untouched.
 *
 * Returns `lines` ITSELF (`===`) when nothing sits at another store, so the same-store shape is byte-identical
 * and costs no query. Lines with no `storeId` belong to no store and are left alone. Money is summed in integer
 * centavos (bible §2.5), never `Number`.
 *
 * ⛔ A non-owing store that nets to a DEBIT is an `internalFault`: no caller produces one, and a silent reverse
 * pair would mis-state both stores.
 */
export async function withInterStoreLegs(
  tx: Tx,
  orgId: string,
  input: InterStoreInput,
): Promise<PostEntryLine[]> {
  const { owingStoreId, lines, memo } = input;

  // Net (debit − credit) per store other than the owing one, in first-seen order.
  const net = new Map<string, bigint>();
  for (const line of lines) {
    const storeId = line.storeId ?? null;
    if (storeId === null || storeId === owingStoreId) continue;
    const delta = toCentavos(money(line.debit ?? '0')) - toCentavos(money(line.credit ?? '0'));
    net.set(storeId, (net.get(storeId) ?? 0n) + delta);
  }

  const paying: { storeId: string; credited: bigint }[] = [];
  for (const [storeId, delta] of net) {
    if (delta > 0n) {
      throw internalFault(
        `withInterStoreLegs: store ${storeId} nets to a debit of ${fromCentavos(delta)} in an entry owed by ${owingStoreId}; ` +
          'an inter-store pair is only built for a store that paid.',
      );
    }
    if (delta < 0n) paying.push({ storeId, credited: -delta });
  }
  if (paying.length === 0) return lines;

  const codes = await moneyTransfersRepo.storeCodes(tx, orgId, [owingStoreId, ...paying.map((p) => p.storeId)]);
  const owingCode = codes.get(owingStoreId);
  if (!owingCode) throw internalFault(`withInterStoreLegs: store ${owingStoreId} has no code to name on the due-to line`);

  const pairs: PostEntryLine[] = [];
  for (const { storeId, credited } of paying) {
    const payingCode = codes.get(storeId);
    if (!payingCode) throw internalFault(`withInterStoreLegs: store ${storeId} has no code to name on the due-from line`);
    const amount = fromCentavos(credited);
    pairs.push(
      {
        accountCode: DUE_FROM_STORE,
        storeId,
        debit: amount,
        partyType: 'store',
        partyId: owingCode,
        lineMemo: `Due from ${owingCode} — ${memo}`,
      },
      {
        accountCode: DUE_TO_STORE,
        storeId: owingStoreId,
        credit: amount,
        partyType: 'store',
        partyId: payingCode,
        lineMemo: `Due to ${payingCode} — ${memo}`,
      },
    );
  }
  return [...lines, ...pairs];
}
