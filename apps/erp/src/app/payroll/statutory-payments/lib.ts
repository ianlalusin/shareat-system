/**
 * Server-only helpers for `/payroll/statutory-payments`. T-193 S5.
 *
 * Everything here is READ and DERIVED: what is owed to each agency is summed live from posted pay runs and what was paid from
 * posted payments (packages/db/src/repo/statutory-payments.ts); nothing is cached. Each loader authorizes `remit_statutory`
 * FIRST, on its own, so a page that forgot its gate still cannot read a figure (bible 15.11: no layer is the only one).
 */
import { auditLogRepo, statutoryPaymentsRepo, moneyAccountsRepo, storesRepo } from '@shareat/db';
import { add, compare, money, ZERO, type Money } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { authorize, can, type Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../../expenses/lib';

export { withOrgPrincipal };
export type StatutoryAgency = statutoryPaymentsRepo.StatutoryAgency;
export type MonthTotal = statutoryPaymentsRepo.MonthTotalRow;
export type ReconciliationLine = statutoryPaymentsRepo.ReconciliationRow;
export type StatutoryPayment = statutoryPaymentsRepo.StatutoryPaymentRow;
export type MonthDetailRow = statutoryPaymentsRepo.MonthDetailRow;

export const AGENCIES: readonly { value: StatutoryAgency; label: string }[] = [
  { value: 'sss', label: 'SSS' },
  { value: 'philhealth', label: 'PhilHealth' },
  { value: 'pagibig', label: 'Pag-IBIG' },
  { value: 'bir', label: 'BIR' },
];
export const agencyLabel = (a: string): string => AGENCIES.find((x) => x.value === a)?.label ?? a;
export const isAgency = (v: unknown): v is StatutoryAgency => AGENCIES.some((a) => a.value === v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'YYYY-MM-01' -> "October 2026" */
export const monthWords = (month: string): string => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;

/** Owed / paid / outstanding per agency + month + store, oldest month first. */
export async function monthsFor(
  actor: Actor,
  filter: { agency?: StatutoryAgency; year?: number | string; storeId?: string } = {},
): Promise<MonthTotal[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'remit_statutory');
    const year = filter.year === undefined || filter.year === '' ? undefined : Number(filter.year);
    return statutoryPaymentsRepo.monthTotals(tx, actor.orgId, {
      ...(filter.agency && isAgency(filter.agency) ? { agency: filter.agency } : {}),
      ...(filter.storeId && UUID.test(filter.storeId) ? { storeId: filter.storeId } : {}),
      ...(year !== undefined && Number.isInteger(year) ? { year } : {}),
    });
  });
}

/** All-time outstanding next to the ledger's 22x0 balance, per agency and store. */
export async function reconciliationFor(actor: Actor): Promise<ReconciliationLine[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'remit_statutory');
    return statutoryPaymentsRepo.reconciliation(tx, actor.orgId);
  });
}

/** The lines where the payroll books and the ledger disagree. */
export function mismatches(rows: readonly ReconciliationLine[]): ReconciliationLine[] {
  return rows.filter((r) => compare(money(r.outstanding), money(r.glBalance)) !== 0);
}

/** One payment with its lines, or null for a non-uuid, unknown or another organization's id. */
export async function paymentFor(actor: Actor, id: string): Promise<StatutoryPayment | null> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'remit_statutory');
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    return statutoryPaymentsRepo.getById(tx, actor.orgId, id);
  });
}

export interface PayFromAccount {
  id: string;
  name: string;
  storeId: string;
  storeName: string;
  glAccountCode: string;
}

/** The money accounts a payment may be drawn from: never a staff cash float (GL 1120). The domain refuses it by name too. */
export async function payFromAccountsFor(actor: Actor): Promise<PayFromAccount[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'remit_statutory');
    const [accounts, stores] = await Promise.all([
      moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId),
      storesRepo.listForOrg(tx, actor.orgId),
    ]);
    const storeName = new Map(stores.map((s) => [s.id, s.name]));
    return accounts
      .filter((a) => a.glAccountCode !== '1120')
      .map((a) => ({ id: a.id, name: a.name, storeId: a.storeId, storeName: storeName.get(a.storeId) ?? '', glAccountCode: a.glAccountCode }));
  });
}

/** Store id -> name for this organization (retired stores too: a payment can name one). */
export async function storeNamesFor(actor: Actor): Promise<Map<string, string>> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'remit_statutory');
    return new Map((await storesRepo.listForOrg(tx, actor.orgId)).map((s) => [s.id, s.name]));
  });
}

/** The name of one money account, for the payment page. */
export async function moneyAccountNameFor(actor: Actor, accountId: string): Promise<string> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'remit_statutory');
    const a = await moneyAccountsRepo.getById(tx, actor.orgId, accountId);
    return a?.name ?? '';
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// T-193 S6: month detail, due dates and lateness, the dashboard tile.
// ---------------------------------------------------------------------------------------------------------------------

const MONTH_FIRST = /^\d{4}-(0[1-9]|1[0-2])-01$/;
/** 'YYYY-MM-01' only (a real first of a month); anything else is not a month this screen can show. */
export const isMonthStart = (v: unknown): v is string => typeof v === 'string' && MONTH_FIRST.test(v);

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
/** Whole days from `from` to `to` (both 'YYYY-MM-DD'); negative when `to` is earlier. */
function dayDiff(from: string, to: string): number {
  const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}
/** The due date of a month's contributions: `dueDay` of the FOLLOWING month, clamped to that month's last day. 'YYYY-MM-DD'. */
export function dueDateOf(month: string, dueDay: number): string {
  let y = Number(month.slice(0, 4));
  let m = Number(month.slice(5, 7)) + 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return `${pad(y, 4)}-${pad(m)}-${pad(Math.min(dueDay, daysInMonth(y, m)))}`;
}

export interface MonthDetail {
  rows: MonthDetailRow[];
  /** This agency + month, posted AND voided. */
  payments: StatutoryPayment[];
  /** 'YYYY-MM-DD'; null = no due day on file for the agency (no date is guessed). */
  dueDate: string | null;
  daysLate: number;
  /** Not late, and due within 5 days (the due day itself included). */
  dueSoon: boolean;
  /** Nothing is outstanding for the month (it was paid, possibly late). */
  fullyPaid: boolean;
  /**
   * 'n.nn', or null.
   * T-193 spec Question 2 (docs/tasks/193-statutory-remittance.md :231-234): "(a) Show an estimated penalty on the report and book
   * the real one when it is paid (recommended: agency formulas change and differ, and a wrong automatic charge is wrong money)".
   * NO spec line states any agency's penalty rate, so none is invented here: '0.00' only when the month is not late
   * (a true statement), null whenever the month is late, owing or already paid (the rate is not on file). Never posted.
   */
  estimatedPenalty: string | null;
}

/** One agency + month: the payslip rows behind it, its payments, and how it stands against its due date. */
export async function monthDetailFor(
  actor: Actor,
  input: { agency: string; month: string; today?: string },
): Promise<MonthDetail> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'remit_statutory');
    const { agency, month } = input;
    if (!isAgency(agency) || !isMonthStart(month)) throw new Error('monthDetailFor: not an agency and a first-of-month date');
    const today = input.today ?? toBusinessDate();
    const [rows, payments, employers, totals] = await Promise.all([
      statutoryPaymentsRepo.monthDetail(tx, actor.orgId, agency, month),
      statutoryPaymentsRepo.paymentsForMonth(tx, actor.orgId, agency, month),
      statutoryPaymentsRepo.listEmployers(tx, actor.orgId),
      statutoryPaymentsRepo.monthTotals(tx, actor.orgId, { agency, year: Number(month.slice(0, 4)) }),
    ]);
    const mine = totals.filter((t) => t.month === month);
    const outstanding = add(ZERO, ...mine.map((t) => money(t.outstanding)));
    const paidSome = mine.some((t) => compare(money(t.paid), ZERO) > 0);
    const owing = compare(outstanding, ZERO) > 0;
    const dueDay = employers.find((e) => e.agency === agency)?.dueDay ?? null;
    const dueDate = dueDay === null ? null : dueDateOf(month, dueDay);

    let daysLate = 0;
    let dueSoon = false;
    if (dueDate !== null) {
      if (owing) {
        daysLate = Math.max(0, dayDiff(dueDate, today));
        const ahead = dayDiff(today, dueDate);
        dueSoon = daysLate === 0 && ahead >= 0 && ahead <= 5;
      } else if (paidSome) {
        const lastPaid = payments
          .filter((p) => p.status === 'posted')
          .map((p) => String(p.paidOn).slice(0, 10))
          .sort()
          .pop();
        if (lastPaid) daysLate = Math.max(0, dayDiff(dueDate, lastPaid));
      }
    }
    return { rows, payments, dueDate, daysLate, dueSoon, fullyPaid: !owing && paidSome, estimatedPenalty: daysLate === 0 ? '0.00' : null };
  });
}

export interface StatutoryTile {
  totalOutstanding: string;
  totalOverdue: string;
  oldestUnpaidMonth: string | null;
  /** noDueDay: money is outstanding but no due day is on file, so overdue cannot be told (shown as such, never as 0 overdue). */
  agencies: { agency: StatutoryAgency; outstanding: string; overdue: string; noDueDay: boolean }[];
}

/**
 * The dashboard tile: what is owed to the agencies and how much of it is past its due date. Null for anyone who does not hold
 * `remit_statutory` (a plain yes/no, never a refusal: the dashboard asks it for every viewer). Same rows `monthsFor` returns.
 */
export async function statutoryTileFor(actor: Actor, today?: string): Promise<StatutoryTile | null> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    if (!(await can(tx, actor, 'remit_statutory', {}))) return null;
    const now = today ?? toBusinessDate();
    const [rows, employers] = await Promise.all([
      statutoryPaymentsRepo.monthTotals(tx, actor.orgId, {}),
      statutoryPaymentsRepo.listEmployers(tx, actor.orgId),
    ]);
    const dueDays = new Map(employers.map((e) => [e.agency, e.dueDay]));
    // One figure per agency + month (the stores summed).
    const months = new Map<string, { agency: StatutoryAgency; month: string; outstanding: Money }>();
    for (const r of rows) {
      const key = `${r.agency}|${r.month}`;
      const cur = months.get(key);
      months.set(key, { agency: r.agency, month: r.month, outstanding: add(cur?.outstanding ?? ZERO, money(r.outstanding)) });
    }
    let totalOutstanding: Money = ZERO;
    let totalOverdue: Money = ZERO;
    let oldest: string | null = null;
    const per = new Map<StatutoryAgency, { outstanding: Money; overdue: Money }>();
    for (const m of months.values()) {
      const dueDay = dueDays.get(m.agency);
      const overdue = dueDay !== undefined && compare(m.outstanding, ZERO) > 0 && dayDiff(dueDateOf(m.month, dueDay), now) > 0;
      const a = per.get(m.agency) ?? { outstanding: ZERO, overdue: ZERO };
      per.set(m.agency, { outstanding: add(a.outstanding, m.outstanding), overdue: overdue ? add(a.overdue, m.outstanding) : a.overdue });
      totalOutstanding = add(totalOutstanding, m.outstanding);
      if (overdue) totalOverdue = add(totalOverdue, m.outstanding);
      if (compare(m.outstanding, ZERO) > 0 && (oldest === null || m.month < oldest)) oldest = m.month;
    }
    return {
      totalOutstanding,
      totalOverdue,
      oldestUnpaidMonth: oldest,
      agencies: AGENCIES.flatMap((a) => {
        const v = per.get(a.value);
        return v && (compare(v.outstanding, ZERO) !== 0 || compare(v.overdue, ZERO) !== 0)
          ? [{ agency: a.value, outstanding: v.outstanding, overdue: v.overdue, noDueDay: !dueDays.has(a.value) && compare(v.outstanding, ZERO) > 0 }]
          : [];
      }),
    };
  });
}

/** One audit row per month-detail CSV download. Agency, month and row count only: never a government number. */
export async function auditStatutoryExport(actor: Actor, input: { agency: StatutoryAgency; month: string; rowCount: number }): Promise<void> {
  await withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'remit_statutory');
    await auditLogRepo.append(tx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'statutory_payment.export',
      storeId: null,
      entityId: actor.orgId,
      before: null,
      after: { table: 'statutory_payments', event: 'export', agency: input.agency, month: input.month, rows: input.rowCount },
      source: 'web',
    });
  });
}
