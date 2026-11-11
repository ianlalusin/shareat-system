import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-529 ruling 2 - `listRefillableTables(tx, actor, { storeId })`: the open dine-in tables that hold a package (the refill stand picker and the heads list).
 * Real Postgres on a scratch "_test" database (any name). Needs request_pos_refill OR confirm_pos_heads at the store, scoped to that store.
 * Also: the refill queue's `askedBy` (ruling 3), the name of the person who asked, never an id.
 */
import { addLines, listRefillableTables, listRefillQueue, openStand, requestRefill } from '../../src/pos';
import { insRule, newItem, sql } from '../../../db/tests/integration/_fixtures/t401-menu';
import { asOrg, closeAll, fixture, makeServer0240, newStand, nowIso, uuid, type Fx } from './_fixtures/t525-pos';

afterAll(closeAll);

async function table(f: Fx, o: { mode?: 'dine_in' | 'take_out'; heads?: number; item?: { itemId: string; variantId: string } } = {}) {
  const mode = o.mode ?? 'dine_in';
  const stand = mode === 'dine_in' ? await newStand(f) : null;
  const sessionId = uuid();
  const base = { storeId: f.storeId, pairingId: f.pairingId };
  const item = o.item ?? f.menu.unli;
  await asOrg(f.orgId, async (tx) => {
    await openStand(tx, f.counter, { ...base, sessionId, mode, ...(stand ? { standId: stand.id } : {}), headsCashier: mode === 'take_out' ? 0 : (o.heads ?? 2), openedAtDevice: nowIso() });
    await addLines(tx, f.counter, { ...base, sessionId, lines: [{ lineId: uuid(), menuItemId: item.itemId, variantId: item.variantId, qty: mode === 'take_out' ? 1 : (o.heads ?? 2), addedAtDevice: nowIso() }] });
  });
  return { sessionId, standNumber: stand?.number ?? null };
}
const read = (f: Fx, who: Fx['counter'], storeId = f.storeId) => asOrg(f.orgId, (tx) => listRefillableTables(tx, who, { storeId }));

describe('listRefillableTables', () => {
  it('lists the open dine-in package tables with their package and heads, by stand number; take-out and an a la carte table are left out', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const a = await table(f, { heads: 3 });
    const b = await table(f, { heads: 2 });
    await table(f, { item: f.menu.pork }); // a la carte only: no package
    await table(f, { mode: 'take_out', item: f.menu.pork });
    const out = await read(f, server);
    expect(out.tables.map((t) => t.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
    expect(out.tables.map((t) => t.standNumber)).toEqual([...out.tables.map((t) => t.standNumber)].sort((x, y) => x - y));
    expect(out.tables.find((t) => t.sessionId === a.sessionId)).toEqual({ sessionId: a.sessionId, standNumber: a.standNumber, packageVariantId: f.menu.unli.variantId, packageVariantIds: [f.menu.unli.variantId], headsCashier: 3, headsServer: null });
  });

  it('a table holding TWO package variants lists both (the first is packageVariantId), still one row for the table', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const premium = await newItem(f, 'package', 'Premium Unli');
    await insRule(f, premium.variantId);
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
              values (${f.orgId}, ${f.storeId}, ${premium.variantId}, 'store', ${null}, '599.00', ${null}, ${null}, false, ${f.personId})`;
    await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${premium.itemId}, ${f.grill}, ${f.personId})`;
    const t = await table(f, { heads: 2 });
    await asOrg(f.orgId, (tx) =>
      addLines(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: t.sessionId, lines: [{ lineId: uuid(), menuItemId: premium.itemId, variantId: premium.variantId, qty: 2, addedAtDevice: nowIso() }] }),
    );
    const out = await read(f, server);
    expect(out.tables).toHaveLength(1);
    expect(out.tables[0]!.packageVariantId).toBe(f.menu.unli.variantId);
    expect([...out.tables[0]!.packageVariantIds].sort()).toEqual([f.menu.unli.variantId, premium.variantId].sort());
  });

  it('a Cashier on everyday access (neither request_pos_refill nor confirm_pos_heads) is REFUSED with a sentence', async () => {
    const f = await fixture();
    await table(f);
    await expect(read(f, f.counter)).rejects.toMatchObject({ name: 'AuthorizationError' });
  });

  it('a person of another store is REFUSED', async () => {
    const f = await fixture();
    await table(f);
    await expect(read(f, f.managerOther)).rejects.toBeTruthy();
  });
});

describe('listRefillQueue askedBy', () => {
  it('names the person who asked for the refill (their name, not an id)', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    const t = await table(f);
    await asOrg(f.orgId, (tx) => requestRefill(tx, server, { storeId: f.storeId, pairingId: null, sessionId: t.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() }] }));
    const q = await asOrg(f.orgId, (tx) => listRefillQueue(tx, f.kitchen, { storeId: f.storeId }));
    expect(q.tickets).toHaveLength(1);
    expect(typeof q.tickets[0]!.askedBy).toBe('string');
    expect(q.tickets[0]!.askedBy).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect((q.tickets[0]!.askedBy ?? '').length).toBeGreaterThan(1);
  });
});
