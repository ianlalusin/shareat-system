/**
 * May this account give up this money? — the ONE answer, shared by every path that takes money
 * out of an account. Bible row 154.
 *
 * ## ⭐ The rule is a property of the ACCOUNT, not of the feature
 *
 * > **Ian, 2026-08-26:** *"warning for now, don't block … implement it only to cashier owned
 * > account, since only cashier owned account might experience this."*
 *
 * A **cashier** account holds money the ledger genuinely cannot see yet. A sales day posts only
 * at **verify** (`sales-days/verify.ts`), so today's takings are sitting in the till hours before
 * they exist in the books. A drawer that reads ₱0 at 2pm may hold ₱40,000. **Refusing an outflow
 * there would refuse a shortfall that is not real** — and the surest way to make people work
 * around a system is to have it deny things they can see with their own eyes.
 *
 * ⭐ **No other custodian has that gap.** An office safe or a staff float only ever receives money
 * through a transfer, a cash request or a liquidation — all of which post the moment they happen.
 * Its balance is complete, so a negative there is not a timing artefact, it is a real error, and
 * it is still refused.
 *
 * ## ⛔ Why this lives in one file
 *
 * Two callers take money out of an account — `approveExpense` and `createMoneyTransfer` — and the
 * rule has to be identical in both, or the same act becomes legal on one screen and refused on
 * the next. That is exactly the mistake T-139 made first (gating transfers while an expense could
 * fund itself from another store one menu across), and exactly how v1's two amortisation runners
 * drifted apart. One rule, one place.
 */
import { money, type Money } from '@shareat/core/money';
import { moneyAccountsRepo, type MoneyAccountRow, type Tx } from '@shareat/db';
import { refuse } from '../shared/refusal';

/**
 * ⭐ **`judgeDraw` and `DrawVerdict` moved to `./draw-verdict` (T-266) and are re-exported here
 * unchanged**, so every existing caller keeps working and there is still exactly ONE definition of
 * the rule — which is this file's whole point.
 *
 * ⚠️ The split is a BUNDLING boundary, not a design change. `judgeDraw` was already pure, but it
 * sat in this file, and this file imports `moneyAccountsRepo` for `checkDraw` below — so anything
 * importing the verdict pulled `@shareat/db` and the Postgres driver behind it. T-266's money form
 * renders the verdict inline in a CLIENT component, and `next build` refused it for exactly that
 * reason.
 */
import { judgeDraw } from './draw-verdict';
export { judgeDraw, type DrawVerdict, type DrawableAccount } from './draw-verdict';

export async function checkDraw(
  tx: Tx,
  orgId: string,
  account: MoneyAccountRow,
  drawn: Money,
  context: string,
): Promise<string | null> {
  // T-501: lock the account row FIRST, so a concurrent draw waits and then reads a balance that includes ours.
  await moneyAccountsRepo.lockForDraw(tx, orgId, account.id);
  const available = money(await moneyAccountsRepo.balanceOf(tx, orgId, account));
  const verdict = judgeDraw(account, available, drawn);
  if (verdict.blocked) throw refuse(`${context}: ${verdict.message}`, verdict.message ?? 'That account cannot cover this amount.');
  return verdict.message ?? null;
}
