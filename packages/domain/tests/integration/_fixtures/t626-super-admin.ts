/**
 * T-626 (TESTER) - a super admin for a t525 fixture's org, the only role that may add menu items and pair prices to hours (`add_menu_item`, `pair_menu_dayparts`).
 * Raw SQL, so the DATABASE is the oracle. Scope is the fixture's two stores.
 */
import { actorOf, sql, type Fx } from './t525-pos';

export async function superAdminOf(f: Pick<Fx, 'orgId' | 'storeId' | 'store2Id'>) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Sue Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'super_admin')`;
  for (const s of [f.storeId, f.store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return actorOf(f.orgId, p!.id);
}
