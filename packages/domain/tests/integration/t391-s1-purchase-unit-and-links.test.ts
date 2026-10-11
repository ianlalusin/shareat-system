import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-391 S1 - `docs/tasks/391-production-master-data-load.md`, test 15 (+ review changes). TESTER file.
 * Real Postgres, real `authorize()`, as APP_ROLE under an org principal. Migration 0193 adds
 * items.purchase_unit / purchase_factor (3 named CHECKs) and the v1_master_links table (RLS, no UPDATE/DELETE).
 * Each test names its killing mutant and why it is red on HEAD.
 *
 * Trap: postgres.js reports a statement's FIRST error, so every refusal asserts the SPECIFIC constraint name.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, PURCHASE_UNITS, type Tx } from '@shareat/db';
import { CUTOVER_CLASSIFICATION } from '../../../db/src/cutover/classification';
import { RLS_REGISTRY } from '../../../db/src/rls/registry';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { decimal } from '@shareat/core/money';
import * as domain from '@shareat/domain';
import { changeItemBaseUnit, createItem } from '@shareat/domain';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 5 });
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
  const code = uid(`t391s1-${hint}`);
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
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  return {
    orgId, superId,
    superAdmin: actor(orgId, superId), admin: actor(orgId, adminId), manager: actor(orgId, managerId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function newItem(f: Fixture, baseUnit: 'kg' | 'pcs' | 'ltr' = 'pcs'): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: testItemCode(), name: `Item ${uid('n')}`, kind: 'raw_material', baseUnit }),
  );
  return id;
}

/** setItemPurchaseUnit is resolved at call time so a missing export is a red TypeError in THIS test only. */
type SetUnit = (tx: Tx, a: Actor, i: { itemId: string; purchaseUnit: string | null; purchaseFactor: string | null }) => Promise<unknown>;
const setUnit = (): SetUnit => (domain as unknown as { setItemPurchaseUnit: SetUnit }).setItemPurchaseUnit;

const itemRow = async (id: string) =>
  (await sql<{ purchase_unit: string | null; purchase_factor: string | null; base_unit: string }[]>`
    select purchase_unit, purchase_factor, base_unit from items where id = ${id}`)[0];
const auditRows = (itemId: string) =>
  sql<{ action: string; entity: string; before: unknown; after: unknown; actor_person_id: string }[]>`
    select action, entity, before, after, actor_person_id from audit_log
    where entity = 'items' and entity_id = ${itemId} and action = 'set_item_purchase_unit'
    order by occurred_at, id`;

/** The Postgres error's constraint name, found anywhere on the cause chain. */
function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 6; i++, e = (e as { cause?: unknown }).cause) {
    const c = (e as { constraint_name?: string }).constraint_name ?? (e as { constraint?: string }).constraint;
    if (c) return c;
  }
  return undefined;
}
function codeOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 6; i++, e = (e as { cause?: unknown }).cause) {
    const c = (e as { code?: string }).code;
    if (c) return c;
  }
  return undefined;
}
async function failure(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be refused');
}

let linkSeq = 0;
function linkRow(f: Fixture, over: Record<string, unknown> = {}) {
  return {
    org_id: f.orgId, entity: 'supplier', v1_store_id: 'S1', v1_id: `v1-${Date.now()}-${++linkSeq}`,
    v2_id: f.superId, v1_unit: null as string | null, factor_to_base: null as string | null,
    created_by: f.superId, ...over,
  } as {
    org_id: string; entity: string; v1_store_id: string; v1_id: string; v2_id: string;
    v1_unit: string | null; factor_to_base: string | null; created_by: string;
  };
}
const rawInsertLink = (r: ReturnType<typeof linkRow>) => sql`
  insert into v1_master_links (org_id, entity, v1_store_id, v1_id, v2_id, v1_unit, factor_to_base, created_by)
  values (${r.org_id}, ${r.entity}, ${r.v1_store_id}, ${r.v1_id}, ${r.v2_id},
          ${r.v1_unit}, ${r.factor_to_base}, ${r.created_by})`;

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('15 - items CHECKs (the database owns the rule)', () => {
  const upd = (id: string, unit: string | null, factor: string | null) =>
    sql`update items set purchase_unit = ${unit}, purchase_factor = ${factor} where id = ${id}`;

  it(
    'C1: a valid pair (box / 24) stores; both null stores. Control for the rest. Red today: column purchase_unit does not exist',
    async () => {
      const f = await fixture('c1');
      const id = await newItem(f, 'pcs');
      await upd(id, 'box', '24');
      expect(await itemRow(id)).toMatchObject({ purchase_unit: 'box', base_unit: 'pcs' });
      await upd(id, null, null);
      expect(await itemRow(id)).toMatchObject({ purchase_unit: null, purchase_factor: null });
    },
    30_000,
  );

  it.each([
    ['unit without factor', 'box', null],
    ['factor without unit', null, '24'],
  ] as const)(
    'C2: %s -> items_purchase_pair_check. Killing mutant: the pair CHECK dropped. Red today: no such column / constraint',
    async (_n, unit, factor) => {
      const f = await fixture('c2');
      const id = await newItem(f, 'pcs');
      expect(constraintOf(await failure(upd(id, unit, factor)))).toBe('items_purchase_pair_check');
    },
    30_000,
  );

  it(
    'C3: purchase unit equal to the base unit -> items_purchase_unit_check. Killing mutant: the `<> base_unit` leg dropped. Red today: no such column',
    async () => {
      const f = await fixture('c3');
      const id = await newItem(f, 'kg');
      expect(constraintOf(await failure(upd(id, 'kg', '1')))).toBe('items_purchase_unit_check');
    },
    30_000,
  );

  it(
    'C4: a unit outside the list -> items_purchase_unit_check. Killing mutant: the IN list dropped. Red today: no such column',
    async () => {
      const f = await fixture('c4');
      const id = await newItem(f, 'pcs');
      expect(constraintOf(await failure(upd(id, 'bucket', '5')))).toBe('items_purchase_unit_check');
    },
    30_000,
  );

  it.each(['0', '-1', '-0.5'])(
    'C5: factor %s -> items_purchase_factor_check. Killing mutant: `> 0` weakened to `>= 0`. Red today: no such column',
    async (factor) => {
      const f = await fixture('c5');
      const id = await newItem(f, 'pcs');
      expect(constraintOf(await failure(upd(id, 'box', factor)))).toBe('items_purchase_factor_check');
    },
    30_000,
  );

  it(
    "C6: factor 'Infinity' -> refused by numeric(14,6) itself (SQLSTATE 22003, before any CHECK). Killing mutant: purchase_factor widened to an unbounded numeric with no finite CHECK. Red today: no such column",
    async () => {
      const f = await fixture('c6');
      const id = await newItem(f, 'pcs');
      expect(codeOf(await failure(upd(id, 'box', 'Infinity')))).toBe('22003');
    },
    30_000,
  );

  it(
    "C7 (review): the SQL unit list equals PURCHASE_UNITS exactly (read from pg_constraint), and every member other than the base is accepted. Killing mutant: 'dozen' missing from the SQL list. Red today: no constraint to read",
    async () => {
      const [row] = await sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'items_purchase_unit_check' and conrelid = 'items'::regclass`;
      expect(row, 'items_purchase_unit_check must exist').toBeDefined();
      const listed = [...row!.def.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]!);
      expect(new Set(listed)).toEqual(new Set(PURCHASE_UNITS));
      const f = await fixture('c7');
      const id = await newItem(f, 'ltr');
      for (const u of PURCHASE_UNITS.filter((x) => x !== 'ltr')) {
        await upd(id, u, '2');
        expect((await itemRow(id))!.purchase_unit).toBe(u);
      }
    },
    60_000,
  );

  it(
    'C8 (review): the CHECKs and FKs carry their NAMES (named, not generated). Killing mutant: unnamed constraint. Red today: none exist',
    async () => {
      const names = (
        await sql<{ conname: string }[]>`
          select conname from pg_constraint
          where conrelid in ('items'::regclass, to_regclass('v1_master_links'))`
      ).map((r) => r.conname);
      for (const n of [
        'items_purchase_pair_check', 'items_purchase_unit_check', 'items_purchase_factor_check',
        'v1_master_links_entity_check', 'v1_master_links_v1_id_not_blank_check', 'v1_master_links_item_factor_check',
        'v1_master_links_org_id_organizations_id_fk', 'v1_master_links_created_by_persons_id_fk',
      ]) {
        expect(names, n).toContain(n);
      }
    },
    30_000,
  );
});

describe('15 - v1_master_links CHECKs, uniqueness, FKs', () => {
  it(
    'L1: an item link needs v1_unit AND a positive finite factor; zero / negative / missing unit / missing factor are refused by v1_master_links_item_factor_check. Killing mutant: the factor leg dropped. Red today: table missing',
    async () => {
      const f = await fixture('l1');
      await rawInsertLink(linkRow(f, { entity: 'item', v1_unit: 'box', factor_to_base: '24' }));
      for (const bad of [
        { entity: 'item', v1_unit: 'box', factor_to_base: '0' },
        { entity: 'item', v1_unit: 'box', factor_to_base: '-3' },
        { entity: 'item', v1_unit: 'box', factor_to_base: null }, // NULL > 0 is NULL: the CHECK must say IS NOT NULL
        { entity: 'item', v1_unit: null, factor_to_base: '2' },
      ]) {
        expect(constraintOf(await failure(rawInsertLink(linkRow(f, bad)))), JSON.stringify(bad)).toBe(
          'v1_master_links_item_factor_check',
        );
      }
    },
    30_000,
  );

  it(
    'L2: a non-item link must carry NO factor and NO unit. Killing mutant: the `<> item` leg dropped. Red today: table missing',
    async () => {
      const f = await fixture('l2');
      expect(
        constraintOf(await failure(rawInsertLink(linkRow(f, { entity: 'supplier', v1_unit: 'box', factor_to_base: '2' })))),
      ).toBe('v1_master_links_item_factor_check');
      expect(
        constraintOf(await failure(rawInsertLink(linkRow(f, { entity: 'person', v1_unit: null, factor_to_base: '2' })))),
      ).toBe('v1_master_links_item_factor_check');
    },
    30_000,
  );

  it(
    'L3: entity outside the list and a blank v1_id are refused by name; the six real entities pass. Killing mutant: either CHECK dropped. Red today: table missing',
    async () => {
      const f = await fixture('l3');
      expect(constraintOf(await failure(rawInsertLink(linkRow(f, { entity: 'invoice' }))))).toBe('v1_master_links_entity_check');
      expect(constraintOf(await failure(rawInsertLink(linkRow(f, { v1_id: '   ' }))))).toBe(
        'v1_master_links_v1_id_not_blank_check',
      );
      for (const e of ['supplier', 'customer', 'person', 'employment', 'position']) {
        await rawInsertLink(linkRow(f, { entity: e }));
      }
    },
    30_000,
  );

  it(
    'L4: (org, entity, v1_store_id, v1_id) is unique (v1_master_links_key); the same v1_id at another store or entity is allowed; v1_store_id "" is allowed. Killing mutant: v1_store_id left out of the key; unique index dropped. Red today: table missing',
    async () => {
      const f = await fixture('l4');
      const r = linkRow(f, { v1_id: 'dup-1' });
      await rawInsertLink(r);
      expect(constraintOf(await failure(rawInsertLink(r)))).toBe('v1_master_links_key');
      await rawInsertLink({ ...r, v1_store_id: 'S2' });
      await rawInsertLink({ ...r, entity: 'customer' });
      await rawInsertLink({ ...r, v1_store_id: '' });
    },
    30_000,
  );

  it(
    'L5: org_id and created_by must reference real rows (named FKs). Killing mutant: FK omitted. Red today: table missing',
    async () => {
      const f = await fixture('l5');
      const ghost = '00000000-0000-7000-8000-000000000001';
      expect(constraintOf(await failure(rawInsertLink(linkRow(f, { org_id: ghost }))))).toBe(
        'v1_master_links_org_id_organizations_id_fk',
      );
      expect(constraintOf(await failure(rawInsertLink(linkRow(f, { created_by: ghost }))))).toBe(
        'v1_master_links_created_by_persons_id_fk',
      );
    },
    30_000,
  );
});

describe('15 - v1_master_links RLS and grants', () => {
  it(
    "R1: org B cannot SEE org A's links; org A sees its own. Killing mutant: policy USING true / RLS not enabled. Red today: relation does not exist",
    async () => {
      const a = await fixture('r1a');
      const b = await fixture('r1b');
      const r = linkRow(a, { v1_id: uid('r1') });
      await rawInsertLink(r);
      const seenByA = await asOrg(a.orgId, (tx) => tx.execute(dsql`select v1_id from v1_master_links where v1_id = ${r.v1_id}`));
      const seenByB = await asOrg(b.orgId, (tx) => tx.execute(dsql`select v1_id from v1_master_links where v1_id = ${r.v1_id}`));
      expect([...seenByA]).toHaveLength(1);
      expect([...seenByB]).toHaveLength(0);
    },
    30_000,
  );

  it(
    "R2: org B cannot INSERT a link for org A (WITH CHECK, 42501); org B CAN insert its own. Killing mutant: policy without WITH CHECK. Red today: relation does not exist",
    async () => {
      const a = await fixture('r2a');
      const b = await fixture('r2b');
      const ins = (tx: Tx, orgId: string) =>
        tx.execute(dsql`insert into v1_master_links (org_id, entity, v1_store_id, v1_id, v2_id, created_by)
          values (${orgId}, 'supplier', 'S1', ${uid('r2')}, ${b.superId}, ${b.superId})`);
      const err = await failure(asOrg(b.orgId, (tx) => ins(tx, a.orgId)));
      expect(codeOf(err)).toBe('42501');
      await asOrg(b.orgId, (tx) => ins(tx, b.orgId));
    },
    30_000,
  );

  it(
    'R3: RLS is ENABLED and FORCED on v1_master_links. Killing mutant: FORCE omitted. Red today: relation does not exist',
    async () => {
      const [r] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity from pg_class where oid = to_regclass('v1_master_links')`;
      expect(r).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    },
    30_000,
  );

  it(
    'R4: the app role has SELECT and INSERT but NO UPDATE and NO DELETE (a link is a fact). Killing mutant: GRANT UPDATE / DELETE. Red today: relation does not exist',
    async () => {
      const [g] = await sql<{ s: boolean; i: boolean; u: boolean; d: boolean }[]>`
        select has_table_privilege(${APP_ROLE}, 'v1_master_links', 'SELECT') as s,
               has_table_privilege(${APP_ROLE}, 'v1_master_links', 'INSERT') as i,
               has_table_privilege(${APP_ROLE}, 'v1_master_links', 'UPDATE') as u,
               has_table_privilege(${APP_ROLE}, 'v1_master_links', 'DELETE') as d`;
      expect(g).toEqual({ s: true, i: true, u: false, d: false });
    },
    30_000,
  );

  it('R5 (review): classified `keep` for cutover and registered in the RLS registry by org_column. Killing mutant: classified purge / missing. Red today: no entry', () => {
    expect(CUTOVER_CLASSIFICATION['v1_master_links'], 'v1_master_links must be classified').toBeDefined();
    expect(CUTOVER_CLASSIFICATION['v1_master_links']!.class).toBe('keep');
    expect(RLS_REGISTRY['v1_master_links']).toMatchObject({ scope: 'org_column' });
  });
});

describe('15 - setItemPurchaseUnit', () => {
  it(
    'S1: super-admin sets box/24 -> pair stored, exactly one set_item_purchase_unit audit row with before/after. Killing mutants: audit append dropped; before and after swapped. Red today: setItemPurchaseUnit is not exported (TypeError)',
    async () => {
      const f = await fixture('s1');
      const id = await newItem(f, 'pcs');
      await asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, purchaseUnit: 'box', purchaseFactor: '24' }));
      const r = (await itemRow(id))!;
      expect(r.purchase_unit).toBe('box');
      expect(Number(r.purchase_factor)).toBe(24);
      const rows = await auditRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'set_item_purchase_unit', entity: 'items', actor_person_id: f.superAdmin.personId,
        before: { purchaseUnit: null, purchaseFactor: null },
        after: { purchaseUnit: 'box' },
      });
    },
    30_000,
  );

  it.each(['admin', 'manager'] as const)(
    'S2: %s (no approve_item) -> AuthorizationError, pair unchanged, no audit row (the X fires). Killing mutant: authorize call removed or a weaker capability. Red today: TypeError, not AuthorizationError',
    async (who) => {
      const f = await fixture(`s2${who}`);
      const id = await newItem(f, 'pcs');
      const err = await failure(
        asOrg(f.orgId, (tx) => setUnit()(tx, f[who], { itemId: id, purchaseUnit: 'box', purchaseFactor: '24' })),
      );
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((await itemRow(id))!.purchase_unit).toBeNull();
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'S3: clearing (both null) writes null/null and one more audit row; clearing an already-clear item writes none. Killing mutants: clear ignored; unconditional append. Red today: TypeError',
    async () => {
      const f = await fixture('s3');
      const id = await newItem(f, 'pcs');
      await asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, purchaseUnit: 'box', purchaseFactor: '12' }));
      await asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, purchaseUnit: null, purchaseFactor: null }));
      expect(await itemRow(id)).toMatchObject({ purchase_unit: null, purchase_factor: null });
      const rows = await auditRows(id);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ before: { purchaseUnit: 'box' }, after: { purchaseUnit: null } });
      await asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, purchaseUnit: null, purchaseFactor: null }));
      expect(await auditRows(id)).toHaveLength(2);
    },
    30_000,
  );

  it.each([
    ['unit equal to base', { purchaseUnit: 'kg', purchaseFactor: '1' }, 'items_purchase_unit_check'],
    ['factor 0', { purchaseUnit: 'box', purchaseFactor: '0' }, 'items_purchase_factor_check'],
    ['negative factor', { purchaseUnit: 'box', purchaseFactor: '-2' }, 'items_purchase_factor_check'],
    ['unit without factor', { purchaseUnit: 'box', purchaseFactor: null }, 'items_purchase_pair_check'],
    ['factor without unit', { purchaseUnit: null, purchaseFactor: '3' }, 'items_purchase_pair_check'],
  ] as const)(
    'S4: %s -> refused by the DB CHECK (not re-implemented in TypeScript), pair unchanged, no audit row. Killing mutant: audit appended before a refused UPDATE without rollback. Red today: TypeError, no constraint',
    async (_n, input, constraint) => {
      const f = await fixture('s4');
      const id = await newItem(f, 'kg');
      const err = await failure(asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, ...input })));
      expect(constraintOf(err)).toBe(constraint);
      expect((await itemRow(id))!.purchase_unit).toBeNull();
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    "S5: another org's item is not found (tenancy), pair untouched. Killing mutant: repo update without the org filter. Red today: TypeError",
    async () => {
      const a = await fixture('s5a');
      const b = await fixture('s5b');
      const id = await newItem(a, 'pcs');
      await failure(asOrg(b.orgId, (tx) => setUnit()(tx, b.superAdmin, { itemId: id, purchaseUnit: 'box', purchaseFactor: '2' })));
      expect((await itemRow(id))!.purchase_unit).toBeNull();
    },
    30_000,
  );

  it(
    'S6: createItem does NOT take the pair - a pair passed to it is not stored. Killing mutant: createItem passes purchaseUnit through. Red today: column purchase_unit does not exist',
    async () => {
      const f = await fixture('s6');
      const { id } = await asOrg(f.orgId, (tx) =>
        createItem(tx, f.superAdmin, {
          code: testItemCode(), name: `Item ${uid('n')}`, kind: 'raw_material', baseUnit: 'pcs',
          purchaseUnit: 'box', purchaseFactor: '24',
        } as never),
      );
      expect((await itemRow(id))!.purchase_unit ?? null).toBeNull();
    },
    30_000,
  );
});

describe('15 - setItemPurchaseUnit audit legs', () => {
  const plain = (err: unknown) => {
    const e = err as { name?: string; userMessage?: string; message?: string };
    expect(e.name, `a raw driver error reached the caller: ${e.message}`).toBe('RefusalError');
    expect(e.userMessage ?? '').not.toMatch(/22P02|22003|numeric|invalid input|out of range|SQLSTATE/i);
    expect((e.userMessage ?? '').length).toBeGreaterThan(10);
  };

  it.each(['abc', '100000000'])(
    'A1: factor %s -> a plain-words RefusalError (no raw 22P02 / 22003), nothing written, no audit row. Killing mutant: the raw string passed straight to the UPDATE. Red today: raw Postgres error',
    async (factor) => {
      const f = await fixture('a1');
      const id = await newItem(f, 'pcs');
      const err = await failure(asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, purchaseUnit: 'box', purchaseFactor: factor })));
      plain(err);
      expect((await itemRow(id))!.purchase_unit).toBeNull();
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it.each([
    ['24.0000004 (rounds to the stored 24.000000)', '24.0000004'],
    ['24 (same number, written differently)', '24'],
    ['24.000000', '24.000000'],
  ])(
    'A1b: re-setting the same factor as %s is a no-op: {changed:false}, still one audit row. Killing mutant: comparing the raw input string with the stored one. Red today: TypeError / extra audit row',
    async (_n, again) => {
      const f = await fixture('a1b');
      const id = await newItem(f, 'pcs');
      await asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, purchaseUnit: 'box', purchaseFactor: '24' }));
      const res = await asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, purchaseUnit: 'box', purchaseFactor: again }));
      expect(res).toEqual({ changed: false });
      expect(await auditRows(id)).toHaveLength(1);
    },
    30_000,
  );

  it(
    "A2: the audit row's `after` holds the stored normalised form ('24.000000', scale 6), the same form `before` uses on the next change. Killing mutant: after = the raw input '24'. Red today: after.purchaseFactor is '24'",
    async () => {
      const f = await fixture('a2');
      const id = await newItem(f, 'pcs');
      await asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, purchaseUnit: 'box', purchaseFactor: '24' }));
      await asOrg(f.orgId, (tx) => setUnit()(tx, f.superAdmin, { itemId: id, purchaseUnit: 'box', purchaseFactor: '12.5' }));
      const rows = await auditRows(id);
      expect(rows).toHaveLength(2);
      expect((rows[0]!.after as { purchaseFactor: string }).purchaseFactor).toBe('24.000000');
      expect((rows[1]!.before as { purchaseFactor: string }).purchaseFactor).toBe('24.000000');
      expect((rows[1]!.after as { purchaseFactor: string }).purchaseFactor).toBe('12.500000');
    },
    30_000,
  );

  it.each([
    ['purchaseUnit', { purchaseUnit: 'box' }],
    ['purchaseFactor', { purchaseFactor: '24' }],
    ['both', { purchaseUnit: 'box', purchaseFactor: '24' }],
  ])(
    'A3: updateItem (manage_items) given %s is refused with a sentence pointing to the buying-unit action; nothing written. Killing mutant: updateItem passes the pair through. Red today: the pair is written',
    async (_n, values) => {
      const f = await fixture('a3');
      const id = await newItem(f, 'pcs');
      const err = await failure(asOrg(f.orgId, (tx) => domain.updateItem(tx, f.manager, id, values as never)));
      plain(err);
      expect((err as { userMessage: string }).userMessage).toMatch(/buying unit/i);
      expect((await itemRow(id))!.purchase_unit).toBeNull();
    },
    30_000,
  );
});

describe('15 - changeItemBaseUnit refuses while a purchase unit is set', () => {
  it(
    'B1: purchase unit set -> changeItemBaseUnit refused with "Clear the buying unit first", base unit unchanged, no change audit row; after clearing it succeeds. Killing mutant: refusal removed. Red today: setup UPDATE fails (no column)',
    async () => {
      const f = await fixture('b1');
      const id = await newItem(f, 'pcs');
      await sql`update items set purchase_unit = 'box', purchase_factor = 24 where id = ${id}`;
      const err = await failure(asOrg(f.orgId, (tx) => changeItemBaseUnit(tx, f.superAdmin, { itemId: id, baseUnit: 'kg' })));
      expect(String((err as Error).message)).toContain('Clear the buying unit first');
      expect((await itemRow(id))!.base_unit).toBe('pcs');
      expect(
        await sql`select 1 from audit_log where entity = 'items' and entity_id = ${id} and action = 'change_item_base_unit'`,
      ).toHaveLength(0);
      await sql`update items set purchase_unit = null, purchase_factor = null where id = ${id}`;
      expect(await asOrg(f.orgId, (tx) => changeItemBaseUnit(tx, f.superAdmin, { itemId: id, baseUnit: 'kg' }))).toEqual({
        changed: true,
      });
    },
    30_000,
  );

  it(
    'B2: an unchanged base unit with a purchase unit set stays {changed:false} (no refusal for a no-op). Killing mutant: refusal placed before the equality check. Red today: setup UPDATE fails (no column)',
    async () => {
      const f = await fixture('b2');
      const id = await newItem(f, 'pcs');
      await sql`update items set purchase_unit = 'box', purchase_factor = 24 where id = ${id}`;
      expect(await asOrg(f.orgId, (tx) => changeItemBaseUnit(tx, f.superAdmin, { itemId: id, baseUnit: 'pcs' }))).toEqual({
        changed: false,
      });
    },
    30_000,
  );
});

describe('15 - master-links repo (linksFor / insertLink) and I4', () => {
  it(
    'M1: insertLink writes under the org principal and linksFor(orgId, entity) returns only that org+entity, each item link resolving to a real item of the same org (I4). Killing mutants: linksFor without the entity filter; without the org filter. Red today: module repo/master-links does not exist',
    async () => {
      const a = await fixture('m1a');
      const b = await fixture('m1b');
      const itemId = await newItem(a, 'pcs');
      const repo = await import('../../../db/src/repo/master-links');
      const v1Id = uid('m1');
      await asOrg(a.orgId, (tx) =>
        repo.insertLink(tx, {
          orgId: a.orgId, entity: 'item', v1StoreId: 'S1', v1Id, v2Id: itemId, v1Unit: 'box', factorToBase: decimal('24', '14,6'), createdBy: a.superId,
        }),
      );
      await asOrg(a.orgId, (tx) =>
        repo.insertLink(tx, {
          orgId: a.orgId, entity: 'supplier', v1StoreId: 'S1', v1Id, v2Id: a.superId, v1Unit: null, factorToBase: null, createdBy: a.superId,
        }),
      );
      const items = await asOrg(a.orgId, (tx) => repo.linksFor(tx, a.orgId, 'item'));
      expect(items.map((l: { v1Id: string }) => l.v1Id)).toEqual([v1Id]);
      expect(await asOrg(b.orgId, (tx) => repo.linksFor(tx, b.orgId, 'item'))).toHaveLength(0);
      const orphans = await sql`
        select l.id from v1_master_links l left join items i on i.id = l.v2_id and i.org_id = l.org_id
        where l.org_id = ${a.orgId} and l.entity = 'item' and i.id is null`;
      expect(orphans).toHaveLength(0);
    },
    30_000,
  );
});
