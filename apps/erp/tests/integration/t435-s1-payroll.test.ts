import { afterAll, describe, expect, it, vi } from 'vitest';

import { M, expectAbsent, expectAuthRefusal, expectNotAvailable, expectPresent, expectRefusalCard, plain, render, sql, world } from './t435-fixture';

/**
 * T-435 S1 (TESTER) - payroll: /payroll, /payroll/thirteenth-month, /payroll/separations and their loaders.
 * Spec: docs/tasks/435-personal-data-access-gates.md, cases 1-11 (design 1-4, 6). Bible row 353.
 *
 * Contract pinned here (the builder matches it):
 *  - every loader takes the FULL Actor first: rosterFor(actor, storeId), runsFor(actor, storeId), cashAccountsFor(actor, storeId),
 *    premiumSettingsFor(actor, storeId) in payroll/lib.ts; slipsFor(actor, runId) authorizes on the RUN's own store;
 *    thirteenth-month/lib.ts runsFor(actor, storeId), payoutsFor(actor, runId); separations/lib.ts worklistFor(actor, storeId),
 *    separationsFor(actor, storeId). A refusal is authorize()'s AuthorizationError for `run_payroll`.
 *  - a requested ?store= the actor does not hold renders "This store is not available to you." and nothing else of that store.
 *
 * Mutants (spec): M1 delete the /payroll route entry; M2 listStores instead of scopedStores; M3 page trusts sp.store; M4 no loader
 * authorize; M5 no authorize in runsFor; M6 slipsFor authorizes on a caller-supplied store; M7/M8 drop the 13th-month / separations
 * loader gates; M9 held list cut to the first store; M10 includeRetired ignored; M11 an isAdmin short-circuit.
 *
 * Red today: pages trust ?store= and list every store (page-level leaks); loaders take an orgId, not an Actor (signature).
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

const payrollPage = () => import('../../src/app/payroll/page');
const thirteenthPage = () => import('../../src/app/payroll/thirteenth-month/page');
const separationsPage = () => import('../../src/app/payroll/separations/page');
const payrollLib = () => import('../../src/app/payroll/lib');
const thirteenthLib = () => import('../../src/app/payroll/thirteenth-month/lib');
const separationsLib = () => import('../../src/app/payroll/separations/lib');

type Loader = (...a: unknown[]) => Promise<unknown>;
const fn = async (load: () => Promise<Record<string, unknown>>, name: string): Promise<Loader> => {
  const f = (await load())[name];
  if (typeof f !== 'function') throw new Error(`${name} is not exported`);
  return f as Loader;
};

const ROUTES = [
  ['/payroll', payrollPage],
  ['/payroll/thirteenth-month', thirteenthPage],
  ['/payroll/separations', separationsPage],
] as const;

describe('T-435 S1 payroll - case 1: no run_payroll, no payroll screen', () => {
  for (const who of ['C', 'M1'] as const) {
    for (const [route, page] of ROUTES) {
      it(`${who} opens ${route}: the access-refused card, and none of the pay data (M1: delete the /payroll entry)`, async () => {
        const w = await world();
        const html = await render(page, w[who]);
        expectRefusalCard(html, `${who} ${route}`);
        expectAbsent(html, `${who} ${route}`, M.e1Name, M.e2Name, M.e3Name, M.e1Rate, M.e2Rate, M.s2Name);
      });
    }
  }
});

describe('T-435 S1 payroll - case 2: one store\'s payroll admin sees that store only', () => {
  it('P1 /payroll: the picker lists S1 only; E1 and 650.00 render; E2, 720.00 and S2 are nowhere (M2: listStores)', async () => {
    const w = await world();
    const html = await render(payrollPage, w.P1);
    expectPresent(html, 'P1 /payroll', M.s1Name, M.e1Name, M.e1Rate);
    expectAbsent(html, 'P1 /payroll', M.s2Name, M.e2Name, M.e2Rate, w.s2);
  });
});

describe('T-435 S1 payroll - case 3: a forged ?store= is one sentence', () => {
  it('P1 /payroll?store=<S2>: "This store is not available to you." and nothing of S2 (M3: page trusts sp.store)', async () => {
    const w = await world();
    const html = await render(payrollPage, w.P1, { search: { store: w.s2 } });
    expectNotAvailable(html, 'P1 /payroll?store=S2');
    expectAbsent(html, 'P1 /payroll?store=S2', M.s2Name, M.e2Name, M.e2Rate, M.e1Name);
  });
  it('and it does not quietly fall back to S1 (no request falls back to the first held store)', async () => {
    const w = await world();
    const html = await render(payrollPage, w.P1, { search: { store: w.s2 } });
    expectAbsent(html, 'P1 forged store', M.e1Name, M.e1Rate);
  });
});

describe('T-435 S1 payroll - cases 4-6: the loaders refuse on their own (M4, M5, M6)', () => {
  it('rosterFor(P1, S2) throws the run_payroll refusal; rosterFor(P1, S1) still returns E1 (positive control)', async () => {
    const w = await world();
    const rosterFor = await fn(payrollLib, 'rosterFor');
    await expectAuthRefusal(() => rosterFor(w.P1, w.s2), 'run_payroll', 'rosterFor(P1,S2)');
    const mine = (await rosterFor(w.P1, w.s1)) as { displayName: string }[];
    expect(mine.map((r) => r.displayName)).toContain(M.e1Name);
  });

  it('runsFor, cashAccountsFor, premiumSettingsFor (P1, S2) each throw (M5: remove the authorize in runsFor)', async () => {
    const w = await world();
    for (const name of ['runsFor', 'cashAccountsFor', 'premiumSettingsFor']) {
      const f = await fn(payrollLib, name);
      await expectAuthRefusal(() => f(w.P1, w.s2), 'run_payroll', `${name}(P1,S2)`);
    }
    const runsFor = await fn(payrollLib, 'runsFor');
    expect(((await runsFor(w.P1, w.s1)) as { id: string }[]).map((r) => r.id)).toContain(w.runS1);
  });

  it('slipsFor(P1, <S2 run id>) throws - authorized on the RUN\'s store, not on one the caller names (M6)', async () => {
    const w = await world();
    const slipsFor = await fn(payrollLib, 'slipsFor');
    await expectAuthRefusal(() => slipsFor(w.P1, w.runS2), 'run_payroll', 'slipsFor(P1, S2 run)');
    const own = (await slipsFor(w.P1, w.runS1)) as { personName: string }[];
    expect(own.map((s) => s.personName)).toContain(M.e1Name);
  });

  it('a loader called by a person with no run_payroll anywhere refuses too (C, M1)', async () => {
    const w = await world();
    const rosterFor = await fn(payrollLib, 'rosterFor');
    await expectAuthRefusal(() => rosterFor(w.C, w.s1), 'run_payroll', 'rosterFor(C,S1)');
    await expectAuthRefusal(() => rosterFor(w.M1, w.s1), 'run_payroll', 'rosterFor(M1,S1)');
  });
});

describe('T-435 S1 payroll - case 7: 13th-month', () => {
  it('P1 /payroll/thirteenth-month?store=<S2>: not available, nothing of S2 (M7)', async () => {
    const w = await world();
    const html = await render(thirteenthPage, w.P1, { search: { store: w.s2 } });
    expectNotAvailable(html, 'P1 13th-month S2');
    expectAbsent(html, 'P1 13th-month S2', M.s2Name, M.e2Name);
  });
  it('P1 /payroll/thirteenth-month: the picker lists S1 only', async () => {
    const w = await world();
    const html = await render(thirteenthPage, w.P1);
    expectPresent(html, 'P1 13th-month', M.s1Name);
    expectAbsent(html, 'P1 13th-month', M.s2Name, M.e2Name);
  });
  it('runsFor / payoutsFor (P1, S2 run) throw (M7: drop that loader gate)', async () => {
    const w = await world();
    const runsFor = await fn(thirteenthLib, 'runsFor');
    const payoutsFor = await fn(thirteenthLib, 'payoutsFor');
    await expectAuthRefusal(() => runsFor(w.P1, w.s2), 'run_payroll', '13th runsFor(P1,S2)');
    await expectAuthRefusal(() => payoutsFor(w.P1, w.thirteenthS2), 'run_payroll', '13th payoutsFor(P1,S2 run)');
  });
});

describe('T-435 S1 payroll - case 8: separations', () => {
  it('P1 /payroll/separations?store=<S2>: not available (M8)', async () => {
    const w = await world();
    const html = await render(separationsPage, w.P1, { search: { store: w.s2 } });
    expectNotAvailable(html, 'P1 separations S2');
    expectAbsent(html, 'P1 separations S2', M.s2Name, M.e2Name);
  });
  it('worklistFor / separationsFor (P1, S2) throw (M8: drop that loader gate)', async () => {
    const w = await world();
    const worklistFor = await fn(separationsLib, 'worklistFor');
    const separationsFor = await fn(separationsLib, 'separationsFor');
    await expectAuthRefusal(() => worklistFor(w.P1, w.s2), 'run_payroll', 'worklistFor(P1,S2)');
    await expectAuthRefusal(() => separationsFor(w.P1, w.s2), 'run_payroll', 'separationsFor(P1,S2)');
  });
});

describe('T-435 S1 payroll - case 9: an admin of every store sees every store (M9)', () => {
  it('A /payroll: S1 and S2 are both offered', async () => {
    const w = await world();
    const html = await render(payrollPage, w.A);
    expectPresent(html, 'A /payroll', M.s1Name, M.s2Name);
  });
  it('A /payroll?store=<S2>: E2 and 720.00 render under S2', async () => {
    const w = await world();
    const html = await render(payrollPage, w.A, { search: { store: w.s2 } });
    expectPresent(html, 'A /payroll?store=S2', M.e2Name, M.e2Rate);
    expect(plain(html)).not.toContain(M.notAvailable);
  });
});

describe('T-435 S1 payroll - case 10: a retired store is reachable only where the actor has a scope row (M10)', () => {
  it('A (scope row at retired S3) opens separations for S3 and sees E3 on the worklist', async () => {
    const w = await world();
    const html = await render(separationsPage, w.A, { search: { store: w.s3 } });
    expectPresent(html, 'A separations S3', M.e3Name);
    expect(plain(html)).not.toContain(M.notAvailable);
  });
  it('P1 (no S3 row) is not offered S3, and ?store=<S3> is not available', async () => {
    const w = await world();
    const offered = await render(separationsPage, w.P1);
    expectAbsent(offered, 'P1 separations picker', M.s3Name, M.e3Name);
    const forged = await render(separationsPage, w.P1, { search: { store: w.s3 } });
    expectNotAvailable(forged, 'P1 separations S3');
    expectAbsent(forged, 'P1 separations S3', M.s3Name, M.e3Name);
  });
});

describe('T-435 S1 payroll - case 11: there is no admin bypass, by design (M11)', () => {
  it('P1 is an admin (it holds run_payroll at S1) yet sees nothing of S2, in the loaders and on the page', async () => {
    const w = await world();
    const [role] = await sql<{ role: string }[]>`select role from person_roles where person_id = ${w.P1.personId}`;
    expect(role!.role).toBe('admin');
    const rosterFor = await fn(payrollLib, 'rosterFor');
    expect(((await rosterFor(w.P1, w.s1)) as unknown[]).length).toBeGreaterThan(0);
    await expectAuthRefusal(() => rosterFor(w.P1, w.s2), 'run_payroll', 'admin without an S2 row');
    expectAbsent(await render(payrollPage, w.P1, { search: { store: w.s2 } }), 'P1 S2', M.e2Name, M.e2Rate);
  });
});

describe('T-435 S1 payroll - an admin with ZERO held stores gets the one sentence, never a throw or data', () => {
  for (const [route, page] of ROUTES) {
    it(`G opens ${route}: "This store is not available to you." and no pay data`, async () => {
      const w = await world();
      const html = await render(page, w.G);
      expectNotAvailable(html, `G ${route}`);
      expectAbsent(html, `G ${route}`, M.e1Name, M.e2Name, M.e3Name, M.e1Rate, M.e2Rate, M.s1Name, M.s2Name);
    });
  }
});
