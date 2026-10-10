import { expect, it, vi } from 'vitest';

/**
 * T-389 S4 (TESTER) - inventory/counts/[id]: a counted line keeps what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md; bible row 300. Legs and harness: t389-s4-common.ts.
 *
 * Form: recordCountAction, one EditableRecord per sheet row that already has a counted figure (a row with none is an ADD form
 * ending in Save: out of scope, N1). Hidden sessionId + itemId + locationId; the redirect carries no nav key (the session is in
 * the path). Refusal driven: a figure the server cannot read ("1,0OO", letter O), which `inputMode="decimal"` does not stop.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form key `count.line`; allow-list = countedQuantity. NOT sessionId, itemId, locationId.
 *  - record id = the count line's OWN primary key (count_lines.id, one uuid, multi-room safe; coordinator ruling on QUESTION C). The page
 *    must pass it (SheetLine has no id today) and the action must resolve it. Sessions here are MULTI-room: the same item counted in
 *    a second room is a sibling and must stay locked. hidden ids (sessionId, itemId, locationId) are never kept.
 *  - the figure stays text as typed: "1,0OO" comes back exactly as "1,0OO" (spec R3), judged in the record's own <form>.
 *
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

import { openCountSession, recordCount } from '@shareat/domain';
import { asOrg, createHarness, fixture, LONG, sql, uid, type BaseCtx, type FormCase } from './t389-s4-common';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const { runTypedLegs } = createHarness({ h, seen });

interface CountCtx extends BaseCtx {
  sessionId: string;
  roomId: string;
  itemA: string; // counted 12.500
  itemB: string; // the sibling, counted 3.000
  lineA: string; // count_lines.id of itemA in the room whose Save is refused
  roomB: string;
  lineA2: string; // the SAME item counted in a second room (a sibling)
}
async function countCtx(hint: string): Promise<CountCtx> {
  const f = await fixture(`cnt-${hint}`);
  await sql`update stores set stock_model = 'multi_room' where id = ${f.storeId}`;
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Stockroom') returning id`;
  const [room] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${f.storeId}, 'KIT', 'Kitchen', ${lt!.id}, 'operating', true, ${f.admin.personId}) returning id`;
  const [room2] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${f.storeId}, 'DRY', 'Dry', ${lt!.id}, 'operating', false, ${f.admin.personId}) returning id`;
  const mk = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${testItemCode()}, ${name}, 'raw_material', 'kg', ${f.admin.personId}) returning id`)[0]!.id;
  const itemA = await mk('Pork Belly');
  const itemB = await mk('Chicken Thigh');
  const opened = await asOrg(f.orgId, (tx) => openCountSession(tx, f.admin, { storeId: f.storeId, locationIds: [room!.id, room2!.id], countedOn: '2026-08-20' }));
  if (!opened.ok) throw new Error(opened.reason);
  for (const [itemId, qty] of [[itemA, '12.500'], [itemB, '3.000']] as const) {
    const r = await asOrg(f.orgId, (tx) => recordCount(tx, f.admin, { sessionId: opened.sessionId, itemId, locationId: room!.id, countedQuantity: qty }));
    if (!r.ok) throw new Error(r.reason);
  }
  const r2 = await asOrg(f.orgId, (tx) => recordCount(tx, f.admin, { sessionId: opened.sessionId, itemId: itemA, locationId: room2!.id, countedQuantity: '7.000' }));
  if (!r2.ok) throw new Error(r2.reason);
  const lid = async (itemId: string, loc: string) =>
    (await sql<{ id: string }[]>`select id from count_lines where session_id = ${opened.sessionId} and item_id = ${itemId} and location_id = ${loc}`)[0]!.id;
  const lineA = await lid(itemA, room!.id);
  return { f, record: lineA, sessionId: opened.sessionId, roomId: room!.id, itemA, itemB, lineA, roomB: room2!.id, lineA2: await lid(itemA, room2!.id) };
}

const line: FormCase<CountCtx> = {
  label: 'inventory count line',
  form: 'count.line',
  setup: countCtx,
  action: async () => (await import('../../src/app/inventory/counts/actions')).recordCountAction,
  page: async () => (await import('../../src/app/inventory/counts/[id]/page')).default as never,
  props: (ctx, params) => ({ params: Promise.resolve({ id: ctx.sessionId }) as never, searchParams: Promise.resolve(params) }),
  sel: (ctx) => ({ action: 'recordCountAction', hidden: { itemId: ctx.itemA, locationId: ctx.roomId } }),
  has: (ctx) => [`name="locationId" value="${ctx.roomId}"`, `name="itemId" value="${ctx.itemA}"`, 'name="countedQuantity"'],
  hiddenNames: ['sessionId', 'itemId', 'locationId'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    const base = { sessionId: ctx.sessionId, itemId: ctx.itemA, locationId: ctx.roomId, countedQuantity: '1,0OO' };
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /is not a valid quantity/,
  fields: () => ({ countedQuantity: '1,0OO' }),
  changed: { list: 'countedQuantity', fields: () => ({ countedQuantity: '1,0OO' }) },
  notDrawn: ['1,0OO'],
  stored: (_ctx, seg, m) => expect(m.inputValue(seg, 'countedQuantity'), 'the stored count is drawn').toBe('12.500'),
  tooLong: { countedQuantity: LONG },
  good: (ctx) => line.refused(ctx, { countedQuantity: '13' }),
  ok: /Line saved/,
  siblings: async (ctx) => [{ label: 'the same item in the other room', sel: { action: 'recordCountAction', hidden: { itemId: ctx.itemA, locationId: ctx.roomB } }, has: [`name="locationId" value="${ctx.roomB}"`, `name="itemId" value="${ctx.itemA}"`, 'name="countedQuantity"'] }, { label: 'another item', sel: { action: 'recordCountAction', hidden: { itemId: ctx.itemB, locationId: ctx.roomId } }, has: [`name="itemId" value="${ctx.itemB}"`, 'name="countedQuantity"'] }],
  note: 'record = count_lines.id, multi-room',
};

runTypedLegs(line);

// ---- permission refusal: no typed slot, no count_lines id (coordinator ruling: the line lookup is skipped on an AuthorizationError) ----
it('permission refusal: with the person\'s store scope revoked a count-line save is refused in words, and NO typed slot is kept (no count_lines id in the cookie)', async () => {
  const ctx = await countCtx('perm');
  const { captureRedirect, outcomeOf, resetJar, currentJar, FLASH_COOKIE } = await import('../helpers/flash-jar');
  const { decodeFlash } = await import('../../src/lib/flash');
  h.actor = ctx.f.admin;
  resetJar();
  await sql`delete from person_store_scope where person_id = ${ctx.f.admin.personId} and store_id = ${ctx.f.storeId}`;
  const fd = new FormData();
  for (const [k, v] of Object.entries({ sessionId: ctx.sessionId, itemId: ctx.itemA, locationId: ctx.roomId, countedQuantity: '13', __changed: 'countedQuantity' })) fd.set(k, v);
  const signal = await captureRedirect(async () => (await import('../../src/app/inventory/counts/actions')).recordCountAction(fd));
  await sql`insert into person_store_scope (person_id, store_id) values (${ctx.f.admin.personId}, ${ctx.f.storeId})`;
  expect(outcomeOf(signal).flash.error, 'refused in words').toBeTruthy();
  const raw = currentJar().get(FLASH_COOKIE)!.value;
  const p = decodeFlash(raw) as { t?: unknown; td?: unknown };
  expect(p.t, 'no typed slot on a permission refusal').toBeUndefined();
  expect(p.td).toBeUndefined();
  expect(JSON.stringify(p), 'no count_lines id anywhere in the cookie').not.toContain(ctx.lineA);
});
