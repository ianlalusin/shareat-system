import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

/**
 * T-389 S3 (TESTER) - budgets: a category's cap (amount, renew automatically, how often).
 * Census: budgets/page.tsx `CapForm`, <EditableRecord action={setBudgetAction} label="cap" hidden={{ storeId, periodKey,
 * categoryId }}>, rendered only for a category that already has a cap (the "no cap yet" form is an add form: N1, out of
 * scope). Refusal driven: a NEGATIVE cap with renew-automatically ticked ("A cap cannot be negative.").
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - record id = the cap's category id (the page is already one store + one period, so the category is unique on it).
 *  - allow-list = amount, autoReissue, reissueInterval. NOT storeId, periodKey, categoryId.
 *  - SPEC GAP (same as S1's supplier): each cap's form sits inside its own closed <details>. A reopened (or dropped)
 *    cap must be VISIBLE, so the page opens THAT cap's <details> when it has a typed view; the other cap stays closed.
 *  - the refusal puts the person back on the same store + period (nav keys store, period), so the page can find the cap.
 * Harness and legs: t389-s3-common.ts (the S1 supplier pattern).
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/forms', async (orig) => {
  const real = await orig<typeof import('@/components/forms')>();
  const { createElement } = await import('react');
  return {
    ...real,
    EditableRecord: (p: Record<string, unknown>) => {
      if (p) seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { setExpenseBudget } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { actor, asOrg, captureRedirect, closeAfterAll, keepTypingLegs, outcomeOf, person, resetJar, sql, uid } from './t389-s3-common';

closeAfterAll();

async function setup(hint: string) {
  const code = uid(`t389s3bd-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const adminId = await person(orgId, 'Admin', 'admin', [storeId]);
  const admin2Id = await person(orgId, 'Admin Two', 'admin', [storeId]);
  const admin = actor(orgId, adminId);
  const cat = async () =>
    (await sql<{ id: string }[]>`insert into expense_categories (org_id, "group", category, account_code) values (${orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`)[0]!.id;
  const catA = await cat();
  const catB = await cat();
  const { currentPeriodKey } = await import('../../src/app/budgets/lib');
  const periodKey = currentPeriodKey();
  for (const [categoryId, amount] of [[catA, '1000.00'], [catB, '500.00']] as const) {
    await asOrg(orgId, (tx) => setExpenseBudget(tx, admin, { storeId, categoryId, periodKey, amount, autoReissue: false, reissueInterval: null }));
  }
  return { orgId, storeId, periodKey, catA, catB, admin, other: actor(orgId, admin2Id) };
}
type C = Awaited<ReturnType<typeof setup>>;

keepTypingLegs<C>({
  area: 'budgets cap',
  setup,
  admin: (c) => c.admin,
  other: (c) => c.other,
  recordId: (c) => c.catA,
  siblingId: (c) => c.catB,
  marker: (_c, id) => `name="categoryId" value="${id}"`,
  inDetails: true,
  refusedForm: (c, over = {}) => {
    const base: Record<string, string> = {
      storeId: c.storeId, periodKey: c.periodKey, categoryId: c.catA, amount: '-5.55', autoReissue: 'on', reissueInterval: 'weekly',
    };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
    return fd;
  },
  async submit(_c, fd, who) {
    h.actor = who;
    const { setBudgetAction } = await import('../../src/app/budgets/actions');
    const signal = await captureRedirect(() => setBudgetAction(fd));
    const o = outcomeOf(signal);
    return { signal, error: o.flash.error, ok: o.flash.ok };
  },
  expectError: /cannot be negative/i,
  expectedFields: () => ({ amount: '-5.55', autoReissue: 'on', reissueInterval: 'weekly' }),
  neverKept: () => ['storeId', 'periodKey', 'categoryId'],
  // The box left UNticked and changed: it must reopen unticked, so it rides as an empty array.
  changedLeg: () => ({ changed: 'amount,autoReissue', over: { autoReissue: null }, fields: { amount: '-5.55', autoReissue: [] } }),
  async render(c, who, params) {
    h.actor = who;
    seen.records = [];
    const { default: Page } = await import('../../src/app/budgets/page');
    return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store: c.storeId, period: c.periodKey, ...params }) })) as never);
  },
  typedOf: (_c, id) => {
    const rec = seen.records.find((r) => r && (r.hidden as Record<string, string> | undefined)?.categoryId === id);
    return { found: rec !== undefined, typed: rec?.typed as never };
  },
  stored: () => ['value="1000.00"'],
  typedNotDrawn: () => ['-5.55'],
  tooLong: { name: 'amount' },
  goodForm: (c) => {
    const fd = new FormData();
    fd.set('storeId', c.storeId);
    fd.set('periodKey', c.periodKey);
    fd.set('categoryId', c.catA);
    fd.set('amount', '1200.00');
    fd.set('reissueInterval', 'monthly');
    return fd;
  },
  expectOk: /^Cap saved/,
});
