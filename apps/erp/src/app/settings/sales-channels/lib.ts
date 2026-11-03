/**
 * Server-only reads for `/settings/sales-channels`. T-230.
 *
 * ⭐ Plain reads go straight through with **no capability gate** — the gate belongs to the WRITE,
 * which each domain function performs itself. Same asymmetry as
 * `/settings/expense-categories/lib.ts` and the house rule in `apps/erp/src/app/admin/users/lib.ts`.
 * A manager who opens this screen sees it and is refused on submit, which is honest; hiding the
 * screen would be presentation, and presentation is not a control (DEF-051).
 */
import { moneyAccountsRepo } from '@shareat/db';
import { listSalesChannelsForAdmin, receivableAccountOptions } from '@shareat/domain';
import { can, type Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../../expenses/lib';

export { withOrgPrincipal };

export type SalesChannelAdminRow = Awaited<ReturnType<typeof listSalesChannelsForAdmin>>[number];

export async function channelsForStore(actor: Actor, storeId: string): Promise<SalesChannelAdminRow[]> {
  return withOrgPrincipal(actor.orgId, (tx) => listSalesChannelsForAdmin(tx, actor, { storeId }));
}

/** Postable, active, party-bearing accounts — T-230 invariant 4. `1220` is the answer in practice. */
export async function receivableOptions(actor: Actor): Promise<{ code: string; name: string }[]> {
  return withOrgPrincipal(actor.orgId, (tx) => receivableAccountOptions(tx, actor));
}

/**
 * ⚠️ Read-only on this screen. `destination_money_account_id` is written by
 * `setChannelPayoutDestination` on `/channel-settlements`, and a second writer would be a second
 * validation that drifts from the first (bible §4.2 rule 8). This resolves the NAME so the row can
 * say which wallet is wired rather than showing a uuid or nothing at all.
 */
export async function moneyAccountNames(actor: Actor): Promise<Map<string, string>> {
  const rows = await withOrgPrincipal(actor.orgId, (tx) =>
    moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, {}),
  );
  return new Map(rows.map((a) => [a.id, a.name]));
}

/**
 * T-511 S2b: may this person set a channel's platform and store code at this store? Decides only whether the separate form is
 * DRAWN (presentation); `setSalesChannelPlatformCode` authorizes again and is the real gate. The page and the shared update
 * form stay open to a manager; this one is admin only.
 */
export async function canEditPlatformCode(actor: Actor, storeId: string): Promise<boolean> {
  return withOrgPrincipal(actor.orgId, (tx) => can(tx, actor, 'edit_platform_store_code', { storeId }));
}
