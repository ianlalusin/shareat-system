/**
 * Server-only helpers for `/payroll/separations`. T-192.
 */
import { separationsRepo } from '@shareat/db';
import { previewSeparation, type SeparationPreview } from '@shareat/domain';
import { withOrgPrincipal, listStores } from '../lib';
import { errorMessage } from '@/lib/constraint-messages';

export { peso } from '../../../lib/format';
export { withOrgPrincipal, listStores };
export { cashAccountsFor } from '../lib';

export async function worklistFor(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) => separationsRepo.endedEmploymentsWithoutSeparation(tx, orgId, storeId));
}

export async function separationsFor(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) => separationsRepo.listSeparations(tx, orgId, { storeId }));
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
