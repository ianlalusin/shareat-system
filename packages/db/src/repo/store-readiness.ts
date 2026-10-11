/**
 * store-readiness - T-391 S6. READ-ONLY SQL behind the per-store readiness report (`scripts/lib/master-data-readiness.ts`).
 * Nothing here writes. Every query runs under the caller's org principal and names the org, so a store of another org reads empty.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';

export interface ReadinessPerson {
  personId: string;
  displayName: string;
}

export interface StoreReadinessFacts {
  posLinked: boolean;
  cashAccount: boolean;
  /** Open employments at the store (the `loaded.staff` count). */
  openEmployments: number;
  /** Persons with an open employment at the store. Whether each is an encoder is `canAt`'s answer, not this file's. */
  employees: ReadinessPerson[];
  /** Active `manager` role AND person_store_scope at the store. */
  managers: ReadinessPerson[];
}

const rowsOf = <T>(r: unknown): T[] => r as unknown as T[];

/** Cash account: any ACTIVE instrument 'cash' money account at the store (the seeded foundation accounts included). */
export async function storeFacts(tx: Tx, orgId: string, storeId: string): Promise<StoreReadinessFacts> {
  const [link] = rowsOf<{ n: number }>(
    await tx.execute(sql`select count(*)::int as n from pos_v1_store_links where org_id = ${orgId} and store_id = ${storeId} and unlinked_at is null`),
  );
  const [cash] = rowsOf<{ n: number }>(
    await tx.execute(
      sql`select count(*)::int as n from money_accounts where org_id = ${orgId} and store_id = ${storeId} and instrument = 'cash' and is_active = true`,
    ),
  );
  const [open] = rowsOf<{ n: number }>(
    await tx.execute(sql`select count(*)::int as n from employments where org_id = ${orgId} and store_id = ${storeId} and ended_on is null`),
  );
  const emps = rowsOf<{ person_id: string; display_name: string }>(
    await tx.execute(sql`
      select distinct p.id as person_id, p.display_name
        from persons p
        join employments e on e.person_id = p.id and e.org_id = ${orgId} and e.store_id = ${storeId} and e.ended_on is null
       where p.org_id = ${orgId}
    `),
  );
  const mgr = rowsOf<{ person_id: string; display_name: string }>(
    await tx.execute(sql`
      select distinct p.id as person_id, p.display_name
        from persons p
        join person_roles r on r.person_id = p.id and r.org_id = ${orgId} and r.role = 'manager' and r.revoked_at is null
        join person_store_scope s on s.person_id = p.id and s.store_id = ${storeId}
       where p.org_id = ${orgId}
    `),
  );
  return {
    posLinked: Number(link?.n ?? 0) > 0,
    cashAccount: Number(cash?.n ?? 0) > 0,
    openEmployments: Number(open?.n ?? 0),
    employees: emps.map((m) => ({ personId: m.person_id, displayName: m.display_name })),
    managers: mgr.map((m) => ({ personId: m.person_id, displayName: m.display_name })),
  };
}

/** v1_master_links rows of one v1 store, counted per entity. */
export async function linkCountsForV1Store(tx: Tx, orgId: string, v1StoreId: string): Promise<Record<string, number>> {
  const rows = rowsOf<{ entity: string; n: number }>(
    await tx.execute(sql`select entity, count(*)::int as n from v1_master_links where org_id = ${orgId} and v1_store_id = ${v1StoreId} group by entity`),
  );
  return Object.fromEntries(rows.map((r) => [r.entity, Number(r.n)]));
}
