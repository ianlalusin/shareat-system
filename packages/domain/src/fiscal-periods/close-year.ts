/**
 * closeYear — the one journal entry ADR-006 describes: every income and expense balance for the
 * year zeroed into 3300 Retained earnings, posted through the existing `postEntry`, dated the first
 * day of the following year. T-274, `docs/tasks/274-adr-006-year-close-entry.md`,
 * `docs/decisions/ADR-006-period-close.md`.
 *
 * ⛔ **Reuses everything that already exists rather than re-deriving it**: the SAME `close_period`
 * capability `closePeriod` checks (ADR-006 §7.4 — "the grant covers closing and the year-close
 * posting only"), the SAME `hasEarlierOpenPeriod` query (asked about 1 January of next year, it
 * already means "has every month through December been closed"), the SAME `getIncomeStatementLines`
 * report query for the year's totals, and the SAME `postEntry` every other entry uses. The only new
 * write this task adds is `lockYearPeriods` — ADR-006 §7.5's `closed -> locked`, which nothing in
 * this codebase has ever implemented before.
 *
 * ⚠️ **Shipping this permanently removes T-264 slice 3's admin override from every month of the year
 * once it locks** (`post-entry.ts`'s `'locked'` branch refuses `periodOverride` unconditionally).
 * That is intended, not a regression — bible row 193's reasoning is that a locked period's balances
 * have already been consumed by a later year's close, so letting a further entry in would silently
 * invalidate the closing entry that consumed them.
 */
import { fiscalPeriodsRepo, reportsRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { add, compare, money, negate, subtract, ZERO } from '@shareat/core';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';

export interface CloseYearInput {
  orgId: string;
  /** The calendar year being closed, e.g. 2027. The entry posts on 1 January of `year + 1`. */
  year: number;
}

export interface CloseYearResult {
  entryId: string;
  /** false means this year was already closed — the idempotency key already existed and nothing
   *  new was written (mirrors `postEntry`'s own `created`). */
  created: boolean;
  /** How many of `year`'s twelve periods this call transitioned `closed -> locked`. 0 on an
   *  idempotent replay where they were already locked — not an error. */
  periodsLocked: number;
}

/**
 * Closes fiscal `year` for `actor.orgId`: computes every income/expense account's net movement for
 * the year, posts ONE balanced entry zeroing them into 3300, dated `year + 1`-01-01, then locks
 * every one of `year`'s periods. Idempotent and safely re-runnable, in one transaction — pass an
 * open `tx`; there is no `tx: null` form here because, unlike `postEntry`/`reverseEntry`, this
 * function is never meant to be called bare at the top of a request — it is always the close
 * routine's own transaction.
 */
export async function closeYear(
  tx: Tx,
  actor: Actor,
  input: CloseYearInput,
): Promise<CloseYearResult> {
  await authorize(tx, actor, 'close_period', {});

  const nextJanuary = `${input.year + 1}-01`;
  const earlierOpen = await fiscalPeriodsRepo.hasEarlierOpenPeriod(tx, input.orgId, nextJanuary);
  if (earlierOpen) {
    throw new Error(
      `closeYear: an earlier period for this organisation is still open. ` +
        `Every month of ${input.year} must be closed before the year itself can close.`,
    );
  }

  // ⛔ `includeYearClose: false` is LOAD-BEARING, not the default relied on — see the SPEC. A prior
  // year's own closing entry is dated 1 January of THIS range and would otherwise be absorbed into
  // this year's totals, double-counting its income into 3300.
  const rows = await reportsRepo.getIncomeStatementLines(tx, {
    orgId: input.orgId,
    fromDate: `${input.year}-01-01`,
    toDate: `${input.year}-12-31`,
    includeYearClose: false,
  });

  // ⛔ Per-account NET, never the raw totals swapped directly. `debitTotal`/`creditTotal` are two
  // INDEPENDENT sums (reports.ts:163-166) — an account charged and later refunded in the same year
  // comes back with BOTH nonzero, and swapping them straight onto one line would emit a two-sided
  // line `journal_lines_exactly_one_side_check` rejects (migration 0003:74-76). Net first, one side
  // per account, using the RAW subtraction (not `netAmount`, which is signed by account TYPE and
  // would force a branch on it) — found in review by system32-85, reproduced by test 11 against the
  // unfixed code before this comment existed.
  const lines: PostEntryLine[] = [];
  for (const row of rows) {
    const net = subtract(money(row.debitTotal), money(row.creditTotal));
    const netVsZero = compare(net, ZERO);
    if (netVsZero > 0) {
      lines.push({ accountCode: row.accountCode, credit: net });
    } else if (netVsZero < 0) {
      lines.push({ accountCode: row.accountCode, debit: negate(net) });
    }
    // netVsZero === 0: this account is already closed for the year — no line, and a zero-amount
    // line would itself violate journal_lines_exactly_one_side_check.
  }

  if (lines.length === 0) {
    throw new Error(`closeYear: no income or expense activity to close for ${input.year}`);
  }

  // The 3300 plug — computed from the SAME rows' raw totals. Unchanged by the fix above: for any
  // account whose net is exactly zero, debitTotal and creditTotal are equal and cancel in this sum
  // exactly as they do in the per-account net, so totalCredit - totalDebit equals -Sum(net) whether
  // or not a given account produced a line. Bible §6, money in centavos via @shareat/core, never a
  // float.
  const totalCredit = add(...rows.map((row) => money(row.creditTotal)));
  const totalDebit = add(...rows.map((row) => money(row.debitTotal)));
  const plugNet = subtract(totalCredit, totalDebit);
  const plugVsZero = compare(plugNet, ZERO);
  if (plugVsZero > 0) {
    lines.push({ accountCode: '3300', credit: plugNet });
  } else if (plugVsZero < 0) {
    lines.push({ accountCode: '3300', debit: negate(plugNet) });
  }
  // plugVsZero === 0: no plug line — the closing lines already balance each other.

  const posted = await postEntry(tx, {
    orgId: input.orgId,
    entryDate: `${input.year + 1}-01-01`,
    sourceType: 'year_close',
    sourceId: `${input.orgId}:${input.year}`,
    idempotencyKey: `year_close:${input.orgId}:${input.year}`,
    memo: `Year close ${input.year}`,
    postedBy: actor.personId,
    lines,
  });

  // Always attempted, even on a replay (`posted.created === false`) — idempotent by its own WHERE
  // guard, so a prior attempt that posted the entry but crashed before locking self-heals here
  // instead of leaving the year permanently un-locked.
  const periodsLocked = await fiscalPeriodsRepo.lockYearPeriods(tx, input.orgId, input.year);

  return { entryId: posted.entryId, created: posted.created, periodsLocked };
}
