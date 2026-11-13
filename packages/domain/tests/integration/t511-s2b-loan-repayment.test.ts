import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S2b (TESTER) - `updateLoanRepaymentAmount`: an admin records the expected daily repayment of a loan (the figure the
 * company-wide loan check will compare Grab's deduction against). Spec: docs/tasks/511-settlement-upload-s2-spec.md "The two admin
 * edits (2b)" item 2; design Decision 6.
 *
 * Contract pinned here:
 *   updateLoanRepaymentAmount(tx, actor, { loanId, repaymentAmount: string | null })
 *   - read the loan first, authorize 'edit_loan_repayment_amount' { storeId: loan.storeId }, THEN judge the value
 *     (LOAN_REPAYMENT_RULES, money, min 0.01), parsed with the money helpers
 *   - null or '' clears it; the same value again is a no-op (no write, no updated_at move, NO audit row)
 *   - a real change writes updated_at = now() and an audit row: action 'loan.repayment_amount_edited', storeId = the loan's store,
 *     entityId = the loan id, before and after amounts, source 'web', same transaction
 *   - zero, negative, NaN, Infinity, 3 decimals, scientific notation and text are refused with a sentence (RefusalError)
 *   - an unknown or another org's loan: a RefusalError sentence (never addressable)
 *
 * HIDING IS PRESENTATION-LEVEL: the screen hides the amount from managers/staff, but the repo read is not gated (a manager's
 * `loansRepo.getById` still returns the column). The last test documents that on purpose so nobody mistakes the page for a control.
 *
 * Real Postgres on a scratch database whose name contains "_test". Never truncates.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, loansRepo, RefusalError, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createLoan, updateLoanRepaymentAmount } from '@shareat/domain';

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
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function person(orgId: string, role: string, name: string, stores: string[]) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return p!.id;
}

/** An org with stores A and B, a Grab loan at each, and people at every role. */
async function fixture(hint: string) {
  const code = uid(`t511l-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('Store A');
  const storeB = await mkStore('Store B');
  const adminId = await person(orgId, 'admin', 'Admin', [storeA, storeB]);
  const adminAId = await person(orgId, 'admin', 'Admin A only', [storeA]);
  const superId = await person(orgId, 'super_admin', 'Super', [storeA, storeB]);
  const managerId = await person(orgId, 'manager', 'Manager', [storeA, storeB]);
  const staffId = await person(orgId, 'staff', 'Staff', [storeA, storeB]);
  const admin = actorOf(orgId, adminId);
  const mkLoan = (storeId: string, name: string) =>
    asOrg(orgId, (tx) =>
      createLoan(tx, admin, {
        storeId, lenderName: 'Grab', name, principalAmount: '200000.00', interestRate: '2', ratePeriod: 'month',
        interestMethod: 'straight', paymentFrequency: 'daily', termPeriods: 90, startDate: '2026-05-11',
      }),
    ).then((l) => l.id);
  return {
    orgId, storeA, storeB,
    loanA: await mkLoan(storeA, 'Grab loan A'),
    loanB: await mkLoan(storeB, 'Grab loan B'),
    admin,
    adminA: actorOf(orgId, adminAId),
    superAdmin: actorOf(orgId, superId),
    manager: actorOf(orgId, managerId),
    staff: actorOf(orgId, staffId),
  };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

interface LoanDb { repayment_amount: string | null; updated_at: Date | null }
async function loanRow(id: string): Promise<LoanDb> {
  const [r] = await sql<LoanDb[]>`select repayment_amount::text as repayment_amount, updated_at from loans where id = ${id}`;
  return r!;
}
interface AuditRow { action: string; store_id: string | null; entity_id: string; source: string; actor_person_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
async function audits(f: Fx, loanId?: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, store_id, entity_id, source, actor_person_id, before, after from audit_log
    where org_id = ${f.orgId} and action = 'loan.repayment_amount_edited' ${loanId ? sql`and entity_id = ${loanId}` : sql``}
    order by recorded_at`;
}
const nonNull = (o: Record<string, unknown> | null) => Object.values(o ?? {}).filter((v) => v !== null).map(String);

const update = (f: Fx, who: Actor, loanId: string, repaymentAmount: string | null) =>
  asOrg(f.orgId, (tx) => updateLoanRepaymentAmount(tx, who, { loanId, repaymentAmount }));

async function expectRefusal(p: Promise<unknown>, sentence?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.name)}: ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  const msg = (err as RefusalError).userMessage;
  expect(msg.length, 'the refusal has a sentence').toBeGreaterThan(10);
  if (sentence) expect(msg).toMatch(sentence);
}
async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

describe('T-511 S2b - updateLoanRepaymentAmount: it exists and is exported from the package index', () => {
  it('is a function on @shareat/domain (red until the builder adds it)', () => {
    expect(typeof updateLoanRepaymentAmount).toBe('function');
  });
});

describe('T-511 S2b - who may record a loan\'s repayment amount (edit_loan_repayment_amount: admin and super_admin only)', () => {
  it('an admin sets 1771.88: stored, updated_at moves, one audit row (action, store, entity, before, after, source, actor)', async () => {
    const f = await fixture('admin');
    const before = await loanRow(f.loanA);
    expect(before.repayment_amount, 'setup: a new loan has no repayment amount').toBeNull();

    await update(f, f.admin, f.loanA, '1771.88');

    const r = await loanRow(f.loanA);
    expect(r.repayment_amount).toBe('1771.88');
    expect(r.updated_at, 'a real change sets updated_at').not.toBeNull();

    const rows = await audits(f, f.loanA);
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.action).toBe('loan.repayment_amount_edited');
    expect(a.store_id, 'the LOAN\'s store').toBe(f.storeA);
    expect(a.entity_id).toBe(f.loanA);
    expect(a.source).toBe('web');
    expect(a.actor_person_id).toBe(f.admin.personId);
    expect(nonNull(a.before), 'before: nothing recorded').toEqual([]);
    expect(nonNull(a.after)).toContain('1771.88');
  });

  it('a change from one amount to another: the audit row carries both', async () => {
    const f = await fixture('change');
    await update(f, f.admin, f.loanA, '1771.88');
    await update(f, f.admin, f.loanA, '1800');
    expect((await loanRow(f.loanA)).repayment_amount).toBe('1800.00');
    const rows = await audits(f, f.loanA);
    expect(rows).toHaveLength(2);
    expect(nonNull(rows[1]!.before)).toContain('1771.88');
    expect(nonNull(rows[1]!.after).map((v) => Number(v))).toContain(1800);
  });

  it('a super_admin may', async () => {
    const f = await fixture('super');
    await update(f, f.superAdmin, f.loanA, '500');
    expect((await loanRow(f.loanA)).repayment_amount).toBe('500.00');
  });

  it('a manager is refused (AuthorizationError); nothing written; no audit row', async () => {
    const f = await fixture('manager');
    await expectAuthRefusal(update(f, f.manager, f.loanA, '1771.88'));
    expect(await loanRow(f.loanA)).toEqual({ repayment_amount: null, updated_at: null });
    expect(await audits(f)).toHaveLength(0);
  });

  it('staff are refused (AuthorizationError); nothing written; no audit row', async () => {
    const f = await fixture('staff');
    await expectAuthRefusal(update(f, f.staff, f.loanA, '1771.88'));
    expect((await loanRow(f.loanA)).repayment_amount).toBeNull();
    expect(await audits(f)).toHaveLength(0);
  });

  it('the gate comes FIRST (auth-first): a manager posting garbage is told they may not, not that the amount is invalid', async () => {
    const f = await fixture('authfirst');
    await expectAuthRefusal(update(f, f.manager, f.loanA, 'abc'));
    await expectAuthRefusal(update(f, f.staff, f.loanA, '-5'));
  });

  it('scope: an admin who holds the capability at store A only may edit store A\'s loan, and is refused for store B\'s', async () => {
    const f = await fixture('scope');
    await update(f, f.adminA, f.loanA, '900');
    expect((await loanRow(f.loanA)).repayment_amount).toBe('900.00');
    await expectAuthRefusal(update(f, f.adminA, f.loanB, '900'));
    expect((await loanRow(f.loanB)).repayment_amount).toBeNull();
    expect(await audits(f, f.loanB)).toHaveLength(0);
  });

  it('another org\'s admin cannot address this org\'s loan: a refusal sentence; nothing written', async () => {
    const f = await fixture('org1');
    const g = await fixture('org2');
    await expectRefusal(update(g, g.admin, f.loanA, '1771.88'), /loan/i);
    expect((await loanRow(f.loanA)).repayment_amount).toBeNull();
    expect(await audits(f)).toHaveLength(0);
    expect(await audits(g)).toHaveLength(0);
  });

  it('a loan id that does not exist: a refusal sentence', async () => {
    const f = await fixture('ghost');
    await expectRefusal(update(f, f.admin, randomUUID(), '100'), /loan/i);
  });
});

describe('T-511 S2b - the amount: parsed with the money helpers, judged AFTER the gate', () => {
  it.each([
    ['0.01 (the smallest allowed)', '0.01', '0.01'],
    ['a whole number', '250', '250.00'],
    ['two decimals', '1771.88', '1771.88'],
    ['thousands commas in correct groups (the shared money parser accepts them)', '1,771.88', '1771.88'],
    ['surrounding spaces', '  500.5 ', '500.50'],
  ])('accepts %s', async (_label, typed, stored) => {
    const f = await fixture('good');
    await update(f, f.admin, f.loanA, typed);
    expect((await loanRow(f.loanA)).repayment_amount).toBe(stored);
  });

  it.each([
    ['zero', '0'],
    ['zero with decimals', '0.00'],
    ['negative', '-5'],
    ['text', 'abc'],
    ['scientific notation', '1e3'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['minus Infinity', '-Infinity'],
    ['three decimals', '12.345'],
    ['a thousandth of a peso (would store as 0.00)', '0.004'],
    ['two numbers', '12 34'],
    ['a misplaced comma', '12,34'],
    ['more than the column holds (numeric(14,2))', '1000000000000'],
  ])('refuses %s with a sentence; nothing is written; no audit row', async (_label, typed) => {
    const f = await fixture('bad');
    await expectRefusal(update(f, f.admin, f.loanA, typed));
    expect(await loanRow(f.loanA)).toEqual({ repayment_amount: null, updated_at: null });
    expect(await audits(f)).toHaveLength(0);
  });

  it('a refused edit leaves an amount that was already recorded exactly as it was', async () => {
    const f = await fixture('badkeep');
    await update(f, f.admin, f.loanA, '1771.88');
    await expectRefusal(update(f, f.admin, f.loanA, '0'));
    expect((await loanRow(f.loanA)).repayment_amount).toBe('1771.88');
    expect(await audits(f, f.loanA)).toHaveLength(1);
  });

  it('the refusal sentence never echoes a raw database error (no "numeric", "constraint", "violates", column names)', async () => {
    const f = await fixture('sentence');
    for (const typed of ['0', 'abc', '12.345']) {
      const err = await update(f, f.admin, f.loanA, typed).then(() => null, (e: unknown) => e);
      expect(err, 'expected a refusal').toBeInstanceOf(RefusalError);
      expect((err as RefusalError).userMessage).not.toMatch(/numeric|constraint|violates|repayment_amount/i);
    }
  });
});

describe('T-511 S2b - clearing', () => {
  it('null clears the amount and writes an audit row holding the old value', async () => {
    const f = await fixture('clear');
    await update(f, f.admin, f.loanA, '1771.88');
    await update(f, f.admin, f.loanA, null);
    expect((await loanRow(f.loanA)).repayment_amount).toBeNull();
    const rows = await audits(f, f.loanA);
    expect(rows).toHaveLength(2);
    expect(nonNull(rows[1]!.before)).toContain('1771.88');
    expect(nonNull(rows[1]!.after)).toEqual([]);
  });

  it('the empty string clears it too (a blank box)', async () => {
    const f = await fixture('clear2');
    await update(f, f.admin, f.loanA, '300');
    await update(f, f.admin, f.loanA, '');
    expect((await loanRow(f.loanA)).repayment_amount).toBeNull();
  });

  it('clearing a loan that has no amount is a no-op: no write, no audit row', async () => {
    const f = await fixture('clear3');
    await update(f, f.admin, f.loanA, null);
    await update(f, f.admin, f.loanA, '');
    expect(await loanRow(f.loanA)).toEqual({ repayment_amount: null, updated_at: null });
    expect(await audits(f)).toHaveLength(0);
  });

  it('a manager clearing is refused like a manager setting', async () => {
    const f = await fixture('clear4');
    await update(f, f.admin, f.loanA, '300');
    await expectAuthRefusal(update(f, f.manager, f.loanA, null));
    expect((await loanRow(f.loanA)).repayment_amount).toBe('300.00');
  });
});

describe('T-511 S2b - the same value again is a no-op: no write, no updated_at move, NO audit row', () => {
  it('twice the same amount: one audit row; updated_at untouched by the second call', async () => {
    const f = await fixture('noop');
    await update(f, f.admin, f.loanA, '1771.88');
    const first = await loanRow(f.loanA);
    await update(f, f.admin, f.loanA, '1771.88');
    const second = await loanRow(f.loanA);
    expect(second.updated_at!.getTime()).toBe(first.updated_at!.getTime());
    expect(await audits(f, f.loanA)).toHaveLength(1);
  });

  it('numerically equal is the same value ("500" then "500.00" then " 500 "): one audit row', async () => {
    const f = await fixture('noop2');
    await update(f, f.admin, f.loanA, '500');
    await update(f, f.admin, f.loanA, '500.00');
    await update(f, f.admin, f.loanA, ' 500 ');
    expect(await audits(f, f.loanA)).toHaveLength(1);
  });

  it('a no-op is still gated: a manager repeating the stored amount is refused', async () => {
    const f = await fixture('noop3');
    await update(f, f.admin, f.loanA, '500');
    await expectAuthRefusal(update(f, f.manager, f.loanA, '500'));
  });
});

describe('T-511 S2b - hiding the amount is presentation, not a control', () => {
  it('a manager can still read the stored amount through the existing repo read (the SCREEN hides it; the repo does not)', async () => {
    const f = await fixture('hiding');
    await update(f, f.admin, f.loanA, '1771.88');
    const asManager = await asOrg(f.orgId, (tx) => loansRepo.getById(tx, f.orgId, f.loanA));
    expect(asManager?.repaymentAmount).toBe('1771.88');
    const listed = await asOrg(f.orgId, (tx) => loansRepo.listLoans(tx, f.orgId));
    expect(listed.find((l) => l.id === f.loanA)?.repaymentAmount).toBe('1771.88');
  });
});
