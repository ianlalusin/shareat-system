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
import { moneyAccountsRepo, type MoneyAccountRow, type Tx } from '@shareat/db';

export interface DrawVerdict {
  /** ⛔ True means refuse. False with a `message` means post it and TELL someone. */
  blocked: boolean;
  /** Present whenever the account cannot cover the draw, whether or not it is blocked. */
  message?: string;
}

const OK: DrawVerdict = { blocked: false };

/**
 * The decision itself, with no database in it, so the branch is testable on its own.
 *
 * @param available what the LEDGER says the account holds — never a stored figure
 * @param drawn     the total leaving this account, summed across every line of a split
 */
export function judgeDraw(
  account: Pick<MoneyAccountRow, 'name' | 'custodian'>,
  available: number,
  drawn: number,
): DrawVerdict {
  if (drawn <= available) return OK;

  const short = (drawn - available).toFixed(2);
  const holds = available.toFixed(2);

  if (account.custodian === 'cashier') {
    // ⚠️ A WARNING, NOT A REFUSAL. The till's true balance is unknowable until the day is
    // verified, so this is a "look at this", not a "you are wrong".
    return {
      blocked: false,
      message:
        `"${account.name}" is short ${short} against the books (holds ${holds}, this takes ` +
        `${drawn.toFixed(2)}). That is expected while today's sales are unverified — the cash is ` +
        'in the till before it is in the ledger. If the day IS verified, the drawer is genuinely ' +
        'over-spent and needs counting.',
    };
  }

  // ⛔ Office and staff balances are complete, so this is a real shortfall.
  return {
    blocked: true,
    message:
      `"${account.name}" holds ${holds} and this takes ${drawn.toFixed(2)}. Unlike a cashier ` +
      'drawer, this balance is complete — nothing is waiting to be posted into it — so record ' +
      'the money coming in first, or draw it from somewhere that holds it.',
  };
}

/**
 * Reads the account's ledger balance and judges the draw. Throws when blocked; otherwise returns
 * the warning to be surfaced, or `null` when there is nothing to say.
 */
export async function checkDraw(
  tx: Tx,
  orgId: string,
  account: MoneyAccountRow,
  drawn: number,
  context: string,
): Promise<string | null> {
  const available = Number(await moneyAccountsRepo.balanceOf(tx, orgId, account));
  const verdict = judgeDraw(account, available, drawn);
  if (verdict.blocked) throw new Error(`${context}: ${verdict.message}`);
  return verdict.message ?? null;
}
