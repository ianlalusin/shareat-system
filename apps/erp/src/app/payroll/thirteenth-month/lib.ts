/**
 * Server-only helpers for `/payroll/thirteenth-month`. T-191.
 */
import { thirteenthMonthRepo } from '@shareat/db';
import { preview13thMonthRun, type ThirteenthMonthPreview } from '@shareat/domain';
import { authorize, type Actor } from '@shareat/auth';
import { withOrgPrincipal, listStores } from '../lib';
import { errorMessage } from '@/lib/constraint-messages';

export { peso } from '../../../lib/format';
export { withOrgPrincipal, listStores };
export { cashAccountsFor, payrollStoresFor } from '../lib';

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
    return { preview: null, error: errorMessage(err) };
  }
}

// ⛔ T-435: the full Actor, authorized for run_payroll; a by-id reader authorizes on the run's OWN store.
export async function runsFor(actor: Actor, storeId: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'run_payroll', { storeId });
    return thirteenthMonthRepo.listThirteenthMonthRuns(tx, actor.orgId, { storeId });
  });
}

export async function payoutsFor(actor: Actor, runId: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const run = await thirteenthMonthRepo.getThirteenthMonthRun(tx, actor.orgId, runId);
    if (!run) return [];
    await authorize(tx, actor, 'run_payroll', { storeId: run.storeId });
    return thirteenthMonthRepo.listThirteenthMonthPayouts(tx, runId);
  });
}
