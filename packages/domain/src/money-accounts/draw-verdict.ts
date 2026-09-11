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
export interface DrawableAccount {
  name: string;
  custodian: 'cashier' | 'office' | 'staff';
  /** ⭐ How far below zero a CASHIER drawer may go. Positive; office/staff ignore it. */
  overdraftLimit: string;
  /** ⭐ Non-null makes this a TILL FLOAT pot — it blocks at zero regardless of custodian. */
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
  available: number,
  drawn: number,
): DrawVerdict {
  if (drawn <= available) return OK;

  const short = (drawn - available).toFixed(2);
  const holds = available.toFixed(2);

  // ⭐ T-153 — A FLOAT POT BLOCKS, even though its custodian is the cashier.
  //
  // > **Ian, 2026-08-29:** *"if this is implemented we guard all accounts to never go negative,
  // > all stops at 0 never below."*
  //
  // ⚠️ The warn-vs-block split below is NOT really about the custodian — it is about **whether the
  // ledger can see the whole balance**. A takings drawer holds today's sales hours before they
  // post at verify, so its ledger balance is provisional. **A float pot's is complete**: it only
  // ever moves by transfer, exactly like the office safe two branches down, and every one of those
  // transfers posts the moment it happens.
  //
  // ⛔ So a float going negative is never a timing artefact. It means the side pocket has been
  // spent past what is in it, which is the one thing the daily count exists to catch.
  if (account.floatTarget !== null && account.floatTarget !== undefined) {
    return {
      blocked: true,
      message:
        `"${account.name}" is a till float holding ${holds} and this takes ${drawn.toFixed(2)}. ` +
        'A float is a side pocket, not a drawer that runs behind — its balance is complete, so it ' +
        'cannot go below zero. Pay the rest from the takings drawer, or top the float up from the ' +
        'office first.',
    };
  }

  if (account.custodian === 'cashier') {
    const limit = Number(account.overdraftLimit);
    // ⭐ Where the balance LANDS, not how big the draw is. A ₱50,000 draw against a ₱49,000 drawer
    // leaves it ₱1,000 behind, which is ordinary; a ₱1,000 draw against a drawer already ₱19,500
    // behind is what pushes it past the cap.
    const after = available - drawn;

    if (-after <= limit) {
      // ⚠️ A WARNING, NOT A REFUSAL. The till's true balance is unknowable until the day is
      // verified, so this is a "look at this", not a "you are wrong".
      return {
        blocked: false,
        message:
          `"${account.name}" is short ${short} against the books (holds ${holds}, this takes ` +
          `${drawn.toFixed(2)}). That is expected while today's sales are unverified — the cash is ` +
          'in the till before it is in the ledger. If the day IS verified, the drawer is genuinely ' +
          `over-spent and needs counting. Allowed down to −${limit.toFixed(2)}.`,
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
        `"${account.name}" would go to −${(-after).toFixed(2)}, past the ${limit.toFixed(2)} ` +
        `overdraft this drawer is allowed (holds ${holds}, this takes ${drawn.toFixed(2)}). ` +
        'A cashier drawer is expected to run behind while the day is unverified, but not this far. ' +
        'Verify the day, remit what is in the till, or raise the limit deliberately.',
    };
  }

  // ⛔ Office and staff balances are complete, so this is a real shortfall — no overdraft applies,
  // and the limit column is not consulted for them at all.
  return {
    blocked: true,
    message:
      `"${account.name}" holds ${holds} and this takes ${drawn.toFixed(2)}. Unlike a cashier ` +
      'drawer, this balance is complete — nothing is waiting to be posted into it — so record ' +
      'the money coming in first, or draw it from somewhere that holds it.',
  };
}
