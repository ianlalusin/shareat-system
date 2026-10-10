import { describe, expect, it, vi } from 'vitest';

/**
 * T-389 S2 (TESTER) - admin/stores/[id]: the three saved-record forms keep what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md. Legs and harness: t389-s2-common.ts (read its header).
 *
 * Forms (page -> action -> the refusal driven; every one is reachable from the browser):
 *   Details       updateStoreAction          tinBranchCode "1" (a branch code is 3-5 digits)
 *   Opening date  setStoreOpeningDateAction  moving the date past the store's first trading day (a store that has traded)
 *   Stock model   setStoreStockModelAction   narrowing to one room while two active rooms exist
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form keys: `store.details`, `store.openingDate`, `store.stockModel`; record = the store id for all three.
 *  - allow-lists (every user-editable control, no hidden id):
 *      store.details     name, timezone, address, contactNumber, tinBranchCode            (NOT storeId)
 *      store.openingDate openingDate                                                       (NOT storeId, NOT confirmedPlan)
 *      store.stockModel  stockModel                                                        (NOT storeId)
 *  - the opening-date form wires the PLAIN-error branches only (the traded-since refusal and the invalid-date guard,
 *    which today rides `keep.openingDate`); the confirm-to-proceed branch and its keep keys are untouched (spec census).
 *  - SPEC GAP, reported not worked around: the "too long" leg for the two one-field forms (opening date, stock model)
 *    cannot be made by honest typing (a date box and two radios hold a few characters). The leg posts a hand-crafted
 *    value, which the server refuses in its guard clause before the try (an invalid date; neither stock model), so the
 *    builder must call keepTyping in those guard clauses too (the spec says so for guard clauses).
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
      seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { createHarness, fixture, LONG, sql, uid, type BaseCtx, type FormCase } from './t389-s2-common';

const { runTypedLegs } = createHarness({ h, seen });
const props = (id: string, params: Record<string, string>) => ({ params: Promise.resolve({ id }) as never, searchParams: Promise.resolve(params) });
const acts = () => import('../../src/app/admin/stores/actions');
const page = async () => (await import('../../src/app/admin/stores/[id]/page')).default as never;

interface StoreCtx extends BaseCtx {
  name: string;
}
async function storeCtx(hint: string, extra?: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<StoreCtx> {
  const f = await fixture(`adm-${hint}`);
  const name = `Stored Store ${uid(hint)}`;
  await sql`update stores set name = ${name}, timezone = 'Asia/Manila', address = 'Stored Address', contact_number = '0917-STORED', tin_branch_code = '00001', opening_date = '2026-02-01' where id = ${f.storeId}`;
  await extra?.(f);
  return { f, record: f.storeId, name };
}
const storeSiblings = (ctx: StoreCtx, except: 'details' | 'openingDate' | 'stockModel') =>
  [
    { k: 'details', label: 'Details form', sel: { action: 'updateStoreAction', hidden: { storeId: ctx.record } }, has: [`name="storeId" value="${ctx.record}"`, 'name="tinBranchCode"'] },
    { k: 'openingDate', label: 'Opening date form', sel: { action: 'setStoreOpeningDateAction', hidden: { storeId: ctx.record } }, has: [`name="storeId" value="${ctx.record}"`, 'name="openingDate"'] },
    { k: 'stockModel', label: 'Stock model form', sel: { action: 'setStoreStockModelAction', hidden: { storeId: ctx.record } }, has: [`name="storeId" value="${ctx.record}"`, 'name="stockModel"'] },
  ]
    .filter((s) => s.k !== except)
    .map(({ k: _k, ...s }) => s);

const details: FormCase<StoreCtx> = {
  label: 'admin store details',
  form: 'store.details',
  setup: (hint) => storeCtx(hint),
  action: async () => (await acts()).updateStoreAction,
  page,
  props: (ctx, params) => props(ctx.record, params),
  sel: (ctx) => ({ action: 'updateStoreAction', hidden: { storeId: ctx.record } }),
  has: (ctx) => [`name="storeId" value="${ctx.record}"`, 'name="tinBranchCode"'],
  hiddenNames: ['storeId'],
  refused: (ctx, over = {}) => {
    const base: Record<string, string> = {
      storeId: ctx.record,
      name: 'Typed Store Name',
      timezone: 'Asia/Tokyo',
      address: 'Typed Address',
      contactNumber: '0999-TYPED',
      tinBranchCode: '1',
    };
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /branch code/i,
  fields: () => ({ name: 'Typed Store Name', timezone: 'Asia/Tokyo', address: 'Typed Address', contactNumber: '0999-TYPED', tinBranchCode: '1' }),
  changed: { list: 'name,tinBranchCode,address', fields: () => ({ name: 'Typed Store Name', tinBranchCode: '1', address: 'Typed Address' }) },
  notDrawn: ['Typed Store Name', 'Typed Address', '0999-TYPED'],
  stored: (ctx, seg, m) => {
    expect(m.inputValue(seg, 'name')).toBe(ctx.name);
    expect(m.inputValue(seg, 'timezone')).toBe('Asia/Manila');
    expect(m.textareaValue(seg, 'address')).toBe('Stored Address');
    expect(m.inputValue(seg, 'contactNumber')).toBe('0917-STORED');
    expect(m.inputValue(seg, 'tinBranchCode')).toBe('00001');
  },
  tooLong: { address: LONG },
  good: (ctx) => details.refused(ctx, { tinBranchCode: '00002', name: 'Renamed Store' }),
  ok: /Store updated/,
  siblings: async (ctx) => storeSiblings(ctx, 'details'),
};

const openingDate: FormCase<StoreCtx> = {
  label: 'admin store opening date',
  form: 'store.openingDate',
  // a store that traded from 2026-03-03: its opening date may not move past that day
  setup: (hint) =>
    storeCtx(hint, async (f) => {
      await sql`
        insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
        values (${f.orgId}, ${f.storeId}, '2026-03-03', 'open', '1.00', '1.00', '0.00', ${f.admin.personId})`;
    }),
  action: async () => (await acts()).setStoreOpeningDateAction,
  page,
  props: (ctx, params) => props(ctx.record, params),
  sel: (ctx) => ({ action: 'setStoreOpeningDateAction', hidden: { storeId: ctx.record } }),
  has: (ctx) => [`name="storeId" value="${ctx.record}"`, 'name="openingDate"'],
  hiddenNames: ['storeId', 'confirmedPlan'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ storeId: ctx.record, openingDate: '2026-04-01', ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /traded since 2026-03-03/,
  fields: () => ({ openingDate: '2026-04-01' }),
  changed: { list: 'openingDate', fields: () => ({ openingDate: '2026-04-01' }) },
  notDrawn: ['2026-04-01'],
  stored: (_ctx, seg, m) => expect(m.inputValue(seg, 'openingDate')).toBe('2026-02-01'),
  tooLong: { openingDate: LONG },
  good: (ctx) => openingDate.refused(ctx, { openingDate: '2026-03-01' }),
  ok: /Opening date set to 2026-03-01/,
  siblings: async (ctx) => storeSiblings(ctx, 'openingDate'),
  note: 'plain-error branch only; the confirm branch keeps its keep keys',
};

const stockModel: FormCase<StoreCtx> = {
  label: 'admin store stock model',
  form: 'store.stockModel',
  // a multi-room store with two active, non-Receiving rooms: narrowing it to one room is refused
  setup: (hint) =>
    storeCtx(hint, async (f) => {
      await sql`update stores set stock_model = 'multi_room' where id = ${f.storeId}`;
      const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, ${uid('LT')}, 'Stockroom') returning id`;
      for (const code of ['ROOM-A', 'ROOM-B']) {
        await sql`insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${f.orgId}, ${f.storeId}, ${code}, ${code}, ${lt!.id}, ${f.admin.personId})`;
      }
    }),
  action: async () => (await acts()).setStoreStockModelAction,
  page,
  props: (ctx, params) => props(ctx.record, params),
  sel: (ctx) => ({ action: 'setStoreStockModelAction', hidden: { storeId: ctx.record } }),
  has: (ctx) => [`name="storeId" value="${ctx.record}"`, 'name="stockModel"'],
  hiddenNames: ['storeId'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ storeId: ctx.record, stockModel: 'single_room', ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /cannot become single-room/,
  fields: () => ({ stockModel: 'single_room' }),
  changed: { list: 'stockModel', fields: () => ({ stockModel: 'single_room' }) },
  notDrawn: [],
  stored: (_ctx, seg, m) => {
    expect(m.checked(seg, 'stockModel', 'multi_room'), 'the stored model is ticked').toBe(true);
    expect(m.checked(seg, 'stockModel', 'single_room'), 'the typed model is never ticked by the server').toBe(false);
  },
  tooLong: { stockModel: LONG },
  good: (ctx) => stockModel.refused(ctx, { stockModel: 'multi_room' }),
  ok: /several stockrooms/,
  siblings: async (ctx) => storeSiblings(ctx, 'stockModel'),
  note: 'guard-clause refusal for the too-long leg',
};

runTypedLegs(details);
runTypedLegs(openingDate);
// Audit leg set: the INVALID-DATE refusal (guard clause before the try), not the traded-since one.
const openingDateInvalid: FormCase<StoreCtx> = {
  ...openingDate,
  label: 'admin store opening date (invalid date)',
  refused: (ctx, over = {}) => openingDate.refused(ctx, { openingDate: '2026-02-30', ...over }),
  refusal: /is not a valid date/,
  fields: () => ({ openingDate: '2026-02-30' }),
  changed: { list: 'openingDate', fields: () => ({ openingDate: '2026-02-30' }) },
  notDrawn: ['2026-02-30'],
  note: 'invalid-date guard clause',
};
runTypedLegs(openingDateInvalid);
runTypedLegs(stockModel);

describe('T-389 S2 admin store - census', () => {
  it('the page holds exactly the three saved-record forms this file drives', async () => {
    const ctx = await storeCtx('census');
    h.actor = ctx.f.admin;
    seen.records = [];
    const { renderToStaticMarkup } = await import('react-dom/server');
    const Page = (await page()) as unknown as (p: unknown) => Promise<unknown>;
    renderToStaticMarkup((await Page(props(ctx.record, {}))) as never);
    const names = (seen.records as Array<{ action?: { name?: string } }>).map((r) => r.action?.name).sort();
    expect(names).toEqual(['setStoreOpeningDateAction', 'setStoreStockModelAction', 'updateStoreAction']);
  });
});
