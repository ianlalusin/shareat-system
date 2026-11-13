import { afterAll, describe, expect, it } from 'vitest';
import { RefusalError } from '@shareat/db';
import { addLines, completeSale, openStand } from '../../src/pos';
import { asOrg, closeAll, fixture, newStand, nowIso, RATES, salePayload, sql, uuid, type Fx } from './_fixtures/t525-pos';
import { insOptionOffer, insRule, newItem, newOption } from '../../../db/tests/integration/_fixtures/t401-menu';

/**
 * T-557 - the chosen option ids are stored on the session line and copied to the receipt line, and a replay (T-556 sameChoices) compares the id sets.
 * docs/tasks/557-store-option-ids-on-lines.md. NULL = a line written before migration 0249 (names only); {} = no options chosen. Real PostgreSQL.
 */
afterAll(closeAll);

const DIFFERENT = 'This change was already recorded differently on the till.';
const base = (f: Fx) => ({ storeId: f.storeId, pairingId: f.pairingId });

async function expectDifferent(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success (the replay was acknowledged)').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toBe(DIFFERENT);
}

/** Two single-choice option groups on pork (one value each) and on a Family Pack (up to 4 heads, 100.00 per extra head). */
async function menuWithOptions(f: Fx) {
  const a = await newOption(f);
  await insOptionOffer(f, a.valueId, '30.00');
  const c = await newOption(f);
  await insOptionOffer(f, c.valueId, '10.00');
  await sql`update menu_option_groups set min_selections = 0 where id in (${a.groupId}, ${c.groupId})`; // T-552: newOption makes a REQUIRED group; these lines are added with and without a choice
  const family = await newItem(f, 'package', 'Family Pack');
  await insRule(f, family.variantId);
  await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
            values (${f.orgId}, ${f.storeId}, ${family.variantId}, 'store', ${null}, '1000.00', 4, '100.00', false, ${f.personId})`;
  await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${family.itemId}, ${f.grill}, ${f.personId})`;
  for (const g of [a.groupId, c.groupId]) {
    for (const item of [f.menu.pork.itemId, family.itemId]) {
      await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, status, created_by) values (${f.orgId}, ${g}, ${item}, 'active', ${f.personId})`;
    }
  }
  await new Promise((r) => setTimeout(r, 60)); // offers start at the DB's now(); a device time taken in the same instant can land before them ('option not on the item')
  return { optA: a.valueId, optC: c.valueId, family };
}

type L = { lineId: string; menuItemId: string; variantId?: string; qty: number; addedAtDevice: string; optionValueIds?: string[] };
const lines = (f: Fx, sessionId: string, ls: L[]) => asOrg(f.orgId, (tx) => addLines(tx, f.counter, { ...base(f), sessionId, lines: ls }));
const pork = (f: Fx, o: Partial<L> = {}): L => ({ lineId: uuid(), menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 1, addedAtDevice: nowIso(), ...o });
const stored = async (lineId: string) => (await sql<{ ids: string[] | null }[]>`select option_value_ids as ids from table_session_lines where id = ${lineId}`)[0]!.ids;
async function dineIn(f: Fx, heads: number) {
  const st = await newStand(f);
  const sessionId = uuid();
  await asOrg(f.orgId, (tx) => openStand(tx, f.counter, { ...base(f), sessionId, mode: 'dine_in', standId: st.id, headsCashier: heads, openedAtDevice: nowIso() }));
  return sessionId;
}

describe('T-557 - option ids on the session line and the receipt line', () => {
  it('a line with two options stores the SORTED ids; a line with none stores {}', async () => {
    const f = await fixture();
    const x = await menuWithOptions(f);
    const sessionId = await dineIn(f, 2);
    const withBoth = pork(f, { optionValueIds: [x.optA, x.optC] });
    const plain = pork(f);
    await lines(f, sessionId, [withBoth, plain]);
    expect(await stored(withBoth.lineId)).toEqual([x.optA, x.optC].sort());
    expect(await stored(plain.lineId)).toEqual([]);
  });

  it('the ids are copied onto the receipt line when the session is paid', async () => {
    const f = await fixture();
    const x = await menuWithOptions(f);
    const sessionId = await dineIn(f, 1);
    const l = pork(f, { optionValueIds: [x.optC, x.optA] });
    await lines(f, sessionId, [l]);
    const gross = Number((await sql<{ p: string }[]>`select unit_price::text p from table_session_lines where id = ${l.lineId}`)[0]!.p).toFixed(2);
    const payload = salePayload(f, { sessionId, porkLineId: l.lineId, qty: 1 });
    const input = { ...base(f), ...payload, device: { subtotal: gross, discountTotal: '0.00', total: gross, lines: [{ lineId: l.lineId, gross, discountTotal: '0.00', net: gross }] }, payments: [{ tenderId: f.cash, amount: gross, toCheck: false }] };
    expect(await asOrg(f.orgId, (tx) => completeSale(tx, f.counter, input as Parameters<typeof completeSale>[2], RATES))).toMatchObject({ wrote: true });
    const rows = await sql<{ ids: string[] | null }[]>`select option_value_ids as ids from pos_sales_receipt_lines where session_line_id = ${l.lineId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ids).toEqual([x.optA, x.optC].sort());
  });

  it('a bundle line and its derived extra-heads line carry the same ids', async () => {
    const f = await fixture();
    const x = await menuWithOptions(f);
    const sessionId = await dineIn(f, 6);
    const l: L = { lineId: uuid(), menuItemId: x.family.itemId, variantId: x.family.variantId, qty: 6, addedAtDevice: nowIso(), optionValueIds: [x.optC, x.optA] };
    await lines(f, sessionId, [l]);
    const rows = await sql<{ ids: string[] | null }[]>`select option_value_ids as ids from table_session_lines where session_id = ${sessionId}`;
    expect(rows, 'bundle line + extra-heads line').toHaveLength(2);
    for (const r of rows) expect(r.ids).toEqual([x.optA, x.optC].sort());
  });

  it('replay with the same ids in a different ORDER is a no-op (and a duplicated id is the same set)', async () => {
    const f = await fixture();
    const x = await menuWithOptions(f);
    const sessionId = await dineIn(f, 2);
    const l = pork(f, { optionValueIds: [x.optA, x.optC] });
    expect(await lines(f, sessionId, [l])).toEqual({ wrote: true });
    expect(await lines(f, sessionId, [{ ...l, optionValueIds: [x.optC, x.optA] }])).toEqual({ wrote: false });
    expect(await lines(f, sessionId, [{ ...l, optionValueIds: [x.optC, x.optA, x.optC] }])).toEqual({ wrote: false });
  });

  it('an option renamed between the order and the replay does not break an identical replay', async () => {
    const f = await fixture();
    const x = await menuWithOptions(f);
    const sessionId = await dineIn(f, 2);
    const l = pork(f, { optionValueIds: [x.optA] });
    await lines(f, sessionId, [l]);
    await sql`update menu_option_values set name = 'Renamed value' where id = ${x.optA}`;
    expect(await lines(f, sessionId, [{ ...l }])).toEqual({ wrote: false });
  });

  it('other option ids (other option, none instead of one, one instead of none, a subset) are refused', async () => {
    const f = await fixture();
    const x = await menuWithOptions(f);
    const sessionId = await dineIn(f, 2);
    const withA = pork(f, { optionValueIds: [x.optA] });
    const plain = pork(f);
    const both = pork(f, { optionValueIds: [x.optA, x.optC] });
    await lines(f, sessionId, [withA, plain, both]);
    await expectDifferent(lines(f, sessionId, [{ ...withA, optionValueIds: [x.optC] }]));
    await expectDifferent(lines(f, sessionId, [{ ...withA, optionValueIds: [] }]));
    await expectDifferent(lines(f, sessionId, [{ ...plain, optionValueIds: [x.optA] }]));
    await expectDifferent(lines(f, sessionId, [{ ...both, optionValueIds: [x.optA] }]));
    expect(await lines(f, sessionId, [{ ...withA }, { ...plain }, { ...both }])).toEqual({ wrote: false });
  });

  it('a legacy line (option_value_ids NULL) still replays by the name path: identical is a no-op, different is refused', async () => {
    const f = await fixture();
    const x = await menuWithOptions(f);
    const sessionId = await dineIn(f, 2);
    const withA = pork(f, { optionValueIds: [x.optA] });
    const plain = pork(f);
    await lines(f, sessionId, [withA, plain]);
    // the line guard freezes written lines (even for the owner), so a pre-0249 line is a copy inserted with the column left NULL
    const legacy = async (from: L): Promise<L> => {
      const id = uuid();
      await sql`insert into table_session_lines (id, org_id, store_id, session_id, kind, menu_item_id, menu_item_variant_id, name, qty, unit_price, kitchen_station_id, note, added_by, added_on_pairing_id, added_at_device)
                select ${id}, org_id, store_id, session_id, kind, menu_item_id, menu_item_variant_id, name, qty, unit_price, kitchen_station_id, note, added_by, added_on_pairing_id, added_at_device
                from table_session_lines where id = ${from.lineId}`;
      expect(await stored(id)).toBeNull();
      return { ...from, lineId: id };
    };
    const oldA = await legacy(withA);
    const oldPlain = await legacy(plain);
    expect(await lines(f, sessionId, [{ ...oldA }, { ...oldPlain }])).toEqual({ wrote: false });
    await expectDifferent(lines(f, sessionId, [{ ...oldA, optionValueIds: [x.optC] }]));
    await expectDifferent(lines(f, sessionId, [{ ...oldA, optionValueIds: [] }]));
    await expectDifferent(lines(f, sessionId, [{ ...oldPlain, optionValueIds: [x.optA] }]));
  });
});
