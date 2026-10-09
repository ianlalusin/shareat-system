import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-386 S5 - `docs/tasks/386-item-code-auto-suggest.md` S5 / R11, legs C1-C6. TESTER file. Real Postgres, real `authorize()`.
 *
 * Red today: `recodeItems` (packages/domain/src/items/recode.ts), `scripts/recode-items.ts` `run()` and the importer's exported
 * insert function do not exist. Each leg reaches them through a late-bound lookup so a missing export fails THAT leg at call time.
 *
 * Contracts coded against (builder must provide exactly these):
 *   recodeItems(tx, actor, { orgId }) -> [{ itemId, name, status, from, to | null, note }]   (from '@shareat/domain')
 *   scripts/recode-items.ts  export run({ org, actor, apply, out? }) -> { recoded, kept, skipped, lines: string[] }
 *       `out` receives each printed line (default console.log); importing the file must NOT start main().
 *       Printed row format: `<old> -> <new>  <name> (<status>)`; a counts line: `recoded N · kept M · skipped K`.
 *   scripts/import-items.ts  export insertCleanItems({ orgId, items: [{ name, kind, baseUnit }] }) -> { inserted, skipped }
 *       Runs under withOrgPrincipal; allocates a code (allocateItemCode) only after the name is known to be new;
 *       importing the file must NOT start main().
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';

type Row = { itemId: string; name: string; status: string; from: string; to: string | null; note: string };
type RunResult = { recoded: number; kept: number; skipped: number; lines: string[] };

// Read off the namespace so a missing export fails the leg that calls it (TypeError at call time), not the whole file at import.
const recodeItems = (domain as unknown as {
  recodeItems: (tx: Tx, actor: Actor, input: { orgId: string }) => Promise<Row[]>;
}).recodeItems;

const loadRun = async () =>
  (await import('../../../../scripts/recode-items')) as unknown as {
    run: (o: { org: string; actor: string; apply: boolean; out?: (l: string) => void }) => Promise<RunResult>;
  };
const loadImporter = async () =>
  (await import('../../../../scripts/import-items')) as unknown as {
    insertCleanItems: (o: {
      orgId: string;
      items: { name: string; kind: string; baseUnit: string }[];
    }) => Promise<{ inserted: number; skipped: number }>;
  };

const sql = postgres(url, { max: 12 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t386s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const superId = await mk('Super', 'super_admin');
  const managerId = await mk('Manager', 'manager');
  return { orgId, createdBy: superId, superId, superAdmin: actor(orgId, superId), manager: actor(orgId, managerId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Raw insert (superuser connection, like the legacy rows production holds). `age` orders created_at: bigger = older. */
async function legacy(f: Fixture, name: string, code: string, age: number, status = 'active', mergedInto?: string) {
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, status, merged_into_id, created_by, created_at)
    values (${f.orgId}, ${code}, ${name}, 'raw_material', 'kg', ${status}, ${mergedInto ?? null}, ${f.createdBy},
            now() - (${age} || ' minutes')::interval)
    returning id`;
  return r!.id;
}

/** The C1 org, oldest first: Pork belly, Chicken wings, Chicken winglets (merged into wings), Coke 1.5, shaped Coke 15 (CK15-004). */
async function c1Org(hint: string) {
  const f = await fixture(hint);
  const pork = await legacy(f, 'Pork belly', 'PORK-BELLY', 50);
  const wings = await legacy(f, 'Chicken wings', 'CHICKEN-WINGS', 40, 'inactive');
  const winglets = await legacy(f, 'Chicken winglets', 'CHICKEN-WINGLETS', 30, 'merged', wings);
  const coke = await legacy(f, 'Coke 1.5', 'COKE-1-5', 20);
  const shaped = await legacy(f, 'Coke 15', 'CK15-004', 10);
  return { f, pork, wings, winglets, coke, shaped };
}

const itemRow = async (id: string) =>
  (await sql<{ name: string; code: string; status: string }[]>`select name, code, status from items where id = ${id}`)[0]!;
const codesOf = async (f: Fixture) =>
  Object.fromEntries(
    (await sql<{ name: string; code: string }[]>`select name, code from items where org_id = ${f.orgId}`).map((r) => [r.name, r.code]),
  );
const markOf = async (f: Fixture, stem: string) =>
  (await sql<{ last_seq: number }[]>`select last_seq from item_code_counters where org_id = ${f.orgId} and stem = ${stem}`)[0]?.last_seq ?? null;
const recodeAudit = (f: Fixture) =>
  sql<{ entity_id: string; before: { code?: string }; after: { code?: string } }[]>`
    select entity_id, before, after from audit_log
     where entity = 'items' and action = 'recode_item' and org_id = ${f.orgId} order by occurred_at, id`;

const recode = (f: Fixture, who: Actor) => asOrg(f.orgId, (tx) => recodeItems(tx, who, { orgId: f.orgId }));

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('C - the one-time recode (R11)', () => {
  it(
    'C1: legacy codes -> PRBL-001, CHWN-001, CHWN-002 (merged), CK15-005 (mark was 4); shaped CK15-004 kept; one recode_item audit row each; statuses unchanged. Mutants: skip non-active items -> the inactive and merged rows stay legacy, red; order by name not created_at -> "Chicken winglets" sorts before "Chicken wings" and takes CHWN-001, red',
    async () => {
      const o = await c1Org('c1');
      // sanity: the fixture really holds the legacy rows and the mark is 4 (raised by the trigger from the shaped row)
      expect(await codesOf(o.f)).toMatchObject({ 'Pork belly': 'PORK-BELLY', 'Coke 15': 'CK15-004' });
      expect(await markOf(o.f, 'CK15')).toBe(4);

      const rows = await recode(o.f, o.f.superAdmin);

      expect(await codesOf(o.f)).toEqual({
        'Pork belly': 'PRBL-001',
        'Chicken wings': 'CHWN-001',
        'Chicken winglets': 'CHWN-002',
        'Coke 1.5': 'CK15-005',
        'Coke 15': 'CK15-004',
      });
      // statuses and the merge pointer are untouched
      expect((await itemRow(o.wings)).status).toBe('inactive');
      expect((await itemRow(o.winglets)).status).toBe('merged');
      expect((await itemRow(o.pork)).status).toBe('active');
      // returned rows: 4 recoded (from -> to); the shaped one is not reported as changed
      const changed = rows.filter((r) => r.to !== null && r.to !== r.from);
      expect(changed.map((r) => [r.from, r.to])).toEqual([
        ['PORK-BELLY', 'PRBL-001'],
        ['CHICKEN-WINGS', 'CHWN-001'],
        ['CHICKEN-WINGLETS', 'CHWN-002'],
        ['COKE-1-5', 'CK15-005'],
      ]);
      expect(rows.find((r) => r.itemId === o.wings)).toMatchObject({ name: 'Chicken wings', status: 'inactive' });
      // one audit row per recoded item, old code in before, new in after
      const audit = await recodeAudit(o.f);
      expect(audit.map((a) => [a.entity_id, a.before.code, a.after.code])).toEqual([
        [o.pork, 'PORK-BELLY', 'PRBL-001'],
        [o.wings, 'CHICKEN-WINGS', 'CHWN-001'],
        [o.winglets, 'CHICKEN-WINGLETS', 'CHWN-002'],
        [o.coke, 'COKE-1-5', 'CK15-005'],
      ]);
      expect(await markOf(o.f, 'CK15')).toBe(5);
      expect(await markOf(o.f, 'CHWN')).toBe(2);
    },
    60_000,
  );

  it(
    'C2: a second run recodes nothing and writes no new audit rows (idempotent). Mutant: re-allocate shaped codes -> red',
    async () => {
      const o = await c1Org('c2');
      await recode(o.f, o.f.superAdmin);
      const before = await codesOf(o.f);
      const auditBefore = (await recodeAudit(o.f)).length;
      expect(auditBefore).toBe(4);
      const again = await recode(o.f, o.f.superAdmin);
      expect(again.filter((r) => r.to !== null && r.to !== r.from)).toEqual([]);
      expect(await codesOf(o.f)).toEqual(before);
      expect((await recodeAudit(o.f)).length).toBe(auditBefore);
    },
    60_000,
  );

  it(
    'C3: a manager is refused (AuthorizationError) and nothing changes. Mutant: authorize dropped -> red',
    async () => {
      const o = await c1Org('c3');
      const before = await codesOf(o.f);
      await expect(recode(o.f, o.f.manager)).rejects.toBeInstanceOf(AuthorizationError);
      expect(await codesOf(o.f)).toEqual(before);
      expect((await recodeAudit(o.f)).length).toBe(0);
    },
    60_000,
  );

  it(
    'C4: an item named "--" is listed skipped (to null, a note), its code unchanged; the rest are recoded. Mutant: a skipped item aborts the run or gets a code -> red',
    async () => {
      const f = await fixture('c4');
      const odd = await legacy(f, '--', 'ODD-ONE', 30);
      const pork = await legacy(f, 'Pork belly', 'PORK-BELLY', 20);
      const rows = await recode(f, f.superAdmin);
      expect((await itemRow(odd)).code).toBe('ODD-ONE');
      expect((await itemRow(pork)).code).toBe('PRBL-001');
      const skipped = rows.filter((r) => r.to === null);
      expect(skipped.map((r) => r.itemId)).toEqual([odd]);
      expect(skipped[0]!.note).toMatch(/no letters or numbers/);
      expect((await recodeAudit(f)).map((a) => a.entity_id)).toEqual([pork]);
    },
    60_000,
  );
});

describe('C7 - org scoping', () => {
  it(
    'C7: recoding org A changes none of org B items, writes no audit rows for B and leaves B counters unchanged. Mutant: the item listing ignores orgId -> B legacy codes change, red (unless row-level security hides B first; B holds the same names as A so a leak would show as B codes or B counters moving)',
    async () => {
      const a = await c1Org('c7a');
      const b = await fixture('c7b');
      await legacy(b, 'Pork belly', 'PORK-BELLY', 50);
      await legacy(b, 'Chicken wings', 'CHICKEN-WINGS', 40);
      const bCodes = await codesOf(b);
      const bCounters = () =>
        sql<{ stem: string; last_seq: number }[]>`select stem, last_seq from item_code_counters where org_id = ${b.orgId} order by stem`;
      const bCountersBefore = await bCounters();
      const bAuditBefore = (await sql<{ n: number }[]>`select count(*)::int n from audit_log where org_id = ${b.orgId}`)[0]!.n;

      await recode(a.f, a.f.superAdmin);

      expect(Object.values(await codesOf(a.f)).sort()).toEqual(['CHWN-001', 'CHWN-002', 'CK15-004', 'CK15-005', 'PRBL-001']);
      expect(await codesOf(b)).toEqual(bCodes);
      expect(await bCounters()).toEqual(bCountersBefore);
      expect((await recodeAudit(b)).length).toBe(0);
      expect((await sql<{ n: number }[]>`select count(*)::int n from audit_log where org_id = ${b.orgId}`)[0]!.n).toBe(bAuditBefore);
    },
    60_000,
  );
});

describe('C5 - the script dry run shows what apply writes', () => {
  it(
    'C5: run({apply:false}) prints the `old -> new  name (status)` lines and counts and leaves the DB unchanged; run({apply:true}) prints the same lines and writes them. Mutant: dry run commits -> the DB-unchanged legs are red',
    async () => {
      const o = await c1Org('c5');
      const { run } = await loadRun();
      const before = await codesOf(o.f);

      const dryLines: string[] = [];
      const dry = await run({ org: o.f.orgId, actor: o.f.superId, apply: false, out: (l) => dryLines.push(l) });
      expect(await codesOf(o.f)).toEqual(before);
      expect((await recodeAudit(o.f)).length).toBe(0);
      expect(await markOf(o.f, 'CHWN')).toBeNull();
      expect(dry).toMatchObject({ recoded: 4, kept: 1, skipped: 0 });
      expect(dryLines.some((l) => l.includes('PORK-BELLY -> PRBL-001') && l.includes('Pork belly') && l.includes('(active)'))).toBe(true);
      expect(dryLines.some((l) => l.includes('CHICKEN-WINGLETS -> CHWN-002') && l.includes('(merged)'))).toBe(true);
      expect(dryLines.some((l) => /recoded 4/.test(l) && /kept 1/.test(l) && /skipped 0/.test(l))).toBe(true);

      const applyLines: string[] = [];
      await run({ org: o.f.orgId, actor: o.f.superId, apply: true, out: (l) => applyLines.push(l) });
      const arrows = (ls: string[]) => ls.filter((l) => l.includes(' -> '));
      expect(arrows(dryLines).length).toBe(4);
      expect(arrows(applyLines)).toEqual(arrows(dryLines));
      expect(Object.values(await codesOf(o.f)).sort()).toEqual(['CHWN-001', 'CHWN-002', 'CK15-004', 'CK15-005', 'PRBL-001']);
    },
    60_000,
  );
});

describe('C6 - the importer allocates', () => {
  it(
    'C6: two names sharing a stem import as -001 and -002; a re-run inserts nothing and the counter is unchanged. Mutant: allocate before the name check -> the re-run consumes numbers, red',
    async () => {
      const f = await fixture('c6');
      const { insertCleanItems } = await loadImporter();
      const items = [
        { name: 'Chicken wings', kind: 'raw_material', baseUnit: 'kg' },
        { name: 'Chicken winglets', kind: 'raw_material', baseUnit: 'kg' },
      ];
      const first = await insertCleanItems({ orgId: f.orgId, items });
      expect(first).toEqual({ inserted: 2, skipped: 0 });
      expect(await codesOf(f)).toEqual({ 'Chicken wings': 'CHWN-001', 'Chicken winglets': 'CHWN-002' });
      expect(await markOf(f, 'CHWN')).toBe(2);

      const second = await insertCleanItems({ orgId: f.orgId, items });
      expect(second).toEqual({ inserted: 0, skipped: 2 });
      expect(await markOf(f, 'CHWN')).toBe(2);
      expect((await sql<{ n: number }[]>`select count(*)::int n from items where org_id = ${f.orgId}`)[0]!.n).toBe(2);
    },
    60_000,
  );
});
