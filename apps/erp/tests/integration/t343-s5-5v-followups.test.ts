/**
 * T-343 S5.5v — DEF-472 census (money / integer count / rate boxes), action level.
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5v items 1-8, Ian's Q1 ruling, and
 * Amendment A1 (previewChannelSettlement collects refusals instead of throwing the first one).
 *
 * ⛔ TESTER, not BUILDER. Every "wanted" sentence is the TARGET the builder has not written yet;
 * every "observed today" comment is the actual pre-fix result, MEASURED against this file's own
 * lane database (`shareat_test_t343s5_tester`), never presumed.
 *
 * ⚠️ **Scope trim, declared rather than silent:** the two remaining SAFE comma-leg sites — payroll
 * pay rate (`payroll/index.ts:72-75`) and service-charge distribute (`service-charge/index.ts:50,
 * 82-83`) — are asserted by the spec's own line-cited source read (both already call
 * `parseMoneyInput`/a plain `<= 0` guard), not by an executed round trip here: building a full
 * employment/attendance fixture and a service-charge pool fixture for two already-green,
 * already-covered-elsewhere sites was judged disproportionate to what it would additionally prove.
 * Say so if a real round trip is wanted for either.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

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

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createItem, createSupplier, openTillShift } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';

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

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const errorOf = (to: string) => new URL(to, 'http://localhost').searchParams.get('error');
const okOf = (to: string) => new URL(to, 'http://localhost').searchParams.get('ok');

const DATABASE_ERROR_FALLBACK =
  'The database refused that change for a reason this screen cannot show. The detail is in the server log.';
const UNMAPPED_LOANS = "That change isn't allowed for loans — please check the values you entered.";

// =================================================================================================
// Shared org/store/admin/super-admin fixture — every domain area below builds on this.
// =================================================================================================

async function orgWithAdmin(hint: string) {
  const code = uid(`s55v-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;
  const [superAdmin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${superAdmin!.id}, ${orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${superAdmin!.id}, ${storeId})`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  return { orgId, storeId, admin: actor(orgId, admin!.id), superAdmin: actor(orgId, superAdmin!.id) };
}
type OrgFixture = Awaited<ReturnType<typeof orgWithAdmin>>;

async function drawerOf(f: OrgFixture): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  return row!.id;
}

// =================================================================================================
// Cash requests — createRequestAction / decideAction / releaseAction
// =================================================================================================

async function cashRequestFixture(hint: string) {
  const f = await orgWithAdmin(hint);
  const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Worker') returning id`;
  return { ...f, workerId: worker!.id };
}

function requestFormData(f: Awaited<ReturnType<typeof cashRequestFixture>>, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('requestedFor', f.workerId);
  fd.set('purpose', 'Test');
  fd.set('amount', '1000.00');
  fd.set('on', '2026-01-10');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

async function requestCountFor(orgId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from cash_requests where org_id = ${orgId}`;
  return Number(row!.count);
}

describe('Comma legs — SAFE sites (green pins, already parsed via parseMoneyInput today)', () => {
  it('createRequestAction: amount="1,5" already refuses by name', async () => {
    const f = await cashRequestFixture('cr-safe');
    ACTOR_HOLDER.actor = f.admin;
    const { createRequestAction } = await import('../../src/app/cash-requests/actions');
    const before = await requestCountFor(f.orgId);
    const to = await expectRedirectTo(() => createRequestAction(requestFormData(f, { amount: '1,5' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The amount requested — "1,5" is not a valid amount. Use at most two decimal places.');
    expect(await requestCountFor(f.orgId)).toBe(before);
  });

  it('decideAction: approve amount="1,5" already refuses by name', async () => {
    const f = await cashRequestFixture('cr-approve-safe');
    ACTOR_HOLDER.actor = f.admin;
    const { createRequestAction, decideAction } = await import('../../src/app/cash-requests/actions');
    const to0 = await expectRedirectTo(() => createRequestAction(requestFormData(f)));
    const requestId = to0.match(/cash-requests\/([^?]+)/)![1]!;
    const fd = new FormData();
    fd.set('requestId', requestId);
    fd.set('amount', '1,5');
    const to = await expectRedirectTo(() => decideAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The approved amount — "1,5" is not a valid amount. Use at most two decimal places.');
  });
});

async function approvedRequestFixture(hint: string, approvedAmount = '1000.00') {
  const f = await cashRequestFixture(hint);
  const { createRequestAction, decideAction } = await import('../../src/app/cash-requests/actions');
  ACTOR_HOLDER.actor = f.admin;
  const to0 = await expectRedirectTo(() => createRequestAction(requestFormData(f)));
  const requestId = to0.match(/cash-requests\/([^?]+)/)![1]!;
  const fd = new FormData();
  fd.set('requestId', requestId);
  fd.set('amount', approvedAmount);
  await expectRedirectTo(() => decideAction(fd));
  const drawerId = await drawerOf(f);
  return { ...f, requestId, drawerId };
}

describe('Comma legs — SAFE: releaseAction amount="1,5" already refuses by name', () => {
  it('refuses, nothing released', async () => {
    const f = await approvedRequestFixture('cr-release-safe');
    ACTOR_HOLDER.actor = f.admin;
    const { releaseAction } = await import('../../src/app/cash-requests/actions');
    const fd = new FormData();
    fd.set('requestId', f.requestId);
    fd.set('amount', '1,5');
    fd.set('fromMoneyAccountId', f.drawerId);
    fd.set('on', '2026-01-10');
    const to = await expectRedirectTo(() => releaseAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The amount released — "1,5" is not a valid amount. Use at most two decimal places.');
  });
});

describe('C1/C2 (DEF-472) — releaseAction amount="0" / "-5" (no positivity guard exists yet)', () => {
  it(
    'C1 "0": wanted "The amount released has to be greater than zero." — observed today (measured): ' +
      '"That change isn\'t allowed for journal lines — please check the values you entered." ' +
      '(journal_lines_exactly_one_side_check: debit=0 AND credit=0 both, an unmapped CHECK)',
    async () => {
      const f = await approvedRequestFixture('c1');
      ACTOR_HOLDER.actor = f.admin;
      const { releaseAction } = await import('../../src/app/cash-requests/actions');
      const fd = new FormData();
      fd.set('requestId', f.requestId);
      fd.set('amount', '0');
      fd.set('fromMoneyAccountId', f.drawerId);
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => releaseAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The amount released has to be greater than zero.');
    },
  );

  it(
    'C2 "-5": wanted same sentence — observed today (measured): "That change isn\'t allowed for ' +
      'journal lines — please check the values you entered." (journal_lines_amounts_nonnegative_check, ' +
      'a DIFFERENT unmapped CHECK producing the SAME generic screen text today)',
    async () => {
      const f = await approvedRequestFixture('c2');
      ACTOR_HOLDER.actor = f.admin;
      const { releaseAction } = await import('../../src/app/cash-requests/actions');
      const fd = new FormData();
      fd.set('requestId', f.requestId);
      fd.set('amount', '-5');
      fd.set('fromMoneyAccountId', f.drawerId);
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => releaseAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The amount released has to be greater than zero.');
    },
  );
});

describe('Converted guards — createRequestAction/decideAction amount="0" (existing guards, reworded)', () => {
  it(
    'requested "0": wanted "The amount requested has to be greater than zero." — observed today ' +
      '(measured): "the amount has to be greater than zero." (prefix-stripped plain Error, lowercase "the")',
    async () => {
      const f = await cashRequestFixture('conv-req');
      ACTOR_HOLDER.actor = f.admin;
      const { createRequestAction } = await import('../../src/app/cash-requests/actions');
      const to = await expectRedirectTo(() => createRequestAction(requestFormData(f, { amount: '0' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The amount requested has to be greater than zero.');
    },
  );

  it(
    'approved "0": wanted "The approved amount has to be greater than zero." — observed today ' +
      '(measured): "an approved amount has to be greater than zero." (prefix-stripped, lowercase "an")',
    async () => {
      const f = await cashRequestFixture('conv-approve');
      ACTOR_HOLDER.actor = f.admin;
      const { createRequestAction, decideAction } = await import('../../src/app/cash-requests/actions');
      const to0 = await expectRedirectTo(() => createRequestAction(requestFormData(f)));
      const requestId = to0.match(/cash-requests\/([^?]+)/)![1]!;
      const fd = new FormData();
      fd.set('requestId', requestId);
      fd.set('amount', '0');
      const to = await expectRedirectTo(() => decideAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The approved amount has to be greater than zero.');
    },
  );
});

// =================================================================================================
// Loans — createLoanAction / disburseLoanAction / recordPaymentAction
// =================================================================================================

function loanFormData(f: OrgFixture, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('lenderName', 'Test Lender');
  fd.set('name', 'Test Loan');
  fd.set('principalAmount', '100000.00');
  fd.set('interestRate', '5.0000');
  fd.set('ratePeriod', 'month');
  fd.set('interestMethod', 'straight');
  fd.set('paymentFrequency', 'monthly');
  fd.set('termPeriods', '12');
  fd.set('startDate', '2026-01-01');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}
async function loanCountFor(orgId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from loans where org_id = ${orgId}`;
  return Number(row!.count);
}

const PRINCIPAL_SENTENCE = 'The amount agreed has to be greater than zero.';
const RATE_SENTENCE = (raw: string) =>
  `The interest rate — "${raw}" is not a valid rate. Use a number from 0 to 9999.9999 with up to four decimal places.`;
const PAYMENTS_SENTENCE = (raw: string) => `The number of payments — "${raw}" is not a whole number from 1 to 99999.`;
const PAYMENTS_BLANK_SENTENCE = 'The number of payments — enter a whole number from 1 to 99999.';

const PRINCIPAL_COMMA_SENTENCE = 'The amount agreed — "1,5" is not a valid amount. Use at most two decimal places.';

describe('principal comma leg (Tier 2, no server parse)', () => {
  it(
    `wanted: "${PRINCIPAL_COMMA_SENTENCE}" (parseMoneyInput, not yet built) — observed today ` +
      `(measured): "${DATABASE_ERROR_FALLBACK}" (PostgresError 22P02 invalid input syntax for type numeric)`,
    async () => {
      const f = await orgWithAdmin('principal-comma');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const before = await loanCountFor(f.orgId);
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { principalAmount: '1,5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(PRINCIPAL_COMMA_SENTENCE);
      expect(await loanCountFor(f.orgId)).toBe(before);
    },
  );
});

describe('P1 (DEF-472) — createLoanAction principalAmount="0" (unmapped CHECK today)', () => {
  it(
    `wanted: "${PRINCIPAL_SENTENCE}" — observed today (measured): "${UNMAPPED_LOANS}" ` +
      '(loans_principal_positive_check, unmapped)',
    async () => {
      const f = await orgWithAdmin('p1');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const before = await loanCountFor(f.orgId);
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { principalAmount: '0' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(PRINCIPAL_SENTENCE);
      expect(await loanCountFor(f.orgId)).toBe(before);
    },
  );
});

describe('L1/L2 (DEF-472) — interestRate regex refusal', () => {
  it(
    `L1 "1,5": wanted "${RATE_SENTENCE('1,5')}" — observed today (measured): "${DATABASE_ERROR_FALLBACK}" ` +
      '(22P02 invalid input syntax for type numeric)',
    async () => {
      const f = await orgWithAdmin('l1');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { interestRate: '1,5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(RATE_SENTENCE('1,5'));
    },
  );

  it(
    `L2a "-1": wanted "${RATE_SENTENCE('-1')}" — observed today (measured): "${UNMAPPED_LOANS}" ` +
      '(loans_rate_not_negative_check, unmapped)',
    async () => {
      const f = await orgWithAdmin('l2a');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { interestRate: '-1' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(RATE_SENTENCE('-1'));
    },
  );

  it(
    `L2b "12345": wanted "${RATE_SENTENCE('12345')}" — observed today (measured): "${DATABASE_ERROR_FALLBACK}" ` +
      '(22003 numeric field overflow, precision 8 scale 4 — a DIFFERENT mechanism than L2a, same target template)',
    async () => {
      const f = await orgWithAdmin('l2b');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { interestRate: '12345' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(RATE_SENTENCE('12345'));
    },
  );
});

describe('L3/L4/L5 (DEF-472) — termPeriods (action-level Number(str()) today, no app guard)', () => {
  it(
    `L3 "1,5": wanted "${PAYMENTS_SENTENCE('1,5')}" — observed today (measured): "${DATABASE_ERROR_FALLBACK}" ` +
      '(Number(\'1,5\')=NaN -> 22P02 invalid input syntax for type integer)',
    async () => {
      const f = await orgWithAdmin('l3');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { termPeriods: '1,5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(PAYMENTS_SENTENCE('1,5'));
    },
  );

  it(
    `L4 "0": wanted "${PAYMENTS_SENTENCE('0')}" — observed today (measured): "${UNMAPPED_LOANS}" ` +
      '(loans_term_positive_check, unmapped)',
    async () => {
      const f = await orgWithAdmin('l4');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { termPeriods: '0' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(PAYMENTS_SENTENCE('0'));
    },
  );

  it(
    `L5 "" (blank): wanted "${PAYMENTS_BLANK_SENTENCE}" — observed today (measured): "${UNMAPPED_LOANS}" ` +
      "(Number('')=0 -> same unmapped loans_term_positive_check as L4)",
    async () => {
      const f = await orgWithAdmin('l5');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { termPeriods: '' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(PAYMENTS_BLANK_SENTENCE);
    },
  );
});

describe('Comma legs — SAFE: disburseLoanAction / recordPaymentAction already refuse by name', () => {
  async function existingLoan(f: OrgFixture) {
    const to = await expectRedirectTo(() =>
      import('../../src/app/loans/actions').then(({ createLoanAction }) => createLoanAction(loanFormData(f))),
    );
    return to.match(/loans\/([^?]+)/)![1]!;
  }

  it('disburseLoanAction amount="1,5" refuses', async () => {
    const f = await orgWithAdmin('disb-safe');
    ACTOR_HOLDER.actor = f.admin;
    const loanId = await existingLoan(f);
    const { disburseLoanAction } = await import('../../src/app/loans/actions');
    const drawerId = await drawerOf(f);
    const fd = new FormData();
    fd.set('loanId', loanId);
    fd.set('amount', '1,5');
    fd.set('intoMoneyAccountId', drawerId);
    fd.set('on', '2026-01-10');
    const to = await expectRedirectTo(() => disburseLoanAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The loan amount — "1,5" is not a valid amount. Use at most two decimal places.');
  });

  it('recordPaymentAction amount="1,5" refuses', async () => {
    const f = await orgWithAdmin('pay-safe');
    ACTOR_HOLDER.actor = f.admin;
    const loanId = await existingLoan(f);
    const { disburseLoanAction, recordPaymentAction } = await import('../../src/app/loans/actions');
    const drawerId = await drawerOf(f);
    const disburseFd = new FormData();
    disburseFd.set('loanId', loanId);
    disburseFd.set('amount', '50000.00');
    disburseFd.set('intoMoneyAccountId', drawerId);
    disburseFd.set('on', '2026-01-10');
    await expectRedirectTo(() => disburseLoanAction(disburseFd));

    const payFd = new FormData();
    payFd.set('loanId', loanId);
    payFd.set('amount', '1,5');
    payFd.set('fromMoneyAccountId', drawerId);
    payFd.set('on', '2026-01-15');
    const to = await expectRedirectTo(() => recordPaymentAction(payFd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The payment amount — "1,5" is not a valid amount. Use at most two decimal places.');
  });
});

describe('Converted guards — disburseLoanAction/recordPaymentAction amount="0"', () => {
  it(
    'disburse "0": wanted "The loan amount has to be greater than zero." — observed today ' +
      '(measured): "the amount has to be greater than zero." (prefix-stripped, lowercase "the")',
    async () => {
      const f = await orgWithAdmin('conv-disb');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction, disburseLoanAction } = await import('../../src/app/loans/actions');
      const to0 = await expectRedirectTo(() => createLoanAction(loanFormData(f)));
      const loanId = to0.match(/loans\/([^?]+)/)![1]!;
      const drawerId = await drawerOf(f);
      const fd = new FormData();
      fd.set('loanId', loanId);
      fd.set('amount', '0');
      fd.set('intoMoneyAccountId', drawerId);
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => disburseLoanAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The loan amount has to be greater than zero.');
    },
  );
});

// =================================================================================================
// Liabilities — chargeAction / payAction
// =================================================================================================

async function liabilityFixture(hint: string) {
  const f = await orgWithAdmin(hint);
  const [liab] = await sql<{ id: string }[]>`
    insert into liabilities (org_id, store_id, name, category, created_by)
    values (${f.orgId}, ${f.storeId}, 'Test Liability', 'other', ${f.admin.personId}) returning id`;
  return { ...f, liabilityId: liab!.id };
}
async function liabilityChargeCount(orgId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from journal_entries where org_id = ${orgId} and source_type = 'liability_charge'`;
  return Number(row!.count);
}

describe('O3 (DEF-472) — chargeAction amount="1.234" (extra decimal place, valid syntax)', () => {
  it(
    'refused with the charge sentence (T-371: built — was NO ERROR, silently rounded to 1.23); nothing posts',
    async () => {
      const f = await liabilityFixture('o3');
      ACTOR_HOLDER.actor = f.admin;
      const { chargeAction } = await import('../../src/app/liabilities/actions');
      const fd = new FormData();
      fd.set('liabilityId', f.liabilityId);
      fd.set('amount', '1.234');
      fd.set('againstAccountCode', '6100');
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => chargeAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(
        'The charge amount — "1.234" is not a valid amount. Use at most two decimal places.',
      );
      expect(await liabilityChargeCount(f.orgId), 'nothing should have posted').toBe(0);
    },
  );
});

describe('Comma legs — Tier 2: chargeAction/payAction amount="1,5" (no server parse today)', () => {
  it(
    `charge "1,5": a presentable refusal (T-371: built — was "${DATABASE_ERROR_FALLBACK}", 22P02)`,
    async () => {
      const f = await liabilityFixture('liab-charge-comma');
      ACTOR_HOLDER.actor = f.admin;
      const { chargeAction } = await import('../../src/app/liabilities/actions');
      const fd = new FormData();
      fd.set('liabilityId', f.liabilityId);
      fd.set('amount', '1,5');
      fd.set('againstAccountCode', '6100');
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => chargeAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(
        'The charge amount — "1,5" is not a valid amount. Use at most two decimal places.',
      );
      expect(await liabilityChargeCount(f.orgId), 'nothing should have posted').toBe(0);
    },
  );
});

describe('Converted guards — chargeAction/payAction amount="0"', () => {
  it(
    'charge "0": wanted "A charge has to be greater than zero." — observed today (measured): ' +
      '"a charge has to be greater than zero." (prefix-stripped, lowercase "a" — the ONLY ' +
      'difference is capitalisation)',
    async () => {
      const f = await liabilityFixture('conv-charge');
      ACTOR_HOLDER.actor = f.admin;
      const { chargeAction } = await import('../../src/app/liabilities/actions');
      const fd = new FormData();
      fd.set('liabilityId', f.liabilityId);
      fd.set('amount', '0');
      fd.set('againstAccountCode', '6100');
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => chargeAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('A charge has to be greater than zero.');
    },
  );

  it(
    'pay "0": wanted "A payment has to be greater than zero." — observed today (measured): ' +
      '"a payment has to be greater than zero." (prefix-stripped, lowercase "a")',
    async () => {
      const f = await liabilityFixture('conv-pay');
      ACTOR_HOLDER.actor = f.admin;
      const { chargeAction, payAction } = await import('../../src/app/liabilities/actions');
      const chargeFd = new FormData();
      chargeFd.set('liabilityId', f.liabilityId);
      chargeFd.set('amount', '1000.00');
      chargeFd.set('againstAccountCode', '6100');
      chargeFd.set('on', '2026-01-10');
      await expectRedirectTo(() => chargeAction(chargeFd));

      const drawerId = await drawerOf(f);
      const payFd = new FormData();
      payFd.set('liabilityId', f.liabilityId);
      payFd.set('amount', '0');
      payFd.set('fromMoneyAccountId', drawerId);
      payFd.set('on', '2026-01-12');
      const to = await expectRedirectTo(() => payAction(payFd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('A payment has to be greater than zero.');
    },
  );
});

// =================================================================================================
// Customers — setPriceAction (rate)
// =================================================================================================

async function priceListFixture(hint: string) {
  const f = await orgWithAdmin(hint);
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: uid('SKU'), name: 'Test Item', kind: 'raw_material', baseUnit: 'pcs', sellableWholesale: true } as any),
  );
  const { createPriceListAction } = await import('../../src/app/customers/actions');
  ACTOR_HOLDER.actor = f.admin;
  const fd = new FormData();
  fd.set('name', 'Test List');
  const to = await expectRedirectTo(() => createPriceListAction(fd));
  const priceListId = to.match(/price-lists\/([^?]+)/)![1]!;
  return { ...f, itemId: item.id, priceListId };
}

const RATE_COMMA_SENTENCE = 'The rate — "1,5" is not a valid amount. Use at most two decimal places.';
const RATE_BLANK_SENTENCE = 'The rate — "" is not a valid amount. Use at most two decimal places.';

describe('Comma leg — customers setPriceAction rate="1,5" (Tier 2, no server parse today)', () => {
  it(
    `wanted: "${RATE_COMMA_SENTENCE}" (parseMoneyInput, item 6, not yet built) — observed today ` +
      `(measured): "${DATABASE_ERROR_FALLBACK}" (22P02 invalid input syntax for type numeric)`,
    async () => {
      const f = await priceListFixture('customers-comma');
      ACTOR_HOLDER.actor = f.admin;
      const { setPriceAction } = await import('../../src/app/customers/actions');
      const fd = new FormData();
      fd.set('priceListId', f.priceListId);
      fd.set('itemId', f.itemId);
      fd.set('rate', '1,5');
      const to = await expectRedirectTo(() => setPriceAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(RATE_COMMA_SENTENCE);
    },
  );

  it(
    `RED — rate="" wanted: "${RATE_BLANK_SENTENCE}" — parseMoneyInput('') also throws (empty string ` +
      'fails the money regex), so this leg\'s "blank stays unchanged" premise breaks once item 6 lands ' +
      `— observed today (measured): "${DATABASE_ERROR_FALLBACK}"`,
    async () => {
      const f = await priceListFixture('customers-blank');
      ACTOR_HOLDER.actor = f.admin;
      const { setPriceAction } = await import('../../src/app/customers/actions');
      const fd = new FormData();
      fd.set('priceListId', f.priceListId);
      fd.set('itemId', f.itemId);
      fd.set('rate', '');
      const to = await expectRedirectTo(() => setPriceAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(RATE_BLANK_SENTENCE);
    },
  );
});

// =================================================================================================
// Owners — drawingAction / settleAction (repay/recover/writeoff) / contributionAction
// =================================================================================================

async function ownerFixture(hint: string) {
  const f = await orgWithAdmin(hint);
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Owner Person') returning id`;
  const { createOwnerAction } = await import('../../src/app/owners/actions');
  ACTOR_HOLDER.actor = f.admin;
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('personId', person!.id);
  fd.set('personalExpenseTreatment', 'repayable');
  const to = await expectRedirectTo(() => createOwnerAction(fd));
  const ownerId = to.match(/owners\/([^?]+)/)![1]!;
  return { ...f, ownerId };
}

const DRAWING_COMMA_SENTENCE = 'The drawing amount — "1,5" is not a valid amount. Use at most two decimal places.';
const SETTLE_ABC_SENTENCE = 'The amount settled — "abc" is not a valid amount. Use at most two decimal places.';

describe('owners drawing/settle comma legs (Tier 2)', () => {
  it(
    `wanted: "${DRAWING_COMMA_SENTENCE}" (parseMoneyInput, item 7, not yet built) — observed today ` +
      '(measured, NOT a raw DB syntax error): a readable-shaped message already containing the ' +
      'literal word "NaN", thrown by checkDraw BEFORE postEntry is ever reached: `"Cashier cash" ' +
      'would go to −NaN, past the 20000.00 overdraft this drawer is allowed (holds 0.00, this ' +
      'takes NaN). A cashier drawer is expected to run behind while the day is unverified, but not ' +
      'this far. Verify the day, remit what is in the till, or raise the limit deliberately.`',
    async () => {
      const f = await ownerFixture('drawing-comma');
      ACTOR_HOLDER.actor = f.admin;
      const { drawingAction } = await import('../../src/app/owners/actions');
      const drawerId = await drawerOf(f);
      const fd = new FormData();
      fd.set('ownerId', f.ownerId);
      fd.set('amount', '1,5');
      fd.set('fromMoneyAccountId', drawerId);
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => drawingAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(DRAWING_COMMA_SENTENCE);
    },
  );

  it(
    `settleAction how="cash" amount="abc" (O2): wanted "${SETTLE_ABC_SENTENCE}" — observed today ` +
      `(measured): "${DATABASE_ERROR_FALLBACK}" (22P02 invalid input syntax for type numeric — ` +
      "Number('abc')=NaN passes both assertWithinReceivable checks)",
    async () => {
      const f = await ownerFixture('settle-abc');
      ACTOR_HOLDER.actor = f.admin;
      const { settleAction } = await import('../../src/app/owners/actions');
      const drawerId = await drawerOf(f);
      const fd = new FormData();
      fd.set('ownerId', f.ownerId);
      fd.set('how', 'cash');
      fd.set('amount', 'abc');
      fd.set('intoMoneyAccountId', drawerId);
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => settleAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(SETTLE_ABC_SENTENCE);
    },
  );
});

describe('Converted guards — drawingAction/contributionAction amount="0"', () => {
  it(
    'drawing "0": wanted "A drawing has to be greater than zero." — observed today (measured): ' +
      '"a drawing has to be greater than zero." (prefix-stripped, lowercase "a")',
    async () => {
      const f = await ownerFixture('conv-drawing');
      ACTOR_HOLDER.actor = f.admin;
      const { drawingAction } = await import('../../src/app/owners/actions');
      const drawerId = await drawerOf(f);
      const fd = new FormData();
      fd.set('ownerId', f.ownerId);
      fd.set('amount', '0');
      fd.set('fromMoneyAccountId', drawerId);
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => drawingAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('A drawing has to be greater than zero.');
    },
  );

  it(
    'settled (repay) "0": wanted "The amount settled has to be greater than zero." — observed ' +
      'today (measured): "the amount has to be greater than zero." (prefix-stripped, lowercase "the")',
    async () => {
      const f = await ownerFixture('conv-settle');
      ACTOR_HOLDER.actor = f.admin;
      const { settleAction } = await import('../../src/app/owners/actions');
      const drawerId = await drawerOf(f);
      const fd = new FormData();
      fd.set('ownerId', f.ownerId);
      fd.set('how', 'cash');
      fd.set('amount', '0');
      fd.set('intoMoneyAccountId', drawerId);
      fd.set('on', '2026-01-10');
      const to = await expectRedirectTo(() => settleAction(fd));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe('The amount settled has to be greater than zero.');
    },
  );

  it('⛔ green, unedited — contributionAction amount="0" text is UNCHANGED by S5.5v', async () => {
    const f = await ownerFixture('contrib-unchanged');
    ACTOR_HOLDER.actor = f.admin;
    const { contributionAction } = await import('../../src/app/owners/actions');
    const drawerId = await drawerOf(f);
    const fd = new FormData();
    fd.set('ownerId', f.ownerId);
    fd.set('amount', '0');
    fd.set('intoMoneyAccountId', drawerId);
    fd.set('on', '2026-01-10');
    const to = await expectRedirectTo(() => contributionAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('a contribution has to be greater than zero.');
  });
});

describe('Comma legs — SAFE: contributionAction already refuses by name', () => {
  it('amount="1,5" refuses', async () => {
    const f = await ownerFixture('contrib-safe');
    ACTOR_HOLDER.actor = f.admin;
    const { contributionAction } = await import('../../src/app/owners/actions');
    const drawerId = await drawerOf(f);
    const fd = new FormData();
    fd.set('ownerId', f.ownerId);
    fd.set('amount', '1,5');
    fd.set('intoMoneyAccountId', drawerId);
    fd.set('on', '2026-01-10');
    const to = await expectRedirectTo(() => contributionAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The contribution amount — "1,5" is not a valid amount. Use at most two decimal places.');
  });
});

// =================================================================================================
// Money transfers — SAFE, green pins only (amountOut already server-parsed + app-refused blank)
// =================================================================================================

describe('Comma leg — money-transfers createMoneyTransferAction amountOut="1,5" (SAFE, green pin)', () => {
  it('refuses by name', async () => {
    const f = await orgWithAdmin('transfer-safe');
    const drawerId = await drawerOf(f);
    const [wallet] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId} and instrument = 'ewallet' and custodian = 'cashier' and is_foundation`;
    ACTOR_HOLDER.actor = f.admin;
    const { createMoneyTransferAction } = await import('../../src/app/money-transfers/actions');
    const fd = new FormData();
    fd.set('fromMoneyAccountId', drawerId);
    fd.set('toMoneyAccountId', wallet!.id);
    fd.set('amountOut', '1,5');
    fd.set('transferDate', '2026-01-10');
    const to = await expectRedirectTo(() => createMoneyTransferAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The amount sent — "1,5" is not a valid amount. Use at most two decimal places.');
  });

  it('⛔ green, unedited — amountOut="" refuses at the app layer, meaning unchanged', async () => {
    const f = await orgWithAdmin('transfer-blank');
    const drawerId = await drawerOf(f);
    const [wallet] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId} and instrument = 'ewallet' and custodian = 'cashier' and is_foundation`;
    ACTOR_HOLDER.actor = f.admin;
    const { createMoneyTransferAction } = await import('../../src/app/money-transfers/actions');
    const fd = new FormData();
    fd.set('fromMoneyAccountId', drawerId);
    fd.set('toMoneyAccountId', wallet!.id);
    fd.set('amountOut', '');
    fd.set('transferDate', '2026-01-10');
    const to = await expectRedirectTo(() => createMoneyTransferAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('Enter the amount that left the source account.');
  });

  it('⛔ green, unedited — amountOut="   " (spaces-only) same as blank', async () => {
    const f = await orgWithAdmin('transfer-spaces');
    const drawerId = await drawerOf(f);
    const [wallet] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId} and instrument = 'ewallet' and custodian = 'cashier' and is_foundation`;
    ACTOR_HOLDER.actor = f.admin;
    const { createMoneyTransferAction } = await import('../../src/app/money-transfers/actions');
    const fd = new FormData();
    fd.set('fromMoneyAccountId', drawerId);
    fd.set('toMoneyAccountId', wallet!.id);
    fd.set('amountOut', '   ');
    fd.set('transferDate', '2026-01-10');
    const to = await expectRedirectTo(() => createMoneyTransferAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('Enter the amount that left the source account.');
  });
});

// =================================================================================================
// Cutover opening — addOpeningFigureAction ("This amount", SAFE)
// =================================================================================================

describe('Comma leg — cutover addOpeningFigureAction amount="1,5" ("This amount", SAFE, green pin)', () => {
  it('refuses by name', async () => {
    const f = await orgWithAdmin('opening-safe');
    ACTOR_HOLDER.actor = f.admin;
    const { addOpeningFigureAction } = await import('../../src/app/cutover/actions');
    const fd = new FormData();
    fd.set('accountCode', '1220');
    fd.set('storeId', f.storeId);
    fd.set('direction', 'debit');
    fd.set('amount', '1,5');
    fd.set('entryDate', '2026-01-10');
    const to = await expectRedirectTo(() => addOpeningFigureAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('This amount — "1,5" is not a valid amount. Use at most two decimal places.');
  });
});

// =================================================================================================
// Fixed assets — U1/U2 (S5.5q already built these; S5.5v only changes the input TYPE)
// =================================================================================================

async function fixedAssetsFixture(hint: string) {
  const f = await orgWithAdmin(hint);
  const { seedExpenseCategories } = await import('../../../../packages/db/seed/expense-categories');
  await seedExpenseCategories(sql, f.orgId);
  return f;
}
function assetFormData(f: OrgFixture, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('name', 'Chest freezer');
  fd.set('category', 'appliances');
  fd.set('acquiredOn', '2026-01-15');
  fd.set('cost', '120000.00');
  fd.set('interval', 'monthly');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

describe('U1/U2 (DEF-472) — fixed-assets usefulLifeMonths (green pins, S5.5q already built this)', () => {
  it('U1: usefulLifeMonths="1,5" refuses (unchanged sentence)', async () => {
    const f = await fixedAssetsFixture('u1');
    ACTOR_HOLDER.actor = f.admin;
    const { createAssetAction } = await import('../../src/app/fixed-assets/actions');
    const to = await expectRedirectTo(() => createAssetAction(assetFormData(f, { usefulLifeMonths: '1,5' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The useful life must be a whole number of months, 1 or more.');
  });

  it('U2: usefulLifeMonths="" saves the category default (green, unedited)', async () => {
    const f = await fixedAssetsFixture('u2');
    ACTOR_HOLDER.actor = f.admin;
    const { createAssetAction } = await import('../../src/app/fixed-assets/actions');
    const to = await expectRedirectTo(() => createAssetAction(assetFormData(f, {})));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
  });
});

// =================================================================================================
// Channel settlements — Ian's Q1 ruling (G1-G5) + Amendment A1's P1
// =================================================================================================

async function channelFixture(hint: string, configured = true) {
  const f = await orgWithAdmin(hint);
  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${f.orgId}, ${f.storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;
  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
    values (${f.orgId}, ${f.storeId}, ${`Channel ${uid('c')}`}, false, '1220', ${configured ? bank!.id : null})
    returning id`;
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${f.storeId}, '2026-01-10', 0, 0, 0, ${f.admin.personId}) returning id`;
  // Raise the receivable a verified channel-day would have raised — otherwise EVERY settlement
  // attempt hits "nothing outstanding to settle" before gross/net ever matter.
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-10', ${period!.id}, 'sales_day', ${uid('src')}, 'draft') returning id`;
    // ⚠️ 40.00 receivable, matched by settlementFormData's 40.00/40.00 gross/net defaults below —
    // both chosen so that blanking EITHER field (→ effectively 0) still lands the resulting
    // variance/gain (≤40.00) inside toleranceFor(gross)'s floor of 50.00, so the blank-refusal
    // legs (G1-G5) aren't also tripping the UNRELATED variance/gain blocker.
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, (select id from accounts where org_id = ${f.orgId} and code = '1220'), ${f.storeId}, '40.00', '0', 'channel', ${channel!.id})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, (select id from accounts where org_id = ${f.orgId} and code = '4150'), ${f.storeId}, '0', '40.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
  return { ...f, channelId: channel!.id, salesDayId: day!.id };
}
async function settlementCountFor(orgId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`select count(*)::text as count from channel_settlements where org_id = ${orgId}`;
  return Number(row!.count);
}

function settlementFormData(f: Awaited<ReturnType<typeof channelFixture>>, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('channelId', f.channelId);
  fd.set('salesDayId', f.salesDayId);
  fd.set('businessDate', '2026-01-10');
  fd.set('grossAmount', '40.00');
  fd.set('netDeposited', '40.00');
  fd.set('settledOn', '2026-01-15');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

const GROSS_BLANK_SENTENCE = 'The gross settled — enter the figure from the payout statement.';
const NET_BLANK_SENTENCE = 'The net deposited — enter the figure from the payout statement.';

describe('G1-G5 (Ian, Q1) — blank/spaces-only gross/net now REFUSE, on both save and preview', () => {
  it(
    'G1 recordSettlementAction grossAmount="": wanted the refusal above — observed today ' +
      '(measured, NOT presumed — differs from the spec\'s "records with gross 0" prediction): ' +
      '"That change isn\'t allowed for journal lines — please check the values you entered." ' +
      '(journal_lines_exactly_one_side_check — the receivable-clearing leg computed to exactly 0 ' +
      'debit AND 0 credit when outstandingCleared = min(outstanding, 0) = 0, an unmapped CHECK; ' +
      'this is a DIFFERENT observed mechanism than G2\'s, which genuinely does post cleanly with net 0)',
    async () => {
      const f = await channelFixture('g1');
      ACTOR_HOLDER.actor = f.admin;
      const { recordSettlementAction } = await import('../../src/app/channel-settlements/actions');
      const before = await settlementCountFor(f.orgId);
      const to = await expectRedirectTo(() => recordSettlementAction(settlementFormData(f, { grossAmount: '' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBe(GROSS_BLANK_SENTENCE);
      expect(await settlementCountFor(f.orgId), 'nothing should have posted').toBe(before);
    },
  );

  it('G2 recordSettlementAction netDeposited="": wanted the refusal above — observed today: succeeds with net 0', async () => {
    const f = await channelFixture('g2');
    ACTOR_HOLDER.actor = f.admin;
    const { recordSettlementAction } = await import('../../src/app/channel-settlements/actions');
    const before = await settlementCountFor(f.orgId);
    const to = await expectRedirectTo(() => recordSettlementAction(settlementFormData(f, { netDeposited: '' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(NET_BLANK_SENTENCE);
    expect(await settlementCountFor(f.orgId)).toBe(before);
  });

  it('G3 recordSettlementAction grossAmount="   " (spaces-only = blank; same observed mechanism as G1)', async () => {
    const f = await channelFixture('g3');
    ACTOR_HOLDER.actor = f.admin;
    const { recordSettlementAction } = await import('../../src/app/channel-settlements/actions');
    const to = await expectRedirectTo(() => recordSettlementAction(settlementFormData(f, { grossAmount: '   ' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe(GROSS_BLANK_SENTENCE);
  });

  it(
    'G4 (RULED FLIP, S5.5v Amendment A2 item 2) — previewSettlementAction grossAmount="": the ' +
      'refusal now surfaces INSIDE preview.blockers (item 1 moved the parse past authorize/into the ' +
      'domain, so the action\'s own top-level figure() throw is gone) — computeSettlement must not ' +
      'run on the bad figure, so no "NaN" anywhere in the response',
    async () => {
      const f = await channelFixture('g4');
      ACTOR_HOLDER.actor = f.admin;
      const { previewSettlementAction } = await import('../../src/app/channel-settlements/actions');
      const result = await previewSettlementAction({
        storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
        grossAmount: '', netDeposited: '40.00',
        commission: '', marketing: '', platformFee: '', vatOnFees: '', withholdingTax: '', penalty: '',
        loanId: '', loanAmount: '', loanOwnerStoreId: '', recognizeGain: false,
      });
      expect(result.ok, 'a preview always returns ok:true with blockers listed').toBe(true);
      if (result.ok) {
        expect(result.preview.blockers.join(' | '), 'wanted the gross-blank refusal present').toContain(GROSS_BLANK_SENTENCE);
      }
      expect(JSON.stringify(result), 'wanted: no NaN anywhere (item 2)').not.toMatch(/NaN/);
    },
  );

  it(
    'G5 (RULED FLIP, S5.5v Amendment A2 item 2) — previewSettlementAction netDeposited="": same shape as G4',
    async () => {
      const f = await channelFixture('g5');
      ACTOR_HOLDER.actor = f.admin;
      const { previewSettlementAction } = await import('../../src/app/channel-settlements/actions');
      const result = await previewSettlementAction({
        storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
        grossAmount: '40.00', netDeposited: '',
        commission: '', marketing: '', platformFee: '', vatOnFees: '', withholdingTax: '', penalty: '',
        loanId: '', loanAmount: '', loanOwnerStoreId: '', recognizeGain: false,
      });
      expect(result.ok, 'a preview always returns ok:true with blockers listed').toBe(true);
      if (result.ok) {
        expect(result.preview.blockers.join(' | '), 'wanted the net-blank refusal present').toContain(NET_BLANK_SENTENCE);
      }
      expect(JSON.stringify(result), 'wanted: no NaN anywhere (item 2)').not.toMatch(/NaN/);
    },
  );

  it('⛔ green, unedited — a blank deduction still saves as 0', async () => {
    const f = await channelFixture('g-deduction-blank');
    ACTOR_HOLDER.actor = f.admin;
    const { recordSettlementAction } = await import('../../src/app/channel-settlements/actions');
    const to = await expectRedirectTo(() => recordSettlementAction(settlementFormData(f, { commission: '' })));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
  });
});

describe('Amendment A1 P1 — previewChannelSettlement with a comma penalty AND an unconfigured channel', () => {
  it(
    'wanted: returns normally with BOTH refusals in blockers (not yet built) — observed today ' +
      "(measured): THROWS with only the figures refusal — the destination-account blocker (already " +
      'computed in ctx.configBlockers) is silently discarded because assertSettlementFigures throws ' +
      'before the preview object combining both is ever built',
    async () => {
      const f = await channelFixture('p1-amendment', false);
      ACTOR_HOLDER.actor = f.admin;
      const { previewSettlementAction } = await import('../../src/app/channel-settlements/actions');
      const result = await previewSettlementAction({
        storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
        grossAmount: '40.00', netDeposited: '40.00',
        commission: '', marketing: '', platformFee: '', vatOnFees: '', withholdingTax: '', penalty: '1,5',
        loanId: '', loanAmount: '', loanOwnerStoreId: '', recognizeGain: false,
      });
      expect(result.ok, 'wanted ok:true with both blockers listed').toBe(true);
      if (result.ok) {
        const joined = result.preview.blockers.join(' | ');
        expect(joined, 'wanted the destination-account blocker present').toMatch(/destination/);
        expect(joined, 'wanted the penalty parse refusal present too').toMatch(/penalty/i);
      }
    },
  );
});

// =================================================================================================
// S5.5v Amendment A2 — parse-after-authorize, no-NaN preview, multi-refusal preview, loan rate shape
// =================================================================================================

async function noCapabilityStaffActor(f: OrgFixture): Promise<Actor> {
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'No-Cap Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${f.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${f.storeId})`;
  return actor(f.orgId, staff!.id);
}

const AZ1_AUTH_SENTENCE = /^Your role \(Staff\) can.t record a payment from a customer\./;

describe('AZ1 (RULED FLIP, S5.5v Amendment A2 item 1 landed) — no record_ar_collection capability + blank gross', () => {
  it(
    'recordSettlementAction: authorize() now runs before the figure parse — the redirect carries ' +
      'the authorization sentence ("Your role (Staff) can\'t record a payment from a customer...."), ' +
      'never the figure-blank sentence',
    async () => {
      const f = await channelFixture('az1-record');
      const noCap = await noCapabilityStaffActor(f);
      ACTOR_HOLDER.actor = noCap;
      const { recordSettlementAction } = await import('../../src/app/channel-settlements/actions');
      const to = await expectRedirectTo(() => recordSettlementAction(settlementFormData(f, { grossAmount: '' })));
      expect(errorOf(to), `redirect URL was: ${to}`).not.toBe(GROSS_BLANK_SENTENCE);
      expect(errorOf(to), `redirect URL was: ${to}`).toMatch(AZ1_AUTH_SENTENCE);
    },
    30000,
  );

  it(
    'previewSettlementAction: same — the authorization sentence, never the figure-blank sentence',
    async () => {
      const f = await channelFixture('az1-preview');
      const noCap = await noCapabilityStaffActor(f);
      ACTOR_HOLDER.actor = noCap;
      const { previewSettlementAction } = await import('../../src/app/channel-settlements/actions');
      const result = await previewSettlementAction({
        storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
        grossAmount: '', netDeposited: '40.00',
        commission: '', marketing: '', platformFee: '', vatOnFees: '', withholdingTax: '', penalty: '',
        loanId: '', loanAmount: '', loanOwnerStoreId: '', recognizeGain: false,
      });
      expect(result.ok, 'wanted ok:false with an authorization sentence').toBe(false);
      if (!result.ok) {
        expect(result.error, 'the figure-blank sentence must be absent').not.toBe(GROSS_BLANK_SENTENCE);
        expect(result.error).toMatch(AZ1_AUTH_SENTENCE);
      }
    },
    30000,
  );
});

describe('PV2 (S5.5v Amendment A2 item 2) — preview with a comma-typed gross renders no "NaN"', () => {
  it(
    'wanted: figures come back zeroed, no "NaN" anywhere (computeSettlement skipped when a figure ' +
      'refusal exists, not yet built) — observed today (measured, not presumed): computeSettlement ' +
      'still runs on Number("1,5")=NaN, and the preview response contains the literal string "NaN"',
    async () => {
      const f = await channelFixture('pv2');
      ACTOR_HOLDER.actor = f.admin;
      const { previewSettlementAction } = await import('../../src/app/channel-settlements/actions');
      const result = await previewSettlementAction({
        storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
        grossAmount: '1,5', netDeposited: '40.00',
        commission: '', marketing: '', platformFee: '', vatOnFees: '', withholdingTax: '', penalty: '',
        loanId: '', loanAmount: '', loanOwnerStoreId: '', recognizeGain: false,
      });
      expect(JSON.stringify(result), 'wanted: no NaN anywhere in the preview response').not.toMatch(/NaN/);
    },
    30000,
  );
});

describe('PV3 (S5.5v Amendment A2 item 3) — two bad figures produce both refusals in one preview', () => {
  it(
    'wanted: blockers contains both the gross AND the commission refusal (assertSettlementFigures ' +
      'collects every field, not yet built) — observed today (measured, not presumed): only the ' +
      'FIRST bad field (gross) is present — parseMoneyInput throws on gross before commission is ' +
      'ever checked',
    async () => {
      const f = await channelFixture('pv3');
      ACTOR_HOLDER.actor = f.admin;
      const { previewSettlementAction } = await import('../../src/app/channel-settlements/actions');
      const result = await previewSettlementAction({
        storeId: f.storeId, channelId: f.channelId, businessDate: '2026-01-10',
        grossAmount: '1,5', netDeposited: '40.00',
        commission: '2,5', marketing: '', platformFee: '', vatOnFees: '', withholdingTax: '', penalty: '',
        loanId: '', loanAmount: '', loanOwnerStoreId: '', recognizeGain: false,
      });
      expect(result.ok, 'a preview always returns ok:true with blockers listed').toBe(true);
      if (result.ok) {
        const joined = result.preview.blockers.join(' | ');
        expect(joined, 'wanted the gross refusal present').toMatch(/gross/i);
        expect(joined, 'wanted the commission refusal ALSO present').toMatch(/commission/i);
      }
    },
    30000,
  );
});

describe('L6/L7 (S5.5v Amendment A2 item 5) — interestRate shape must not narrow what money() etc. accept', () => {
  it(
    'L6 interestRate=".5": wanted saves as 0.5 (shape /^(?=.*\\d)\\d*(?:\\.\\d{0,4})?$/, not yet ' +
      'built) — observed today (measured, not presumed — S5.5v item 3\'s ORIGINAL narrow regex ' +
      '/^\\d{1,4}(\\.\\d{1,4})?$/ is already live): refused by name, "The interest rate — \\".5\\" is ' +
      'not a valid rate. Use a number from 0 to 9999.9999 with up to four decimal places." — the ' +
      'narrow regex requires a leading digit, which ".5" lacks',
    async () => {
      const f = await orgWithAdmin('l6');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { interestRate: '.5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
      const [row] = await sql<{ interest_rate: string }[]>`select interest_rate from loans where org_id = ${f.orgId} order by created_at desc limit 1`;
      expect(row!.interest_rate).toBe('0.5000');
    },
    30000,
  );

  it(
    'L7 interestRate="00012.5": wanted saves as 12.5 (leading zeros are a digit run, not the value) ' +
      '— observed today (measured, not presumed — same live narrow regex as L6): refused, ' +
      '"...is not a valid rate..." — 5 leading digits exceed the regex\'s 1-4-digit integer part',
    async () => {
      const f = await orgWithAdmin('l7');
      ACTOR_HOLDER.actor = f.admin;
      const { createLoanAction } = await import('../../src/app/loans/actions');
      const to = await expectRedirectTo(() => createLoanAction(loanFormData(f, { interestRate: '00012.5' })));
      expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
      const [row] = await sql<{ interest_rate: string }[]>`select interest_rate from loans where org_id = ${f.orgId} order by created_at desc limit 1`;
      expect(row!.interest_rate).toBe('12.5000');
    },
    30000,
  );
});
