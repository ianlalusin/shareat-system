/**
 * T-511 S5b - the review stage of the settlement upload: what a manager reads, rejects and reopens. docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 4.
 *
 * Nothing is booked here (approve and the books are slice 7). Four reads/writes:
 *   - `listReviewDays`: the day table, store-scoped by the gate of recording a channel settlement; Foodpanda days carry their invoice; Appendix-B-only
 *     invoices (PandaGO) are listed apart.
 *   - `getReviewDayDetail`: one day, with the staff-accuracy order list re-read from the stored file when the file and staff disagree.
 *   - `rejectDay` / `reopenDay`: a decision, compare-and-set on the line, audited. A rejection needs a reason (kept with the decision).
 *   - `overrideLoanAllocation`: an admin pins a Grab day's loan deductions to loans; the old lines go inactive, never deleted.
 *
 * Capabilities (no new one, BOSS ruling 6, 5 Nov): reject = `record_ar_collection` at the line's store (the gate of recording a channel settlement);
 * reopen = `override_period_lock` (admin, whole org); override = `edit_loan_repayment_amount` at the line's store (admin).
 * Order in every writer: the gate first, then the typed fields, then the compare-and-set. A refusal changes nothing and writes no audit row.
 */
import { authorize, AuthorizationError, can, type Actor, type Capability } from '@shareat/auth';
import { toBusinessDate } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { ZERO, compare, fromCentavos, isZero, money, subtract, toCentavos, type Money } from '@shareat/core/money';
import { auditLogRepo, fiscalPeriodsRepo, loansRepo, settlementIntakeRepo, storesRepo, type SettlementDayLineRow, type Tx } from '@shareat/db';
import { SETTLEMENT_DAY_REJECT_REASON_MAX, SETTLEMENT_DAY_REJECT_RULES } from '../field-rules/channel-settlements';
import { capAuditText } from '../shared/audit-text';
import { assertFieldRules } from '../shared/field-rules-assert';
import { refuse } from '../shared/refusal';
import { dayBlockers, dayBlockersForLines, type DayBlocker } from './day-checks';
import { loadLoanCheckContext, loanCheckViewerOf, loanCheckForDay, primeLoanCheckCoverage, type LoanCheckContext, type LoanCheckViewer, type LoanCheckViewerView } from './loan-check';
import { intakeRefusal } from './refusal';
import { stageFoodpandaDays } from './stage';
import { readStoredUpload, type StoredUpload } from './stored-upload';
import { groupedMoney, plainDate } from './text';

export type ReviewPlatform = 'grab' | 'foodpanda';
export type ReviewState = 'pending' | 'booked' | 'rejected';

export interface ReviewFilters {
  needsAttention?: boolean;
  storeId?: string;
  platform?: ReviewPlatform;
  /** YYYY-MM, the month of the sales date */
  period?: string;
}

export interface SettlementReviewRow {
  lineId: string;
  storeId: string;
  storeName: string;
  platform: ReviewPlatform;
  salesDate: string;
  /** Foodpanda: the invoice; Grab: null */
  invoiceNumber: string | null;
  /** the file's order value */
  fileFigure: string;
  /** what staff recorded, read fresh; null while the sales day is not verified */
  staffFigure: string | null;
  /** file minus staff, read fresh */
  difference: string | null;
  reviewState: ReviewState;
  paidState: 'paid' | 'not_paid';
  changedSinceBooked: boolean;
  /** Grab only */
  loanCheck: { status: LoanCheckViewerView['status']; sentence: string } | null;
  /** sentences, from dayBlockers (a day already decided shows none) */
  blockers: string[];
  needsAttention: boolean;
}

export interface PandagoOnlyInvoice {
  uploadId: string;
  storeId: string;
  storeName: string;
  invoiceNumber: string | null;
  /** the invoice date the workbook carries; the PDF may print another */
  workbookDate: string;
  pandagoNetTotal: string;
  pandagoReceivable: string;
  sentence: string;
  dateNote: string;
  /** the stored file could not be read again (the reader refused or failed): no figure is shown, the sentence says so */
  unreadable: boolean;
}

export interface ReviewList {
  days: SettlementReviewRow[];
  pandagoOnly: PandagoOnlyInvoice[];
}

const isZeroText = (t: string | null): boolean => t !== null && isZero(money(t));

/** Stores of the org the actor may review (the gate of recording a channel settlement, per store). */
async function visibleStoreIds(tx: Tx, actor: Actor): Promise<{ ids: string[]; names: Map<string, string> }> {
  const stores = await storesRepo.listForOrg(tx, actor.orgId);
  const ids: string[] = [];
  for (const s of stores) if (await can(tx, actor, 'record_ar_collection', { storeId: s.id })) ids.push(s.id);
  return { ids, names: new Map(stores.map((s) => [s.id, s.name])) };
}

const diffOf = (fileFigure: string, recorded: Money | null): { staffFigure: string | null; difference: string | null } =>
  recorded === null ? { staffFigure: null, difference: null } : { staffFigure: recorded, difference: subtract(money(fileFigure), recorded) };

/** The day table. Scoped by the gate, never another org's; superseded versions are never listed. */
export async function listReviewDays(tx: Tx, actor: Actor, filters: ReviewFilters = {}): Promise<ReviewList> {
  const orgId = actor.orgId;
  const { ids, names } = await visibleStoreIds(tx, actor);
  const storeIds = filters.storeId ? ids.filter((i) => i === filters.storeId) : ids;
  const lines = await settlementIntakeRepo.currentLinesForReview(tx, orgId, { storeIds, platform: filters.platform, period: filters.period });

  const grabDates = lines.filter((l) => l.platform === 'grab').map((l) => l.salesDate).sort();
  const context: LoanCheckContext | undefined = grabDates.length > 0 ? await loadLoanCheckContext(tx, orgId, grabDates[grabDates.length - 1]!) : undefined;
  const viewer: LoanCheckViewer = await loanCheckViewerOf(tx, orgId, actor.personId);
  const today = toBusinessDate();

  // A fixed number of reads for the whole table, however many days: the facts of every day are read together, then each day is worked out in memory.
  if (context) await primeLoanCheckCoverage(tx, context, grabDates);
  const figures = await settlementIntakeRepo.salesDayFiguresMany(tx, orgId, lines);
  const checks = await dayBlockersForLines(tx, actor, lines.filter((l) => l.reviewState === 'pending'), { today, loanContext: context, viewer });

  const rows: SettlementReviewRow[] = [];
  for (const line of lines) {
    const figure = figures.get(`${line.channelId}|${line.salesDate}`);
    const { staffFigure, difference } = diffOf(line.orderValue, figure?.recorded ?? null);
    // a day already decided shows no blockers; a Grab day always shows its loan check
    const blockers: DayBlocker[] = checks.get(line.id)?.blockers ?? [];
    const loanView: LoanCheckViewerView | null = line.platform === 'grab' ? (await loanCheckForDay(tx, actor, line.salesDate, { context, viewer })).view : null;
    const differs = difference !== null && !isZeroText(difference);
    rows.push({
      lineId: line.id,
      storeId: line.storeId,
      storeName: names.get(line.storeId) ?? '',
      platform: line.platform,
      salesDate: line.salesDate,
      invoiceNumber: line.platform === 'foodpanda' ? line.payoutReference : null,
      fileFigure: line.orderValue,
      staffFigure,
      difference,
      reviewState: line.reviewState,
      paidState: line.paidState,
      changedSinceBooked: line.changedSinceBooked,
      loanCheck: loanView ? { status: loanView.status, sentence: loanView.sentence } : null,
      blockers: blockers.map((b) => b.sentence),
      needsAttention: (line.reviewState === 'pending' && (blockers.length > 0 || differs)) || line.changedSinceBooked,
    });
  }

  // oldest sales date first, then store; the days of one Foodpanda invoice stay together (placed where the invoice's first day falls)
  const keyOf = (r: SettlementReviewRow): string => (r.invoiceNumber === null ? r.lineId : `${r.storeId}|${r.invoiceNumber}`);
  const groupDate = new Map<string, string>();
  for (const r of rows) {
    const have = groupDate.get(keyOf(r));
    if (have === undefined || r.salesDate.localeCompare(have) < 0) groupDate.set(keyOf(r), r.salesDate);
  }
  const days = rows
    .sort((a, b) => groupDate.get(keyOf(a))!.localeCompare(groupDate.get(keyOf(b))!) || a.storeName.localeCompare(b.storeName) || keyOf(a).localeCompare(keyOf(b)) || a.salesDate.localeCompare(b.salesDate))
    .filter((r) => !filters.needsAttention || r.needsAttention);

  const pandagoOnly = filters.platform === 'grab' || filters.needsAttention ? [] : await pandagoOnlyInvoices(tx, orgId, storeIds, filters.period);
  return { days, pandagoOnly };
}

/**
 * The stored file, read again for a READ-ONLY screen. When the reader refuses (too slow, malformed, unavailable) or fails, or the file is gone from storage, the
 * answer is null and the screen says "could not be read again": one stubborn file must never take a whole list or detail page down. Never used by a write path.
 */
async function rereadStored(tx: Tx, orgId: string, uploadId: string): Promise<StoredUpload | null> {
  try {
    return await readStoredUpload(tx, orgId, uploadId);
  } catch (e) {
    logger.warn({ key: 'settlement_review_reread', error: e instanceof Error ? e.name : 'unknown', code: (e as { code?: unknown }).code }, 'review: a stored settlement file could not be read again');
    return null;
  }
}

const UNREADABLE_PANDAGO = 'This PandaGO-only invoice could not be read again from the stored file, so its amount is not shown now. Try again later.';

const PANDAGO_TAIL =
  'will be paid to you by Foodpanda (cash on delivery that PandaGO riders collected for you, less PandaGO fees). It is not part of the sales receivable and is not booked here; record it yourself.';

async function pandagoOnlyInvoices(tx: Tx, orgId: string, storeIds: readonly string[], period?: string): Promise<PandagoOnlyInvoice[]> {
  const out: PandagoOnlyInvoice[] = [];
  for (const u of await settlementIntakeRepo.pandagoOnlyUploads(tx, orgId, storeIds)) {
    const invoice = (await rereadStored(tx, orgId, u.uploadId))?.foodpanda;
    if (!invoice) {
      // its date is unknown, so a month filter leaves it out
      if (!period) {
        out.push({ uploadId: u.uploadId, storeId: u.storeId, storeName: u.storeName, invoiceNumber: null, workbookDate: '', pandagoNetTotal: '', pandagoReceivable: '', sentence: UNREADABLE_PANDAGO, dateNote: '', unreadable: true });
      }
      continue;
    }
    const staged = stageFoodpandaDays(invoice, { channelId: '', channelName: '', storeId: u.storeId, storeName: u.storeName, platform: 'foodpanda', code: invoice.vendorCode });
    if (staged.pandagoNetTotal === null || staged.pandagoReceivable === null) continue;
    if (period && invoice.invoiceDate.slice(0, 7) !== period) continue;
    out.push({
      uploadId: u.uploadId,
      storeId: u.storeId,
      storeName: u.storeName,
      invoiceNumber: invoice.invoiceNumber,
      workbookDate: invoice.invoiceDate,
      pandagoNetTotal: staged.pandagoNetTotal,
      pandagoReceivable: staged.pandagoReceivable,
      sentence: `PandaGO: ${groupedMoney(staged.pandagoReceivable)} ${PANDAGO_TAIL}`,
      dateNote: `This invoice has no sales days. The workbook gives its date as ${plainDate(invoice.invoiceDate)}; the PDF may print another date (the PDF is not read here).`,
      unreadable: false,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ the day detail */

export interface ReviewOrder {
  /** HH:MM, 24-hour Manila clock as printed (Grab); null for Foodpanda, whose file has a date only */
  time: string | null;
  amount: string;
}

export interface ReviewLoanLine {
  kind: 'deduction' | 'disbursal';
  amount: string;
  loanName: string | null;
  ownerStoreName: string | null;
  allocationSource: 'auto' | 'admin';
}

export interface ReviewDayDetail {
  lineId: string;
  storeId: string;
  storeName: string;
  platform: ReviewPlatform;
  salesDate: string;
  reviewState: ReviewState;
  decisionReason: string | null;
  changedSinceBooked: boolean;
  fileFigure: string;
  staffFigure: string | null;
  difference: string | null;
  /** present only when the file and staff differ */
  orders: ReviewOrder[];
  salesCorrection: { to: string; on: string; sentence: string } | null;
  loan: { check: LoanCheckViewerView | null; lines: ReviewLoanLine[] };
  charges: { commission: string; marketing: string; platformFee: string; vendorDiscount: string; grossInfo: string };
  otherLines: { kind: string; bookedAs: string; amount: string; lineDate: string | null; description: string | null }[];
  /** Foodpanda: the 12% VAT on Appendix B (ads and the weekly fee), rounded once on the sum, re-read from the stored invoice; null for Grab */
  vatOnFees: string | null;
  /** Foodpanda only: the stored invoice could not be read again, so `vatOnFees` is null and the screen says so (it is not 0.00) */
  vatOnFeesUnreadable: boolean;
  feeMonthNote: string | null;
  blockers: DayBlocker[];
  willPostOn: string | null;
  postNote: string | null;
}

const centsOf = (t: string): bigint => toCentavos(money(t));

async function ordersOf(tx: Tx, orgId: string, line: SettlementDayLineRow): Promise<ReviewOrder[]> {
  const stored = await rereadStored(tx, orgId, line.sourceUploadId);
  if (!stored) return [];
  let orders: { time: string | null; amount: Money }[] = [];
  if (stored.transactions) {
    orders = stored.transactions.rows.filter((r) => r.kind === 'payment' && r.createdOn.date === line.salesDate && r.netSales !== null).map((r) => ({ time: r.createdOn.time, amount: r.netSales! }));
  } else if (stored.foodpanda) {
    orders = stored.foodpanda.orders.filter((o) => o.orderDate === line.salesDate).map((o) => ({ time: null, amount: o.revenueAfterDiscounts }));
  }
  return orders
    .sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || compare(a.amount, b.amount))
    .map((o) => ({ time: o.time, amount: o.amount }));
}

/** 12% (or whatever the rows say) of Appendix B ads and weekly fee, rounded once on the sum, half up; the stored invoice is read again. null when it cannot be. */
async function vatOnFeesOf(tx: Tx, orgId: string, line: SettlementDayLineRow): Promise<string | null> {
  const invoice = (await rereadStored(tx, orgId, line.sourceUploadId))?.foodpanda;
  if (!invoice) return null;
  const numerator = invoice.charges
    .filter((c) => c.kind === 'cpc_ad' || c.kind === 'platform_fee')
    .reduce((t, c) => t + centsOf(c.netTotal) * BigInt(c.vatRate), 0n);
  const abs = numerator < 0n ? -numerator : numerator;
  const rounded = (2n * abs + 100n) / 200n;
  return fromCentavos(numerator < 0n ? -rounded : rounded);
}

/** One day for the review screen, or null for an unknown line, another org's line or a line the actor may not see (the same answer for all three). */
export async function getReviewDayDetail(tx: Tx, actor: Actor, input: { lineId: string }, opts: { today?: string } = {}): Promise<ReviewDayDetail | null> {
  const orgId = actor.orgId;
  const line = await settlementIntakeRepo.dayLineById(tx, orgId, input.lineId);
  if (!line || !(await can(tx, actor, 'record_ar_collection', { storeId: line.storeId }))) return null;
  const today = opts.today ?? toBusinessDate();
  const storeName = (await storesRepo.getById(tx, orgId, line.storeId))?.name ?? '';
  const figure = await settlementIntakeRepo.salesDayFigure(tx, orgId, line.channelId, line.salesDate);
  const { staffFigure, difference } = diffOf(line.orderValue, figure.recorded);
  const differs = difference !== null && !isZeroText(difference);

  const vatOnFees = line.platform === 'foodpanda' ? await vatOnFeesOf(tx, orgId, line) : null;
  const viewer = await loanCheckViewerOf(tx, orgId, actor.personId);
  const context = line.platform === 'grab' ? await loadLoanCheckContext(tx, orgId, line.salesDate) : undefined;
  const checks = await dayBlockers(tx, actor, line, { today, loanContext: context, viewer });
  const loan = line.platform === 'grab' ? await loanCheckForDay(tx, actor, line.salesDate, { context, viewer }) : null;

  let salesCorrection: ReviewDayDetail['salesCorrection'] = null;
  if (differs) {
    const open = await fiscalPeriodsRepo.firstOpenDateOnOrAfter(tx, orgId, line.salesDate, today);
    if (open) {
      salesCorrection = {
        to: line.orderValue,
        on: open.date,
        sentence: `Sales will be corrected to ${groupedMoney(line.orderValue)} on ${plainDate(open.date)}. Nothing is booked yet; the correction is made when the day is approved.`,
      };
    }
  }

  // loan lines: the day's own rows (one store), each named with the loan(s) the company-wide check allocated it to
  const loanLines = await settlementIntakeRepo.loanLinesOf(tx, orgId, line.id, { activeOnly: true });
  const lines: ReviewLoanLine[] = loanLines.map((l) => {
    const hits = (loan?.result.allocations ?? []).filter((a) => a.rowKey === l.id);
    const loans = hits.map((a) => loan!.result.byLoan.find((b) => b.loanId === a.loanId)).filter((b) => b !== undefined);
    const names = [...new Set(loans.map((b) => b!.loanName))];
    const owners = [...new Set(loans.map((b) => b!.ownerStoreName))];
    return {
      kind: l.kind,
      amount: l.amount,
      loanName: l.kind === 'deduction' && names.length > 0 ? names.join(' and ') : null,
      ownerStoreName: l.kind === 'deduction' && owners.length > 0 ? owners.join(' and ') : null,
      allocationSource: l.allocationSource,
    };
  });
  const others = await settlementIntakeRepo.otherLinesOf(tx, orgId, line.id);

  return {
    lineId: line.id,
    storeId: line.storeId,
    storeName,
    platform: line.platform,
    salesDate: line.salesDate,
    reviewState: line.reviewState,
    decisionReason: line.decisionReason,
    changedSinceBooked: line.changedSinceBooked,
    fileFigure: line.orderValue,
    staffFigure,
    difference,
    orders: differs ? await ordersOf(tx, orgId, line) : [],
    salesCorrection,
    loan: { check: loan?.view ?? null, lines },
    charges: { commission: line.commission, marketing: line.marketing, platformFee: line.platformFee, vendorDiscount: line.vendorDiscount, grossInfo: line.grossInfo },
    otherLines: others.map((o) => ({ kind: o.kind, bookedAs: o.bookedAs, amount: o.amount, lineDate: o.lineDate, description: o.description })),
    vatOnFees,
    vatOnFeesUnreadable: line.platform === 'foodpanda' && vatOnFees === null,
    feeMonthNote: line.feeMonthNote,
    blockers: checks.blockers,
    willPostOn: checks.willPostOn,
    postNote: checks.postNote,
  };
}

/* ------------------------------------------------------------------ decisions */

async function lineOf(tx: Tx, orgId: string, lineId: string, lock = false): Promise<SettlementDayLineRow> {
  const line = UUID_SHAPE.test(lineId) ? await settlementIntakeRepo.dayLineById(tx, orgId, lineId, { forUpdate: lock }) : null;
  if (!line) throw intakeRefusal('LINE_NOT_FOUND', 'This day was not found. Reload the page.');
  return line;
}
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The gate, with a sentence of this screen's own. The platform's refusal for a store the person is not assigned to NAMES that store; here it must not (a manager
 * of one store learns nothing about another), and the stock wording of an admin-only word ("post into a closed period") would confuse here. The refusal keeps its type.
 */
async function authorizeWith(tx: Tx, actor: Actor, capability: Capability, storeId: string | undefined, sentence: string): Promise<void> {
  try {
    await authorize(tx, actor, capability, storeId === undefined ? {} : { storeId });
  } catch (e) {
    if (e instanceof AuthorizationError) throw new AuthorizationError(e.message, capability, sentence);
    throw e;
  }
}

/** After a failed compare-and-set: say why in plain words (replaced by a newer file, or someone decided first). */
async function whyNotPending(tx: Tx, orgId: string, lineId: string): Promise<never> {
  const now = await settlementIntakeRepo.dayLineById(tx, orgId, lineId);
  if (now && !now.isCurrent) throw intakeRefusal('LINE_NOT_CURRENT', 'A newer file has replaced this day. Reload the page to see the newer one.');
  throw intakeRefusal('LINE_ALREADY_DECIDED', 'This day was already decided by someone else. Reload the page to see what they decided.');
}

/** Reject one staged day with a reason. Posts nothing. Gate (the line's store) -> the reason -> compare-and-set on current + pending -> audit. */
export async function rejectDay(tx: Tx, actor: Actor, input: { lineId: string; reason: string }): Promise<{ lineId: string }> {
  const orgId = actor.orgId;
  const line = await lineOf(tx, orgId, input.lineId);
  await authorizeWith(tx, actor, 'record_ar_collection', line.storeId, 'You do not have permission to reject settlement days for this store.');
  // the rule's one sentence covers a blank reason; a reason over the limit gets its own (the form box says how many characters are over)
  const typedLength = input.reason.trim().length;
  if (typedLength > SETTLEMENT_DAY_REJECT_REASON_MAX) {
    throw refuse('rejectDay: reason too long', `The reason is too long: it is ${typedLength} characters and the most is ${SETTLEMENT_DAY_REJECT_REASON_MAX}. Shorten it.`);
  }
  const reason = assertFieldRules(SETTLEMENT_DAY_REJECT_RULES, { reason: input.reason }).reason!;
  if (!(await settlementIntakeRepo.markRejected(tx, orgId, line.id, { reason, decidedBy: actor.personId }))) return whyNotPending(tx, orgId, line.id);
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: actor.personId,
    action: 'settlement_day.rejected',
    storeId: line.storeId,
    entityId: line.id,
    before: { reviewState: 'pending' },
    after: { reviewState: 'rejected', reason: capAuditText(reason) },
    source: 'web',
  });
  return { lineId: line.id };
}

/** An administrator puts a rejected day back to waiting for a decision (owner decision 13). Only a CURRENT REJECTED line reopens. */
export async function reopenDay(tx: Tx, actor: Actor, input: { lineId: string }): Promise<{ lineId: string }> {
  const orgId = actor.orgId;
  await authorizeWith(tx, actor, 'override_period_lock', undefined, 'Only an administrator can reopen a rejected day.');
  const line = await lineOf(tx, orgId, input.lineId);
  if (!(await settlementIntakeRepo.markReopened(tx, orgId, line.id))) {
    const now = await settlementIntakeRepo.dayLineById(tx, orgId, line.id);
    if (now && !now.isCurrent) throw intakeRefusal('LINE_NOT_CURRENT', 'A newer file has replaced this day. Reload the page to see the newer one.');
    throw intakeRefusal('LINE_NOT_REJECTED', 'Only a rejected day can be reopened. This one is not rejected.');
  }
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: actor.personId,
    action: 'settlement_day.reopened',
    storeId: line.storeId,
    entityId: line.id,
    before: { reviewState: 'rejected', reason: capAuditText(line.decisionReason) },
    after: { reviewState: 'pending' },
    source: 'web',
  });
  return { lineId: line.id };
}

const refusedOverride = (sentence: string) => intakeRefusal('LOAN_OVERRIDE_REFUSED', sentence);

/**
 * An administrator pins a Grab day's loan deductions to loans. The amounts must be above zero, name loans of the org and add up to the day's loan
 * deduction. Every active deduction line of the day goes inactive (kept) and one new active line per amount is added; disbursals are never touched.
 */
export async function overrideLoanAllocation(
  tx: Tx,
  actor: Actor,
  input: { lineId: string; allocations: { loanId: string; amount: string }[] },
): Promise<{ lineId: string }> {
  const orgId = actor.orgId;
  const peek = await lineOf(tx, orgId, input.lineId);
  await authorizeWith(tx, actor, 'edit_loan_repayment_amount', peek.storeId, 'Only an administrator can change how loan deductions are allocated.');
  const line = await lineOf(tx, orgId, input.lineId, true);
  if (!line.isCurrent) throw intakeRefusal('LINE_NOT_CURRENT', 'A newer file has replaced this day. Reload the page to see the newer one.');
  if (line.platform !== 'grab') throw refusedOverride('Only a Grab day has loan deductions to allocate.');
  if (line.reviewState === 'booked') throw refusedOverride('This day is already booked, so its loan allocation cannot be changed.');
  const before = (await settlementIntakeRepo.loanLinesOf(tx, orgId, line.id, { activeOnly: true })).filter((l) => l.kind === 'deduction');
  if (before.length === 0) throw refusedOverride('This day has no loan deductions to allocate.');
  if (input.allocations.length === 0) throw refusedOverride('Choose at least one loan and an amount.');

  const lines: { loanId: string; amount: Money }[] = [];
  const seen = new Set<string>();
  for (const a of input.allocations) {
    if (seen.has(a.loanId.toLowerCase())) throw refusedOverride('Each loan can be chosen only once. Put the amounts for the same loan together.');
    seen.add(a.loanId.toLowerCase());
    let amount: Money;
    try {
      amount = money(a.amount);
    } catch {
      throw refusedOverride('Each amount must be a valid number, for example 591.24.');
    }
    if (compare(amount, ZERO) <= 0) throw refusedOverride('Each amount must be above zero.');
    const loan = UUID_SHAPE.test(a.loanId) ? await loansRepo.getById(tx, orgId, a.loanId) : undefined;
    if (!loan) throw refusedOverride('One of the loans chosen was not found.');
    if (loan.status !== 'active') throw refusedOverride('One of the loans chosen is not active any more (it is paid off or closed), so nothing can be allocated to it.');
    lines.push({ loanId: a.loanId, amount });
  }
  const given = lines.reduce((t, l) => t + toCentavos(l.amount), 0n);
  if (given !== toCentavos(money(line.loanDeduction))) {
    throw refusedOverride(`The amounts must add up to the day's loan deductions of ${groupedMoney(line.loanDeduction)}. They add up to ${groupedMoney(fromCentavos(given))}.`);
  }

  await settlementIntakeRepo.deactivateDeductionLines(tx, orgId, line.id);
  await settlementIntakeRepo.insertAdminDeductionLines(tx, orgId, line.id, lines);
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: actor.personId,
    action: 'settlement_loan.allocation_overridden',
    storeId: line.storeId,
    entityId: line.id,
    before: { allocations: before.map((l) => ({ loanId: l.loanId, amount: l.amount, source: l.allocationSource })) },
    after: { allocations: lines.map((l) => ({ loanId: l.loanId, amount: l.amount, source: 'admin' })) },
    source: 'web',
  });
  return { lineId: line.id };
}
