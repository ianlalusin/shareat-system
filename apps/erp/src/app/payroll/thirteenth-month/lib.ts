/**
 * Server-only helpers for `/payroll/thirteenth-month`. T-191.
 */
import { thirteenthMonthRepo } from '@shareat/db';
import { preview13thMonthRun, type ThirteenthMonthPreview } from '@shareat/domain';
import { withOrgPrincipal, listStores } from '../lib';

export { peso } from '../../../lib/format';
export { withOrgPrincipal, listStores };
export { cashAccountsFor } from '../lib';

/** ⚠️ Returns the error rather than throwing: a bad year should render a message, not a 500. */
export async function preview(
  orgId: string,
  actor: { orgId: string; personId: string },
  input: { storeId: string; year: number },
): Promise<{ preview: ThirteenthMonthPreview | null; error: string | null }> {
  try {
    const p = await withOrgPrincipal(orgId, (tx) => preview13thMonthRun(tx, actor, input));
    return { preview: p, error: null };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { preview: null, error: raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, '') };
  }
}

export async function runsFor(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) => thirteenthMonthRepo.listThirteenthMonthRuns(tx, orgId, { storeId }));
}

export async function payoutsFor(orgId: string, runId: string) {
  return withOrgPrincipal(orgId, (tx) => thirteenthMonthRepo.listThirteenthMonthPayouts(tx, runId));
}
