import type postgres from 'postgres';

/**
 * T-390 S2 - run the REAL `applyPurge` (never a hand-inserted `cutover_steps` row) so C2 is reached the way production reaches it.
 * `docs/tasks/390-opening-stock-and-subledger-tieout.md` s4 R8, s8 fixtures. TESTER-owned, shared by the S2 files and the two
 * existing callers R8 now refuses (cutover.test.ts, t343-s5-5v-followups.test.ts).
 *
 * ⚠️ A real purge TRUNCATEs every purge-class table of the WHOLE database, so it may only be used against a database no other test
 * run is using (`run-with-db.mjs <your own db>`), and a test must create its org BEFORE calling it (the C2 row is written for every
 * organization that exists at purge time) and its operational data AFTER. Each test therefore builds a fresh fixture and never
 * relies on rows from an earlier test.
 */
export const PURGE_AS_OF = '2027-01-01';

/**
 * DEF-640: the purge takes ONE same-org performer per organization (0194's same-org FK). `performedBy` is the person for their own
 * org (a string) and/or an explicit orgId -> personId map; every other org that exists at purge time gets its earliest person, and a
 * person is created for an org that has none, as production would require an operator to.
 */
export async function performersForAllOrgs(
  sql: postgres.Sql,
  performedBy: string | Record<string, string>,
): Promise<Record<string, string>> {
  const map: Record<string, string> = typeof performedBy === 'string' ? {} : { ...performedBy };
  if (typeof performedBy === 'string') {
    const [p] = await sql<{ org_id: string }[]>`select org_id from persons where id = ${performedBy}`;
    if (p) map[p.org_id] = performedBy;
  }
  for (const o of await sql<{ id: string }[]>`select id from organizations`) {
    if (map[o.id]) continue;
    const [any] = await sql<{ id: string }[]>`select id from persons where org_id = ${o.id} order by id limit 1`;
    if (any) map[o.id] = any.id;
    else {
      const [made] = await sql<{ id: string }[]>`
        insert into persons (org_id, display_name) values (${o.id}, 'C2 performer') returning id`;
      map[o.id] = made!.id;
    }
  }
  return map;
}

export async function realPurge(
  sql: postgres.Sql,
  performedBy: string | Record<string, string>,
  opts: { rollback?: boolean } = {},
): Promise<void> {
  const { planPurge, applyPurge } = await import('../../packages/db/src/cutover/purge');
  const map = await performersForAllOrgs(sql, performedBy);
  const ROLLBACK = Symbol('rehearsal rollback');
  try {
    await sql.begin(async (tx) => {
      const plan = await planPurge(tx, PURGE_AS_OF);
      await applyPurge(tx, plan, { performedBy: map });
      if (opts.rollback) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}
