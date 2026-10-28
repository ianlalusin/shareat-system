import { afterAll, describe, expect, it, vi } from 'vitest';

import { franchiseWorld, D0, SENTINEL_BANK, SENTINEL_COST, SENTINEL_EXPENSE, totalLogCount, sql as ownerSql, type FranchiseWorld } from '../../../../packages/db/tests/integration/_fixtures/t398-s6-franchise';
import { M, pageError, plain, render } from './t435-fixture';

/**
 * T-398 S6d (TESTER) - the two franchisor pages as pages (GET). docs/tasks/398-s6/{S6-REFRESH s6, TESTS S6d U2/U3}.md.
 *
 *   P1  /franchise/sales and /franchise/stock: refused (the access-refused card, naming the capability) for L's admin, manager and staff and for PG's own people.
 *   P2  Ian sees the picker with the franchisee's NAME, the "Padre Garcia will see that you looked" notice, a reason box; no figure and no sentinel on the bare page.
 *   P3  rendering writes ZERO log rows - not once, not three times, not with a range already in the URL (U3: a reload must not log).
 *   P4  a third org's reader sees ITS franchisee in the picker and never PG (names are scoped by the agreement).
 *   P5  a non-uuid ?franchisee= / ?store= is NEXT_NOT_FOUND, never a database error.
 * Mutants: page fetches figures on render -> P3; picker lists every organisation -> P4; raw segment to SQL -> P5; page without requirePageAccess -> P1.
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

const salesPage = () => import('../../src/app/franchise/sales/page');
const stockPage = () => import('../../src/app/franchise/stock/page');
const actorOf = (orgId: string, p: { id: string }) => ({ orgId, personId: p.id }) as never;
const pgName = async (W: FranchiseWorld) => (await ownerSql<{ name: string }[]>`select name from organizations where id = ${W.pg.orgId}`)[0]!.name;
const yName = async (W: FranchiseWorld) => (await ownerSql<{ name: string }[]>`select name from organizations where id = ${W.y.orgId}`)[0]!.name;
const ROUTES = [
  ['sales', salesPage],
  ['stock', stockPage],
] as const;

describe('P1 the page gate (requirePageAccess)', () => {
  for (const [route, load] of ROUTES) {
    it.each([
      ['adminL', (W: FranchiseWorld) => actorOf(W.l.orgId, W.adminL)],
      ['mgrL', (W: FranchiseWorld) => actorOf(W.l.orgId, W.mgrL)],
      ['staffL', (W: FranchiseWorld) => actorOf(W.l.orgId, W.staffL)],
      ['mgrPG', (W: FranchiseWorld) => actorOf(W.pg.orgId, W.mgrPG)],
      ['adminPG', (W: FranchiseWorld) => actorOf(W.pg.orgId, W.adminPG)],
      ['staffPG', (W: FranchiseWorld) => actorOf(W.pg.orgId, W.staffPG)],
    ])(`/franchise/${route}: %s gets the access-refused card and no picker`, async (_who, mk) => {
      const W = await franchiseWorld();
      const html = await render(load, mk(W));
      expect(plain(html)).toContain(M.refusedCard);
      expect(plain(html)).toContain('view_franchise_sales');
      expect(html).not.toContain(W.pg.orgId);
      expect(plain(html)).not.toContain(await pgName(W));
    });
  }
});

describe('P2 / P3 Ian\'s bare page', () => {
  for (const [route, load] of ROUTES) {
    it(`/franchise/${route}: picker by name, a plain notice, nothing about money, and rendering logs nothing (3 loads, 0 rows)`, async () => {
      const W = await franchiseWorld();
      const total0 = await totalLogCount();
      const html = await render(load, actorOf(W.l.orgId, W.ianL));
      await render(load, actorOf(W.l.orgId, W.ianL));
      await render(load, actorOf(W.l.orgId, W.ianL), { search: { franchisee: W.pg.orgId, from: D0, to: D0 } });
      const text = plain(html);
      expect(text, 'the franchisee is picked by name').toContain(await pgName(W));
      expect(text, 'the notice').toMatch(/will see that you looked/i);
      for (const s of [SENTINEL_COST, SENTINEL_EXPENSE, SENTINEL_BANK, 'SENTINEL']) expect(html).not.toContain(s);
      expect(text, 'no figures on a page nobody has pressed a button on').not.toMatch(/1,?000\.00|4,?500\.50/);
      expect(await totalLogCount(), 'a render is not a look').toBe(total0);
    });
  }

  it('/franchise/sales: a reason box and a button exist (the look is a press, not a load)', async () => {
    const W = await franchiseWorld();
    const html = await render(salesPage, actorOf(W.l.orgId, W.ianL));
    expect(html).toMatch(/name="reason"/);
    expect(html).toMatch(/name="from"/);
    expect(html).toMatch(/name="to"/);
    expect(html).toMatch(/<button[^>]*type="submit"|<button(?![^>]*type=)/);
  });

  it('/franchise/stock: no edit control anywhere (read only: no input other than the picker and the reason)', async () => {
    const W = await franchiseWorld();
    const html = await render(stockPage, actorOf(W.l.orgId, W.ianL));
    const names = [...html.matchAll(/<(?:input|select|textarea)[^>]*\bname="([^"]+)"/g)].map((m) => m[1]!);
    for (const n of names) expect(['franchiseeOrgId', 'storeId', 'reason', 'franchisee', 'store'], `unexpected control "${n}"`).toContain(n);
  });
});

describe('P4 the picker is scoped by the agreement', () => {
  it('X\'s reader sees Y (its franchisee) and never PG', async () => {
    const W = await franchiseWorld();
    for (const [, load] of ROUTES) {
      const html = await render(load, actorOf(W.x.orgId, W.readerX));
      expect(plain(html)).toContain(await yName(W));
      expect(plain(html)).not.toContain(await pgName(W));
      expect(html).not.toContain(W.pg.orgId);
    }
  });
  it('W\'s reader (no agreement) sees an empty picker, not an error', async () => {
    const W = await franchiseWorld();
    const html = await render(salesPage, actorOf(W.w.orgId, W.readerW));
    expect(plain(html)).not.toContain(await pgName(W));
    expect(html).not.toContain(W.pg.orgId);
  });
});

describe('P5 route parameters that are not uuids', () => {
  const uuidless = ['abc', 'not-a-uuid', '123', "x'; drop table users;--"];
  it.each(uuidless)('sales ?franchisee="%s" is NEXT_NOT_FOUND, not a database error', async (seg) => {
    const W = await franchiseWorld();
    expect(await pageError(() => render(salesPage, actorOf(W.l.orgId, W.ianL), { search: { franchisee: seg } }))).toBe('NEXT_NOT_FOUND');
  });
  it.each(uuidless)('stock with "%s" as franchisee or as store is NEXT_NOT_FOUND, not a database error', async (seg) => {
    const W = await franchiseWorld();
    expect(await pageError(() => render(stockPage, actorOf(W.l.orgId, W.ianL), { search: { franchisee: seg } }))).toBe('NEXT_NOT_FOUND');
    expect(await pageError(() => render(stockPage, actorOf(W.l.orgId, W.ianL), { search: { franchisee: W.pg.orgId, store: seg } }))).toBe('NEXT_NOT_FOUND');
  });
});
