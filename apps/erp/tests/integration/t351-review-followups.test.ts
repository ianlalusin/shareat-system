import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-351 — follow-ups from the post-commit `/code-review 0944455` review (DEF-480..483).
 * `docs/tasks/351-def-480-483-0944455-review-followups.md` §Legs A6, W1-W7, plus orchestrator
 * amendment M5's extra leg (a non-holder sends unit price '-5').
 *
 * ⛔ TESTER, not BUILDER. `createLoanAction`/`createPrepaidItemAction`/`confirmTermAction` all parse
 * their whole-number field (`wholePayments`/`wholeMonths`) BEFORE calling the domain — so a
 * malformed value never reaches `authorize()` at all, and a MANAGER who lacks the capability still
 * gets the parse sentence, not the refusal that would tell them why nothing happened.
 *
 * Harness: real Postgres, `next/navigation`/session/`@/lib/constraint-messages` mocked exactly as
 * `t343-s5-5v-followups.test.ts:36-49` does — everything else (the actions, the domain, the DB) is
 * real.
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
import { createItem, createPrepaidItem, createSupplier, recordInvoice } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { paramsOf } from '../helpers/flash-jar';

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

async function fixture(hint: string) {
  const code = uid(`t351-erp-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;

  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;

  const [superAdmin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${superAdmin!.id}, ${orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${superAdmin!.id}, ${storeId})`;

  // A manager holds record_supplier_invoice but lacks manage_chart_of_accounts / manage_prepaid_items
  // (CAPABILITY_MATRIX — confirmed by the T-351 spec's own note, and by W1/W4/W6 leaning on it).
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;

  // A staff person: holds NONE of record_supplier_invoice / manage_chart_of_accounts / manage_prepaid_items.
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;

  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, actor(orgId, admin!.id), { name: `Supplier ${code}` }));
  const itemName = `Pork belly ${uid('n')}`;
  const item = await asOrg(orgId, (tx) =>
    createItem(tx, actor(orgId, superAdmin!.id), { code: uid('PORK'), name: itemName, kind: 'raw_material', baseUnit: 'kg' }),
  );

  return {
    orgId, storeId,
    admin: actor(orgId, admin!.id),
    manager: actor(orgId, manager!.id),
    staff: actor(orgId, staff!.id),
    supplierId: supplier.id,
    itemId: item.id, itemName,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function evidence(f: Fixture): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${f.admin.personId})
    returning id`;
  return row!.id;
}

/** A PENDING invoice (via the real `recordInvoice`, actor = admin) with ONE good line, left
 *  unverified so `setInvoiceLinesAction` can still edit it. */
async function pendingInvoice(f: Fixture): Promise<string> {
  const fileId = await evidence(f);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.admin, {
      storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
      totalAmount: '100.00', receiptFileId: fileId,
      lines: [{ itemId: f.itemId, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '100', lineTotal: '100.00' }],
    }),
  );
  return created.id;
}

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) {
      // T-380: the flash cookie is ONE cookie, overwritten by every redirect. A test that compares two
      // redirects must read each banner at the moment its redirect happened, so snapshot it here.
      SEEN.set(err.to, paramsOf(err.to));
      return err.to;
    }
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const SEEN = new Map<string, URLSearchParams>();
const errorOf = (to: string) => (SEEN.get(to) ?? paramsOf(to)).get('error');
const okOf = (to: string) => (SEEN.get(to) ?? paramsOf(to)).get('ok');

let actionsAp: typeof import('../../src/app/ap/actions');
let actionsLoans: typeof import('../../src/app/loans/actions');
let actionsPrepaid: typeof import('../../src/app/prepaid/actions');

beforeAll(async () => {
  actionsAp = await import('../../src/app/ap/actions');
  actionsLoans = await import('../../src/app/loans/actions');
  actionsPrepaid = await import('../../src/app/prepaid/actions');
}, 30_000);

afterAll(async () => {
  await sql.end();
});

// =================================================================================================
// A6 — the AP action surfaces the same written sentence, not the generic DB-refused fallback.
// =================================================================================================

describe('A6 — setInvoiceLinesAction with line1_unitPrice=-5', () => {
  it("the redirect error equals A1's sentence — measured (M3), not presumed", async () => {
    const f = await fixture('a6');
    ACTOR_HOLDER.actor = f.admin;
    const invoiceId = await pendingInvoice(f);

    const fd = new FormData();
    fd.set('invoiceId', invoiceId);
    fd.set('line1_itemId', f.itemId);
    fd.set('line1_quantity', '10');
    fd.set('line1_unitPrice', '-5');
    fd.set('line2_itemId', f.itemId);
    fd.set('line2_quantity', '15');
    fd.set('line2_unitPrice', '10');

    const to = await expectRedirectTo(() => actionsAp.setInvoiceLinesAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toMatch(
      /^Line 1 \(.*\)'s unit price — "-5" is not a valid amount\. Use a non-negative number with up to four decimal places\.$/,
    );
  });
});

describe('M5 (⛔ green today, a guard) — an actor without record_supplier_invoice sends unit price -5: the authorization refusal, not the price sentence', () => {
  it('the redirect error is the role refusal — already correct today: authorize() runs before validateInvoiceLines regardless of DEF-480', async () => {
    const f = await fixture('m5');
    const invoiceId = await pendingInvoice(f);

    ACTOR_HOLDER.actor = f.staff;
    const fd = new FormData();
    fd.set('invoiceId', invoiceId);
    fd.set('line1_itemId', f.itemId);
    fd.set('line1_quantity', '10');
    fd.set('line1_unitPrice', '-5');

    const to = await expectRedirectTo(() => actionsAp.setInvoiceLinesAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).not.toContain('is not a valid amount');
    expect(errorOf(to), `redirect URL was: ${to}`).toBe("Your role (Staff) can't record a supplier invoice. Ask an admin if you need to.");
  });
});

// =================================================================================================
// W1-W3 — loans: createLoanAction's termPeriods must parse AFTER authorize(), never before.
// =================================================================================================

describe('W1 — MANAGER, createLoanAction termPeriods="abc": equals the auth refusal for "12"', () => {
  it('the same error either way; no "number of payments" sentence — was red today: the payments sentence', async () => {
    const f = await fixture('w1');
    ACTOR_HOLDER.actor = f.manager;

    const base = {
      storeId: f.storeId, lenderName: 'Grab', principalAmount: '5000.00', interestRate: '0',
      ratePeriod: 'month', interestMethod: 'straight', paymentFrequency: 'monthly', startDate: '2026-01-01',
    };
    const fdAbc = new FormData();
    for (const [k, v] of Object.entries({ ...base, name: `Advance ${uid('l')}`, termPeriods: 'abc' })) fdAbc.set(k, v);
    const toAbc = await expectRedirectTo(() => actionsLoans.createLoanAction(fdAbc));

    const fdValid = new FormData();
    for (const [k, v] of Object.entries({ ...base, name: `Advance ${uid('l')}`, termPeriods: '12' })) fdValid.set(k, v);
    const toValid = await expectRedirectTo(() => actionsLoans.createLoanAction(fdValid));

    expect(errorOf(toAbc), `redirect URL was: ${toAbc}`).not.toContain('number of payments');
    expect(errorOf(toAbc), 'wanted: identical to the valid-value refusal').toBe(errorOf(toValid));

    const [row] = await sql<{ c: string }[]>`select count(*)::text as c from loans where org_id = ${f.orgId}`;
    const c = row!.c;
    expect(c, 'M4 — nothing written for either attempt').toBe('0');
  });
});

describe('W2 — admin, termPeriods="000012": saves as 12', () => {
  it('loans.term_periods = 12', async () => {
    const f = await fixture('w2');
    ACTOR_HOLDER.actor = f.admin;
    const fd = new FormData();
    for (const [k, v] of Object.entries({
      storeId: f.storeId, lenderName: 'Grab', name: `Advance ${uid('l')}`, principalAmount: '5000.00',
      interestRate: '0', ratePeriod: 'month', interestMethod: 'straight', paymentFrequency: 'monthly',
      startDate: '2026-01-01', termPeriods: '000012',
    })) fd.set(k, v);
    const to = await expectRedirectTo(() => actionsLoans.createLoanAction(fd));
    expect(okOf(to) ?? errorOf(to), `redirect URL was: ${to}`).not.toMatch(/whole number/);
    const [row] = await sql<{ term_periods: number }[]>`select term_periods from loans where org_id = ${f.orgId} order by created_at desc limit 1`;
    expect(row!.term_periods).toBe(12);
  });
});

describe('W3 (guard) — admin, termPeriods="100000": refused, no row', () => {
  it('"The number of payments — "100000" is not a whole number from 1 to 99999."', async () => {
    const f = await fixture('w3');
    ACTOR_HOLDER.actor = f.admin;
    const fd = new FormData();
    for (const [k, v] of Object.entries({
      storeId: f.storeId, lenderName: 'Grab', name: `Advance ${uid('l')}`, principalAmount: '5000.00',
      interestRate: '0', ratePeriod: 'month', interestMethod: 'straight', paymentFrequency: 'monthly',
      startDate: '2026-01-01', termPeriods: '100000',
    })) fd.set(k, v);
    const to = await expectRedirectTo(() => actionsLoans.createLoanAction(fd));
    expect(errorOf(to), `redirect URL was: ${to}`).toBe('The number of payments — "100000" is not a whole number from 1 to 99999.');
    const [row] = await sql<{ c: string }[]>`select count(*)::text as c from loans where org_id = ${f.orgId}`;
    const c = row!.c;
    expect(c).toBe('0');
  });
});

// =================================================================================================
// W4-W5 — prepaid create: coverageMonths must parse AFTER authorize(), never before.
// =================================================================================================

describe('W4 — MANAGER, createPrepaidItemAction coverageMonths="abc": equals the auth refusal for "12"', () => {
  it('the same error either way; no "The coverage" sentence — was red today: the coverage sentence', async () => {
    const f = await fixture('w4');
    ACTOR_HOLDER.actor = f.manager;
    const base = {
      storeId: f.storeId, name: `Insurance ${uid('p')}`, category: 'insurance', coverageStartDate: '2026-01-01',
      totalCost: '6000.00',
    };
    const fdAbc = new FormData();
    for (const [k, v] of Object.entries({ ...base, coverageMonths: 'abc' })) fdAbc.set(k, v);
    const toAbc = await expectRedirectTo(() => actionsPrepaid.createPrepaidItemAction(fdAbc));

    const fdValid = new FormData();
    for (const [k, v] of Object.entries({ ...base, coverageMonths: '12' })) fdValid.set(k, v);
    const toValid = await expectRedirectTo(() => actionsPrepaid.createPrepaidItemAction(fdValid));

    expect(errorOf(toAbc), `redirect URL was: ${toAbc}`).not.toContain('The coverage');
    expect(errorOf(toAbc), 'wanted: identical to the valid-value refusal').toBe(errorOf(toValid));

    const [row] = await sql<{ c: string }[]>`select count(*)::text as c from prepaid_items where org_id = ${f.orgId}`;
    const c = row!.c;
    expect(c, 'M4 — nothing written for either attempt').toBe('0');
  });
});

describe('W5 — admin, coverageMonths="0012": saves as 12', () => {
  it('prepaid_items.coverage_months = 12', async () => {
    const f = await fixture('w5');
    ACTOR_HOLDER.actor = f.admin;
    const fd = new FormData();
    for (const [k, v] of Object.entries({
      storeId: f.storeId, name: `Insurance ${uid('p')}`, category: 'insurance', coverageStartDate: '2026-01-01',
      totalCost: '6000.00', coverageMonths: '0012',
    })) fd.set(k, v);
    const to = await expectRedirectTo(() => actionsPrepaid.createPrepaidItemAction(fd));
    expect(okOf(to) ?? errorOf(to), `redirect URL was: ${to}`).not.toMatch(/whole number/);
    const [row] = await sql<{ coverage_months: number }[]>`
      select coverage_months from prepaid_items where org_id = ${f.orgId} order by created_at desc limit 1`;
    expect(row!.coverage_months).toBe(12);
  });
});

// =================================================================================================
// W6-W7 — prepaid confirmTerm: same shape as W4/W5, on a needs-review item.
// =================================================================================================

async function needsReviewItem(f: Fixture) {
  const created = await asOrg(f.orgId, (tx) =>
    createPrepaidItem(tx, f.admin, {
      storeId: f.storeId, name: `Auto insurance ${uid('p')}`, category: 'insurance',
      coverageStartDate: '2026-01-01', coverageMonths: 6, totalCost: '6000.00', needsReview: true,
    }),
  );
  return created.id;
}

describe('W6 — MANAGER, confirmTermAction coverageMonths="abc" on a needs-review item: equals the auth refusal for "12"', () => {
  it('the same error either way; no "The coverage" sentence; needs_review/coverage_months unchanged — was red today: the coverage sentence', async () => {
    const f = await fixture('w6');
    const itemId = await needsReviewItem(f);
    ACTOR_HOLDER.actor = f.manager;

    const fdAbc = new FormData();
    fdAbc.set('prepaidItemId', itemId);
    fdAbc.set('coverageMonths', 'abc');
    fdAbc.set('coverageStartDate', '2026-01-01');
    const toAbc = await expectRedirectTo(() => actionsPrepaid.confirmTermAction(fdAbc));

    const fdValid = new FormData();
    fdValid.set('prepaidItemId', itemId);
    fdValid.set('coverageMonths', '12');
    fdValid.set('coverageStartDate', '2026-01-01');
    const toValid = await expectRedirectTo(() => actionsPrepaid.confirmTermAction(fdValid));

    expect(errorOf(toAbc), `redirect URL was: ${toAbc}`).not.toContain('The coverage');
    expect(errorOf(toAbc), 'wanted: identical to the valid-value refusal').toBe(errorOf(toValid));

    const [row] = await sql<{ needs_review: boolean; coverage_months: number }[]>`
      select needs_review, coverage_months from prepaid_items where id = ${itemId}`;
    expect(row!.needs_review, 'M4 — unchanged after either refused attempt').toBe(true);
    expect(row!.coverage_months, 'M4 — unchanged after either refused attempt').toBe(6);
  });
});

describe('W7 — admin, confirmTermAction "0012": confirms the term', () => {
  it('coverage_months = 12, needs_review false', async () => {
    const f = await fixture('w7');
    const itemId = await needsReviewItem(f);
    ACTOR_HOLDER.actor = f.admin;

    const fd = new FormData();
    fd.set('prepaidItemId', itemId);
    fd.set('coverageMonths', '0012');
    fd.set('coverageStartDate', '2026-01-01');
    const to = await expectRedirectTo(() => actionsPrepaid.confirmTermAction(fd));
    expect(okOf(to) ?? errorOf(to), `redirect URL was: ${to}`).not.toMatch(/whole number/);

    const [row] = await sql<{ needs_review: boolean; coverage_months: number }[]>`
      select needs_review, coverage_months from prepaid_items where id = ${itemId}`;
    expect(row!.coverage_months).toBe(12);
    expect(row!.needs_review).toBe(false);
  });
});
