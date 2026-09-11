import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { money } from '@shareat/core/money';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { commitCountSession } from '../../src/stock/count-sessions';
import { postUsageRecord } from '../../src/stock/usage';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';

/**
 * T-169 — the freeze, the count, and the variance that finally posts.
 *
 * ⭐ **v1 posts no GL entry for a count at all** — `stock-count.actions.ts` says *"NO GL, v1"* in
 * its own words, so a fleet-wide shrinkage moved stock and touched the books nowhere. Every
 * posting case here is a gap being closed rather than a shape being ported.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, storeA: string, personA: string, fileA: string;
let kitchen: string, stockroom: string, itemA: string;

const locations = (): LocationLike[] => [
  { id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
  { id: stockroom, role: 'storage', purpose: 'normal', isDefault: false, status: 'active' },
];

async function onHand(loc = kitchen): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemA} and location_id = ${loc}`;
  return r!.t;
}

async function balances(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgA} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

/** 10 kg at ₱100 into the kitchen. */
async function stockUp(qty = '10', cost = '100.0000') {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgA},${storeA},'purchase','2026-08-01',${fileA},${personA}) returning id`;
  await withOrgPrincipal(orgA, (tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: locations(), receivedBy: personA,
      lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId: kitchen }],
    }),
  );
}

async function openSession(locationId = kitchen, status = 'open'): Promise<string> {
  const [s] = await sql<{ id: string }[]>`
    insert into count_sessions (org_id, store_id, status, counted_on, opened_by)
    values (${orgA},${storeA},${status},'2026-08-20',${personA}) returning id`;
  await sql`insert into count_session_locations (session_id, location_id) values (${s!.id}, ${locationId})`;
  return s!.id;
}

beforeEach(async () => {
  await sql`
    truncate table count_lines, count_session_locations, count_sessions,
      stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
      stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  personA = p!.id;
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [r2] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${personA}) returning id`;
  const [r3] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgA},${storeA},'STORE','Stockroom',${t!.id},${personA}) returning id`;
  kitchen = r2!.id; stockroom = r3!.id;
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'PORK','Pork','raw_material','kg',${personA}) returning id`;
  itemA = i!.id;
  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${personA}) returning id`;
  fileA = f!.id;
  await seedChartOfAccounts(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgA},'2026-08-01','2026-08-31','open')`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-169 — ⭐ the freeze, enforced once for every writer', () => {
  it('a frozen location refuses a USAGE post', async () => {
    await stockUp();
    await openSession(kitchen);
    await expect(
      withOrgPrincipal(orgA, (tx) =>
        postUsageRecord(tx, {
          orgId: orgA, storeId: storeA, locationId: kitchen, recordId: crypto.randomUUID(),
          kind: 'usage', usedOn: '2026-08-20', postedBy: personA,
          lines: [{ lineId: '1', itemId: itemA, cogsCategory: 'meat', inventoryAccount: '1310', quantity: quantity('2') }],
        }),
      ),
    ).rejects.toThrow(/frozen/);
    expect(await onHand()).toBe('10.000');
  });

  it('⭐ and it refuses a RECEIPT too — one trigger covers writers that did not exist when it was written', async () => {
    // v1 wires this check into five separate paths, and §16.7 defect 6 is the record of what
    // happens when one is missed. Here it lives on stock_movements, so every writer inherits it.
    await openSession(kitchen);
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgA},${storeA},'purchase','2026-08-20',${fileA},${personA}) returning id`;
    await expect(
      withOrgPrincipal(orgA, (tx) =>
        receiveDelivery(tx, {
          orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: '2026-08-20',
          locations: locations(), receivedBy: personA,
          lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('5'), conversionFactor: '1', unitCost: '100.0000', locationId: kitchen }],
        }),
      ),
    ).rejects.toThrow(/frozen/);
  });

  it('an UNfrozen location in the same store is unaffected', async () => {
    await openSession(stockroom);
    await expect(stockUp()).resolves.toBeUndefined();
  });

  it('closing the session releases the freeze', async () => {
    await stockUp();
    const id = await openSession(kitchen);
    await sql`update count_sessions set status='closed', closed_at=now(), closed_by=${personA} where id=${id}`;
    await expect(stockUp('1')).resolves.toBeUndefined();
  });

  it('cancelling releases it too, and posts nothing', async () => {
    const id = await openSession(kitchen);
    await sql`update count_sessions set status='cancelled', closed_at=now(), closed_by=${personA} where id=${id}`;
    await expect(stockUp()).resolves.toBeUndefined();
    expect(await balances()).not.toHaveProperty('5400');
  });

  it('⭐ the admin bypass is a session GUC, set only after authorize()', async () => {
    await stockUp();
    await openSession(kitchen);
    // ⚠️ A trigger cannot know who the caller is; the connection can — the same shape RLS uses
    // for app.org_id.
    await sql.begin(async (tx) => {
      await tx`select set_config('app.bypass_count_freeze', 'on', true)`;
      await tx`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
               values (${orgA},${storeA},${kitchen},${itemA},now(),1,'manual_adjustment','admin',${crypto.randomUUID()},${personA})`;
    });
    // Assert the EFFECT, not that the promise resolved — `sql.begin` returns whatever the callback
    // returns, so a callback returning nothing makes `toBeTruthy()` a test of nothing.
    expect(await onHand()).toBe('11.000');
  });

  it('⚠️ and the bypass does NOT leak past its transaction', async () => {
    // `set_config(..., true)` is transaction-local. If it were session-local, one admin action
    // would silently unfreeze every later write on that pooled connection — the same class of bug
    // as DEF-077, where a GUC outlived the request that set it.
    await stockUp();
    await openSession(kitchen);
    await sql.begin(async (tx) => {
      await tx`select set_config('app.bypass_count_freeze', 'on', true)`;
      await tx`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
               values (${orgA},${storeA},${kitchen},${itemA},now(),1,'manual_adjustment','admin',${crypto.randomUUID()},${personA})`;
    });
    await expect(
      sql`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
          values (${orgA},${storeA},${kitchen},${itemA},now(),1,'manual_adjustment','after',${crypto.randomUUID()},${personA})`,
    ).rejects.toThrow(/frozen/);
  });

  it('⚠️ a location can be in only ONE active session', async () => {
    await openSession(kitchen);
    await expect(openSession(kitchen)).rejects.toThrow(/already in active count session/);
  });

  it('but a CLOSED session frees it for a new count', async () => {
    const id = await openSession(kitchen);
    await sql`update count_sessions set status='closed', closed_at=now(), closed_by=${personA} where id=${id}`;
    await expect(openSession(kitchen)).resolves.toBeTruthy();
  });
});

describe('T-169 — ⭐ the variance that v1 never posted', () => {
  it('counted SHORT relieves the layers and posts 5400 at FIFO cost', async () => {
    await stockUp('10', '100.0000');
    // ⭐ DEF-142: the session freezes the SAME room it counts — the only shape a real count has.
    // Until migration 0123 this test froze the stockroom "so the write can land", which is how the
    // freeze refusing its own session's resolving write went unnoticed for five days.
    const sessionId = await openSession(kitchen);

    const res = await withOrgPrincipal(orgA, (tx) =>
      commitCountSession(tx, {
        orgId: orgA, storeId: storeA, sessionId, countedOn: '2026-08-20', committedBy: personA,
        lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('8'), inventoryAccount: '1310' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.shortCost).toBe(money('200.00')); // 2 kg missing at ₱100

    const b = await balances();
    expect(b['5400']).toBe('200.00');
    expect(b['1310']).toBe('800.00');
    expect(await onHand()).toBe('8.000');
  });

  it('⛔ DEF-142: a count movement from a DIFFERENT session is still refused by the freeze', async () => {
    // The exemption is exactly one shape: THIS session's own write into a room THIS session holds.
    // Session A holds the kitchen; session B (holding the stockroom) tries to post a kitchen line.
    await stockUp('10', '100.0000');
    await openSession(kitchen);
    const other = await openSession(stockroom);
    await expect(
      withOrgPrincipal(orgA, (tx) =>
        commitCountSession(tx, {
          orgId: orgA, storeId: storeA, sessionId: other, countedOn: '2026-08-20', committedBy: personA,
          lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('8'), inventoryAccount: '1310' }],
        }),
      ),
    ).rejects.toThrow(/frozen/);
    expect(await onHand()).toBe('10.000');
  });

  it('⭐ counted LONG runs the other way, at the most recent layer cost', async () => {
    await stockUp('10', '100.0000');
    const sessionId = await openSession(kitchen); // DEF-142 — same room, see above

    const res = await withOrgPrincipal(orgA, (tx) =>
      commitCountSession(tx, {
        orgId: orgA, storeId: storeA, sessionId, countedOn: '2026-08-20', committedBy: personA,
        lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('12'), inventoryAccount: '1310' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.longCost).toBe(money('200.00'));

    const b = await balances();
    expect(b['1310']).toBe('1200.00');
    expect(b['5400']).toBe('-200.00');
    expect(await onHand()).toBe('12.000');
  });

  it('⛔ counted long with NO cost basis refuses the commit, and writes nothing', async () => {
    // A free layer would make every later margin on that item fictional, for as long as the stock
    // lasts. Refusing is the only honest option.
    const sessionId = await openSession(stockroom);
    const res = await withOrgPrincipal(orgA, (tx) =>
      commitCountSession(tx, {
        orgId: orgA, storeId: storeA, sessionId, countedOn: '2026-08-20', committedBy: personA,
        lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('5'), inventoryAccount: '1310' }],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('no cost basis');
    const [n] = await sql<{ c: string }[]>`select count(*)::text as c from stock_movements`;
    expect(n!.c).toBe('0');
  });

  it('⭐ a MIXED-kind count posts each inventory account its own items\' cost (review 2026-09-03)', async () => {
    // Pork is raw_material → 1310; a takeout box is supply → 1320. Before the fix the whole
    // variance landed on whichever account the last varying line carried, and 1310/1320 stopped
    // tying to the layers (invariant 6).
    await stockUp('10', '100.0000');
    const [box] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgA},'BOX','Takeout box','supply','pcs',${personA}) returning id`;
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgA},${storeA},'purchase','2026-08-02',${fileA},${personA}) returning id`;
    await withOrgPrincipal(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: '2026-08-02',
        locations: locations(), receivedBy: personA,
        lines: [{ lineId: '1', itemId: box!.id, itemKind: 'supply', receivedQuantity: quantity('10'), conversionFactor: '1', unitCost: '5.0000', locationId: kitchen }],
      }),
    );
    const sessionId = await openSession(kitchen);

    const res = await withOrgPrincipal(orgA, (tx) =>
      commitCountSession(tx, {
        orgId: orgA, storeId: storeA, sessionId, countedOn: '2026-08-20', committedBy: personA,
        lines: [
          { itemId: itemA, locationId: kitchen, countedQuantity: quantity('8'), inventoryAccount: '1310' },
          { itemId: box!.id, locationId: kitchen, countedQuantity: quantity('6'), inventoryAccount: '1320' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.shortEntryIds).toHaveLength(2);
    expect(res.shortCost).toBe(money('220.00')); // 2 kg × ₱100 + 4 boxes × ₱5

    const b = await balances();
    expect(b['1310']).toBe('800.00'); // 1,000 − 200, pork's own loss only
    expect(b['1320']).toBe('30.00'); // 50 − 20, the boxes' own loss only
    expect(b['5400']).toBe('220.00');
  });

  it('⛔ DEF-142: a CLOSED session\'s id does not open the freeze a later session placed on the room', async () => {
    await stockUp('10', '100.0000');
    const stale = await openSession(kitchen);
    await sql`update count_sessions set status='closed', closed_at=now(), closed_by=${personA} where id=${stale}`;
    await openSession(kitchen); // a NEW, active freeze on the same room
    await expect(
      withOrgPrincipal(orgA, (tx) =>
        commitCountSession(tx, {
          orgId: orgA, storeId: storeA, sessionId: stale, countedOn: '2026-08-20', committedBy: personA,
          lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('8'), inventoryAccount: '1310' }],
        }),
      ),
    ).rejects.toThrow(/frozen/);
    expect(await onHand()).toBe('10.000');
  });

  it('an exact count posts nothing at all', async () => {
    await stockUp('10', '100.0000');
    const sessionId = await openSession(stockroom);
    const res = await withOrgPrincipal(orgA, (tx) =>
      commitCountSession(tx, {
        orgId: orgA, storeId: storeA, sessionId, countedOn: '2026-08-20', committedBy: personA,
        lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('10'), inventoryAccount: '1310' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.shortEntryId).toBeNull();
    expect(res.longEntryId).toBeNull();
    expect((await balances())['5400']).toBeUndefined();
  });

  it('⛔ 0.001 — the smallest representable difference — DOES post; there is no tolerance band', async () => {
    // T-161 §8: v1's 1e-6 tolerance was a float defence and cannot fire at numeric(14,3).
    await stockUp('10', '100.0000');
    const sessionId = await openSession(stockroom);
    const res = await withOrgPrincipal(orgA, (tx) =>
      commitCountSession(tx, {
        orgId: orgA, storeId: storeA, sessionId, countedOn: '2026-08-20', committedBy: personA,
        lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('9.999'), inventoryAccount: '1310' }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lines[0]!.variance).toBe(quantity('-0.001'));
    expect(res.shortEntryId).not.toBeNull();
  });

  it('⛔ an OPENING count is refused, naming 3900 and T-134', async () => {
    const sessionId = await openSession(stockroom);
    const res = await withOrgPrincipal(orgA, (tx) =>
      commitCountSession(tx, {
        orgId: orgA, storeId: storeA, sessionId, countedOn: '2026-08-20', committedBy: personA,
        isOpeningCount: true,
        lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('5'), inventoryAccount: '1310' }],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('3900');
    expect(res.reason).toContain('T-134');
  });

  it('⭐ after a count, the exit gate still holds', async () => {
    await stockUp('10', '100.0000');
    const sessionId = await openSession(stockroom);
    await withOrgPrincipal(orgA, (tx) =>
      commitCountSession(tx, {
        orgId: orgA, storeId: storeA, sessionId, countedOn: '2026-08-20', committedBy: personA,
        lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('8'), inventoryAccount: '1310' }],
      }),
    );
    const [gate] = await sql<{ book: string; layers: string }[]>`
      select
        (select (sum(l.debit) - sum(l.credit))::text from journal_lines l
           join accounts a on a.id = l.account_id
          where a.org_id = ${orgA} and a.code in ('1310','1320','1330','1340')) as book,
        (select round(sum(remaining_quantity * unit_cost), 2)::text from stock_layers
          where remaining_quantity > 0) as layers`;
    expect(gate!.book).toBe(gate!.layers);
  });

  it('the trial balance ties after a count', async () => {
    await stockUp('10', '100.0000');
    const sessionId = await openSession(stockroom);
    await withOrgPrincipal(orgA, (tx) =>
      commitCountSession(tx, {
        orgId: orgA, storeId: storeA, sessionId, countedOn: '2026-08-20', committedBy: personA,
        lines: [{ itemId: itemA, locationId: kitchen, countedQuantity: quantity('12'), inventoryAccount: '1310' }],
      }),
    );
    const [tb] = await sql<{ net: string }[]>`
      select (sum(debit) - sum(credit))::text as net from journal_lines l
      join accounts a on a.id = l.account_id where a.org_id = ${orgA}`;
    expect(tb!.net).toBe('0.00');
  });
});

describe('T-169 — a commit happens once', () => {
  it('⛔ a second commit is refused by the database', async () => {
    const id = await openSession(stockroom);
    await sql`update count_sessions set committed_at = now() where id = ${id}`;
    await expect(sql`update count_sessions set committed_at = now() where id = ${id}`).rejects.toThrow(
      /already committed/,
    );
  });

  it('a zero counted quantity is storable — absent and zero are different answers', async () => {
    const id = await openSession(stockroom);
    await expect(
      sql`insert into count_lines (session_id, item_id, location_id, counted_quantity, counted_by)
          values (${id}, ${itemA}, ${kitchen}, 0, ${personA})`,
    ).resolves.toBeTruthy();
  });

  it('a negative counted quantity is not', async () => {
    const id = await openSession(stockroom);
    await expect(
      sql`insert into count_lines (session_id, item_id, location_id, counted_quantity, counted_by)
          values (${id}, ${itemA}, ${kitchen}, -1, ${personA})`,
    ).rejects.toThrow(/counted_non_negative/);
  });
});
