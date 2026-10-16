/**
 * T-435 / bible row 353 - the stores `actor` may see on a personal-data page: `scopedStores` (the one store rule shared with
 * the reports), kept where `can()` passes for ANY of `capabilities`. Never throws (a refused page is a card, DEF-189).
 *
 * Its own file so a page test can stub `scopedStores` and `can` without stubbing this.
 */
import { can, type Actor, type Capability } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import { scopedStores, type StoreOption } from '../app/reports/lib';

export async function heldStoresFor(
  tx: Tx,
  actor: Actor,
  capabilities: readonly Capability[],
  opts: { includeRetired?: boolean } = {},
): Promise<StoreOption[]> {
  const { stores } = await scopedStores(tx, actor, opts);
  const out: StoreOption[] = [];
  for (const s of stores) {
    for (const cap of capabilities) {
      if (await can(tx, actor, cap, { storeId: s.id })) {
        out.push(s);
        break;
      }
    }
  }
  return out;
}
