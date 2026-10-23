import { expect, vi } from 'vitest';

/**
 * T-389 S4 (TESTER) - inventory/low-stock: a saved threshold keeps what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md; bible row 300. Legs and harness: t389-s4-common.ts.
 *
 * Form: setThresholdAction, one EditableRecord per item that already has a threshold (an item with none is an add form: out of
 * scope, N1). Hidden storeId + itemId; nav key `store` rides the redirect (the action already sets it). Refusal driven: a
 * figure the server cannot read ("abc"), which `inputMode="decimal"` does not stop (it only picks the phone keypad).
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form key `lowStock.threshold`; record = the ITEM id (the page is already one store, so the item is unique on it);
 *    allow-list = threshold. NOT storeId, NOT itemId.
 *  - a good save RETURNS (revalidatePath, no redirect, no banner): the good leg only asserts no typed slot is written and
 *    that the action still returns; the refusal branch must stay the only place that redirects and keeps typing.
 *  - the page prints the error banner from `sp.error` only (no `ok`): unchanged.
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

interface LowCtx extends BaseCtx {
  storeId: string;
  itemA: string; // stored threshold 5.000
  itemB: string; // the sibling, stored threshold 9.000
}
async function lowCtx(hint: string): Promise<LowCtx> {
  const f = await fixture(`low-${hint}`);
  const mk = async (name: string, code: string, threshold: string) => {
    const id = (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${code}, ${name}, 'raw_material', 'kg', ${f.admin.personId}) returning id`)[0]!.id;
    await sql`insert into store_item_thresholds (org_id, store_id, item_id, low_stock_threshold, set_by) values (${f.orgId}, ${f.storeId}, ${id}, ${threshold}, ${f.admin.personId})`;
    return id;
  };
  const itemA = await mk('Pork Belly', testItemCode(), '5.000');
  const itemB = await mk('Chicken Thigh', testItemCode(), '9.000');
  return { f, record: itemA, storeId: f.storeId, itemA, itemB };
}

const threshold: FormCase<LowCtx> = {
  label: 'inventory low-stock',
  form: 'lowStock.threshold',
  setup: lowCtx,
  action: async () => (await import('../../src/app/inventory/low-stock/actions')).setThresholdAction,
  page: async () => (await import('../../src/app/inventory/low-stock/page')).default as never,
  props: (ctx, params) => ({ params: Promise.resolve({}) as never, searchParams: Promise.resolve({ store: ctx.storeId, ...params }) }),
  sel: (ctx) => ({ action: 'setThresholdAction', hidden: { itemId: ctx.itemA } }),
  has: (ctx) => [`name="itemId" value="${ctx.itemA}"`, 'name="threshold"'],
  hiddenNames: ['storeId', 'itemId'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ storeId: ctx.storeId, itemId: ctx.itemA, threshold: 'xyz', ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /Low-stock threshold/i,
  fields: () => ({ threshold: 'xyz' }),
  changed: { list: 'threshold', fields: () => ({ threshold: 'xyz' }) },
  notDrawn: ['xyz'],
  stored: (_ctx, seg, m) => expect(m.inputValue(seg, 'threshold'), 'the stored threshold is drawn').toBe('5.000'),
  tooLong: { threshold: LONG },
  good: (ctx) => threshold.refused(ctx, { threshold: '7' }),
  ok: null,
  goodReturns: true,
  siblings: async (ctx) => [{ label: 'another item', sel: { action: 'setThresholdAction', hidden: { itemId: ctx.itemB } }, has: [`name="itemId" value="${ctx.itemB}"`, 'name="threshold"'] }],
};

runTypedLegs(threshold);
