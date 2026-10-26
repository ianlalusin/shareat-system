import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-489 (DEF-780) - the purchase-to-base conversion uses the full six-decimal factor, exactly, and a line whose base
 * quantity rounds to zero is REFUSED rather than silently skipped as "nothing arrived".
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, storeA: string, personA: string, kitchen: string, itemA: string;

beforeEach(async () => {
  await sql`
    truncate table delivery_lines, deliveries, stock_layer_consumptions, stock_layers,
      stock_movements, stock_locations, location_types, departments,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  personA = p!.id;
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [r2] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${personA}) returning id`;
  kitchen = r2!.id;
  const [i1] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgA},${testItemCode()},'Rice','raw_material','kg',${personA}) returning id`;
  itemA = i1!.id;
  await seedChartOfAccounts(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            values (${orgA},'2026-08-01','2026-08-31','open')`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function receive(qty: string, factor: string) {
  const deliveryId = crypto.randomUUID();
  return withOrgPrincipal(orgA, (tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId: storeA, deliveryId, deliveredOn: '2026-08-20',
      locations: [{ id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: personA,
      lines: [{
        lineId: '1', itemId: itemA, itemKind: 'raw_material',
        receivedQuantity: quantity(qty), conversionFactor: factor, unitCost: '10.0000', locationId: kitchen,
      }],
    }),
  );
}

describe('T-489 - exact unit conversion', () => {
  it('1,000 cases at factor 0.0625 put exactly 62,500 thousandths in stock and in the layer', async () => {
    const res = await receive('1000', '0.062500');
    expect(res.ok).toBe(true);
    const [m] = await sql<{ q: string }[]>`select sum(quantity)::text as q from stock_movements where item_id = ${itemA}`;
    expect(m!.q).toBe('62.500');
    const [l] = await sql<{ q: string }[]>`select sum(quantity)::text as q from stock_layers where item_id = ${itemA}`;
    expect(l!.q).toBe('62.500');
  });

  it('a line of 1 at factor 0.0004 is refused with the plain sentence, and nothing is written', async () => {
    const res = await receive('1', '0.000400');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.userReason).toMatch(/so small that 1\.000 .* round to zero base units. Fix the item's conversion factor first\.$/);
    const [m] = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements`;
    expect(m!.n).toBe('0');
    const [j] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries`;
    expect(j!.n).toBe('0');
  });

  it('a line received as zero is still the legitimate skip (not this refusal)', async () => {
    const res = await receive('0', '0.000400');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('every line was received as zero — nothing to post');
  });
});
