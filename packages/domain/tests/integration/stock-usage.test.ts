import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { money } from '@shareat/core/money';
import { closeDb, transaction } from '@shareat/db';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { postUsageRecord, voidUsageRecord } from '../../src/stock/usage';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';

/**
 * T-168 — usage, wastage and the loop closing.
 *
 * ⭐ **This file is the first place stock goes all the way round**: received (T-166), layered
 * (T-162), consumed (T-168), and costed into the P&L at what it actually cost (T-164). Everything
 * before this proved a piece; this proves the chain.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, storeA: string, personA: string, fileA: string;
let receivingRoom: string, kitchen: string, stockroom: string, itemA: string;

function locations(): LocationLike[] {
  return [
    { id: receivingRoom, role: 'storage', purpose: 'receiving', isDefault: false, status: 'active' },
    { id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
    { id: stockroom, role: 'storage', purpose: 'normal', isDefault: false, status: 'active' },
  ];
}

async function onHand(locationId = kitchen): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemA} and location_id = ${locationId}`;
  return r!.t;
}

async function balances(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgA} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

/** Two receipts at different costs, so FIFO has something to choose between. */
async function stockUp() {
  for (const [n, cost, day] of [['10', '100.0000', '01'], ['8', '120.0000', '05']] as const) {
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgA},${storeA},'purchase',${'2026-08-' + day},${fileA},${personA}) returning id`;
    await transaction((tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: `2026-08-${day}`,
        locations: locations(), receivedBy: personA,
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity(n), conversionFactor: '1', unitCost: cost, locationId: kitchen }],
      }),
    );
  }
}

const usageInput = (over: Record<string, unknown> = {}) => ({
  orgId: orgA, storeId: storeA, locationId: kitchen,
  recordId: crypto.randomUUID(), kind: 'usage' as const, usedOn: '2026-08-20',
  postedBy: personA,
  lines: [{ lineId: '1', itemId: itemA, cogsCategory: 'meat', inventoryAccount: '1310', quantity: quantity('15') }],
  ...over,
});

beforeEach(async () => {
  await sql`
    truncate table stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
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
  const [r1] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, purpose, created_by) values (${orgA},${storeA},'RCV','Receiving',${t!.id},'receiving',${personA}) returning id`;
  const [r2] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${personA}) returning id`;
  const [r3] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgA},${storeA},'STORE','Stockroom',${t!.id},${personA}) returning id`;
  receivingRoom = r1!.id; kitchen = r2!.id; stockroom = r3!.id;
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'PORK','Pork Belly','raw_material','kg',${personA}) returning id`;
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

describe('T-168 — ⭐ the loop closes', () => {
  it('receive, use, and COGS is what the stock actually cost', async () => {
    await stockUp();
    expect(await onHand()).toBe('18.000');
    expect((await balances())['1310']).toBe('1960.00'); // 10x100 + 8x120

    const res = await transaction((tx) => postUsageRecord(tx, usageInput()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // ⭐ 15 kg = 10 @ ₱100 + 5 @ ₱120 = ₱1,600. FIFO, oldest first, not an average.
    expect(res.totalCost).toBe(money('1600.00'));
    expect(await onHand()).toBe('3.000');

    const b = await balances();
    expect(b['5110']).toBe('1600.00');
    expect(b['1310']).toBe('360.00'); // 3 kg left, all from the ₱120 layer

    // The subledger says which layer paid for what.
    const [sub] = await sql<{ n: string; total: string }[]>`
      select count(*)::text as n, sum(cost)::text as total from stock_layer_consumptions`;
    expect(sub!.n).toBe('2');
    expect(sub!.total).toBe('1600.00');
  });

  it('⭐ wastage takes the same FIFO cost but lands in 5300, never COGS', async () => {
    await stockUp();
    await transaction((tx) =>
      postUsageRecord(tx, usageInput({ kind: 'wastage', reason: 'spoilage' })),
    );
    const b = await balances();
    expect(b['5300']).toBe('1600.00');
    expect(b['5110']).toBeUndefined();
    expect(await onHand()).toBe('3.000');
  });

  it('⛔ using more than exists is refused, and NOTHING is written', async () => {
    await stockUp();
    const res = await transaction((tx) =>
      postUsageRecord(tx, usageInput({ lines: [{ lineId: '1', itemId: itemA, cogsCategory: 'meat', inventoryAccount: '1310', quantity: quantity('25') }] })),
    );
    expect(res.ok).toBe(false);
    expect(await onHand()).toBe('18.000');
    const [n] = await sql<{ c: string }[]>`select count(*)::text as c from stock_layer_consumptions`;
    expect(n!.c).toBe('0');
  });
});

describe('T-168 — a multi-line post is all or nothing (review 2026-09-03)', () => {
  it('⛔ a refusal on line 2 UNWINDS line 1 — nothing is consumed', async () => {
    // Before the fix `postUsageRecord` returned line 2's refusal after line 1's movement and layer
    // consumptions were written, and the caller committed a half-post: item A gone, no entry, the
    // record still `draft`, and a second press consuming A again.
    await stockUp();
    const [rice] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgA},'RICE','Rice','raw_material','kg',${personA}) returning id`;
    await expect(
      transaction((tx) =>
        postUsageRecord(tx, usageInput({
          lines: [
            { lineId: '1', itemId: itemA, cogsCategory: 'meat', inventoryAccount: '1310', quantity: quantity('5') },
            { lineId: '2', itemId: rice!.id, cogsCategory: 'meat', inventoryAccount: '1310', quantity: quantity('1') },
          ],
        })),
      ),
    ).rejects.toThrow(/refused after stock was written/);
    expect(await onHand()).toBe('18.000');
    const [n] = await sql<{ c: string }[]>`select count(*)::text as c from stock_layer_consumptions`;
    expect(n!.c).toBe('0');
    expect((await balances())['5110']).toBeUndefined();
  });
});

describe('T-168 — the reserved category, and the charge that must not vanish', () => {
  it('⭐ a wastage reason of "transfer" is REFUSED, with the reason explained', async () => {
    await stockUp();
    const res = await transaction((tx) =>
      postUsageRecord(tx, usageInput({ kind: 'wastage', reason: 'transfer' })),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // The message has to say WHY, or the next person just picks another word for it.
    expect(res.reason).toContain('OUT leg');
    expect(await onHand()).toBe('18.000');
  });

  it('⛔ the database refuses it too, by any path', async () => {
    await expect(
      sql`insert into stock_usage_records (org_id, store_id, location_id, kind, used_on, reason_code, created_by)
          values (${orgA},${storeA},${kitchen},'wastage','2026-08-20','transfer',${personA})`,
    ).rejects.toThrow(/reason_not_transfer/);
  });

  it('⭐ a staff charge is REFUSED while Phase 5 is unbuilt — never silently dropped', async () => {
    // A charge that vanishes is worse than one that fails: the stock still moved, and somebody
    // believes they are being recovered from.
    await stockUp();
    const res = await transaction((tx) =>
      postUsageRecord(tx, usageInput({ kind: 'wastage', reason: 'spoilage', chargePersonId: personA })),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('Phase 5');
    expect(await onHand()).toBe('18.000');
  });

  it('only a wastage may carry a charge', async () => {
    await stockUp();
    const res = await transaction((tx) => postUsageRecord(tx, usageInput({ chargePersonId: personA })));
    expect(res.ok).toBe(false);
  });
});

describe('T-168 — where stock may be used from', () => {
  it('⭐ a STORAGE room can never be a usage source', async () => {
    await expect(
      sql`insert into stock_usage_records (org_id, store_id, location_id, kind, used_on, created_by)
          values (${orgA},${storeA},${stockroom},'usage','2026-08-20',${personA})`,
    ).rejects.toThrow(/storage room/);
  });

  it('⛔ nor can the Receiving parking spot', async () => {
    await expect(
      sql`insert into stock_usage_records (org_id, store_id, location_id, kind, used_on, created_by)
          values (${orgA},${storeA},${receivingRoom},'usage','2026-08-20',${personA})`,
    ).rejects.toThrow(/parking spot/);
  });

  it('⚠️ an ADJUSTMENT is exempt — a miscount lives exactly where the stock is', async () => {
    await expect(
      sql`insert into stock_usage_records (org_id, store_id, location_id, kind, used_on, adjustment_reason, created_by)
          values (${orgA},${storeA},${stockroom},'adjustment','2026-08-20','recount',${personA})`,
    ).resolves.toBeTruthy();
  });

  it('an operating room is fine', async () => {
    await expect(
      sql`insert into stock_usage_records (org_id, store_id, location_id, kind, used_on, created_by)
          values (${orgA},${storeA},${kitchen},'usage','2026-08-20',${personA})`,
    ).resolves.toBeTruthy();
  });
});

describe('T-168 — draft, posted, void', () => {
  async function record(status = 'draft'): Promise<string> {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_usage_records (org_id, store_id, location_id, kind, status, used_on, created_by, posted_at, posted_by)
      values (${orgA},${storeA},${kitchen},'usage',${status},'2026-08-20',${personA},
              ${status === 'posted' ? sql`now()` : null}, ${status === 'posted' ? personA : null})
      returning id`;
    return r!.id;
  }

  it('⛔ a POSTED record is immutable except for the transition to void', async () => {
    const id = await record('posted');
    await expect(sql`update stock_usage_records set used_on = '2026-08-21' where id = ${id}`).rejects.toThrow(
      /immutable/,
    );
    await expect(
      sql`update stock_usage_records set status='void', voided_at=now(), voided_by=${personA}, void_reason='wrong' where id = ${id}`,
    ).resolves.toBeTruthy();
  });

  it('⛔ a void is TERMINAL — a voided record is never re-posted', async () => {
    const id = await record('posted');
    await sql`update stock_usage_records set status='void', voided_at=now(), voided_by=${personA}, void_reason='x' where id = ${id}`;
    await expect(
      sql`update stock_usage_records set status='posted' where id = ${id}`,
    ).rejects.toThrow(/terminal/);
  });

  it('a DRAFT can still be edited freely', async () => {
    const id = await record('draft');
    await expect(sql`update stock_usage_records set used_on = '2026-08-21' where id = ${id}`).resolves.toBeTruthy();
  });
});

describe('T-168 — void gives stock back to the layers it came from', () => {
  it('⭐ restores each layer exactly, not the oldest', async () => {
    await stockUp();
    const input = usageInput();
    const posted = await transaction((tx) => postUsageRecord(tx, input));
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;

    const before = await sql<{ id: string; remaining_quantity: string }[]>`
      select id, remaining_quantity from stock_layers order by received_at`;
    expect(before.map((r) => r.remaining_quantity)).toEqual(['0.000', '3.000']);

    const res = await transaction((tx) =>
      voidUsageRecord(tx, {
        orgId: orgA, storeId: storeA, locationId: kitchen, recordId: input.recordId,
        kind: 'usage', voidedOn: '2026-08-21', voidedBy: personA,
        lines: [{ itemId: itemA, movementId: posted.movementIds[0]!, quantity: quantity('15') }],
      }),
    );
    expect(res.ok).toBe(true);

    // ⭐ 10 back to the ₱100 layer and 5 to the ₱120 one — never 15 to the oldest, which would be
    // a silent re-costing.
    const after = await sql<{ remaining_quantity: string }[]>`
      select remaining_quantity from stock_layers order by received_at`;
    expect(after.map((r) => r.remaining_quantity)).toEqual(['10.000', '8.000']);
    expect(await onHand()).toBe('18.000');
  });

  it('⭐ and REVERSES the entry — 5110 and 1310 return to their pre-post balances (DEF-141)', async () => {
    // Spec test 8 says "void reverses stock and entry"; until 2026-09-03 this file asserted only the
    // stock half, and the engine reversed only the stock half. A voided usage silently kept its
    // COGS, and no screen existed to notice.
    await stockUp();
    const input = usageInput({ kind: 'wastage', reason: 'spoilage' });
    const posted = await transaction((tx) => postUsageRecord(tx, input));
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect((await balances())['5300']).toBe('1600.00');
    expect((await balances())['1310']).toBe('360.00');

    const res = await transaction((tx) =>
      voidUsageRecord(tx, {
        orgId: orgA, storeId: storeA, locationId: kitchen, recordId: input.recordId,
        kind: 'wastage', voidedOn: '2026-08-21', voidedBy: personA, reason: 'counted wrong',
        lines: [{ itemId: itemA, movementId: posted.movementIds[0]!, quantity: quantity('15') }],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reversalEntryIds).toHaveLength(1);

    const b = await balances();
    expect(b['5300']).toBe('0.00');
    expect(b['1310']).toBe('1960.00');

    // The ledger's own discipline, not a hand-rolled opposite entry: the original is `reversed`,
    // the reversal points back at it, and it carries the reason.
    const [orig] = await sql<{ status: string }[]>`select status from journal_entries where id = ${posted.entryIds[0]!}`;
    expect(orig!.status).toBe('reversed');
    const [rev] = await sql<{ reversal_of_entry_id: string; memo: string; entry_date: string }[]>`
      select reversal_of_entry_id, memo, entry_date::text from journal_entries where id = ${res.reversalEntryIds[0]!}`;
    expect(rev!.reversal_of_entry_id).toBe(posted.entryIds[0]);
    expect(rev!.memo).toBe('counted wrong');
    expect(rev!.entry_date).toBe('2026-08-21');
  });

  it('⛔ a void carrying a live staff charge is refused while Phase 5 is unbuilt', async () => {
    // v1's ordering rule: the charge is voided FIRST, so a failure never leaves reversed stock
    // beside an un-reversed pay deduction.
    const res = await transaction((tx) =>
      voidUsageRecord(tx, {
        orgId: orgA, storeId: storeA, locationId: kitchen, recordId: crypto.randomUUID(),
        kind: 'wastage', voidedOn: '2026-08-21', voidedBy: personA,
        lines: [], hasLiveStaffCharge: true,
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('deduction standing');
  });
});

describe('T-168 — the period lock and the ledger', () => {
  it('a post into a closed period is refused and nothing survives', async () => {
    await stockUp();
    await sql`update fiscal_periods set status='closed' where org_id = ${orgA}`;
    await expect(transaction((tx) => postUsageRecord(tx, usageInput()))).rejects.toThrow(/period|closed/i);
    expect(await onHand()).toBe('18.000');
  });

  it('⭐ the trial balance ties after receive + use', async () => {
    await stockUp();
    await transaction((tx) => postUsageRecord(tx, usageInput()));
    const [tb] = await sql<{ net: string }[]>`
      select (sum(debit) - sum(credit))::text as net from journal_lines l
      join accounts a on a.id = l.account_id where a.org_id = ${orgA}`;
    expect(tb!.net).toBe('0.00');
  });

  it('⭐ inventory on the books equals the open layers — Phase 3’s exit gate, on a real loop', async () => {
    await stockUp();
    await transaction((tx) => postUsageRecord(tx, usageInput()));
    const [gate] = await sql<{ book: string; layers: string }[]>`
      select
        (select (sum(l.debit) - sum(l.credit))::text from journal_lines l
           join accounts a on a.id = l.account_id
          where a.org_id = ${orgA} and a.code in ('1310','1320','1330','1340')) as book,
        (select round(sum(remaining_quantity * unit_cost), 2)::text from stock_layers
          where remaining_quantity > 0) as layers`;
    expect(gate!.book).toBe(gate!.layers);
  });
});
