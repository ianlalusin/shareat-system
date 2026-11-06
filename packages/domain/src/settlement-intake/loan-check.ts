/**
 * T-511 S5b - the company-wide Grab loan check. docs/designs/channel-settlement-upload.md Component F; spec "S5b" item 3.
 *
 * Grab's loan rows name no loan, so a day's deductions are checked against the company's open loans together, never store by store:
 * the rows of every store's file for one sales date are allocated to the open loans, OLDEST START DATE FIRST, each up to what it expects that day
 * (its repayment amount, or the remaining outstanding on its final payment); a row that does not fit one loan splits across two. An admin override pins
 * a row to a loan instead. The day then reads: matches / doesn't match / waiting for other stores' files / no matching loan recorded.
 *
 * `checkLoanDay` and `loanCheckForViewer` are pure (no database). `loanCheckForDay` is the one that reads: it loads the company's loans and rows and
 * hands them to the pure part. Manager privacy (design goal 7, BOSS ruling 4): from the company-wide answer a non-admin sees only the status, a sentence
 * with no store name, no foreign loan name and no company-wide amount, and the lines of HIS OWN stores' rows.
 *
 * "Outstanding before the day" is the ledger's outstanding minus the deductions already allocated to the loan on EARLIER days whose day lines are still
 * pending (a booked day is already in the ledger). Nothing here books or posts.
 */
import { can, type Actor } from '@shareat/auth';
import { accessRepo, loansRepo, settlementIntakeRepo, storesRepo, type Tx } from '@shareat/db';
import { ZERO, compare, fromCentavos, money, toCentavos, type Money } from '@shareat/core/money';
import { groupedMoney } from './text';

export type LoanCheckStatus = 'ok' | 'mismatch' | 'waiting_for_other_stores' | 'no_matching_loan';

export interface OpenLoan {
  loanId: string;
  name: string;
  ownerStoreId: string;
  ownerStoreName: string;
  startDate: string;
  repaymentAmount: Money | null;
  outstandingBefore: Money;
}

export interface DeductionRow {
  key: string;
  storeId: string;
  /** a magnitude */
  amount: Money;
  /** a non-null loan id is an admin override: the row is pinned to that loan */
  loanId?: string | null;
}

export interface LoanCheckInput {
  salesDate: string;
  loans: readonly OpenLoan[];
  rows: readonly DeductionRow[];
  storesNeedingFile: readonly { storeId: string; storeName: string }[];
  storesWithFile: ReadonlySet<string>;
}

export interface LoanAllocation {
  rowKey: string;
  loanId: string;
  amount: Money;
}

export interface LoanCheckLoan {
  loanId: string;
  loanName: string;
  ownerStoreId: string;
  ownerStoreName: string;
  expected: Money;
  allocated: Money;
  /** this is the loan's last payment: its expected amount is what is left, not the usual repayment */
  final: boolean;
}

export interface LoanCheckResult {
  salesDate: string;
  status: LoanCheckStatus;
  /** true for every status but ok */
  blocking: boolean;
  total: Money;
  expected: Money;
  allocations: LoanAllocation[];
  byLoan: LoanCheckLoan[];
  waitingOn: { storeId: string; storeName: string }[];
  /** the full (admin) sentence */
  sentence: string;
  /** which store each row belongs to, so a viewer's own rows can be picked out without naming any store */
  rowStoreIds: Record<string, string>;
}

/** Grab shortens a loan's last payment by a centavo at times. */
const FINAL_TOLERANCE = 1n;

const sumOf = (xs: bigint[]): bigint => xs.reduce((t, n) => t + n, 0n);

interface PlanItem {
  loan: OpenLoan;
  final: boolean;
  expected: bigint;
  /** the least this loan may take and still match: a final loan may be one centavo short, any other loan none */
  min: bigint;
  room: bigint;
  allocated: bigint;
}

/**
 * Hands the rows to the open loans, oldest start date first. `tolerant` is the second try, used only when the files fall short and a loan is final: each final
 * loan then asks for its minimum first, and what is left over tops its last centavo up afterwards, so a missing centavo lands on a FINAL loan, never an ordinary one.
 */
function allocate(open: readonly OpenLoan[], rows: readonly DeductionRow[], tolerant: boolean): { plan: PlanItem[]; allocations: LoanAllocation[]; leftover: bigint } {
  const plan: PlanItem[] = open.map((l) => {
    const repayment = l.repaymentAmount === null ? null : toCentavos(l.repaymentAmount);
    const outstanding = toCentavos(l.outstandingBefore);
    const final = repayment !== null && outstanding <= repayment + FINAL_TOLERANCE;
    const expected = repayment === null ? 0n : final ? outstanding : repayment;
    const min = final && expected > FINAL_TOLERANCE ? expected - FINAL_TOLERANCE : expected;
    return { loan: l, final, expected, min, room: tolerant ? min : expected, allocated: 0n };
  });
  const planOf = new Map(plan.map((p) => [p.loan.loanId, p]));

  // pass 1: an admin override takes its loan's room first, whatever the order would have been
  for (const r of rows) {
    const p = r.loanId ? planOf.get(r.loanId) : undefined;
    if (p) p.room -= toCentavos(r.amount);
  }
  // pass 2: rows in the order given
  const allocations: LoanAllocation[] = [];
  const left: { r: DeductionRow; remaining: bigint }[] = [];
  let leftover = 0n;
  for (const r of rows) {
    let remaining = toCentavos(r.amount);
    const pinned = r.loanId ? planOf.get(r.loanId) : undefined;
    if (r.loanId && !pinned) {
      // pinned to a loan that is not open: nowhere to go
      leftover += remaining;
      continue;
    }
    if (pinned) {
      pinned.allocated += remaining;
      allocations.push({ rowKey: r.key, loanId: pinned.loan.loanId, amount: r.amount });
      continue;
    }
    for (const p of plan) {
      if (remaining === 0n) break;
      if (p.room <= 0n) continue;
      const take = remaining < p.room ? remaining : p.room;
      p.room -= take;
      p.allocated += take;
      remaining -= take;
      allocations.push({ rowKey: r.key, loanId: p.loan.loanId, amount: fromCentavos(take) });
    }
    left.push({ r, remaining });
  }
  // pass 3 (tolerant only): what is left tops up the last centavo of a final loan
  for (const x of left) {
    if (tolerant) {
      for (const p of plan) {
        if (x.remaining === 0n) break;
        const top = p.final ? p.expected - p.allocated : 0n;
        if (top <= 0n) continue;
        const take = x.remaining < top ? x.remaining : top;
        p.allocated += take;
        x.remaining -= take;
        allocations.push({ rowKey: x.r.key, loanId: p.loan.loanId, amount: fromCentavos(take) });
      }
    }
    leftover += x.remaining;
  }
  return { plan, allocations, leftover };
}

export function checkLoanDay(input: LoanCheckInput): LoanCheckResult {
  const open = input.loans
    .filter((l) => l.startDate.localeCompare(input.salesDate) < 0 && toCentavos(l.outstandingBefore) > 0n)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.loanId.localeCompare(b.loanId));

  const total = sumOf(input.rows.map((r) => toCentavos(r.amount)));
  let run = allocate(open, input.rows, false);
  const expectedSum = sumOf(run.plan.map((p) => p.expected));
  if (total < expectedSum && run.plan.some((p) => p.final)) run = allocate(open, input.rows, true);
  const { plan, allocations, leftover } = run;

  const waitingOn = input.storesNeedingFile.filter((s) => !input.storesWithFile.has(s.storeId)).map((s) => ({ storeId: s.storeId, storeName: s.storeName }));
  const overLoans = plan.filter((p) => p.allocated > p.expected);
  // each loan on its own: no loan over, no ordinary loan short, a final loan at most one centavo short
  const offLoans = plan.filter((p) => p.allocated > p.expected || p.allocated < p.min);

  let status: LoanCheckStatus;
  if (waitingOn.length > 0) status = 'waiting_for_other_stores';
  else if (leftover > 0n) status = 'no_matching_loan';
  else if (offLoans.length > 0) status = 'mismatch';
  else status = 'ok';

  const finalTookPart = plan.some((p) => p.final && p.allocated > 0n);
  const finalFull = plan.some((p) => p.final && p.allocated >= p.expected);
  let sentence: string;
  if (status === 'ok') {
    sentence = total === 0n ? 'Grab loan check: no loan payment is expected on this day' : `Grab loan check, all stores together: ${groupedMoney(fromCentavos(total))} matches${finalTookPart ? ' (last payment, rounded by Grab)' : ''}`;
  } else if (status === 'waiting_for_other_stores') {
    sentence = `Waiting for other stores' files (${waitingOn.map((s) => s.storeName).join(', ')}).`;
  } else if (status === 'no_matching_loan') {
    sentence = finalFull
      ? `Grab loan check, all stores together: the files take ${groupedMoney(fromCentavos(leftover))} more than the loan still owes.`
      : `No matching loan recorded for ${groupedMoney(fromCentavos(leftover))} of this day's deductions, all stores together.`;
  } else if (total !== expectedSum) {
    sentence = `Grab loan check, all stores together: the loan amounts don't match. The files take ${groupedMoney(fromCentavos(total))} but the loans expect ${groupedMoney(fromCentavos(expectedSum))}.`;
  } else {
    const parts = overLoans.map((p) => `${p.loan.name} takes ${groupedMoney(fromCentavos(p.allocated))} but expects ${groupedMoney(fromCentavos(p.expected))}`);
    sentence = `Grab loan check, all stores together: the loan amounts don't match. The total is right but it is split differently across the loans: ${parts.join('; ')}.`;
  }

  return {
    salesDate: input.salesDate,
    status,
    blocking: status !== 'ok',
    total: fromCentavos(total),
    expected: fromCentavos(expectedSum),
    allocations,
    byLoan: plan.map((p) => ({
      loanId: p.loan.loanId, loanName: p.loan.name, ownerStoreId: p.loan.ownerStoreId, ownerStoreName: p.loan.ownerStoreName,
      expected: fromCentavos(p.expected), allocated: fromCentavos(p.allocated), final: p.final,
    })),
    waitingOn,
    sentence,
    rowStoreIds: Object.fromEntries(input.rows.map((r) => [r.key, r.storeId])),
  };
}

export interface LoanCheckViewer {
  isAdmin: boolean;
  storeIds: ReadonlySet<string>;
}

export interface LoanCheckOwnLine {
  amount: Money;
  loanName: string;
  ownerStoreName: string;
}

export interface LoanCheckViewerView {
  status: LoanCheckStatus;
  blocking: boolean;
  sentence: string;
  ownLines: LoanCheckOwnLine[];
}

/** What one viewer may read of a company-wide result. An admin gets everything; anyone else gets the status in words that name no store and show no company amount. */
export function loanCheckForViewer(result: LoanCheckResult, viewer: LoanCheckViewer): LoanCheckViewerView {
  const loanOf = new Map(result.byLoan.map((l) => [l.loanId, l]));
  const ownLines: LoanCheckOwnLine[] = [];
  for (const a of result.allocations) {
    const store = result.rowStoreIds[a.rowKey];
    const loan = loanOf.get(a.loanId);
    if (!loan || store === undefined || !(viewer.isAdmin || viewer.storeIds.has(store))) continue;
    ownLines.push({ amount: a.amount, loanName: loan.loanName, ownerStoreName: loan.ownerStoreName });
  }
  if (viewer.isAdmin) return { status: result.status, blocking: result.blocking, sentence: result.sentence, ownLines };
  const final = result.byLoan.some((l) => l.final && compare(l.allocated, ZERO) > 0);
  const sentence: Record<LoanCheckStatus, string> = {
    ok: `Grab loan check: matches${final ? ' (last payment, rounded by Grab)' : ''}`,
    mismatch: "Grab loan check: the loan amounts don't match.",
    waiting_for_other_stores: "Waiting for other stores' files.",
    no_matching_loan: 'No matching loan recorded.',
  };
  return { status: result.status, blocking: result.blocking, sentence: sentence[result.status], ownLines };
}

/* ------------------------------------------------------------------ the part that reads */

/** The company's loans, ledger outstanding and staged deduction rows through one date: loaded once, then asked for any day up to it. */
export interface LoanCheckContext {
  orgId: string;
  throughDate: string;
  loans: Awaited<ReturnType<typeof loansRepo.listLoans>>;
  outstanding: Map<string, Money>;
  storeNames: Map<string, string>;
  rows: settlementIntakeRepo.DeductionRowRecord[];
  /** the answers already worked out, by sales date (a list asks for the same day more than once) */
  answers: Map<string, LoanCheckResult>;
  /** who has a file and who recorded sales, by sales date, read ahead for a whole list (see `primeLoanCheckCoverage`); a date not in it is read when asked */
  coverage?: Map<string, settlementIntakeRepo.GrabStoreCoverage[]>;
  /** the rows grouped by date with the pending totals carried forward, built on first use (see `timelineOf`) */
  timeline?: Timeline;
}

/** Reads the Grab file coverage of all these dates in one go, so asking about each of them later costs no query. */
export async function primeLoanCheckCoverage(tx: Tx, ctx: LoanCheckContext, salesDates: readonly string[]): Promise<void> {
  const have = ctx.coverage ?? new Map<string, settlementIntakeRepo.GrabStoreCoverage[]>();
  const missing = salesDates.filter((d) => !have.has(d));
  for (const [d, list] of await settlementIntakeRepo.grabStoreCoverageForDates(tx, ctx.orgId, missing)) have.set(d, list);
  for (const d of missing) if (!have.has(d)) have.set(d, []);
  ctx.coverage = have;
}

export async function loadLoanCheckContext(tx: Tx, orgId: string, throughDate: string): Promise<LoanCheckContext> {
  const loans = await loansRepo.listLoans(tx, orgId, { status: 'active' });
  const positions = await loansRepo.positionsByLoan(tx, orgId);
  const outstanding = new Map(loans.map((l) => [l.id, money(positions.get(l.id)?.outstanding ?? '0')]));
  const storeNames = new Map((await storesRepo.listForOrg(tx, orgId)).map((s) => [s.id, s.name]));
  const rows = await settlementIntakeRepo.activeDeductionRows(tx, orgId, throughDate);
  return { orgId, throughDate, loans, outstanding, storeNames, rows, answers: new Map() };
}

function openLoansOn(ctx: LoanCheckContext, pending: ReadonlyMap<string, bigint>): OpenLoan[] {
  return ctx.loans.map((l) => {
    const left = toCentavos(ctx.outstanding.get(l.id) ?? ZERO) - (pending.get(l.id) ?? 0n);
    return {
      loanId: l.id, name: l.name, ownerStoreId: l.storeId, ownerStoreName: ctx.storeNames.get(l.storeId) ?? 'a store', startDate: l.startDate,
      repaymentAmount: l.repaymentAmount === null ? null : money(l.repaymentAmount), outstandingBefore: fromCentavos(left < 0n ? 0n : left),
    };
  });
}

/** The staged rows grouped by date, and what each loan has pending BEFORE each date: worked out once, by one pass over the days in date order. */
interface Timeline {
  rowsByDate: Map<string, settlementIntakeRepo.DeductionRowRecord[]>;
  /** the dates that have rows, ascending */
  dates: string[];
  /** pendingBefore[i] = deductions pending on every date before dates[i]; the last entry is the total over all dates */
  pendingBefore: ReadonlyMap<string, bigint>[];
}

function timelineOf(ctx: LoanCheckContext): Timeline {
  if (ctx.timeline) return ctx.timeline;
  const rowsByDate = new Map<string, settlementIntakeRepo.DeductionRowRecord[]>();
  for (const r of ctx.rows) (rowsByDate.get(r.salesDate) ?? rowsByDate.set(r.salesDate, []).get(r.salesDate)!).push(r);
  const dates = [...rowsByDate.keys()].sort();
  const pendingBefore: ReadonlyMap<string, bigint>[] = [];
  let pending = new Map<string, bigint>();
  for (const d of dates) {
    pendingBefore.push(pending);
    const rows = rowsByDate.get(d)!;
    const r = checkLoanDay({ salesDate: d, loans: openLoansOn(ctx, pending), rows: rows.map(toRow), storesNeedingFile: [], storesWithFile: new Set() });
    const pendingKeys = new Set(rows.filter((x) => x.reviewState === 'pending').map((x) => x.key));
    const next = new Map(pending);
    for (const a of r.allocations) if (pendingKeys.has(a.rowKey)) next.set(a.loanId, (next.get(a.loanId) ?? 0n) + toCentavos(a.amount));
    pending = next;
  }
  pendingBefore.push(pending);
  ctx.timeline = { rowsByDate, dates, pendingBefore };
  return ctx.timeline;
}

/**
 * The company-wide answer for one sales date, from a loaded context. Earlier days still pending take their deductions off each loan's outstanding before this
 * day; that is worked out for every date in ONE forward pass the first time any date is asked (`timelineOf`), so a list of N days costs N day-checks, not N-squared.
 * `needing` is the stores that should have a file for the day.
 */
export function loanCheckFromContext(ctx: LoanCheckContext, salesDate: string, needing: { storeIds: readonly { storeId: string; storeName: string }[]; withFile: ReadonlySet<string> }): LoanCheckResult {
  const t = timelineOf(ctx);
  let before = 0;
  while (before < t.dates.length && t.dates[before]!.localeCompare(salesDate) < 0) before++;
  const rows = (t.rowsByDate.get(salesDate) ?? []).map(toRow);
  return checkLoanDay({ salesDate, loans: openLoansOn(ctx, t.pendingBefore[before]!), rows, storesNeedingFile: needing.storeIds, storesWithFile: needing.withFile });
}

const toRow = (r: settlementIntakeRepo.DeductionRowRecord): DeductionRow => ({ key: r.key, storeId: r.storeId, amount: r.amount, loanId: r.loanId });

/** Who is asking: an admin sees everything, anyone else their own stores. The gate is the existing admin-level capability. */
export async function loanCheckViewerOf(tx: Tx, orgId: string, personId: string): Promise<LoanCheckViewer> {
  return { isAdmin: await can(tx, { orgId, personId }, 'override_period_lock'), storeIds: new Set(await accessRepo.storeIdsForPerson(tx, personId)) };
}

export interface LoanCheckForDay {
  /** the full company-wide answer: for the server's own use, never sent to a screen as it is */
  result: LoanCheckResult;
  /** what the actor may read */
  view: LoanCheckViewerView;
}

/**
 * The loan check of one Grab sales date, for this actor. The company-wide rows are read whoever asks (the check is company-wide by nature);
 * what comes back to a non-admin is the redacted view only. `waiting for other stores` is looked for only when the day does not already match.
 */
export async function loanCheckForDay(tx: Tx, actor: Actor, salesDate: string, opts: { context?: LoanCheckContext; viewer?: LoanCheckViewer } = {}): Promise<LoanCheckForDay> {
  const ctx = opts.context && opts.context.throughDate.localeCompare(salesDate) >= 0 ? opts.context : await loadLoanCheckContext(tx, actor.orgId, salesDate);
  const viewer = opts.viewer ?? (await loanCheckViewerOf(tx, actor.orgId, actor.personId));
  let result = ctx.answers.get(salesDate);
  if (!result) {
    result = loanCheckFromContext(ctx, salesDate, { storeIds: [], withFile: new Set() });
    if (result.status !== 'ok') {
      const coverage = ctx.coverage?.get(salesDate) ?? (await settlementIntakeRepo.grabStoreCoverage(tx, actor.orgId, salesDate));
      // A store is waited on when it holds a line (then it is not waiting, it is in), or its file covers the date and staff recorded Grab sales that day (the rule
      // of the "no file yet" list: a verified sales day, not no-sales, amount above zero). A store with no sales that day was closed or not open yet: never waited on.
      const needing = coverage.filter((c) => c.hasLine || (c.covered && c.hasSales)).map((c) => ({ storeId: c.storeId, storeName: c.storeName }));
      result = loanCheckFromContext(ctx, salesDate, { storeIds: needing, withFile: new Set(coverage.filter((c) => c.hasLine).map((c) => c.storeId)) });
    }
    ctx.answers.set(salesDate, result);
  }
  return { result, view: loanCheckForViewer(result, viewer) };
}
