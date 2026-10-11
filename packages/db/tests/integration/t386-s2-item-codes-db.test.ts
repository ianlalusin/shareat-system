import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-386 S2 - `docs/tasks/386-item-code-auto-suggest.md` S2 / R3 / R4, tests D1-D9 (D10, the sentence, lives in
 * `apps/erp/tests/integration/constraint-message-lookup.test.ts`: it needs the app's lookup table, which a db-package test must not
 * import). TESTER file. Real Postgres, as the app role under an org principal unless a test says "owner".
 *
 * Migration 0189 (a) turns `items_org_code_key` into UNIQUE (org_id, upper(code)); (b) creates `item_code_counters`
 * (org_id, stem, last_seq): the highest number ever issued per 4-character stem; (c) adds the trigger `items_code_never_reused`
 * (BEFORE INSERT OR UPDATE OF code ON items, only for a code of the shape CHWN-001): the new number must be ABOVE the stem's
 * mark, and the mark rises to it; (d) the ENABLE ALWAYS trigger `item_code_counters_forward_only`; (e) RLS on the counters.
 *
 * ## State at HEAD (red first)
 * Migration 0189 does not exist: no table, no trigger, a case-sensitive index. Every test below that touches the new table or the
 * new rule fails; the CONTROL legs (named "control") pin what must NOT change and pass today: legacy free-form codes still insert
 * and update (D5), an exact duplicate code still 23505s (D1 control), a non-code update of a shaped item still works (D4).
 *
 * ## Mutants (spec; each named on the leg it turns red)
 * index on `code` not `upper(code)` -> D1. `>=` instead of `>` in the trigger -> D2 second leg. Drop the mark update -> D2 third/fourth
 * legs. Drop the unchanged-code early return -> D4. Trigger without the shape WHEN -> D5. A bypass branch for the owner -> D6 owner leg.
 *
 * ## Fixtures
 * Every test makes its own org and COMMITS (separate transactions: a refused statement aborts its transaction, and the point of D2/D3
 * is the state left by the earlier committed ones). Each statement that is expected to be refused runs in its own transaction.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, RLS_REGISTRY } from '../../src/rls/registry';
import { TRIGGER_REGISTRY } from '../../src/triggers/registry';
import { CUTOVER_CLASSIFICATION } from '../../src/cutover/classification';
import { closeDb } from '@shareat/db';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Tx = postgres.TransactionSql;
type PgErr = { code?: string; constraint_name?: string; message?: string } | null;

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** Runs `fn` as the app role under `orgId` (or as the owner when `owner`); COMMITS on success; returns the error (rolled back) or null. */
async function run(orgId: string, fn: (t: Tx) => Promise<unknown>, o: { owner?: boolean } = {}): Promise<PgErr> {
  try {
    await sql.begin(async (t) => {
      if (!o.owner) {
        await t.unsafe(`set local role ${APP_ROLE}`);
        await t`select set_config('app.principal_kind', 'staff', true)`;
        await t`select set_config('app.org_id', ${orgId}, true)`;
      }
      await fn(t);
    });
    return null;
  } catch (e) {
    return e as PgErr;
  }
}

async function mkOrg(hint: string) {
  const code = uid(`t386s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Person') returning id`;
  return { orgId: org!.id, personId: p!.id };
}
type Org = Awaited<ReturnType<typeof mkOrg>>;

let n = 0;
/** One INSERT into items as the app role; the name is unique per call so only the CODE can clash. */
const insertItem = (o: Org, code: string) =>
  run(o.orgId, (t) =>
    t`insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${o.orgId}, ${code}, ${`Item ${++n} ${uid('n')}`}, 'raw_material', 'kg', ${o.personId})`,
  );
const insertedId = async (o: Org, code: string): Promise<string> => {
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${o.orgId}, ${code}, ${`Item ${++n} ${uid('n')}`}, 'raw_material', 'kg', ${o.personId}) returning id`;
  return r!.id;
};
const itemId = async (o: Org, code: string): Promise<string> => {
  const err = await insertItem(o, code);
  expect(err, `fixture insert of ${code}`).toBeNull();
  const [r] = await sql<{ id: string }[]>`select id from items where org_id = ${o.orgId} and code = ${code}`;
  return r!.id;
};
const mark = async (o: Org, stem: string): Promise<number | null> => {
  const rows = await sql<{ last_seq: number }[]>`select last_seq from item_code_counters where org_id = ${o.orgId} and stem = ${stem}`;
  return rows.length ? rows[0]!.last_seq : null;
};
const counterRows = async (o: Org): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from item_code_counters where org_id = ${o.orgId}`)[0]!.n;

function expectRefused(err: PgErr, what: string, code: string, constraint: string) {
  expect(err, `${what}: expected the statement to be refused, but it succeeded`).not.toBeNull();
  expect({ what, code: err!.code, constraint: err!.constraint_name }).toEqual({ what, code, constraint });
}
const NEVER_REUSED = 'items_code_never_reused';
const FORWARD_ONLY = 'item_code_counters_forward_only';

describe('T-386 S2 - D1: the code is unique ignoring case (S6: the lower-case twin is now refused by the shape CHECK first)', () => {
  it('D1 (S6, converted): a lower-case twin abcd-123 of an existing ABCD-123 is refused - by items_code_shape_check (23514), before the case-insensitive unique index can speak. Replaces the 23505 case-twin leg, whose "legacy" fixture can no longer exist. Mutant: lower-case allowed in the CHECK -> the refusal moves to the never-reused trigger / index, red. Red before S6: the 23514 comes from items_code_never_reused or the insert succeeds', async () => {
    const o = await mkOrg('d1');
    expect(await insertItem(o, 'ABCD-123'), 'the shaped code is a fixture').toBeNull();
    expectRefused(await insertItem(o, 'abcd-123'), 'case twin', '23514', 'items_code_shape_check');
  });

  it('D1b: the index is on (org_id, upper(code)) under the SAME name, and the same shaped code in ANOTHER org is fine (its own mark). Red today: the index definition has no upper()', async () => {
    const [def] = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'items' and indexname = 'items_org_code_key'`;
    expect(def?.indexdef ?? '(index missing)').toMatch(/UNIQUE INDEX items_org_code_key ON public\.items USING btree \(org_id, upper\(code\)\)/);
    const a = await mkOrg('d1ba');
    const b = await mkOrg('d1bb');
    expect(await insertItem(a, 'ABCD-123')).toBeNull();
    expect(await insertItem(b, 'ABCD-123'), 'a different org may use the same code').toBeNull();
  });
});

describe('T-386 S2 - D2: a number once given out under a stem is never given out again', () => {
  it('D2: CHWN-001 -> counter (org, CHWN, 1); CHWN-001 again -> 23514 items_code_never_reused; CHWN-003 -> ok, mark 3; CHWN-002 -> refused (a gap below the mark is never filled). Mutants: >= instead of > -> second leg red; drop the mark update -> third/fourth legs red. Red today: no counter table, no trigger', async () => {
    const o = await mkOrg('d2');
    expect(await insertItem(o, 'CHWN-001')).toBeNull();
    expect(await mark(o, 'CHWN'), 'the trigger creates the counter row at the first shaped code').toBe(1);
    expectRefused(await insertItem(o, 'CHWN-001'), 'same number twice', '23514', NEVER_REUSED);
    expect(await insertItem(o, 'CHWN-003')).toBeNull();
    expect(await mark(o, 'CHWN')).toBe(3);
    expectRefused(await insertItem(o, 'CHWN-002'), 'a gap below the mark', '23514', NEVER_REUSED);
    expect(await mark(o, 'CHWN'), 'a refusal leaves the mark alone').toBe(3);
    expect(await insertItem(o, 'CHWN-004')).toBeNull();
    expect(await mark(o, 'CHWN')).toBe(4);
  });

  it('D2b: the mark is per stem and per org: CHWT-001 is free after CHWN-003; another org may use CHWN-001. Mutant: one counter for all stems -> red. Red today: no counter table', async () => {
    const o = await mkOrg('d2b');
    const other = await mkOrg('d2bo');
    expect(await insertItem(o, 'CHWN-003')).toBeNull();
    expect(await insertItem(o, 'CHWT-001'), 'a different stem starts at its own mark').toBeNull();
    expect(await mark(o, 'CHWT')).toBe(1);
    expect(await insertItem(other, 'CHWN-001'), 'another org has its own mark').toBeNull();
    expect(await mark(other, 'CHWN')).toBe(1);
    expect(await mark(o, 'CHWN')).toBe(3);
  });

  it('D2c: number 000 is never issued (a fresh stem has mark 0, and 000 is not above it), 999 is the last. Mutant: >= -> 000 allowed. Red today: no trigger', async () => {
    const o = await mkOrg('d2c');
    expectRefused(await insertItem(o, 'ABCD-000'), 'number 000', '23514', NEVER_REUSED);
    expect(await mark(o, 'ABCD'), 'a refused first insert leaves no counter row behind').toBeNull();
    expect(await insertItem(o, 'ABCD-999')).toBeNull();
    expect(await mark(o, 'ABCD')).toBe(999);
    expectRefused(await insertItem(o, 'ABCD-999'), 'nothing is above 999', '23514', NEVER_REUSED);
  });

  it('D2d (S6: the case twin is now refused by items_code_shape_check): a lower-case code is not "of the shape" - the domain upper-cases before it writes; the database only guards the upper-case form, and the unique index still stops a case twin of an issued code. Red today: the case twin is accepted', async () => {
    const o = await mkOrg('d2d');
    expect(await insertItem(o, 'CHWN-001')).toBeNull();
    expectRefused(await insertItem(o, 'chwn-001'), 'lower-case twin of an issued code', '23514', 'items_code_shape_check');
  });

  it('D2e: a failed statement inside a transaction does not consume a number: insert CHWN-005 then fail the transaction -> mark and items unchanged. Red today: no counter table', async () => {
    const o = await mkOrg('d2e');
    const err = await run(o.orgId, async (t) => {
      await t`insert into items (org_id, code, name, kind, base_unit, created_by) values (${o.orgId}, 'CHWN-005', ${uid('n')}, 'raw_material', 'kg', ${o.personId})`;
      throw new Error('rolled back on purpose');
    });
    expect(err?.message).toBe('rolled back on purpose');
    expect(await mark(o, 'CHWN'), 'no counter row survives a rolled-back transaction').toBeNull();
    expect(await insertItem(o, 'CHWN-001'), 'so 001 is still free').toBeNull();
  });
});

describe('T-386 S2 - D3: a number freed by a code change is not reusable', () => {
  it('D3: CHWN-001 renamed away to CHWT-001 -> ok; a NEW item CHWN-001 -> refused; putting the old code BACK on any item -> refused. Red today: no trigger, the freed number is reused', async () => {
    const o = await mkOrg('d3');
    const id = await itemId(o, 'CHWN-001');
    expect(await run(o.orgId, (t) => t`update items set code = 'CHWT-001' where id = ${id}`)).toBeNull();
    expect(await mark(o, 'CHWT')).toBe(1);
    expect(await mark(o, 'CHWN'), 'the old stem keeps its mark').toBe(1);
    expectRefused(await insertItem(o, 'CHWN-001'), 'new item on the freed number', '23514', NEVER_REUSED);
    expectRefused(await run(o.orgId, (t) => t`update items set code = 'CHWN-001' where id = ${id}`), 'recode back to the old number', '23514', NEVER_REUSED);
    expect(await insertItem(o, 'CHWN-002'), 'the next number under the old stem is free').toBeNull();
  });

  it('D3b: retired and merged items keep their number reserved: neither a retired CHWN-001 nor a merged CHWN-002 can be issued again. Red today: no trigger', async () => {
    const o = await mkOrg('d3b');
    const retired = await itemId(o, 'CHWN-001');
    const merged = await itemId(o, 'CHWN-002');
    const target = await itemId(o, 'CHWN-003');
    await sql`update items set status = 'inactive' where id = ${retired}`;
    await sql`update items set status = 'merged', merged_into_id = ${target} where id = ${merged}`;
    expectRefused(await insertItem(o, 'CHWN-001'), 'retired item\'s number', '23514', NEVER_REUSED);
    expectRefused(await insertItem(o, 'CHWN-002'), 'merged item\'s number', '23514', NEVER_REUSED);
  });

  it('D3c: moving an item to a HIGHER number under the same stem is allowed and raises the mark: CHWN-001 -> CHWN-009 -> mark 9; CHWN-005 is then refused. Red today: no counter table', async () => {
    const o = await mkOrg('d3c');
    const id = await itemId(o, 'CHWN-001');
    expect(await run(o.orgId, (t) => t`update items set code = 'CHWN-009' where id = ${id}`)).toBeNull();
    expect(await mark(o, 'CHWN')).toBe(9);
    expectRefused(await insertItem(o, 'CHWN-005'), 'below the raised mark', '23514', NEVER_REUSED);
  });

  it('D3d: the guard also holds for the OWNER connection (no role filter, no bypass). Mutant: a bypass branch for the owner -> red. Red today: no trigger', async () => {
    const o = await mkOrg('d3d');
    expect(await insertItem(o, 'CHWN-004')).toBeNull();
    const err = await run(
      o.orgId,
      (t) => t`insert into items (org_id, code, name, kind, base_unit, created_by) values (${o.orgId}, 'CHWN-002', ${uid('n')}, 'raw_material', 'kg', ${o.personId})`,
      { owner: true },
    );
    expectRefused(err, 'owner re-issue', '23514', NEVER_REUSED);
  });
});

describe('T-386 S2 - D4: an update that does not change the code is not this trigger\'s business', () => {
  it('D4: updating name and status of a shaped item, and `set code = code`, is ok and leaves the mark alone. Mutant: drop the unchanged-code early return -> the `set code = code` leg is red (its own number is not above the mark). Red today: control for the name/status legs; the counter read is absent', async () => {
    const o = await mkOrg('d4');
    const id = await itemId(o, 'CHWN-007');
    expect(await mark(o, 'CHWN')).toBe(7);
    expect(await run(o.orgId, (t) => t`update items set name = ${uid('renamed')} where id = ${id}`), 'name only').toBeNull();
    expect(await run(o.orgId, (t) => t`update items set status = 'inactive' where id = ${id}`), 'status only').toBeNull();
    expect(await run(o.orgId, (t) => t`update items set code = code, kind = 'supply' where id = ${id}`), 'code re-assigned to itself').toBeNull();
    expect(await run(o.orgId, (t) => t`update items set code = 'CHWN-007' where id = ${id}`), 'same literal code').toBeNull();
    expect(await mark(o, 'CHWN')).toBe(7);
  });
});

describe('T-386 S2 - D5 (S6, converted): codes not of the shape are refused by items_code_shape_check', () => {
  it('D5 (S6, converted): PORK-BELLY, pork-2, CHW-001, CHWN-0001, CHWN-0 each refused on insert; an update of a shaped item to PORK-BELLY-2 is refused; no counter row is created by any of them. Replaces "legacy codes pass untouched until S6". Red before S6: they all succeed', async () => {
    const o = await mkOrg('d5');
    const id = await itemId(o, 'ABCD-001');
    for (const bad of ['PORK-BELLY', 'pork-2', 'CHW-001', 'CHWN-0001', 'CHWN-0']) {
      expectRefused(await insertItem(o, bad), bad, '23514', 'items_code_shape_check');
    }
    expectRefused(await run(o.orgId, (t) => t`update items set code = 'PORK-BELLY-2' where id = ${id}`), 'update to a legacy shape', '23514', 'items_code_shape_check');
    expect(await mark(o, 'ABCD'), 'only the one shaped insert raised a mark').toBe(1);
    expect(await counterRows(o)).toBe(1);
  });
});

describe('T-386 S2 - D6: the mark only rises', () => {
  async function org7() {
    const o = await mkOrg('d6');
    expect(await insertItem(o, 'CHWN-007')).toBeNull();
    return o;
  }

  it('D6: as the app role, lowering the mark (to 0, to 6), changing the stem, or changing the org -> 23514 item_code_counters_forward_only; raising it is allowed; DELETE -> 42501. Red today: no table', async () => {
    const o = await org7();
    const other = await mkOrg('d6o');
    expectRefused(await run(o.orgId, (t) => t`update item_code_counters set last_seq = 0 where org_id = ${o.orgId} and stem = 'CHWN'`), 'lower to 0', '23514', FORWARD_ONLY);
    expectRefused(await run(o.orgId, (t) => t`update item_code_counters set last_seq = 6 where org_id = ${o.orgId} and stem = 'CHWN'`), 'lower to 6', '23514', FORWARD_ONLY);
    expectRefused(await run(o.orgId, (t) => t`update item_code_counters set stem = 'ZZZZ' where org_id = ${o.orgId} and stem = 'CHWN'`), 'change the stem', '23514', FORWARD_ONLY);
    expectRefused(await run(o.orgId, (t) => t`update item_code_counters set org_id = ${other.orgId} where org_id = ${o.orgId} and stem = 'CHWN'`), 'change the org', '23514', FORWARD_ONLY);
    expect(await mark(o, 'CHWN')).toBe(7);
    expect(await run(o.orgId, (t) => t`update item_code_counters set last_seq = 8 where org_id = ${o.orgId} and stem = 'CHWN'`), 'raising is the only move').toBeNull();
    expect(await mark(o, 'CHWN')).toBe(8);
    const del = await run(o.orgId, (t) => t`delete from item_code_counters where org_id = ${o.orgId} and stem = 'CHWN'`);
    expect(del, 'no DELETE grant: the statement must be refused').not.toBeNull();
    expect(del!.code).toBe('42501');
    expect(await mark(o, 'CHWN')).toBe(8);
  });

  it('D6 (owner): the same lowering as the owner/superuser is STILL refused (ENABLE ALWAYS: it fires under session_replication_role = replica too). Mutant: ENABLE ALWAYS dropped -> the replica leg is red. Red today: no table', async () => {
    const o = await org7();
    expectRefused(
      await run(o.orgId, (t) => t`update item_code_counters set last_seq = 0 where org_id = ${o.orgId} and stem = 'CHWN'`, { owner: true }),
      'owner lowers the mark', '23514', FORWARD_ONLY,
    );
    const replica = await run(
      o.orgId,
      async (t) => {
        await t.unsafe(`set local session_replication_role = replica`);
        await t`update item_code_counters set last_seq = 0 where org_id = ${o.orgId} and stem = 'CHWN'`;
      },
      { owner: true },
    );
    // A non-superuser test role cannot set session_replication_role at all (42501); that is a refusal too, but not the one under test.
    if (replica?.code !== '42501') expectRefused(replica, 'owner lowers the mark in replica mode', '23514', FORWARD_ONLY);
    expect(await mark(o, 'CHWN')).toBe(7);
  });

  it('D6b: the table\'s own CHECKs: a stem that is not 4 of A-Z0-9, a negative or over-999 mark, and an org that does not exist are refused. Red today: no table', async () => {
    const o = await mkOrg('d6b');
    const ins = (stem: string, last: number, org = o.orgId) =>
      run(o.orgId, (t) => t`insert into item_code_counters (org_id, stem, last_seq) values (${org}, ${stem}, ${last})`, { owner: true });
    expect((await ins('abcd', 1))?.code, 'lower-case stem').toBe('23514');
    expect((await ins('ABC', 1))?.code, 'three characters').toBe('23514');
    expect((await ins('ABCDE', 1))?.code, 'five characters').toBe('23514');
    expect((await ins('AB-D', 1))?.code, 'a dash in the stem').toBe('23514');
    expect((await ins('ABCD', -1))?.code, 'negative mark').toBe('23514');
    expect((await ins('ABCD', 1000))?.code, 'mark over 999').toBe('23514');
    expect((await ins('ABCD', 1, '00000000-0000-4000-8000-000000000000'))?.code, 'org that does not exist').toBe('23503');
    expect(await ins('ABCD', 0), 'the lowest valid row').toBeNull();
    expect((await ins('ABCD', 5))?.code, 'one row per (org, stem)').toBe('23505');
  });
});

describe('T-386 S2 - D7: the counters are org-scoped (RLS)', () => {
  it('D7: org B\'s principal sees none of org A\'s counter rows, and cannot insert one for org A. Red today: no table', async () => {
    const a = await mkOrg('d7a');
    const b = await mkOrg('d7b');
    expect(await insertItem(a, 'CHWN-001')).toBeNull();
    expect(await insertItem(b, 'CHWT-001')).toBeNull();
    let seen: { org_id: string }[] = [];
    expect(await run(b.orgId, async (t) => { seen = await t<{ org_id: string }[]>`select org_id from item_code_counters`; })).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((r) => r.org_id))).toEqual(new Set([b.orgId]));
    const err = await run(b.orgId, (t) => t`insert into item_code_counters (org_id, stem, last_seq) values (${a.orgId}, 'ZZZZ', 1)`);
    expect(err, 'org B writing an org A row').not.toBeNull();
    expect(err!.code).toBe('42501');
    expect(await mark(a, 'ZZZZ')).toBeNull();
  });

  it('D7b: RLS is ENABLED and FORCED with policy item_code_counters_org_isolation; the app role may SELECT, INSERT, UPDATE and may not DELETE. Red today: no table', async () => {
    const [c] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class where relname = 'item_code_counters' and relkind = 'r'`;
    expect(c, 'table item_code_counters is missing (migration 0189 not applied)').toBeDefined();
    expect(c!.relrowsecurity).toBe(true);
    expect(c!.relforcerowsecurity).toBe(true);
    const pol = await sql<{ policyname: string }[]>`select policyname from pg_policies where tablename = 'item_code_counters'`;
    expect(pol.map((p) => p.policyname)).toEqual(['item_code_counters_org_isolation']);
    const [g] = await sql<{ s: boolean; i: boolean; u: boolean; d: boolean }[]>`
      select has_table_privilege(${APP_ROLE}, 'item_code_counters', 'SELECT') as s,
             has_table_privilege(${APP_ROLE}, 'item_code_counters', 'INSERT') as i,
             has_table_privilege(${APP_ROLE}, 'item_code_counters', 'UPDATE') as u,
             has_table_privilege(${APP_ROLE}, 'item_code_counters', 'DELETE') as d`;
    expect(g).toEqual({ s: true, i: true, u: true, d: false });
  });
});

describe('T-386 S2 - D8: the seed raises the mark for codes that already have the shape', () => {
  it('D8: an item ABCD-007 that existed BEFORE 0189 (inserted with the triggers off) -> the migration\'s seed statement gives mark 7 for (org, ABCD). The statement is the spec\'s R2a step 5, scoped to this org. (The builder may instead prove the seed on the scratch DB of ADR-012 section 5.8; the commit names which.) Red today: no table', async () => {
    const o = await mkOrg('d8');
    // A non-superuser test role cannot set session_replication_role; that is reported, not hidden, by the 42501 assertion below.
    const err = await run(
      o.orgId,
      async (t) => {
        await t.unsafe(`set local session_replication_role = replica`);
        await t`insert into items (org_id, code, name, kind, base_unit, created_by) values (${o.orgId}, 'ABCD-007', ${uid('n')}, 'raw_material', 'kg', ${o.personId})`;
        await t`insert into items (org_id, code, name, kind, base_unit, created_by) values (${o.orgId}, 'ABCD-003', ${uid('n')}, 'raw_material', 'kg', ${o.personId})`;
        await t.unsafe(`set local session_replication_role = origin`);
        await t.unsafe(`set local row_security = off`);
        await t`insert into item_code_counters (org_id, stem, last_seq)
                select org_id, left(code, 4), max(right(code, 3)::int) from items
                 where code ~ '^[A-Z0-9]{4}-[0-9]{3}$' and org_id = ${o.orgId} group by 1, 2`;
        await t.unsafe(`set local row_security = on`);
      },
      { owner: true },
    );
    expect(err, 'the seed legs need a superuser test role; if this is 42501, prove the seed on the scratch DB instead and say so').toBeNull();
    expect(await mark(o, 'ABCD')).toBe(7);
    expect(await counterRows(o)).toBe(1);
    expectRefused(await insertItem(o, 'ABCD-005'), 'a number below the seeded mark', '23514', NEVER_REUSED);
    expect(await insertItem(o, 'ABCD-008')).toBeNull();
  });
});

describe('T-386 S2 - D9: the triggers exist with the right mode', () => {
  it('D9: items_code_never_reused is origin-enabled (O), BEFORE INSERT OR UPDATE, FOR EACH ROW on items; item_code_counters_forward_only is ENABLE ALWAYS (A), BEFORE UPDATE, FOR EACH ROW on item_code_counters. Red today: neither exists', async () => {
    const rows = await sql<{ tgname: string; tgenabled: string; tgtype: number; relname: string }[]>`
      select t.tgname, t.tgenabled, t.tgtype, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname in (${NEVER_REUSED}, ${FORWARD_ONLY}) and not t.tgisinternal`;
    const by = Object.fromEntries(rows.map((r) => [r.tgname, r]));
    expect(by[NEVER_REUSED], `trigger ${NEVER_REUSED} is missing (migration 0189 not applied)`).toBeDefined();
    expect(by[FORWARD_ONLY], `trigger ${FORWARD_ONLY} is missing (migration 0189 not applied)`).toBeDefined();
    expect(by[NEVER_REUSED]!.relname).toBe('items');
    expect(by[NEVER_REUSED]!.tgenabled).toBe('O');
    expect(by[FORWARD_ONLY]!.relname).toBe('item_code_counters');
    expect(by[FORWARD_ONLY]!.tgenabled).toBe('A');
    // tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT, 16 = UPDATE
    for (const [name, bits] of [[NEVER_REUSED, 1 | 2 | 4 | 16], [FORWARD_ONLY, 1 | 2 | 16]] as const) {
      expect(by[name]!.tgtype & bits, `${name} row/before/event bits`).toBe(bits);
    }
    expect(by[FORWARD_ONLY]!.tgtype & 4, 'forward-only is UPDATE only').toBe(0);
  });

  it('D9b: items_code_never_reused fires on UPDATE OF code only (a name-only UPDATE does not even enter the function) and carries the shape WHEN. Red today: no trigger', async () => {
    const [d] = await sql<{ def: string }[]>`select pg_get_triggerdef(t.oid) as def from pg_trigger t where t.tgname = ${NEVER_REUSED} and not t.tgisinternal`;
    expect(d?.def ?? '(trigger missing)').toMatch(/BEFORE INSERT OR UPDATE OF code ON (public\.)?items/);
    expect(d!.def).toMatch(/WHEN \(/);
    expect(d!.def).toContain('[A-Z0-9]{4}-[0-9]{3}');
  });
});

describe('T-386 S2 - the registrations and the migration artefacts', () => {
  it('registries: the RLS registry, the trigger registry and the cutover classification each carry the new entries (the guards that cross-check them stay green). Red today: the keys are absent', () => {
    expect(RLS_REGISTRY.item_code_counters?.scope).toBe('org_column');
    expect(TRIGGER_REGISTRY[NEVER_REUSED]).toMatchObject({ table: 'items', mode: 'origin', kind: 'validator' });
    expect(TRIGGER_REGISTRY[FORWARD_ONLY]).toMatchObject({ table: 'item_code_counters', mode: 'always', kind: 'history_guard' });
    expect(CUTOVER_CLASSIFICATION.item_code_counters?.class).toBe('keep');
    for (const e of [RLS_REGISTRY.item_code_counters, TRIGGER_REGISTRY[NEVER_REUSED], TRIGGER_REGISTRY[FORWARD_ONLY], CUTOVER_CLASSIFICATION.item_code_counters]) {
      expect((e as { reason?: string } | undefined)?.reason ?? '', 'every entry says why').not.toBe('');
    }
  });

  const root = fileURLToPath(new URL('../../../../', import.meta.url));

  it('journal: idx 189, tag 0189_t386_item_codes, when = 1802403107084 (0188\'s plus one day) and the file exists, hand-authored (ADR-012 section 5). Red today: no entry', () => {
    const journal = JSON.parse(readFileSync(`${root}packages/db/migrations/meta/_journal.json`, 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
    const e = journal.entries.find((x) => x.idx === 189);
    expect(e, 'journal entry idx 189').toBeDefined();
    expect(e!.tag).toBe('0189_t386_item_codes');
    expect(e!.when).toBe(1802403107084);
    expect(existsSync(`${root}packages/db/migrations/0189_t386_item_codes.sql`)).toBe(true);
  });

  it('migration text: carries the prechecks P0189a-e, the seed between row_security off/on, the ENABLE ALWAYS line, and the new index; no DELETE grant. Red today: the file does not exist', () => {
    const text = readFileSync(`${root}packages/db/migrations/0189_t386_item_codes.sql`, 'utf8');
    for (const p of ['P0189a', 'P0189b', 'P0189c', 'P0189d', 'P0189e']) expect(text, p).toContain(p);
    expect(text).toMatch(/upper\("code"\)/);
    expect(text).toMatch(/ENABLE ALWAYS TRIGGER "item_code_counters_forward_only"/);
    expect(text).toMatch(/SET LOCAL row_security = off/);
    expect(text).toMatch(/SET LOCAL row_security = on/);
    expect(text).toMatch(/GRANT SELECT, INSERT, UPDATE ON "item_code_counters" TO "shareat_app"/);
    expect(text).not.toMatch(/GRANT[^;]*DELETE[^;]*item_code_counters/);
    expect(text).not.toContain('\r');
  });

  it('docs/ops/README.md carries the 0189 deploy-gate row with P0189c "MUST be 0 rows". Red today: no row', () => {
    const text = readFileSync(`${root}docs/ops/README.md`, 'utf8');
    expect(text).toMatch(/0189 \(T-386\)/);
    expect(text).toMatch(/P0189c MUST be 0 rows/);
  });
});
