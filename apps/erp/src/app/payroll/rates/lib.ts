/**
 * Server-only reads for `/payroll/rates`. T-190.
 *
 * The page gate (`requirePageAccess('/payroll/rates')`, `manage_payroll_rates`, admin only) is the READ control; the write gates are
 * the domain functions' own `authorize()`. Every figure here is a reference-table row, not a person's pay.
 */
import { statutoryRepo } from '@shareat/db';
import { withOrgPrincipal } from '../../expenses/lib';

export { withOrgPrincipal };
export { listStores } from '../../expenses/lib';

export async function ratesView(orgId: string) {
  return withOrgPrincipal(orgId, async (tx) => ({
    rates: await statutoryRepo.listRates(tx, orgId),
    bracketSets: await statutoryRepo.listBracketSets(tx, orgId),
    minimumWages: await statutoryRepo.listMinimumWages(tx, orgId),
  }));
}
