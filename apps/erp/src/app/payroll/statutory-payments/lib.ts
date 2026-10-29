/**
 * Server-only helpers for `/payroll/statutory-payments`. T-193 S5.
 *
 * Everything here is READ and DERIVED: what is owed to each agency is summed live from posted pay runs and what was paid from
 * posted payments (packages/db/src/repo/statutory-payments.ts); nothing is cached. Each loader authorizes `remit_statutory`
 * FIRST, on its own, so a page that forgot its gate still cannot read a figure (bible 15.11: no layer is the only one).
 */
import { statutoryPaymentsRepo, moneyAccountsRepo, storesRepo } from '@shareat/db';
import { compare, money } from '@shareat/core/money';
import { authorize, type Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../../expenses/lib';

export { withOrgPrincipal };
export type StatutoryAgency = statutoryPaymentsRepo.StatutoryAgency;
export type MonthTotal = statutoryPaymentsRepo.MonthTotalRow;
export type ReconciliationLine = statutoryPaymentsRepo.ReconciliationRow;
export type StatutoryPayment = statutoryPaymentsRepo.StatutoryPaymentRow;

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
