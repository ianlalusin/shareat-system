import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-475 S2 (TESTER) - what the expense pages hand the browser: /expenses/new (E1 E2 E3, C2 / F1, F5), /expenses/[id] edit card (E4,
 * F4, R12) and approve card (P1 P2 P3, F3, F7), plus R8 (loader and domain agree) and R10 (a page view writes no denial row).
 * Spec: docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md sections 3, 4, 6, 7 S2 and the amendments.
 *
 * HOW (shape-agnostic): <RuleCheck id facts> is replaced by a capture. For each id the test takes the facts the PAGE handed it and runs
 * the REAL check from BUSINESS_CHECKS with typed control values - exactly what the browser would do on a keystroke. So the fact shapes
 * are the builder's; pinned here are only (a) the check ids (see apps/erp/tests/t475-s2-expense-rules.test.ts), (b) the control names:
 * supplierInvoiceId, categoryId, MoneyLines' lineCount / lineMethod_i / lineAmount_i, periodOverrideConfirm, and (c) that RuleCheck is
 * mounted from the '@/components/forms' barrel (as S1's verify page does).
 *
 * MUTANTS: E1 `>=` (equal refused / a centavo over allowed), a split's rows judged one at a time; E2 Credit never offered because the
 * supplier is not fed in (`supplierId={null}`), COD not blocked; E3 inactive supplier unmarked / unblocked; E4 check removed, select
 * offering an unmapped category enabled, the draft's CURRENT unmapped category blocked (R12); P1 approve offered on a pending invoice;
 * P2 gated on override-holder again (loader skipped for a manager), a locked month lifted by the tick, a closed month not lifted by it;
 * P3 an unmapped category not shown; a loader sentence that differs from the real refusal (R8); the loader calling authorize() (R10).
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
const CAPTURED: Array<{ id: string; facts: unknown }> = [];
vi.mock('@/components/forms', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  RuleCheck: (props: { id: string; facts: unknown }) => {
    CAPTURED.push({ id: props.id, facts: props.facts });
    return null;
  },
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/money-lines/load', async () => await import('../../src/lib/money-lines/load'));
vi.mock('@/components/money/MoneyLines', async () => await import('../../src/components/money/MoneyLines'));

import { apRepo, closeDb } from '@shareat/db';
import { flushSecurityEvents } from '@shareat/auth';
import { approveExpense } from '@shareat/domain';
import { BUSINESS_CHECKS, capacityRefusal } from '@shareat/domain/business-rules';
import { cashOnDeliverySentence } from '../../../../packages/domain/src/shared/money-lines';
import { ap475Fixture, asOrg, type Fixture } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ID = {
  amountWithinRemaining: 'expense.new.amountWithinRemaining',
  creditNeedsTerms: 'expense.new.creditNeedsTerms',
  supplierActive: 'expense.new.supplierActive',
  categoryMapped: 'expense.edit.categoryMapped',
  invoiceVerified: 'expense.approve.invoiceVerified',
  periodOpen: 'expense.approve.periodOpen',
  wouldPost: 'expense.approve.wouldPost',
} as const;
// First-refusal order of the REAL approval (R9): the invoice, then the category / money / routing, then the period.
const P_ORDER = [ID.invoiceVerified, ID.wouldPost, ID.periodOpen] as const;

type Verdict = null | { level: 'block' | 'warn'; sentence: string };
const REGISTRY = BUSINESS_CHECKS as unknown as Record<string, { run(facts: unknown, values: Record<string, string>): Verdict }>;

/** Run the check `id` as the page configured it, against typed control values. */
function verdictOf(id: string, values: Record<string, string>): Verdict {
  expect(REGISTRY[id], `missing check ${id} in BUSINESS_CHECKS`).toBeTruthy();
  const hits = CAPTURED.filter((c) => c.id === id);
  expect(hits.length, `the page must mount <RuleCheck id="${id}">; mounted: ${[...new Set(CAPTURED.map((c) => c.id))].join(', ') || 'none'}`).toBeGreaterThan(0);
  return REGISTRY[id]!.run(hits[hits.length - 1]!.facts, values);
}
/** The values a MoneyLines block posts: a count plus a method and an amount per row. */
const lines = (rows: Array<{ method?: string; amount: string }>): Record<string, string> => {
  const v: Record<string, string> = { lineCount: String(rows.length) };
  rows.forEach((r, i) => {
    v[`lineMethod_${i}`] = r.method ?? 'cash';
    v[`lineAmount_${i}`] = r.amount;
  });
  return v;
};

async function renderNew(who: { orgId: string; personId: string }, storeId: string): Promise<string> {
  ACTOR_HOLDER.actor = who;
  CAPTURED.length = 0;
  const { default: Page } = await import('../../src/app/expenses/new/page');
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store: storeId }) } as never)) as never);
}
async function renderDetail(who: { orgId: string; personId: string }, expenseId: string): Promise<string> {
  ACTOR_HOLDER.actor = who;
  CAPTURED.length = 0;
  const { default: Page } = await import('../../src/app/expenses/[id]/page');
  return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: expenseId }), searchParams: Promise.resolve({}) } as never)) as never);
}
const optionTag = (html: string, id: string): string | null => html.match(new RegExp(`<option[^>]*value="${id}"[^>]*>`))?.[0] ?? null;
const optionText = (html: string, id: string): string | null => html.match(new RegExp(`<option[^>]*value="${id}"[^>]*>([^<]*)<`))?.[1] ?? null;
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status;

/** What the REAL approval says (userMessage), or null when it posted. */
async function realApproval(f: Fixture, who: Fixture['admin'], expenseId: string, override?: { reason: 'late_supplier_invoice'; note: null }): Promise<string | null> {
  try {
    await asOrg(f.orgId, (tx) => approveExpense(tx, who, expenseId, override ? { periodOverride: override } : undefined));
    return null;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? `RAW: ${(err as Error).message}`;
  }
}
/** The loader's verdict for an approve card: the first blocker in the real order, with the override tick as typed. */
function loaderVerdict(tick: boolean): string | null {
  for (const id of P_ORDER) {
    const v = verdictOf(id, tick ? { periodOverrideConfirm: 'on' } : {});
    if (v) return v.sentence;
  }
  return null;
}

// =====================================================================================================================
describe('T-475 S2 / E1 - an amount over what the invoice has left (/expenses/new)', () => {
  async function page() {
    const f = await ap475Fixture(sql, 'e1page');
    const inv = await f.invoice({ total: '5000.00', status: 'verified' });
    await f.draft(inv, { amount: '100.00' }); // 4900.00 left
    const html = await renderNew(f.admin, f.storeId);
    const row = (await asOrg(f.orgId, (tx) => apRepo.capacityOf(tx, f.orgId, inv)))!;
    return { f, inv, html, row };
  }

  it('an amount equal to what is left passes; one centavo over blocks with the capacity sentence (mutant: `>=` refuses equal / `>` dropped lets a centavo over through)', async () => {
    const { inv, row } = await page();
    expect(verdictOf(ID.amountWithinRemaining, { supplierInvoiceId: inv, ...lines([{ amount: '4900.00' }]) }), 'equal to the room passes').toBeNull();
    const over = verdictOf(ID.amountWithinRemaining, { supplierInvoiceId: inv, ...lines([{ amount: '4900.01' }]) });
    expect(over, 'one centavo over must block').not.toBeNull();
    expect(over!.level).toBe('block');
    expect(over!.sentence).toBe(capacityRefusal(row, '4900.01', 'draft')!.sentence);
    expect(over!.sentence).toMatch(/has only ₱4900\.00 left of ₱5000\.00; ₱4900\.01 doesn't fit\.$/);
  });

  it('the rows of a split are summed: 2000.00 + 2900.01 blocks, 2000.00 + 2900.00 passes (mutant: rows judged one at a time)', async () => {
    const { inv } = await page();
    expect(verdictOf(ID.amountWithinRemaining, { supplierInvoiceId: inv, ...lines([{ amount: '2000.00' }, { amount: '2900.00' }]) })).toBeNull();
    expect(verdictOf(ID.amountWithinRemaining, { supplierInvoiceId: inv, ...lines([{ amount: '2000.00' }, { amount: '2900.01' }]) })).not.toBeNull();
  });

  it('no invoice picked yet, or an amount not yet typed: no verdict (never a blocker on an empty form)', async () => {
    const { inv } = await page();
    expect(verdictOf(ID.amountWithinRemaining, lines([{ amount: '999999.00' }]))).toBeNull();
    expect(verdictOf(ID.amountWithinRemaining, { supplierInvoiceId: inv, ...lines([{ amount: '' }]) })).toBeNull();
  });
});

// =====================================================================================================================
describe('T-475 S2 / E2 + C2 (F1) - Credit on /expenses/new follows the picked invoice\'s supplier', () => {
  it('listOpenInvoicesForPicker carries each option\'s supplier id, name, credit terms (null = cash-on-delivery), status and room (mutant: facts missing, so the wrapper cannot know the supplier)', async () => {
    const f = await ap475Fixture(sql, 'e2data');
    const terms = await f.supplier({ name: 'Terms Co', creditTermsDays: 30 });
    const cod = await f.supplier({ name: 'Cash Only Co', creditTermsDays: null });
    const dormant = await f.supplier({ name: 'Dormant Co', status: 'inactive' });
    const a = await f.invoice({ supplierId: terms, status: 'verified', total: '2000.00' });
    const b = await f.invoice({ supplierId: cod, status: 'pending', total: '3000.00' });
    const c = await f.invoice({ supplierId: dormant, status: 'verified', total: '4000.00' });
    const { listOpenInvoicesForPicker } = await import('../../src/app/ap/lib');
    const opts = (await listOpenInvoicesForPicker(f.orgId, f.storeId)) as unknown as Array<Record<string, unknown>>;
    const by = (id: string) => opts.find((o) => o.id === id);
    expect(by(a), 'terms supplier invoice listed').toMatchObject({ supplierId: terms, supplierName: 'Terms Co', creditTermsDays: 30, supplierStatus: 'active', remaining: '2000.00' });
    expect(by(b), 'COD supplier invoice listed').toMatchObject({ supplierId: cod, supplierName: 'Cash Only Co', creditTermsDays: null, supplierStatus: 'active' });
    expect(by(c), 'inactive supplier invoice listed (F5 marks it, it does not vanish)').toMatchObject({ supplierId: dormant, supplierStatus: 'inactive' });
  });

  it('E2: a Credit row on a cash-on-delivery supplier blocks with cashOnDeliverySentence; Credit on a terms supplier, and Cash on a COD supplier, pass (mutant: COD not blocked)', async () => {
    const f = await ap475Fixture(sql, 'e2page');
    const terms = await f.supplier({ name: 'Terms Co', creditTermsDays: 30 });
    const cod = await f.supplier({ name: 'Cash Only Co', creditTermsDays: null });
    const termsInv = await f.invoice({ supplierId: terms, status: 'verified' });
    const codInv = await f.invoice({ supplierId: cod, status: 'verified' });
    await renderNew(f.admin, f.storeId);
    const credit = lines([{ method: 'credit', amount: '500.00' }]);
    const blocked = verdictOf(ID.creditNeedsTerms, { supplierInvoiceId: codInv, ...credit });
    expect(blocked, 'credit on a COD supplier must block').not.toBeNull();
    expect(blocked!.level).toBe('block');
    expect(blocked!.sentence).toBe(cashOnDeliverySentence('Cash Only Co'));
    expect(verdictOf(ID.creditNeedsTerms, { supplierInvoiceId: termsInv, ...credit }), 'credit on a terms supplier passes').toBeNull();
    expect(verdictOf(ID.creditNeedsTerms, { supplierInvoiceId: codInv, ...lines([{ method: 'cash', amount: '500.00' }]) }), 'cash on COD passes').toBeNull();
    expect(verdictOf(ID.creditNeedsTerms, credit), 'no invoice picked: no verdict').toBeNull();
  });
});

// =====================================================================================================================
describe('T-475 S2 / E3 + F5 - an invoice of an inactive supplier', () => {
  it('the picker marks the row "(supplier inactive)" and E3 blocks it with the exact sentence; an active supplier\'s row is neither marked nor blocked (mutant: unmarked / unblocked)', async () => {
    const f = await ap475Fixture(sql, 'e3page');
    const dormant = await f.supplier({ name: 'Dormant Co', status: 'inactive' });
    const bad = await f.invoice({ supplierId: dormant, status: 'verified', invoiceNo: 'D-1' });
    const good = await f.invoice({ status: 'verified', invoiceNo: 'G-1' });
    const html = await renderNew(f.admin, f.storeId);

    expect(optionText(html, bad), 'the inactive supplier\'s invoice is still listed, but marked').toMatch(/supplier inactive/i);
    expect(optionText(html, good)).not.toMatch(/supplier inactive/i);

    const v = verdictOf(ID.supplierActive, { supplierInvoiceId: bad });
    expect(v, 'an inactive supplier\'s invoice must block').not.toBeNull();
    expect(v!.level).toBe('block');
    expect(v!.sentence).toBe('Dormant Co is inactive, not active — an expense cannot be recorded against a supplier the business has stopped buying from.');
    expect(verdictOf(ID.supplierActive, { supplierInvoiceId: good })).toBeNull();
    expect(verdictOf(ID.supplierActive, {}), 'nothing picked').toBeNull();
  });
});

// =====================================================================================================================
describe('T-475 S2 / E4 + F4 + R12 - the draft\'s category select and rule', () => {
  it('on a draft with a mapped category: the select DISABLES a category with no ledger account; E4 blocks a change onto it with the exact sentence, passes a mapped one and the current one (mutant: select enabled / check removed)', async () => {
    const f = await ap475Fixture(sql, 'e4page');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv);
    const unmapped = await f.unmappedCategory();
    const mapped = (await sql<{ id: string }[]>`select id from expense_categories where org_id = ${f.orgId} and account_code is not null and id <> ${f.categoryId} limit 1`)[0]!.id;
    const html = await renderDetail(f.admin, id);

    const tag = optionTag(html, unmapped);
    expect(tag, 'the unmapped category is listed').not.toBeNull();
    expect(tag, 'and disabled (F4)').toMatch(/disabled/);
    expect(optionTag(html, mapped)).not.toMatch(/disabled/);

    const v = verdictOf(ID.categoryMapped, { categoryId: unmapped });
    expect(v, 'a change onto an unmapped category must block').not.toBeNull();
    expect(v!.level).toBe('block');
    expect(v!.sentence).toBe("This category has no ledger account yet, so the draft can't post. Pick another category.");
    expect(verdictOf(ID.categoryMapped, { categoryId: mapped })).toBeNull();
    expect(verdictOf(ID.categoryMapped, { categoryId: f.categoryId }), 'keeping the current category').toBeNull();
  });

  it('R12 on the page: a draft that already sits on an unmapped category still shows it (enabled, selected); keeping it passes, another unmapped one blocks (mutant: the current category blocked / hidden)', async () => {
    const f = await ap475Fixture(sql, 'r12page');
    const inv = await f.invoice({ status: 'verified' });
    const current = await f.unmappedCategory();
    const otherUnmapped = await f.unmappedCategory();
    const id = await f.draft(inv, { categoryId: current });
    const html = await renderDetail(f.admin, id);

    const tag = optionTag(html, current);
    expect(tag, 'the draft\'s own unmapped category is still shown').not.toBeNull();
    expect(tag).not.toMatch(/disabled/);
    expect(tag).toMatch(/selected/);
    expect(optionTag(html, otherUnmapped), 'another unmapped category is disabled').toMatch(/disabled/);
    expect(verdictOf(ID.categoryMapped, { categoryId: current }), 'keeping the current unmapped category passes').toBeNull();
    expect(verdictOf(ID.categoryMapped, { categoryId: otherUnmapped })!.sentence).toMatch(/has no ledger account yet/);
  });
});

// =====================================================================================================================
describe('T-475 S2 / P1 + P3 + R8 - Approve & post: the loader says what the real approval says', () => {
  it('a draft on a PENDING invoice: P1 blocks with the real refusal\'s words (F3); a verified invoice\'s clean draft shows nothing and then really posts (positive control)', async () => {
    const f = await ap475Fixture(sql, 'p1page');
    const pendingInv = await f.invoice({ status: 'pending' });
    const pendingDraft = await f.draft(pendingInv);
    await renderDetail(f.admin, pendingDraft);
    const p1 = verdictOf(ID.invoiceVerified, {});
    expect(p1, 'approve on a pending invoice is a certain refusal: P1 must block').not.toBeNull();
    expect(p1!.level).toBe('block');
    expect(p1!.sentence).toMatch(/hasn't been verified yet, so this can't post against it\.$/);
    expect(p1!.sentence).toBe(await realApproval(f, f.admin, pendingDraft));
    expect(await statusOf(pendingDraft)).toBe('draft');

    const okInv = await f.invoice({ status: 'verified' });
    const okDraft = await f.draft(okInv);
    await renderDetail(f.admin, okDraft);
    for (const id of P_ORDER) expect(verdictOf(id, {}), `${id} on a clean draft`).toBeNull();
    expect(await realApproval(f, f.admin, okDraft)).toBeNull();
    expect(await statusOf(okDraft)).toBe('posted');
  });

  it('P3: a draft on an unmapped category blocks with the real refusal\'s words, and P1 does not (mutant: P3 not shown / gather skips the category)', async () => {
    const f = await ap475Fixture(sql, 'p3page');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv, { categoryId: await f.unmappedCategory() });
    await renderDetail(f.admin, id);
    expect(verdictOf(ID.invoiceVerified, {})).toBeNull();
    const p3 = verdictOf(ID.wouldPost, {});
    expect(p3, 'an unmapped category is a certain refusal: P3 must block').not.toBeNull();
    expect(p3!.level).toBe('block');
    expect(p3!.sentence).toBe(await realApproval(f, f.admin, id));
    expect(await statusOf(id)).toBe('draft');
  });
});

// =====================================================================================================================
describe('T-475 S2 / P2 + F7 - the month the draft would post into', () => {
  async function draftIn(hint: string, month: 'locked' | 'closed' | 'open') {
    const f = await ap475Fixture(sql, hint);
    const inv = await f.invoice({ status: 'verified', on: '2026-01-10' });
    const id = await f.draft(inv, { on: '2026-01-10' });
    if (month !== 'open') await f.setPeriod('2026-01-01', month);
    return { f, id };
  }
  const LOCKED = /is locked\. Nothing can be posted into it, not even with the closed-month override\.$/;
  const CLOSED = /is closed\. Ask an administrator to post this one entry into it\.$/;

  it('a LOCKED month blocks even with the override ticked, with the real refusal\'s words (mutant: the tick lifts a lock)', async () => {
    const { f, id } = await draftIn('p2lock', 'locked');
    await renderDetail(f.admin, id);
    const plain = verdictOf(ID.periodOpen, {});
    expect(plain, 'a locked month blocks').not.toBeNull();
    expect(plain!.level).toBe('block');
    expect(plain!.sentence).toMatch(LOCKED);
    const ticked = verdictOf(ID.periodOpen, { periodOverrideConfirm: 'on' });
    expect(ticked, 'a locked month blocks even with the override ticked').not.toBeNull();
    expect(ticked!.sentence).toMatch(LOCKED);
    expect(await realApproval(f, f.admin, id, { reason: 'late_supplier_invoice', note: null })).toBe(plain!.sentence);
    expect(await statusOf(id)).toBe('draft');
  });

  it('a CLOSED month blocks an override HOLDER until the override is ticked, then passes - and the real approval then posts (mutant: tick ignored)', async () => {
    const { f, id } = await draftIn('p2closedholder', 'closed');
    await renderDetail(f.admin, id);
    const plain = verdictOf(ID.periodOpen, {});
    expect(plain, 'a closed month blocks without the override').not.toBeNull();
    expect(plain!.sentence).toMatch(CLOSED);
    expect(plain!.sentence).toBe(await realApproval(f, f.admin, id));
    expect(verdictOf(ID.periodOpen, { periodOverrideConfirm: 'on' }), 'ticked: passes').toBeNull();
    expect(await realApproval(f, f.admin, id, { reason: 'late_supplier_invoice', note: null })).toBeNull();
    expect(await statusOf(id)).toBe('posted');
  });

  it('a CLOSED month is shown to a manager who CANNOT override too: the loader runs for everyone (mutant: gated on override_period_lock again)', async () => {
    const { f, id } = await draftIn('p2closedmgr', 'closed');
    const html = await renderDetail(f.manager, id);
    expect(html, 'control: a manager is not offered the override').not.toContain('data-closed-month-override');
    const v = verdictOf(ID.periodOpen, {});
    expect(v, 'the manager learns the month is closed BEFORE pressing Approve').not.toBeNull();
    expect(v!.level).toBe('block');
    expect(v!.sentence).toMatch(CLOSED);
    expect(v!.sentence).toBe(await realApproval(f, f.manager, id));
    expect(await statusOf(id)).toBe('draft');
  });

  it('an OPEN month shows nothing to anyone (positive control)', async () => {
    const { f, id } = await draftIn('p2open', 'open');
    await renderDetail(f.manager, id);
    expect(verdictOf(ID.periodOpen, {})).toBeNull();
    expect(verdictOf(ID.periodOpen, { periodOverrideConfirm: 'on' })).toBeNull();
  });
});

// =====================================================================================================================
describe('T-475 S2 / R8 - the page\'s verdict and the real refusal agree for the same rows', () => {
  const cases: Array<{ name: string; build: (f: Fixture) => Promise<string>; viewer: 'admin' | 'manager'; month?: 'locked' | 'closed' }> = [
    { name: 'pending invoice', viewer: 'admin', build: async (f) => f.draft(await f.invoice({ status: 'pending' })) },
    { name: 'unmapped category', viewer: 'admin', build: async (f) => f.draft(await f.invoice({ status: 'verified' }), { categoryId: await f.unmappedCategory() }) },
    { name: 'locked month', viewer: 'admin', month: 'locked', build: async (f) => f.draft(await f.invoice({ status: 'verified', on: '2026-01-10' }), { on: '2026-01-10' }) },
    { name: 'closed month, a manager', viewer: 'manager', month: 'closed', build: async (f) => f.draft(await f.invoice({ status: 'verified', on: '2026-01-10' }), { on: '2026-01-10' }) },
  ];
  for (const c of cases) {
    it(`${c.name}: the first blocker the approve card shows is word for word the real approval's refusal (mutant: leaf and domain sentences diverge)`, async () => {
      const f = await ap475Fixture(sql, `r8-${c.name.slice(0, 6).replace(/\W/g, '')}`);
      const id = await c.build(f);
      if (c.month) await f.setPeriod('2026-01-01', c.month);
      await renderDetail(f[c.viewer], id);
      const shown = loaderVerdict(false);
      expect(shown, 'the card shows a blocker').not.toBeNull();
      expect(shown).toBe(await realApproval(f, f[c.viewer], id));
    });
  }
});

// =====================================================================================================================
describe('T-475 S2 / R10 - looking at the page never writes a denial row', () => {
  it('floor staff (who may not create or approve expenses) open /expenses/new and a draft\'s page: both still mount their rule checks, and no audit row and no denial counter is written (mutant: a loader calls authorize())', async () => {
    const f = await ap475Fixture(sql, 'r10');
    const inv = await f.invoice({ status: 'pending' });
    const id = await f.draft(inv);
    const counts = async () =>
      (await sql<{ a: string; c: string }[]>`
        select (select count(*) from audit_log where org_id = ${f.orgId})::text as a,
               (select count(*) from authz_denial_counts where org_id = ${f.orgId})::text as c`)[0]!;
    await flushSecurityEvents();
    const before = await counts();

    await renderNew(f.staff, f.storeId);
    expect(CAPTURED.length, 'control: /expenses/new mounts its rule checks even for a viewer who may not create').toBeGreaterThan(0);
    await renderDetail(f.staff, id);
    expect(CAPTURED.some((c) => c.id === ID.invoiceVerified), 'control: the draft page mounts P1 for a viewer who may not approve (the loader runs for everyone)').toBe(true);

    await flushSecurityEvents();
    expect(await counts(), 'a page view wrote an audit or denial row').toEqual(before);
  });
});


// =====================================================================================================================
describe('T-475 S2 / audit F1 - P3 still shows the first NON-invoice blocker when P1 blocks for another reason', () => {
  async function voidedDraft(hint: string, unmapped: boolean) {
    const f = await ap475Fixture(sql, hint);
    const cat = unmapped ? await f.unmappedCategory() : undefined;
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv, cat ? { categoryId: cat } : {});
    await sql`update supplier_invoices set status = 'voided', voided_by = ${f.verifierId}, voided_at = now(), void_reason = 'test' where id = ${inv}`;
    return { f, id, cat };
  }

  it('voided invoice + unmapped category: P1 shows the invoice sentence AND P3 shows the unmapped-category sentence (mutant: P3 filters out the whole verdict when the invoice refuses first)', async () => {
    const { f, id, cat } = await voidedDraft('f1a', true);
    // reference: the same category (same fixture, so the same name in the sentence) on a healthy invoice
    const refDraft = await f.draft(await f.invoice({ status: 'verified' }), { categoryId: cat! });
    const unmappedSentence = (await realApproval(f, f.admin, refDraft))!;
    expect(unmappedSentence, 'fixture: the unmapped-category refusal on a healthy invoice').toBeTruthy();

    await renderDetail(f.admin, id);
    const p1 = verdictOf(ID.invoiceVerified, {});
    expect(p1, 'P1 shows the invoice refusal').not.toBeNull();
    expect(p1!.sentence).toMatch(/voided|left of/);
    const p3 = verdictOf(ID.wouldPost, {});
    expect(p3, 'P3 must still show the unmapped category behind the invoice refusal').not.toBeNull();
    expect(p3!.sentence).toBe(unmappedSentence);
  });

  it('positive control: voided invoice and everything else fine: P1 blocks, P3 is empty', async () => {
    const { f, id } = await voidedDraft('f1b', false);
    await renderDetail(f.admin, id);
    expect(verdictOf(ID.invoiceVerified, {})).not.toBeNull();
    expect(verdictOf(ID.wouldPost, {})).toBeNull();
  });
});
