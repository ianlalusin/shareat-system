import { expect, vi } from 'vitest';

/**
 * T-389 S4 (TESTER) - inventory/locations: a room's name, type and role keep what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md; bible row 300. Legs and harness: t389-s4-common.ts.
 *
 * Form: updateLocationAction, one EditableRecord per room row (hidden storeId + id). Nav key `store` rides the redirect (the
 * action already sets it). Refusal driven: the room TYPE was removed between page load and Save ("that room type does not exist
 * for this organisation"), which the browser cannot pre-empt: the name box has no `required`, and the select held a type that
 * was real when the page was drawn.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches):
 *  - form key `location.edit`; record = the room id (hidden `id`); allow-list = name, typeId, role. NOT storeId, NOT id.
 *  - the typed type is no longer an option on the reopened page, so that select keeps its STORED choice (the spec's "no matching
 *    option: leave the stored selection" rule); the leg asserts the server never draws the typed id.
 *  - the Receiving room's edit form has no role select (page.tsx): that form is a different field set and is not driven here.
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

const { runTypedLegs } = createHarness({ h, seen });

interface LocCtx extends BaseCtx {
  storeId: string;
  room: string; // the room whose Save is refused (stored: name "Main Room", operating)
  sibling: string; // another room, same form
  typeA: string; // the stored type
  goneType: string; // a type that was removed after the page was drawn
}
async function locCtx(hint: string): Promise<LocCtx> {
  const f = await fixture(`loc-${hint}`);
  const mkType = async (code: string, name: string) =>
    (await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, ${code}, ${name}) returning id`)[0]!.id;
  await sql`update stores set stock_model = 'multi_room' where id = ${f.storeId}`;
  const typeA = await mkType('STK', 'Stockroom');
  const goneType = await mkType(uid('GONE').slice(0, 20), 'Cold Store');
  await sql`delete from location_types where id = ${goneType}`;
  const mkRoom = async (code: string, name: string, isDefault: boolean) =>
    (await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${f.orgId}, ${f.storeId}, ${code}, ${name}, ${typeA}, 'operating', ${isDefault}, ${f.admin.personId}) returning id`)[0]!.id;
  const room = await mkRoom('MAIN', 'Main Room', true);
  const sibling = await mkRoom('DRY', 'Dry Room', false);
  return { f, record: room, storeId: f.storeId, room, sibling, typeA, goneType };
}

const edit: FormCase<LocCtx> = {
  label: 'inventory locations',
  form: 'location.edit',
  setup: locCtx,
  action: async () => (await import('../../src/app/inventory/locations/actions')).updateLocationAction,
  page: async () => (await import('../../src/app/inventory/locations/page')).default as never,
  props: (ctx, params) => ({ params: Promise.resolve({}) as never, searchParams: Promise.resolve({ store: ctx.storeId, ...params }) }),
  sel: (ctx) => ({ action: 'updateLocationAction', hidden: { id: ctx.room } }),
  has: (ctx) => [`name="id" value="${ctx.room}"`, 'name="typeId"'],
  hiddenNames: ['storeId', 'id'],
  refused: (ctx, over = {}) => {
    const fd = new FormData();
    const base = { storeId: ctx.storeId, id: ctx.room, name: 'Renamed Room', typeId: ctx.goneType, role: 'storage' };
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v as string);
    return fd;
  },
  refusal: /room type does not exist/i,
  fields: (ctx) => ({ name: 'Renamed Room', typeId: ctx.goneType, role: 'storage' }),
  changed: { list: 'name,role', fields: () => ({ name: 'Renamed Room', role: 'storage' }) },
  notDrawn: (ctx) => ['Renamed Room', ctx.goneType],
  stored: (ctx, seg, m) => {
    expect(m.inputValue(seg, 'name'), 'the stored name is drawn').toBe('Main Room');
    expect(m.selectedValue(seg, 'typeId'), 'the stored type is selected').toBe(ctx.typeA);
    expect(m.selectedValue(seg, 'role'), 'the stored role is selected').toBe('operating');
  },
  tooLong: { name: LONG },
  good: (ctx) => edit.refused(ctx, { name: 'Main Room Two', typeId: ctx.typeA, role: 'operating' }),
  ok: /Room updated/,
  siblings: async (ctx) => [{ label: 'another room', sel: { action: 'updateLocationAction', hidden: { id: ctx.sibling } }, has: [`name="id" value="${ctx.sibling}"`, 'name="typeId"'] }],
};

runTypedLegs(edit);
