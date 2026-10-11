import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-390 S5 (TESTER, audit round) - the cutover screens' read gate, the attest return path, exact merged totals, whole-month lives,
 * and the count sheet's honesty. Real actions (nothing mocked but the session, the redirect and the shell).
 *
 * CONTRACT PINNED HERE (the spec is silent; the builder matches):
 *  - /cutover/opening, /cutover/count, /cutover/count/sheet gate their READ on `run_cutover` (`requirePageAccess`, which maps the
 *    route in lib/route-capability.ts): a person without it gets the refusal card (or a redirect), and nothing of the page's data.
 *  - the C3P attest form on /cutover/opening brings the person back to /cutover/opening, on success and on refusal, whatever
 *    mechanism the builder chooses (the test submits the form it finds on the page, hidden fields and all).
 *  - a merged line's total is summed exactly (decimal), e.g. 0.100 + 0.200 = "0.300".
 *  - valueOpeningAssetAction takes the life as plain digits only: '1e2', '0x10' and '12.5' are refused in words.
 *  - the count sheet omits inactive items; the count page's money figure is labelled as the STORE's (it is not the room's).
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { captureRedirect, outcomeOf, pageParamsOf, RedirectSignal, resetJar } from '../helpers/flash-jar';
import { formsOf } from '../helpers/element-forms';
import { plain } from './t389-s2-common';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';
import { asOrg, domain, figure, fixture, mkShell, mkSupplier, sql, uid } from '../../../../tests/integration/t390-s3-common';
import { capabilityForRoute } from '../../src/lib/route-capability';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Route = 'opening' | 'count' | 'count/sheet';
const pageOf = async (route: Route) => (await import(`../../src/app/cutover/${route}/page`)).default as (p: unknown) => Promise<unknown>;
const actions = () => import('../../src/app/cutover/actions');

type Who = { personId: string; orgId: string };
/** Render; a redirect counts as a refusal (empty markup), anything else returns the markup and the element tree. */
async function show(route: Route, who: Who, sp: Record<string, string>) {
  h.actor = who;
  try {
    const el = await (await pageOf(route))({ params: Promise.resolve({}), searchParams: Promise.resolve(sp) });
    const html = renderToStaticMarkup(el as never);
    return { redirected: false, html, text: plain(html), el };
  } catch (e) {
    if (e instanceof RedirectSignal) return { redirected: true, html: '', text: '', el: null as unknown };
    throw e;
  }
}

async function setup(hint: string) {
  const f = await fixture(hint);
  const [lt] = await sql<{ id: string }[]>`select id from location_types where org_id = ${f.orgId} limit 1`;
  const [frz] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, status, created_by)
    values (${f.orgId}, ${f.storeA}, 'FRZ', 'Freezer', ${lt!.id}, 'operating', false, 'active', ${f.adminId}) returning id`;
  const mkItem = async (name: string, status = 'active') =>
    (await sql<{ id: string; name: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, status, created_by)
      values (${f.orgId}, ${testItemCode()}, ${`${name}${uid('x').replace(/\W/g, '')}`}, 'raw_material', 'kg', ${status}, ${f.adminId})
      returning id, name`)[0]!;
  const move = (item: string, room: string) =>
    sql`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
        values (${f.orgId}, ${f.storeA}, ${room}, ${item}, now() - interval '5 days', 1, 'transfer_in', 'test_fixture', gen_random_uuid(), ${f.adminId})`;
  return { f, kit: f.roomA, frz: frz!.id, mkItem, move };
}
type Setup = Awaited<ReturnType<typeof setup>>;

describe('1 - the read gate: run_cutover', () => {
  it('the three routes are mapped to run_cutover', () => {
    for (const r of ['/cutover/opening', '/cutover/count', '/cutover/count/sheet']) expect(capabilityForRoute(r), r).toBe('run_cutover');
  });

  it('staff see none of the party names, peso figures or costs on any of the three pages; manager and admin do', async () => {
    const s = await setup('gate');
    const sup = await mkSupplier(s.f, 'Secretsupplier');
    await figure(s.f, { accountCode: '2110', storeId: s.f.storeA, direction: 'credit', amount: '1500.00', partyType: 'supplier', partyId: sup.id });
    const item = await s.mkItem('Gateditem');
    await asOrg(s.f.orgId, (tx) =>
      domain.recordOpeningCount(tx, s.f.admin, { storeId: s.f.storeA, locationId: s.kit, itemId: item.id, quantity: '3', unitCost: '777.7777', costSource: 'typed' } as never),
    );
    await s.move(item.id, s.kit);
    const secrets = [sup.name, '1,500.00', '777.7777', item.name];
    for (const route of ['opening', 'count', 'count/sheet'] as const) {
      const sp = { store: s.f.storeA };
      for (const [label, who] of [['admin', s.f.admin], ['manager', s.f.manager]] as const) {
        const ok = await show(route, who, sp);
        expect(ok.redirected, `${label} sees /cutover/${route}`).toBe(false);
        expect(ok.text, `${label} is not shown a refusal on /cutover/${route}`).not.toMatch(/do not have access/i);
      }
      const staff = await show(route, s.f.staff, sp);
      if (!staff.redirected) expect(staff.text, `/cutover/${route}: staff get the refusal card`).toMatch(/do not have access|run_cutover/i);
      for (const secret of secrets) expect(staff.html, `/cutover/${route}: staff must not receive "${secret}"`).not.toContain(secret);
    }
  });
});

describe('2 - the C3P attest form returns to /cutover/opening', () => {
  async function submitC3P(s: Setup, who: Who) {
    const page = await show('opening', s.f.admin, {});
    const form = (await formsOf(page.el)).find((x) => x.hidden['stepCode'] === 'C3P');
    expect(form, 'the opening page has a C3P attest form').toBeDefined();
    const fd = new FormData();
    for (const [k, v] of Object.entries(form!.hidden)) fd.set(k, v);
    fd.set('note', 'agreed with the v1 aged lists');
    resetJar();
    h.actor = who;
    return captureRedirect(() => (form!.action as (f: FormData) => Promise<void>)(fd));
  }

  it('success goes back to /cutover/opening', async () => {
    const s = await setup('attest-ok');
    const o = outcomeOf(await submitC3P(s, s.f.admin));
    expect(o.flash.error, 'attested').toBeUndefined();
    expect(o.path).toBe('/cutover/opening');
  });

  it('a refusal goes back to /cutover/opening and the flash shows there', async () => {
    const s = await setup('attest-refuse');
    const signal = await submitC3P(s, s.f.staff);
    const o = outcomeOf(signal);
    expect(o.flash.error, 'staff may not attest').toBeTruthy();
    expect(o.path, 'the refusal lands on the screen the person was on').toBe('/cutover/opening');
    const shown = await show('opening', s.f.admin, pageParamsOf(signal.url));
    expect(shown.text, 'the refusal is shown on that page').toContain(plain(o.flash.error!));
  });
});

describe('3 - merged totals are exact', () => {
  it('0.100 kg in the Kitchen + 0.200 kg in the Freezer shows 0.300, never 0.30000000000000004', async () => {
    const s = await setup('exact');
    const item = await s.mkItem('Exactitem');
    for (const [room, q] of [[s.kit, '0.100'], [s.frz, '0.200']] as const) {
      await asOrg(s.f.orgId, (tx) =>
        domain.recordOpeningCount(tx, s.f.admin, { storeId: s.f.storeA, locationId: room, itemId: item.id, quantity: q } as never),
      );
    }
    const { text } = await show('count', s.f.admin, { store: s.f.storeA });
    expect(text, 'the merged line is on the page').toContain(item.name);
    expect(text).not.toMatch(/0\.3000000/);
    expect(text).toMatch(/0\.300\b/);
  });
});

describe('6 - valueOpeningAssetAction: the life is plain digits', () => {
  for (const life of ['1e2', '0x10', '12.5']) {
    it(`'${life}' is refused in words and the shell stays pending`, async () => {
      const s = await setup(`life-${life.replace(/\W/g, '')}`);
      const shell = await mkShell(s.f, s.f.storeA);
      const fd = new FormData();
      for (const [k, v] of Object.entries({ assetId: shell.id, bookValue: '1000.00', remainingLifeMonths: life, salvageValue: '' })) fd.set(k, v);
      resetJar();
      h.actor = s.f.admin;
      const o = outcomeOf(await captureRedirect(() => actions().then((m) => m.valueOpeningAssetAction(fd))));
      expect(o.flash.error, `life ${life}`).toMatch(/whole number of months/i);
      const [r] = await sql<{ status: string }[]>`select status from fixed_assets where id = ${shell.id}`;
      expect(r!.status).toBe('pending_valuation');
    });
  }
});

describe('7 - the count sheet and the count page tell the truth', () => {
  it('the sheet omits an inactive item that moved in the room; an active one is listed', async () => {
    const s = await setup('sheet-inactive');
    const live = await s.mkItem('Liveitem');
    const dead = await s.mkItem('Deaditem', 'inactive');
    await s.move(live.id, s.kit);
    await s.move(dead.id, s.kit);
    const { text } = await show('count/sheet', s.f.admin, { store: s.f.storeA, room: s.kit });
    expect(text).toContain(live.name);
    expect(text, 'an inactive item is not counted').not.toContain(dead.name);
  });

  it("the count page labels its money figure as the STORE's, not the room's", async () => {
    const s = await setup('label');
    const item = await s.mkItem('Labelitem');
    await asOrg(s.f.orgId, (tx) =>
      domain.recordOpeningCount(tx, s.f.admin, { storeId: s.f.storeA, locationId: s.frz, itemId: item.id, quantity: '2', unitCost: '50', costSource: 'typed' } as never),
    );
    const { text } = await show('count', s.f.admin, { store: s.f.storeA, room: s.kit });
    expect(text, 'the Kitchen view carries a figure that includes the Freezer: the label must say it is the store').toMatch(
      /(whole store|entire store|all rooms|store total|in the store|this store|at the store|store-wide)/i,
    );
  });
});

describe('5 - the loaders hold no SQL', () => {
  it('apps/erp/src/app/cutover/lib.ts has no dsql / sql`` (SQL belongs in cutoverRepo)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/app/cutover/lib.ts'), 'utf8');
    expect(src).not.toMatch(/\bdsql\b/);
    expect(src).not.toMatch(/\bsql`/);
  });
});
