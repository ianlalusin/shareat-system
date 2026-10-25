import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-475 S2 (TESTER) - the server keeps re-checking: every live check on the expense forms is also refused when the client is bypassed
 * (a raw POST to the real server action), with the same sentence the screen shows. Spec: docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md
 * section 3.3 ("the domain still runs every check on every save") and 7 S2 ("server refuses each when the client is bypassed").
 *
 * Which legs are red on HEAD: E4 (updateDraftAction / editExpense has no category check). E1, E2, E3, P1, P2 are already refused today - those
 * are GUARDS that must stay green, byte-identical, when the sentences move into the leaf. Each refusal has a positive control (the same POST
 * with the one fault removed saves / posts), so a refusal can never be a fixture problem.
 *
 * MUTANTS: E1 `>=`; the E4 check removed; E4 refusing a re-post of the draft's CURRENT unmapped category (the edit form always posts the
 * category - R12); a closed month lifted for a manager by a forged override POST; a locked month lifted by the override; a pending invoice
 * posting.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/lib/money-lines/load', async () => await import('../../src/lib/money-lines/load'));

import { closeDb } from '@shareat/db';
import { cashOnDeliverySentence } from '../../../../packages/domain/src/shared/money-lines';
import { ap475Fixture, type Fixture } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';
import { captureRedirect, outcomeOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const E4 = "This category has no ledger account yet, so the draft can't post. Pick another category.";

type Who = { personId: string; orgId: string };
async function post(who: Who, action: 'createExpenseAction' | 'updateDraftAction' | 'approveExpenseAction', fields: Record<string, string>) {
  h.actor = who;
  const mod = (await import('../../src/app/expenses/actions')) as unknown as Record<string, (fd: FormData) => Promise<void>>;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const signal = await captureRedirect(() => mod[action]!(fd));
  const o = outcomeOf(signal);
  return { to: signal.url, path: o.path, error: o.flash.error, ok: o.flash.ok };
}

/** What /expenses/new posts for a one-row payment block. */
function newForm(f: Fixture, inv: string, o: { supplierId?: string; amount: string; method?: 'cash' | 'credit' }): Record<string, string> {
  const credit = o.method === 'credit';
  return {
    returnTo: '/expenses/new',
    storeId: f.storeId,
    supplierId: o.supplierId ?? f.supplierId,
    supplierInvoiceId: inv,
    categoryId: f.categoryId,
    particulars: 'T-475 S2 raw POST',
    lineCount: '1',
    lineMethod_0: credit ? 'credit' : 'cash',
    lineAmount_0: o.amount,
    lineAccount_0: credit ? '' : f.cashId,
    lineRequest_0: '',
    lineStaff_0: '',
  };
}
const rowsFor = async (invoiceId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from expenses where supplier_invoice_id = ${invoiceId}`)[0]!.n);
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status;
const columnOf = async (id: string) => (await sql<{ category_id: string; particulars: string }[]>`select category_id, particulars from expenses where id = ${id}`)[0]!;

describe('T-475 S2 / E1 raw POST - more than the invoice has left', () => {
  it('one centavo over the room is refused with the capacity sentence and nothing is written; exactly the room saves a draft (mutant: `>=`)', async () => {
    const f = await ap475Fixture(sql, 'e1post');
    const inv = await f.invoice({ total: '5000.00', status: 'verified' });
    await f.draft(inv, { amount: '100.00' }); // 4900.00 left
    const before = await rowsFor(inv);
    const refused = await post(f.admin, 'createExpenseAction', newForm(f, inv, { amount: '4900.01' }));
    expect(refused.error, `redirected to ${refused.to}`).toMatch(/has only ₱4900\.00 left of ₱5000\.00; ₱4900\.01 doesn't fit\.$/);
    expect(await rowsFor(inv)).toBe(before);

    const ok = await post(f.admin, 'createExpenseAction', newForm(f, inv, { amount: '4900.00' }));
    expect(ok.error, `redirected to ${ok.to}`).toBeUndefined();
    expect(ok.path).toMatch(/^\/expenses\/[0-9a-f-]{36}$/);
    expect(await rowsFor(inv)).toBe(before + 1);
  });
});

describe('T-475 S2 / E2 raw POST - Credit against a cash-on-delivery supplier', () => {
  it('refused with cashOnDeliverySentence and nothing is written; the same credit row on a supplier with terms saves a draft', async () => {
    const f = await ap475Fixture(sql, 'e2post');
    const cod = await f.supplier({ name: 'Cash Only Co', creditTermsDays: null });
    const terms = await f.supplier({ name: 'Terms Co', creditTermsDays: 30 });
    const codInv = await f.invoice({ supplierId: cod, status: 'verified' });
    const termsInv = await f.invoice({ supplierId: terms, status: 'verified' });
    const refused = await post(f.admin, 'createExpenseAction', newForm(f, codInv, { supplierId: cod, amount: '500.00', method: 'credit' }));
    expect(refused.error, `redirected to ${refused.to}`).toBe(cashOnDeliverySentence('Cash Only Co'));
    expect(await rowsFor(codInv)).toBe(0);

    const ok = await post(f.admin, 'createExpenseAction', newForm(f, termsInv, { supplierId: terms, amount: '500.00', method: 'credit' }));
    expect(ok.error, `redirected to ${ok.to}`).toBeUndefined();
    expect(await rowsFor(termsInv)).toBe(1);
  });
});

describe('T-475 S2 / E3 raw POST - an invoice of an inactive supplier', () => {
  it('refused with the exact sentence and nothing is written; an active supplier\'s invoice saves (positive control)', async () => {
    const f = await ap475Fixture(sql, 'e3post');
    const dormant = await f.supplier({ name: 'Dormant Co', status: 'inactive' });
    const bad = await f.invoice({ supplierId: dormant, status: 'verified' });
    const good = await f.invoice({ status: 'verified' });
    const refused = await post(f.admin, 'createExpenseAction', newForm(f, bad, { supplierId: dormant, amount: '100.00' }));
    expect(refused.error, `redirected to ${refused.to}`).toBe('Dormant Co is inactive, not active — an expense cannot be recorded against a supplier the business has stopped buying from.');
    expect(await rowsFor(bad)).toBe(0);
    const ok = await post(f.admin, 'createExpenseAction', newForm(f, good, { amount: '100.00' }));
    expect(ok.error).toBeUndefined();
    expect(await rowsFor(good)).toBe(1);
  });
});

describe('T-475 S2 / E4 + R12 raw POST - the draft edit form (updateDraftAction)', () => {
  const edit = (f: Fixture, expenseId: string, categoryId: string, particulars = 'Edited particulars') => ({ storeId: f.storeId, expenseId, categoryId, particulars });

  it('a category with no ledger account is refused with the exact sentence and the draft does not move; a mapped category saves (mutant: check removed)', async () => {
    const f = await ap475Fixture(sql, 'e4post');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv, { particulars: 'Original' });
    const unmapped = await f.unmappedCategory();
    const refused = await post(f.admin, 'updateDraftAction', edit(f, id, unmapped));
    expect(refused.error, `redirected to ${refused.to}`).toBe(E4);
    expect(await columnOf(id)).toMatchObject({ category_id: f.categoryId, particulars: 'Original' });

    const mapped = (await sql<{ id: string }[]>`select id from expense_categories where org_id = ${f.orgId} and account_code is not null and id <> ${f.categoryId} limit 1`)[0]!.id;
    const ok = await post(f.admin, 'updateDraftAction', edit(f, id, mapped));
    expect(ok.error).toBeUndefined();
    expect(await columnOf(id)).toMatchObject({ category_id: mapped, particulars: 'Edited particulars' });
  });

  it('R12: a draft already on an unmapped category: the form re-posts that same category with new particulars and it SAVES; another unmapped category is refused (mutant: any edit refused / a re-post refused)', async () => {
    const f = await ap475Fixture(sql, 'r12post');
    const inv = await f.invoice({ status: 'verified' });
    const current = await f.unmappedCategory();
    const other = await f.unmappedCategory();
    const id = await f.draft(inv, { categoryId: current, particulars: 'Original' });
    const keep = await post(f.admin, 'updateDraftAction', edit(f, id, current, 'Fixed a typo'));
    expect(keep.error, `redirected to ${keep.to}`).toBeUndefined();
    expect(await columnOf(id)).toMatchObject({ category_id: current, particulars: 'Fixed a typo' });

    const move = await post(f.admin, 'updateDraftAction', edit(f, id, other, 'Should not save'));
    expect(move.error).toBe(E4);
    expect(await columnOf(id)).toMatchObject({ category_id: current, particulars: 'Fixed a typo' });
  });
});

describe('T-475 S2 / P1 raw POST - approving a draft on a pending invoice', () => {
  it('refused with the "hasn\'t been verified yet" sentence and it stays a draft; a draft on a verified invoice posts (positive control)', async () => {
    const f = await ap475Fixture(sql, 'p1post');
    const pending = await f.draft(await f.invoice({ status: 'pending' }));
    const refused = await post(f.admin, 'approveExpenseAction', { storeId: f.storeId, expenseId: pending });
    expect(refused.error, `redirected to ${refused.to}`).toMatch(/hasn't been verified yet, so this can't post against it\.$/);
    expect(await statusOf(pending)).toBe('draft');

    const verified = await f.draft(await f.invoice({ status: 'verified' }));
    const ok = await post(f.admin, 'approveExpenseAction', { storeId: f.storeId, expenseId: verified });
    expect(ok.error).toBeUndefined();
    expect(ok.ok).toBe('Expense posted.');
    expect(await statusOf(verified)).toBe('posted');
  });
});

describe('T-475 S2 / P2 raw POST - a locked or closed month', () => {
  const OVERRIDE = { periodOverrideConfirm: 'on', periodOverrideReason: 'late_supplier_invoice', periodOverrideNote: '' };
  async function draftIn(hint: string, month: 'locked' | 'closed') {
    const f = await ap475Fixture(sql, hint);
    const id = await f.draft(await f.invoice({ status: 'verified', on: '2026-01-10' }), { on: '2026-01-10' });
    await f.setPeriod('2026-01-01', month);
    return { f, id };
  }

  it('a LOCKED month is refused even with a complete override POSTed by an admin, and it stays a draft (mutant: the override lifts a lock)', async () => {
    const { f, id } = await draftIn('p2lockpost', 'locked');
    const refused = await post(f.admin, 'approveExpenseAction', { storeId: f.storeId, expenseId: id, ...OVERRIDE });
    expect(refused.error, `redirected to ${refused.to}`).toMatch(/is locked\. Nothing can be posted into it, not even with the closed-month override\.$/);
    expect(await statusOf(id)).toBe('draft');
  });

  it('a CLOSED month: a manager is refused with the closed sentence, and a forged override in the POST does not lift it; the admin with a complete override posts (positive control)', async () => {
    const { f, id } = await draftIn('p2closedpost', 'closed');
    const plain = await post(f.manager, 'approveExpenseAction', { storeId: f.storeId, expenseId: id });
    expect(plain.error, `redirected to ${plain.to}`).toMatch(/is closed\. Ask an administrator to post this one entry into it\.$/);
    expect(await statusOf(id)).toBe('draft');

    const forged = await post(f.manager, 'approveExpenseAction', { storeId: f.storeId, expenseId: id, ...OVERRIDE });
    expect(forged.error, 'a manager without override_period_lock cannot lift a closed month by posting the fields').toBeTruthy();
    expect(forged.ok).toBeUndefined();
    expect(await statusOf(id)).toBe('draft');

    const ok = await post(f.admin, 'approveExpenseAction', { storeId: f.storeId, expenseId: id, ...OVERRIDE });
    expect(ok.error, `redirected to ${ok.to}`).toBeUndefined();
    expect(await statusOf(id)).toBe('posted');
  });
});

describe('T-475 S2 / audit F4 raw POST - more payment lines than the cap', () => {
  it('51 lines are refused with the cap sentence and nothing is written; 50 is the limit the sentence names (positive control: 1 line saves)', async () => {
    const f = await ap475Fixture(sql, 'f4');
    const inv = await f.invoice({ total: '5000.00', status: 'verified' });
    const fields = newForm(f, inv, { amount: '1.00' });
    fields.lineCount = '51';
    for (let i = 1; i < 51; i++) {
      fields[`lineMethod_${i}`] = 'cash';
      fields[`lineAmount_${i}`] = '1.00';
      fields[`lineAccount_${i}`] = f.cashId;
    }
    const refused = await post(f.admin, 'createExpenseAction', fields);
    expect(refused.error, `redirected to ${refused.to}`).toBe('An expense can carry at most 50 payment lines.');
    expect(await rowsFor(inv)).toBe(0);
    const ok = await post(f.admin, 'createExpenseAction', newForm(f, inv, { amount: '1.00' }));
    expect(ok.error).toBeUndefined();
  });
});
