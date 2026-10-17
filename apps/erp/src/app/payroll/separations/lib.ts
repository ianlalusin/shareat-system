/**
 * Server-only helpers for `/payroll/separations`. T-192.
 */
import { separationsRepo } from '@shareat/db';
import { previewSeparation, type SeparationPreview } from '@shareat/domain';
import { authorize, type Actor } from '@shareat/auth';
import { withOrgPrincipal, listStores } from '../lib';
import { errorMessage } from '@/lib/constraint-messages';

export { peso } from '../../../lib/format';
export { withOrgPrincipal, listStores };
export { cashAccountsFor, payrollStoresFor } from '../lib';

// ⛔ T-435: the full Actor, authorized for run_payroll at the store read (bible row 353, §15.11).
export async function worklistFor(actor: Actor, storeId: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'run_payroll', { storeId });
    return separationsRepo.endedEmploymentsWithoutSeparation(tx, actor.orgId, storeId);
  });
}

export async function separationsFor(actor: Actor, storeId: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'run_payroll', { storeId });
    return separationsRepo.listSeparations(tx, actor.orgId, { storeId });
  });
}

/** ⚠️ Returns the error rather than throwing: a bad selection should render a message, not a 500. */
export async function preview(
  orgId: string,
  actor: { orgId: string; personId: string },
  input: { storeId: string; employmentId: string; separationDate: string },
): Promise<{ preview: SeparationPreview | null; error: string | null }> {
  try {
    const p = await withOrgPrincipal(orgId, (tx) => previewSeparation(tx, actor, input));
    return { preview: p, error: null };
  } catch (err) {
    return { preview: null, error: errorMessage(err) };
  }
}
