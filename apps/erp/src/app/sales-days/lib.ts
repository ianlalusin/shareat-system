/**
 * Server-only helpers for the sales-day screens. docs/tasks/123-sales-day.md.
 *
 * ⚠️ **The org/store/"acting as" picker is the SAME temporary stand-in T-122 documents** — see
 * `apps/erp/src/app/expenses/lib.ts`'s top comment in full before touching anything here. There
 * is still no session/login bridge in `apps/erp` (bible §7.1 plans one; no task has built it), so
 * the acting person travels as an unsigned form field exactly as `orgId`/`storeId` already do on
 * the reports screens.
 *
 * Those helpers are imported rather than duplicated: two copies of an auth stand-in is two places
 * to forget when the real bridge lands.
 */
import { moneyAccountsRepo, salesDaysRepo } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export {
  listStores,
  listActingPersons,
  withOrgPrincipal,
} from '../expenses/lib';
export type { StoreOption, PersonOption } from '../expenses/lib';

export interface ChannelOption {
  id: string;
  name: string;
  isRemittedDaily: boolean;
  receivableAccountCode: string | null;
  isActive: boolean;
}

/** A store's configured sales channels. **The `isRemittedDaily` flag is the one that matters** —
 *  it decides whether a channel's money reaches the till, and therefore whether it is part of
 *  expected remittance at all (bible row 128). Shown on the form for exactly that reason.
 *
 *  ⭐ **T-230: ACTIVE only, and this is a PICKER, not a validator.** `writeChannels`
 *  (`domain/sales-days/create.ts`) deliberately validates against the UNFILTERED list, because
 *  editing an old sales day that names a since-retired channel has to keep working. Offering a
 *  retired channel for a NEW day is the thing that would make "retire" mean nothing. */
export async function listChannels(orgId: string, storeId: string): Promise<ChannelOption[]> {
  return withOrgPrincipal(orgId, (tx) => salesDaysRepo.listChannels(tx, orgId, storeId, { activeOnly: true }));
}

export interface StoreWallet {
  id: string;
  name: string;
  storeId: string;
  custodian: string;
  isActive: boolean;
}

/**
 * T-369 S3 (DEF-291): the ACTIVE money accounts of ONE store - what a sales day at that store may
 * report money into. Scoped in the query, never fetched org-wide and filtered after: the old
 * `listMoneyAccountsForPicker(orgId)` read every store's accounts and relied on each caller to
 * remember the filter. `writeTenders` (domain) still refuses a foreign wallet at save time.
 */
export async function listStoreMoneyAccounts(
  orgId: string,
  storeId: string,
  opts: { includeRetired?: boolean } = {},
): Promise<StoreWallet[]> {
  const rows = await withOrgPrincipal(orgId, (tx) =>
    moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId, ...(opts.includeRetired ? { activeOnly: false } : {}) }),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, storeId: r.storeId, custodian: r.custodian, isActive: r.isActive }));
}
