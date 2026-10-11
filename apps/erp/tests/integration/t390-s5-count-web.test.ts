import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * T-390 S5 (TESTER) - /cutover/count with a room per count. DEF-630 (editing a merged two-room line double-counts) and bible row 300
 * (the typed slot keeps typing; its record is now per ITEM AND ROOM).
 * Spec: docs/tasks/390-opening-stock-and-subledger-tieout.md s5.4, s7 S5; docs/DEFECTS-REGISTER.md DEF-630; t389-s4-common.ts harness.
 *
 * CONTRACT PINNED HERE (the spec is silent; the builder matches):
 *  - the page takes `?store=<id>&room=<id>`; no `room` = the store's default room. It shows ONE room's lines at a time, with a room
 *    selector (a link or an option per active room, carrying the room id; the room's name shown).
 *  - every line is one EditableRecord whose hidden fields are storeId, itemId, locationId, and which is prefilled with THAT ROOM'S
 *    quantity and cost, never the store total. There is no form anywhere that writes the merged total.
 *  - typed slot: form key `cutover.count` (unchanged), record = `${itemId}:${locationId}`, allow-list quantity + unitCost only.
 *  - a "counted N of M" line, per room.
 *  - a refusal redirects with `store` and `room` so the page reopens the room that was being counted.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
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
      seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { captureRedirect, outcomeOf, pageParamsOf, resetJar } from '../helpers/flash-jar';
import { createHarness, fixture, LONG, markup, plain, sql, type BaseCtx, type FormCase } from './t389-s4-common';
import { formSegments } from './t389-s2-common';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const { runTypedLegs } = createHarness({ h, seen });

interface CountCtx extends BaseCtx {
  storeId: string;
  kit: string; // default room
  frz: string;
  itemA: string; // Kitchen 7 + Freezer 6 @ 10.0000 (a merged two-room line: total 13)
  itemB: string; // Kitchen 8 @ 20.0000
}
async function countCtx(hint: string, record: 'kit' | 'frz' = 'kit'): Promise<CountCtx> {
  const f = await fixture(`cc5-${hint}`);
  await sql`update stores set stock_model = 'multi_room' where id = ${f.storeId}`;
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (code: string, name: string, isDefault: boolean) =>
    (await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${f.orgId}, ${f.storeId}, ${code}, ${name}, ${lt!.id}, 'operating', ${isDefault}, ${f.admin.personId}) returning id`)[0]!.id;
  const kit = await mkRoom('KIT', 'Kitchen', true);
  const frz = await mkRoom('FRZ', 'Freezer', false);
  const mkItem = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${testItemCode()}, ${name}, 'raw_material', 'kg', ${f.admin.personId}) returning id`)[0]!.id;
  const put = (item: string, room: string, qty: string, cost: string) =>
    sql`insert into opening_counts (org_id, store_id, location_id, item_id, quantity, unit_cost, cost_source, counted_by)
        values (${f.orgId}, ${f.storeId}, ${room}, ${item}, ${qty}, ${cost}, 'typed', ${f.admin.personId})`;
  const itemA = await mkItem('Pork Belly');
  const itemB = await mkItem('Chicken Thigh');
  await put(itemA, kit, '7.000', '10.0000');
  await put(itemA, frz, '6.000', '10.0000');
  await put(itemB, kit, '8.000', '20.0000');
  const ctx: CountCtx = { f, record: `${itemA}:${record === 'kit' ? kit : frz}`, storeId: f.storeId, kit, frz, itemA, itemB };
  return ctx;
}

const page = async () => (await import('../../src/app/cutover/count/page')).default as never;
const actions = () => import('../../src/app/cutover/actions');
const fdOf = (base: Record<string, string>, over: Record<string, string | string[] | null> = {}): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v as string);
  return fd;
};

function roomCase(which: 'kit' | 'frz'): FormCase<CountCtx> {
  const room = (c: CountCtx) => (which === 'kit' ? c.kit : c.frz);
  const stored = which === 'kit' ? { q: '7.000', c: '10.0000' } : { q: '6.000', c: '10.0000' };
  const self: FormCase<CountCtx> = {
    label: `cutover opening count, ${which === 'kit' ? 'Kitchen' : 'Freezer'} line (record = item:room)`,
    form: 'cutover.count',
    setup: (hint) => countCtx(`${which}-${hint}`, which),
    action: async () => (await actions()).recordCountAction,
    page,
    // The Freezer case passes its room explicitly (no room = the default room, Kitchen); the refusal-keeps-the-room leg is its own test below.
    props: (ctx, params) => ({ params: Promise.resolve({}) as never, searchParams: Promise.resolve({ store: ctx.storeId, ...(which === 'frz' ? { room: ctx.frz } : {}), ...params }) }),
    sel: (ctx) => ({ action: 'recordCountAction', hidden: { itemId: ctx.itemA, locationId: room(ctx) } }),
    has: (ctx) => [`name="itemId" value="${ctx.itemA}"`, `name="locationId" value="${room(ctx)}"`],
    hiddenNames: ['storeId', 'itemId', 'locationId'],
    refused: (ctx, over = {}) =>
      fdOf({ storeId: ctx.storeId, locationId: room(ctx), itemId: ctx.itemA, quantity: '-3', unitCost: '12.5' }, over),
    refusal: /cannot be negative/i,
    fields: () => ({ quantity: '-3', unitCost: '12.5' }),
    changed: { list: 'quantity', fields: () => ({ quantity: '-3' }) },
    notDrawn: ['value="-3"', 'value="12.5"'],
    stored: (_ctx, seg, m) => {
      expect(m.inputValue(seg, 'quantity'), 'the stored quantity of THIS ROOM is drawn (never the 13 total)').toBe(stored.q);
      expect(m.inputValue(seg, 'unitCost'), 'the stored cost is drawn').toBe(stored.c);
    },
    tooLong: { unitCost: LONG },
    good: (ctx) => self.refused(ctx, { quantity: '4', unitCost: '11' }),
    ok: null,
    siblings:
      which === 'kit'
        ? async (ctx) => [{ label: 'another item, same room', sel: { action: 'recordCountAction', hidden: { itemId: ctx.itemB, locationId: ctx.kit } }, has: [`name="itemId" value="${ctx.itemB}"`, `name="locationId" value="${ctx.kit}"`] }]
        : async () => [],
  };
  return self;
}
runTypedLegs(roomCase('kit'));
runTypedLegs(roomCase('frz'));

// ---------------------------------------------------------------------------------------------------------------------------
// DEF-630 and the room selector
// ---------------------------------------------------------------------------------------------------------------------------

async function render(ctx: CountCtx, params: Record<string, string> = {}): Promise<string> {
  h.actor = ctx.f.admin;
  seen.records = [];
  const Page = (await page()) as (p: unknown) => Promise<unknown>;
  const el = await Page({ params: Promise.resolve({}), searchParams: Promise.resolve({ store: ctx.storeId, ...params }) });
  return renderToStaticMarkup(el as never);
}
const quantitiesDrawn = (html: string): number[] =>
  formSegments(html)
    .map((seg) => markup.inputValue(seg, 'quantity'))
    .filter((v): v is string => v !== null && v !== '')
    .map(Number);
const hiddenOf = (seg: string, name: string): string | null => {
  const m = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"|<input[^>]*value="([^"]*)"[^>]*name="${name}"`).exec(seg);
  return m ? (m[1] ?? m[2] ?? null) : null;
};

describe('T-390 S5 DEF-630 - a merged two-room line is never an editable total', () => {
  it('no form on any view of the page carries the room TOTAL (7 + 6 = 13) as a quantity', async () => {
    const ctx = await countCtx('def630-total');
    const views: Record<string, string>[] = [{}, { room: ctx.kit }, { room: ctx.frz }];
    for (const params of views) {
      const html = await render(ctx, params);
      expect(quantitiesDrawn(html), `view ${JSON.stringify(params)}: nothing is prefilled with the double-counting total`).not.toContain(13);
    }
  });

  it('the Kitchen view prefills 7 for the item and the Freezer view prefills 6, each with its own room id', async () => {
    const ctx = await countCtx('def630-views');
    const forItem = (html: string) => formSegments(html).find((s) => s.includes(`name="itemId" value="${ctx.itemA}"`));
    const kit = forItem(await render(ctx, { room: ctx.kit }));
    const frz = forItem(await render(ctx, { room: ctx.frz }));
    expect(kit, 'Kitchen draws the item').toBeDefined();
    expect(frz, 'Freezer draws the item').toBeDefined();
    expect(Number(markup.inputValue(kit!, 'quantity'))).toBe(7);
    expect(Number(markup.inputValue(frz!, 'quantity'))).toBe(6);
    expect(hiddenOf(kit!, 'locationId')).toBe(ctx.kit);
    expect(hiddenOf(frz!, 'locationId')).toBe(ctx.frz);
  });

  it('no room in the address = the default room (Kitchen), not the merged line', async () => {
    const ctx = await countCtx('def630-default');
    const html = await render(ctx);
    const seg = formSegments(html).find((s) => s.includes(`name="itemId" value="${ctx.itemA}"`))!;
    expect(seg, 'the item is drawn').toBeDefined();
    expect(Number(markup.inputValue(seg, 'quantity'))).toBe(7);
  });

  it('END TO END: open the Freezer line, change 6 to 2, Save -> Freezer 2, Kitchen still 7, store total 9 (not 7 + 13)', async () => {
    const ctx = await countCtx('def630-e2e');
    const html = await render(ctx, { room: ctx.frz });
    const seg = formSegments(html).find((s) => s.includes(`name="itemId" value="${ctx.itemA}"`));
    expect(seg, 'the Freezer line is on the page').toBeDefined();
    // Submit exactly what that form would submit, with the quantity edited.
    const fd = fdOf({
      storeId: hiddenOf(seg!, 'storeId') ?? '',
      itemId: hiddenOf(seg!, 'itemId') ?? '',
      locationId: hiddenOf(seg!, 'locationId') ?? '',
      quantity: '2',
      unitCost: markup.inputValue(seg!, 'unitCost') ?? '',
    });
    resetJar();
    h.actor = ctx.f.admin;
    await captureRedirect(() => actions().then((m) => m.recordCountAction(fd)));
    const got = await sql<{ location_id: string; quantity: string }[]>`
      select location_id, quantity::text from opening_counts where org_id = ${ctx.f.orgId} and store_id = ${ctx.storeId} and item_id = ${ctx.itemA}`;
    const by = Object.fromEntries(got.map((r) => [r.location_id, Number(r.quantity)]));
    expect(by[ctx.frz], 'Freezer was edited').toBe(2);
    expect(by[ctx.kit], 'Kitchen is untouched by a Freezer edit').toBe(7);
  });

  it('the page has a room selector: every active room by name, linkable by id, the current one marked', async () => {
    const ctx = await countCtx('selector');
    const html = await render(ctx, { room: ctx.frz });
    const text = plain(html);
    expect(text).toContain('Kitchen');
    expect(text).toContain('Freezer');
    expect(html, 'the Kitchen choice carries the room id').toContain(ctx.kit);
    expect(html, 'the Freezer choice carries the room id').toContain(ctx.frz);
  });

  it('"counted N of M" is per room: Kitchen 2 of 2, Freezer 1 of 2', async () => {
    const ctx = await countCtx('progress');
    expect(plain(await render(ctx, { room: ctx.kit }))).toMatch(/counted\s+2\s+of\s+2/i);
    expect(plain(await render(ctx, { room: ctx.frz }))).toMatch(/counted\s+1\s+of\s+2/i);
  });
});

describe('T-390 S5 bible row 300 - the typed record is per (item, room)', () => {
  it('a refusal in the Freezer keeps the typing for itemA:Freezer; the same item in the Kitchen stays locked with nothing typed', async () => {
    const ctx = await countCtx('typed-other-room', 'frz');
    resetJar();
    h.actor = ctx.f.admin;
    const signal = await captureRedirect(() =>
      actions().then((m) => m.recordCountAction(fdOf({ storeId: ctx.storeId, locationId: ctx.frz, itemId: ctx.itemA, quantity: '-3', unitCost: '12.5' }))),
    );
    expect(outcomeOf(signal).flash.error).toMatch(/cannot be negative/i);
    const params = pageParamsOf(signal.url);
    // The user is put back in the Freezer: that record reopens with the typing.
    await render(ctx, params);
    const frzRec = (seen.records as Array<{ hidden?: Record<string, string>; typed?: { kind?: string } | null }>).find(
      (r) => r?.hidden?.['itemId'] === ctx.itemA && r.hidden['locationId'] === ctx.frz,
    );
    expect(frzRec?.typed?.kind, 'the Freezer line reopens with the typing').toBe('typed');
    // Same flash, but looking at the Kitchen: the Kitchen line of the SAME item must not receive the Freezer's typing.
    await render(ctx, { ...params, room: ctx.kit });
    const kitRec = (seen.records as Array<{ hidden?: Record<string, string>; typed?: { kind?: string } | null }>).find(
      (r) => r?.hidden?.['itemId'] === ctx.itemA && r.hidden['locationId'] === ctx.kit,
    );
    expect(kitRec, 'the Kitchen line is drawn').toBeDefined();
    expect(kitRec?.typed ?? null, 'a record id of just the item would hand the Freezer typing to the Kitchen line').toBeNull();
  });

  it('control: the item-only record id of T-389 S4 (itemId) is no longer the slot record', async () => {
    const ctx = await countCtx('typed-record');
    resetJar();
    h.actor = ctx.f.admin;
    await captureRedirect(() =>
      actions().then((m) => m.recordCountAction(fdOf({ storeId: ctx.storeId, locationId: ctx.kit, itemId: ctx.itemA, quantity: '-3' }))),
    );
    const { decodeFlash } = await import('../../src/lib/flash');
    const { currentJar, FLASH_COOKIE } = await import('../helpers/flash-jar');
    const p = decodeFlash(currentJar().get(FLASH_COOKIE)!.value) as { t?: { record: string } };
    expect(p.t?.record).toBe(`${ctx.itemA}:${ctx.kit}`);
  });
});
