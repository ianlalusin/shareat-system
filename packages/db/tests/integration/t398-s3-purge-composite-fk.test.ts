/**
 * T-398 S3 / DEF-491 -- leg P1 (D1): the cutover purge still works once same-org composite foreign keys exist.
 * docs/tasks/398-padre-garcia-franchise-org.md D1. Real Postgres, scratch database (name contains "_test").
 *
 * The mechanism (D1): a composite FK is (org_id, col). `applyPurge` step 1 refuses unless EVERY column of every
 * kept-child -> purged-parent FK is in the child's `clearColumns`; the purge never clears org_id, so with the
 * composites present it refuses on fixed_assets.source_expense_id (parent `expenses` is purged) and on
 * recurring_expenses.last_drafted_expense_id. S3 makes that check ignore org_id: a composite is MATCH SIMPLE, so
 * clearing the other column to NULL satisfies it, and the dropped FK is re-added validated afterwards.
 *
 * Independence from 0213: the scratch database is migrated to head and then, if the two composites are not
 * there yet (they are not before 0213), this test ADDS them (plus the UNIQUE (org_id, id) on expenses) by hand,
 * so the leg is red today for the real reason and stays a regression guard after 0213.
 *
 * MUTANT: purge.ts's step-1 check goes back to `fk.childColumns.every(c => clearColumns.includes(c))` (counting
 * org_id) -> "C2 performer"-free refusal "not in clearColumns" -> every `it` here goes red.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { auditDumpFor } from '../../../../tests/integration/t402-s3-audit-dump';
import { buildScratchAtHead, dbUrl, dropDb, insertOrg, insertSynth } from './t398-s3-fixture';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const DB = `shareat_t398s3_test_p1_${Date.now()}`;
/** D1's two named cases: kept shell child columns whose parent (`expenses`) is purged. */
const CASES = [
  { child: 'fixed_assets', col: 'source_expense_id' },
  { child: 'recurring_expenses', col: 'last_drafted_expense_id' },
] as const;

let s: postgres.Sql;
let orgId = '';
let personId = '';
let applyError: unknown;
let seeded: { child: string; id: string; col: string; expenseId: string }[] = [];

async function hasComposite(q: postgres.Sql, child: string, col: string): Promise<boolean> {
  const [r] = await q<{ n: number }[]>`
    select count(*)::int as n from pg_constraint con
    where con.contype = 'f' and con.conrelid = ${child}::regclass and con.confrelid = 'expenses'::regclass and cardinality(con.conkey) = 2
      and (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) = 'org_id'
      and (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[2]) = ${col}`;
  return (r?.n ?? 0) > 0;
}

beforeAll(async () => {
  s = await buildScratchAtHead(url, DB); // CHECKs and user triggers stripped: the rows below are crude on purpose
  // The composites, exactly as 0213 will shape them, when 0213 is not applied yet.
  const [u] = await s<{ n: number }[]>`
    select count(*)::int as n from pg_constraint u
    where u.conrelid = 'expenses'::regclass and u.contype = 'u' and cardinality(u.conkey) = 2
      and (select array_agg(attname::text order by attname) from pg_attribute where attrelid = u.conrelid and attnum = any(u.conkey)) = array['id', 'org_id']`;
  if ((u?.n ?? 0) === 0) await s.unsafe(`alter table expenses add constraint zz_t398s3_p1_expenses_org_id_id_unique unique (org_id, id)`);
  for (const c of CASES) {
    if (!(await hasComposite(s, c.child, c.col))) {
      await s.unsafe(
        `alter table "${c.child}" add constraint "zz_t398s3_p1_${c.child}_${c.col}" foreign key (org_id, "${c.col}") references expenses (org_id, id)`,
      );
    }
  }
  // One performer, and one kept-shell child row per case pointing at a real expense.
  seeded = await s.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    orgId = await insertOrg(tx, 'p1');
    personId = await insertSynth(tx, 'persons', orgId);
    const out: typeof seeded = [];
    for (const c of CASES) {
      const expenseId = await insertSynth(tx, 'expenses', orgId);
      const id = await insertSynth(tx, c.child, orgId, { [c.col]: `'${expenseId}'::uuid` });
      out.push({ child: c.child, id, col: c.col, expenseId });
    }
    return out;
  });
  try {
    const mod = (await import('../../src/cutover/purge')) as {
      planPurge: (sql: unknown, asOf: string) => Promise<unknown>;
      applyPurge: (tx: unknown, plan: unknown, opts?: { performedBy?: Record<string, string>; auditDump?: unknown }) => Promise<unknown>;
    };
    await s.begin(async (tx) => {
      const plan = await mod.planPurge(tx, '2026-12-31');
      const auditDump = await auditDumpFor(dbUrl(url, DB), '2026-12-31');
      await mod.applyPurge(tx, plan, { auditDump, performedBy: { [orgId]: personId } });
    });
  } catch (err) {
    applyError = err;
  }
}, 300_000);

afterAll(async () => {
  await s?.end({ timeout: 5 });
  await dropDb(url, DB);
}, 120_000);

describe('P1 (D1) -- applyPurge succeeds with the composite FKs present', () => {
  it('the precondition holds: both composites exist on the scratch database before the purge ran', async () => {
    for (const c of CASES) expect(await hasComposite(s, c.child, c.col), `${c.child}.${c.col} composite`).toBe(true);
  });

  it('RED today (purge.ts counts org_id): applyPurge does not throw -- it is not refused with "not in clearColumns"', () => {
    expect(applyError, `applyPurge threw: ${(applyError as Error | undefined)?.message}`).toBeUndefined();
  });

  it.each(CASES.map((c) => [`${c.child}.${c.col}`, c] as const))('%s is cleared to NULL, org_id is kept, and the composite is re-added validated', async (_n, c) => {
    expect(applyError, 'the purge must have succeeded').toBeUndefined();
    const row = seeded.find((x) => x.child === c.child)!;
    const [r] = await s.unsafe<{ v: string | null; org: string }[]>(`select "${c.col}"::text as v, org_id::text as org from "${c.child}" where id = $1`, [row.id]);
    expect(r, 'a kept shell row must still exist (recurring_expenses and fixed_assets are keep_shell; fixed_assets may drop a disposed row, never a fresh one)').toBeDefined();
    expect(r!.v, 'the reference to the purged expense is cleared').toBeNull();
    expect(r!.org, 'org_id is never cleared').toBe(orgId);
    const [k] = await s<{ n: number }[]>`
      select count(*)::int as n from pg_constraint con
      where con.contype = 'f' and con.conrelid = ${c.child}::regclass and con.confrelid = 'expenses'::regclass and cardinality(con.conkey) = 2 and con.convalidated`;
    expect(k!.n, 'the composite FK is back and validated').toBeGreaterThanOrEqual(1);
  });

  it('the purged parent is empty', async () => {
    expect(applyError).toBeUndefined();
    const [r] = await s<{ n: number }[]>`select count(*)::int as n from expenses`;
    expect(r!.n).toBe(0);
  });
});
