/**
 * The opening balances — step C3, and the post that closes it at C5. T-134.
 *
 * ## ⭐ Why each figure is its own BALANCED draft, and not one big unbalanced one
 *
 * The spec says C3 is *"one unposted `journal_entries` draft, editable in place"*. The database
 * says otherwise, and the database is right: `journal_entries_balance_check` is a **DEFERRABLE
 * INITIALLY DEFERRED** constraint trigger, so every entry — draft included — must balance and
 * carry at least two lines **at COMMIT**. An unbalanced draft cannot survive the transaction that
 * creates it, let alone several days.
 *
 * ⭐ So the shape that actually works is the one the accounting already implies: each figure is a
 * balanced pair against `3900 Opening balance equity`, entered as its own DRAFT. The **residual
 * accumulates in 3900** and nets to zero only when every side has been entered — which is exactly
 * the running difference C3 displays and C4 checks.
 *
 * ⚠️ Nothing is weakened by this. Drafts stay freely editable and deletable (the immutability
 * triggers fire only on `posted`), figures can be entered over days, and C5's post is still the
 * single act that makes the whole set final.
 */
import { cutoverRepo, journalRepo, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { parseMoneyInput } from '../shared/money-input';
import { gone, refuse } from '../shared/refusal';

export const OPENING_EQUITY_CODE = '3900';
export const OPENING_SOURCE_TYPE = 'opening_balance';

/** Decimal noise only. The same value every other module here uses. */
const EPSILON = 0.005;

export interface OpeningFigureInput {
  /** The real account the balance belongs to — `1110`, `2110`, `1310`… never `3900`. */
  accountCode: string;
  storeId: string;
  /** `debit` for what the business HAS, `credit` for what it OWES. */
  direction: 'debit' | 'credit';
  amount: string;
  /** Required on the control accounts, forbidden elsewhere — the database enforces which. */
  partyType?: string | null;
  partyId?: string | null;
  memo?: string | null;
  /** The conversion date. Every opening figure carries the same one. */
  entryDate: string;
}

/**
 * Add one opening figure, as its own draft.
 *
 * ⛔ Refuses `3900` itself: that account is the *other* side of every figure, and entering it
 * directly would let somebody hand-plug the residual to zero — which is precisely the escape hatch
 * this design refuses to have.
 */
export async function addOpeningFigure(
  tx: Tx | null,
  actor: Actor,
  input: OpeningFigureInput,
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'run_cutover', {});

    if (input.accountCode === OPENING_EQUITY_CODE) {
      throw refuse(
        'addOpeningFigure: 3900 is the other half of every opening figure, not a figure of its ' +
          'own. Entering it directly would let the difference be plugged to zero by hand, which ' +
          'is the one thing this is built not to allow.',
        '3900 is the other half of every opening figure, not a figure of its own. Entering it ' +
          'directly would let the difference be plugged to zero by hand, which is the one thing ' +
          'this is built not to allow.',
      );
    }
    const amount = parseMoneyInput(input.amount, 'addOpeningFigure: the amount');
    if (!(Number(amount) > 0)) {
      throw refuse('addOpeningFigure: an opening figure has to be greater than zero.', 'An opening figure has to be greater than zero.');
    }

    const period = await journalRepo.findPeriodForDate(trx, actor.orgId, input.entryDate);
    if (!period) {
      throw refuse(
        `addOpeningFigure: no fiscal period covers ${input.entryDate}. Create the opening period ` +
          'first — the conversion posts into it.',
        `No fiscal period covers ${input.entryDate}. Create the opening period first — the conversion posts into it.`,
      );
    }

    const memo = input.memo?.trim() || `Opening balance — ${input.accountCode}`;
    const { id: entryId, created } = await journalRepo.insertDraftEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.entryDate,
      periodId: period.id,
      memo,
      sourceType: OPENING_SOURCE_TYPE,
      sourceId: `${actor.orgId}:${input.accountCode}:${input.storeId}:${input.partyId ?? ''}`,
      // ⭐ The idempotency key IS the identity of the figure: one opening balance per account,
      // per store, per party. Re-entering the same one returns the existing draft rather than
      // adding a second — which is what makes "enter it over several days" safe to retry.
      idempotencyKey: `opening:${actor.orgId}:${input.accountCode}:${input.storeId}:${input.partyId ?? ''}`,
    });

    const amountStr = amount;
    const real = {
      accountCode: input.accountCode,
      storeId: input.storeId,
      ...(input.direction === 'debit' ? { debit: amountStr } : { credit: amountStr }),
      ...(input.partyId ? { partyType: input.partyType ?? null, partyId: input.partyId } : {}),
      lineMemo: memo,
    };
    // The other half, always 3900, always the opposite side.
    const equity = {
      accountCode: OPENING_EQUITY_CODE,
      storeId: input.storeId,
      ...(input.direction === 'debit' ? { credit: amountStr } : { debit: amountStr }),
      lineMemo: memo,
    };

    if (created) {
      await journalRepo.insertLines(trx, entryId, await resolveLines(trx, actor.orgId, [real, equity]));
    }
    return { entryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

type DraftLine = {
  accountCode: string;
  storeId: string;
  debit?: string;
  credit?: string;
  partyType?: string | null;
  partyId?: string | null;
  lineMemo: string;
};

/** `insertLines` wants account IDs; the caller thinks in codes, as everywhere else here. */
async function resolveLines(tx: Tx, orgId: string, lines: DraftLine[]) {
  const out = [];
  let lineNo = 1;
  for (const l of lines) {
    out.push({
      accountId: await journalRepo.resolveAccountId(tx, orgId, l.accountCode),
      lineNo: lineNo++,
      storeId: l.storeId,
      debit: l.debit ?? '0',
      credit: l.credit ?? '0',
      partyType: l.partyType ?? null,
      partyId: l.partyId ?? null,
      lineMemo: l.lineMemo,
      channelId: null,
    });
  }
  return out;
}

/**
 * Remove an opening figure that was entered wrongly.
 *
 * ⭐ A plain delete, and that is correct **because it is still a draft**. Forcing a formal reversal
 * to fix a typo in a document that was never final is ceremony, not control — invariant 5 starts
 * at C5's post, which is what correction 3 of the spec settled.
 */
export async function removeOpeningFigure(
  tx: Tx | null,
  actor: Actor,
  input: { entryId: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'run_cutover', {});
    const entry = await journalRepo.findEntryById(trx, input.entryId);
    if (!entry || entry.orgId !== actor.orgId) {
      throw gone(`removeOpeningFigure: entry ${input.entryId} does not exist.`, 'opening figure');
    }
    if (entry.sourceType !== OPENING_SOURCE_TYPE) {
      throw refuse('removeOpeningFigure: that is not an opening-balance entry.', 'That is not an opening-balance entry.');
    }
    if (entry.status !== 'draft') {
      throw refuse(
        'removeOpeningFigure: this has already been posted. The books are open, so a correction ' +
          'is a reversal now, not a deletion.',
        'This has already been posted. The books are open, so a correction is a reversal now, not a deletion.',
      );
    }
    await cutoverRepo.deleteDraftEntry(trx, actor.orgId, input.entryId);
  };
  if (tx) return run(tx);
  return transaction(run);
}

export interface PostOpeningResult {
  posted: number;
  entryIds: string[];
}

/**
 * ⭐ **C5 — the act that opens the books.**
 *
 * Checks the two things that must be true, then flips every opening draft to posted in ONE
 * transaction. ⛔ A residual halts here and there is no override: the whole design of C3's running
 * difference is that this moment is never a surprise.
 */
export async function postOpeningBalances(
  tx: Tx | null,
  actor: Actor,
): Promise<PostOpeningResult> {
  const run = async (trx: Tx): Promise<PostOpeningResult> => {
    await authorize(trx, actor, 'run_cutover', {});

    const drafts = await cutoverRepo.openingDrafts(trx, actor.orgId);
    if (drafts.length === 0) {
      throw refuse('postOpeningBalances: there are no opening figures to post.', 'There are no opening figures to post.');
    }

    const residual = await cutoverRepo.openingEquityResidual(trx, actor.orgId);
    if (Math.abs(Number(residual)) > EPSILON) {
      throw refuse(
        `postOpeningBalances: opening balance equity still carries ₱${residual}. This halts — ` +
          'there is no plug account. Find the difference; it has been on screen the whole time.',
        `Opening balance equity still carries ₱${residual}. This halts — there is no plug account. Find the difference; it has been on screen the whole time.`,
      );
    }

    const drift = await cutoverRepo.trialBalanceDrift(trx, actor.orgId);
    if (Math.abs(Number(drift)) > EPSILON) {
      throw refuse(
        `postOpeningBalances: debits and credits differ by ₱${drift} across the ledger. The books ` +
          'cannot open on an entry that does not balance.',
        `Debits and credits differ by ₱${drift} across the ledger. The books cannot open on an entry that does not balance.`,
      );
    }

    for (const d of drafts) await journalRepo.postDraftEntry(trx, d.id, actor.personId);

    await cutoverRepo.recordStep(trx, {
      orgId: actor.orgId,
      storeId: null,
      stepCode: 'C5',
      completion: 'performed',
      note: `Posted ${drafts.length} opening figure(s).`,
      completedBy: actor.personId,
    });

    return { posted: drafts.length, entryIds: drafts.map((d) => d.id) };
  };
  if (tx) return run(tx);
  return transaction(run);
}
