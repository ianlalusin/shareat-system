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
  /** ⭐ How far below zero a CASHIER drawer may go before a draw is refused. Positive; office and
   *  staff balances are complete and block at zero regardless (bible row 154). */
  overdraftLimit: string;
  notes: string | null;
}

/** Every money account, retired ones included — this is the register, not a payment picker. */
/** `storeIds`: only these stores' accounts; `undefined` = the viewer is not store-limited (T-603). */
export async function listAll(orgId: string, storeIds?: readonly string[]): Promise<MoneyAccountRow[]> {
  const rows = await withOrgPrincipal(orgId, (tx) => moneyAccountsRepo.listMoneyAccounts(tx, orgId, { activeOnly: false }));
  return rows.filter((a) => !storeIds || storeIds.includes(a.storeId));
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
