/**
 * T-398 S5 audit findings 2 and 3 (TESTER) -- migration 0218 (still unapplied anywhere, so the builder edits it in place).
 * docs/tasks/398-s5/QUESTIONS.md "S5a+S5b audit (25 Oct)", orchestrator rulings 2 and 3.
 * Real Postgres via TEST_DATABASE_URL (`_test` guard). Seller/buyer legs run as shareat_app (SET LOCAL ROLE) inside a ROLLED-BACK
 * transaction; "owner" legs use the connection owner, which the receipt guard of 0218 also treats as the privileged path.
 *
 * FREEZE (ruling 2): once inter_entity_shipments.status <> 'in_transit' the app role may not change billed_total, credited_total, the
 * organisations, the order link, or a line's quantity / rate / line_total / item identity (item_name, unit). Refusal = 42501, raised by a
 * BEFORE trigger, so it comes before any CHECK (each leg alters one column on purpose so a CHECK cannot be the reason). credited_total
 * moves only on the owner/definer path. BUILDER NOTE: the freeze must run BEFORE the billed-total sum check can fire (make the sum check
 * a deferred AFTER/constraint trigger, or name its trigger so it sorts after the freeze trigger), else billed_total edits answer 23514.
 * SUM (ruling 2): billed_total = sum(lines.line_total). A header and its lines are written in separate statements, so the check must be
 * DEFERRED to the end of the transaction; legs end with SET CONSTRAINTS ALL IMMEDIATE to force it inside a rolled-back test
 * transaction, and expect 23514. A header with NO lines yet must be tolerated (the owner fixtures insert header, then line).
 * RECEIVE INPUTS (ruling 3): written against the function as it stands in 0218; legs that pass today say so in their title.
 *
 * MUTANTS: freeze trigger missing / only some columns -> F1..F9; freeze applies to the owner too -> F10; freeze applies while in_transit -> F8, F11;
 *   sum check missing -> S1, S3, S5; sum check immediate (blocks a legitimate header+line write) -> S2, S4; receive duplicate-line / foreign-line /
 *   negative / missing-line / void guards dropped -> V1..V6.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { menuFixture, sql, uid, asApp, type PgErr, type MenuFx } from './_fixtures/t401-menu';

config({ path: '.env.local' });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type Tx = postgres.TransactionSql;
const asSql = (q: Tx | postgres.Sql) => q as unknown as postgres.Sql;
const BROKEN = ['42P01', '42703', '42883', '42704'];
const SHIP = 'inter_entity_shipments';
const LINE = 'inter_entity_shipment_lines';

async function probe(q: Tx, fn: (sp: Tx) => PromiseLike<unknown>): Promise<PgErr | undefined> {
  try {
    await q.savepoint(async (sp) => {
      await fn(sp as unknown as Tx);
    });
    return undefined;
  } catch (e) {
    return e as PgErr;
  }
}
function expectRefused(err: PgErr | undefined, why: string, code: string) {
  expect(err, `${why}: the statement was ACCEPTED`).toBeDefined();
  expect(BROKEN, `${why}: raised ${err?.code} ${err?.message} - an object is missing, not a refusal`).not.toContain(err?.code);
  expect(err?.code, `${why}: wrong SQLSTATE (${err?.message})`).toBe(code);
}
async function asPerson<T>(org: string, person: string, fn: (tx: Tx) => Promise<T>) {
  return asApp(org, async (tx) => {
    await tx`select set_config('app.person_id', ${person}, true)`;
    return fn(tx);
  });
}

interface World {
  a: MenuFx;
  b: MenuFx;
  customerA: string;
}
let worldP: Promise<World> | undefined;
const world = () => (worldP ??= (async () => {
  const a = await menuFixture('s5au');
  const b = await menuFixture('s5bu');
  const [cu] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, counterparty_org_id, created_by) values (${a.orgId}, ${uid('PG')}, ${b.orgId}, ${a.personId}) returning id`;
  return { a, b, customerA: cu!.id };
})());

/**
 * A shipment A -> B in ONE owner transaction: order, N order lines, header, N lines (10.000 kg at 310.00 = 3100.00; the 2nd line
 * 0.500 kg at 7.77 = 3.89). `state` 'received' stamps the receipt as the owner (the receipt guard only binds the app role).
 */
async function newShipment(w: World, o: { lines?: 1 | 2; state?: 'in_transit' | 'received' | 'void' } = {}) {
  const n = o.lines ?? 1;
  const state = o.state ?? 'in_transit';
  const billed = n === 2 ? '3103.89' : '3100.00';
  return sql.begin(async (tx) => {
    const t = asSql(tx);
    const [ord] = await t<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
      values (${w.a.orgId}, ${w.a.storeId}, ${w.customerA}, current_date, 'draft', ${billed}, ${w.a.personId}) returning id`;
    const [ol1] = await t<{ id: string }[]>`
      insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
      values (${w.a.orgId}, ${ord!.id}, ${w.a.stockItemId}, '10.000', 'kg', '310.00', '3100.00') returning id`;
    const ol2 = n === 2
      ? (await t<{ id: string }[]>`
          insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
          values (${w.a.orgId}, ${ord!.id}, ${w.a.stockItemId}, '0.500', 'kg', '7.77', '3.89') returning id`)[0]!.id
      : null;
    const [sh] = await t<{ id: string }[]>`
      insert into inter_entity_shipments (org_id, buyer_org_id, trade_order_id, store_id, shipped_on, billed_total, status)
      values (${w.a.orgId}, ${w.b.orgId}, ${ord!.id}, ${w.a.storeId}, '2026-12-01', ${billed}, 'in_transit') returning id`;
    const [l1] = await t<{ id: string }[]>`
      insert into inter_entity_shipment_lines (org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total)
      values (${w.a.orgId}, ${w.b.orgId}, ${sh!.id}, ${ol1!.id}, 1, 'Pork belly', 'kg', '10.000', '310.00', '3100.00') returning id`;
    const l2 = ol2
      ? (await t<{ id: string }[]>`
          insert into inter_entity_shipment_lines (org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total)
          values (${w.a.orgId}, ${w.b.orgId}, ${sh!.id}, ${ol2}, 2, 'Salt', 'kg', '0.500', '7.77', '3.89') returning id`)[0]!.id
      : null;
    if (state === 'received') {
      await t`update inter_entity_shipment_lines set received_quantity = quantity where shipment_id = ${sh!.id}`;
      await t`update inter_entity_shipments set status = 'received', received_at = now(), received_by = ${w.b.personId}, received_total = ${billed} where id = ${sh!.id}`;
    } else if (state === 'void') {
      await t`update inter_entity_shipments set status = 'void', voided_at = now(), voided_by = ${w.a.personId}, void_reason = 'test' where id = ${sh!.id}`;
    }
    return { orderId: ord!.id, shipmentId: sh!.id, line1: l1!.id, line2: l2, orderLine1: ol1!.id };
  });
}

// ================================================================================================ FREEZE (ruling 2)
describe('F -- once a shipment is not in_transit, the shipping org cannot rewrite money or identity (42501)', () => {
  const BILLED = `update ${SHIP} set billed_total = '3200.00' where id = $1`;
  const CREDITED = `update ${SHIP} set credited_total = '10.00' where id = $1`;

  it('F1 RECEIVED shipment: the seller (shareat_app) updating billed_total or credited_total is refused 42501; an unrelated column (bir_invoice_no) still updates (control: the guard is column-specific)', async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'received' });
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => {
      const billed = await probe(tx, (sp) => asSql(sp).unsafe(BILLED, [s.shipmentId]));
      const credited = await probe(tx, (sp) => asSql(sp).unsafe(CREDITED, [s.shipmentId]));
      const ok = await asSql(tx)`update ${asSql(tx)(SHIP)} set bir_invoice_no = 'BIR-77' where id = ${s.shipmentId} returning id`;
      return { billed, credited, ok: ok.length };
    });
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.billed, 'F1 billed_total 3100.00 -> 3200.00 after receipt', '42501');
    expectRefused(r.value!.credited, 'F1 credited_total 0 -> 10.00 after receipt', '42501');
    expect(r.value!.ok, 'control: bir_invoice_no (not money, not identity) still updates').toBe(1);
    const [row] = await sql<{ billed_total: string; credited_total: string }[]>`select billed_total, credited_total from ${sql(SHIP)} where id = ${s.shipmentId}`;
    expect(row, 'money unchanged in the database').toEqual({ billed_total: '3100.00', credited_total: '0.00' });
  });

  it('F2 VOID shipment: billed_total and credited_total are frozen for the seller too (42501)', async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'void' });
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => ({
      billed: await probe(tx, (sp) => asSql(sp).unsafe(BILLED, [s.shipmentId])),
      credited: await probe(tx, (sp) => asSql(sp).unsafe(CREDITED, [s.shipmentId])),
    }));
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.billed, 'F2 void: billed_total', '42501');
    expectRefused(r.value!.credited, 'F2 void: credited_total', '42501');
  });

  it('F3 credited_total moves from the OWNER path after receipt (positive control for F1: the credit-note path stays open); billed_total stays 3100.00', async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'received' });
    await sql`update ${sql(SHIP)} set credited_total = '150.00' where id = ${s.shipmentId}`;
    const [row] = await sql<{ credited_total: string; billed_total: string }[]>`select credited_total, billed_total from ${sql(SHIP)} where id = ${s.shipmentId}`;
    expect(row).toEqual({ credited_total: '150.00', billed_total: '3100.00' });
  });

  it('F4 RECEIVED: the seller re-pointing the shipment at another order of the same customer (trade_order_id) is refused 42501; the same re-point while in_transit is accepted (control)', async () => {
    const w = await world();
    const rec = await newShipment(w, { state: 'received' });
    const transit = await newShipment(w);
    const [spare] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
      values (${w.a.orgId}, ${w.a.storeId}, ${w.customerA}, current_date, 'draft', '1.00', ${w.a.personId}) returning id`;
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => ({
      received: await probe(tx, (sp) => asSql(sp)`update ${asSql(sp)(SHIP)} set trade_order_id = ${spare!.id} where id = ${rec.shipmentId}`),
      inTransit: await probe(tx, (sp) => asSql(sp)`update ${asSql(sp)(SHIP)} set trade_order_id = ${spare!.id} where id = ${transit.shipmentId}`),
    }));
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.received, 'F4 re-pointing a received shipment at another order', '42501');
    expect(r.value!.inTransit, 'control: while in_transit the same re-point is accepted').toBeUndefined();
  });

  it('F5 RECEIVED: org_id / buyer_org_id cannot be rewritten (any refusal; NOTE this may already be GREEN today because the link trigger and the composite foreign keys refuse first - the freeze must not weaken it)', async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'received' });
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => ({
      buyer: await probe(tx, (sp) => asSql(sp)`update ${asSql(sp)(SHIP)} set buyer_org_id = ${w.a.orgId} where id = ${s.shipmentId}`),
      org: await probe(tx, (sp) => asSql(sp)`update ${asSql(sp)(SHIP)} set org_id = ${w.b.orgId} where id = ${s.shipmentId}`),
    }));
    expect(r.err?.message).toBeUndefined();
    for (const [k, e] of Object.entries(r.value!)) {
      expect(e, `F5 ${k} rewrite was ACCEPTED`).toBeDefined();
      expect(BROKEN).not.toContain(e!.code);
      expect(['42501', '23514', '23503'], `F5 ${k}: ${e!.code} ${e!.message}`).toContain(e!.code);
    }
  });

  const lineEdits: [string, string][] = [
    ['quantity', `update ${LINE} set quantity = '9.000' where id = $1`],
    ['rate', `update ${LINE} set rate = '300.00' where id = $1`],
    ['line_total', `update ${LINE} set line_total = '3000.00' where id = $1`],
    ['item_name', `update ${LINE} set item_name = 'Chicken' where id = $1`],
    ['unit', `update ${LINE} set unit = 'g' where id = $1`],
  ];

  it("F6 RECEIVED: the seller changing a line's quantity, rate, line_total, item_name or unit is refused 42501, one column at a time, and nothing changes", async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'received' });
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => {
      const out: Record<string, PgErr | undefined> = {};
      for (const [k, q] of lineEdits) out[k] = await probe(tx, (sp) => asSql(sp).unsafe(q, [s.line1]));
      return out;
    });
    expect(r.err?.message).toBeUndefined();
    for (const [k] of lineEdits) expectRefused(r.value![k], `F6 line ${k} after receipt`, '42501');
    const [row] = await sql<{ quantity: string; rate: string; line_total: string; item_name: string; unit: string }[]>`
      select quantity, rate, line_total, item_name, unit from ${sql(LINE)} where id = ${s.line1}`;
    expect(row, 'line money and identity unchanged in the database').toEqual({ quantity: '10.000', rate: '310.00', line_total: '3100.00', item_name: 'Pork belly', unit: 'kg' });
  });

  it('F7 VOID: the same line edits are refused 42501 (quantity, line_total shown)', async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'void' });
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => ({
      quantity: await probe(tx, (sp) => asSql(sp).unsafe(lineEdits[0]![1], [s.line1])),
      line_total: await probe(tx, (sp) => asSql(sp).unsafe(lineEdits[2]![1], [s.line1])),
    }));
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.quantity, 'F7 void: quantity', '42501');
    expectRefused(r.value!.line_total, 'F7 void: line_total', '42501');
  });

  it('F8 control: while IN TRANSIT the seller may fix a line - item_name, and a sum-neutral requote (quantity 20.000 x rate 155.00 = the same 3100.00) are accepted', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => {
      const q = asSql(tx);
      const name = await q`update ${q(LINE)} set item_name = 'Pork belly (corrected)' where id = ${s.line1} returning id`;
      const req = await q`update ${q(LINE)} set quantity = '20.000', rate = '155.00' where id = ${s.line1} returning id`;
      await q`set constraints all immediate`;
      const [row] = await q<{ line_total: string; quantity: string }[]>`select line_total, quantity from ${q(LINE)} where id = ${s.line1}`;
      return { name: name.length, req: req.length, row };
    });
    expect(r.err?.message, 'a legitimate in-transit edit must not be refused').toBeUndefined();
    expect(r.value).toMatchObject({ name: 1, req: 1, row: { line_total: '3100.00', quantity: '20.000' } });
  });

  it('F9 RECEIVED: the sum-neutral requote of F8 (quantity + rate together, line_total unchanged) is refused 42501 - same edit, only the status differs', async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'received' });
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) =>
      probe(tx, (sp) => asSql(sp)`update ${asSql(sp)(LINE)} set quantity = '20.000', rate = '155.00' where id = ${s.line1}`),
    );
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value, 'F9 requote after receipt', '42501');
  });

  it('F10 the OWNER role is not bound by the freeze (positive control, like the receipt guard): an owner line edit on a received shipment is accepted', async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'received' });
    const res = await sql`update ${sql(LINE)} set item_name = 'Pork belly (owner fix)' where id = ${s.line1} returning id`;
    expect(res.length).toBe(1);
  });

  it('F11 control: the seller can still VOID an in_transit shipment (the freeze starts after the status leaves in_transit, it does not block the transition out of it)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => {
      const q = asSql(tx);
      const up = await q`update ${q(SHIP)} set status = 'void', voided_at = now(), voided_by = ${w.a.personId}, void_reason = 'sent in error' where id = ${s.shipmentId} returning id`;
      return up.length;
    });
    expect(r.err?.message, 'voiding an in_transit shipment must stay allowed').toBeUndefined();
    expect(r.value).toBe(1);
  });
});

// ================================================================================================ billed_total = sum(lines) (ruling 2)
describe("S -- billed_total must equal the sum of the lines' line_total (deferred to the end of the transaction)", () => {
  const newOrderWithLine = async (tx: Tx, w: World, total: string) => {
    const q = asSql(tx);
    const [o] = await q<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
      values (${w.a.orgId}, ${w.a.storeId}, ${w.customerA}, current_date, 'draft', ${total}, ${w.a.personId}) returning id`;
    const [l] = await q<{ id: string }[]>`
      insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
      values (${w.a.orgId}, ${o!.id}, ${w.a.stockItemId}, '10.000', 'kg', '310.00', '3100.00') returning id`;
    return { orderId: o!.id, lineId: l!.id };
  };
  const insertShipment = async (tx: Tx, w: World, orderId: string, billed: string) => {
    const [h] = await asSql(tx)<{ id: string }[]>`
      insert into inter_entity_shipments (org_id, buyer_org_id, trade_order_id, store_id, shipped_on, billed_total, status)
      values (${w.a.orgId}, ${w.b.orgId}, ${orderId}, ${w.a.storeId}, '2026-12-01', ${billed}, 'in_transit') returning id`;
    return h!.id;
  };
  const insertLine = (tx: Tx, w: World, shipmentId: string, orderLineId: string, total: string, qty: string, rate: string) =>
    asSql(tx)`
      insert into inter_entity_shipment_lines (org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total)
      values (${w.a.orgId}, ${w.b.orgId}, ${shipmentId}, ${orderLineId}, 1, 'Pork belly', 'kg', ${qty}, ${rate}, ${total})`;

  it('S1 INSERT: header billed_total 3100.00 with one line of 3000.00 (10.000 x 300.00) breaks the sum - refused 23514 at the end of the transaction', async () => {
    const w = await world();
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) =>
      probe(tx, async (sp) => {
        const o = await newOrderWithLine(sp, w, '3100.00');
        const id = await insertShipment(sp, w, o.orderId, '3100.00');
        await insertLine(sp, w, id, o.lineId, '3000.00', '10.000', '300.00');
        await asSql(sp)`set constraints all immediate`;
      }),
    );
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value, 'S1 header 3100.00 vs lines 3000.00', '23514');
  });

  it('S2 positive control for S1: header 3100.00 with a line of 3100.00 (10.000 x 310.00) passes the same flow, including a header written BEFORE its line (the check is deferred)', async () => {
    const w = await world();
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) =>
      probe(tx, async (sp) => {
        const o = await newOrderWithLine(sp, w, '3100.00');
        const id = await insertShipment(sp, w, o.orderId, '3100.00');
        await insertLine(sp, w, id, o.lineId, '3100.00', '10.000', '310.00');
        await asSql(sp)`set constraints all immediate`;
      }),
    );
    expect(r.err?.message).toBeUndefined();
    expect(r.value, 'a header whose lines add up to billed_total must be accepted').toBeUndefined();
  });

  it('S3 LATER EDIT while in_transit: the seller changes the line to 10.000 x 320.00 = 3200.00 but leaves billed_total at 3100.00 - refused 23514', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) =>
      probe(tx, async (sp) => {
        await asSql(sp)`update ${asSql(sp)(LINE)} set rate = '320.00', line_total = '3200.00' where id = ${s.line1}`;
        await asSql(sp)`set constraints all immediate`;
      }),
    );
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value, 'S3 line edited to 3200.00, header left at 3100.00', '23514');
  });

  it('S4 positive control for S3: line edited to 3200.00 AND billed_total raised to 3200.00 in the same transaction is accepted while in_transit', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => {
      const q = asSql(tx);
      await q`update ${q(LINE)} set rate = '320.00', line_total = '3200.00' where id = ${s.line1}`;
      await q`update ${q(SHIP)} set billed_total = '3200.00' where id = ${s.shipmentId}`;
      await q`set constraints all immediate`;
      const [row] = await q<{ billed_total: string }[]>`select billed_total from ${q(SHIP)} where id = ${s.shipmentId}`;
      return row!.billed_total;
    });
    expect(r.err?.message, 'a consistent in-transit correction must not be refused').toBeUndefined();
    expect(r.value).toBe('3200.00');
  });

  it('S5 HEADER-ONLY edit while in_transit: billed_total 3100.00 -> 3200.00 with the lines left at 3100.00 is refused 23514', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) =>
      probe(tx, async (sp) => {
        await asSql(sp)`update ${asSql(sp)(SHIP)} set billed_total = '3200.00' where id = ${s.shipmentId}`;
        await asSql(sp)`set constraints all immediate`;
      }),
    );
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value, 'S5 header raised alone', '23514');
  });
});

// ================================================================================================ receive_inter_entity_shipment inputs (ruling 3)
describe('V -- receive_inter_entity_shipment(): bad inputs are refused and the shipment stays untouched', () => {
  const call = (tx: Tx, shipmentId: string, lines: unknown) =>
    asSql(tx)`select receive_inter_entity_shipment(${shipmentId}::uuid, ${asSql(tx).json(lines as never)}::jsonb)`;
  const state = async (tx: Tx, shipmentId: string) => {
    const q = asSql(tx);
    const [h] = await q<{ status: string; received_total: string | null }[]>`select status, received_total from ${q(SHIP)} where id = ${shipmentId}`;
    const ls = await q<{ received_quantity: string | null }[]>`select received_quantity from ${q(LINE)} where shipment_id = ${shipmentId}`;
    return { status: h!.status, total: h!.received_total, counted: ls.filter((l) => l.received_quantity !== null).length };
  };
  const UNTOUCHED = { status: 'in_transit', total: null, counted: 0 };

  it('V0 positive control (GREEN today): counting both lines of a 2-line shipment exactly once succeeds, received_total = 3100.00 + 3.89 = 3103.89', async () => {
    const w = await world();
    const s = await newShipment(w, { lines: 2 });
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      await call(tx, s.shipmentId, [{ line_id: s.line1, received_quantity: '10.000' }, { line_id: s.line2, received_quantity: '0.500' }]);
      return state(tx, s.shipmentId);
    });
    expect(r.err?.message).toBeUndefined();
    expect(r.value).toEqual({ status: 'received', total: '3103.89', counted: 2 });
  });

  it('V1 (GREEN today) the same line listed twice is refused 22023 ("counted twice"); nothing is stamped', async () => {
    const w = await world();
    const s = await newShipment(w, { lines: 2 });
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      const e = await probe(tx, (sp) => call(sp, s.shipmentId, [{ line_id: s.line1, received_quantity: '5.000' }, { line_id: s.line1, received_quantity: '5.000' }]));
      return { e, after: await state(tx, s.shipmentId) };
    });
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.e, 'V1 duplicate line', '22023');
    expect(r.value!.e!.message).toMatch(/twice/i);
    expect(r.value!.after, 'nothing stamped').toEqual(UNTOUCHED);
  });

  it("V2 (GREEN today) a line that belongs to ANOTHER shipment in the input is refused 22023, and that other shipment's line is not stamped", async () => {
    const w = await world();
    const mine = await newShipment(w);
    const other = await newShipment(w);
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      const e = await probe(tx, (sp) => call(sp, mine.shipmentId, [{ line_id: other.line1, received_quantity: '10.000' }]));
      return { e, mine: await state(tx, mine.shipmentId), other: await state(tx, other.shipmentId) };
    });
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.e, 'V2 foreign line', '22023');
    expect(r.value!.e!.message).toMatch(/does not belong/i);
    expect(r.value!.mine).toEqual(UNTOUCHED);
    expect(r.value!.other, "the other shipment's line must not be stamped").toEqual(UNTOUCHED);
  });

  it('V3 (GREEN today) a negative quantity (-1.000) is refused 22023; nothing is stamped', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      const e = await probe(tx, (sp) => call(sp, s.shipmentId, [{ line_id: s.line1, received_quantity: '-1.000' }]));
      return { e, after: await state(tx, s.shipmentId) };
    });
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.e, 'V3 negative quantity', '22023');
    expect(r.value!.after).toEqual(UNTOUCHED);
  });

  it('V4 (GREEN today) a line missing from the input (2-line shipment, only line 1 counted) is refused 22023 ("every line"); line 1 is NOT left stamped', async () => {
    const w = await world();
    const s = await newShipment(w, { lines: 2 });
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      const e = await probe(tx, (sp) => call(sp, s.shipmentId, [{ line_id: s.line1, received_quantity: '10.000' }]));
      return { e, after: await state(tx, s.shipmentId) };
    });
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.e, 'V4 missing line', '22023');
    expect(r.value!.e!.message).toMatch(/every line/i);
    expect(r.value!.after, 'a half-counted receipt must not persist').toEqual(UNTOUCHED);
  });

  it('V5 (GREEN today) receiving a VOID shipment is refused 23514 naming the cancellation; nothing is stamped', async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'void' });
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      const e = await probe(tx, (sp) => call(sp, s.shipmentId, [{ line_id: s.line1, received_quantity: '10.000' }]));
      const q = asSql(tx);
      const [h] = await q<{ status: string }[]>`select status from ${q(SHIP)} where id = ${s.shipmentId}`;
      const [l] = await q<{ received_quantity: string | null }[]>`select received_quantity from ${q(LINE)} where id = ${s.line1}`;
      return { e, status: h!.status, rq: l!.received_quantity };
    });
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.e, 'V5 void shipment', '23514');
    expect(r.value!.e!.message).toMatch(/cancel/i);
    expect(r.value!).toMatchObject({ status: 'void', rq: null });
  });

  it('V6 (GREEN today) an empty list [], a non-array and a quantity with 4 decimals (1.0005) are all refused 22023; nothing is stamped', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => ({
      empty: await probe(tx, (sp) => call(sp, s.shipmentId, [])),
      notArray: await probe(tx, (sp) => call(sp, s.shipmentId, { line_id: s.line1 })),
      fine4: await probe(tx, (sp) => call(sp, s.shipmentId, [{ line_id: s.line1, received_quantity: '1.0005' }])),
      after: await state(tx, s.shipmentId),
    }));
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.empty, 'V6 empty list', '22023');
    expectRefused(r.value!.notArray, 'V6 non-array', '22023');
    expectRefused(r.value!.fine4, 'V6 four decimals', '22023');
    expect(r.value!.after).toEqual(UNTOUCHED);
  });
});

// ================================================================================================ audit round 2
describe('audit round 2 -- status loop, lines on frozen shipments, sum check under another org context, zero-line receipt', () => {
  const zeroLine = (w: World, shipmentId: string, orderLineId: string, lineNo: number, amount = '0.00') =>
    `insert into ${LINE} (org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total)
     values ('${w.a.orgId}', '${w.b.orgId}', '${shipmentId}', '${orderLineId}', ${lineNo}, 'Extra', 'kg', '1.000', '${amount}', '${amount}')`;

  it('A1a (HIGH) VOID shipment: the seller (shareat_app) setting status back to in_transit with the void columns cleared is refused 42501; the money edit is STILL refused afterwards; control: in_transit -> void by the seller still works', async () => {
    const w = await world();
    const v = await newShipment(w, { state: 'void' });
    const fresh = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => {
      const q = asSql(tx);
      const loop = await probe(tx, (sp) => asSql(sp)`
        update ${asSql(sp)(SHIP)} set status = 'in_transit', voided_at = null, voided_by = null, void_reason = null where id = ${v.shipmentId}`);
      const money = await probe(tx, (sp) => asSql(sp)`update ${asSql(sp)(SHIP)} set billed_total = '3200.00' where id = ${v.shipmentId}`);
      const [row] = await q<{ status: string }[]>`select status from ${q(SHIP)} where id = ${v.shipmentId}`;
      const voidOk = await q`update ${q(SHIP)} set status = 'void', voided_at = now(), voided_by = ${w.a.personId}, void_reason = 'x' where id = ${fresh.shipmentId} returning id`;
      return { loop, money, status: row!.status, voidOk: voidOk.length };
    });
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.loop, 'A1a void -> in_transit by the app role', '42501');
    expectRefused(r.value!.money, 'A1a money edit on the same void shipment', '42501');
    expect(r.value!.status, 'still void').toBe('void');
    expect(r.value!.voidOk, 'control: in_transit -> void still works').toBe(1);
  });

  it('A1b (HIGH) RECEIVED shipment: the seller setting status back to in_transit (receipt columns cleared) is refused 42501 BY THE FREEZE, not by the receipt guard (whose message says "receiving organisation")', async () => {
    const w = await world();
    const s = await newShipment(w, { state: 'received' });
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) =>
      probe(tx, (sp) => asSql(sp)`
        update ${asSql(sp)(SHIP)} set status = 'in_transit', received_at = null, received_by = null, received_total = null where id = ${s.shipmentId}`),
    );
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value, 'A1b received -> in_transit by the app role', '42501');
    expect(r.value!.message, 'must be the freeze refusal, not the incidental receipt-guard one').not.toMatch(/receiving organisation/i);
  });

  it('A2a (MEDIUM) the seller INSERTing a zero-total line (qty 1, rate 0.00) into a RECEIVED or a VOID shipment is refused 42501; the same INSERT into an in_transit shipment succeeds (control)', async () => {
    const w = await world();
    const rec = await newShipment(w, { state: 'received' });
    const vd = await newShipment(w, { state: 'void' });
    const tr = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => ({
      rec: await probe(tx, (sp) => asSql(sp).unsafe(zeroLine(w, rec.shipmentId, rec.orderLine1, 2))),
      vd: await probe(tx, (sp) => asSql(sp).unsafe(zeroLine(w, vd.shipmentId, vd.orderLine1, 2))),
      tr: await probe(tx, async (sp) => {
        await asSql(sp).unsafe(zeroLine(w, tr.shipmentId, tr.orderLine1, 2));
        await asSql(sp)`set constraints all immediate`;
      }),
    }));
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.rec, 'A2a insert into a received shipment', '42501');
    expectRefused(r.value!.vd, 'A2a insert into a void shipment', '42501');
    expect(r.value!.tr, 'control: the same insert into an in_transit shipment is accepted (sum unchanged at 3100.00)').toBeUndefined();
  });

  it('A2b (MEDIUM) moving an in_transit shipment zero-total line INTO a received shipment (UPDATE shipment_id) is refused 42501; moving it into another in_transit shipment is accepted (control)', async () => {
    const w = await world();
    const src = await newShipment(w);
    const rec = await newShipment(w, { state: 'received' });
    const dst = await newShipment(w);
    const [zl] = await sql<{ id: string }[]>`
      insert into inter_entity_shipment_lines (org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total)
      values (${w.a.orgId}, ${w.b.orgId}, ${src.shipmentId}, ${src.orderLine1}, 5, 'Extra', 'kg', '1.000', '0.00', '0.00') returning id`;
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => ({
      intoReceived: await probe(tx, (sp) => asSql(sp)`update ${asSql(sp)(LINE)} set shipment_id = ${rec.shipmentId} where id = ${zl!.id}`),
      intoTransit: await probe(tx, async (sp) => {
        await asSql(sp)`update ${asSql(sp)(LINE)} set shipment_id = ${dst.shipmentId} where id = ${zl!.id}`;
        await asSql(sp)`set constraints all immediate`;
      }),
    }));
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.intoReceived, 'A2b moving a line into a received shipment', '42501');
    expect(r.value!.intoTransit, 'control: moving a zero line between in_transit shipments is accepted').toBeUndefined();
  });

  it('A3a (MEDIUM) the sum check does not fail open: a line insert that breaks the sum, then the session org context switched to an unrelated org (header invisible under RLS), is STILL refused 23514 at commit; control: a sum-neutral insert under the same switch passes', async () => {
    const w = await world();
    const c = await menuFixture('s5cu');
    const s = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => {
      const bad = await probe(tx, async (sp) => {
        await asSql(sp).unsafe(zeroLine(w, s.shipmentId, s.orderLine1, 2, '5.00'));
        await asSql(sp)`select set_config('app.org_id', ${c.orgId}, true)`;
        await asSql(sp)`set constraints all immediate`;
      });
      const good = await probe(tx, async (sp) => {
        await asSql(sp).unsafe(zeroLine(w, s.shipmentId, s.orderLine1, 3));
        await asSql(sp)`select set_config('app.org_id', ${c.orgId}, true)`;
        await asSql(sp)`set constraints all immediate`;
      });
      return { bad, good };
    });
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value!.bad, 'A3a sum broken (3100.00 vs 3105.00), checked under an org context that cannot see the shipment', '23514');
    expect(r.value!.good, 'control: a sum-neutral insert passes under the same context switch').toBeUndefined();
  });

  it('A3b (MEDIUM) same for a header-only billed_total change (3100.00 -> 3200.00) checked with app.org_id cleared (no org context): refused 23514', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) =>
      probe(tx, async (sp) => {
        await asSql(sp)`update ${asSql(sp)(SHIP)} set billed_total = '3200.00' where id = ${s.shipmentId}`;
        await asSql(sp)`select set_config('app.org_id', '', true)`;
        await asSql(sp)`set constraints all immediate`;
      }),
    );
    expect(r.err?.message).toBeUndefined();
    expectRefused(r.value, 'A3b broken header checked with no org context', '23514');
  });

  it('A4 (LOW) receiving a shipment that has ZERO lines is refused 22023 and stamps nothing; control: a normal full receipt in the same session still passes', async () => {
    const w = await world();
    const orphan = await sql.begin(async (tx) => {
      const t = asSql(tx);
      const [o] = await t<{ id: string }[]>`
        insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
        values (${w.a.orgId}, ${w.a.storeId}, ${w.customerA}, current_date, 'draft', '3100.00', ${w.a.personId}) returning id`;
      const [h] = await t<{ id: string }[]>`
        insert into inter_entity_shipments (org_id, buyer_org_id, trade_order_id, store_id, shipped_on, billed_total, status)
        values (${w.a.orgId}, ${w.b.orgId}, ${o!.id}, ${w.a.storeId}, '2026-12-01', '3100.00', 'in_transit') returning id`;
      return h!.id;
    });
    const ok = await newShipment(w);
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      const q = asSql(tx);
      const e = await probe(tx, (sp) => asSql(sp)`select receive_inter_entity_shipment(${orphan}::uuid, '[]'::jsonb)`);
      const [h] = await q<{ status: string; received_total: string | null }[]>`select status, received_total from ${q(SHIP)} where id = ${orphan}`;
      await q`select receive_inter_entity_shipment(${ok.shipmentId}::uuid, ${q.json([{ line_id: ok.line1, received_quantity: '10.000' }] as never)}::jsonb)`;
      return { e, h };
    });
    expect(r.err?.message, 'control: the normal receipt must still work').toBeUndefined();
    expectRefused(r.value!.e, 'A4 zero-line shipment received', '22023');
    expect(r.value!.h, 'nothing stamped').toEqual({ status: 'in_transit', received_total: null });
  });
});
