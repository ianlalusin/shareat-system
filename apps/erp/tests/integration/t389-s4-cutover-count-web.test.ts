import { expect, vi } from 'vitest';

/**
 * T-389 S4 (TESTER) - cutover/count: a saved opening count keeps quantity and unit cost after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md; bible row 300; T-390 S1 (a count belongs to a room; a typed cost
 * carries costSource 'typed'). Legs and harness: t389-s4-common.ts.
 *
 * Form: recordCountAction, one EditableRecord per item that already has a count (an uncounted row is an ADD: out of scope,
 * N1). Hidden storeId + itemId; nav key `store` rides the redirect (the action already sets it). Refusal driven: a NEGATIVE
 * count ("A count cannot be negative."), which no browser attribute prevents.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form key `cutover.count`; record = the ITEM id (the page is already one store); allow-list = quantity, unitCost. NOT
 *    storeId, NOT itemId. Nothing about the room or costSource: the page has no room control and costSource is derived by the
 *    action from unitCost, so neither is a typed field.
 *  - a good save redirects with an empty flash (no banner): the good leg asserts no error, no ok, no typed slot.
 *  - T-390 S1 note: the row is keyed on the stored figures (`key={itemId:quantity:unitCost}`) so a good save reopens locked;
 *    a refusal does not change them, so the key is stable and the typed view is not lost to a remount.
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

import { createHarness, fixture, LONG, sql, uid, type BaseCtx, type FormCase } from './t389-s4-common';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const { runTypedLegs } = createHarness({ h, seen });

interface CountCtx extends BaseCtx {
  storeId: string;
  itemA: string; // stored count 5 @ 10.0000
  itemB: string; // the sibling, stored count 8 @ 20.0000
}
async function countCtx(hint: string): Promise<CountCtx> {
  const f = await fixture(`cc-${hint}`);
  await sql`update stores set stock_model = 'multi_room' where id = ${f.storeId}`;
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Stockroom') returning id`;
  const [room] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${f.storeId}, 'MAIN', 'Main', ${lt!.id}, 'operating', true, ${f.admin.personId}) returning id`;
  const mk = async (name: string, code: string, qty: string, cost: string) => {
    const id = (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${org(f)}, ${code}, ${name}, 'raw_material', 'kg', ${f.admin.personId}) returning id`)[0]!.id;
    await sql`
      insert into opening_counts (org_id, store_id, location_id, item_id, quantity, unit_cost, cost_source, counted_by)
      values (${org(f)}, ${f.storeId}, ${room!.id}, ${id}, ${qty}, ${cost}, 'typed', ${f.admin.personId})`;
    return id;
  };
  const itemA = await mk('Pork Belly', testItemCode(), '5.000', '10.0000');
  const itemB = await mk('Chicken Thigh', testItemCode(), '8.000', '20.0000');
  return { f, record: itemA, storeId: f.storeId, itemA, itemB };
}
const org = (f: { orgId: string }) => f.orgId;

const count: FormCase<CountCtx> = {
  label: 'cutover opening count',
  form: 'cutover.count',
  setup: countCtx,
  action: async () => (await import('../../src/app/cutover/actions')).recordCountAction,
  page: async () => (await import('../../src/app/cutover/count/page')).default as never,
  props: (ctx, params) => ({ params: Promise.resolve({}) as never, searchParams: Promise.resolve({ store: ctx.storeId, ...params }) }),
  sel: (ctx) => ({ action: 'recordCountAction', hidden: { itemId: ctx.itemA } }),
  has: (ctx) => [`name="itemId" value="${ctx.itemA}"`, 'name="unitCost"'],
  hiddenNames: ['storeId', 'itemId'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ storeId: ctx.storeId, itemId: ctx.itemA, quantity: '-3', unitCost: '12.5', ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /cannot be negative/i,
  fields: () => ({ quantity: '-3', unitCost: '12.5' }),
  changed: { list: 'quantity', fields: () => ({ quantity: '-3' }) },
  notDrawn: ['value="-3"', 'value="12.5"'],
  stored: (_ctx, seg, m) => {
    expect(m.inputValue(seg, 'quantity'), 'the stored quantity is drawn').toBe('5.000');
    expect(m.inputValue(seg, 'unitCost'), 'the stored cost is drawn').toBe('10.0000');
  },
  tooLong: { unitCost: LONG },
  good: (ctx) => count.refused(ctx, { quantity: '4', unitCost: '11' }),
  ok: null,
  siblings: async (ctx) => [{ label: 'another item', sel: { action: 'recordCountAction', hidden: { itemId: ctx.itemB } }, has: [`name="itemId" value="${ctx.itemB}"`, 'name="unitCost"'] }],
};

runTypedLegs(count);
