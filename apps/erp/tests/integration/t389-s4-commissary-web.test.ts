import { expect, vi } from 'vitest';

/**
 * T-389 S4 (TESTER) - commissary/orders/[id]: the two per-line forms keep what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md; bible row 300. Legs and harness: t389-s4-common.ts.
 *
 * The page draws one EditableRecord PER LINE, each with its own hidden orderId + lineId, so this is not a "multi-line form"
 * in the invoice-lines sense (one form, `line1..5_*`): every line is its own record and the line id is the record id. No design
 * decision is needed (siblings are the other lines).
 *   page form (draft stage, branch side)    updateLineAction  record = lineId  refusal: quantity 0 ("more than zero")  commissary.lineUpdate
 *   page form (accepted stage, commissary)  fulfilLineAction  record = lineId  refusal: negative send ("negative")       commissary.lineFulfil
 * (the unpacked-line fulfil form, the Remove/Approve/Decline/Receive forms are adds or commands: out of scope.)
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - allow-lists: lineUpdate = quantity, rate; lineFulfil = quantity, rate, sourceLocationId. NOT orderId, NOT lineId.
 *  - the nav: no nav key (the order id is in the path).
 *  - the actions return `redirectWithFlash(path, {}, await perform(...))` with no catch of their own: the builder must carry the
 *    typed slot through `perform`'s Flash (or catch in the action). That is a builder detail, not tested here.
 *  - the fulfil room select keeps its STORED choice on reopen (default room); the typed room is an <option> already, so the
 *    browser (not the server) selects it.
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

import { acceptOrder, fulfilLine, saveBranchOrderDraft, submitOrder } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { actor, asOrg, createHarness, LONG, sql, uid, type BaseCtx, type FormCase } from './t389-s4-common';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const { runTypedLegs } = createHarness({ h, seen });

interface OrdCtx extends BaseCtx {
  orderId: string;
  lineA: string; // pork
  lineB: string; // sauce
  comDry: string;
}
/** One org, a commissary and a branch, two admins scoped to both, two offered and mapped items, a draft order (optionally accepted and packed). */
async function orderCtx(hint: string, stage: 'draft' | 'accepted'): Promise<OrdCtx> {
  const code = uid(`t389s4c-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-08-01', '2026-08-31', 'open')`;
  const mkStore = async (label: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid(label)}, ${`Store ${label}`}, 'multi_room') returning id`)[0]!.id;
  const com = await mkStore('com');
  const br = await mkStore('br');
  const people: ReturnType<typeof actor>[] = [];
  for (const name of ['Admin', 'Other Admin']) {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
    for (const s of [com, br]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    people.push(actor(orgId, p!.id));
  }
  const [admin, other] = people as [ReturnType<typeof actor>, ReturnType<typeof actor>];
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (storeId: string, c: string, isDefault: boolean) =>
    (await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${storeId}, ${c}, ${c}, ${lt!.id}, 'operating', ${isDefault}, ${admin.personId}) returning id`)[0]!.id;
  await mkRoom(com, 'KIT', true);
  const comDry = await mkRoom(com, 'DRY', false);
  await mkRoom(br, 'KIT', true);
  const mkItem = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgId}, ${testItemCode()}, ${name}, 'raw_material', 'kg', ${admin.personId}) returning id`)[0]!.id;
  const pork = await mkItem('Pork belly');
  const porkBr = await mkItem('Pork belly (branch)');
  const sauce = await mkItem('Bulgogi sauce');
  const sauceBr = await mkItem('Bulgogi sauce (branch)');
  await sql`insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by) values (${orgId}, ${com}, ${br}, ${admin.personId})`;
  for (const [item, cost] of [[pork, '310.0000'], [sauce, '95.0000']] as const) {
    await sql`insert into commissary_item_offerings (org_id, commissary_store_id, item_id, manual_cost, created_by) values (${orgId}, ${com}, ${item}, ${cost}, ${admin.personId})`;
  }
  await sql`
    insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
    values (${orgId}, ${`Store br (internal) ${code}`}, 'internal', ${br}, ${admin.personId})`;
  const [cogs] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and "group" = 'COGS' order by category limit 1`;
  for (const [from, to] of [[pork, porkBr], [sauce, sauceBr]] as const) {
    await sql`
      insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, is_ledger_only, expense_category_id, created_by)
      values (${orgId}, ${com}, ${br}, ${from}, ${to}, false, ${cogs!.id}, ${admin.personId})`;
  }
  const { orderId } = await asOrg(orgId, (tx) =>
    saveBranchOrderDraft(tx, admin, {
      branchStoreId: br, commissaryStoreId: com, orderDate: '2026-08-20',
      lines: [{ itemId: pork, quantity: '20' }, { itemId: sauce, quantity: '4' }],
    }),
  );
  const lineOf = async (itemId: string) =>
    (await sql<{ id: string }[]>`select id from trade_order_lines where order_id = ${orderId} and item_id = ${itemId}`)[0]!.id;
  const lineA = await lineOf(pork);
  const lineB = await lineOf(sauce);
  if (stage === 'accepted') {
    await asOrg(orgId, (tx) => submitOrder(tx, admin, { orderId }));
    await asOrg(orgId, (tx) => acceptOrder(tx, admin, { orderId }));
    // Packed once each, so the page draws the SAVED-record form (an unpacked line is an add form).
    await asOrg(orgId, (tx) => fulfilLine(tx, admin, { orderId, lineId: lineA, quantity: '5' }));
    await asOrg(orgId, (tx) => fulfilLine(tx, admin, { orderId, lineId: lineB, quantity: '2' }));
  }
  const f = { orgId, storeId: com, admin, other };
  return { f, record: lineA, orderId, lineA, lineB, comDry };
}

const page = async () => (await import('../../src/app/commissary/orders/[id]/page')).default as never;
const props = (ctx: OrdCtx, params: Record<string, string>) => ({ params: Promise.resolve({ id: ctx.orderId }) as never, searchParams: Promise.resolve(params) });
const actions = () => import('../../src/app/commissary/orders/[id]/actions');
const fdOf = (base: Record<string, string>, over: Record<string, string | string[] | null> = {}): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v as string);
  return fd;
};

const lineUpdate: FormCase<OrdCtx> = {
  label: 'commissary order line (the ask)',
  form: 'commissary.lineUpdate',
  setup: (hint) => orderCtx(hint, 'draft'),
  action: async () => (await actions()).updateLineAction,
  page,
  props,
  sel: (ctx) => ({ action: 'updateLineAction', hidden: { lineId: ctx.lineA } }),
  has: (ctx) => [`name="lineId" value="${ctx.lineA}"`, 'name="quantity"'],
  hiddenNames: ['orderId', 'lineId'],
  refused: (ctx, over = {}) => fdOf({ orderId: ctx.orderId, lineId: ctx.lineA, quantity: '0', rate: '333' }, over),
  refusal: /more than zero/i,
  fields: () => ({ quantity: '0', rate: '333' }),
  changed: { list: 'quantity', fields: () => ({ quantity: '0' }) },
  notDrawn: ['333'],
  stored: (_ctx, seg, m) => {
    expect(m.inputValue(seg, 'quantity'), 'the stored ask is drawn').toBe('20.000');
    expect(m.inputValue(seg, 'rate'), 'the stored rate is drawn').toBe('310.00');
  },
  tooLong: { rate: LONG },
  good: (ctx) => lineUpdate.refused(ctx, { quantity: '21', rate: '311' }),
  ok: /Line updated/,
  siblings: async (ctx) => [{ label: 'the other line', sel: { action: 'updateLineAction', hidden: { lineId: ctx.lineB } }, has: [`name="lineId" value="${ctx.lineB}"`, 'name="quantity"'] }],
};
runTypedLegs(lineUpdate);

const lineFulfil: FormCase<OrdCtx> = {
  label: 'commissary order line (the packing)',
  form: 'commissary.lineFulfil',
  setup: (hint) => orderCtx(hint, 'accepted'),
  action: async () => (await actions()).fulfilLineAction,
  page,
  props,
  sel: (ctx) => ({ action: 'fulfilLineAction', hidden: { lineId: ctx.lineA } }),
  has: (ctx) => [`name="lineId" value="${ctx.lineA}"`, 'name="sourceLocationId"'],
  hiddenNames: ['orderId', 'lineId'],
  refused: (ctx, over = {}) => fdOf({ orderId: ctx.orderId, lineId: ctx.lineA, quantity: '-2', rate: '333', sourceLocationId: ctx.comDry }, over),
  refusal: /negative/i,
  fields: (ctx) => ({ quantity: '-2', rate: '333', sourceLocationId: ctx.comDry }),
  changed: { list: 'quantity,sourceLocationId', fields: (ctx) => ({ quantity: '-2', sourceLocationId: ctx.comDry }) },
  notDrawn: ['333'],
  stored: (_ctx, seg, m) => {
    expect(m.inputValue(seg, 'quantity'), 'the stored packed quantity is drawn').toBe('5.000');
    expect(m.inputValue(seg, 'rate'), 'the stored rate is drawn').toBe('310.00');
    expect(m.selectedValue(seg, 'sourceLocationId'), 'the stored room (the default) is selected, never the typed one').toBe('');
  },
  tooLong: { rate: LONG },
  good: (ctx) => lineFulfil.refused(ctx, { quantity: '6', rate: '312' }),
  ok: /Fulfilment saved/,
  siblings: async (ctx) => [{ label: 'the other line', sel: { action: 'fulfilLineAction', hidden: { lineId: ctx.lineB } }, has: [`name="lineId" value="${ctx.lineB}"`, 'name="sourceLocationId"'] }],
};
runTypedLegs(lineFulfil);
