/**
 * Server-only helpers for the remittance screens. T-143, bible row 157.
 *
 * ⭐ Every figure here is DERIVED. `endDayReports` asks the ledger what the cashier actually holds
 * on each date — it does not sum document types, so a document type nobody has invented yet is
 * already counted.
 */
import { moneyAccountsRepo, remittanceRepo, type EndDayReport } from '@shareat/db';
import { remittanceStateOf } from '@shareat/domain';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export interface DayRow extends EndDayReport {
  state: 'nothing_owed' | 'unremitted' | 'partially_remitted' | 'remitted';
}

export async function endDays(orgId: string, storeId: string, upTo: string): Promise<DayRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await remittanceRepo.endDayReports(tx, orgId, { storeId, upTo });
    return rows.map((r) => ({ ...r, state: remittanceStateOf(r) }));
  });
}

/** The cashier accounts money can be handed over FROM, with what each holds. */
export async function cashierAccounts(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, {
      storeId,
      custodian: 'cashier',
    });
    return Promise.all(
      accounts.map(async (a) => ({
        ...a,
        balance: await moneyAccountsRepo.balanceOf(tx, orgId, a),
      })),
    );
  });
}

/** Where it lands. ⚠️ Office only — a remittance runs cashier → office, never the other way. */
export async function officeAccounts(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) =>
    moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId, custodian: 'office' }),
  );
}

export async function recentRemittances(orgId: string, storeId?: string) {
  return withOrgPrincipal(orgId, (tx) => remittanceRepo.listRemittances(tx, orgId, storeId));
}

/** ⭐ The list that must not hide (Ian, bible row 147). */
export async function openVariances(orgId: string) {
  return withOrgPrincipal(orgId, (tx) => remittanceRepo.listVariances(tx, orgId, 'open'));
}

export const STATE_LABEL: Record<string, string> = {
  nothing_owed: 'Nothing owed',
  unremitted: 'Not remitted',
  partially_remitted: 'Partly remitted',
  remitted: 'Remitted',
};

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
