import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-343 S5.5s — DEF-470, money half, action/domain level.
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5s.
 *
 * ⛔ TESTER, not BUILDER. This is a FIRST INSTALMENT, not the full 17-field set — see the tester's
 * own report for the queue (cash-requests C1-C4, remittance, channel-settlements X1, the
 * agreed-amount and amountIn comma legs). Covered here, all measured directly against the current
 * (pre-fix) domain code, never presumed:
 * - Item 2 (overdraft limit, `money-accounts/index.ts:231-238`): comma leg + negative range guard.
 * - Item 3 (ownership %, `owners/index.ts` `createOwner`): comma leg (W1) + range guard (W2, "150").
 * - Item 4 (drawing limit, same function): range guard ("0"). The comma leg is ALREADY green — the
 *   field is already `parseMoneyInput`'d (`:78`) — asserted as a green pin, not a new red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
import { vi } from 'vitest';
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

import { cashRequestsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { closeDrawingMonth, createCashRequest, createOwner, decideCashRequest, recordChannelSettlement, releaseCashRequest, renameMoneyAccount, settleCashRequest } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { paramsOf } from '../helpers/flash-jar';
import { givePin } from '../helpers/approval-pin';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function orgFixture(hint: string) {
  const code = uid(`s55s-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  // T-412: posting a separation is Tier P; the administrator approves with their own PIN.
  const pin = await givePin(sql, { orgId, storeId, personId: adminId });
  return { orgId, storeId, admin: actor(orgId, adminId), pin };
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// =================================================================================================
// Item 1 — amountIn (money-transfers/index.ts createMoneyTransfer:155) — ALREADY green
// =================================================================================================

async function transferFixture(hint: string) {
  const f = await orgFixture(hint);
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [safe] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return { ...f, drawerId: drawer!.id, safeId: safe!.id };
}

describe('amountIn (DEF-470 item 1) — comma-typed value is ALREADY green (createMoneyTransfer:155 already parseMoneyInput-wraps it)', () => {
  it('⛔ green, unedited — "1,5" already refuses by name, byte-identical before and after this task', async () => {
    const f = await transferFixture('amtin');
    const { createMoneyTransfer } = await import('@shareat/domain');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, f.admin, {
          fromMoneyAccountId: f.drawerId,
          toMoneyAccountId: f.safeId,
          amountOut: '100.00',
          amountIn: '1,5',
          transferDate: '2026-01-10',
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "1,5" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The amount received — "1,5" is not a valid amount. Use at most two decimal places.');
  });
});

// =================================================================================================
// Item 2 — overdraft limit (money-accounts/index.ts renameMoneyAccount)
// =================================================================================================

async function cashierDrawerFixture(hint: string) {
  const f = await orgFixture(hint);
  // seedChartOfAccounts already provisions the store's foundation cashier-cash drawer — a second
  // createMoneyAccount for the same (store, cash, cashier) shape is refused (correctly) by the
  // domain's own dedupe rule, so the fixture selects the real one instead of creating another.
  const [row] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  return { ...f, accountId: row!.id };
}

async function overdraftLimitOf(accountId: string): Promise<string | null> {
  const [row] = await sql<{ overdraft_limit: string | null }[]>`select overdraft_limit from money_accounts where id = ${accountId}`;
  return row!.overdraft_limit;
}

describe('Overdraft limit (DEF-470 item 2) — a comma-typed value refuses by name', () => {
  it('wanted: "The overdraft limit — \\"1,5\\" is not a valid amount. Use at most two decimal places." — was red before this fix: a raw numeric-syntax DB error, the generic fallback', async () => {
    const f = await cashierDrawerFixture('ov1');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        renameMoneyAccount(tx, f.admin, { moneyAccountId: f.accountId, name: 'Cash drawer', overdraftLimit: '1,5' }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "1,5" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The overdraft limit — "1,5" is not a valid amount. Use at most two decimal places.');
    expect(await overdraftLimitOf(f.accountId), 'the limit must be unchanged').toBe('20000.00');
  });
});

describe('Overdraft limit (DEF-470 item 2) — a negative value refuses by name, backing the dropped min="0"', () => {
  it('wanted: "An overdraft limit is how far below zero the drawer may go, so enter it as a positive number. Zero means it may never go below zero at all." — was red before this fix: the raw prefix-stripped developer sentence', async () => {
    const f = await cashierDrawerFixture('ov2');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        renameMoneyAccount(tx, f.admin, { moneyAccountId: f.accountId, name: 'Cash drawer', overdraftLimit: '-5' }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "-5" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe(
      'An overdraft limit is how far below zero the drawer may go, so enter it as a positive number. Zero means it may never go below zero at all.',
    );
    expect(await overdraftLimitOf(f.accountId), 'the limit must be unchanged').toBe('20000.00');
  });
});

// =================================================================================================
// Items 3/4 — ownership % and drawing limit (owners/index.ts createOwner)
// =================================================================================================

async function ownerCandidateFixture(hint: string) {
  const f = await orgFixture(hint);
  const [candidate] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${uid('owner')}) returning id`;
  return { ...f, candidateId: candidate!.id };
}

async function ownerCountFor(orgId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from owners where org_id = ${orgId}`;
  return Number(row!.count);
}

describe('W1 (DEF-470 item 3) — ownershipPercentage "1,5" refuses by name (no parse exists today at all)', () => {
  it('wanted: the percentage sentence — was red before this fix: a raw numeric-syntax DB error, the generic fallback', async () => {
    const f = await ownerCandidateFixture('w1');
    const before = await ownerCountFor(f.orgId);
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createOwner(tx, f.admin, { storeId: f.storeId, personId: f.candidateId, ownershipPercentage: '1,5' } as never),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "1,5" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe(
      'The ownership percentage must be a number from 0.001 to 100.',
    );
    expect(await ownerCountFor(f.orgId), 'no owner row should have been created').toBe(before);
  });
});

describe('W2 (DEF-470 item 3) — ownershipPercentage "150" (out of range) refuses by name', () => {
  it('wanted: the percentage sentence — was red before this fix: an unmapped owners_ownership_percentage_range_check, the generic fallback', async () => {
    const f = await ownerCandidateFixture('w2');
    const before = await ownerCountFor(f.orgId);
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createOwner(tx, f.admin, { storeId: f.storeId, personId: f.candidateId, ownershipPercentage: '150' } as never),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "150" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe(
      'The ownership percentage must be a number from 0.001 to 100.',
    );
    expect(await ownerCountFor(f.orgId), 'no owner row should have been created').toBe(before);
  });
});

describe('Drawing limit (DEF-470 item 4) — the comma leg is ALREADY green (parseMoneyInput already wraps it)', () => {
  it('⛔ green, unedited — "1,5" already refuses by name, byte-identical before and after this task', async () => {
    const f = await ownerCandidateFixture('dl-green');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createOwner(tx, f.admin, {
          storeId: f.storeId,
          personId: f.candidateId,
          drawingLimit: '1,5',
          drawingLimitPeriod: 'monthly',
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "1,5" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The drawing limit — "1,5" is not a valid amount. Use at most two decimal places.');
  });
});

describe('Drawing limit (DEF-470 item 4) — "0" with a period refuses by name, backing the dropped min="0.01"', () => {
  it('wanted: "A drawing limit has to be greater than zero." — was red before this fix: "a drawing limit has to be greater than zero." (prefix-stripped, lowercase)', async () => {
    const f = await ownerCandidateFixture('dl-zero');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createOwner(tx, f.admin, {
          storeId: f.storeId,
          personId: f.candidateId,
          drawingLimit: '0',
          drawingLimitPeriod: 'monthly',
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "0" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('A drawing limit has to be greater than zero.');
  });
});

// =================================================================================================
// Item 5 — agreed amount (owners/index.ts closeDrawingMonth:624-634)
// =================================================================================================
//
// ⛔ Not ownerCandidateFixture — closeDrawingMonth needs a real owner WITH a drawing already posted,
// so `ledger` (:624-629) is nonzero and `difference` is computed against something. Measured
// directly (zzprobe9.test.ts, created then deleted, against shareat_test_t343s5_tester) before
// writing these two legs — `Number(input.acknowledgedAmount)` (:631) is a raw `Number()`, no
// parseMoneyInput at all, so a comma-typed "1,5" becomes NaN and takes TWO different wrong paths
// depending on whether a reason is given:
//   - WITH a reason (adjustmentReason set): `magnitude = Math.abs(NaN).toFixed(2)` = "NaN" is
//     written straight into `journal_lines.debit`/`credit` (post-entry.ts:206-207, no validation) —
//     a raw PostgresError (23514) on `journal_lines_debit_finite_check`, `userMessage: undefined`.
//   - NO reason: `difference` is also NaN, so `difference !== 0` is true and the "say why" guard
//     (:643-650) fires first — but it interpolates the raw NaN into the sentence itself
//     ("the agreed ₱NaN differs from the ledger's ₱12000.00 by ₱NaN — say why"), no userMessage,
//     leaking the malformed value instead of naming the field.

async function ownerWithDrawingFixture(hint: string) {
  const f = await orgFixture(hint);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${f.orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Ana') returning id`;
  const anaId = staff!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${anaId}, ${f.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${anaId}, ${f.storeId})`;
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  // Cash to draw against, so the overdraft guard is not the thing under test.
  await sql.begin(async (tx) => {
    const [period] = await tx<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1`;
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${f.orgId} and code in ('1110', '3900')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get('1110')!}, ${f.storeId}, '500000.00', '0'), (${e!.id}, 2, ${by.get('3900')!}, ${f.storeId}, '0', '500000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
  const created = await asOrg(f.orgId, (tx) => createOwner(tx, f.admin, { storeId: f.storeId, personId: anaId, role: 'Managing Partner' }));
  const recordDrawingFn = (await import('@shareat/domain')).recordDrawing;
  await asOrg(f.orgId, (tx) => recordDrawingFn(tx, f.admin, { ownerId: created.id, amount: '12000.00', fromMoneyAccountId: till!.id, on: '2026-01-10' }));
  return { ...f, ownerId: created.id };
}

describe('Agreed amount (DEF-470 item 5) — comma-typed acknowledgedAmount, WITH a reason', () => {
  it('wanted: "The agreed amount — \\"1,5\\" is not a valid amount. Use at most two decimal places." — was red before this fix: a raw PostgresError (23514) on journal_lines_debit_finite_check, userMessage undefined', async () => {
    const f = await ownerWithDrawingFixture('ag-reason');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        closeDrawingMonth(tx, f.admin, {
          ownerId: f.ownerId,
          month: '2026-01-01',
          acknowledgedAmount: '1,5',
          adjustmentReason: 'testing comma',
          on: '2026-02-01',
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "1,5" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The agreed amount — "1,5" is not a valid amount. Use at most two decimal places.');
  });
});

describe('Agreed amount (DEF-470 item 5) — comma-typed acknowledgedAmount, NO reason', () => {
  it('wanted: same field sentence (the target wraps :631 unconditionally, before the "say why" branch) — was red before this fix: NaN leaked into the "say why" sentence itself', async () => {
    const f = await ownerWithDrawingFixture('ag-noreason');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        closeDrawingMonth(tx, f.admin, { ownerId: f.ownerId, month: '2026-01-01', acknowledgedAmount: '1,5', on: '2026-02-01' }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "1,5" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The agreed amount — "1,5" is not a valid amount. Use at most two decimal places.');
  });
});

// =================================================================================================
// C1-C4 — returned/short amounts (cash-requests/index.ts settleCashRequest, item 6)
// =================================================================================================

async function cashRequestFixture(hint: string) {
  const f = await orgFixture(hint);
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Staff') returning id`;
  const staffId = staff!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${f.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staffId}, ${f.storeId})`;
  // T-318 — 'staff' no longer holds create_expense (or the other everyday capabilities) on the
  // bare role matrix; createCashRequest needs it, same as the precedent fixture
  // (cash-requests.test.ts's own grantStaffAccess).
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${f.orgId}, ${f.storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId: f.orgId, storeId: f.storeId, employmentId: employment!.id, personId: staffId, setBy: f.admin.personId });
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  return { ...f, staffId, staff: actor(f.orgId, staffId), till: till!.id };
}

/** A request approved and released for `amount` (₱2,000 by default — plenty of room for every
 *  leg below, none of which comes near the outstanding-amount guard). */
async function released(f: Awaited<ReturnType<typeof cashRequestFixture>>, amount = '2000.00'): Promise<string> {
  const req = await asOrg(f.orgId, (tx) =>
    createCashRequest(tx, f.staff, { storeId: f.storeId, requestedFor: f.staffId, purpose: 'Market run', amount, on: '2026-01-05' }),
  );
  await asOrg(f.orgId, (tx) => decideCashRequest(tx, f.admin, { requestId: req.id, decision: 'approve', amount, on: '2026-01-05' }));
  await asOrg(f.orgId, (tx) => releaseCashRequest(tx, f.admin, { requestId: req.id, amount, fromMoneyAccountId: f.till, on: '2026-01-05' }));
  return req.id;
}

async function returnRowCount(orgId: string, requestId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from journal_entries where org_id = ${orgId} and source_type = 'cash_request_return' and source_id = ${requestId}`;
  return Number(row!.count);
}
async function shortageRowCount(orgId: string, requestId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from journal_entries where org_id = ${orgId} and source_type = 'cash_request_shortage' and source_id = ${requestId}`;
  return Number(row!.count);
}

const NEGATIVE_SENTENCE = 'A returned or short amount cannot be negative.';

describe('C1 (DEF-470) — returnedAmount "1,000" (comma), shortAmount "100": the return silently vanished (NaN > 0 is false)', () => {
  it('wanted: the returned-amount sentence, nothing posted — was red before this fix: only the shortage posted, no refusal', async () => {
    const f = await cashRequestFixture('c1');
    const requestId = await released(f);
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        settleCashRequest(tx, f.admin, {
          requestId,
          returnedAmount: '1,000',
          shortAmount: '100',
          shortReason: 'Lost',
          toMoneyAccountId: f.till,
          on: '2026-01-10',
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "1,000" to be refused at all — measured pre-fix: it silently succeeded instead').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The returned amount — "1,000" is not a valid amount. Use at most two decimal places.');
    expect(await returnRowCount(f.orgId, requestId), 'no return entry').toBe(0);
    expect(await shortageRowCount(f.orgId, requestId), 'no shortage entry either — nothing posted at all').toBe(0);
  });
});

describe('C2 (DEF-470) — returnedAmount "1,000" (comma) alone: nothing posted, no refusal, no throw at all', () => {
  it('wanted: the returned-amount sentence — was red before this fix: it silently succeeded with nothing posted', async () => {
    const f = await cashRequestFixture('c2');
    const requestId = await released(f);
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        settleCashRequest(tx, f.admin, { requestId, returnedAmount: '1,000', toMoneyAccountId: f.till, on: '2026-01-10' }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "1,000" to be refused at all — measured pre-fix: it silently succeeded instead').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The returned amount — "1,000" is not a valid amount. Use at most two decimal places.');
    expect(await returnRowCount(f.orgId, requestId)).toBe(0);
  });
});

describe('C3 (DEF-470) — returnedAmount "100", shortAmount "-5": the return posted, the negative shortage silently skipped', () => {
  it('wanted: "A returned or short amount cannot be negative.", nothing posted — was red before this fix: the return posted for real, the shortage silently dropped', async () => {
    const f = await cashRequestFixture('c3');
    const requestId = await released(f);
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        settleCashRequest(tx, f.admin, {
          requestId,
          returnedAmount: '100',
          shortAmount: '-5',
          toMoneyAccountId: f.till,
          on: '2026-01-10',
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "-5" short to be refused at all — measured pre-fix: the return posted instead').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe(NEGATIVE_SENTENCE);
    expect(await returnRowCount(f.orgId, requestId), 'the return must NOT have posted').toBe(0);
    expect(await shortageRowCount(f.orgId, requestId)).toBe(0);
  });
});

describe('C4 (DEF-470) — returnedAmount "-5" alone: today\'s message is "nothing to settle", the wrong reason', () => {
  it('wanted: "A returned or short amount cannot be negative." — was red before this fix: "nothing to settle — give a return, a shortage, or both." (an order bug, not a missing check)', async () => {
    const f = await cashRequestFixture('c4');
    const requestId = await released(f);
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        settleCashRequest(tx, f.admin, { requestId, returnedAmount: '-5', toMoneyAccountId: f.till, on: '2026-01-10' }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected "-5" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe(NEGATIVE_SENTENCE);
    expect(await returnRowCount(f.orgId, requestId)).toBe(0);
  });
});

// =================================================================================================
// Item 7 — remittance line amount (apps/erp/src/app/remittance/actions.ts createRemittanceAction)
// =================================================================================================

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

async function remittanceFixture(hint: string) {
  const f = await orgFixture(hint);
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return { ...f, tillId: till!.id, officeId: office!.id };
}

function remittanceFormData(f: Awaited<ReturnType<typeof remittanceFixture>>, lineAmount: string): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('remittedOn', '2026-01-15');
  fd.append('lineAccountId', f.tillId);
  fd.set('lineTo_0', f.officeId);
  fd.set('lineAmount_0', lineAmount);
  return fd;
}

async function remittanceCountFor(orgId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from remittances where org_id = ${orgId}`;
  return Number(row!.count);
}

describe('Remittance line amount (DEF-470 item 7) — the comma leg is ALREADY green (parseMoneyInput already wraps it, account-named)', () => {
  it('⛔ green, unedited — "1,5" already refuses by name, account-named, byte-identical before and after this task', async () => {
    const f = await remittanceFixture('rem-green');
    ACTOR_HOLDER.actor = f.admin;
    const { createRemittanceAction } = await import('../../src/app/remittance/actions');

    const to = await expectRedirectTo(() => createRemittanceAction(remittanceFormData(f, '1,5')));
    const params = paramsOf(to);
    const error = params.get('error');
    expect(error, `redirect URL was: ${to}`).toContain('is not a valid amount. Use at most two decimal places.');
    expect(error).toMatch(/^".*": /);
  });
});

describe('Remittance line amount (DEF-470 item 7) — a negative amount is silently dropped, backing the missing min="0"', () => {
  it(
    'wanted: "<account>": the amount handed over cannot be negative." — was red before this fix: ' +
      'measured, not presumed — with only this one (negative) line, `handedOverOn` today just returns ' +
      'false (no throw: `Number(-500) > 0` is false), so `lines` ends up empty and the visible error ' +
      'was the generic "Enter what was handed over from at least one account." — never naming the account or the real problem',
    async () => {
      const f = await remittanceFixture('rem-neg');
      ACTOR_HOLDER.actor = f.admin;
      const { createRemittanceAction } = await import('../../src/app/remittance/actions');

      const before = await remittanceCountFor(f.orgId);
      const to = await expectRedirectTo(() => createRemittanceAction(remittanceFormData(f, '-500')));
      const params = paramsOf(to);
      const error = params.get('error');
      expect(error, `redirect URL was: ${to}`).toMatch(/": the amount handed over cannot be negative\.$/);
      expect(await remittanceCountFor(f.orgId), 'nothing should have been recorded').toBe(before);
    },
  );
});

// =================================================================================================
// Item 8 — channel settlement figures (packages/domain/src/channel-settlements/index.ts)
// =================================================================================================

async function channelSettlementFixture(hint: string) {
  const f = await orgFixture(hint);
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${f.orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${f.storeId})`;
  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${f.orgId}, ${f.storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;
  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
    values (${f.orgId}, ${f.storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${bank!.id}) returning id`;
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${f.storeId}, '2026-01-10', 0, 0, 0, ${manager!.id}) returning id`;
  const manager_ = actor(f.orgId, manager!.id);
  return { ...f, manager: manager_, channelId: channel!.id, salesDayId: day!.id, bankId: bank!.id };
}

/** Raise the receivable a verified channel-day would have raised, the same shape
 *  `channel-settlements.test.ts`'s own `raiseReceivable` uses. */
async function raiseReceivable(f: Awaited<ReturnType<typeof channelSettlementFixture>>, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-10', ${period!.id}, 'sales_day', ${uid('sd')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${f.orgId} and code in ('1220', '4150')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, ${by.get('1220')!}, ${f.storeId}, ${amount}, '0', 'channel', ${f.channelId}),
             (${e!.id}, 2, ${by.get('4150')!}, ${f.storeId}, '0', ${amount}, null, null)`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function settlementCountFor(orgId: string, channelId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from channel_settlements where org_id = ${orgId} and channel_id = ${channelId}`;
  return Number(row!.count);
}

describe('X1 (DEF-470 item 8) — a comma-typed deduction reaches raw Number(), no parse exists today at all', () => {
  it('wanted: refused by name — measured, not presumed: probed directly before writing this assertion', async () => {
    const f = await channelSettlementFixture('x1');
    await raiseReceivable(f, '100000.00');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        recordChannelSettlement(tx, f.manager, {
          storeId: f.storeId,
          channelId: f.channelId,
          salesDayId: f.salesDayId,
          businessDate: '2026-01-10',
          grossAmount: '100000.00',
          netDeposited: '79500.00',
          deductions: { commission: '1,000' },
          settledOn: '2026-01-15',
        } as never),
      );
    } catch (err) {
      caught = err;
    }
    // ⚠️ Measured directly (probed before writing this assertion), not the mechanism guessed from
    // reading `computeSettlement` alone: `Number('1,000')` is `NaN`, `feesTotal` becomes `NaN`, and
    // `blockers` stays empty (every comparison against a NaN is `false`) — so `computeSettlement`
    // itself raises no refusal. But the settlement does NOT quietly post: for `commission`
    // specifically the write hits `channel_settlements_commission_finite_check` (T-327's 160-column
    // NaN-guard, migration 0155) — a raw `PostgresError` (23514), no `userMessage`, the constraint
    // name never shown. `wanted`: refused by name before the write is ever attempted.
    expect(caught, 'wanted: refused by name — was red before this fix: an unpresentable raw PostgresError (23514)').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The commission — "1,000" is not a valid amount. Use at most two decimal places.');
    expect(await settlementCountFor(f.orgId, f.channelId), 'no settlement row should have been created').toBe(0);
  });
});

describe('Deductions (DEF-470 item 8) — a comma-typed value refuses by name, one per deduction', () => {
  const DEDUCTIONS = ['commission', 'platformFee', 'vatOnFees', 'marketing', 'withholdingTax', 'penalty'] as const;
  const LABELS: Record<(typeof DEDUCTIONS)[number], string> = {
    commission: 'The commission',
    platformFee: 'The platform fee',
    vatOnFees: 'The VAT on fees',
    marketing: 'The channel marketing',
    withholdingTax: 'The withholding tax',
    penalty: 'The penalty',
  };

  // ⚠️ Re-measured field-by-field (not assumed uniform from X1's commission result): every field
  // hits a raw PostgresError (23514), but WHICH check constraint fires first is not the same for
  // all six. `commission` hits its own `channel_settlements_commission_finite_check`, same as X1.
  // The other five (platformFee, vatOnFees, marketing, withholdingTax, penalty) instead hit
  // `channel_settlements_identity_check` (migration 0057) first — its SUM formula includes every
  // deduction and `loan_deduction`, so a NaN in ANY addend fails `abs(...) < 0.005` before that
  // column's own (migration 0155) `_finite_check` is ever reached. Either way: no `userMessage`.
  it.each(DEDUCTIONS)('%s: "1,000" refuses by name — was red before this fix: an unpresentable raw PostgresError (23514), measured per-field, not assumed uniform', async (name) => {
    const f = await channelSettlementFixture(`ded-${name}`);
    await raiseReceivable(f, '100000.00');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        recordChannelSettlement(tx, f.manager, {
          storeId: f.storeId,
          channelId: f.channelId,
          salesDayId: f.salesDayId,
          businessDate: '2026-01-10',
          grossAmount: '100000.00',
          netDeposited: '79500.00',
          deductions: { [name]: '1,000' },
          settledOn: '2026-01-15',
        } as never),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, `expected ${name}="1,000" to be refused at all`).toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe(`${LABELS[name]} — "1,000" is not a valid amount. Use at most two decimal places.`);
    expect(await settlementCountFor(f.orgId, f.channelId)).toBe(0);
  });
});

describe('Amount docked (DEF-470 item 8) — comma leg + negative range guard', () => {
  it('"1,000" refuses by name — was red before this fix: measured — an unpresentable raw PostgresError (23514, channel_settlements_identity_check), not the finite_check the deductions hit', async () => {
    const f = await channelSettlementFixture('loan-comma');
    await raiseReceivable(f, '100000.00');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        recordChannelSettlement(tx, f.manager, {
          storeId: f.storeId,
          channelId: f.channelId,
          salesDayId: f.salesDayId,
          businessDate: '2026-01-10',
          grossAmount: '100000.00',
          netDeposited: '79500.00',
          loan: { loanId: '00000000-0000-0000-0000-000000000000', amount: '1,000' },
          settledOn: '2026-01-15',
        } as never),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected loan amount "1,000" to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    // T-440: the rule's own sentence (CHANNEL_SETTLEMENT_RECORD_RULES.loanAmount) wins over the old domain sentence.
    expect(err.userMessage).toBe('The amount docked — "1,000" is not a valid amount. Use at most two decimal places.');
  });

  it(
    '"-5" refuses "The amount docked cannot be negative." — was red before this fix: measured — a REAL negative number ' +
      '(not NaN) flows straight into the arithmetic as `loanDeduction`, which SUBTRACTS from the difference and makes the ' +
      'day read as short by an unrelated ₱20,505 past tolerance — a genuine domain throw, but the wrong reason entirely, ' +
      'not this field\'s own refusal',
    async () => {
    const f = await channelSettlementFixture('loan-neg');
    await raiseReceivable(f, '100000.00');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        recordChannelSettlement(tx, f.manager, {
          storeId: f.storeId,
          channelId: f.channelId,
          salesDayId: f.salesDayId,
          businessDate: '2026-01-10',
          grossAmount: '100000.00',
          netDeposited: '79500.00',
          loan: { loanId: '00000000-0000-0000-0000-000000000000', amount: '-5' },
          settledOn: '2026-01-15',
        } as never),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected a negative loan amount to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBe('The amount docked must be an amount of 0 or more.');
  });
});

// =================================================================================================
// Blank legs — green before AND after this task, unedited. §S5.5s "Blank legs" list.
// =================================================================================================

// ---- separationPayAmount='' (and '   ') — actions.ts:38 `str(fd,'separationPayAmount') || '0'` ----

async function separationFixture(hint: string) {
  const f = await orgFixture(hint);
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Worker') returning id`;
  const staffId = staff!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${f.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staffId}, ${f.storeId})`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${f.orgId}, ${staffId}, ${f.storeId}, ${uid('sep')}, '2026-01-01', 'regular', ${f.admin.personId}) returning id`;
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return { ...f, employmentId: emp!.id, officeAccountId: office!.id };
}

function separationFormData(f: Awaited<ReturnType<typeof separationFixture>>, separationPayAmount: string): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('employmentId', f.employmentId);
  fd.set('separationDate', '2026-02-01');
  fd.set('cause', 'resignation');
  fd.set('separationPayAmount', separationPayAmount);
  fd.set('moneyAccountId', f.officeAccountId);
  fd.set('clearanceConfirmed', 'on');
  fd.set('adminPin', f.pin);
  return fd;
}

async function separationPayAmountOf(orgId: string, employmentId: string): Promise<string> {
  const [row] = await sql<{ v: string }[]>`
    select separation_pay_amount::text as v from separations where org_id = ${orgId} and employment_id = ${employmentId}`;
  return row!.v;
}

describe.each([
  ['blank', ''],
  ['spaces-only', '   '],
])('separationPayAmount %s — ALREADY green: actions.ts:38 defaults to \'0\' before the domain ever sees it', (_label, value) => {
  it('posts with separation pay 0.00, unedited', async () => {
    const f = await separationFixture(`sep-${_label}`);
    ACTOR_HOLDER.actor = f.admin;
    const { postSeparationAction } = await import('../../src/app/payroll/separations/actions');
    await expectRedirectTo(() => postSeparationAction(separationFormData(f, value)));
    expect(await separationPayAmountOf(f.orgId, f.employmentId)).toBe('0.00');
  });
});

// ---- amountIn='' — money-transfers/actions.ts:36 `str(fd,'amountIn') || amountOut` ----

function transferFormData(f: Awaited<ReturnType<typeof transferFixture>>, amountIn: string): FormData {
  const fd = new FormData();
  fd.set('fromMoneyAccountId', f.drawerId);
  fd.set('toMoneyAccountId', f.safeId);
  fd.set('amountOut', '100.00');
  fd.set('amountIn', amountIn);
  fd.set('transferDate', '2026-01-10');
  return fd;
}

async function lastTransferAmounts(orgId: string): Promise<{ amountOut: string; amountIn: string }> {
  const [row] = await sql<{ amount_out: string; amount_in: string }[]>`
    select amount_out, amount_in from money_transfers where org_id = ${orgId} order by created_at desc limit 1`;
  return { amountOut: row!.amount_out, amountIn: row!.amount_in };
}

describe('amountIn blank — ALREADY green: actions.ts:36 defaults amountIn to amountOut, unedited', () => {
  it('the transfer records amountIn = amountOut', async () => {
    const f = await transferFixture('amtin-blank');
    ACTOR_HOLDER.actor = f.admin;
    const { createMoneyTransferAction } = await import('../../src/app/money-transfers/actions');
    await expectRedirectTo(() => createMoneyTransferAction(transferFormData(f, '')));
    const row = await lastTransferAmounts(f.orgId);
    expect(row.amountIn).toBe(row.amountOut);
    expect(row.amountIn).toBe('100.00');
  });
});

// ---- returnedAmount='100', shortAmount='' (and '   ') — settleCashRequest ALREADY green: the
// domain only skips its parse when `shortAmount === undefined` (:318), and cash-requests/
// actions.ts:120 `...(shortAmount ? { shortAmount } : {})` already omits the key entirely for a
// blank/spaces-only field (`str()` trims first) — measured, an explicit '' would NOT be blank-safe
// at the domain layer, so the fixture calls it exactly as the action does: key omitted ----

describe.each(['blank', 'spaces-only'])('shortAmount %s alongside a real returnedAmount — ALREADY green, unedited', (_label) => {
  it('the return alone posts, no shortage row', async () => {
    const f = await cashRequestFixture(`short-${_label}`);
    const requestId = await released(f);
    await asOrg(f.orgId, (tx) => settleCashRequest(tx, f.admin, { requestId, returnedAmount: '100', toMoneyAccountId: f.till, on: '2026-01-10' }));
    expect(await returnRowCount(f.orgId, requestId), 'the return must have posted').toBe(1);
    expect(await shortageRowCount(f.orgId, requestId), 'no shortage — blank means none').toBe(0);
  });
});

// ---- overdraftLimit='' (and '   '), '0', '500' — renameMoneyAccount:231-238, ALREADY green ----

describe.each([
  ['blank', ''],
  ['spaces-only', '   '],
])('overdraftLimit %s — ALREADY green: the limit key is omitted from the update entirely, unedited', (_label, value) => {
  it('the limit stays unchanged — at the foundation default, 20000.00 (money_accounts.overdraft_limit default), not 0', async () => {
    const f = await cashierDrawerFixture(`ov-${_label}`);
    await asOrg(f.orgId, (tx) => renameMoneyAccount(tx, f.admin, { moneyAccountId: f.accountId, name: 'Cash drawer', overdraftLimit: value }));
    expect(await overdraftLimitOf(f.accountId)).toBe('20000.00');
  });
});

describe('overdraftLimit real values — ALREADY green, unedited', () => {
  it('"0" sets the limit to 0.00 (distinct from blank: the key IS written)', async () => {
    const f = await cashierDrawerFixture('ov-zero-real');
    await asOrg(f.orgId, (tx) => renameMoneyAccount(tx, f.admin, { moneyAccountId: f.accountId, name: 'Cash drawer', overdraftLimit: '0' }));
    expect(await overdraftLimitOf(f.accountId)).toBe('0.00');
  });
  it('"500" sets the limit to 500.00', async () => {
    const f = await cashierDrawerFixture('ov-500');
    await asOrg(f.orgId, (tx) => renameMoneyAccount(tx, f.admin, { moneyAccountId: f.accountId, name: 'Cash drawer', overdraftLimit: '500' }));
    expect(await overdraftLimitOf(f.accountId)).toBe('500.00');
  });
});

// ---- ownershipPercentage='' — createOwner already treats blank as "not set", ALREADY green ----

describe('ownershipPercentage blank — ALREADY green, unedited', () => {
  it('the owner is created with ownershipPercentage null', async () => {
    // ⚠️ owners/actions.ts:47 `str(fd,'ownershipPercentage') || null` — the ACTION converts a blank
    // form field to `null` before the domain ever sees it. `createOwner` itself does NOT treat ''
    // as blank (measured: it fails the `\d{1,3}` regex and refuses) — only `null`/`undefined` skip
    // the parse. Passing `null` here is what a blank form field actually becomes by the time it
    // reaches the domain, same translation W1/W2 already assume for '1,5'/'150' as raw strings.
    const f = await ownerCandidateFixture('own-blank');
    const created = await asOrg(f.orgId, (tx) =>
      createOwner(tx, f.admin, { storeId: f.storeId, personId: f.candidateId, ownershipPercentage: null }),
    );
    const [row] = await sql<{ v: string | null }[]>`select ownership_percentage as v from owners where id = ${created.id}`;
    expect(row!.v).toBeNull();
  });
});

// ---- acknowledgedAmount omitted — closeDrawingMonth:630 already closes at the ledger figure ----

describe('acknowledgedAmount omitted — ALREADY green, unedited', () => {
  it('closes at the ledger figure (12000.00), no adjustment', async () => {
    const f = await ownerWithDrawingFixture('ack-omitted');
    const result = await asOrg(f.orgId, (tx) => closeDrawingMonth(tx, f.admin, { ownerId: f.ownerId, month: '2026-01-01', on: '2026-02-01' }));
    expect(result.acknowledgedAmount).toBe('12000.00');
    expect(result.adjustmentAmount).toBeNull();
  });
});

// ---- lineOverage_0='' — remittance/actions.ts:77 `str(fd,'lineOverage_0') || null`, ALREADY green ----

/** A verified sales day for a date — the LOCK that makes the date remittable (createRemittance's
 *  own precondition), same shape as remittance.test.ts's own `verifiedDay`. */
async function verifiedDay(f: Awaited<ReturnType<typeof remittanceFixture>>, date: string): Promise<void> {
  await sql`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${f.storeId}, ${date}, 'verified', '0', '0', '0', ${f.admin.personId})`;
}

/** A till sale — verified alone is not enough; createRemittance also requires `owed > 0` for the
 *  day to be `settleable` (§ remittance.test.ts's own `tillMovement`). */
async function tillMovement(f: Awaited<ReturnType<typeof remittanceFixture>>, date: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${f.orgId} and code in ('1110', '4100')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get('1110')!}, ${f.storeId}, ${amount}, '0'), (${e!.id}, 2, ${by.get('4100')!}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

describe('lineOverage_0 blank — ALREADY green: actions.ts:77 already maps blank to null, unedited', () => {
  it('the line posts with declaredOverage null', async () => {
    const f = await remittanceFixture('overage-blank');
    await verifiedDay(f, '2026-01-15');
    await tillMovement(f, '2026-01-15', '100.00');
    ACTOR_HOLDER.actor = f.admin;
    const { createRemittanceAction } = await import('../../src/app/remittance/actions');
    const fd = remittanceFormData(f, '100.00');
    // lineOverage_0 left unset — blank, same as fd.set('lineOverage_0', '').
    const to = await expectRedirectTo(() => createRemittanceAction(fd));
    expect(paramsOf(to).get('error'), `expected success, got redirect: ${to}`).toBeNull();
    const [row] = await sql<{ v: string | null }[]>`
      select rl.declared_overage as v from remittance_lines rl
        join remittances r on r.id = rl.remittance_id
       where r.org_id = ${f.orgId}`;
    expect(row!.v).toBeNull();
  });
});

// ---- a blank deduction → '0', loanId set with loanAmount='' → no loan — channel-settlements
// actions.ts:32-34 money() and :116-117 hasLoan, ALREADY green ----

async function settlementFormData(f: Awaited<ReturnType<typeof channelSettlementFixture>>, over: Record<string, string> = {}): Promise<FormData> {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('channelId', f.channelId);
  fd.set('salesDayId', f.salesDayId);
  fd.set('businessDate', '2026-01-10');
  fd.set('grossAmount', '100000.00');
  fd.set('netDeposited', '79500.00');
  fd.set('settledOn', '2026-01-15');
  fd.set('commission', '20500.00');
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

describe('a blank deduction — ALREADY green: actions.ts:33 money() defaults blank to \'0\', unedited', () => {
  it('marketing left blank settles with marketing 0.00, no refusal', async () => {
    const f = await channelSettlementFixture('ded-blank');
    await raiseReceivable(f, '100000.00');
    ACTOR_HOLDER.actor = f.manager;
    const { recordSettlementAction } = await import('../../src/app/channel-settlements/actions');
    const fd = await settlementFormData(f);
    fd.delete('marketing');
    await expectRedirectTo(() => recordSettlementAction(fd));
    const [row] = await sql<{ marketing: string }[]>`
      select marketing::text from channel_settlements where org_id = ${f.orgId} and channel_id = ${f.channelId}`;
    expect(row!.marketing).toBe('0.00');
  });
});

describe('loanId set, loanAmount blank — ALREADY green: actions.ts:117 hasLoan is false, unedited', () => {
  it('settles with no loan recorded at all', async () => {
    const f = await channelSettlementFixture('loan-blank');
    await raiseReceivable(f, '100000.00');
    ACTOR_HOLDER.actor = f.manager;
    const { recordSettlementAction } = await import('../../src/app/channel-settlements/actions');
    const fd = await settlementFormData(f, { loanId: '00000000-0000-0000-0000-000000000000', loanAmount: '' });
    await expectRedirectTo(() => recordSettlementAction(fd));
    const [row] = await sql<{ loan_id: string | null }[]>`
      select loan_id from channel_settlements where org_id = ${f.orgId} and channel_id = ${f.channelId}`;
    expect(row!.loan_id).toBeNull();
  });
});
