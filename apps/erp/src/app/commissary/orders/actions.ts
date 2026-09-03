'use server';

/**
 * The register's one action — a branch drafts a new order. T-172 / DEF-136.
 *
 * Thin adapter: parse `FormData`, call the domain, redirect with a message. ⭐ The actor comes from
 * the session, never the form; `saveBranchOrderDraft` authorises `place_branch_order` at the
 * BRANCH as its first statement, under the org's RLS principal.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { saveBranchOrderDraft } from '@shareat/domain';
import { errorMessageOf, withOrgPrincipal, peso } from './lib';
import { requireActor } from '../../../lib/session';

// ⚠️ A `'use server'` module may export ONLY async functions — a sync helper exported from here is
// a build error the dev server surfaces as a page error (memory: use-server type re-export).
// `errorMessageOf` therefore lives in `./lib`.

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : ''));
}

export async function createOrderAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/commissary/orders');
  const branchStoreId = str(fd, 'branchStoreId');
  const itemIds = strs(fd, 'itemId');
  const quantities = strs(fd, 'quantity');
  const rates = strs(fd, 'rate');
  // A row whose item was never picked is an empty row, not an error — skipped. A picked item
  // with no quantity is a real mistake, and the domain says so by name.
  const lines = itemIds
    .map((itemId, i) => ({ itemId, quantity: quantities[i] ?? '', rate: rates[i] || null }))
    .filter((l) => l.itemId);

  let orderId = '';
  let total = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      saveBranchOrderDraft(tx, actor, {
        branchStoreId,
        commissaryStoreId: str(fd, 'commissaryStoreId'),
        orderDate: str(fd, 'orderDate'),
        notes: str(fd, 'notes') || null,
        lines,
      }),
    );
    orderId = result.orderId;
    total = result.totalAmount;
  } catch (err) {
    redirect(`/commissary/orders?${new URLSearchParams({ store: branchStoreId, error: errorMessageOf(err) })}`);
  }
  revalidatePath('/commissary/orders');
  redirect(
    `/commissary/orders/${orderId}?${new URLSearchParams({
      ok: `Draft saved at ${peso(total)}. Add or change lines, then submit it to the commissary.`,
    })}`,
  );
}
