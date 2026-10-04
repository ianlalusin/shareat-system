import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S5a (DEF-314) — the closed-month override on the reimbursement SCREEN. `docs/tasks/369-unwired-money-screens.md`
 * §S5 "BUILDER S5a" and tests T3, T5, T6 (T1/T2/T4 are the domain file; T7 is S5b, not written; T8 the unit file).
 *
 * ⛔ TESTER, not BUILDER. Harness from `t369-s1-reimbursement-web.test.ts` (session mock, `Page` stub, real
 * `requirePageAccess`, real domain, real Postgres).
 *
 * ## What the spec leaves open, pinned so the builder has one reading
 * `apps/erp/src/lib/period-override.ts` exports
 *   closedMonths(orgId) -> { startsOn, endsOn, label }[]     (status 'closed' ONLY — never open, never locked; label "January 2026")
 *   readPeriodOverride(fd) -> { reason, note? } | undefined
 * and the override form fields are:
 *   periodOverrideConfirm (checkbox, "on") · periodOverrideReason (a PERIOD_OVERRIDE_REASONS value) · periodOverrideNote
 * `payReimbursementAction` reads them with `readPeriodOverride(fd)` and drops the override unless the payout date's
 * period is `closed` (so an open-month payout writes no audit row). `ClosedMonthOverride` is a client component rendered
 * ONLY for actors who hold `override_period_lock`; its SSR output carries the marker attribute `data-closed-month-override`
 * (shown/hidden on the client by the chosen date) and the three fields above, with reason labels "Late supplier bill",
 * "Correction required by BIR/regulator", "Fixing a mistake" and "Other".
 * If the builder reads different names, that is a QUESTION to the tester, not a test edit.
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
  notFound: () => {
    throw new Error('notFound() called — fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
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

/** Lipa; admin + manager; Ana owed ₱650 from 5 Jan; Jan 2026 CLOSED, Feb 2026 open, Mar 2026 LOCKED is not possible
 * (a locked year holds no open period), so the locked case builds its own org. */
async function fixture(hint: string) {
  const code = uid(`t369s5w-${hint}`);
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

const payoutEntries = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'reimbursement_payout'`)[0]!.n);
const overrideRows = (orgId: string) =>
  sql<{ actor_person_id: string; reason: string; note: string | null; period_status_at_post: string }[]>`
    select actor_person_id, reason, note, period_status_at_post from period_overrides where org_id = ${orgId}`;

async function load<T>(spec: () => Promise<T>, what: string): Promise<T> {
  try {
    return await spec();
  } catch (err) {
    throw new Error(`${what} does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
}
async function expectRedirectTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => new URL(to, 'http://localhost').searchParams.get(k);

function payForm(f: Fixture, o: { on: string; confirm?: boolean; reason?: string; note?: string }): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('employeeId', f.anaId);
  fd.set('amount', '650.00');
  fd.set('fromMoneyAccountId', f.cashId);
  fd.set('on', o.on);
  fd.set('payoutId', crypto.randomUUID());
  if (o.confirm) fd.set('periodOverrideConfirm', 'on');
  if (o.reason !== undefined) fd.set('periodOverrideReason', o.reason);
  if (o.note !== undefined) fd.set('periodOverrideNote', o.note);
  return fd;
}
async function submit(who: Actor, fd: FormData): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const { payReimbursementAction } = await import('../../src/app/expenses/reimbursements/actions');
  return expectRedirectTo(() => payReimbursementAction(fd));
}
async function renderPage(who: Actor, f: Fixture): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const { default: Page } = await import('../../src/app/expenses/reimbursements/page');
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store: f.storeId }) } as never)) as never);
}

// -----------------------------------------------------------------------------------------------
// The two helpers in apps/erp/src/lib/period-override.ts
// -----------------------------------------------------------------------------------------------

describe('readPeriodOverride(fd) — only a confirmed, valid, complete override survives', () => {
  type Lib = { readPeriodOverride?: (fd: FormData) => { reason: string; note?: string | null } | undefined };
  const lib = async () => (await load(() => import('../../src/lib/period-override'), 'apps/erp/src/lib/period-override.ts')) as unknown as Lib;
  const form = (o: { confirm?: boolean; reason?: string; note?: string }) => {
    const fd = new FormData();
    if (o.confirm) fd.set('periodOverrideConfirm', 'on');
    if (o.reason !== undefined) fd.set('periodOverrideReason', o.reason);
    if (o.note !== undefined) fd.set('periodOverrideNote', o.note);
    return fd;
  };

  it('confirm on + a valid reason -> { reason, note }; each way of failing returns undefined (positive control: the first case)', async () => {
    const { readPeriodOverride } = await lib();
    expect(typeof readPeriodOverride, 'readPeriodOverride is not exported from lib/period-override.ts').toBe('function');
    const ok = readPeriodOverride!(form({ confirm: true, reason: 'data_entry_error', note: '  found late  ' }));
    expect(ok?.reason).toBe('data_entry_error');
    expect((ok?.note ?? '').trim()).toBe('found late');

    expect(readPeriodOverride!(form({ confirm: false, reason: 'data_entry_error' })), 'no confirm box').toBeUndefined();
    expect(readPeriodOverride!(form({ confirm: true, reason: 'because I said so' })), 'a reason outside PERIOD_OVERRIDE_REASONS').toBeUndefined();
    expect(readPeriodOverride!(form({ confirm: true })), 'no reason at all').toBeUndefined();
    expect(readPeriodOverride!(form({ confirm: true, reason: 'other' })), '"other" needs a note').toBeUndefined();
    expect(readPeriodOverride!(form({ confirm: true, reason: 'other', note: '   ' })), '"other" with a blank note').toBeUndefined();
    expect(readPeriodOverride!(form({ confirm: true, reason: 'other', note: 'BIR asked for it' }))?.reason).toBe('other');
  });
});

describe('closedMonths(orgId) — closed months only', () => {
  it('lists a CLOSED month as { startsOn, endsOn, label: "January 2026" }; an open month is absent', async () => {
    const f = await fixture('months');
    const lib = (await load(() => import('../../src/lib/period-override'), 'apps/erp/src/lib/period-override.ts')) as unknown as {
      closedMonths?: (orgId: string) => Promise<{ startsOn: string; endsOn: string; label: string }[]>;
    };
    expect(typeof lib.closedMonths, 'closedMonths is not exported from lib/period-override.ts').toBe('function');
    const months = await lib.closedMonths!(f.orgId);
    expect(months).toEqual([{ startsOn: '2026-01-01', endsOn: '2026-01-31', label: 'January 2026' }]);
  });

  it('a LOCKED month is absent (it cannot be overridden)', async () => {
    const f = await fixture('months-locked');
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;
    await sql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId}`;
    const lib = (await load(() => import('../../src/lib/period-override'), 'apps/erp/src/lib/period-override.ts')) as unknown as {
      closedMonths?: (orgId: string) => Promise<{ label: string }[]>;
    };
    expect(typeof lib.closedMonths).toBe('function');
    expect(await lib.closedMonths!(f.orgId)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// T3 / T5 / T6 — the action
// -----------------------------------------------------------------------------------------------

describe('payReimbursementAction — the override on the screen', () => {
  it('T1 on the screen: the admin, a closed-month date, confirm + reason + note -> ok banner; one override row for the admin', async () => {
    const f = await fixture('act-ok');
    const to = await submit(f.admin, payForm(f, { on: '2026-01-16', confirm: true, reason: 'data_entry_error', note: 'Receipt found late' }));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(param(to, 'ok')).toMatch(/^Paid ₱650/);
    const rows = await overrideRows(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_person_id: f.adminId, reason: 'data_entry_error', note: 'Receipt found late', period_status_at_post: 'closed' });
  });

  it('T3: a closed-month date with NO override fields -> the banner says the month is closed ("January 2026 is closed…"), no id; no entry, no override row — control: T1', async () => {
    const f = await fixture('act-t3');
    for (const who of [f.admin, f.manager]) {
      const to = await submit(who, payForm(f, { on: '2026-01-16' }));
      const error = param(to, 'error');
      expect(error, 'a refusal banner').toBeTruthy();
      expect(error, `the banner must name the month in words: ${error}`).toMatch(/^January 2026 is closed\b/);
      expect(error).not.toMatch(UUID);
      expect(error).not.toMatch(/\[hidden\]/);
    }
    expect(await payoutEntries(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });

  it('a manager who submits the override fields anyway is refused (they do not hold the capability); nothing posts, no row, no id in the banner', async () => {
    const f = await fixture('act-mgr');
    const to = await submit(f.manager, payForm(f, { on: '2026-01-16', confirm: true, reason: 'data_entry_error', note: 'Receipt found late' }));
    expect(param(to, 'error'), 'a refusal banner').toBeTruthy();
    expect(param(to, 'ok')).toBeNull();
    expect(param(to, 'error')).not.toMatch(UUID);
    expect(await payoutEntries(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });

  it('T5: an OPEN-month date WITH override fields posts, but the action DROPS the override — no period_overrides row (no audit noise) — Mutant: forward unconditionally -> a row with period_status_at_post "open", red', async () => {
    const f = await fixture('act-t5');
    const to = await submit(f.admin, payForm(f, { on: '2026-02-05', confirm: true, reason: 'data_entry_error', note: 'Not needed here' }));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(await payoutEntries(f.orgId)).toBe(1);
    expect(await overrideRows(f.orgId), 'an override audit row was written for an OPEN month').toHaveLength(0);
  });

  // (A confirm box ticked with NO reason, or "Other" with NO note, is a person's incomplete form, not a weakened
  // one: it gets a sentence naming what is missing — the S5a-audit legs at the end of this file.)
  it('T6: a FORGED invalid reason, or no confirm box, drops the override -> the closed-month refusal and no row', async () => {
    const f = await fixture('act-t6');
    const cases = [
      payForm(f, { on: '2026-01-16', confirm: true, reason: 'because I said so', note: 'x' }),
      payForm(f, { on: '2026-01-16', confirm: false, reason: 'data_entry_error', note: 'x' }),
    ];
    for (const fd of cases) {
      const to = await submit(f.admin, fd);
      expect(param(to, 'error')).toMatch(/^January 2026 is closed\b/);
    }
    expect(await payoutEntries(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------------
// T6 (render) — holders see the control, a manager does not
// -----------------------------------------------------------------------------------------------

describe('the page — the override control renders only for holders of override_period_lock', () => {
  it('the admin\'s HTML carries the marker, the three field names and the plain-word reason labels; the manager\'s carries none of them', async () => {
    const f = await fixture('render');

    const admin = await renderPage(f.admin, f);
    expect(admin, 'no data-closed-month-override marker for the admin').toContain('data-closed-month-override');
    for (const name of ['periodOverrideConfirm', 'periodOverrideReason', 'periodOverrideNote']) expect(admin, `missing ${name}`).toContain(`name="${name}"`);
    for (const label of ['Late supplier bill', 'Correction required by BIR/regulator', 'Fixing a mistake', 'Other']) expect(admin, `missing label ${label}`).toContain(label);
    expect(admin, 'no browser dialogs').not.toMatch(/\b(alert|confirm)\(/);

    const manager = await renderPage(f.manager, f);
    expect(manager).toMatch(/Ana Reyes/); // positive control: the manager's page renders its rows
    expect(manager, "a manager must not be handed the override control").not.toContain('data-closed-month-override');
    for (const name of ['periodOverrideConfirm', 'periodOverrideReason', 'periodOverrideNote']) expect(manager).not.toContain(name);
  });
});

// -----------------------------------------------------------------------------------------------
// S5a AUDIT legs (B, C) — added after the auditor's findings.
// -----------------------------------------------------------------------------------------------

describe('AUDIT B — an incomplete override form is refused with a sentence naming what is missing', () => {
  it('confirm ticked but NO reason -> "…reason…"; "Other" with NO note -> "…note…"; neither is the closed-month refusal; nothing posts — control: the complete form (T1)', async () => {
    const f = await fixture('auditB');

    const noReason = param(await submit(f.admin, payForm(f, { on: '2026-01-16', confirm: true, reason: '', note: 'Receipt found late' })), 'error');
    expect(noReason, 'a ticked confirm with no reason must be refused with a sentence').toBeTruthy();
    expect(noReason, `the form was silently dropped into the closed-month refusal: ${noReason}`).not.toMatch(/is closed/);
    expect(noReason).toMatch(/reason/i);
    expect(noReason).not.toMatch(UUID);

    const noNote = param(await submit(f.admin, payForm(f, { on: '2026-01-16', confirm: true, reason: 'other', note: '   ' })), 'error');
    expect(noNote, '"Other" with no note must be refused with a sentence').toBeTruthy();
    expect(noNote, `the form was silently dropped into the closed-month refusal: ${noNote}`).not.toMatch(/is closed/);
    expect(noNote).toMatch(/note/i);
    expect(noNote).not.toMatch(UUID);

    expect(await payoutEntries(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    const ok = param(await submit(f.admin, payForm(f, { on: '2026-01-16', confirm: true, reason: 'other', note: 'BIR asked for it' })), 'error');
    expect(ok, `the complete form was refused: ${ok}`).toBeNull();
  });
});

describe('AUDIT C — a LOCKED month with a full override is refused with the locked sentence', () => {
  it('admin + confirm + a valid reason + a note, dated in a locked month -> "January 2026 is locked…" (no id); nothing posted, no override row', async () => {
    const f = await fixture('auditC');
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId}`;
    await sql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId}`;

    const to = await submit(f.admin, payForm(f, { on: '2026-01-16', confirm: true, reason: 'data_entry_error', note: 'Receipt found late' }));
    const error = param(to, 'error');
    expect(error, 'a refusal banner').toBeTruthy();
    expect(error, `the locked month must say so: ${error}`).toMatch(/^January 2026 is locked\b/);
    expect(error).not.toMatch(UUID);
    expect(param(to, 'ok')).toBeNull();
    expect(await payoutEntries(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------------
// S5b — T7 on the screen: the approve form on `/expenses/[id]` (docs/tasks/369-unwired-money-screens.md §S5
// "BUILDER S5b": `approveExpenseAction` and `expenses/[id]/page.tsx` mounting the control).
//
// Same field names as S5a: periodOverrideConfirm · periodOverrideReason · periodOverrideNote, and the marker
// `data-closed-month-override`. The approve form carries `expenseId` (+ `storeId`); the DATE the action judges is
// the EXPENSE's own business date, read server-side (an expense's date is its invoice's — the form has no date field).
// The action forwards the override only when that date's month is `closed` (else it is dropped: no audit noise).
// -----------------------------------------------------------------------------------------------

/** Lipa; admin + manager; one DRAFT expense dated 10 Jan (January then CLOSED) and one dated 10 Feb (open). */
async function expenseFixture(hint: string) {
  const { seedExpenseCategories } = await import('../../../../packages/db/seed/expense-categories');
  const { createExpense } = await import('@shareat/domain');
  const code = uid(`t369s5bw-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', storeId);
  const managerId = await person(orgId, 'Manager', 'manager', storeId);
  const [cash] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
      lines: [{ accountCode: cash!.gl_account_code, storeId, debit: '100000.00' }, { accountCode: '3900', storeId, credit: '100000.00' }],
    }),
  );
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, 'Pork Co', ${adminId}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('r')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${adminId})
    returning id`;
  const [cat] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'`;
  const admin = actor(orgId, adminId);
  const draft = async (on: string) => {
    const [inv] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
                                     attested_supplier, attested_invoice, attested_items, attested_price)
      values (${orgId}, ${storeId}, ${supplier!.id}, ${on}, '99999999.00', 'verified', ${file!.id}, ${managerId}, now(), ${adminId}, true, true, true, true)
      returning id`;
    const made = await asOrg(orgId, (tx) =>
      createExpense(tx, admin, {
        storeId, supplierId: supplier!.id, supplierInvoiceId: inv!.id, businessDate: on, categoryId: cat!.id,
        particulars: `Pork, cash (${on})`, payments: [{ method: 'cash', amount: '1200.00', moneyAccountId: cash!.id }],
      }),
    );
    return made.id;
  };
  const closedExpenseId = await draft('2026-01-10');
  const openExpenseId = await draft('2026-02-10');
  await sql`update fiscal_periods set status = 'closed' where org_id = ${orgId} and starts_on = '2026-01-01'`;
  return { orgId, storeId, adminId, managerId, admin, manager: actor(orgId, managerId), closedExpenseId, openExpenseId };
}
type ExpenseFixture = Awaited<ReturnType<typeof expenseFixture>>;

const expenseEntries = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'expense_payment'`)[0]!.n);
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status;

function approveForm(f: ExpenseFixture, expenseId: string, o: { confirm?: boolean; reason?: string; note?: string } = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('expenseId', expenseId);
  if (o.confirm) fd.set('periodOverrideConfirm', 'on');
  if (o.reason !== undefined) fd.set('periodOverrideReason', o.reason);
  if (o.note !== undefined) fd.set('periodOverrideNote', o.note);
  return fd;
}
async function approveOnScreen(who: Actor, fd: FormData): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const { approveExpenseAction } = await import('../../src/app/expenses/actions');
  return expectRedirectTo(() => approveExpenseAction(fd));
}
async function renderExpensePage(who: Actor, f: ExpenseFixture, expenseId: string): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const { default: Page } = await import('../../src/app/expenses/[id]/page');
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: expenseId }), searchParams: Promise.resolve({ store: f.storeId }) } as never)) as never);
}

describe('T7 (S5b, web) — approveExpenseAction and the closed-month override', () => {
  it('the admin, an expense dated in the closed January, confirm + reason + note -> no error banner; the expense is posted; one override row for the admin — red on HEAD: the fields are ignored and the closed period refuses', async () => {
    const f = await expenseFixture('w-ok');
    const to = await approveOnScreen(f.admin, approveForm(f, f.closedExpenseId, { confirm: true, reason: 'data_entry_error', note: 'Receipt found late' }));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(await statusOf(f.closedExpenseId)).toBe('posted');
    const rows = await overrideRows(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_person_id: f.adminId, reason: 'data_entry_error', note: 'Receipt found late', period_status_at_post: 'closed' });
  });

  it('no override fields on a closed-month expense -> a refusal banner for the admin AND the manager; stays a draft; no entry, no row — positive control: the previous test', async () => {
    const f = await expenseFixture('w-none');
    for (const who of [f.admin, f.manager]) {
      const to = await approveOnScreen(who, approveForm(f, f.closedExpenseId));
      expect(param(to, 'error'), 'a refusal banner').toBeTruthy();
    }
    expect(await statusOf(f.closedExpenseId)).toBe('draft');
    expect(await expenseEntries(f.orgId)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    const ok = await approveOnScreen(f.admin, approveForm(f, f.closedExpenseId, { confirm: true, reason: 'data_entry_error', note: 'x' }));
    expect(param(ok, 'error'), `the control approval was refused: ${param(ok, 'error')}`).toBeNull();
  });

  it('a manager who submits the override fields anyway is refused (no override_period_lock); stays a draft; no row — positive control: the admin posts the same expense with the same fields', async () => {
    const f = await expenseFixture('w-mgr');
    const fields = { confirm: true, reason: 'data_entry_error', note: 'Receipt found late' };
    const to = await approveOnScreen(f.manager, approveForm(f, f.closedExpenseId, fields));
    expect(param(to, 'error'), 'a refusal banner').toBeTruthy();
    expect(await statusOf(f.closedExpenseId)).toBe('draft');
    expect(await overrideRows(f.orgId)).toHaveLength(0);

    const ok = await approveOnScreen(f.admin, approveForm(f, f.closedExpenseId, fields));
    expect(param(ok, 'error'), `the admin was refused: ${param(ok, 'error')}`).toBeNull();
    expect(await overrideRows(f.orgId)).toHaveLength(1);
  });

  it('an OPEN-month expense WITH override fields posts, but the action DROPS the override — no period_overrides row — Mutant: forward unconditionally -> a row with period_status_at_post "open", red', async () => {
    const f = await expenseFixture('w-open');
    const to = await approveOnScreen(f.admin, approveForm(f, f.openExpenseId, { confirm: true, reason: 'data_entry_error', note: 'Not needed here' }));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(await statusOf(f.openExpenseId)).toBe('posted');
    expect(await overrideRows(f.orgId), 'an override audit row was written for an OPEN month').toHaveLength(0);
  });

  it('a FORGED invalid reason, or no confirm box, drops the override -> refused, stays a draft, no row', async () => {
    const f = await expenseFixture('w-forged');
    for (const o of [{ confirm: true, reason: 'because I said so', note: 'x' }, { confirm: false, reason: 'data_entry_error', note: 'x' }]) {
      const to = await approveOnScreen(f.admin, approveForm(f, f.closedExpenseId, o));
      expect(param(to, 'error'), 'a refusal banner').toBeTruthy();
    }
    expect(await statusOf(f.closedExpenseId)).toBe('draft');
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });
});

describe('T7 (S5b, render) — the expense page offers the override control only to holders of override_period_lock', () => {
  it("the admin's HTML for the closed-month draft carries the marker, the three field names and the plain-word reason labels; the manager's carries none of them (positive control: it renders the draft's particulars and its Approve button)", async () => {
    const f = await expenseFixture('w-render');

    const admin = await renderExpensePage(f.admin, f, f.closedExpenseId);
    expect(admin, 'no data-closed-month-override marker for the admin').toContain('data-closed-month-override');
    for (const name of ['periodOverrideConfirm', 'periodOverrideReason', 'periodOverrideNote']) expect(admin, `missing ${name}`).toContain(`name="${name}"`);
    for (const label of ['Late supplier bill', 'Correction required by BIR/regulator', 'Fixing a mistake', 'Other']) expect(admin, `missing label ${label}`).toContain(label);
    expect(admin, 'no browser dialogs').not.toMatch(/\b(alert|confirm)\(/);

    const manager = await renderExpensePage(f.manager, f, f.closedExpenseId);
    expect(manager).toContain('Pork, cash (2026-01-10)');
    expect(manager).toMatch(/Approve &amp; post/);
    expect(manager, 'a manager must not be handed the override control').not.toContain('data-closed-month-override');
    for (const name of ['periodOverrideConfirm', 'periodOverrideReason', 'periodOverrideNote']) expect(manager).not.toContain(name);
  });
});

describe('T7 (S5b, web, T-364 order) — nothing about the expense is said before approve_expense is proven', () => {
  it('a staff member (no approve_expense) approving a closed-month expense gets the generic authorization refusal, not the closed-month sentence, even with a ticked, half-filled override form', async () => {
    const f = await expenseFixture('w-order');
    const staffId = await person(f.orgId, 'Cashier', 'staff', f.storeId);
    const to = await approveOnScreen(actor(f.orgId, staffId), approveForm(f, f.closedExpenseId, { confirm: true }));
    const err = param(to, 'error');
    expect(err, 'a refusal banner').toBeTruthy();
    expect(err).not.toMatch(/closed|Choose a reason|January/i);
    expect(await statusOf(f.closedExpenseId)).toBe('draft');
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });
});
