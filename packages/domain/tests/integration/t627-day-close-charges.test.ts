import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-627 (test 3) - a day with store charges reconciles, `sales_days.other_charges` = the sum of the receipts' charges, and verifying it posts them to 4500
 * through the EXISTING sale.mixed pattern (no new posting pattern). docs/tasks/627-pos-charges.md "Day close".
 *
 * The day: ONE receipt, 2 pork (500.00) + Leftover 3 x 100.00 (per unit) + Corkage 50.00 (custom), amount due 850.00, paid 1,000.00 cash (change 150.00); a SECOND
 * receipt, 1 pork (250.00) + Extra griller 150.00 (once per bill), paid 400.00 cash. Charges 500.00, billed (gross) 1,250.00, subtotal 750.00.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { verifySalesDay } from '@shareat/domain';
import { sendV1Bridge } from '../../src/pos';
import { D1, asOrg, close, closeAll, fakeWriter, journalLines, manila, pinOf, reading, salesDaysOf, sell, sql, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const AT = manila(D1, '22:30');

async function presets(w: World) {
  const mk = async (name: string, amount: string, perUnit: boolean) =>
    (await sql<{ id: string }[]>`insert into pos_charge_presets (org_id, store_id, name, amount, per_unit, created_by) values (${w.orgId}, ${w.storeId}, ${name}, ${amount}, ${perUnit}, ${w.adminId}) returning id`)[0]!.id;
  return { leftover: await mk('Leftover', '100.00', true), griller: await mk('Extra griller', '150.00', false) };
}

async function chargedDay(w: World) {
  const p = await presets(w);
  const r1 = await sell(w, {
    at: manila(D1, '19:00'), items: [{ item: w.menu.pork, qty: 2 }], expectTotal: '500.00',
    charges: [{ presetId: p.leftover, qty: 3 }, { name: 'Corkage', unitAmount: '50.00' }],
    pay: [{ tenderId: w.cash, amount: '1000.00' }],
  });
  const r2 = await sell(w, {
    at: manila(D1, '20:00'), items: [{ item: w.menu.pork, qty: 1 }], expectTotal: '250.00',
    charges: [{ presetId: p.griller }],
    pay: [{ tenderId: w.cash, amount: '400.00' }],
  });
  return { p, r1, r2 };
}

describe('T-627 day close with store charges', () => {
  it('the receipt keeps total = subtotal - discounts, holds charge_total and its charge rows; the amount due was total + charges', async () => {
    const w = await world();
    const { r1, r2 } = await chargedDay(w);
    expect(r1).toMatchObject({ total: '500.00', chargeTotal: '350.00' });
    expect(r2).toMatchObject({ total: '250.00', chargeTotal: '150.00' });
    const rec = await sql<{ id: string; total: string; charge_total: string }[]>`select id, total::text, charge_total::text from pos_sales_receipts where id = ${r1.receiptId}`;
    expect(rec[0]).toMatchObject({ total: '500.00', charge_total: '350.00' });
    const rows = await sql<{ name: string; qty: number; unit_amount: string; amount: string; preset_id: string | null }[]>`
      select name, qty, unit_amount::text, amount::text, preset_id from pos_sales_receipt_charges where receipt_id = ${r1.receiptId} order by charge_no`;
    expect(rows.map((r) => [r.name, r.qty, r.unit_amount, r.amount, r.preset_id !== null])).toEqual([
      ['Leftover', 3, '100.00', '300.00', true],
      ['Corkage', 1, '50.00', '50.00', false],
    ]);
    // paid 1000 for 850: change 150, not a short payment
    expect(await sql`select 1 from audit_log where org_id = ${w.orgId} and action in ('pos.sale_payment_variance', 'pos.sale_payment_shortfall', 'pos.sale_recompute_mismatch')`).toHaveLength(0);
  });

  it('the X reading: chargeTotal is the sum, gross is what was billed (total + charges), and tenders add up to it', async () => {
    const w = await world();
    await chargedDay(w);
    const x = await reading(w, AT);
    expect(x).toMatchObject({ receiptCount: 2, subtotal: '750.00', discountTotal: '0.00', chargeTotal: '500.00', grossTotal: '1250.00' });
    // cash taken 1000 + 400, change 150 given: net 1250 = gross
    const net = (Array.isArray(x.byTender) ? x.byTender.map((t) => t.amount) : Object.values(x.byTender)).reduce((a, s) => a + Math.round(Number(s) * 100), 0);
    expect(net).toBe(125000);
  });

  it('the Z derives a sales day that reconciles: other_charges = 500.00, total_sales = 750.00 (before charges), cash collected 1,250.00', async () => {
    const w = await world();
    await chargedDay(w);
    const res = await close(w, AT, await pinOf(w, w.managerId));
    expect(res.salesDayId).not.toBeNull();
    const [day] = await sql<{ other_charges: string; total_sales: string; cash_collected: string; service_charge: string; source: string; status: string }[]>`
      select other_charges::text, total_sales::text, cash_collected::text, service_charge::text, source, status from sales_days where id = ${res.salesDayId!}`;
    expect(day).toMatchObject({ source: 'pos_receipts', status: 'submitted', other_charges: '500.00', total_sales: '750.00', cash_collected: '1250.00', service_charge: '0.00' });
    const [z] = await sql<{ gross_total: string }[]>`select gross_total::text from pos_day_closes where id = ${res.dayCloseId}`;
    expect(z!.gross_total).toBe('1250.00');
    expect(await salesDaysOf(w)).toHaveLength(1);
  });

  it('verifying the day posts the charges to 4500 through the existing sale.mixed pattern, and the entry balances', async () => {
    const w = await world();
    await chargedDay(w);
    await close(w, AT, await pinOf(w, w.managerId));
    const [d] = await salesDaysOf(w);
    const res = await asOrg(w.orgId, (tx) => verifySalesDay(tx, w.manager, d!.id));
    const lines = await journalLines(res.journalEntryId);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ['1110', '1250.00', '0.00'],
      ['4150', '0.00', '750.00'],
      ['4500', '0.00', '500.00'],
    ]);
    const cents = (s: string) => Math.round(Number(s) * 100);
    expect(lines.reduce((a, l) => a + cents(l.debit), 0)).toBe(lines.reduce((a, l) => a + cents(l.credit), 0));
  });

  it('the December bridge document carries the Z charges as chargesTotal, inside totalGross', async () => {
    const w = await world();
    await chargedDay(w);
    await close(w, AT, await pinOf(w, w.managerId));
    const f = fakeWriter();
    const out = await asOrg(w.orgId, (tx) => sendV1Bridge(tx, w.counter, { storeId: w.storeId, businessDates: [D1] }, { writer: f.writer }));
    expect(out.results[0]).toMatchObject({ status: 'sent' });
    const payments = (f.calls[0]!.data as { payments: { chargesTotal: number; totalGross: number } }).payments;
    expect(payments).toMatchObject({ chargesTotal: 500, totalGross: 1250 });
  });

  it('a charged receipt where only the goods were paid is a short payment of exactly the charges: the Z reads it, the tenders add up, and the day closes', async () => {
    const w = await world();
    const p = await presets(w);
    // 2 pork 500.00 + Extra griller 150.00 = 650.00 due, 500.00 paid in cash
    await sell(w, { at: manila(D1, '19:00'), items: [{ item: w.menu.pork, qty: 2 }], expectTotal: '500.00', charges: [{ presetId: p.griller }], pay: [{ tenderId: w.cash, amount: '500.00' }] });
    const x = await reading(w, AT);
    expect(x).toMatchObject({ receiptCount: 1, chargeTotal: '150.00', grossTotal: '650.00', varianceTotal: '150.00', shortfallCount: 1 });
    const res = await close(w, AT, await pinOf(w, w.managerId));
    const [day] = await sql<{ other_charges: string; cash_collected: string }[]>`select other_charges::text, cash_collected::text from sales_days where id = ${res.salesDayId!}`;
    expect(day).toEqual({ other_charges: '150.00', cash_collected: '500.00' });
    const [shortAudit] = await sql<{ after: { gap: string; serverTotal: string; deviceTotal: string } }[]>`select after from audit_log where org_id = ${w.orgId} and action in ('pos.sale_payment_variance', 'pos.sale_payment_shortfall')`;
    // like with like: the device's amount due (goods + charges) against the server's
    expect(shortAudit!.after).toMatchObject({ gap: '150.00', serverTotal: '650.00', deviceTotal: '650.00' });
  });

  it('a day without charges is unchanged: other_charges 0.00 and no 4500 line', async () => {
    const w = await world();
    await sell(w, { at: manila(D1, '19:00'), items: [{ item: w.menu.pork, qty: 1 }], expectTotal: '250.00', pay: [{ tenderId: w.cash, amount: '250.00' }] });
    const res = await close(w, AT, await pinOf(w, w.managerId));
    const [day] = await sql<{ other_charges: string }[]>`select other_charges::text from sales_days where id = ${res.salesDayId!}`;
    expect(day!.other_charges).toBe('0.00');
    const verified = await asOrg(w.orgId, (tx) => verifySalesDay(tx, w.manager, res.salesDayId!));
    expect((await journalLines(verified.journalEntryId)).map((l) => l.code)).not.toContain('4500');
  });
});
