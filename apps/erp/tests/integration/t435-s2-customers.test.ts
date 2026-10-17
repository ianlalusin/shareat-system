import { afterAll, describe, expect, it, vi } from 'vitest';

import { M, expectAbsent, expectAuthRefusal, expectNotAvailable, expectPresent, expectRefusalCard, pageError, plain, render, sql, world } from './t435-fixture';

/**
 * T-435 S2 (TESTER) - customers: /customers, /customers/[customerId], /customers/price-lists and their loaders.
 * Spec: docs/tasks/435-personal-data-access-gates.md, cases 12-22 (design 5-7; Ian Q1: a manager does NOT see a business customer who
 * only buys at another branch; Ian Q3: price lists stay open). Bible row 353.
 *
 * Contract pinned here:
 *  - /customers and everything under it needs `record_ar_collection` (any store) EXCEPT /customers/price-lists, which is open.
 *  - customers/lib.ts loaders take the full Actor first and authorize record_ar_collection at the stores they read:
 *    listRegister(actor); getCustomer(actor, id) etc. A refusal is AuthorizationError('record_ar_collection').
 *  - a viewer sees a customer if it has any AR row at a held store, or it has none anywhere (Z). Balances, "owes", store credit,
 *    charges, collections, receipt links and the store dropdown cover HELD stores only.
 *  - the over-limit FLAG is judged org-wide but only the words "over limit" are shown - never the org-wide figure or another
 *    store's amount.
 *  - a by-id page for an out-of-scope customer is the same notFound() as a random uuid (DEF-497).
 *
 * Mutants (spec): M12 delete the /customers entry; M13 remove the `null` price-lists entry; M14 no loader authorize; M15 drop the
 * store filter; M16 unscoped balancesByCustomer; M17 getCustomer skips the scope rule; M18 dropdown from unfiltered
 * storesWithOpenItems; M19 listCharges without storeIds; M20a flag from S1 only; M20b render the org-wide figure; M21 filter by the
 * viewer's FIRST store only; M22 over-filtering.
 *
 * Fixture: X charged only at S2; Y owes 1,000.00 at S1 and 9,500.00 at S2 (limit 10,000.00 - over it org-wide at 10,500.00);
 * Z has no AR rows. M1 = manager at S1, M2 = manager at S2, C = cashier, A = admin of every store.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const registerPage = () => import('../../src/app/customers/page');
const detailPage = () => import('../../src/app/customers/[customerId]/page');
const priceListsPage = () => import('../../src/app/customers/price-lists/page');
const customersLib = () => import('../../src/app/customers/lib');

type Loader = (...a: unknown[]) => Promise<unknown>;
const fn = async (name: string): Promise<Loader> => {
  const f = ((await customersLib()) as Record<string, unknown>)[name];
  if (typeof f !== 'function') throw new Error(`${name} is not exported`);
  return f as Loader;
};

const OVER_LIMIT = /over limit/i;

describe('T-435 S2 customers - case 12: a cashier sees no customer data', () => {
  it('C /customers: the access-refused card; no name, phone, balance (M12: delete the /customers entry)', async () => {
    const w = await world();
    const html = await render(registerPage, w.C);
    expectRefusalCard(html, 'C /customers');
    expectAbsent(html, 'C /customers', M.xName, M.yName, M.zName, M.xPhone, M.yPhone, M.owesS1, M.owesAll, M.owesS2);
  });
  it('C /customers/<Y>: the access-refused card; no name, phone, balance', async () => {
    const w = await world();
    const html = await render(detailPage, w.C, { params: { customerId: w.y } });
    expectRefusalCard(html, 'C /customers/Y');
    expectAbsent(html, 'C /customers/Y', M.yName, M.yPhone, M.owesS1, M.owesAll, M.owesS2, M.yS1Ref, M.yS2Ref, M.limit);
  });
});

describe('T-435 S2 customers - case 13: price lists stay open (Ian Q3)', () => {
  it('C /customers/price-lists renders (M13: remove the null entry and the /customers prefix closes it)', async () => {
    const w = await world();
    const html = await render(priceListsPage, w.C);
    expect(plain(html)).toContain('Price lists');
    expect(plain(html)).not.toContain(M.refusedCard);
  });
});

describe('T-435 S2 customers - case 14: the loader refuses on its own (M14)', () => {
  it('listRegister(C) throws the record_ar_collection refusal', async () => {
    const w = await world();
    const listRegister = await fn('listRegister');
    await expectAuthRefusal(() => listRegister(w.C), 'record_ar_collection', 'listRegister(C)');
  });
  it('listRegister(M1) returns Y and Z, not X, and Y at 1,000.00 (positive control, loader level)', async () => {
    const w = await world();
    const listRegister = await fn('listRegister');
    const rows = (await listRegister(w.M1)) as { id: string; balance: string }[];
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(w.y);
    expect(ids).toContain(w.z);
    expect(ids).not.toContain(w.x);
    expect(rows.find((r) => r.id === w.y)!.balance).toBe('1000.00');
  });
});

describe('T-435 S2 customers - cases 15, 16: the register is scoped to the viewer\'s stores', () => {
  it('M1 /customers shows Y and Z, not X: no X name or phone (M15: drop the store filter)', async () => {
    const w = await world();
    const html = await render(registerPage, w.M1);
    expectPresent(html, 'M1 /customers', M.yName, M.zName);
    expectAbsent(html, 'M1 /customers', M.xName, M.xPhone);
  });
  it('M1 /customers shows Y owing 1,000.00, never 10,500.00 or 9,500.00 (M16: unscoped balancesByCustomer)', async () => {
    const w = await world();
    const html = await render(registerPage, w.M1);
    expectPresent(html, 'M1 /customers', M.owesS1);
    expectAbsent(html, 'M1 /customers', M.owesAll, M.owesS2, M.s2Name);
  });
});

describe('T-435 S2 customers - case 17: an out-of-scope customer does not exist for the viewer', () => {
  it('M1 /customers/<X> is the same not-found as a random uuid (M17: getCustomer skips the scope rule)', async () => {
    const w = await world();
    const forged = await pageError(() => render(detailPage, w.M1, { params: { customerId: '019a0000-0000-7000-8000-000000000001' } }));
    const real = await pageError(() => render(detailPage, w.M1, { params: { customerId: w.x } }));
    expect(forged, 'a random uuid is a not-found').toBe('NEXT_NOT_FOUND');
    expect(real, 'X (buys only at S2) must be the very same not-found for M1').toBe(forged);
  });
});

describe('T-435 S2 customers - cases 18-20: the detail page shows held stores only', () => {
  it('M1 /customers/<Y>?store=<S2>: "This store is not available to you." and nothing of S2 (M18)', async () => {
    const w = await world();
    const html = await render(detailPage, w.M1, { params: { customerId: w.y }, search: { store: w.s2 } });
    expectNotAvailable(html, 'M1 Y ?store=S2');
    expectAbsent(html, 'M1 Y ?store=S2', M.s2Name, M.yS2Ref, M.yS2ColRef, M.owesS2, M.owesAll, M.s2Charge, w.receiptFileId);
  });

  it('M1 /customers/<Y>: no S2 store name or id in the dropdown/links, no S2 charge, collection, receipt link or 9,500.00 (M18)', async () => {
    const w = await world();
    const html = await render(detailPage, w.M1, { params: { customerId: w.y } });
    expectPresent(html, 'M1 Y', M.yName);
    expectAbsent(html, 'M1 Y', M.s2Name, w.s2, M.yS2Ref, M.yS2ColRef, M.s2Charge, M.owesS2, M.owesAll, w.receiptFileId);
  });

  it('M1 /customers/<Y>: charges, collections and "owes" are S1 only (M19: listCharges without storeIds)', async () => {
    const w = await world();
    const html = await render(detailPage, w.M1, { params: { customerId: w.y } });
    expectPresent(html, 'M1 Y', M.yS1Ref, M.owesS1);
    expectAbsent(html, 'M1 Y', M.yS2Ref, M.xRef);
  });

  it('M1 /customers/<Y> shows "over limit" (10,500.00 org-wide > 10,000.00) but neither 9,500.00 nor 10,500.00 (M20a flag from S1 only; M20b the org-wide figure)', async () => {
    const w = await world();
    const html = await render(detailPage, w.M1, { params: { customerId: w.y } });
    expect(plain(html), 'the over-limit flag is judged org-wide').toMatch(OVER_LIMIT);
    expectAbsent(html, 'M1 Y', M.owesS2, M.owesAll);
  });
});

describe('T-435 S2 customers - case 21: a manager at S2 sees S2 (M21: filter by the first store only)', () => {
  it('M2 /customers shows X, Y and Z', async () => {
    const w = await world();
    const html = await render(registerPage, w.M2);
    expectPresent(html, 'M2 /customers', M.xName, M.yName, M.zName, M.owesS2);
    expectAbsent(html, 'M2 /customers', M.owesAll, M.s1Name);
  });
  it('M2 /customers/<Y> shows Y at 9,500.00 with the over-limit flag, and nothing of S1', async () => {
    const w = await world();
    const html = await render(detailPage, w.M2, { params: { customerId: w.y } });
    expectPresent(html, 'M2 Y', M.owesS2, M.yS2Ref);
    expect(plain(html)).toMatch(OVER_LIMIT);
    expectAbsent(html, 'M2 Y', M.owesAll, M.yS1Ref, M.s1Name, w.s1);
  });
  it('M2 /customers/<X> renders (X buys at S2)', async () => {
    const w = await world();
    const html = await render(detailPage, w.M2, { params: { customerId: w.x } });
    expectPresent(html, 'M2 X', M.xName, M.xRef);
  });
});

describe('T-435 S2 customers - case 22: an admin of every store sees everything (M22: over-filtering)', () => {
  it('A /customers sees X, Y (10,500.00) and Z', async () => {
    const w = await world();
    const html = await render(registerPage, w.A);
    expectPresent(html, 'A /customers', M.xName, M.yName, M.zName, M.owesAll);
  });
  it('A /customers/<Y> sees both stores\' receivables and the over-limit flag', async () => {
    const w = await world();
    const html = await render(detailPage, w.A, { params: { customerId: w.y } });
    expectPresent(html, 'A Y', M.yS1Ref, M.yS2Ref, M.owesAll);
    expect(plain(html)).toMatch(OVER_LIMIT);
  });
  it('A /customers/<Z> (no AR rows anywhere) renders', async () => {
    const w = await world();
    const html = await render(detailPage, w.A, { params: { customerId: w.z } });
    expectPresent(html, 'A Z', M.zName);
  });
});

describe('T-435 S2 customers - a user with record_ar_collection but ZERO held stores gets the one sentence, never a throw or data', () => {
  it('G /customers', async () => {
    const w = await world();
    const html = await render(registerPage, w.G);
    expectNotAvailable(html, 'G /customers');
    expectAbsent(html, 'G /customers', M.xName, M.yName, M.zName, M.owesS1, M.owesS2, M.owesAll);
  });
  it('G /customers/<Y>', async () => {
    const w = await world();
    const html = await render(detailPage, w.G, { params: { customerId: w.y } });
    expectNotAvailable(html, 'G /customers/Y');
    expectAbsent(html, 'G /customers/Y', M.yName, M.yPhone, M.owesS1, M.owesS2, M.owesAll, M.yS1Ref, M.yS2Ref);
  });
});
