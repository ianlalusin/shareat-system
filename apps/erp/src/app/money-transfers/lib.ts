/**
 * Server-only helpers for the money-transfers screen. T-139, bible row 150.
 *
 * `withOrgPrincipal` comes from the expenses screens rather than being duplicated — one
 * RLS-principal wrapper, one place to get it wrong.
 */
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { moneyAccountsRepo, moneyTransfersRepo, type MoneyTransferListRow } from '@shareat/db';
import { listStores, withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
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
 * EVERY active account in the org, each with what it holds - the "what is where" balances, which sit
 * behind the page's own read gate (`view_financial_reports`). ⚠️ Never feed a PICKER from this: it is not
 * scoped to anything the viewer may move (use `listTransferableAccounts`).
 */
export async function listAccountBalances(orgId: string): Promise<AccountOption[]> {
  return withOrgPrincipal(orgId, (tx) => balancesOf(tx, orgId, null));
}

/**
 * T-369 S6a (DEF-291): the accounts THIS person may move money out of or into - only those at stores where
 * they hold `transfer_funds` (pass `balances` from `listAccountBalances` to filter them rather than recompute). A picker used to offer every store's accounts and left the refusal to submit
 * time, which is the wrong half of the control to find out about. The domain still checks both ends on
 * submit (`createMoneyTransfer`); this decides what is OFFERED.
 *
 * Retired accounts are excluded deliberately: the service refuses them at either end, so offering one would
 * be an error the form invites and the domain then rejects.
 */
export async function listTransferableAccounts(actor: Actor, balances?: readonly AccountOption[]): Promise<AccountOption[]> {
  const stores = await listStores(actor.orgId);
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const allowed = new Set<string>();
    for (const s of stores) {
      try {
        await authorize(tx, actor, 'transfer_funds', { storeId: s.id });
        allowed.add(s.id);
      } catch (err) {
        if (err instanceof AuthorizationError) continue;
        throw err;
      }
    }
    if (allowed.size === 0) return [];
    // Given the org-wide balances the caller already read, narrow them instead of reading every ledger twice.
    if (balances) return balances.filter((a) => allowed.has(a.storeId));
    return balancesOf(tx, actor.orgId, allowed);
  });
}

async function balancesOf(
  tx: Parameters<Parameters<typeof withOrgPrincipal>[1]>[0],
  orgId: string,
  onlyStores: ReadonlySet<string> | null,
): Promise<AccountOption[]> {
  const accounts = (await moneyAccountsRepo.listMoneyAccounts(tx, orgId, {})).filter((a) => !onlyStores || onlyStores.has(a.storeId));
  return Promise.all(
    accounts.map(async (a) => ({
      id: a.id,
      storeId: a.storeId,
      name: a.name,
      instrument: a.instrument,
      custodian: a.custodian,
      glAccountCode: a.glAccountCode,
      // ⭐ Read from the LEDGER on every load - there is no balance column to go stale.
      balance: await moneyAccountsRepo.balanceOf(tx, orgId, a),
    })),
  );
}

export async function listRecentTransfers(orgId: string): Promise<MoneyTransferListRow[]> {
  return withOrgPrincipal(orgId, (tx) =>
    moneyTransfersRepo.listMoneyTransfers(tx, orgId, { limit: 50 }),
  );
}

