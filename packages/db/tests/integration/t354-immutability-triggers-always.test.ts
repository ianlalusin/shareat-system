/**
 * T-354 / DEF-487 — legs T5 (registry over-flip guard, duplicated here for locality is NOT done;
 * it lives in t354-trigger-registry.test.ts alongside T1-T4 per M1), P1-P6 (replica-mode history
 * guards), D1-D2 (derivation triggers stay origin) and A1-A5 (audit_log app-role privileges).
 *
 * Real Postgres via TEST_DATABASE_URL, `_test` name guard (matches every sibling integration
 * file). The admin connection here is the OWNER/superuser connection `setup.ts` establishes
 * (same one every other integration file uses as `sql`) — P6 and the rollsuper guard below
 * both depend on that being true; if it is not, this file FAILS rather than silently skipping
 * (Orchestrator ruling: "a skipped replica leg is the vacuous pass this task exists to end").
 *
 * ⚠️ Orchestrator amendment M2 (binds): "row still there" after a sentinel-rollback is vacuous,
 * and probing a row inside an ABORTED transaction hits 25P02. Every P/D leg therefore runs its
 * target statement under `tx.savepoint(...)`, records today's red as the DML SUCCEEDING (a
 * non-zero `count`), and checks row state INSIDE the outer transaction, before the sentinel
 * throw rolls the whole thing back.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';
import { testItemCode } from '../../../domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------------------
// The rollsuper guard (TESTER paths, spec body): if the admin connection is not superuser,
// EVERY P/D/A leg below is meaningless (RLS and privilege checks would be bypassed for the
// wrong reason), so the file fails loudly instead of quietly passing.
// ---------------------------------------------------------------------------------------
describe('admin connection precondition', () => {
  it('the TEST_DATABASE_URL connection is superuser — required for every replica-mode leg below to mean anything', async () => {
    const [row] = await sql<{ rolsuper: boolean }[]>`select rolsuper from pg_roles where rolname = current_user`;
    expect(
      row?.rolsuper,
      'the admin connection is NOT superuser. Every replica-mode (P/D) leg below is meaningless ' +
        'without it (a non-superuser cannot SET session_replication_role at all, or the outcome ' +
        'proves nothing about ENABLE ALWAYS). This must FAIL, not skip.',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Rollback plumbing — sentinel throw at the end of every P/D leg's outer transaction.
// ---------------------------------------------------------------------------------------
class RollbackSentinel extends Error {}

async function inReplicaTx(fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local session_replication_role = 'replica'`);
      await fn(tx);
      throw new RollbackSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackSentinel)) throw err;
  }
}

/** Runs `fn` under a SAVEPOINT of `tx`. Captures success (count) or the thrown error, whichever
 *  happens — the statement never aborts the outer transaction either way (M2). */
async function attempt(
  tx: postgres.TransactionSql,
  fn: (sp: postgres.TransactionSql) => Promise<{ count: number }>,
): Promise<{ result?: { count: number }; error?: Error & { code?: string; message: string } }> {
  let result: { count: number } | undefined;
  let error: (Error & { code?: string }) | undefined;
  try {
    await tx.savepoint(async (sp) => {
      result = await fn(sp);
    });
  } catch (err) {
    error = err as Error & { code?: string };
  }
  return { result, error };
}

// ---------------------------------------------------------------------------------------
// Journal fixture (P1-P3) — mirrors journal.test.ts's baseFixture/insertEntryWithLines,
// trimmed to what these three legs need.
// ---------------------------------------------------------------------------------------
async function insertOrg(hint: string): Promise<string> {
  const code = uid(`t354-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return row!.id;
}
async function accountId(orgId: string, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${code}`;
  if (!row) throw new Error(`seeded account ${code} not found for org ${orgId}`);
  return row.id;
}
async function insertPeriod(orgId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open') returning id`;
  return row!.id;
}
/** One posted, balanced two-line entry, created draft-first (0004's rule) then flipped posted. */
async function postedEntryFixture(hint: string) {
  const orgId = await insertOrg(hint);
  await seedChartOfAccounts(sql, orgId);
  const periodId = await insertPeriod(orgId);
  const cash = await accountId(orgId, '1110');
  const opex = await accountId(orgId, '6900');
  const entryId = await sql.begin(async (trx) => {
    const [entry] = await trx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-15', ${periodId}, 'test', ${uid(hint)}, 'draft') returning id`;
    await trx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${entry!.id}, 1, ${opex}, '10.00', '0')`;
    await trx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${entry!.id}, 2, ${cash}, '0', '10.00')`;
    await trx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
    return entry!.id;
  });
  const lines = await sql<{ id: string; line_no: number }[]>`select id, line_no from journal_lines where entry_id = ${entryId} order by line_no`;
  return { orgId, periodId, cash, opex, entryId, lineId: lines[0]!.id };
}

describe('P1 — replica · DELETE one line of a POSTED journal entry', () => {
  it('rejects with /its lines are immutable/; the line is still there — today\'s red: the DELETE succeeds (1 row)', async () => {
    const { entryId, lineId } = await postedEntryFixture('p1');
    await inReplicaTx(async (tx) => {
      const { result, error } = await attempt(tx, (sp) => sp`delete from journal_lines where id = ${lineId}`);
      expect(error, `wanted a rejection — today's red: the DELETE just succeeded (count ${result?.count})`).toBeInstanceOf(Error);
      expect(error?.message ?? '').toMatch(/its lines are immutable/);
      const stillThere = await tx`select id from journal_lines where id = ${lineId} and entry_id = ${entryId}`;
      expect(stillThere.length, 'the line must still be present').toBe(1);
    });
  });
});

describe('P2 — replica · DELETE a POSTED journal_entries row', () => {
  it('rejects with /cannot be deleted/ — today\'s red: succeeds, and FK triggers are also silent in replica mode so it orphans the lines', async () => {
    const { entryId } = await postedEntryFixture('p2');
    await inReplicaTx(async (tx) => {
      const { result, error } = await attempt(tx, (sp) => sp`delete from journal_entries where id = ${entryId}`);
      expect(error, `wanted a rejection — today's red: the DELETE just succeeded (count ${result?.count})`).toBeInstanceOf(Error);
      expect(error?.message ?? '').toMatch(/cannot be deleted/);
      const stillThere = await tx`select id from journal_entries where id = ${entryId}`;
      expect(stillThere.length, 'the entry must still be present').toBe(1);
    });
  });
});

describe('P3 — replica · INSERT a balanced line pair onto a POSTED entry', () => {
  it('rejects with /lines may only be inserted while an entry is draft/ — today\'s red: the INSERT succeeds', async () => {
    const { entryId, opex, cash } = await postedEntryFixture('p3');
    await inReplicaTx(async (tx) => {
      const { result, error } = await attempt(
        tx,
        (sp) => sp`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${entryId}, 99, ${opex}, '1.00', '0')`,
      );
      expect(error, `wanted a rejection — today's red: the INSERT just succeeded (count ${result?.count})`).toBeInstanceOf(Error);
      expect(error?.message ?? '').toMatch(/lines may only be inserted while an entry is draft/);
      const extra = await tx`select id from journal_lines where entry_id = ${entryId} and line_no = 99`;
      expect(extra.length, 'no extra line should exist').toBe(0);
      void cash;
    });
  });
});

// ---------------------------------------------------------------------------------------
// Stock ledger fixture (P4) — mirrors stock-ledger.test.ts's setup, trimmed to one movement.
// ---------------------------------------------------------------------------------------
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

describe('P4 — replica · UPDATE stock_movements.quantity', () => {
  it('rejects with /stock_movements is append-only/ — today\'s red: the UPDATE succeeds', async () => {
    const { movementId } = await stockMovementFixture('p4');
    await inReplicaTx(async (tx) => {
      const { result, error } = await attempt(tx, (sp) => sp`update stock_movements set quantity = '99' where id = ${movementId}`);
      expect(error, `wanted a rejection — today's red: the UPDATE just succeeded (count ${result?.count})`).toBeInstanceOf(Error);
      expect(error?.message ?? '').toMatch(/stock_movements is append-only/);
      const [row] = await tx<{ quantity: string }[]>`select quantity from stock_movements where id = ${movementId}`;
      expect(Number(row?.quantity), 'the quantity must be unchanged').toBe(10);
    });
  });
});

// ---------------------------------------------------------------------------------------
// Attendance fixture (P5) — one punch on one employment.
// ---------------------------------------------------------------------------------------
async function attendancePunchFixture(hint: string) {
  const orgId = await insertOrg(hint);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Worker') returning id`;
  const personId = person!.id;
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${personId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  const employmentId = employment!.id;
  const [punch] = await sql<{ id: string }[]>`
    insert into attendance_punches
      (org_id, store_id, person_id, employment_id, client_punch_id, occurred_at, shift_day, method, asserted_intent, source)
    values (${orgId}, ${storeId}, ${personId}, ${employmentId}, ${uid('punch')}, now(), current_date, 'manual', 'in', 'manual_entry')
    returning id`;
  return { orgId, storeId, personId, employmentId, punchId: punch!.id };
}

describe('P5 — replica · DELETE an attendance_punches row', () => {
  it('rejects (the append-only message) — today\'s red: the DELETE succeeds', async () => {
    const { punchId } = await attendancePunchFixture('p5');
    await inReplicaTx(async (tx) => {
      const { result, error } = await attempt(tx, (sp) => sp`delete from attendance_punches where id = ${punchId}`);
      expect(error, `wanted a rejection — today's red: the DELETE just succeeded (count ${result?.count})`).toBeInstanceOf(Error);
      expect(error?.message ?? '').toMatch(/append-only/);
      const stillThere = await tx`select id from attendance_punches where id = ${punchId}`;
      expect(stillThere.length, 'the punch must still be present').toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------------------
// audit_log fixtures (P6, A1-A5) — mirrors audit-log-rls.test.ts's orgAndPerson/seedRow.
// ---------------------------------------------------------------------------------------
async function asOrg<T>(org: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    if (org !== null) await tx`select set_config('app.org_id', ${org}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}
async function orgAndPerson(hint: string) {
  const code = uid(`t354-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Actor') returning id`;
  return { orgId, personId: person!.id };
}
async function seedAuditRow(orgId: string, personId: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into audit_log (org_id, actor_person_id, action, entity, entity_id, before, after, source)
    values (${orgId}, ${personId}, 't354_test', 'sales_channels', ${crypto.randomUUID()}, ${sql.json({ a: 1 })}, ${sql.json({ a: 2 })}, 'web')
    returning id`;
  return row!.id;
}
async function caught<T>(p: Promise<T>): Promise<(Error & { code?: string }) | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  return undefined;
}

describe('P6 — replica · superuser DELETE of an audit_log row (the auditor\'s repro)', () => {
  it('code 23001, the row is still there — today\'s red: the DELETE succeeds', async () => {
    const a = await orgAndPerson('p6');
    const id = await seedAuditRow(a.orgId, a.personId);
    await inReplicaTx(async (tx) => {
      const { result, error } = await attempt(tx, (sp) => sp`delete from audit_log where id = ${id}`);
      expect(error, `wanted a rejection — today's red: the DELETE just succeeded (count ${result?.count})`).toBeInstanceOf(Error);
      expect(error?.code).toBe('23001');
      const stillThere = await tx`select id from audit_log where id = ${id}`;
      expect(stillThere.length, 'the row must still be present').toBe(1);
    });
  });
});

describe('D1 — replica · INSERT a stores row', () => {
  it('zero foundation money accounts are created for it (derivation stays origin) — green today (guard)', async () => {
    const orgId = await insertOrg('d1');
    await inReplicaTx(async (tx) => {
      const [store] = await tx<{ id: string }[]>`
        insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
      const accounts = await tx`select id from money_accounts where store_id = ${store!.id}`;
      expect(accounts.length, 'a replica-mode INSERT must not seed foundation money accounts').toBe(0);
    });
  });
});

describe('D2 — replica · UPDATE a persons row with an employment', () => {
  it('no new mirror-outbox row — green today (guard)', async () => {
    const orgId = await insertOrg('d2');
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Original Name') returning id`;
    await sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${store!.id}, ${person!.id}, ${uid('SE')}, 'regular', '2025-01-01')`;

    await inReplicaTx(async (tx) => {
      const before = await tx`select count(*)::int as c from mirror_outbox where entity_id = ${person!.id}`;
      await tx`update persons set display_name = 'Renamed' where id = ${person!.id}`;
      const after = await tx`select count(*)::int as c from mirror_outbox where entity_id = ${person!.id}`;
      expect((after[0] as { c: number }).c, 'a replica-mode UPDATE must not enqueue a new mirror row').toBe((before[0] as { c: number }).c);
    });
  });
});

describe('A1 — app role (asOrg) UPDATE of its OWN org\'s audit_log row', () => {
  it('code 42501 — today\'s red: a silent count 0', async () => {
    const a = await orgAndPerson('a1');
    const id = await seedAuditRow(a.orgId, a.personId);
    const err = await caught(asOrg(a.orgId, (tx) => tx`update audit_log set action = 'tampered' where id = ${id}`));
    expect(err, 'wanted a rejection — today\'s red: the UPDATE runs and silently affects 0 rows').toBeInstanceOf(Error);
    expect(err?.code).toBe('42501');
  });
});

describe('A2 — app role DELETE of the same', () => {
  it('code 42501 — today\'s red: a silent count 0', async () => {
    const a = await orgAndPerson('a2');
    const id = await seedAuditRow(a.orgId, a.personId);
    const err = await caught(asOrg(a.orgId, (tx) => tx`delete from audit_log where id = ${id}`));
    expect(err, 'wanted a rejection — today\'s red: the DELETE runs and silently affects 0 rows').toBeInstanceOf(Error);
    expect(err?.code).toBe('42501');
  });
});

describe('A3 — app role INSERT (own org, own actor)', () => {
  it('succeeds — green today (guard: the REVOKE must not touch INSERT)', async () => {
    const a = await orgAndPerson('a3');
    const err = await caught(
      asOrg(a.orgId, (tx) => tx`
        insert into audit_log (org_id, actor_person_id, action, entity, entity_id, before, after, source)
        values (${a.orgId}, ${a.personId}, 't354_a3', 'sales_channels', ${crypto.randomUUID()}, null, null, 'web')`),
    );
    expect(err, err?.message).toBeUndefined();
  });
});

describe('A4 — app role SELECT of own-org rows', () => {
  it('returns the row — green today (guard: the REVOKE must not touch SELECT)', async () => {
    const a = await orgAndPerson('a4');
    const id = await seedAuditRow(a.orgId, a.personId);
    const rows = await asOrg(a.orgId, (tx) => tx`select id from audit_log where id = ${id}`);
    expect(rows.length).toBe(1);
  });
});

describe('A5 — has_table_privilege(shareat_app, audit_log, p)', () => {
  it('false for UPDATE and DELETE, true for SELECT and INSERT — today\'s red: UPDATE and DELETE are true', async () => {
    const [row] = await sql<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
      select
        has_table_privilege(${APP_ROLE}, 'audit_log', 'SELECT') as sel,
        has_table_privilege(${APP_ROLE}, 'audit_log', 'INSERT') as ins,
        has_table_privilege(${APP_ROLE}, 'audit_log', 'UPDATE') as upd,
        has_table_privilege(${APP_ROLE}, 'audit_log', 'DELETE') as del`;
    expect(row?.sel, 'SELECT should remain granted').toBe(true);
    expect(row?.ins, 'INSERT should remain granted').toBe(true);
    expect(row?.upd, 'UPDATE should be revoked — today\'s red: still true').toBe(false);
    expect(row?.del, 'DELETE should be revoked — today\'s red: still true').toBe(false);
  });
});
