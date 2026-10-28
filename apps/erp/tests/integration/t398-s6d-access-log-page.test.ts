import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { franchiseWorld, addDays, D0, insertLogRow, totalLogCount, sql as ownerSql, type FranchiseWorld } from '../../../../packages/db/tests/integration/_fixtures/t398-s6-franchise';
import { M, pageError, plain, render } from './t435-fixture';

/**
 * T-398 S6d (TESTER) - /franchise/access-log: Padre Garcia's owner reads who looked. docs/tasks/398-s6/{S6-REFRESH s5-s6, TESTS S6d U2}.md.
 *
 *   L1  PG's manager and admin see, newest first, Ian's sales look, stock look, PIN sign-in and PIN approval - each with who (the name written at the time) and a plain label
 *       ("Sales looked at", "Stock looked at", "Signed in", "Approved with PIN"), and the reason typed.
 *   L2  PG's staff, and L's staff, are refused by the page gate (the card names view_franchise_access_log); the capability is role-only.
 *   L3  only the viewer's OWN organisation's rows: a log row between two OTHER organisations (X -> Y) is nowhere on PG's page; L's admin (the franchisor) and X's reader
 *       see none of PG's rows on this screen (the franchisor gets no screen for them in S6).
 *   L4  the page is read-only and reading it adds no log row; the optional ?what= filter narrows to one kind.
 * Mutants: page mapped to view_franchise_sales -> L2; repo read without org_id = actor org -> L3; log rows written by the page -> L4; labels raw enum text -> L1.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await ownerSql.end({ timeout: 5 });
});

const logPage = () => import('../../src/app/franchise/access-log/page');
const actorOf = (orgId: string, p: { id: string }) => ({ orgId, personId: p.id }) as never;

const N = { sales: 'Reader-Sales-Alpha', stock: 'Reader-Stock-Bravo', signin: 'Signer-Charlie', approver: 'Approver-Delta', foreign: 'Foreign-Reader-Zulu' };
const REASON = 'Reason-Marker-77';
let W: FranchiseWorld;

beforeAll(async () => {
  W = await franchiseWorld();
  // owner-side inserts so the page is judged on its own, independent of the definers (those are S6b/S6c's legs)
  await insertLogRow(ownerSql, { franchisee: W.pg, franchisor: W.l, readerPersonId: W.ianL.id, what: 'sales_daily', over: { person_name: N.sales, range_from: D0, range_to: addDays(D0, 6), rows_returned: 5, reason: REASON } });
  await insertLogRow(ownerSql, { franchisee: W.pg, franchisor: W.l, readerPersonId: W.ianL.id, what: 'stock_levels', over: { person_name: N.stock, range_from: null, range_to: null, store_id: W.pg.storeId, rows_returned: 7 } });
  await insertLogRow(ownerSql, {
    franchisee: W.pg, franchisor: W.l, what: 'break_glass_sign_in',
    over: { reader_person_id: null, franchisee_person_id: W.ianPG.id, person_name: N.signin, range_from: null, range_to: null, rows_returned: null, session_id: randomUUID(), credential_kind: 'pin', store_id: W.pg.storeId },
  });
  await insertLogRow(ownerSql, {
    franchisee: W.pg, franchisor: W.l, what: 'break_glass_approval',
    over: { reader_person_id: null, franchisee_person_id: W.ianPG.id, person_name: N.approver, range_from: null, range_to: null, rows_returned: null, capability: 'void_expense', store_id: W.pg.storeId },
  });
  await insertLogRow(ownerSql, { franchisee: W.y, franchisor: W.x, readerPersonId: W.readerX.id, what: 'sales_daily', over: { person_name: N.foreign, rows_returned: 1 } });
});

describe('L1 PG\'s manager and admin read every look', () => {
  it.each([
    ['mgrPG', () => actorOf(W.pg.orgId, W.mgrPG)],
    ['adminPG', () => actorOf(W.pg.orgId, W.adminPG)],
  ])('%s: all four kinds, with who, plain labels and the reason', async (_who, mk) => {
    const html = await render(logPage, mk());
    const t = plain(html);
    for (const n of [N.sales, N.stock, N.signin, N.approver]) expect(t, `who: ${n}`).toContain(n);
    expect(t).toMatch(/sales looked at/i);
    expect(t).toMatch(/stock looked at/i);
    expect(t).toMatch(/signed in/i);
    expect(t).toMatch(/approved with pin/i);
    expect(t, 'the reason typed on the look').toContain(REASON);
    for (const raw of ['sales_daily', 'stock_levels', 'break_glass_sign_in', 'break_glass_approval']) expect(t, `raw enum "${raw}" shown to a person`).not.toContain(raw);
  });

  it('newest first: the approval (inserted last among PG\'s rows) is listed before the sales look (inserted first)', async () => {
    const t = plain(await render(logPage, actorOf(W.pg.orgId, W.mgrPG)));
    expect(t.indexOf(N.approver), 'approval listed').toBeGreaterThan(-1);
    expect(t.indexOf(N.approver)).toBeLessThan(t.indexOf(N.sales));
  });
});

describe('L2 the gate', () => {
  it.each([
    ['staffPG', () => actorOf(W.pg.orgId, W.staffPG)],
    ['staffL', () => actorOf(W.l.orgId, W.staffL)],
  ])('%s gets the access-refused card naming view_franchise_access_log and no rows', async (_who, mk) => {
    const html = await render(logPage, mk());
    const t = plain(html);
    expect(t).toContain(M.refusedCard);
    expect(t).toContain('view_franchise_access_log');
    for (const n of [N.sales, N.stock, N.signin, N.approver]) expect(t).not.toContain(n);
  });
});

describe('L3 only my own organisation\'s rows', () => {
  it('a log row between two other organisations (X -> Y) is nowhere on PG\'s page', async () => {
    const t = plain(await render(logPage, actorOf(W.pg.orgId, W.mgrPG)));
    expect(t).not.toContain(N.foreign);
  });
  it.each([
    ['adminL (the franchisor)', () => actorOf(W.l.orgId, W.adminL)],
    ['ianL (the franchisor)', () => actorOf(W.l.orgId, W.ianL)],
    ['readerX', () => actorOf(W.x.orgId, W.readerX)],
  ])('%s: none of PG\'s rows on this screen', async (_who, mk) => {
    const html = await render(logPage, mk());
    const t = plain(html);
    for (const n of [N.sales, N.stock, N.signin, N.approver, REASON]) expect(t).not.toContain(n);
  });
});

describe('L4 read-only, adds no row, filters by kind', () => {
  it('three loads write nothing; the page has no form that posts anything', async () => {
    const total0 = await totalLogCount();
    const html = await render(logPage, actorOf(W.pg.orgId, W.mgrPG));
    await render(logPage, actorOf(W.pg.orgId, W.mgrPG));
    await render(logPage, actorOf(W.pg.orgId, W.adminPG));
    expect(await totalLogCount()).toBe(total0);
    expect(html, 'no POST form on the owner\'s log').not.toMatch(/<form[^>]*method="post"/i);
  });

  it('?what=break_glass_sign_in shows only the sign-in (assumed filter name; matches listFranchiseAccessLog\'s `what`)', async () => {
    const t = plain(await render(logPage, actorOf(W.pg.orgId, W.mgrPG), { search: { what: 'break_glass_sign_in' } }));
    expect(t).toContain(N.signin);
    for (const n of [N.sales, N.stock, N.approver]) expect(t, `${n} must be filtered out`).not.toContain(n);
  });

  it('an unknown ?what= is not a database error or a 500', async () => {
    const e = await pageError(() => render(logPage, actorOf(W.pg.orgId, W.mgrPG), { search: { what: "x'; drop table franchise_access_log;--" } }));
    expect(['', 'NEXT_NOT_FOUND'], `got ${e}`).toContain(e);
    const rows = await ownerSql<{ n: number }[]>`select count(*)::int n from franchise_access_log`; // T-398 S6d
    expect(rows[0]!.n).toBeGreaterThan(0);
  });
});
