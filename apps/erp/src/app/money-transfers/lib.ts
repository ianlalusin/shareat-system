/**
 * Server-only helpers for the money-transfers screen. T-139, bible row 150.
 *
 * `withOrgPrincipal` comes from the expenses screens rather than being duplicated — one
 * RLS-principal wrapper, one place to get it wrong.
 */
import { moneyAccountsRepo, moneyTransfersRepo, type MoneyTransferListRow } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';
export { CUSTODIAN_LABEL, GL_LABEL, INSTRUMENT_LABEL } from '../money-accounts/lib';

export interface AccountOption {
  id: string;
  storeId: string;
  name: string;
  instrument: string;
  custodian: string;
  glAccountCode: string;
  /** ⭐ Read from the LEDGER on every load — there is no balance column to go stale. */
  balance: string;
}

/**
 * The accounts a transfer may name, each with what it currently holds.
 *
 * ⚠️ Retired accounts are excluded deliberately: the service refuses them at either end, so
 * offering one would be an error the form invites and the domain then rejects.
 */
export async function listTransferableAccounts(orgId: string): Promise<AccountOption[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, {});
    return Promise.all(
      accounts.map(async (a) => ({
        id: a.id,
        storeId: a.storeId,
        name: a.name,
        instrument: a.instrument,
        custodian: a.custodian,
        glAccountCode: a.glAccountCode,
        balance: await moneyAccountsRepo.balanceOf(tx, orgId, a),
      })),
    );
  });
}

export async function listRecentTransfers(orgId: string): Promise<MoneyTransferListRow[]> {
  return withOrgPrincipal(orgId, (tx) =>
    moneyTransfersRepo.listMoneyTransfers(tx, orgId, { limit: 50 }),
  );
}

export function peso(amount: string | number): string {
  return `₱${Number(amount).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
