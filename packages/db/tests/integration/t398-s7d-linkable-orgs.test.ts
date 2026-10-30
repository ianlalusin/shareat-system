/**
 * T-398 S7d (TESTER) - O16: migration 0223, `linkable_counterparty_orgs()` (DEF-747's picker). docs/tasks/398-s7/S7-REFRESH.md s3, s9, s11 (O16).
 * Real Postgres via TEST_DATABASE_URL (`_test` name guard). Calls run as shareat_app with app.org_id set (the real principal shape); catalog and
 * log counts are read AS OWNER. Reuses the S6 world: L -> PG agreement, X -> Y agreement, W with none (agreements: org_id = franchisee,
 * franchisor_org_id = franchisor).
 *
 * RED TODAY for one reason: migration 0223 does not exist, so the function is absent (42883). Every positive leg asserts rows, so a missing
 * function can never pass as "returned nothing"; negative legs go through `rowsOrFail`, which rejects 42883/42P01/42703/42704.
 *
 * ASSUMED NAMES (S7-REFRESH s9): linkable_counterparty_orgs() RETURNS TABLE (org_id uuid, name text, code text); SECURITY DEFINER;
 * search_path pinned to public, pg_temp; EXECUTE for shareat_app only (not PUBLIC); no logging.
 *
 * MUTANTS (each leg names the one it kills): agreement join dropped; self not excluded; one direction only; null principal returns all orgs;
 * definer without a pinned search_path; EXECUTE left on PUBLIC; the function writes to franchise_access_log.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { franchiseWorld, menuFixture, sql, totalLogCount, viaApp, type FranchiseWorld, type PgErr } from './_fixtures/t398-s6-franchise';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const BROKEN = ['42P01', '42703', '42883', '42704'];
type Row = { org_id: string; name: string; code: string };
const W = (): Promise<FranchiseWorld> => franchiseWorld();

/** Run the picker as the app role for `org` (null = no org principal). A missing function is a failure, never an empty result. */
async function linkable(org: string | null, person?: string): Promise<Row[]> {
  const r = await viaApp({ org: org ?? undefined, person }, (tx) => tx.unsafe<Row[]>('select org_id, name, code from linkable_counterparty_orgs()'));
  if (r.err) {
    expect(BROKEN, `linkable_counterparty_orgs() is missing or broken: ${r.err.code} ${r.err.message}`).not.toContain((r.err as PgErr).code);
    throw r.err;
  }
  return r.value ?? [];
}
const ids = (rows: Row[]) => rows.map((r) => r.org_id).sort();

describe('O16 - linkable_counterparty_orgs()', () => {
  it('L sees exactly PG (its franchisee): not X, Y, W, not itself - Mutant: agreement join dropped (would return every other org)', async () => {
    const w = await W();
    const rows = await linkable(w.l.orgId, w.adminL.id);
    expect(ids(rows)).toEqual([w.pg.orgId]);
    const [org] = await sql<{ name: string; code: string }[]>`select name, code from organizations where id = ${w.pg.orgId}`;
    expect(rows[0]).toEqual({ org_id: w.pg.orgId, name: org!.name, code: org!.code });
  });

  it('PG sees exactly L (the agreement counts in EITHER direction) - Mutant: only franchisor_org_id side joined', async () => {
    const w = await W();
    expect(ids(await linkable(w.pg.orgId, w.adminPG.id))).toEqual([w.l.orgId]);
  });

  it('X sees Y and Y sees X, and neither sees L or PG - Mutant: another pair leaks (join on "any agreement exists")', async () => {
    const w = await W();
    expect(ids(await linkable(w.x.orgId, w.ianX.id))).toEqual([w.y.orgId]);
    expect(ids(await linkable(w.y.orgId, w.ianY.id))).toEqual([w.x.orgId]);
  });

  it('W (no agreement at all) sees nothing - Mutant: agreement join dropped / left-joined', async () => {
    const w = await W();
    expect(await linkable(w.w.orgId, w.readerW.id)).toEqual([]);
  });

  it('never the caller\'s own org, for any caller - Mutant: self not excluded', async () => {
    const w = await W();
    for (const [org, person] of [[w.l.orgId, w.adminL.id], [w.pg.orgId, w.adminPG.id], [w.x.orgId, w.ianX.id], [w.y.orgId, w.ianY.id]] as const) {
      expect(ids(await linkable(org, person))).not.toContain(org);
    }
  });

  it('no org principal -> empty, even though agreements exist - Mutant: null app_current_org() matches every row / returns every org', async () => {
    const w = await W();
    expect(await linkable(null)).toEqual([]);
    // positive control in the same world, so "empty" is not just "empty database"
    expect((await linkable(w.l.orgId, w.adminL.id)).length).toBeGreaterThan(0);
  });

  it('a new agreement is picked up at once, and an org with one linked org still sees only that one (control against a stale / cached result)', async () => {
    const w = await W();
    const before = ids(await linkable(w.w.orgId, w.readerW.id));
    expect(before).toEqual([]);
    // A FRESH org is the franchisee (franchise_agreements is UNIQUE on org_id and on franchisor_person_id, so no existing org or franchisor person can be reused).
    // Owner-level insert inside a transaction that is rolled back: W becomes the franchisor of the fresh org for the duration of the probe only.
    const fresh = await menuFixture('s7dfresh');
    class Rollback extends Error {}
    let seen: string[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx`insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from)
                 values (${fresh.orgId}, ${w.w.orgId}, ${fresh.personId}, '2027-01-01')`;
        await tx.unsafe('set local role shareat_app');
        await tx`select set_config('app.principal_kind', 'staff', true)`;
        await tx`select set_config('app.org_id', ${w.w.orgId}, true)`;
        seen = ids(await tx.unsafe<Row[]>('select org_id, name, code from linkable_counterparty_orgs()'));
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    expect(seen).toEqual([fresh.orgId]);
    expect(ids(await linkable(w.w.orgId, w.readerW.id))).toEqual([]);
  });

  it('it is not logged: franchise_access_log is unchanged by calling it - Mutant: the picker writes an access-log row', async () => {
    const w = await W();
    const n = await totalLogCount();
    await linkable(w.l.orgId, w.adminL.id);
    await linkable(w.pg.orgId, w.adminPG.id);
    expect(await totalLogCount()).toBe(n);
  });

  it('returns no business figures: exactly the columns (org_id, name, code) - Mutant: extra columns (e.g. agreement date, owner)', async () => {
    const r = await viaApp({ org: (await W()).l.orgId }, (tx) => tx.unsafe<Record<string, unknown>[]>('select * from linkable_counterparty_orgs()'));
    expect(r.err).toBeUndefined();
    expect(Object.keys(r.value![0]!)).toEqual(['org_id', 'name', 'code']);
  });
});

describe('O16 - the definer is built safely (catalog read as owner)', () => {
  const proc = async () =>
    (
      await sql<{ prosecdef: boolean; proconfig: string[] | null; proacl: string[] | null; owner: string }[]>`
        select p.prosecdef, p.proconfig, p.proacl::text[] as proacl, pg_get_userbyid(p.proowner) as owner
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'linkable_counterparty_orgs'`
    )[0];

  it('exists, is SECURITY DEFINER - Mutant: invoker rights (RLS would hide every other org again, the bug DEF-747 records)', async () => {
    const p = await proc();
    expect(p, 'migration 0223 has not created linkable_counterparty_orgs()').toBeDefined();
    expect(p!.prosecdef).toBe(true);
  });
  it('pins search_path to public, pg_temp - Mutant: definer without a pinned search_path', async () => {
    const p = await proc();
    const cfg = (p?.proconfig ?? []).find((c) => c.startsWith('search_path='));
    expect(cfg, 'search_path is not pinned').toBeDefined();
    expect(cfg!.replace(/\s/g, '')).toBe('search_path=public,pg_temp');
  });
  it('EXECUTE is granted to shareat_app and NOT to PUBLIC - Mutant: REVOKE FROM PUBLIC forgotten', async () => {
    const p = await proc();
    expect(p).toBeDefined();
    const acl = p!.proacl ?? [];
    expect(acl.some((a) => a.startsWith('shareat_app='))).toBe(true);
    expect(acl.some((a) => a.startsWith('='))).toBe(false);
  });
});
