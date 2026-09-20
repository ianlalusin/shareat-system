/**
 * Server-only helpers for the service-charge distribution screen. T-187 slice 1.
 *
 * ⭐ The float shown here is read from the ledger — `serviceChargeRepo.floatBalance`, the same
 * "no stored total" discipline every money screen in this app follows (bible §6.3).
 */
import { moneyAccountsRepo, serviceChargeRepo } from '@shareat/db';
import { toBusinessDate } from '@shareat/core/datetime';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

/**
 * ⛔ The BUSINESS clock (Asia/Manila), never the server's UTC one — `paidOn` is half of
 * Amendment 2's idempotency key, so a UTC default that reads "yesterday" before 8am Manila does
 * not just mis-date the form: a resubmit with the corrected date is a DIFFERENT key, and the
 * float discharges twice. `toBusinessDate` (`@shareat/core/datetime`) is this codebase's one
 * sanctioned source for "today" on the server — T-218 removed every other JS clock for this
 * exact reason.
 */
export function today(): string {
  return toBusinessDate();
}

/** That store's own `2160` balance — what is actually available to distribute (§7 invariant 1). */
export async function floatBalance(orgId: string, storeId: string): Promise<string> {
  return withOrgPrincipal(orgId, (tx) => serviceChargeRepo.floatBalance(tx, orgId, storeId));
}

/** Where a distribution can be paid from — every money account belonging to this store. */
export async function moneyAccounts(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId });
    return Promise.all(
      accounts.map(async (a) => ({
        ...a,
        balance: await moneyAccountsRepo.balanceOf(tx, orgId, a),
      })),
    );
  });
}
