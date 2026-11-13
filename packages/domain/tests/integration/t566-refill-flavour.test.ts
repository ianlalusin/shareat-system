import { afterAll, describe, expect, it } from 'vitest';
import { RefusalError } from '@shareat/db';
import { addLines, openStand, requestRefill } from '../../src/pos';
import { asOrg, closeAll, fixture, makeServer0240, newStand, nowIso, sql, uuid, type Fx } from './_fixtures/t525-pos';
import { insOptionOffer, insRule, newItem, newOption } from '../../../db/tests/integration/_fixtures/t401-menu';

/**
 * T-566 - a refill carries ONE flavour, like v1 (audit P-007). docs/tasks/566-refill-flavour.md. A flavour is an option value on the refill item's variant;
 * "required" = its group has min_selections > 0. Real PostgreSQL.
 */
afterAll(closeAll);

const DIFFERENT = 'This change was already recorded differently on the till.';
const msg = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err).toBeInstanceOf(RefusalError);
  return (err as RefusalError).userMessage;
};

/** A package table, plus a "Pork refill" the package lists: one required single-choice group with two flavours (Bulgogi, Garlic); `other` is a value of a group the meat does not have. */
async function setup(f: Fx) {
  const refill = await newItem(f, 'refill', 'Pork refill');
  await insRule(f, refill.variantId);
  await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
            values (${f.orgId}, ${f.storeId}, ${refill.variantId}, 'store', ${null}, ${null}, ${null}, ${null}, false, ${f.personId})`;
  await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${refill.itemId}, ${f.grill}, ${f.personId})`;
  await sql`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by) values (${f.orgId}, ${f.menu.unli.variantId}, ${refill.itemId}, ${f.personId})`;
  const bulgogi = await newOption(f);
  await insOptionOffer(f, bulgogi.valueId, '0.00');
  const [garlic] = await sql<{ id: string }[]>`insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${f.orgId}, ${bulgogi.groupId}, 'Garlic', 1, 'active', ${f.personId}) returning id`;
  await insOptionOffer(f, garlic!.id, '0.00');
  const other = await newOption(f);
  await insOptionOffer(f, other.valueId, '0.00');
  await sql`update menu_option_values set name = 'Bulgogi' where id = ${bulgogi.valueId}`;
  await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, status, created_by) values (${f.orgId}, ${bulgogi.groupId}, ${refill.itemId}, 'active', ${f.personId})`;
  await new Promise((r) => setTimeout(r, 60)); // offers start at the DB clock
  const st = await newStand(f);
  const sessionId = uuid();
  const base = { storeId: f.storeId, pairingId: f.pairingId };
  await asOrg(f.orgId, async (tx) => {
    await openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: st.id, headsCashier: 2, openedAtDevice: nowIso() });
    await addLines(tx, f.counter, { ...base, sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 2, addedAtDevice: nowIso() }] });
  });
  const server = await makeServer0240(f);
  return { refill, bulgogi: bulgogi.valueId, garlic: garlic!.id, other: other.valueId, sessionId, server };
}

type R = { lineId: string; menuItemId: string; qty: number; addedAtDevice: string; optionValueIds?: string[] };
const ask = (f: Fx, s: { sessionId: string; server: Fx['counter'] }, lines: R[]) =>
  asOrg(f.orgId, (tx) => requestRefill(tx, s.server, { storeId: f.storeId, pairingId: null, sessionId: s.sessionId, lines }));
const row = (itemId: string, o: Partial<R> = {}): R => ({ lineId: uuid(), menuItemId: itemId, qty: 1, addedAtDevice: nowIso(), ...o });
const refillRows = (sessionId: string) =>
  sql<{ name: string; ids: string[] | null; price: string }[]>`select name, option_value_ids as ids, unit_price::text price from table_session_lines where session_id = ${sessionId} and kind = 'refill' order by name`;

describe('T-566 - a refill carries one flavour', () => {
  it('a meat with a required flavour and none chosen is refused, nothing written', async () => {
    const f = await fixture();
    const x = await setup(f);
    expect(await msg(ask(f, x, [row(x.refill.itemId)]))).toBe('Choose a flavour for Pork refill.');
    expect(await refillRows(x.sessionId)).toHaveLength(0);
  });

  it('two flavours on one line are refused', async () => {
    const f = await fixture();
    const x = await setup(f);
    expect(await msg(ask(f, x, [row(x.refill.itemId, { optionValueIds: [x.bulgogi, x.garlic] })]))).toBe('Choose one flavour for Pork refill.');
    expect(await msg(ask(f, x, [row(x.refill.itemId, { optionValueIds: [x.bulgogi, x.other] })]))).toBe('Choose one flavour for Pork refill.');
    expect(await refillRows(x.sessionId)).toHaveLength(0);
  });

  it('a flavour that is not on the meat is refused with the v1 sentence', async () => {
    const f = await fixture();
    const x = await setup(f);
    expect(await msg(ask(f, x, [row(x.refill.itemId, { optionValueIds: [x.other] })]))).toBe('That flavour is not available for Pork refill.');
    expect(await msg(ask(f, x, [row(x.refill.itemId, { optionValueIds: [uuid()] })]))).toBe('That flavour is not available for Pork refill.');
    expect(await refillRows(x.sessionId)).toHaveLength(0);
  });

  it('a disabled (withdrawn) flavour is refused', async () => {
    const f = await fixture();
    const x = await setup(f);
    await sql`insert into menu_option_offers (org_id, store_id, option_value_id, channel, price_delta, withdrawn, created_by) values (${f.orgId}, ${f.storeId}, ${x.garlic}, 'store', ${null}, true, ${f.personId})`;
    await new Promise((r) => setTimeout(r, 60));
    expect(await msg(ask(f, x, [row(x.refill.itemId, { optionValueIds: [x.garlic] })]))).toBe('That flavour is not available for Pork refill.');
  });

  it('the same meat twice in one request is refused, nothing written', async () => {
    const f = await fixture();
    const x = await setup(f);
    expect(await msg(ask(f, x, [row(x.refill.itemId, { optionValueIds: [x.bulgogi] }), row(x.refill.itemId, { optionValueIds: [x.garlic] })]))).toBe('Each meat can be in a refill request only once.');
    expect(await refillRows(x.sessionId)).toHaveLength(0);
  });

  it('one valid flavour is stored as an option id, shown in the name, and the refill stays free', async () => {
    const f = await fixture();
    const x = await setup(f);
    expect(await ask(f, x, [row(x.refill.itemId, { optionValueIds: [x.bulgogi] })])).toEqual({ wrote: true });
    expect(await refillRows(x.sessionId)).toEqual([{ name: 'Pork refill + Bulgogi', ids: [x.bulgogi], price: '0.00' }]);
  });

  it('replay: the same flavour is acknowledged, a different or missing one is refused', async () => {
    const f = await fixture();
    const x = await setup(f);
    const l = row(x.refill.itemId, { optionValueIds: [x.bulgogi] });
    expect(await ask(f, x, [l])).toEqual({ wrote: true });
    expect(await ask(f, x, [{ ...l }])).toEqual({ wrote: false });
    expect(await msg(ask(f, x, [{ ...l, optionValueIds: [x.garlic] }]))).toBe(DIFFERENT);
    expect(await msg(ask(f, x, [{ ...l, optionValueIds: undefined }]))).toBe(DIFFERENT);
    // a replay mixed with a new meat: the replayed line is checked too
    expect(await msg(ask(f, x, [{ ...l, optionValueIds: [x.garlic] }, row(f.menu.refillRice.itemId)]))).toBe(DIFFERENT);
  });

  it('a meat with no flavours works with none, and a flavour on it is refused', async () => {
    const f = await fixture();
    const x = await setup(f);
    expect(await ask(f, x, [row(f.menu.refillRice.itemId)])).toEqual({ wrote: true });
    expect(await refillRows(x.sessionId)).toEqual([{ name: 'Rice refill', ids: [], price: '0.00' }]);
    expect(await msg(ask(f, x, [row(f.menu.refillRice.itemId, { optionValueIds: [x.bulgogi] })]))).toBe('That flavour is not available for Rice refill.');
  });
});
