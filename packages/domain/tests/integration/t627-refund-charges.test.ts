import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-627 (refund part) - a refund gives back the receipt's store charges ONLY when the cashier ticks them (default: not), once per receipt, with at least one item;
 * the money going back is then items + charges, the Z still reconciles, and the receipts view says how much charge is left to refund. docs/tasks/627-pos-charges.md "Refunds".
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { RefusalError } from '@shareat/db';
import { listTodaysSalesReceipts, recordRefund } from '../../src';
import { REFUND_NO_CHARGES } from '../../src/pos/refund';
import { D1, asOrg, close, closeAll, manila, pinOf, reading, sell, sql, uuid, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const AT = manila(D1, '22:30');

/** 2 pork (500.00) + Leftover 3 x 100.00 (per unit): amount due 800.00, paid 800.00 cash. */
async function receipt(w: World) {
  const preset = (await sql<{ id: string }[]>`insert into pos_charge_presets (org_id, store_id, name, amount, per_unit, created_by) values (${w.orgId}, ${w.storeId}, 'Leftover', '100.00', true, ${w.adminId}) returning id`)[0]!.id;
  const s = await sell(w, { at: manila(D1, '19:00'), items: [{ item: w.menu.pork, qty: 2 }], expectTotal: '500.00', charges: [{ presetId: preset, qty: 3 }], pay: [{ tenderId: w.cash, amount: '800.00' }] });
  const lines = await sql<{ id: string }[]>`select id from pos_sales_receipt_lines where receipt_id = ${s.receiptId} order by line_no`;
  const pays = await sql<{ id: string }[]>`select id from pos_sales_receipt_payments where receipt_id = ${s.receiptId}`;
  return { receiptId: s.receiptId, lineId: lines[0]!.id, payId: pays[0]!.id };
}
const refund = (w: World, r: Awaited<ReturnType<typeof receipt>>, o: { qty?: number; amount: string; charges?: boolean; requestId?: string }) =>
  asOrg(w.orgId, (tx) =>
    recordRefund(tx, w.manager, {
      storeId: w.storeId, pairingId: w.pairingId, requestId: o.requestId ?? uuid(), receiptId: r.receiptId, lines: [{ receiptLineId: r.lineId, qty: o.qty ?? 1 }],
      payments: [{ paymentId: r.payId, amount: o.amount }], reason: 'Customer returned it', ...(o.charges ? { refundCharges: true } : {}),
    }),
  );

describe('T-627 refund with store charges', () => {
  it('default: the charges are NOT refunded (an item alone gives back its own money only)', async () => {
    const w = await world();
    const r = await receipt(w);
    const out = await refund(w, r, { amount: '250.00' });
    expect(out.total).toBe('250.00');
    const [row] = await sql<{ charges_amount: string }[]>`select charges_amount::text from pos_refunds where id = ${out.id}`;
    expect(row!.charges_amount).toBe('0.00');
    expect(out.slip.charges).toBe('0.00');
  });

  it('ticked: the money back is the item plus ALL the charges, the slip says so, and a second refund cannot take them again', async () => {
    const w = await world();
    const r = await receipt(w);
    // the item (250.00) + the charges (300.00) = 550.00 back in cash
    await expect(refund(w, r, { amount: '250.00', charges: true })).rejects.toBeInstanceOf(RefusalError); // money back must equal the total: 550.00
    const out = await refund(w, r, { amount: '550.00', charges: true });
    expect(out.total).toBe('550.00');
    expect(out.slip.charges).toBe('300.00');
    const [row] = await sql<{ charges_amount: string; total: string }[]>`select charges_amount::text, total::text from pos_refunds where id = ${out.id}`;
    expect(row).toEqual({ charges_amount: '300.00', total: '550.00' });
    const again = await refund(w, r, { amount: '550.00', charges: true }).then(() => null, (e: unknown) => e);
    expect((again as RefusalError).userMessage).toBe(REFUND_NO_CHARGES);
    // the other item can still be refunded without charges
    const next = await refund(w, r, { amount: '250.00' });
    expect(next.total).toBe('250.00');
  });

  it('the receipts view says how much charge is still refundable: all, then none once refunded', async () => {
    const w = await world();
    const r = await receipt(w);
    const view = async () => (await asOrg(w.orgId, (tx) => listTodaysSalesReceipts(tx, w.counter, { storeId: w.storeId }))).receipts.find((x) => x.receiptId === r.receiptId)!;
    expect(await view()).toMatchObject({ chargeTotal: '300.00', chargesLeft: '300.00', charges: [{ name: 'Leftover', qty: 3, amount: '300.00' }] });
    await refund(w, r, { amount: '550.00', charges: true });
    expect((await view()).chargesLeft).toBe('0.00');
  });

  it('the Z still reconciles: refunded charges come out of the cash, sales_days keeps other_charges whole and refunds carries the whole refund', async () => {
    const w = await world();
    const r = await receipt(w);
    await refund(w, r, { amount: '550.00', charges: true });
    const x = await reading(w, AT);
    expect(x).toMatchObject({ receiptCount: 1, chargeTotal: '300.00', grossTotal: '800.00' });
    expect(x.refunds).toMatchObject({ total: '550.00', count: 1 });
    const res = await close(w, AT, await pinOf(w, w.managerId));
    const [day] = await sql<{ other_charges: string; refunds: string; cash_collected: string }[]>`select other_charges::text, refunds::text, cash_collected::text from sales_days where id = ${res.salesDayId!}`;
    expect(day).toEqual({ other_charges: '300.00', refunds: '550.00', cash_collected: '250.00' }); // 800 taken, 550 given back
  });

  it('a receipt with no charges refuses the tick with a sentence, and nothing is written', async () => {
    const w = await world();
    const s = await sell(w, { at: manila(D1, '19:00'), items: [{ item: w.menu.pork, qty: 2 }], expectTotal: '500.00', pay: [{ tenderId: w.cash, amount: '500.00' }] });
    const lines = await sql<{ id: string }[]>`select id from pos_sales_receipt_lines where receipt_id = ${s.receiptId}`;
    const pays = await sql<{ id: string }[]>`select id from pos_sales_receipt_payments where receipt_id = ${s.receiptId}`;
    const err = await refund(w, { receiptId: s.receiptId, lineId: lines[0]!.id, payId: pays[0]!.id }, { amount: '250.00', charges: true }).then(() => null, (e: unknown) => e);
    expect((err as RefusalError).userMessage).toBe(REFUND_NO_CHARGES);
    expect(await sql`select 1 from pos_refunds where org_id = ${w.orgId}`).toHaveLength(0);
  });
});
