/**
 * T-356 / DEF-489 follow-up — `docs/tasks/356-def-489-existing-table-revokes.md`, legs V1-V4, L1-L2,
 * C1, and amendment A1's C1b. Real Postgres via TEST_DATABASE_URL, `_test` name guard (same idiom as
 * every sibling integration file, e.g. `t354-immutability-triggers-always.test.ts:24-28`).
 *
 * ⛔ 0170 has NOT been applied to this database yet (TESTER runs against shareat_test_t343s5_tester
 * at 0168/0169, per the orchestrator — do not migrate it here). Every leg below is red today for
 * that reason: the six REVOKEs 0170 will apply have not happened.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';
import { transaction, type Tx } from '../../src/client';
import * as stockLedgerRepo from '../../src/repo/stock-ledger';
import { testItemCode } from '../../../domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let MIGRATING_ROLE: string;

beforeAll(async () => {
  const [row] = await sql<{ tableowner: string }[]>`
    select tableowner from pg_tables where schemaname = 'public' and tablename = 'journal_entries'`;
  if (!row?.tableowner) throw new Error('T-356: could not determine the migrating role — no owner found for public.journal_entries.');
  MIGRATING_ROLE = row.tableowner;

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
      throw new RollbackSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackSentinel)) {
      throw new Error(
        `T-356: cannot SET ROLE to the migrating role "${MIGRATING_ROLE}" — every L1/C1/C1b leg below is meaningless without it. Original error: ${(err as Error).message}`,
      );
    }
  }
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

class RollbackSentinel extends Error {}

/** Raw-postgres role switch — for plain SQL UPDATE/DELETE attempts (V2-V4). `org` may be `null`
 *  when the leg is purely about PRIVILEGE, not RLS visibility (a REVOKE fires before RLS is even
 *  evaluated, so no org context is needed to observe the 42501). */
async function asOrg<T>(org: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    if (org !== null) await tx`select set_config('app.org_id', ${org}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

/** Drizzle-based role switch — for L2, which calls a REAL `@shareat/db` repo function that needs a
 *  drizzle `Tx` (`.execute(sql\`...\`)`), not a raw `postgres.TransactionSql`. Mirrors
 *  `stock-transfers.test.ts`'s own `asOrg` (`:40-47`). */
async function asOrgDrizzle<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function caught<T>(p: Promise<T>): Promise<(Error & { code?: string }) | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  return undefined;
}

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`t356-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return row!.id;
}

// =================================================================================================
// Fixtures
// =================================================================================================

async function attendancePunchFixture(hint: string) {
  const orgId = await insertOrg(hint);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Worker') returning id`;
  const personId = person!.id;
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  const employmentId = employment!.id;
  const [punch] = await sql<{ id: string }[]>`
    insert into attendance_punches
      (org_id, store_id, person_id, employment_id, client_punch_id, occurred_at, shift_day, method, asserted_intent, source)
    values (${orgId}, ${storeId}, ${personId}, ${employmentId}, ${uid('punch')}, now(), current_date, 'manual', 'in', 'manual_entry')
    returning id`;
  return { orgId, storeId, personId, employmentId, punchId: punch!.id };
}

async function tradeOrderMessageFixture(hint: string) {
  const orgId = await insertOrg(hint);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Author') returning id`;
  const personId = person!.id;
  const [customer] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, created_by) values (${orgId}, ${`Customer ${uid('c')}`}, ${personId}) returning id`;
  const [order] = await sql<{ id: string }[]>`
    insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
    values (${orgId}, ${storeId}, ${customer!.id}, current_date, 'draft', '100.00', ${personId}) returning id`;
  const [message] = await sql<{ id: string }[]>`
    insert into trade_order_messages (org_id, order_id, body, author_id)
    values (${orgId}, ${order!.id}, 'fixture message', ${personId}) returning id`;
  return { orgId, storeId, personId, orderId: order!.id, messageId: message!.id };
}

async function stockMovementFixture(hint: string) {
  const orgId = await insertOrg(hint);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('ST')}, 'Store', 'multi_room') returning id`;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Actor') returning id`;
  const personId = person!.id;
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgId}, ${storeId}, 'MAIN', 'Main', ${type!.id}, ${personId}) returning id`;
  const locationId = loc!.id;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${testItemCode()}, 'Item', 'raw_material', 'kg', ${personId}) returning id`;
  const itemId = item!.id;
  const [movement] = await sql<{ id: string }[]>`
    insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${orgId}, ${storeId}, ${locationId}, ${itemId}, '2026-01-20T02:00:00Z', '10', 'receipt', 'delivery', ${crypto.randomUUID()}, ${personId})
    returning id`;
  return { orgId, storeId, locationId, itemId, personId, movementId: movement!.id };
}

/** `kind='verify'` — the simplest valid adjustment shape (no REASON_REQUIRED_KINDS, no chosen/effective minute). */
async function attendanceAdjustmentFixture(hint: string) {
  const orgId = await insertOrg(hint);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const personId = person!.id;
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  const employmentId = employment!.id;
  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, external_id) values (${personId}, 'firebase', ${uid('ext')}) returning id`;
  const [session] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, expires_at)
    values (${uid('hash')}, ${personId}, ${cred!.id}, 'firebase', now() + interval '1 hour') returning id`;
  const [adj] = await sql<{ id: string }[]>`
    insert into attendance_adjustments (org_id, store_id, employment_id, shift_day, kind, decided_by_session_id, decided_by_person_id)
    values (${orgId}, ${storeId}, ${employmentId}, current_date, 'verify', ${session!.id}, ${personId}) returning id`;
  return { orgId, storeId, employmentId, personId, adjustmentId: adj!.id };
}

// =================================================================================================
// V1 — has_table_privilege grid over the six tables. No fixture needed (regclass, not a row).
// =================================================================================================

const V1_GRID: Record<string, { SELECT: boolean; INSERT: boolean; UPDATE: boolean; DELETE: boolean }> = {
  stock_movements: { SELECT: true, INSERT: true, UPDATE: true, DELETE: false },
  attendance_adjustments: { SELECT: true, INSERT: true, UPDATE: true, DELETE: false },
  trade_order_messages: { SELECT: true, INSERT: true, UPDATE: false, DELETE: false },
  attendance_punches: { SELECT: true, INSERT: true, UPDATE: false, DELETE: false },
  etl_source_documents: { SELECT: true, INSERT: true, UPDATE: false, DELETE: false },
  missed_month_adjustments: { SELECT: true, INSERT: true, UPDATE: false, DELETE: false },
};

describe('V1 — has_table_privilege(shareat_app) matches the target grid for all six tables', () => {
  it.each(Object.entries(V1_GRID))('%s: SELECT/INSERT/UPDATE/DELETE match the target — red today: every cell is true', async (table, want) => {
    const rows = await sql<{ p: string; has: boolean }[]>`
      select p, has_table_privilege('shareat_app', ${table}::regclass, p) as has
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p`;
    const byP = Object.fromEntries(rows.map((r) => [r.p, r.has]));
    expect(byP.SELECT, `${table}.SELECT`).toBe(want.SELECT);
    expect(byP.INSERT, `${table}.INSERT`).toBe(want.INSERT);
    expect(byP.UPDATE, `${table}.UPDATE`).toBe(want.UPDATE);
    expect(byP.DELETE, `${table}.DELETE`).toBe(want.DELETE);
  });
});

// =================================================================================================
// V2 — attendance_punches, trade_order_messages: UPDATE then DELETE as app role, each 42501.
// =================================================================================================

describe('V2 — app role UPDATE then DELETE of an attendance_punches row and a trade_order_messages row', () => {
  it('attendance_punches: both reject 42501 — red today: the trigger error (23001/P0001), not 42501', async () => {
    const { orgId, punchId } = await attendancePunchFixture('v2-punch');
    // ⛔ Real org context, not null — a 42501 fires before RLS either way (privilege checks precede
    // RLS evaluation), but WITHOUT it, a missing app_current_org() would ALSO silently filter the
    // row to 0-rows-no-error even before 0170 exists, masking whether this leg would ever actually
    // observe 42501 once the privilege really is revoked.
    const updateErr = await caught(asOrg(orgId, (tx) => tx`update attendance_punches set method = 'manual' where id = ${punchId}`));
    expect(updateErr?.code, "today's red: not 42501").toBe('42501');
    const deleteErr = await caught(asOrg(orgId, (tx) => tx`delete from attendance_punches where id = ${punchId}`));
    expect(deleteErr?.code, "today's red: not 42501").toBe('42501');
  });

  it('positive control: the admin connection still raises the trigger\'s own /append-only/ message on attendance_punches (proves the trigger is still the SECOND lock, not replaced)', async () => {
    const { punchId } = await attendancePunchFixture('v2-punch-control');
    await expect(sql`update attendance_punches set method = 'manual' where id = ${punchId}`).rejects.toThrow(/append-only/);
  });

  it('trade_order_messages: both reject 42501 — red today: the trigger error, not 42501', async () => {
    const { orgId, messageId } = await tradeOrderMessageFixture('v2-msg');
    const updateErr = await caught(asOrg(orgId, (tx) => tx`update trade_order_messages set body = 'edited' where id = ${messageId}`));
    expect(updateErr?.code, "today's red: not 42501").toBe('42501');
    const deleteErr = await caught(asOrg(orgId, (tx) => tx`delete from trade_order_messages where id = ${messageId}`));
    expect(deleteErr?.code, "today's red: not 42501").toBe('42501');
  });

  it('positive control: the admin connection still raises the trigger\'s own /append-only/ message on trade_order_messages', async () => {
    const { messageId } = await tradeOrderMessageFixture('v2-msg-control');
    await expect(sql`update trade_order_messages set body = 'edited' where id = ${messageId}`).rejects.toThrow(/append-only/);
  });
});

// =================================================================================================
// V3 — stock_movements, attendance_adjustments: DELETE as app role, each 42501.
// =================================================================================================

describe('V3 — app role DELETE of a stock_movements row and an attendance_adjustments row', () => {
  it('stock_movements: rejects 42501 — red today: the trigger error, not 42501', async () => {
    const { orgId, movementId } = await stockMovementFixture('v3-mov');
    const err = await caught(asOrg(orgId, (tx) => tx`delete from stock_movements where id = ${movementId}`));
    expect(err?.code, "today's red: not 42501").toBe('42501');
  });

  it('attendance_adjustments: rejects 42501 — red today: the trigger error, not 42501', async () => {
    const { orgId, adjustmentId } = await attendanceAdjustmentFixture('v3-adj');
    const err = await caught(asOrg(orgId, (tx) => tx`delete from attendance_adjustments where id = ${adjustmentId}`));
    expect(err?.code, "today's red: not 42501").toBe('42501');
  });
});

// =================================================================================================
// V4 — attendance_adjustments UPDATE of superseded_by_adjustment_id alone (markSuperseded shape),
// as app role, succeeds — guard, stays green.
// =================================================================================================

describe('V4 — app role UPDATE of superseded_by_adjustment_id alone succeeds (guard: the kept UPDATE)', () => {
  it('count 1 — a REAL second adjustment as the superseding row (this asOrg tx commits, unlike L1/C1/C1b\'s deliberate rollbacks, so the FK is genuinely checked)', async () => {
    const { orgId, storeId, employmentId, personId, adjustmentId } = await attendanceAdjustmentFixture('v4');
    // A second, real adjustment row in the SAME org/employment to stand in as the "superseding" row
    // — markSuperseded's actual shape. Reuses the fixture's session (sessions are not 1:1 with
    // adjustments) rather than minting a fresh one.
    const sessionRows = await sql<{ decided_by_session_id: string }[]>`
      select decided_by_session_id from attendance_adjustments where id = ${adjustmentId}`;
    const sessionId = sessionRows[0]!.decided_by_session_id;
    // A DIFFERENT shift_day — attendance_adjustments_live_unique forbids two LIVE 'verify' rows for
    // the same (employment, day), and the fixture's row is still live (not yet superseded).
    const [superseding] = await sql<{ id: string }[]>`
      insert into attendance_adjustments (org_id, store_id, employment_id, shift_day, kind, decided_by_session_id, decided_by_person_id)
      values (${orgId}, ${storeId}, ${employmentId}, current_date - 1, 'verify', ${sessionId}, ${personId}) returning id`;

    // org context is required here (unlike the privilege-only V2/V3 legs above): a REAL affected
    // row needs RLS to actually let the row through, and app_current_org() is null without it.
    const result = await asOrg(orgId, (tx) =>
      tx`update attendance_adjustments set superseded_by_adjustment_id = ${superseding!.id} where id = ${adjustmentId}`,
    );
    expect(result.count, 'expected the UPDATE to affect exactly 1 row').toBe(1);
  });
});

// =================================================================================================
// L1 — the lock needs UPDATE: a migrating-role probe table, SELECT-only grant, app role
// SELECT ... FOR UPDATE.
// =================================================================================================

describe('L1 — SELECT ... FOR UPDATE needs UPDATE privilege, not just SELECT — a Postgres property, guard', () => {
  it('rejects 42501 with SELECT only; positive control: after GRANT UPDATE the same statement succeeds', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
        await tx.unsafe('create table t356_probe(id int primary key)');
        await tx.unsafe(`insert into t356_probe (id) values (1)`);
        // ⛔ A freshly created table inherits whichever default is live on this database — the OLD,
        // unrestricted 0011 default (SELECT+INSERT+UPDATE+DELETE) if 0169 has not been applied here,
        // or 0169's own narrowed default otherwise. Either way a bare GRANT SELECT is additive on
        // top of it, not restrictive. REVOKE ALL first to get a genuinely SELECT-only baseline
        // regardless of which default is live.
        await tx.unsafe(`revoke all on t356_probe from "${APP_ROLE}"`);
        await tx.unsafe(`grant select on t356_probe to "${APP_ROLE}"`);

        await tx.unsafe('savepoint l1_reject');
        await tx.unsafe(`set local role ${APP_ROLE}`);
        const err = await caught(tx.unsafe('select 1 from t356_probe for update'));
        // ⛔ ROLLBACK TO SAVEPOINT first — a rejected statement aborts the savepoint, and any
        // further statement (including the role switch back) would itself fail with 25P02 until
        // the abort is cleared. Same bug class the orchestrator caught in T-355's N2.
        await tx.unsafe('rollback to savepoint l1_reject');
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
        expect(err?.code, 'expected 42501 with SELECT only').toBe('42501');

        await tx.unsafe(`grant update on t356_probe to "${APP_ROLE}"`);
        await tx.unsafe(`set local role ${APP_ROLE}`);
        await tx.unsafe('select 1 from t356_probe for update'); // must not throw
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);

        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
  });
});

// =================================================================================================
// L2 — the real lock path, as the app role, via the actual repo function. Guard.
// =================================================================================================

describe('L2 — stockLedgerRepo.onHandForUpdate as the app role — guard, green now, red if stock_movements UPDATE is ever revoked', () => {
  it('returns the on-hand; current_user is shareat_app inside the same tx', async () => {
    const { orgId, itemId, locationId } = await stockMovementFixture('l2');
    const result = await asOrgDrizzle(orgId, async (tx) => {
      const cuRows = (await tx.execute(dsql`select current_user`)) as unknown as { current_user: string }[];
      const cu = cuRows[0]!.current_user;
      const onHand = await stockLedgerRepo.onHandForUpdate(tx, itemId, locationId);
      return { cu, onHand };
    });
    expect(result.cu, 'expected the role switch to have taken').toBe(APP_ROLE);
    expect(result.onHand, 'expected the seeded 10 units').toBe('10.000');
  });
});

// =================================================================================================
// C1 — RI cascade runs as the OWNER, not the invoking role. Synthetic pair, guard.
// =================================================================================================

describe('C1 — RI cascade runs as the owner (what the missed_month_adjustments DELETE revoke relies on)', () => {
  it('as shareat_app, DELETE the parent (SELECT+DELETE only, no child DELETE) — count 1, and the child row is gone', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
        await tx.unsafe('create table t356_parent(id int primary key)');
        await tx.unsafe('create table t356_child(id int primary key, p int references t356_parent(id) on delete cascade)');
        await tx.unsafe(`grant select, delete on t356_parent to "${APP_ROLE}"`);
        await tx.unsafe(`revoke delete on t356_child from "${APP_ROLE}"`);
        await tx.unsafe('insert into t356_parent (id) values (1)');
        await tx.unsafe('insert into t356_child (id, p) values (1, 1)');

        await tx.unsafe(`set local role ${APP_ROLE}`);
        const result = await tx`delete from t356_parent where id = 1`;
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);

        const remaining = await tx`select id from t356_child where id = 1`;
        expect(result.count, 'expected the parent DELETE to affect exactly 1 row').toBe(1);
        expect(remaining.length, 'expected the cascade to remove the child row').toBe(0);

        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
  });
});

// =================================================================================================
// C1b (amendment A1) — the RI CHECK on INSERT (not the cascade) also runs independent of the
// referenced row's UPDATE privilege — the property attendance_days -> attendance_punches relies on
// once attendance_punches loses UPDATE. Synthetic pair, guard.
// =================================================================================================

describe('C1b (A1) — an RI CHECK on INSERT into the child needs no UPDATE on the parent — a parent with SELECT only, app-role INSERT into its child succeeds', () => {
  it('count 1 — the property attendance_days (child) -> attendance_punches (parent, loses UPDATE in 0170) relies on', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
        await tx.unsafe('create table t356b_parent(id int primary key)');
        await tx.unsafe('create table t356b_child(id int primary key, p int references t356b_parent(id))');
        // ⛔ Same whichever-default-is-live caveat as L1 — REVOKE ALL first so the parent is
        // genuinely SELECT only, not SELECT-plus-whatever-the-live-default-still-grants.
        await tx.unsafe(`revoke all on t356b_parent from "${APP_ROLE}"`);
        await tx.unsafe(`grant select on t356b_parent to "${APP_ROLE}"`);
        await tx.unsafe(`revoke all on t356b_child from "${APP_ROLE}"`);
        await tx.unsafe(`grant insert on t356b_child to "${APP_ROLE}"`);
        await tx.unsafe('insert into t356b_parent (id) values (1)');

        await tx.unsafe(`set local role ${APP_ROLE}`);
        const result = await tx`insert into t356b_child (id, p) values (1, 1)`;
        await tx.unsafe(`set local role ${MIGRATING_ROLE}`);

        expect(result.count, 'expected the child INSERT to succeed despite the parent having no UPDATE grant').toBe(1);

        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
  });
});
