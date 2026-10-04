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
import { authorize, type Actor } from '@shareat/auth';
import { fromCentavos, toCentavos } from '@shareat/core/money';
import { moneyTransfersRepo, type Tx } from '@shareat/db';
import { internalFault } from '../shared/refusal-leaf';
import { lineAmount, type PostEntryLine } from './post-entry';

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
  for (const [index, line] of lines.entries()) {
    const storeId = line.storeId ?? null;
    if (storeId === null || storeId === owingStoreId) continue;
    // T-371 S3 — the same mint postEntry applies, so a malformed figure is refused in words here, not as a TypeError.
    const debit = lineAmount(line.debit, 'debit', index, line.accountCode, 'withInterStoreLegs');
    const credit = lineAmount(line.credit, 'credit', index, line.accountCode, 'withInterStoreLegs');
    const delta = toCentavos(debit) - toCentavos(credit);
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

/**
 * ⭐ T-369 S9 addendum A1 (DEF-573) — undoing a posting that moved ANOTHER store's money moves it again, so the
 * void needs `transfer_funds` at every OTHER store the original entry's lines touch, on top of the document's own
 * void capability at the document's store. Same-store voids are unchanged: nothing else is asked.
 *
 * Detection is the original entry's LINES (every non-null `storeId` that is not the document's), not the 1250/2150
 * pair: the line names the store itself, a store that netted to zero got no pair but its money lines still move, an
 * expense can draw on several stores' wallets, and a caller-named loan entry has no account column to read. Lines
 * with no `storeId` belong to no store and are skipped. Stores are asked in sorted order so the first refusal is
 * deterministic, and `authorize`'s own error comes out unchanged (the capability is kept — nothing wraps it).
 *
 * No query of its own: callers pass `journalRepo.findLinesForEntryWithAccountCodes(tx, entryId)`. The first
 * parameter list is the honest `(tx, actor, …)` of a function that authorizes.
 */
export async function authorizeOtherStores(
  tx: Tx,
  actor: Actor,
  input: { lines: readonly { storeId?: string | null }[]; documentStoreId: string },
): Promise<void> {
  const others = [
    ...new Set(
      input.lines
        .map((l) => l.storeId ?? null)
        .filter((id): id is string => id !== null && id !== input.documentStoreId),
    ),
  ].sort();
  for (const storeId of others) {
    await authorize(tx, actor, 'transfer_funds', { storeId });
  }
}
