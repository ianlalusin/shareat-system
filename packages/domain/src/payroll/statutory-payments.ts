/**
 * T-193 S3 - paying SSS / PhilHealth / Pag-IBIG / BIR what payroll credited to 2210-2240.
 * `docs/tasks/193-statutory-remittance/REFRESH.md` s4. Not the cashier's "remittance" (`packages/domain/src/remittance/`).
 *
 * Order, which the tests pin: the capability FIRST -> the form's own request id -> the REPLAY of that id (so a re-sent form
 * answers with its original even after the month closed or was paid off) -> employer number -> money account -> the month's
 * state in plain words -> lock the month's pay runs -> the replay again (a double click that waited on the lock) -> the
 * per-store ceiling -> the draw on the money account -> one ledger entry through `postEntryOnce`.
 */
import { add, compare, equals, formatMoney, money, ZERO, type Money } from '@shareat/core/money';
import { parseBusinessDate, toBusinessDate } from '@shareat/core/datetime';
import {
  auditLogRepo,
  journalRepo,
  moneyAccountsRepo,
  organizationsRepo,
  statutoryPaymentsRepo,
  storesRepo,
  type Tx,
} from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { assertFieldRules } from '../shared/field-rules-assert';
import { parseMoneyInput } from '../shared/money-input';
import { RefusalError, refuse, humanDate } from '../shared/refusal';
import { PAYROLL_STATUTORY_PAYMENT_RULES } from '../field-rules/payroll';
import { requireRequestId, postEntryOnce, UUID_SHAPE } from '../ledger/replay';
import { withInterStoreLegs } from '../ledger/inter-store';
import { reverseEntry } from '../ledger/reverse-entry';
import type { PostEntryLine } from '../ledger/post-entry';
import { checkDraw } from '../money-accounts/overdraft';
import { buildPeriodFacts, periodRefusal } from '../business-rules/expenses';
import { assertPayrollMoneyAccount, payrollMoneyParty, STATUTORY_PAYABLE_ACCOUNT, WITHHOLDING_PAYABLE_ACCOUNT } from './index';

export type StatutoryPaymentAgency = 'sss' | 'philhealth' | 'pagibig' | 'bir';

const AGENCY_LABEL: Record<StatutoryPaymentAgency, string> = { sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG', bir: 'BIR' };
const AGENCIES: readonly StatutoryPaymentAgency[] = ['sss', 'philhealth', 'pagibig', 'bir'];
/** T-193 (bible row 365, Q3): late-payment penalties and surcharges. Never part of the 22x0 payable. */
export const STATUTORY_PENALTY_ACCOUNT = '6810';

function payableAccount(agency: StatutoryPaymentAgency): string {
  return agency === 'bir' ? WITHHOLDING_PAYABLE_ACCOUNT : STATUTORY_PAYABLE_ACCOUNT[agency];
}

export interface RecordStatutoryPaymentInput {
  /** The form-minted request id: it IS the payment's id, and the ledger key is `statutory_payment:${paymentId}:post`. */
  paymentId: string;
  agency: StatutoryPaymentAgency;
  /** 'YYYY-MM-01': the calendar month of the pay runs' `period_end` this payment settles. */
  month: string;
  paidOn: string;
  moneyAccountId: string;
  referenceNo: string;
  lines: { storeId: string; amount: string }[];
  penalty?: string;
  notes?: string | null;
  /** Posts into a CLOSED month only; the actor is checked for `override_period_lock` by `postEntry`. */
  periodOverride?: { actor: Actor; reason: 'data_entry_error'; note?: string | null };
}

export interface RecordStatutoryPaymentResult {
  id: string;
  entryId: string;
  created: boolean;
}

interface Normalised {
  agency: StatutoryPaymentAgency;
  month: string;
  paidOn: string;
  moneyAccountId: string;
  referenceNo: string;
  penalty: Money;
  notes: string | null;
  lines: { storeId: string; amount: Money }[];
}

const DIFFERENT = 'This was already recorded with different figures. Reload the page and try again.';

function sameFigures(row: statutoryPaymentsRepo.StatutoryPaymentRow, n: Normalised): boolean {
  if (row.agency !== n.agency || String(row.month).slice(0, 10) !== n.month || String(row.paidOn).slice(0, 10) !== n.paidOn) return false;
  if (row.moneyAccountId !== n.moneyAccountId || row.referenceNo !== n.referenceNo) return false;
  if (!equals(money(row.penalty), n.penalty)) return false;
  if (row.lines.length !== n.lines.length) return false;
  const have = new Map(row.lines.map((l) => [l.storeId, money(l.amount)]));
  return n.lines.every((l) => {
    const h = have.get(l.storeId);
    return h !== undefined && equals(h, l.amount);
  });
}

/** A stored payment for this id: the original result, or a refusal in words. Null = no such payment yet. */
async function replayOf(tx: Tx, orgId: string, n: Normalised, paymentId: string): Promise<RecordStatutoryPaymentResult | null> {
  const row = await statutoryPaymentsRepo.getById(tx, orgId, paymentId);
  if (!row) return null;
  if (row.status === 'voided') {
    throw refuse(
      `recordStatutoryPayment: payment ${paymentId} was voided.`,
      'This payment was voided. Reload the page and start a new one.',
    );
  }
  if (!sameFigures(row, n)) {
    throw refuse(`recordStatutoryPayment: payment ${paymentId} was already recorded with different figures.`, DIFFERENT);
  }
  if (!row.journalEntryId) {
    throw refuse(`recordStatutoryPayment: payment ${paymentId} has no ledger entry yet.`, DIFFERENT);
  }
  return { id: row.id, entryId: row.journalEntryId, created: false };
}

/** `parseMoneyInput` throws a plain Error with a presentable sentence; a form refusal carries it as a RefusalError. */
function moneyOrRefuse(raw: string, rawLabel: string, humanLabel: string): Money {
  try {
    return parseMoneyInput(raw, rawLabel, humanLabel);
  } catch (e) {
    if (e instanceof RefusalError) throw e;
    throw refuse(`${rawLabel}: ${e instanceof Error ? e.message : 'not a valid amount'}`, e instanceof Error && e.message ? e.message : `${humanLabel} is not a valid amount.`);
  }
}

function normalise(input: RecordStatutoryPaymentInput): Normalised {
  if (!AGENCIES.includes(input.agency)) {
    throw refuse(`recordStatutoryPayment: unknown agency ${String(input.agency)}`, 'Choose SSS, PhilHealth, Pag-IBIG or BIR.');
  }
  const fields = assertFieldRules(PAYROLL_STATUTORY_PAYMENT_RULES, {
    month: input.month,
    paidOn: input.paidOn,
    referenceNo: input.referenceNo,
    penalty: input.penalty ?? '',
    notes: input.notes ?? '',
  });
  const month = fields.month!;
  const paidOn = fields.paidOn!;
  try {
    parseBusinessDate(month);
    parseBusinessDate(paidOn);
  } catch {
    throw refuse('recordStatutoryPayment: month or payment date is not a date.', 'The month and the payment date must be dates, like 2026-10-01.');
  }
  if (!month.endsWith('-01')) {
    throw refuse(`recordStatutoryPayment: month ${month} is not the first of a month.`, 'Choose a whole month, not a day in the middle of one.');
  }
  if (month.localeCompare(`${toBusinessDate().slice(0, 7)}-01`) > 0) {
    throw refuse(`recordStatutoryPayment: month ${month} is after the current month.`, 'That month has not started yet. Choose this month or an earlier one.');
  }
  if (paidOn.localeCompare(month) < 0) {
    throw refuse(`recordStatutoryPayment: paid on ${paidOn} is before the month ${month}.`, 'The payment date cannot be before the month it pays for.');
  }
  const penalty = !fields.penalty ? ZERO : moneyOrRefuse(fields.penalty, 'recordStatutoryPayment: the penalty', 'The penalty');
  if (compare(penalty, ZERO) < 0) {
    throw refuse('recordStatutoryPayment: the penalty is negative.', 'The penalty cannot be negative.');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw refuse('recordStatutoryPayment: no lines.', 'Enter an amount for at least one store.');
  }
  if (typeof input.moneyAccountId !== 'string' || !UUID_SHAPE.test(input.moneyAccountId)) {
    throw refuse('recordStatutoryPayment: moneyAccountId is not a uuid.', 'Choose the money account the payment was made from.');
  }
  const seen = new Set<string>();
  const lines = input.lines.map((l) => {
    if (typeof l.storeId !== 'string' || !UUID_SHAPE.test(l.storeId)) {
      throw refuse('recordStatutoryPayment: a line storeId is not a uuid.', 'Choose a store for every line.');
    }
    if (seen.has(l.storeId)) {
      throw refuse(`recordStatutoryPayment: store ${l.storeId} appears twice.`, 'Each store can appear only once in a payment. Combine the amounts into one line.');
    }
    seen.add(l.storeId);
    const amount = moneyOrRefuse(String(l.amount ?? ''), 'recordStatutoryPayment: a line amount', 'The amount');
    if (compare(amount, ZERO) <= 0) {
      throw refuse('recordStatutoryPayment: a line amount is not above zero.', 'Each amount has to be greater than zero.');
    }
    return { storeId: l.storeId, amount };
  });
  return { agency: input.agency, month, paidOn, moneyAccountId: input.moneyAccountId, referenceNo: fields.referenceNo!, penalty, notes: fields.notes ?? null, lines };
}

/** SSS / PhilHealth / Pag-IBIG need the employer number on file; BIR pays on the organization's TIN. */
async function assertIdentity(tx: Tx, orgId: string, agency: StatutoryPaymentAgency): Promise<void> {
  if (agency === 'bir') {
    const org = await organizationsRepo.identityOf(tx, orgId);
    if (!org?.tin) {
      throw refuse(
        'recordStatutoryPayment: the organization has no TIN, so a BIR payment cannot be recorded.',
        "Add the company's TIN (tax identification number) in the organization settings before recording a BIR payment.",
      );
    }
    return;
  }
  if (!(await statutoryPaymentsRepo.employerNumber(tx, orgId, agency))) {
    throw refuse(
      `recordStatutoryPayment: no ${AGENCY_LABEL[agency]} employer number on file.`,
      `Add the ${AGENCY_LABEL[agency]} employer number before recording a payment to ${AGENCY_LABEL[agency]}.`,
    );
  }
}

/** "October 2026" */
const monthWords = (month: string): string => {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
};

export async function recordStatutoryPayment(
  tx: Tx,
  actor: Actor,
  input: RecordStatutoryPaymentInput,
): Promise<RecordStatutoryPaymentResult> {
  await authorize(tx, actor, 'remit_statutory');
  const paymentId = requireRequestId('recordStatutoryPayment', input.paymentId);
  const n = normalise(input);

  // The replay first: a re-sent form gets its original answer, whatever has happened to the month since.
  const replayed = await replayOf(tx, actor.orgId, n, paymentId);
  if (replayed) return replayed;

  await assertIdentity(tx, actor.orgId, n.agency);

  const account = await moneyAccountsRepo.getById(tx, actor.orgId, n.moneyAccountId);
  if (!account) {
    throw refuse(`recordStatutoryPayment: money account ${n.moneyAccountId} does not exist.`, 'That money account does not exist. Choose another.');
  }
  assertPayrollMoneyAccount(account, 'recordStatutoryPayment');

  // The month the payment is dated in, in words, before anything is written (postEntry's own answer is developer text).
  const period = await journalRepo.findPeriodForDate(tx, actor.orgId, n.paidOn);
  if (!period) {
    throw refuse(`recordStatutoryPayment: no fiscal period covers ${n.paidOn}.`, `There is no fiscal period for ${humanDate(parseBusinessDate(n.paidOn))} yet.`);
  }
  const blocked = periodRefusal(buildPeriodFacts(period), { override: !!input.periodOverride });
  if (blocked) {
    throw refuse(`recordStatutoryPayment: the fiscal period covering ${n.paidOn} is ${blocked.kind}.`, blocked.sentence);
  }

  // One payment per month's runs at a time: a run voided while we waited drops out of what is owed.
  await statutoryPaymentsRepo.lockMonthRuns(tx, actor.orgId, n.month, n.lines.map((l) => l.storeId));

  // A double click that waited on the lock finds the first click's payment here, before the ceiling can call it an overpayment.
  const again = await replayOf(tx, actor.orgId, n, paymentId);
  if (again) return again;

  if (await statutoryPaymentsRepo.findPostedByReference(tx, actor.orgId, n.agency, n.referenceNo)) {
    throw refuse(
      `recordStatutoryPayment: ${n.agency} receipt ${n.referenceNo} is already on a posted payment.`,
      `${AGENCY_LABEL[n.agency]} receipt ${n.referenceNo} is already recorded on another payment. Each receipt can be used once.`,
    );
  }

  // The ceiling, store by store: what payroll owes the agency for the month, less what posted payments already cleared.
  const totals = await statutoryPaymentsRepo.monthTotals(tx, actor.orgId, { agency: n.agency });
  for (const line of n.lines) {
    const row = totals.find((t) => t.month === n.month && t.storeId === line.storeId);
    const outstanding = row ? money(row.outstanding) : ZERO;
    const store = await storesRepo.getById(tx, actor.orgId, line.storeId);
    const storeName = store?.name ?? 'That store';
    if (compare(outstanding, ZERO) <= 0) {
      throw refuse(
        `recordStatutoryPayment: store ${line.storeId} has nothing outstanding for ${n.agency} ${n.month}.`,
        `${storeName} owes ${AGENCY_LABEL[n.agency]} nothing for ${monthWords(n.month)}.`,
      );
    }
    if (compare(line.amount, outstanding) > 0) {
      throw refuse(
        `recordStatutoryPayment: ${line.amount} is more than the ${outstanding} outstanding for store ${line.storeId}.`,
        `${storeName} owes ${AGENCY_LABEL[n.agency]} only ${formatMoney(outstanding)} for ${monthWords(n.month)}, so ${formatMoney(line.amount)} is too much.`,
      );
    }
  }

  const linesTotal = add(...n.lines.map((l) => l.amount));
  const cashOut = add(linesTotal, n.penalty);
  await checkDraw(tx, actor.orgId, account, cashOut, 'recordStatutoryPayment');

  // The documents first (the line freeze trigger reads the parent), then the entry, then the link.
  try {
    await statutoryPaymentsRepo.insertPayment(tx, {
      id: paymentId,
      orgId: actor.orgId,
      agency: n.agency,
      month: n.month,
      paidOn: n.paidOn,
      moneyAccountId: n.moneyAccountId,
      referenceNo: n.referenceNo,
      penalty: n.penalty,
      notes: n.notes,
      createdBy: actor.personId,
    });
  } catch (e) {
    // The id or the receipt is already taken by a row this organization cannot see or just lost a race for: ask for a fresh form.
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') {
      throw refuse(`recordStatutoryPayment: payment ${paymentId} or its receipt already exists (unique violation).`, 'This form is out of date. Reload the page and try again.');
    }
    throw e;
  }
  await statutoryPaymentsRepo.insertLines(tx, actor.orgId, paymentId, n.lines);

  const memo = `Statutory payment - ${AGENCY_LABEL[n.agency]} ${monthWords(n.month)} (${n.referenceNo})`;
  const payable = payableAccount(n.agency);
  const legs: PostEntryLine[] = n.lines.map((l) => ({ accountCode: payable, storeId: l.storeId, debit: l.amount }));
  if (compare(n.penalty, ZERO) > 0) {
    legs.push({ accountCode: STATUTORY_PENALTY_ACCOUNT, storeId: account.storeId, debit: n.penalty });
  }
  legs.push({ accountCode: account.glAccountCode, storeId: account.storeId, credit: cashOut, ...payrollMoneyParty(account) });
  const lines = await withInterStoreLegs(tx, actor.orgId, { owingStoreId: account.storeId, lines: legs, memo });

  const posted = await postEntryOnce(tx, {
    orgId: actor.orgId,
    entryDate: n.paidOn,
    sourceType: 'statutory_payment',
    sourceId: paymentId,
    idempotencyKey: `statutory_payment:${paymentId}:post`,
    memo,
    postedBy: actor.personId,
    lines,
    ...(input.periodOverride && period.status === 'closed'
      ? { periodOverride: { actor: input.periodOverride.actor, reason: input.periodOverride.reason, note: input.periodOverride.note ?? null } }
      : {}),
  });
  if (!(await statutoryPaymentsRepo.setEntry(tx, actor.orgId, paymentId, posted.entryId))) {
    throw refuse(`recordStatutoryPayment: payment ${paymentId} could not be linked to its entry.`, DIFFERENT);
  }

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'statutory_payment.record',
    storeId: null,
    entityId: paymentId,
    before: null,
    after: {
      table: 'statutory_payments',
      event: 'recorded',
      agency: n.agency,
      month: n.month,
      paidOn: n.paidOn,
      referenceNo: n.referenceNo,
      penalty: n.penalty,
      total: linesTotal,
      lines: n.lines.map((l) => ({ store: l.storeId, amount: l.amount })),
    },
    source: 'web',
  });

  return { id: paymentId, entryId: posted.entryId, created: true };
}

export interface VoidStatutoryPaymentInput {
  paymentId: string;
  reason: string;
  /** The date the reversal posts on. Omitted: the payment's own date, which needs that month to still be open. */
  on?: string;
}

export interface VoidStatutoryPaymentResult {
  id: string;
  reversalEntryId: string;
}

/**
 * T-193 S4 - take back a payment to an agency: its OWN ledger entry is reversed exactly (every leg, the cross-store pair and the
 * penalty), the payment is marked voided and the month is owed again. A voided payment is final; a fresh payment is a fresh form.
 * Order: the capability FIRST -> the reason -> the payment locked FOR UPDATE and judged -> the reversal month in words -> reverse -> mark -> audit.
 */
export async function voidStatutoryPayment(
  tx: Tx,
  actor: Actor,
  input: VoidStatutoryPaymentInput,
): Promise<VoidStatutoryPaymentResult> {
  await authorize(tx, actor, 'remit_statutory');
  const reason = (typeof input.reason === 'string' ? input.reason : '').trim();
  if (!reason) {
    throw refuse('voidStatutoryPayment: no reason.', 'Give a reason for voiding this payment.');
  }
  const NOT_FOUND = 'That payment does not exist. Reload the page and try again.';
  if (typeof input.paymentId !== 'string' || !UUID_SHAPE.test(input.paymentId)) {
    throw refuse('voidStatutoryPayment: paymentId is not a uuid.', NOT_FOUND);
  }
  if (input.on !== undefined) {
    try {
      parseBusinessDate(input.on);
    } catch {
      throw refuse(`voidStatutoryPayment: on ${String(input.on)} is not a date.`, 'The date to void on must be a date, like 2026-12-05.');
    }
  }

  // The lock comes before the status read: a second void waits here and then finds the first one's result.
  const row = await statutoryPaymentsRepo.lockById(tx, actor.orgId, input.paymentId);
  if (!row) throw refuse(`voidStatutoryPayment: payment ${input.paymentId} does not exist.`, NOT_FOUND);
  if (row.status === 'voided') {
    throw refuse(`voidStatutoryPayment: payment ${row.id} is already voided.`, 'This payment was already voided.');
  }
  if (!row.journalEntryId) {
    throw refuse(`voidStatutoryPayment: payment ${row.id} has no ledger entry.`, 'This payment has no ledger entry to reverse. Reload the page and try again.');
  }

  // The month the reversal lands in, in words (reverseEntry's own answers are developer text).
  const original = await journalRepo.findEntryById(tx, row.journalEntryId);
  if (!original) throw refuse(`voidStatutoryPayment: entry ${row.journalEntryId} does not exist.`, 'This payment has no ledger entry to reverse. Reload the page and try again.');
  if (original.status === 'reversed') {
    throw refuse(
      `voidStatutoryPayment: entry ${original.id} of payment ${row.id} is already reversed.`,
      "This payment's entry was already reversed in the journal; it cannot be voided again here.",
    );
  }

  const landing = input.on ?? original.entryDate;
  const period = input.on
    ? await journalRepo.findPeriodForDate(tx, actor.orgId, input.on)
    : await journalRepo.findPeriodById(tx, original.periodId);
  if (!period) {
    throw refuse(`voidStatutoryPayment: no fiscal period covers ${landing}.`, `There is no fiscal period for ${humanDate(parseBusinessDate(landing))} yet.`);
  }
  const blocked = periodRefusal(buildPeriodFacts(period), { override: false });
  if (blocked) {
    const sentence = input.on
      ? `${blocked.sentence}`
      : `${blocked.sentence} Choose a date in an open month to void this payment on.`;
    throw refuse(`voidStatutoryPayment: the fiscal period covering ${landing} is ${blocked.kind}.`, sentence);
  }

  const reversed = await reverseEntry(tx, {
    entryId: row.journalEntryId,
    reason,
    reversedBy: actor.personId,
    ...(input.on ? { reversalDate: input.on } : {}),
  });

  const ok = await statutoryPaymentsRepo.markVoided(tx, actor.orgId, row.id, { voidedBy: actor.personId, reason });
  if (!ok) {
    throw refuse(`voidStatutoryPayment: payment ${row.id} was voided by someone else first.`, 'This payment was already voided.');
  }

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'statutory_payment.void',
    storeId: null,
    entityId: row.id,
    before: { table: 'statutory_payments', status: 'posted' },
    after: {
      table: 'statutory_payments',
      event: 'voided',
      status: 'voided',
      reason,
      agency: row.agency,
      month: String(row.month).slice(0, 10),
      referenceNo: row.referenceNo,
      reversalEntryId: reversed.reversalEntryId,
      reversalDate: landing,
      lines: row.lines.map((l) => ({ store: l.storeId, amount: l.amount })),
    },
    source: 'web',
  });

  return { id: row.id, reversalEntryId: reversed.reversalEntryId };
}
