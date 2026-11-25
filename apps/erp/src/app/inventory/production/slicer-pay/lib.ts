/**
 * Server-only reads for the slicer pay screen. T-635.
 *
 * The period comes from the SAME place the payroll screen gets it (`payroll/lib.ts`: the store's own configured periods), and the
 * overview counts a record in a period with the same inclusive dates the pay run uses. The rules live in `packages/domain/src/production/slicer-pay.ts`.
 */
import { itemsRepo } from '@shareat/db';
import { can, type Actor } from '@shareat/auth';
import { listSlicerPayRatesFor, slicerPayOverview } from '@shareat/domain';
import { withOrgPrincipal } from '../lib';

export async function slicerPayData(actor: Actor, storeId: string, from: string, to: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const [overview, rates, items, canSetRate] = await Promise.all([
      slicerPayOverview(tx, actor, { storeId, from, to }),
      listSlicerPayRatesFor(tx, actor, { storeId }),
      itemsRepo.listItems(tx, actor.orgId, { includeInactive: false, stockedOnly: true }),
      can(tx, actor, 'set_pay_rate', { storeId }),
    ]);
    return { overview, rates, slicedItems: items.filter((i) => i.kind === 'meat_sliced').map((i) => ({ id: i.id, name: i.name })), canSetRate };
  });
}
