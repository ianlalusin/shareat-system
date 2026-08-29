import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { money } from '@shareat/core/money';
import { closeDb, transaction } from '@shareat/db';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { postReceiptValue } from '../../src/stock/receipt-posting';
import { linkInvoiceToReceipt } from '../../src/stock/invoice-link';
import { quantity } from '../../src/stock/quantity';

/**
 * T-163 — the receipt posts its value, and the invoice corrects it.
 *
 * ⭐ The point of every case here is one sentence: **the books are never blind about stock that is
 * physically on the shelf.** ADR-009 measured the alternative at 76% coverage in the worst month,
 * and found the gap is worst for the newest stock — which is the stock a count actually finds.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, storeA: string, personA: string, supplierA: string;

/** Balances by account code for one org — what every assertion below reads. */
async function balances(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, coalesce(sum(l.debit) - sum(l.credit), 0)::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgA}
    group by a.code order by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

beforeEach(async () => {
  await sql`
    truncate table stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      journal_lines, journal_entries, fiscal_periods, audit_log,
      supplier_invoice_lines, supplier_invoices, suppliers,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgA},'A1','A One') returning id`;
  storeA = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  personA = p!.id;
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgA},'Acme Meats',${personA}) returning id`;
  supplierA = sup!.id;
  await seedChartOfAccounts(sql, orgA);
  // ⚠️ `postEntry` REFUSES a date no fiscal period covers, where T-161's movement trigger tolerates
  // one. Not a contradiction: a value-moving receipt writes the movement AND the entry in one
  // transaction, so the stricter of the two governs. Only a transfer — which posts nothing — can
  // happen outside a period at all.
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            values (${orgA},'2026-08-01','2026-08-31','open')`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-163 — a receipt is never costless', () => {
  it('⭐ posts Dr 1310 / Cr 2120 at the typed landed cost, before any invoice exists', async () => {
    const res = await transaction((tx) =>
      postReceiptValue(tx, {
        orgId: orgA,
        storeId: storeA,
        receiptId: crypto.randomUUID(),
        receivedOn: '2026-08-20',
        lines: [{ itemId: crypto.randomUUID(), itemKind: 'raw_material', lineCost: money('30000.00') }],
        postedBy: personA,
      }),
    );
    expect(res.ok).toBe(true);

    const b = await balances();
    expect(b['1310']).toBe('30000.00');
    // ⚠️ Credit balance, so the net is negative — a real liability, not accounts payable.
    expect(b['2120']).toBe('-30000.00');
    expect(b['2110']).toBeUndefined();
  });

  it('routes by the item’s kind — a supply lands in 1320, not 1310', async () => {
    await transaction((tx) =>
      postReceiptValue(tx, {
        orgId: orgA, storeId: storeA, receiptId: crypto.randomUUID(), receivedOn: '2026-08-20',
        lines: [
          { itemId: crypto.randomUUID(), itemKind: 'raw_material', lineCost: money('100.00') },
          { itemId: crypto.randomUUID(), itemKind: 'supply', lineCost: money('40.00') },
        ],
      }),
    );
    const b = await balances();
    expect(b['1310']).toBe('100.00');
    expect(b['1320']).toBe('40.00');
    expect(b['2120']).toBe('-140.00');
  });

  it('⛔ an unmapped item kind BLOCKS rather than guessing an account', async () => {
    const res = await transaction((tx) =>
      postReceiptValue(tx, {
        orgId: orgA, storeId: storeA, receiptId: crypto.randomUUID(), receivedOn: '2026-08-20',
        lines: [{ itemId: crypto.randomUUID(), itemKind: 'spaceship', lineCost: money('1.00') }],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('spaceship');
    expect(await balances()).toEqual({});
  });

  it('is idempotent — a retried receipt posts once', async () => {
    const receiptId = crypto.randomUUID();
    const input = {
      orgId: orgA, storeId: storeA, receiptId, receivedOn: '2026-08-20',
      lines: [{ itemId: crypto.randomUUID(), itemKind: 'raw_material', lineCost: money('500.00') }],
    };
    const first = await transaction((tx) => postReceiptValue(tx, input));
    const second = await transaction((tx) => postReceiptValue(tx, input));
    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(false);
    expect((await balances())['1310']).toBe('500.00');
  });

  it('⛔ refuses a receipt into a CLOSED period', async () => {
    await sql`update fiscal_periods set status = 'closed' where org_id = ${orgA}`;
    await expect(
      transaction((tx) =>
        postReceiptValue(tx, {
          orgId: orgA, storeId: storeA, receiptId: crypto.randomUUID(), receivedOn: '2026-08-20',
          lines: [{ itemId: crypto.randomUUID(), itemKind: 'raw_material', lineCost: money('1.00') }],
        }),
      ),
    ).rejects.toThrow(/period/i);
  });
});

describe('T-163 — the invoice CORRECTS a number that already exists', () => {
  const receiptId = crypto.randomUUID();

  async function receive(total: string) {
    await transaction((tx) =>
      postReceiptValue(tx, {
        orgId: orgA, storeId: storeA, receiptId, receivedOn: '2026-08-20',
        lines: [{ itemId: crypto.randomUUID(), itemKind: 'raw_material', lineCost: money(total) }],
      }),
    );
  }

  it('⭐ an exact invoice clears 2120 to ZERO and raises the payable', async () => {
    await receive('30000.00');
    const res = await transaction((tx) =>
      linkInvoiceToReceipt(tx, {
        orgId: orgA, storeId: storeA, receiptId,
        supplierInvoiceId: crypto.randomUUID(), supplierId: supplierA,
        invoicedOn: '2026-08-25',
        provisionalTotal: money('30000.00'), invoicedTotal: money('30000.00'),
        inventoryAccount: '1310',
        receivedQuantity: quantity('100'), openQuantity: quantity('100'),
      }),
    );
    expect(res.ok).toBe(true);

    const b = await balances();
    expect(b['2120']).toBe('0.00'); // ⭐ the whole point of the clearing account
    expect(b['2110']).toBe('-30000.00');
    expect(b['1310']).toBe('30000.00');
    expect(b['5450']).toBeUndefined();
  });

  it('⭐ Ian’s case: 100 kg at ₱300, 40 consumed, invoice ₱310 — 1310 +600, 5450 +400', async () => {
    await receive('30000.00');
    const res = await transaction((tx) =>
      linkInvoiceToReceipt(tx, {
        orgId: orgA, storeId: storeA, receiptId,
        supplierInvoiceId: crypto.randomUUID(), supplierId: supplierA,
        invoicedOn: '2026-08-25',
        provisionalTotal: money('30000.00'), invoicedTotal: money('31000.00'),
        inventoryAccount: '1310',
        receivedQuantity: quantity('100'), openQuantity: quantity('60'),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.split.inventoryShare).toBe(money('600.00'));
    expect(res.split.consumedShare).toBe(money('400.00'));

    const b = await balances();
    expect(b['2120']).toBe('0.00');
    expect(b['2110']).toBe('-31000.00');
    // Stock still on the shelf now carries its true cost…
    expect(b['1310']).toBe('30600.00');
    // …and the part already eaten posts its correction where COGS cannot be rewritten.
    expect(b['5450']).toBe('400.00');
  });

  it('⭐ nothing consumed — the whole variance re-costs inventory and 5450 stays absent', async () => {
    await receive('1000.00');
    await transaction((tx) =>
      linkInvoiceToReceipt(tx, {
        orgId: orgA, storeId: storeA, receiptId,
        supplierInvoiceId: crypto.randomUUID(), supplierId: supplierA,
        invoicedOn: '2026-08-25',
        provisionalTotal: money('1000.00'), invoicedTotal: money('1100.00'),
        inventoryAccount: '1310',
        receivedQuantity: quantity('10'), openQuantity: quantity('10'),
      }),
    );
    const b = await balances();
    expect(b['1310']).toBe('1100.00');
    expect(b['5450']).toBeUndefined();
    expect(b['2120']).toBe('0.00');
  });

  it('⭐ everything consumed — the whole variance goes to 5450, and the entry still balances', async () => {
    await receive('1000.00');
    await transaction((tx) =>
      linkInvoiceToReceipt(tx, {
        orgId: orgA, storeId: storeA, receiptId,
        supplierInvoiceId: crypto.randomUUID(), supplierId: supplierA,
        invoicedOn: '2026-08-25',
        provisionalTotal: money('1000.00'), invoicedTotal: money('1100.00'),
        inventoryAccount: '1310',
        receivedQuantity: quantity('10'), openQuantity: quantity('0'),
      }),
    );
    const b = await balances();
    expect(b['1310']).toBe('1000.00'); // unchanged — there is no stock left to re-cost
    expect(b['5450']).toBe('100.00');
    expect(b['2120']).toBe('0.00');
  });

  it('a CHEAPER invoice moves both shares the other way', async () => {
    await receive('1000.00');
    await transaction((tx) =>
      linkInvoiceToReceipt(tx, {
        orgId: orgA, storeId: storeA, receiptId,
        supplierInvoiceId: crypto.randomUUID(), supplierId: supplierA,
        invoicedOn: '2026-08-25',
        provisionalTotal: money('1000.00'), invoicedTotal: money('900.00'),
        inventoryAccount: '1310',
        receivedQuantity: quantity('10'), openQuantity: quantity('5'),
      }),
    );
    const b = await balances();
    expect(b['1310']).toBe('950.00');
    expect(b['5450']).toBe('-50.00');
    expect(b['2110']).toBe('-900.00');
    expect(b['2120']).toBe('0.00');
  });

  it('⭐ a centavo-rounded invoice is NEVER blocked — v1’s judgement, kept', async () => {
    await receive('1000.00');
    const res = await transaction((tx) =>
      linkInvoiceToReceipt(tx, {
        orgId: orgA, storeId: storeA, receiptId,
        supplierInvoiceId: crypto.randomUUID(), supplierId: supplierA,
        invoicedOn: '2026-08-25',
        provisionalTotal: money('1000.00'), invoicedTotal: money('1000.60'),
        inventoryAccount: '1310',
        receivedQuantity: quantity('10'), openQuantity: quantity('10'),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.split.withinTolerance).toBe(true);
    expect((await balances())['2120']).toBe('0.00');
  });

  it('the payable carries the supplier as its party — 2110 is a control account', async () => {
    await receive('1000.00');
    await transaction((tx) =>
      linkInvoiceToReceipt(tx, {
        orgId: orgA, storeId: storeA, receiptId,
        supplierInvoiceId: crypto.randomUUID(), supplierId: supplierA,
        invoicedOn: '2026-08-25',
        provisionalTotal: money('1000.00'), invoicedTotal: money('1000.00'),
        inventoryAccount: '1310',
        receivedQuantity: quantity('10'), openQuantity: quantity('10'),
      }),
    );
    const [row] = await sql<{ party_type: string; party_id: string }[]>`
      select l.party_type, l.party_id from journal_lines l
      join accounts a on a.id = l.account_id where a.code = '2110'`;
    expect(row!.party_type).toBe('supplier');
    expect(row!.party_id).toBe(supplierA);
  });

  it('⛔ an invoice for a non-positive amount is refused', async () => {
    await receive('1000.00');
    const res = await transaction((tx) =>
      linkInvoiceToReceipt(tx, {
        orgId: orgA, storeId: storeA, receiptId,
        supplierInvoiceId: crypto.randomUUID(), supplierId: supplierA,
        invoicedOn: '2026-08-25',
        provisionalTotal: money('1000.00'), invoicedTotal: money('0.00'),
        inventoryAccount: '1310',
        receivedQuantity: quantity('10'), openQuantity: quantity('10'),
      }),
    );
    expect(res.ok).toBe(false);
  });

  it('⭐ the trial balance ties after every path', async () => {
    await receive('30000.00');
    await transaction((tx) =>
      linkInvoiceToReceipt(tx, {
        orgId: orgA, storeId: storeA, receiptId,
        supplierInvoiceId: crypto.randomUUID(), supplierId: supplierA,
        invoicedOn: '2026-08-25',
        provisionalTotal: money('30000.00'), invoicedTotal: money('31000.00'),
        inventoryAccount: '1310',
        receivedQuantity: quantity('100'), openQuantity: quantity('60'),
      }),
    );
    const [tb] = await sql<{ net: string }[]>`
      select (sum(debit) - sum(credit))::text as net from journal_lines l
      join accounts a on a.id = l.account_id where a.org_id = ${orgA}`;
    expect(tb!.net).toBe('0.00');
  });
});
