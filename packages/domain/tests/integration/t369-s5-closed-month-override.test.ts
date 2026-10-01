import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S5a (DEF-314) — one late entry into a CLOSED month, from the reimbursement payout.
 * `docs/tasks/369-unwired-money-screens.md` §S5, "BUILDER S5a" and tests T1–T4 (T5/T6 are the web file,
 * T8 the unit file; T7 is S5b — `approveExpense` — and is NOT written here: S5b waits for T-367).
 *
 *   payReimbursement(tx, actor, { …, periodOverride?: { reason, note? } })
 *
 * The override is authorised INSIDE `postEntry` against the DOMAIN function's own `actor` (I4): the
 * input carries no actor, so a form cannot name one. A manager in an org that has an admin does not hold
 * `override_period_lock` (CAPABILITY-MATRIX row 196).
 *
 * ⛔ TESTER, not BUILDER. Fixture is `t369-s1-reimbursement-payout.test.ts`'s (Lipa; manager, admin, staff,
 * Ana owed ₱650 dated 5 Jan 2026), with January then CLOSED — the payout is dated 16 Jan. The sentences the
 * smoke script reads ("January 2026 is closed…", "…is locked…") are pinned as `userMessage`s, because the
 * person reads them on the screen; on HEAD `postEntry` throws a raw Error carrying ids, with no userMessage.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { payReimbursement } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function person(orgId: string, name: string, role: 'manager' | 'admin' | 'staff', storeId: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

/** Lipa; admin, manager (an org WITH an admin), Ana; ₱650 owed to Ana from 5 Jan; January 2026 CLOSED; February open. */
async function fixture(hint: string) {
  const code = uid(`t369s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', storeId);
  const managerId = await person(orgId, 'Manager', 'manager', storeId);
  const anaId = await person(orgId, 'Ana Reyes', 'staff', storeId);
  const [cash] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
      lines: [{ accountCode: cash!.gl_account_code, storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '100000.00' }],
    }),
  );
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-05', sourceType: 'manual_journal', sourceId: uid('owe'), idempotencyKey: uid('owe'), memo: 'fixture reimbursable expense', postedBy: adminId,
      lines: [
        { accountCode: '6200', storeId, debit: '650.00' },
        { accountCode: '2130', storeId, credit: '650.00', partyType: 'employee', partyId: anaId },
      ],
    }),
  );
  await sql`update fiscal_periods set status = 'closed' where org_id = ${orgId} and starts_on = '2026-01-01'`;
  return { orgId, storeId, anaId, adminId, managerId, cashId: cash!.id, admin: actor(orgId, adminId), manager: actor(orgId, managerId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const CLOSED_DATE = '2026-01-16';
const OVERRIDE = { reason: 'data_entry_error' as const, note: 'Receipt found after the books closed' };

const pay = (f: Fixture, who: Actor, over: Record<string, unknown> = {}) =>
  asOrg(f.orgId, (tx) =>
    payReimbursement(tx, who, {
      storeId: f.storeId, employeeId: f.anaId, amount: '650.00', fromMoneyAccountId: f.cashId, on: CLOSED_DATE, payoutId: crypto.randomUUID(), ...over,
    } as never),
  );

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED — ${what} posted instead (the defect this leg targets)`);
}

async function payoutEntries(orgId: string) {
  return Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'reimbursement_payout'`)[0]!.n);
}
async function overrideRows(orgId: string) {
  return sql<{ entry_id: string; actor_person_id: string; reason: string; note: string | null; period_status_at_post: string }[]>`
    select entry_id, actor_person_id, reason, note, period_status_at_post from period_overrides where org_id = ${orgId}`;
}

// -----------------------------------------------------------------------------------------------

describe('T1 — an admin pays a reimbursement dated in a closed month, with a typed reason', () => {
  it('posts; exactly one period_overrides row: actor = the admin, the reason, the note, period_status_at_post = closed — red on HEAD: the input is ignored and the closed period refuses', async () => {
    const f = await fixture('t1');
    const result = await pay(f, f.admin, { periodOverride: OVERRIDE });

    expect(await payoutEntries(f.orgId)).toBe(1);
    const rows = await overrideRows(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entry_id: result.entryId, actor_person_id: f.adminId, reason: 'data_entry_error',
      note: 'Receipt found after the books closed', period_status_at_post: 'closed',
    });
    const [entry] = await sql<{ entry_date: string }[]>`select entry_date::text from journal_entries where id = ${result.entryId}`;
    expect(entry!.entry_date, 'the entry is dated in the CLOSED month, as asked').toBe(CLOSED_DATE);
  });
});

describe('T2 (✗) — a manager (in an org WITH an admin) cannot use the override', () => {
  it('AuthorizationError; no entry, no override row — positive control: the admin posts the same payout (T1). I4: a forged `actor` inside periodOverride changes nothing', async () => {
    const f = await fixture('t2');

    const refused = await rejection(pay(f, f.manager, { periodOverride: OVERRIDE }), 'a manager override of a closed month');
    expect(refused.err).toBeInstanceOf(AuthorizationError);
    const forged = await rejection(pay(f, f.manager, { periodOverride: { ...OVERRIDE, actor: f.admin } }), 'a manager override carrying a forged admin actor');
    expect(forged.err, 'the override actor is the domain function\'s own actor (I4), never a field of the input').toBeInstanceOf(AuthorizationError);
    expect(await payoutEntries(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    const control = await pay(f, f.admin, { periodOverride: OVERRIDE });
    expect(control.outstanding).toBe('0.00');
    expect(await overrideRows(f.orgId)).toHaveLength(1);
  });
});

describe('T3 — no override fields and a closed month', () => {
  it('refused with "January 2026 is closed…" (a written sentence, no id) for the admin AND the manager; no entry, no override row — positive control: the same payout with the override (T1)', async () => {
    const f = await fixture('t3');

    for (const who of [f.admin, f.manager]) {
      const refused = await rejection(pay(f, who), 'a closed-month payout with no override');
      expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toMatch(/^January 2026 is closed\b/);
      expect(refused.userMessage ?? "").not.toMatch(UUID);
    }
    expect(await payoutEntries(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    await pay(f, f.admin, { periodOverride: OVERRIDE });
    expect(await payoutEntries(f.orgId)).toBe(1);
  });
});

describe('T4 — a LOCKED period cannot be overridden', () => {
  it('admin + override into a locked month -> refused with "January 2026 is locked…" (no id); no entry, no override row', async () => {
    const f = await fixture('t4');
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;
    await sql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId}`;

    const refused = await rejection(pay(f, f.admin, { periodOverride: OVERRIDE }), 'an override into a locked month');
    expect(refused.userMessage ?? `NO userMessage — raw: ${refused.message}`).toMatch(/^January 2026 is locked\b/);
    expect(refused.userMessage ?? "").not.toMatch(UUID);
    expect(await payoutEntries(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });
});

describe('an open month never leaves an override row (domain half of T5)', () => {
  it('the admin paying in OPEN February WITHOUT an override writes no period_overrides row — positive control for every row-count assertion in this file', async () => {
    const f = await fixture('t5open');
    await pay(f, f.admin, { on: '2026-02-05' });
    expect(await payoutEntries(f.orgId)).toBe(1);
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------------
// S5a AUDIT leg (A) — added after the auditor's findings.
// -----------------------------------------------------------------------------------------------

describe('AUDIT A — an override sent for an OPEN month is simply ignored', () => {
  it('a MANAGER paying in open February with a periodOverride posts normally: no AuthorizationError, no period_overrides row — Mutant: authorize override_period_lock whenever an override is present -> refused, red', async () => {
    const f = await fixture('auditA');

    const result = await pay(f, f.manager, { on: '2026-02-05', periodOverride: OVERRIDE });
    expect(result.outstanding).toBe('0.00');
    expect(await payoutEntries(f.orgId)).toBe(1);
    expect(await overrideRows(f.orgId), 'an override audit row was written for an OPEN month').toHaveLength(0);
  });
});
