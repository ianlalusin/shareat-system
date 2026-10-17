import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb } from '@shareat/db';
import { voidTradeOrder } from '@shareat/domain';
import { api, asOrg, audit, buyer, dispatch, fixture, freezeClock, internalOrder, orderWorth, sayOf, thawClock, type Fx } from './_fixtures/t433-b2b';

/**
 * T-433 S2 (TESTER) - the BIR booklet invoice number on a trade order. Cases 26-29. Mutants M26..M29.
 *
 * ACCEPTABLE RED REASON (spec, tester brief): `trade_orders.bir_invoice_no` does not exist until the
 * builder's migration 0203 - the cases that read the column fail with "column does not exist" today.
 * The refusal cases (28 closed month, 29 draft/internal/staff) fail because setBirInvoiceNo does not exist.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });

beforeAll(() => freezeClock());
afterAll(async () => {
  thawClock();
  await closeDb();
  await sql.end({ timeout: 5 });
});

const setNo = (f: Fx, who: Fx['manager'], orderId: string, value: string) =>
  asOrg(f.orgId, (tx) => api.setBirInvoiceNo(tx, who, { orderId, value }));
const stored = async (orderId: string) =>
  (await sql<{ v: string | null }[]>`select bir_invoice_no as v from trade_orders where id = ${orderId}`)[0]!.v;

async function dispatched(f: Fx, opts: { orderDate?: string; referenceNo?: string } = {}) {
  const customerId = await buyer(sql, f);
  const o = await orderWorth(sql, f, customerId, '1000.00', opts);
  await dispatch(f, f.manager, o.orderId);
  return { ...o, customerId };
}

describe('S2 BIR invoice number', () => {
  it('26. setting "001234" stores it, appends one trade_order.bir_invoice_set row with before/after; a blank clears it (M26: no append)', async () => {
    const f = await fixture(sql, 's2c26');
    const o = await dispatched(f);
    await setNo(f, f.manager, o.orderId, '  001234 '); // trimmed
    expect(await stored(o.orderId)).toBe('001234');
    const rows = await audit(sql, f.orgId, 'trade_order.bir_invoice_set');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'trade_orders', entity_id: o.orderId, actor_person_id: f.manager.personId });
    expect(JSON.stringify(rows[0]!.after)).toContain('001234');
    expect(JSON.stringify(rows[0]!.before ?? null)).not.toContain('001234');
    // a blank clears it, and that change is audited too
    await setNo(f, f.manager, o.orderId, '   ');
    expect(await stored(o.orderId)).toBeNull();
    const rows2 = await audit(sql, f.orgId, 'trade_order.bir_invoice_set');
    expect(rows2).toHaveLength(2);
    expect(JSON.stringify(rows2[1]!.before)).toContain('001234');
  });

  it('27. the same number on a second order is refused with exactly R6 (the refusal, not the SQL unique error) (M27: drop the unique index)', async () => {
    const f = await fixture(sql, 's2c27');
    const first = await dispatched(f, { referenceNo: 'WO-100' });
    const second = await dispatched(f, { referenceNo: 'WO-200' });
    await setNo(f, f.manager, first.orderId, '001234');
    const r = await sayOf(setNo(f, f.manager, second.orderId, '001234'));
    expect(r.said).toBe('Invoice no. 001234 is already on order WO-100.');
    expect(r.message).not.toMatch(/duplicate key|unique constraint/i);
    expect(await stored(second.orderId)).toBeNull();
    // control: a different number is fine, and the same order may re-save its own number
    await setNo(f, f.manager, second.orderId, '001235');
    await setNo(f, f.manager, first.orderId, '001234');
  });

  it("28. an order in a closed month: the closed-period sentence, value unchanged (M28: drop the period check)", async () => {
    const f = await fixture(sql, 's2c28');
    const o = await dispatched(f, { orderDate: '2026-01-10' });
    await setNo(f, f.manager, o.orderId, '000777');
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on <= '2026-01-01'`;
    const r = await sayOf(setNo(f, f.manager, o.orderId, '000888'));
    expect(r.said ?? r.message).toMatch(/January 2026 is closed/);
    expect(await stored(o.orderId)).toBe('000777');
    expect(await audit(sql, f.orgId, 'trade_order.bir_invoice_set')).toHaveLength(1);
  });

  it('29. a draft or an internal order is refused, and staff get the approve_buyer refusal (M29: allow on drafts)', async () => {
    const f = await fixture(sql, 's2c29');
    const customerId = await buyer(sql, f);
    const draft = await orderWorth(sql, f, customerId, '1000.00');
    await expect(setNo(f, f.manager, draft.orderId, '000100')).rejects.toThrow();
    expect(await stored(draft.orderId)).toBeNull();

    const internal = await internalOrder(sql, f);
    await dispatch(f, f.manager, internal.orderId);
    await expect(setNo(f, f.manager, internal.orderId, '000101')).rejects.toThrow();
    expect(await stored(internal.orderId)).toBeNull();

    const live = await dispatched(f);
    const r = await sayOf(setNo(f, f.staff, live.orderId, '000102'));
    expect(r.message).toMatch(/may not 'approve_buyer'/);
    expect(await stored(live.orderId)).toBeNull();
    // control: the manager can on the dispatched sale
    await setNo(f, f.manager, live.orderId, '000102');
    expect(await stored(live.orderId)).toBe('000102');
    expect(await audit(sql, f.orgId, 'trade_order.bir_invoice_set')).toHaveLength(1);
  });

  it('B. voiding an order clears its bir_invoice_no, so the same booklet number can go on a new order', async () => {
    const f = await fixture(sql, 's2gB');
    const first = await dispatched(f, { referenceNo: 'WO-1' });
    await setNo(f, f.manager, first.orderId, '004321');
    await asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.manager, { orderId: first.orderId, reason: 'wrong buyer' }));
    expect(await stored(first.orderId)).toBeNull();
    const second = await dispatched(f, { referenceNo: 'WO-2' });
    await setNo(f, f.manager, second.orderId, '004321');
    expect(await stored(second.orderId)).toBe('004321');
  });

  it('C. two concurrent setBirInvoiceNo with the same number on different orders: the loser gets R6, not a raw SQL error', async () => {
    const f = await fixture(sql, 's2gC');
    const a = await dispatched(f, { referenceNo: 'WO-A' });
    const b = await dispatched(f, { referenceNo: 'WO-B' });
    let releaseFirst!: () => void;
    const hold = new Promise<void>((res) => { releaseFirst = res; });
    let firstSet!: () => void;
    const done = new Promise<void>((res) => { firstSet = res; });
    const first = asOrg(f.orgId, async (tx) => {
      await api.setBirInvoiceNo(tx, f.manager, { orderId: a.orderId, value: '009999' });
      firstSet();
      await hold;
    });
    await done;
    const second = sayOf(setNo(f, f.manager, b.orderId, '009999')).then(
      (x) => ({ refused: true as const, x }),
      (e: Error) => ({ refused: false as const, message: e.message }),
    );
    await new Promise((res) => setTimeout(res, 1500));
    releaseFirst();
    await first;
    const r2 = await second;
    expect(r2.refused, 'the loser must be refused').toBe(true);
    const x = (r2 as { x: { said: string | null; message: string } }).x;
    expect(x.said).toBe('Invoice no. 009999 is already on order WO-A.');
    expect(x.message).not.toMatch(/duplicate key|unique constraint/i);
    expect(await stored(b.orderId)).toBeNull();
  });
});
