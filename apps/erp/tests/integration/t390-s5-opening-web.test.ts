import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-390 S5 (TESTER) - /cutover/opening (value the count, value assets, party picker, tie-out panel) and /cutover/count/sheet (the
 * printable count sheet). Spec: docs/tasks/390-opening-stock-and-subledger-tieout.md s5.4, s10 smoke 1 and 6.
 *
 * HOW THE WIRING IS PROVEN: the cutover `actions` module is replaced by named spies, and the page's React element tree is walked
 * (function components are expanded; client components that need hooks are left opaque and their children read). A form counts as
 * "wired" when its `action` IS the spy. That is what makes `valueOpeningAsset` / `valueOpeningStock` reachable from apps/ for real.
 *
 * CONTRACT PINNED HERE (the spec is silent; the builder matches):
 *  - actions: `valueOpeningStockAction` (hidden storeId), `valueOpeningAssetAction` (hidden assetId; inputs bookValue,
 *    remainingLifeMonths, salvageValue), `addOpeningFigureAction` (+ inputs partyType, partyId), `attestStepAction` (hidden stepCode).
 *  - /cutover/opening: one "Value the count" form per store; one asset form per pending_valuation shell (and none for an active
 *    asset); the party picker lists the org's suppliers by name; the Tie-out panel prints every tie line's sentence, every notChecked
 *    row (account, amount, reason), the steps C3P / C4 / C5 with their titles and, when set, the blockedBy / detail text; C3P has an
 *    attest form until it is attested.
 *  - /cutover/count/sheet?store=<id>[&room=<id>]: one section per active room, or only `room`. A room lists items with a movement in
 *    that room in the last 90 days. NO expected quantity anywhere.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const spies = vi.hoisted(() => {
  const mk = (n: string) => Object.assign(async () => {}, { displayName: n });
  return {
    attestStepAction: mk('attestStepAction'),
    recordCountAction: mk('recordCountAction'),
    addOpeningFigureAction: mk('addOpeningFigureAction'),
    removeOpeningFigureAction: mk('removeOpeningFigureAction'),
    postOpeningBalancesAction: mk('postOpeningBalancesAction'),
    valueOpeningStockAction: mk('valueOpeningStockAction'),
    valueOpeningAssetAction: mk('valueOpeningAssetAction'),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../../src/app/cutover/actions', () => spies);

import { cutoverProgress, CUTOVER_STEPS } from '@shareat/domain';
import { asOrg, attestC3P, figure, fixture, mkAsset, mkShell, mkSupplier, settle3900, sql, tieOut, uid, type Fixture } from '../../../../tests/integration/t390-s3-common';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';
import { plain } from './t389-s2-common';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const openingPage = async () => (await import('../../src/app/cutover/opening/page')).default as (p: unknown) => Promise<unknown>;
const sheetPage = async () => (await import('../../src/app/cutover/count/sheet/page')).default as (p: unknown) => Promise<unknown>;

// ---- element-tree walk ------------------------------------------------------------------------------------------------

type El = { type: unknown; props: Record<string, unknown> };
async function walk(node: unknown, visit: (el: El) => void): Promise<void> {
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) {
    for (const n of node) await walk(n, visit);
    return;
  }
  if (typeof (node as { then?: unknown }).then === 'function') return walk(await (node as Promise<unknown>), visit);
  if (typeof node !== 'object' || !('props' in (node as object))) return;
  const el = node as El;
  visit(el);
  const t = el.type as { prototype?: { isReactComponent?: unknown } } | ((p: unknown) => unknown);
  if (typeof t === 'function' && !t.prototype?.isReactComponent) {
    try {
      await walk(await (t as (p: unknown) => unknown)(el.props), visit);
      return;
    } catch {
      /* a client component (hooks): fall back to its children */
    }
  }
  await walk(el.props['children'], visit);
}
interface FormInfo {
  action: unknown;
  hidden: Record<string, string>;
  names: Set<string>;
}
async function formsOf(root: unknown): Promise<FormInfo[]> {
  const forms: El[] = [];
  await walk(root, (el) => {
    if (el.type === 'form' || (el.props['action'] !== undefined && el.props['hidden'] !== undefined)) forms.push(el);
  });
  const out: FormInfo[] = [];
  for (const fm of forms) {
    const names = new Set<string>();
    const hidden: Record<string, string> = { ...((fm.props['hidden'] as Record<string, string> | undefined) ?? {}) };
    await walk(fm.props['children'], (el) => {
      if (el.type === 'input' || el.type === 'select' || el.type === 'textarea') {
        const n = el.props['name'];
        if (typeof n === 'string') {
          names.add(n);
          if (el.type === 'input' && el.props['type'] === 'hidden' && typeof el.props['value'] === 'string') hidden[n] = el.props['value'];
        }
      }
    });
    out.push({ action: fm.props['action'], hidden, names });
  }
  return out;
}

async function renderOpening(f: Fixture) {
  h.actor = f.admin;
  const el = await (await openingPage())({ searchParams: Promise.resolve({}) });
  return { forms: await formsOf(el), html: renderToStaticMarkup(el as never), text: '' };
}
const textOf = (html: string) => plain(html);

// ---- /cutover/opening ----------------------------------------------------------------------------------------------------

describe('T-390 S5 /cutover/opening - Value the count', () => {
  it('one "Value the count" form per store, wired to valueOpeningStockAction with the store id', async () => {
    const f = await fixture('op-vs');
    const { forms } = await renderOpening(f);
    const stores = forms.filter((x) => x.action === spies.valueOpeningStockAction).map((x) => x.hidden['storeId']).sort();
    expect(stores, 'a Value-the-count button per store').toEqual([f.storeA, f.storeB].sort());
  });

  it('the button is on the screen, in words', async () => {
    const f = await fixture('op-vs-text');
    const { html } = await renderOpening(f);
    expect(textOf(html)).toMatch(/value the count/i);
  });
});

describe('T-390 S5 /cutover/opening - Assets to value', () => {
  it('every pending_valuation shell gets a form wired to valueOpeningAssetAction (assetId, bookValue, remainingLifeMonths, salvageValue); an active asset gets none', async () => {
    const f = await fixture('op-va');
    const shell = await mkShell(f, f.storeA);
    const shell2 = await mkShell(f, f.storeB);
    const active = await mkAsset(f, f.storeA, '5000.00');
    const { forms, html } = await renderOpening(f);
    const mine = forms.filter((x) => x.action === spies.valueOpeningAssetAction);
    expect(mine.map((x) => x.hidden['assetId']).sort(), 'one form per shell, none for the active asset').toEqual([shell.id, shell2.id].sort());
    expect(mine.map((x) => x.hidden['assetId'])).not.toContain(active);
    for (const m of mine) {
      for (const n of ['bookValue', 'remainingLifeMonths', 'salvageValue']) expect(m.names, `asset form has ${n}`).toContain(n);
    }
    expect(textOf(html), 'the shell is listed by name').toContain(shell.name);
  });

  it('with no shell there is no asset form', async () => {
    const f = await fixture('op-va-none');
    const { forms } = await renderOpening(f);
    expect(forms.filter((x) => x.action === spies.valueOpeningAssetAction)).toHaveLength(0);
  });
});

describe('T-390 S5 /cutover/opening - the party picker (R12)', () => {
  it('Add a figure has partyType and partyId inputs and the picker lists the suppliers by name', async () => {
    const f = await fixture('op-party');
    const sup = await mkSupplier(f, 'Meat King');
    const { forms, html } = await renderOpening(f);
    const add = forms.find((x) => x.action === spies.addOpeningFigureAction);
    expect(add, 'the add-figure form is wired').toBeDefined();
    expect(add!.names).toContain('partyType');
    expect(add!.names).toContain('partyId');
    expect(textOf(html), 'the supplier can be picked by name').toContain(sup.name);
  });
});

describe('T-390 S5 /cutover/opening - the Tie-out panel', () => {
  it('prints every red tie sentence (T2: the 1510 figure is typed short) and drops it once the figure is right', async () => {
    const f = await fixture('op-tie');
    await mkAsset(f, f.storeA, '312400.00');
    await figure(f, { accountCode: '1510', storeId: f.storeA, direction: 'debit', amount: '300000.00' });
    const t = await tieOut(f);
    const t2 = t.lines.filter((l) => /fixed assets/i.test(l.register));
    expect(t2.length, 'the domain says the register is off (fixture sanity)').toBeGreaterThan(0);
    const bad = textOf((await renderOpening(f)).html);
    for (const l of t.lines) expect(bad, `the panel prints the domain sentence for ${l.register}`).toContain(plain(l.sentence));
    // Fix it: replace the figure with the right amount.
    const drafts = await asOrg(f.orgId, (tx) => import('@shareat/db').then((m) => m.cutoverRepo.openingDrafts(tx, f.orgId)));
    for (const id of new Set(drafts.filter((d) => d.accountCode === '1510').map((d) => d.id))) {
      await asOrg(f.orgId, (tx) => import('@shareat/domain').then((m) => m.removeOpeningFigure(tx, f.admin, { entryId: id })));
    }
    await figure(f, { accountCode: '1510', storeId: f.storeA, direction: 'debit', amount: '312400.00' });
    await settle3900(f);
    const good = textOf((await renderOpening(f)).html);
    for (const l of t2) expect(good, 'the fixed-assets sentence is gone once it ties').not.toContain(plain(l.sentence));
  });

  it('lists the accounts that are NOT checked (R15) with account, amount and reason, never as a tie', async () => {
    const f = await fixture('op-nc');
    const sup = await mkSupplier(f, 'Packaging Co');
    await figure(f, { accountCode: '1240', storeId: f.storeB, direction: 'debit', amount: '1240.00', partyType: 'supplier', partyId: sup.id });
    const t = await tieOut(f);
    const notChecked = t.notChecked ?? [];
    expect(notChecked.length, 'the domain lists the 1240 balance (fixture sanity)').toBeGreaterThan(0);
    const text = textOf((await renderOpening(f)).html);
    for (const n of notChecked) {
      expect(text, `not-checked account ${n.account}`).toContain(n.account);
      expect(text, `not-checked amount ${n.amount}`).toContain(plain(n.amount));
      expect(text, `not-checked reason for ${n.account}`).toContain(plain(n.reason));
    }
  });

  it('says party registers are checked for valid parties only, totals at the rehearsal (T-394)', async () => {
    const f = await fixture('op-parties-note');
    expect(textOf((await renderOpening(f)).html)).toMatch(/compared with v1 at the rehearsal/i);
  });

  it('shows C3P, C4 and C5 with their titles and, where the domain gives one, the blockedBy / detail text; C3P has an attest form until attested', async () => {
    const f = await fixture('op-steps');
    const stores = [f.storeA, f.storeB];
    const prog = await asOrg(f.orgId, (tx) => cutoverProgress(tx, f.orgId, stores));
    const first = await renderOpening(f);
    const text = textOf(first.html);
    for (const code of ['C3P', 'C4', 'C5']) {
      const def = CUTOVER_STEPS.find((s) => s.code === code)!;
      expect(text, `${code} title`).toContain(plain(def.title));
      const st = prog.steps.find((s) => s.def.code === code)!;
      const why = st.blockedBy ?? st.detail;
      if (why) expect(text, `${code}: ${why}`).toContain(plain(why));
    }
    expect(first.forms.some((x) => x.action === spies.attestStepAction && x.hidden['stepCode'] === 'C3P'), 'C3P can be attested from this page').toBe(true);

    await attestC3P(f);
    const after = await renderOpening(f);
    expect(after.forms.some((x) => x.action === spies.attestStepAction && x.hidden['stepCode'] === 'C3P'), 'once attested the attest form is gone').toBe(false);
  });
});

// ---- /cutover/count/sheet -------------------------------------------------------------------------------------------------

async function sheetFixture(hint: string) {
  const f = await fixture(hint);
  const [lt] = await sql<{ id: string }[]>`select id from location_types where org_id = ${f.orgId} limit 1`;
  const [frz] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, status, created_by)
    values (${f.orgId}, ${f.storeA}, 'FRZ', 'Freezer', ${lt!.id}, 'operating', false, 'active', ${f.adminId}) returning id`;
  const mk = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${testItemCode()}, ${`${name}${uid('x').replace(/\W/g, '')}`}, 'raw_material', 'kg', ${f.adminId}) returning id`)[0]!;
  const rows = {
    pork: await mk('Porkbelly'), // moved in the Freezer 10 days ago
    soda: await mk('Sodacan'), // moved in the Kitchen 10 days ago
    dormant: await mk('Dormantitem'), // last moved in the Kitchen 200 days ago
    never: await mk('Neveritem'), // never moved
  };
  const move = (item: string, room: string, daysAgo: number) =>
    sql`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
        values (${f.orgId}, ${f.storeA}, ${room}, ${item}, now() - ${daysAgo + ' days'}::interval, 4321.5, 'transfer_in', 'test_fixture', gen_random_uuid(), ${f.adminId})`;
  await move(rows.pork.id, frz!.id, 10);
  await move(rows.soda.id, f.roomA, 10);
  await move(rows.dormant.id, f.roomA, 200);
  return { f, kit: f.roomA, frz: frz!.id, items: rows };
}
async function renderSheet(s: Awaited<ReturnType<typeof sheetFixture>>, params: Record<string, string>) {
  h.actor = s.f.admin;
  const el = await (await sheetPage())({ params: Promise.resolve({}), searchParams: Promise.resolve({ store: s.f.storeA, ...params }) });
  const html = renderToStaticMarkup(el as never);
  return { html, text: plain(html) };
}
const nameOf = async (id: string) => (await sql<{ name: string }[]>`select name from items where id = ${id}`)[0]!.name;

describe('T-390 S5 /cutover/count/sheet - the printable count sheet', () => {
  it('a single room lists the items that moved there in the last 90 days, and not the dormant, the unmoved, or another room\'s', async () => {
    const s = await sheetFixture('sheet-room');
    const frz = (await renderSheet(s, { room: s.frz })).text;
    expect(frz).toContain(await nameOf(s.items.pork.id));
    for (const other of [s.items.soda, s.items.dormant, s.items.never]) expect(frz, 'not on the Freezer sheet').not.toContain(await nameOf(other.id));
    const kit = (await renderSheet(s, { room: s.kit })).text;
    expect(kit).toContain(await nameOf(s.items.soda.id));
    for (const other of [s.items.pork, s.items.dormant, s.items.never]) expect(kit, 'not on the Kitchen sheet').not.toContain(await nameOf(other.id));
  });

  it('with no room it prints one section per active room, each with its own footer', async () => {
    const s = await sheetFixture('sheet-all');
    const { text } = await renderSheet(s, {});
    expect(text).toContain('KIT');
    expect(text).toContain('Freezer');
    expect(text).toContain(await nameOf(s.items.pork.id));
    expect(text).toContain(await nameOf(s.items.soda.id));
    expect((text.match(/Counted by/g) ?? []).length, 'one footer per room').toBe(2);
    expect((text.match(/Checked by/g) ?? []).length).toBe(2);
  });

  it('has the blank rows, the footer fields, the 31 December date and a print stylesheet that hides navigation', async () => {
    const s = await sheetFixture('sheet-furniture');
    const { html, text } = await renderSheet(s, { room: s.frz });
    expect(text).toMatch(/Found here, not listed/i);
    expect(text).toContain('Counted by');
    expect(text).toContain('Checked by');
    expect(text).toMatch(/\bTime\b/);
    expect(text).toMatch(/31 Dec|December 31|2026-12-31/);
    expect(html).toContain('@media print');
  });

  it('shows NO expected quantity anywhere (the ledger said 4321.5; the sheet must not)', async () => {
    const s = await sheetFixture('sheet-blind');
    const { html } = await renderSheet(s, {});
    expect(html).not.toContain('4321');
    expect(html).not.toMatch(/on hand|expected|system qty/i);
  });
});
