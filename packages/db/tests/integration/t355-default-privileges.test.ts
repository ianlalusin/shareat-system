/**
 * T-355 / DEF-489 — `docs/tasks/355-def-489-default-privileges-read-insert.md`, legs D1-D3, N1-N3,
 * E1-E2. Real Postgres via TEST_DATABASE_URL, `_test` name guard (same idiom as every sibling
 * integration file, e.g. `t354-immutability-triggers-always.test.ts:24-28`).
 *
 * ⛔ Orchestrator amendment S1 (binds, 2026-09-29): R3 (the revokes on six EXISTING tables) is NOT
 * built in this task — it goes beyond Ian's ruling and was unsafe (`stock_movements` UPDATE is
 * needed by `onHandForUpdate`'s `select … for update`). V1-V3 and C1 are DROPPED from this file.
 * E1 therefore expects **NO existing table to change** — a plain equality guard against the fixture,
 * green both before and after 0169 (0169 only narrows the DEFAULT for future tables). T-356
 * (separate task, Ian already said yes) later amends E1 to an exact delta map once R3 lands.
 *
 * ⛔ The migrating role. `SET ROLE`/`SET LOCAL ROLE` to it is required for every D3(control)/N1-N3
 * leg to mean anything — the file FAILS (not skips) if it is impossible (spec's own instruction).
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 5 });
let MIGRATING_ROLE: string;

beforeAll(async () => {
  const [row] = await sql<{ tableowner: string }[]>`
    select tableowner from pg_tables where schemaname = 'public' and tablename = 'journal_entries'`;
  if (!row?.tableowner) {
    throw new Error('T-355: could not determine the migrating role — no owner found for public.journal_entries.');
  }
  MIGRATING_ROLE = row.tableowner;

  // ⛔ Fails loudly, never skips, if SET ROLE to the migrating role is impossible — every D3
  // (control)/N1-N3 leg below is meaningless without it.
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
      throw new RollbackSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackSentinel)) {
      throw new Error(
        `T-355: cannot SET ROLE to the migrating role "${MIGRATING_ROLE}" — every D3(control)/N1-N3 ` +
          `leg below is meaningless without it. Original error: ${(err as Error).message}`,
      );
    }
  }
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

class RollbackSentinel extends Error {}

async function caught<T>(p: Promise<T>): Promise<(Error & { code?: string }) | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  return undefined;
}

// =================================================================================================
// D1-D3 — pg_default_acl. Plain reads on the admin connection; D3's positive control runs a real
// (rolled-back) ALTER DEFAULT PRIVILEGES.
// =================================================================================================

async function defaultAclRowsForApp(): Promise<{ grantor: string; namespace: string | null; privs: string[] }[]> {
  const rows = await sql<{ grantor: string; namespace: string | null; privilege_type: string }[]>`
    select r.rolname as grantor, n.nspname as namespace, a.privilege_type
    from pg_default_acl d
    join pg_roles r on r.oid = d.defaclrole
    left join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where d.defaclobjtype = 'r' and a.grantee = 'shareat_app'::regrole
    order by r.rolname, n.nspname, a.privilege_type`;
  const byKey = new Map<string, { grantor: string; namespace: string | null; privs: string[] }>();
  for (const row of rows) {
    const key = `${row.grantor}::${row.namespace ?? '<global>'}`;
    const existing = byKey.get(key);
    if (existing) existing.privs.push(row.privilege_type);
    else byKey.set(key, { grantor: row.grantor, namespace: row.namespace, privs: [row.privilege_type] });
  }
  for (const v of byKey.values()) v.privs.sort();
  return [...byKey.values()];
}

describe('D1 — the migrating role\'s public/"r" default ACL row for shareat_app', () => {
  it('exactly one row (grantor = migrating role, namespace = public), privileges exactly {INSERT, SELECT} — red today: {DELETE, INSERT, SELECT, UPDATE}', async () => {
    const rows = await defaultAclRowsForApp();
    const publicRows = rows.filter((r) => r.grantor === MIGRATING_ROLE && r.namespace === 'public');
    expect(publicRows, `rows: ${JSON.stringify(rows)}`).toHaveLength(1);
    expect(publicRows[0]!.privs, `today's red: extra privileges present`).toEqual(['INSERT', 'SELECT']);
  });
});

describe('D2 — the sequences default (0088:160) is untouched — guard, green today (R2)', () => {
  it('one "S" row, same grantor, privileges {SELECT, USAGE}', async () => {
    const rows = await sql<{ grantor: string; namespace: string | null; privilege_type: string }[]>`
      select r.rolname as grantor, n.nspname as namespace, a.privilege_type
      from pg_default_acl d
      join pg_roles r on r.oid = d.defaclrole
      left join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
      where d.defaclobjtype = 'S' and a.grantee = 'shareat_app'::regrole
      order by a.privilege_type`;
    const grantors = new Set(rows.map((r) => r.grantor));
    expect(grantors.size, `expected one grantor, saw: ${JSON.stringify([...grantors])}`).toBe(1);
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(['SELECT', 'USAGE']);
  });
});

describe('D3 — re-widen guard: no default-ACL row (any grantor, any namespace incl. global) gives shareat_app UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on tables', () => {
  const DANGEROUS = ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

  it('zero matching rows — red today: the 0011 default row matches (UPDATE, DELETE present)', async () => {
    const rows = await defaultAclRowsForApp();
    const offending = rows.filter((r) => r.privs.some((p) => DANGEROUS.includes(p)));
    expect(offending, `offending rows: ${JSON.stringify(offending)}`).toEqual([]);
  });

  it('positive control: in a rolled-back tx, granting UPDATE via ALTER DEFAULT PRIVILEGES makes the SAME query return ≥1 row — proves the guard can fail, not a tautology', async () => {
    let sawRow = false;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
        await tx.unsafe(`alter default privileges in schema public grant update on tables to "${APP_ROLE}"`);
        const rows = await tx<{ privilege_type: string }[]>`
          select a.privilege_type
          from pg_default_acl d
          join pg_roles r on r.oid = d.defaclrole
          cross join lateral aclexplode(d.defaclacl) a
          where d.defaclobjtype = 'r' and a.grantee = 'shareat_app'::regrole and a.privilege_type = 'UPDATE'`;
        sawRow = rows.length >= 1;
        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
    expect(sawRow, 'expected the widening grant to be visible inside its own (rolled-back) transaction').toBe(true);
  });
});

// =================================================================================================
// N1-N3 — a table created by the migrating role, then role-switch checks. ONE shared transaction
// (reserved connection, manual BEGIN/SAVEPOINT) across all three legs so the SAME probe table and
// row exist for each — never committed; rolled back in afterAll.
// =================================================================================================

describe('N1-N3 — a real probe table created by the migrating role', () => {
  let conn: postgres.ReservedSql;

  beforeAll(async () => {
    conn = await sql.reserve();
    await conn.unsafe('begin');
    await conn.unsafe(`set local role ${MIGRATING_ROLE}`);
    await conn.unsafe('create table t355_probe(id int primary key, v int)');
    await conn.unsafe(`insert into t355_probe (id, v) values (1, 1)`);
  });

  afterAll(async () => {
    await conn.unsafe('rollback');
    conn.release();
  });

  it('N1 — has_table_privilege(shareat_app): SELECT and INSERT true, UPDATE and DELETE false — red today: UPDATE and DELETE are true', async () => {
    const rows = await conn<{ p: string; has: boolean }[]>`
      select p, has_table_privilege('shareat_app', 't355_probe'::regclass, p) as has
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p`;
    const byP = Object.fromEntries(rows.map((r) => [r.p, r.has]));
    expect(byP.SELECT, 'SELECT should be true').toBe(true);
    expect(byP.INSERT, 'INSERT should be true').toBe(true);
    expect(byP.UPDATE, "today's red: UPDATE is true").toBe(false);
    expect(byP.DELETE, "today's red: DELETE is true").toBe(false);
  });

  it('N2 — as shareat_app: INSERT succeeds, UPDATE and DELETE each reject 42501 — red today: UPDATE/DELETE succeed (count 1)', async () => {
    // ⛔ Each statement gets its OWN savepoint. A shared savepoint would abort the whole
    // subtransaction the moment UPDATE's 42501 fires, and DELETE would then see 25P02 ("current
    // transaction is aborted") instead of its own real 42501 — a bug the orchestrator caught.
    await conn.unsafe(`set local role ${APP_ROLE}`);

    await conn.unsafe('savepoint n2_insert');
    const insertErr = await caught(conn`insert into t355_probe (id, v) values (2, 2)`);
    await conn.unsafe(insertErr ? 'rollback to savepoint n2_insert' : 'release savepoint n2_insert');

    await conn.unsafe('savepoint n2_update');
    const updateErr = await caught(conn`update t355_probe set v = 99 where id = 1`);
    await conn.unsafe('rollback to savepoint n2_update');

    await conn.unsafe('savepoint n2_delete');
    const deleteErr = await caught(conn`delete from t355_probe where id = 1`);
    await conn.unsafe('rollback to savepoint n2_delete');

    await conn.unsafe(`set local role ${MIGRATING_ROLE}`);

    expect(insertErr, insertErr?.message).toBeUndefined();
    expect(updateErr?.code, "today's red: UPDATE succeeded instead of rejecting").toBe('42501');
    expect(deleteErr?.code, "today's red: DELETE succeeded instead of rejecting").toBe('42501');
  });

  it("N2 control — DELETE's 42501 is a real target: temporarily granting DELETE makes it succeed (proves the rejection is the privilege, not e.g. a mistyped table name)", async () => {
    await conn.unsafe('savepoint n2_delete_control');
    await conn.unsafe(`grant delete on t355_probe to "${APP_ROLE}"`);
    await conn.unsafe(`set local role ${APP_ROLE}`);
    const deleteResult = await conn`delete from t355_probe where id = 1`;
    await conn.unsafe(`set local role ${MIGRATING_ROLE}`);
    await conn.unsafe('rollback to savepoint n2_delete_control');
    expect(deleteResult.count, 'expected the granted DELETE to affect exactly 1 row').toBe(1);
  });

  it('N3 — positive control: after an explicit GRANT UPDATE, DELETE, as shareat_app both succeed (count 1) — proves N2 is the grant, not something else', async () => {
    await conn.unsafe('savepoint n3');
    await conn.unsafe(`grant update, delete on t355_probe to "${APP_ROLE}"`);
    await conn.unsafe(`set local role ${APP_ROLE}`);

    const updateResult = await conn`update t355_probe set v = 100 where id = 1`;
    const deleteResult = await conn`delete from t355_probe where id = 1`;

    await conn.unsafe(`set local role ${MIGRATING_ROLE}`);
    await conn.unsafe('rollback to savepoint n3');

    expect(updateResult.count, 'expected the granted UPDATE to affect exactly 1 row').toBe(1);
    expect(deleteResult.count, 'expected the granted DELETE to affect exactly 1 row').toBe(1);
  });
});

// =================================================================================================
// E1-E2 — snapshot compare against the fixture captured live at 0168
// (`packages/db/tests/fixtures/t355-pre-0169-app-privileges.json`, 136 entries, generated
// 2026-09-29 from shareat_test_t343s5_tester — see the TESTER report).
// =================================================================================================

const FIXTURE_PATH = resolve(__dirname, '../fixtures/t355-pre-0169-app-privileges.json');
const fixture: Record<string, string[]> = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const FIXTURE_ENTRY_COUNT = 136;

const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

async function livePrivilegesFor(relname: string): Promise<string[]> {
  const granted: string[] = [];
  for (const p of PRIVS) {
    const [row] = await sql<{ has: boolean }[]>`select has_table_privilege('shareat_app', ${relname}::regclass, ${p}) as has`;
    if (row?.has) granted.push(p);
  }
  return granted.sort();
}

describe('E2 — the fixture is not vacuous', () => {
  it(`fixture entry count is ${FIXTURE_ENTRY_COUNT} (recorded in the TESTER report) and ≥ 127 — red until the fixture exists`, () => {
    const names = Object.keys(fixture);
    expect(names.length).toBe(FIXTURE_ENTRY_COUNT);
    expect(names.length).toBeGreaterThanOrEqual(127);
  });

  it('every fixture name exists live as a public relation', async () => {
    const rows = await sql<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')`;
    const liveNames = new Set(rows.map((r) => r.relname));
    const missing = Object.keys(fixture).filter((n) => !liveNames.has(n));
    expect(missing, `fixture names missing live: ${JSON.stringify(missing)}`).toEqual([]);
  });
});

/**
 * E1′ (T-356 amendment A3) — the six tables 0170 revokes get an EXACT delta, not an exception. Every
 * delta key must exist in the fixture, and every removed privilege must have been present in it
 * (both asserted below, once, as a fixture-sanity check — a typo'd table name or a removed privilege
 * the fixture never had would otherwise silently no-op the subtraction).
 */
const T356_REVOKES: Record<string, readonly string[]> = {
  stock_movements: ['DELETE'],
  attendance_adjustments: ['DELETE'],
  trade_order_messages: ['UPDATE', 'DELETE'],
  attendance_punches: ['UPDATE', 'DELETE'],
  etl_source_documents: ['UPDATE', 'DELETE'],
  missed_month_adjustments: ['UPDATE', 'DELETE'],
};

describe('E1 sanity — every T356_REVOKES key exists in the fixture, and every removed privilege was present in it', () => {
  it('no typo in a table name; no privilege subtracted that was never granted', () => {
    for (const [table, removed] of Object.entries(T356_REVOKES)) {
      expect(fixture[table], `T356_REVOKES names "${table}", which is not in the fixture`).toBeDefined();
      for (const priv of removed) {
        expect(fixture[table]!, `fixture[${table}] never had ${priv} to remove`).toContain(priv);
      }
    }
  });
});

describe("E1′ — snapshot compare: live privileges = fixture MINUS T-356's delta, deep-equal, EVERY table (no subset/'at most' comparison)", () => {
  const names = Object.keys(fixture);
  it.each(names)('%s: live privileges match fixture − delta exactly', async (name) => {
    const removed = new Set(T356_REVOKES[name] ?? []);
    const expected = fixture[name]!.filter((p) => !removed.has(p));
    const live = await livePrivilegesFor(name);
    expect(live, `expected: ${JSON.stringify(expected)}, live: ${JSON.stringify(live)}`).toEqual(expected);
  });
});

// =================================================================================================
// 0169's DO-block post-assertion — the auditor measured it giving the WRONG message in two states
// (S-wrong-role, S-partial). Every leg here extracts the DO block's LITERAL text from the migration
// file (never a hand-retyped copy, so this cannot drift from what actually ships), runs it inside a
// rolled-back outer transaction with the default privilege state set up first, and asserts on a
// DISTINCTIVE substring of the RAISE message — paired with a "does NOT contain" on each of the other
// checks' messages, so a leg cannot pass by matching the wrong branch.
// =================================================================================================

const MIGRATION_0169_PATH = resolve(__dirname, '../../migrations/0169_t355_def489_default_privileges_read_insert.sql');
const migration0169Sql = readFileSync(MIGRATION_0169_PATH, 'utf8');
const DO_BLOCK_START = migration0169Sql.indexOf('DO $$');
if (DO_BLOCK_START === -1) throw new Error('T-355: could not find the DO $$ block in 0169 — has the migration been rewritten?');
const DO_BLOCK_END = migration0169Sql.indexOf('$$;', DO_BLOCK_START) + '$$;'.length;
const DO_BLOCK_TEXT = migration0169Sql.slice(DO_BLOCK_START, DO_BLOCK_END);

const MSG = {
  stillGrants: /still grants/,
  reGrant: /re-grant SELECT, INSERT/,
  someoneRevoked: /Someone REVOKEd/,
  notThe0011Role: /not the role that ran 0011/,
  namesInsert: /INSERT/,
};

/** Runs the extracted DO block text on `tx` and returns the RAISE'd error, or `undefined` if it ran silently. */
async function runDoBlock(tx: postgres.TransactionSql): Promise<(Error & { message: string }) | undefined> {
  try {
    await tx.unsafe(DO_BLOCK_TEXT);
    return undefined;
  } catch (err) {
    return err as Error & { message: string };
  }
}

describe("0169's DO-block post-assertion — five states of the default-ACL, one leg each", () => {
  it('S-ok — right role, [INSERT, SELECT]: silent (no exception) — the state this database is actually in today', async () => {
    let error: Error | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
        error = await runDoBlock(tx);
        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
    expect(error, `expected silence, got: ${error?.message}`).toBeUndefined();
  });

  it('S-wide — re-widened (UPDATE granted back): check (i) fires, message contains "still grants"', async () => {
    let error: (Error & { message: string }) | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
        await tx.unsafe(`alter default privileges in schema public grant update on tables to "${APP_ROLE}"`);
        error = await runDoBlock(tx);
        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
    expect(error, 'expected an exception').toBeDefined();
    expect(error!.message).toMatch(MSG.stillGrants);
    expect(error!.message).not.toMatch(MSG.notThe0011Role);
    expect(error!.message).not.toMatch(MSG.reGrant);
  });

  it('S-revoked — REVOKE ALL (no row from any grantor): message contains "re-grant SELECT, INSERT" and "Someone REVOKEd"', async () => {
    let error: (Error & { message: string }) | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
        await tx.unsafe(`alter default privileges in schema public revoke all on tables from "${APP_ROLE}"`);
        error = await runDoBlock(tx);
        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
    expect(error, 'expected an exception').toBeDefined();
    expect(error!.message).toMatch(MSG.reGrant);
    expect(error!.message).toMatch(MSG.someoneRevoked);
    expect(error!.message).not.toMatch(MSG.stillGrants);
    expect(error!.message).not.toMatch(MSG.notThe0011Role);
  });

  it('S-wrong-role — run as shareat_test_runner (postgres\'s own row intact): TARGET says "not the role that ran 0011" — RED today: it says "Someone REVOKEd" (check-new cannot tell "never had a row" apart from "was revoked to empty")', async () => {
    let error: (Error & { message: string }) | undefined;
    try {
      await sql.begin(async (tx) => {
        // shareat_test_runner has never run ANY `ALTER DEFAULT PRIVILEGES` — it has no default-ACL
        // row of its own at all, which is a DIFFERENT fact from "someone revoked its row to empty".
        await tx.unsafe(`set local role shareat_test_runner`);
        error = await runDoBlock(tx);
        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
    expect(error, 'expected an exception').toBeDefined();
    expect(error!.message, `today's red — got: ${error!.message}`).toMatch(MSG.notThe0011Role);
    expect(error!.message).not.toMatch(MSG.someoneRevoked);
  });

  it('S-partial — right role, only [SELECT] (INSERT missing): TARGET names the missing INSERT — RED today: the generic "not the role that ran 0011", which never names INSERT', async () => {
    let error: (Error & { message: string }) | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
        // Narrows the existing [SELECT, INSERT] row to [SELECT] only — the row survives (SELECT
        // remains), so this is genuinely "present but partial", not "no row at all" (S-revoked).
        await tx.unsafe(`alter default privileges in schema public revoke insert on tables from "${APP_ROLE}"`);
        error = await runDoBlock(tx);
        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
    expect(error, 'expected an exception').toBeDefined();
    expect(error!.message, `today's red — got: ${error!.message}`).toMatch(MSG.namesInsert);
  });
});
