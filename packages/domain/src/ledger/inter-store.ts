/**
 * ⭐ T-369 S8 (DEF-551) and S8b (DEF-556) — what one store owes another when a store's document moves money
 * through ANOTHER store's money account, in either direction. `docs/tasks/369-unwired-money-screens.md` §S8/§S8b.
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
 * For each store P other than `owingStoreId`, by what P's own lines net to (debit − credit):
 *
 *   a CREDIT X — money LEFT P for the owing store's document (a payout, an AP or loan payment, an expense):
 *     DR 1250 at P (party = the owing store's code) and CR 2150 at the owing store (party = P's code), each X —
 *     P is owed by the owing store;
 *   a DEBIT X — money LANDED at P for the owing store's document (a collection, a loan drawn into P's safe):
 *     DR 1250 at the owing store (party = P's code) and CR 2150 at P (party = the owing store's code), each X —
 *     P is holding the owing store's money, so P owes it (T-369 S8b, DEF-556);
 *   exactly zero — no pair.
 *
 * Either way every store's own lines net to zero again and the org total (and Σ1250 = Σ2150) is untouched. Each
 * store's sign is decided on its own, so one entry can carry a paying store and a receiving store.
 *
 * Returns `lines` ITSELF (`===`) when no store needs a pair, so the same-store shape is byte-identical and costs
 * no query. Lines with no `storeId` belong to no store and are left alone. Money is summed in integer centavos
 * (bible §2.5), never `Number`.
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

  const others = [...net].filter(([, delta]) => delta !== 0n);
  if (others.length === 0) return lines;

  const codes = await moneyTransfersRepo.storeCodes(tx, orgId, [owingStoreId, ...others.map(([storeId]) => storeId)]);
  const owingCode = codes.get(owingStoreId);
  if (!owingCode) throw internalFault(`withInterStoreLegs: store ${owingStoreId} has no code to name on an inter-store line`);

  const pairs: PostEntryLine[] = [];
  for (const [storeId, delta] of others) {
    const otherCode = codes.get(storeId);
    if (!otherCode) throw internalFault(`withInterStoreLegs: store ${storeId} has no code to name on an inter-store line`);
    const left = delta < 0n; // money left this store
    const amount = fromCentavos(left ? -delta : delta);
    pairs.push(
      {
        accountCode: DUE_FROM_STORE,
        storeId: left ? storeId : owingStoreId,
        debit: amount,
        partyType: 'store',
        partyId: left ? owingCode : otherCode,
        lineMemo: `Due from ${left ? owingCode : otherCode} — ${memo}`,
      },
      {
        accountCode: DUE_TO_STORE,
        storeId: left ? owingStoreId : storeId,
        credit: amount,
        partyType: 'store',
        partyId: left ? otherCode : owingCode,
        lineMemo: `Due to ${left ? otherCode : owingCode} — ${memo}`,
      },
    );
  }
  return [...lines, ...pairs];
}
