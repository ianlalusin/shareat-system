import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-162 §6 — the FIFO layers against real PostgreSQL, and the planner driving them.
 *
 * ⭐ The arithmetic is already proved without a database in
 * `packages/domain/tests/unit/fifo-rules.test.ts`. What can only be proved HERE is that the plan
 * and the tables agree: that applying a plan leaves `remaining_quantity` and the subledger tying
 * to each other, and that the database refuses the states the planner is supposed to prevent.
 *
 * ⚠️ T-160's single-room trigger and T-161's reversal check both shipped disagreeing with their
 * TypeScript twin. A rule implemented twice needs a test where both copies meet.
 *
 * ⛔ **It lives in `packages/domain`, not `packages/db`, and that is a layering rule rather than a
 * preference.** It needs the pure planner AND the tables. `packages/db` does not depend on
 * `@shareat/domain` — the arrow runs the other way (ADR-004) — so the same file under `db/tests`
 * could only reach the planner by a relative path out of its own package, which is a dependency
 * cycle wearing a disguise. T-161's and T-160's suites stay in `db` because they use raw SQL only.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { planConsumption, planReversal, type ConsumedLine, type CostLayer } from '../../src/stock/layers';
import { quantity } from '../../src/stock/quantity';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 3 });

let orgA: string, storeA: string, personA: string, roomA: string, itemA: string;

async function movement(qty: string, kind = 'receipt'): Promise<string> {
  const [m] = await sql<{ id: string }[]>`
    insert into stock_movements
      (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${orgA}, ${storeA}, ${roomA}, ${itemA}, now(), ${qty}, ${kind}, 'test', ${crypto.randomUUID()}, ${personA})
    returning id`;
  return m!.id;
}

/** A receipt: the movement plus the layer it creates. */
async function layer(qty: string, unitCost: string, receivedAt: string): Promise<string> {
  const movementId = await movement(qty);
  const [l] = await sql<{ id: string }[]>`
    insert into stock_layers
      (org_id, store_id, item_id, received_at, quantity, unit_cost, remaining_quantity, source, source_id, movement_id)
    values (${orgA}, ${storeA}, ${itemA}, ${receivedAt}, ${qty}, ${unitCost}, ${qty}, 'delivery', ${crypto.randomUUID()}, ${movementId})
    returning id`;
  return l!.id;
}

/** Read the open layers back in the shape the pure planner expects. */
async function openLayers(): Promise<CostLayer[]> {
  const rows = await sql<{ id: string; received_at: Date; remaining_quantity: string; unit_cost: string }[]>`
    select id, received_at, remaining_quantity, unit_cost from stock_layers
    where item_id = ${itemA} and store_id = ${storeA} and remaining_quantity > 0
    order by received_at asc, id asc`;
  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.received_at,
    remainingQuantity: quantity(r.remaining_quantity),
    unitCost: r.unit_cost,
  }));
}

/** Apply a plan the way the service will: subledger row, then decrement, in one transaction. */
async function applyPlan(lines: readonly ConsumedLine[], movementId: string): Promise<void> {
  await sql.begin(async (tx) => {
    for (const l of lines) {
      await tx`insert into stock_layer_consumptions (org_id, layer_id, movement_id, quantity, unit_cost, cost)
               values (${orgA}, ${l.layerId}, ${movementId}, ${l.quantity}, ${l.unitCost}, ${l.cost})`;
      await tx`update stock_layers set remaining_quantity = remaining_quantity - ${l.quantity}::numeric
               where id = ${l.layerId}`;
    }
  });
}

beforeEach(async () => {
  await sql`
    truncate table stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  personA = p!.id;
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [r] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgA}, ${storeA}, 'MAIN','Main', ${t!.id}, ${personA}) returning id`;
  roomA = r!.id;
  const [i] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgA},${testItemCode()},'Pork Belly','raw_material','kg',${personA}) returning id`;
  itemA = i!.id;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('T-162 — the plan and the tables agree', () => {
  it('⭐ consuming 15 across two layers leaves the right remainders and the right subledger', async () => {
    const l1 = await layer('10', '100.0000', '2026-08-01T00:00:00Z');
    const l2 = await layer('8', '120.0000', '2026-08-05T00:00:00Z');

    const plan = planConsumption(await openLayers(), quantity('15'));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.totalCost).toBe('1600.00');

    const out = await movement('-15', 'usage');
    await applyPlan(plan.lines, out);

    const rows = await sql<{ id: string; remaining_quantity: string }[]>`
      select id, remaining_quantity from stock_layers order by received_at`;
    expect(rows.find((r) => r.id === l1)!.remaining_quantity).toBe('0.000');
    expect(rows.find((r) => r.id === l2)!.remaining_quantity).toBe('3.000');

    const [sub] = await sql<{ n: string; total: string }[]>`
      select count(*)::text as n, sum(cost)::text as total from stock_layer_consumptions`;
    expect(sub!.n).toBe('2');
    expect(sub!.total).toBe('1600.00');
  });

  it('⭐ the subledger SUM equals the journal amount — invariant 6’s inventory arm', async () => {
    await layer('1', '0.0050', '2026-08-01T00:00:00Z');
    await layer('1', '0.0050', '2026-08-02T00:00:00Z');
    await layer('1', '0.0050', '2026-08-03T00:00:00Z');

    const plan = planConsumption(await openLayers(), quantity('3'));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const out = await movement('-3', 'usage');
    await applyPlan(plan.lines, out);

    // Rounded per LINE: three lines of ₱0.01 = ₱0.03. Rounding the total instead gives ₱0.02, and
    // the entry would then differ from its own detail by a centavo.
    const [sub] = await sql<{ total: string }[]>`select sum(cost)::text as total from stock_layer_consumptions`;
    expect(sub!.total).toBe('0.03');
    expect(plan.totalCost).toBe('0.03');
  });

  it('FIFO order comes from received_at, not insertion order', async () => {
    const newer = await layer('5', '200.0000', '2026-08-10T00:00:00Z');
    const older = await layer('5', '100.0000', '2026-08-01T00:00:00Z');
    const plan = planConsumption(await openLayers(), quantity('4'));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines[0]!.layerId).toBe(older);
    expect(plan.lines).toHaveLength(1);
    expect(newer).toBeTruthy();
  });
});

describe('T-162 — what the database refuses', () => {
  it('⭐ remaining_quantity can never go negative', async () => {
    const l = await layer('10', '100.0000', '2026-08-01T00:00:00Z');
    await expect(
      sql`update stock_layers set remaining_quantity = -1 where id = ${l}`,
    ).rejects.toThrow(/remaining_within_bounds/);
  });

  it('remaining_quantity can never exceed quantity', async () => {
    const l = await layer('10', '100.0000', '2026-08-01T00:00:00Z');
    await expect(
      sql`update stock_layers set remaining_quantity = 11 where id = ${l}`,
    ).rejects.toThrow(/remaining_within_bounds/);
  });

  it('⭐ the subledger must TIE to its layer, checked at commit', async () => {
    // Write a consumption without decrementing the layer: the two now disagree, and the
    // disagreement is exactly what would be invisible if nothing checked it.
    const l = await layer('10', '100.0000', '2026-08-01T00:00:00Z');
    const out = await movement('-4', 'usage');
    await expect(
      sql`insert into stock_layer_consumptions (org_id, layer_id, movement_id, quantity, unit_cost, cost)
          values (${orgA}, ${l}, ${out}, 4, 100.0000, 400.00)`,
    ).rejects.toThrow(/does not tie/);
  });

  it('one layer per stock-in movement — a retried receipt cannot double the cost basis', async () => {
    const movementId = await movement('10');
    await sql`insert into stock_layers (org_id, store_id, item_id, received_at, quantity, unit_cost, remaining_quantity, source, source_id, movement_id)
              values (${orgA},${storeA},${itemA},now(),10,100,10,'delivery',${crypto.randomUUID()},${movementId})`;
    await expect(
      sql`insert into stock_layers (org_id, store_id, item_id, received_at, quantity, unit_cost, remaining_quantity, source, source_id, movement_id)
          values (${orgA},${storeA},${itemA},now(),10,100,10,'delivery',${crypto.randomUUID()},${movementId})`,
    ).rejects.toThrow(/stock_layers_movement_key/);
  });

  it('a retried consumption cannot double-relieve a layer', async () => {
    const l = await layer('10', '100.0000', '2026-08-01T00:00:00Z');
    const out = await movement('-4', 'usage');
    await sql.begin(async (tx) => {
      await tx`insert into stock_layer_consumptions (org_id, layer_id, movement_id, quantity, unit_cost, cost)
               values (${orgA},${l},${out},4,100.0000,400.00)`;
      await tx`update stock_layers set remaining_quantity = 6 where id = ${l}`;
    });
    await expect(
      sql`insert into stock_layer_consumptions (org_id, layer_id, movement_id, quantity, unit_cost, cost)
          values (${orgA},${l},${out},4,100.0000,400.00)`,
    ).rejects.toThrow(/layer_movement_key/);
  });

  it('⭐ is_provisional and invoice_line_id may not disagree', async () => {
    const l = await layer('10', '100.0000', '2026-08-01T00:00:00Z');
    // Claiming confirmed with no invoice behind it is the flag drifting from the fact.
    await expect(
      sql`update stock_layers set is_provisional = false where id = ${l}`,
    ).rejects.toThrow(/provisional_matches_invoice/);
  });

  it('a layer of zero or negative quantity cannot exist', async () => {
    const movementId = await movement('10');
    await expect(
      sql`insert into stock_layers (org_id, store_id, item_id, received_at, quantity, unit_cost, remaining_quantity, source, source_id, movement_id)
          values (${orgA},${storeA},${itemA},now(),0,100,0,'delivery',${crypto.randomUUID()},${movementId})`,
    ).rejects.toThrow(/quantity_positive/);
  });
});

describe('T-162 — reversal gives back to the layers it took from', () => {
  it('⭐ a full reversal restores each layer exactly, not the oldest', async () => {
    const l1 = await layer('10', '100.0000', '2026-08-01T00:00:00Z');
    const l2 = await layer('8', '120.0000', '2026-08-05T00:00:00Z');
    const plan = planConsumption(await openLayers(), quantity('15'));
    if (!plan.ok) throw new Error('plan failed');
    const out = await movement('-15', 'usage');
    await applyPlan(plan.lines, out);

    const outstanding = await sql<{ id: string; layer_id: string; quantity: string; unit_cost: string; cost: string }[]>`
      select id, layer_id, quantity, unit_cost, cost from stock_layer_consumptions
      where movement_id = ${out} and reversed_by_movement_id is null order by created_at, id`;
    const consumed: ConsumedLine[] = outstanding.map((r) => ({
      layerId: r.layer_id,
      quantity: quantity(r.quantity),
      unitCost: r.unit_cost,
      cost: r.cost as never,
    }));

    const rev = planReversal(consumed, quantity('15'));
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;

    const back = await movement('15', 'receipt');
    await sql.begin(async (tx) => {
      for (const line of rev.lines) {
        const row = outstanding.find((r) => r.layer_id === line.layerId)!;
        await tx`update stock_layer_consumptions set reversed_by_movement_id = ${back} where id = ${row.id}`;
        await tx`update stock_layers set remaining_quantity = remaining_quantity + ${line.quantity}::numeric
                 where id = ${line.layerId}`;
      }
    });

    const rows = await sql<{ id: string; remaining_quantity: string }[]>`
      select id, remaining_quantity from stock_layers`;
    expect(rows.find((r) => r.id === l1)!.remaining_quantity).toBe('10.000');
    expect(rows.find((r) => r.id === l2)!.remaining_quantity).toBe('8.000');
  });

  it('⚠️ a reversed consumption stops counting against its layer, so the tie still holds', async () => {
    // The tie-trigger excludes reversed rows. If it did not, giving quantity back would break the
    // very constraint that proves the give-back was correct.
    const l = await layer('10', '100.0000', '2026-08-01T00:00:00Z');
    const out = await movement('-4', 'usage');
    let consumptionId = '';
    await sql.begin(async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        insert into stock_layer_consumptions (org_id, layer_id, movement_id, quantity, unit_cost, cost)
        values (${orgA},${l},${out},4,100.0000,400.00) returning id`;
      consumptionId = c!.id;
      await tx`update stock_layers set remaining_quantity = 6 where id = ${l}`;
    });

    const back = await movement('4', 'receipt');
    await sql.begin(async (tx) => {
      await tx`update stock_layer_consumptions set reversed_by_movement_id = ${back} where id = ${consumptionId}`;
      await tx`update stock_layers set remaining_quantity = 10 where id = ${l}`;
    });

    const [row] = await sql<{ remaining_quantity: string }[]>`select remaining_quantity from stock_layers where id = ${l}`;
    expect(row!.remaining_quantity).toBe('10.000');
  });
});

describe('T-162 — valuation, the number the exit gate compares', () => {
  it('⭐ Σ (remaining × unit cost), derived on every read', async () => {
    await layer('10', '100.0000', '2026-08-01T00:00:00Z');
    await layer('8', '120.0000', '2026-08-05T00:00:00Z');
    const plan = planConsumption(await openLayers(), quantity('15'));
    if (!plan.ok) throw new Error('plan failed');
    await applyPlan(plan.lines, await movement('-15', 'usage'));

    // 3 remaining at ₱120 = ₱360.
    const [v] = await sql<{ value: string }[]>`
      select round(sum(remaining_quantity * unit_cost), 2)::text as value
      from stock_layers where remaining_quantity > 0`;
    expect(v!.value).toBe('360.00');
  });

  it('⛔ there is no stored valuation column to go stale', async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'stock_layers' and column_name in ('remaining_value','value','total_cost')`;
    expect(cols).toHaveLength(0);
  });
});
