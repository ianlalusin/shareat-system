/**
 * `judgeDraw` — may this account give up this money? The decision alone, with **no database
 * import in the module at all**. Bible row 154.
 *
 * ## ⚠️ Why this is its own file (T-266)
 *
 * It was the top half of `overdraft.ts`, whose own comment already said it was *"the decision
 * itself, with no database in it, so the branch is testable on its own"*. That was true of the
 * FUNCTION and not of the FILE: `overdraft.ts` imports `moneyAccountsRepo` for `checkDraw`, so
 * anything importing `judgeDraw` pulled `@shareat/db` — and the Postgres driver — behind it.
 *
 * ⛔ **That is fatal in a browser bundle, and `next build` is what found it.** T-266's money form
 * renders this verdict inline so the person recording a payment reads, at entry time, the exact
 * sentence approval will give them. A client component cannot do that if the import drags a TCP
 * driver with it.
 *
 * ⭐ **The rule still lives in ONE place** — which is the whole point of row 154. `overdraft.ts`
 * re-exports this, so every existing caller is unchanged and there is still exactly one definition
 * of "can this account cover it".
 */

/** The account facts the verdict turns on — structural, so a caller may pass a `MoneyAccountRow`,
 *  a picker option, or a test fixture without any of them importing each other. */
import { compare, money, negate, subtract, type Money } from '@shareat/core/money';

export interface DrawableAccount {
  name: string;
  custodian: 'cashier' | 'office' | 'staff';
  /** ⭐ How far below zero a CASHIER drawer may go. Positive; office/staff ignore it. */
  overdraftLimit: string;
  /** ⭐ T-316: a till float is a TARGET on the cashier's takings drawer (1110). NOT consulted by
   *  `judgeDraw` — the drawer is judged as a cashier drawer (warn within `overdraftLimit`), and the
   *  floor is enforced at the document (`createRemittance`). Callers still pass it. */
  floatTarget: string | null;
}

export interface DrawVerdict {
  /** ⛔ True means refuse. False with a `message` means post it and TELL someone. */
  blocked: boolean;
  /** Present whenever the account cannot cover the draw, whether or not it is blocked. */
  message?: string;
}

const OK: DrawVerdict = { blocked: false };

/**
 * @param available what the LEDGER says the account holds — never a stored figure
 * @param drawn     the total leaving this account, summed across every line of a split
 */
export function judgeDraw(
  account: DrawableAccount,
  available: Money,
  drawn: Money,
): DrawVerdict {
  // ⭐ T-371 S4 — exact: both sides are Money, compared and subtracted in centavos, never as floats.
  if (compare(drawn, available) <= 0) return OK;

  const short = subtract(drawn, available);
  const holds = available;

  if (account.custodian === 'cashier') {
    // ⭐ T-371 R4/C4 — the stored limit is RE-MINTED, never `Number()`-ed: a malformed value throws
    // here instead of becoming NaN and silently failing the comparison below into a block.
    const limit = money(account.overdraftLimit);
    // ⭐ Where the balance LANDS, not how big the draw is. A ₱50,000 draw against a ₱49,000 drawer
    // leaves it ₱1,000 behind, which is ordinary; a ₱1,000 draw against a drawer already ₱19,500
    // behind is what pushes it past the cap.
    const after = subtract(available, drawn);
    // How far below zero the drawer lands, compared to the limit as Money, not floats.
    const behind = negate(after);

    if (compare(behind, limit) <= 0) {
      // ⚠️ A WARNING, NOT A REFUSAL. The till's true balance is unknowable until the day is
      // verified, so this is a "look at this", not a "you are wrong".
      return {
        blocked: false,
        message:
          `"${account.name}" is short ${short} against the books (holds ${holds}, this takes ` +
          `${drawn}). That is expected while today's sales are unverified — the cash is ` +
          'in the till before it is in the ledger. If the day IS verified, the drawer is genuinely ' +
          `over-spent and needs counting. Allowed down to −${limit}.`,
      };
    }

    // ⛔ PAST THE CAP — and this is where "legitimately behind" stops.
    //
    // > **Ian, 2026-08-27:** *"how deep can a cashier account be negative — it can't be unlimited,
    // > so admin can set it."*
    //
    // ⚠️ Row 154's reasoning has no floor of its own: the unverified-day argument justifies a
    // drawer being ₱2,000 behind and equally ₱2,000,000 behind. The first is a bookkeeping lag; the
    // second is a missing drawer, and nothing in the ledger could tell them apart.
    return {
      blocked: true,
      message:
        `"${account.name}" would go to −${behind}, past the ${limit} ` +
        `overdraft this drawer is allowed (holds ${holds}, this takes ${drawn}). ` +
        'A cashier drawer is expected to run behind while the day is unverified, but not this far. ' +
        'Verify the day, remit what is in the till, or raise the limit deliberately.',
    };
  }

  // ⛔ Office and staff balances are complete, so this is a real shortfall — no overdraft applies,
  // and the limit column is not consulted for them at all.
  return {
    blocked: true,
    message:
      `"${account.name}" holds ${holds} and this takes ${drawn}. Unlike a cashier ` +
      'drawer, this balance is complete — nothing is waiting to be posted into it — so record ' +
      'the money coming in first, or draw it from somewhere that holds it.',
  };
}
