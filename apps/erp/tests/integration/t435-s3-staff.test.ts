import { afterAll, describe, expect, it, vi } from 'vitest';

import { M, expectAbsent, expectNotAvailable, expectPresent, expectRefusalCard, pageError, plain, render, sql, world } from './t435-fixture';

/**
 * T-435 S3 (TESTER) - staff: /staff, /staff/[employmentId], /staff/[employmentId]/credentials, /staff/hire and the staff loaders.
 * Spec: docs/tasks/435-personal-data-access-gates.md, cases 23-29 and 31 (design 5, 6, 8; Ian Q2: holding only manage_attendance at a
 * store is enough to see that store's roster). Case 30 (searchPersons) is in packages/domain/tests/integration/t435-search-persons.test.ts.
 *
 * Contract pinned here:
 *  - /staff (and /staff/[employmentId], /staff/[employmentId]/credentials) needs enrol_staff OR manage_attendance at a store;
 *    /staff/hire needs enrol_staff. A refusal is the access-refused card.
 *  - staff/lib.ts loaders take the full Actor first: rosterForStore(actor, storeId), employmentDetail(actor, employmentId),
 *    livePinFor(actor, personId), otherOpenBranchesFor(actor, personId, excludeStoreId). A store the actor does not hold is an
 *    AuthorizationError for enrol_staff/manage_attendance; a by-id loader authorizes on the ROW's store.
 *  - an employment the viewer cannot reach is the same notFound() as a forged id (DEF-497).
 *  - otherOpenBranchesFor names only branches the viewer holds; the rest render as "and N other branch(es)" so the T-302 PIN
 *    warning still fires.
 *
 * Mutants (spec): M23 delete the /staff entry; M24 /staff maps to enrol_staff alone; M25 listStores instead of scopedStores;
 * M26 page trusts sp.store; M27 no loader authorize; M28 employmentDetail skips the store check; M29 names unfiltered;
 * M31 over-filtering.
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

const staffPage = () => import('../../src/app/staff/page');
const detailPage = () => import('../../src/app/staff/[employmentId]/page');
const credentialsPage = () => import('../../src/app/staff/[employmentId]/credentials/page');
const hirePage = () => import('../../src/app/staff/hire/page');
const staffLib = () => import('../../src/app/staff/lib');

type Loader = (...a: unknown[]) => Promise<unknown>;
const fn = async (name: string): Promise<Loader> => {
  const f = ((await staffLib()) as Record<string, unknown>)[name];
  if (typeof f !== 'function') throw new Error(`${name} is not exported`);
  return f as Loader;
};

const FORGED_ID = '019a0000-0000-7000-8000-000000000002';

describe('T-435 S3 staff - case 23: a cashier sees no colleague', () => {
  it('C opens /staff, /staff/<E1>, /staff/<E1>/credentials, /staff/hire: the access-refused card, no colleague names (M23: delete the /staff entry)', async () => {
    const w = await world();
    const pages: [string, () => Promise<string>][] = [
      ['/staff', () => render(staffPage, w.C)],
      ['/staff/<E1>', () => render(detailPage, w.C, { params: { employmentId: w.e1Emp } })],
      ['/staff/<E1>/credentials', () => render(credentialsPage, w.C, { params: { employmentId: w.e1Emp } })],
      ['/staff/hire', () => render(hirePage, w.C, { search: { q: 'Esperanza' } })],
    ];
    for (const [route, run] of pages) {
      const html = await run();
      expectRefusalCard(html, `C ${route}`);
      if (route !== '/staff/hire') expect(plain(html), `C ${route}: the card names both ways in`).toContain('enrol_staff or manage_attendance');
      expectAbsent(html, `C ${route}`, M.e1Name, M.e2Name, M.f1Name, M.qName, M.uName, M.e2Phone);
    }
  });
});

describe('T-435 S3 staff - case 24: manage_attendance alone is enough for the roster (Ian Q2), not for hiring (M24)', () => {
  it('T1 /staff at S1: the roster renders E1', async () => {
    const w = await world();
    const html = await render(staffPage, w.T1);
    expect(plain(html)).not.toContain(M.refusedCard);
    expectPresent(html, 'T1 /staff', M.e1Name, M.s1Name);
    expectAbsent(html, 'T1 /staff', M.s2Name, M.e2Name);
  });
  it('T1 /staff/hire: the access-refused card (hire needs enrol_staff)', async () => {
    const w = await world();
    const html = await render(hirePage, w.T1);
    expectRefusalCard(html, 'T1 /staff/hire');
  });
});

describe('T-435 S3 staff - case 25: a manager sees the roster of their own store only (M25)', () => {
  it('M1 /staff: the picker lists S1 only; E1 renders, E2 does not', async () => {
    const w = await world();
    const html = await render(staffPage, w.M1);
    expectPresent(html, 'M1 /staff', M.s1Name, M.e1Name);
    expectAbsent(html, 'M1 /staff', M.s2Name, M.s3Name, M.e2Name, M.qName, w.s2);
  });
});

describe('T-435 S3 staff - case 26: a forged ?store= is one sentence (M26)', () => {
  it('M1 /staff?store=<S2> is "This store is not available to you." and shows no roster', async () => {
    const w = await world();
    const html = await render(staffPage, w.M1, { search: { store: w.s2 } });
    expectNotAvailable(html, 'M1 /staff?store=S2');
    expectAbsent(html, 'M1 /staff?store=S2', M.e2Name, M.qName, M.s2Name, M.e1Name);
  });
  it('M1 /staff/hire?store=<S2> is the same sentence', async () => {
    const w = await world();
    const html = await render(hirePage, w.M1, { search: { store: w.s2 } });
    expectNotAvailable(html, 'M1 /staff/hire?store=S2');
    expectAbsent(html, 'M1 /staff/hire?store=S2', M.s2Name);
  });
  it('M1 /staff/hire at S1 still works (positive control)', async () => {
    const w = await world();
    const html = await render(hirePage, w.M1);
    expect(plain(html)).not.toContain(M.refusedCard);
    expectPresent(html, 'M1 /staff/hire', M.s1Name);
    expectAbsent(html, 'M1 /staff/hire', M.s2Name);
  });
});

describe('T-435 S3 staff - case 27: the loader refuses on its own (M27)', () => {
  it('rosterForStore(M1, S2) throws; rosterForStore(M1, S1) returns E1 (positive control)', async () => {
    const w = await world();
    const rosterForStore = await fn('rosterForStore');
    let e: unknown = null;
    try {
      await rosterForStore(w.M1, w.s2);
    } catch (err) {
      e = err;
    }
    expect(e, 'rosterForStore(M1,S2) returned a roster').not.toBeNull();
    expect((e as { name?: string }).name, String((e as Error).message)).toBe('AuthorizationError');
    const mine = (await rosterForStore(w.M1, w.s1)) as { displayName: string }[];
    expect(mine.map((r) => r.displayName)).toContain(M.e1Name);
  });
  it('a cashier (no enrol_staff, no manage_attendance anywhere) is refused for her own store too', async () => {
    const w = await world();
    const rosterForStore = await fn('rosterForStore');
    let e: unknown = null;
    try {
      await rosterForStore(w.C, w.s1);
    } catch (err) {
      e = err;
    }
    expect((e as { name?: string } | null)?.name).toBe('AuthorizationError');
  });
  it('T1 (manage_attendance only) reads the S1 roster at the loader too (Ian Q2)', async () => {
    const w = await world();
    const rosterForStore = await fn('rosterForStore');
    const rows = (await rosterForStore(w.T1, w.s1)) as { displayName: string }[];
    expect(rows.map((r) => r.displayName)).toContain(M.e1Name);
  });
});

describe('T-435 S3 staff - case 28: an employment at another store does not exist for the viewer (M28)', () => {
  it('M1 /staff/<E2> and /staff/<E2>/credentials are the same not-found as a forged id', async () => {
    const w = await world();
    const forgedDetail = await pageError(() => render(detailPage, w.M1, { params: { employmentId: FORGED_ID } }));
    const forgedCreds = await pageError(() => render(credentialsPage, w.M1, { params: { employmentId: FORGED_ID } }));
    expect(forgedDetail).toBe('NEXT_NOT_FOUND');
    expect(forgedCreds).toBe('NEXT_NOT_FOUND');
    expect(await pageError(() => render(detailPage, w.M1, { params: { employmentId: w.e2Emp } })), 'detail for E2 (S2)').toBe(forgedDetail);
    expect(await pageError(() => render(credentialsPage, w.M1, { params: { employmentId: w.e2Emp } })), 'credentials for E2 (S2)').toBe(forgedCreds);
  });
  it('M1 /staff/<E1> renders E1 (positive control)', async () => {
    const w = await world();
    const html = await render(detailPage, w.M1, { params: { employmentId: w.e1Emp } });
    expectPresent(html, 'M1 /staff/E1', M.e1Name, M.s1Name);
  });
});

describe('T-435 S3 staff - cases 29, 31: the PIN warning names only the branches the viewer holds (M29, M31)', () => {
  it('M1 on F1\'s S1 employment: "and 1 other branch", never S2\'s name', async () => {
    const w = await world();
    const html = await render(detailPage, w.M1, { params: { employmentId: w.f1EmpS1 } });
    expectPresent(html, 'M1 F1', M.f1Name);
    expect(plain(html), 'the warning still fires, anonymously').toMatch(/and 1 other branch/i);
    expectAbsent(html, 'M1 F1', M.s2Name, w.s2);
  });
  it('A on the same employment sees S2 named in the warning (M31: over-filtering)', async () => {
    const w = await world();
    const html = await render(detailPage, w.A, { params: { employmentId: w.f1EmpS1 } });
    expectPresent(html, 'A F1', M.f1Name, M.s2Name);
    expect(plain(html)).not.toMatch(/and \d+ other branch/i);
  });
  it('A sees both rosters (S1 and S2)', async () => {
    const w = await world();
    const one = await render(staffPage, w.A, { search: { store: w.s1 } });
    expectPresent(one, 'A /staff S1', M.e1Name);
    const two = await render(staffPage, w.A, { search: { store: w.s2 } });
    expectPresent(two, 'A /staff S2', M.e2Name);
    expect(plain(two)).not.toContain(M.notAvailable);
  });
  it('otherOpenBranchesFor(M1, F1) hides S2\'s name; otherOpenBranchesFor(A, F1) names it', async () => {
    const w = await world();
    const [f1] = await sql<{ person_id: string }[]>`select person_id from employments where id = ${w.f1EmpS1}`;
    const other = await fn('otherOpenBranchesFor');
    const forA = JSON.stringify(await other(w.A, f1!.person_id, w.s1));
    expect(forA, 'A holds S2').toContain(M.s2Name);
    const forM1 = JSON.stringify(await other(w.M1, f1!.person_id, w.s1));
    expect(forM1, 'M1 does not hold S2: no name, no id').not.toContain(M.s2Name);
    expect(forM1).not.toContain(w.s2);
  });
});

describe('T-435 S3 staff - a by-id loader refuses on the row\'s store', () => {
  it('employmentDetail(M1, E2) does not return E2 (null or a refusal, never the record)', async () => {
    const w = await world();
    const employmentDetail = await fn('employmentDetail');
    let value: unknown = 'unset';
    try {
      value = await employmentDetail(w.M1, w.e2Emp);
    } catch (err) {
      expect((err as { name?: string }).name).toBe('AuthorizationError');
      return;
    }
    expect(value, 'employmentDetail leaked another store\'s employment').toBeNull();
  });
  it('a refused person-name read does not happen before the gate: the credentials page for E2 by M1 holds no name (see case 28)', async () => {
    const w = await world();
    const e = await pageError(() => render(credentialsPage, w.M1, { params: { employmentId: w.e2Emp } }));
    expect(e).toBe('NEXT_NOT_FOUND');
  });
});

describe('T-435 S3 staff - a user with enrol_staff but ZERO held stores gets the one sentence, never a throw or data', () => {
  it('G /staff and G /staff/hire', async () => {
    const w = await world();
    for (const [route, page] of [['/staff', staffPage], ['/staff/hire', hirePage]] as const) {
      const html = await render(page, w.G);
      expectNotAvailable(html, `G ${route}`);
      expectAbsent(html, `G ${route}`, M.e1Name, M.e2Name, M.f1Name, M.qName, M.s1Name, M.s2Name);
    }
  });
});

describe('T-435 S3 staff - credentials need manage_attendance at the store, not only enrol_staff', () => {
  it('H1 (enrol_staff only) opens /staff/<E1>/credentials: a plain refusal card, no throw, no credential data', async () => {
    const w = await world();
    const html = await render(credentialsPage, w.H1, { params: { employmentId: w.e1Emp } });
    expect(plain(html), 'a refusal card, in words').toMatch(/do not have access|not allowed|can.?t|cannot|manage_attendance/i);
    expectAbsent(html, 'H1 credentials', 'Card …', 'Fingerprint', 'Enrol a card');
  });
});
