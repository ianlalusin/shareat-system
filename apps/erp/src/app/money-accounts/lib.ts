/**
 * Server-only helpers for the money-accounts screen. ADR-010, bible rows 142–149.
 *
 * `withOrgPrincipal` and the store list are imported from the expenses screens rather than
 * duplicated — one RLS-principal wrapper, one place to get it wrong.
 */
import { moneyAccountsRepo } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export interface MoneyAccountRow {
  id: string;
  storeId: string;
  name: string;
  instrument: string;
  glAccountCode: string;
  custodian: string;
  isActive: boolean;
  isFoundation: boolean;
  notes: string | null;
}

/** Every money account, retired ones included — this is the register, not a payment picker. */
export async function listAll(orgId: string): Promise<MoneyAccountRow[]> {
  return withOrgPrincipal(orgId, (tx) =>
    moneyAccountsRepo.listMoneyAccounts(tx, orgId, { activeOnly: false }),
  );
}

export const CUSTODIAN_LABEL: Record<string, string> = {
  cashier: 'Cashier',
  office: 'Office',
  staff: 'Staff float',
};

export const INSTRUMENT_LABEL: Record<string, string> = {
  cash: 'Cash',
  ewallet: 'E-wallet',
  bank: 'Bank account',
};

/** What each GL code means, for the register's own column. Read-only labelling — the code itself
 *  is derived by the domain from instrument + custodian and is never chosen on the form. */
export const GL_LABEL: Record<string, string> = {
  '1110': 'Cash on hand — cashier',
  '1120': 'Cash on hand — staff custodian',
  '1130': 'Cash on hand — office',
  '1140': 'E-wallet / online channels',
};
