/**
 * T-435 / bible row 353 - the stores `actor` may see on a personal-data page: `scopedStores` (the one store rule shared with
 * the reports), kept where `can()` passes for ANY of `capabilities`. Never throws (a refused page is a card, DEF-189).
 *
 * Its own file so a page test can stub `scopedStores` and `can` without stubbing this.
 */
import { can, type Actor, type Capability } from '@shareat/auth';
import { schema, type Tx } from '@shareat/db';
import { eq } from 'drizzle-orm';
import { isOrgWideRole } from './can-read-at-store';
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

/**
 * T-577 (DEF-834) - the store ids a LIST page may show: where `actor` holds one of `capabilities`. `undefined` means EVERY store of the org (the
 * viewer is not store-limited), so the caller skips filtering and per-store sums altogether. Built on `heldStoresFor`, the one store rule.
 * ⛔ An org-wide role (admin, super_admin) is ALWAYS `undefined`, retired stores included, whatever its scope rows say (they only cover stores that
 * were active at appointment, so filtering would hide a retired store's debt). Everyone else: retired stores count (`includeRetired`) only where
 * the actor has a scope row, the same rule `can()` applies on a detail page.
 */
export async function heldStoreIdsOrAll(tx: Tx, actor: Actor, capabilities: readonly Capability[]): Promise<readonly string[] | undefined> {
  if (await isOrgWideRole(tx, actor)) return undefined;
  const held = await heldStoresFor(tx, actor, capabilities, { includeRetired: true });
  const total = await tx.select({ id: schema.stores.id }).from(schema.stores).where(eq(schema.stores.orgId, actor.orgId));
  return held.length >= total.length ? undefined : held.map((s) => s.id);
}
