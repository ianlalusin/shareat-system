/**
 * T-533 S3 - the reads only the POS pre-flight needs (docs/tasks/533-pos-lipa-switch.md R3). Every other fact it checks comes from an existing repo
 * (pos-v2, pos-v1, kitchen, business-rules, access). READS ONLY: nothing here writes, and no rule lives here; the domain (`pos/preflight.ts`) decides.
 * Each query filters by org (and store where the fact is the store's); RLS backstops (bible section 15.11).
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';

/** Tills of the store whose tablet is a LIVE pairing (not revoked). A till with no tablet, or a revoked one, does not count. */
export async function countTillsWithLivePairing(tx: Tx, orgId: string, storeId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(*)::int as n
      from pos_terminals t
      join pos_tablet_pairings p on p.store_id = t.store_id and p.id = t.pairing_id
     where t.org_id = ${orgId} and t.store_id = ${storeId} and p.revoked_at is null
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** Of `personIds`, the ones holding a live (not revoked) sign-in PIN. */
export async function personIdsWithLivePin(tx: Tx, orgId: string, personIds: readonly string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const rows = (await tx.execute(sql`
    select distinct c.person_id::text as person_id
      from person_credentials c
      join persons p on p.id = c.person_id
     where p.org_id = ${orgId} and c.kind = 'pin' and c.revoked_at is null
       and c.person_id in (${sql.join(personIds.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as { person_id: string }[];
  return new Set(rows.map((r) => r.person_id));
}

/**
 * Active people of the org with an active role above staff (manager, admin, super_admin) and a live PIN. The caller keeps those who may sign in at the
 * store (`accessRepo.personMaySignInAtStore`) and applies the ladder (`isStoreManagerOrAbove`); the role comes back so it can.
 */
export async function listRoleHoldersWithLivePin(tx: Tx, orgId: string): Promise<{ personId: string; role: string }[]> {
  const rows = (await tx.execute(sql`
    select distinct p.id::text as person_id, r.role
      from person_roles r
      join persons p on p.id = r.person_id and p.org_id = r.org_id
     where r.org_id = ${orgId} and r.revoked_at is null and p.is_active
       and r.role in ('manager', 'admin', 'super_admin')
       and exists (select 1 from person_credentials c where c.person_id = p.id and c.kind = 'pin' and c.revoked_at is null)
  `)) as unknown as { person_id: string; role: string }[];
  return rows.map((r) => ({ personId: r.person_id, role: r.role }));
}

/**
 * Package variants on sale NOW at the store (a store-channel offer in force, not withdrawn, active item and variant) that name no active refill item.
 * The same "on sale now" test as `kitchenRepo.offeredItemsWithRoute`. Returns display names, in name order.
 */
export async function listOfferedPackagesWithoutRefills(tx: Tx, orgId: string, storeId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select i.name || coalesce(' (' || v.label || ')', '') as name
      from menu_items i
      join menu_item_variants v on v.menu_item_id = i.id and v.org_id = i.org_id
      cross join lateral menu_offer_in_force(${storeId}, v.id, 'store', now()) f
     where i.org_id = ${orgId} and i.item_type = 'package' and i.status = 'active' and v.status = 'active' and not f.withdrawn
       and not exists (select 1 from menu_package_refills r where r.package_variant_id = v.id and r.status = 'active')
     order by lower(i.name), v.id
  `)) as unknown as { name: string }[];
  return rows.map((r) => r.name);
}
