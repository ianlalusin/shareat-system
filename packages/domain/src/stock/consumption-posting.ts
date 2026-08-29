/**
 * Consumption, wastage and count variance post to the ledger — T-164.
 *
 * ⭐ **This is where gross margin stops being wrong.** Until now cost hit the P&L when goods were
 * BOUGHT (§16.7 defect 5: *"COGS is purchase-basis rather than consumption-basis; gross margin is
 * wrong"*). From here it hits when they are CONSUMED, so margin moves with what was sold rather
 * than with when somebody happened to buy.
 *
 * ## Three exits, three accounts, and they are not interchangeable
 *
 * | Event | Posting | Why not one account |
 * |---|---|---|
 * | **Consumption** | `Dr 5110/5120/…` · `Cr` inventory | The real cost of what was sold |
 * | **Wastage** | `Dr 5300` · `Cr` inventory | ⭐ A cost of sales, but **not a cost of a sale**. Folding it into COGS makes food cost look worse AND hides the shrinkage — and seeing the shrinkage is the entire purpose of the reason taxonomy |
 * | **Count variance** | `Dr`/`Cr 5400` · `Cr`/`Dr` inventory | Not a cost — a **correction**. Mixing it into COGS makes a counting error look like appetite |
 *
 * ⚠️ **v1 posts NO GL entry for a count adjustment at all** — `stock-count.actions.ts`, in its own
 * words, *"NO GL, v1"*. A fleet-wide shrinkage moved stock and touched the books nowhere. That is
 * the gap this module closes, not a shape it ports.
 *
 * ## ⭐ Cost comes from FIFO, never from a price list
 *
 * Every function here takes the cost lines `planConsumption` produced and posts exactly them. It
 * never multiplies a quantity by a rate of its own — that would be a second opinion about what
 * stock cost, and the subledger would stop tying to the entry.
 */
import { add, ZERO, type Money } from '@shareat/core/money';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import type { ConsumedLine } from './layers';
import type { WastageReason } from './wastage-reasons';
import type { Tx } from '@shareat/db';

export const WASTAGE_ACCOUNT = '5300';
export const INVENTORY_ADJUSTMENT_ACCOUNT = '5400';

/**
 * COA-ALIGNMENT §4.1's consumption crosswalk.
 *
 * ⚠️ Keyed by the item's own COGS category — **not by the EXPENSE category**. Those are two
 * different taxonomies, and conflating them is how `5170`'s inter-store elimination breaks: an
 * expense category answers *"what did we spend money on"*, a COGS category answers *"what kind of
 * cost of sale is this"*, and only the second belongs on a consumption.
 */
export const COGS_ACCOUNT_BY_CATEGORY: Readonly<Record<string, string>> = {
  meat: '5110',
  sides: '5120',
  condiments: '5130',
  sauces: '5140',
  packaging: '5150',
  retail: '5160',
  beverage: '5200',
  /** The catch-all. ⚠️ COA-ALIGNMENT marks it "drive to zero" — a live balance here is a category
   *  nobody has classified, not a real kind of cost. */
  food: '5100',
};

export interface ConsumptionPostingInput {
  readonly orgId: string;
  readonly storeId: string;
  /** The inventory account the stock is being relieved from — `1310`, `1320` or `1330`. */
  readonly inventoryAccount: string;
  /** YYYY-MM-DD. Resolved to a fiscal period by `postEntry`. */
  readonly movedOn: string;
  readonly sourceType: string;
  readonly sourceId: string;
  /** What `planConsumption` decided. The cost posted is exactly their sum. */
  readonly costLines: readonly ConsumedLine[];
  readonly postedBy?: string | null;
}

export type PostingResult =
  | { readonly ok: true; readonly entryId: string; readonly created: boolean; readonly cost: Money }
  | { readonly ok: false; readonly reason: string };

const sumCost = (lines: readonly ConsumedLine[]): Money => add(...lines.map((l) => l.cost), ZERO);

/**
 * Stock consumed — sold, used, issued.
 *
 * ⭐ **One journal entry for the whole consumption**, even when it spans several FIFO layers. The
 * per-layer detail is `stock_layer_consumptions`, which IS the subledger; splitting the entry
 * would put the detail in two places and tie neither.
 */
export async function postConsumption(
  tx: Tx,
  input: ConsumptionPostingInput & { readonly cogsCategory: string },
): Promise<PostingResult> {
  const cogsAccount = COGS_ACCOUNT_BY_CATEGORY[input.cogsCategory];
  if (!cogsAccount) {
    // ⛔ Blocks rather than falling back to 5100. COA-ALIGNMENT says drive the catch-all to zero;
    // routing the unknown into it would do the opposite, quietly and forever.
    return {
      ok: false,
      reason: `COGS category "${input.cogsCategory}" has no account in COA-ALIGNMENT §4.1`,
    };
  }
  return postRelief(tx, input, cogsAccount, 'Stock consumed', 'consumption');
}

/**
 * Stock lost — spoiled, damaged, expired, stolen.
 *
 * ⛔ Posts `5300`, **never a COGS account, even for food.** The reason code rides the movement
 * (T-168), not the journal line: the ledger records that value left as wastage, and the taxonomy
 * answers *which kind* without multiplying the chart of accounts by ten.
 */
export async function postWastage(
  tx: Tx,
  input: ConsumptionPostingInput & { readonly reason: WastageReason },
): Promise<PostingResult> {
  return postRelief(tx, input, WASTAGE_ACCOUNT, `Wastage: ${input.reason}`, 'wastage');
}

/**
 * A physical count disagreed with the ledger.
 *
 * ⭐ Signed both ways: counted short relieves inventory into `5400`; counted long does the
 * reverse. ⚠️ **An OPENING count is refused here** — its variance posts against `3900`, not
 * `5400`, because v2 has no prior-period P&L to charge December's shrinkage to (T-134). ERPNext
 * enforces exactly this distinction with a dedicated error class.
 */
export async function postCountVariance(
  tx: Tx,
  input: ConsumptionPostingInput & {
    readonly direction: 'short' | 'long';
    readonly isOpeningCount?: boolean;
  },
): Promise<PostingResult> {
  if (input.isOpeningCount) {
    return {
      ok: false,
      reason:
        'an opening count posts its variance against 3900, not 5400 — see T-134. ' +
        'v2 has no December P&L to charge the difference to.',
    };
  }
  return postRelief(
    tx,
    input,
    INVENTORY_ADJUSTMENT_ACCOUNT,
    `Count variance (${input.direction})`,
    'count',
    input.direction === 'long',
  );
}

/**
 * The shared shape: relieve inventory, charge an expense account, one entry.
 *
 * `reversed` flips it — a count that found MORE stock debits inventory and credits `5400`.
 */
async function postRelief(
  tx: Tx,
  input: ConsumptionPostingInput,
  expenseAccount: string,
  memo: string,
  keySuffix: string,
  reversed = false,
): Promise<PostingResult> {
  if (input.costLines.length === 0) {
    return { ok: false, reason: 'nothing to post: no cost lines' };
  }
  const cost = sumCost(input.costLines);
  if (cost === ZERO) {
    // ⚠️ A zero-cost movement is real — a layer received free, or a variance inside nothing — but
    // invariant 1 forbids zero-amount lines, so there is no entry to write. The MOVEMENT still
    // happened; only its value is nil.
    return { ok: false, reason: 'cost is zero: the movement stands, but there is no entry to post' };
  }

  const lines: PostEntryLine[] = reversed
    ? [
        { accountCode: input.inventoryAccount, storeId: input.storeId, debit: cost },
        { accountCode: expenseAccount, storeId: input.storeId, credit: cost },
      ]
    : [
        { accountCode: expenseAccount, storeId: input.storeId, debit: cost },
        { accountCode: input.inventoryAccount, storeId: input.storeId, credit: cost },
      ];

  const result = await postEntry(tx, {
    orgId: input.orgId,
    entryDate: input.movedOn,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    idempotencyKey: `${input.sourceType}:${input.sourceId}:${keySuffix}`,
    memo,
    postedBy: input.postedBy ?? null,
    lines,
  });

  return { ok: true, entryId: result.entryId, created: result.created, cost };
}
