import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-145 — the item master, supplier invoice lines, and price history.
 * `docs/tasks/145-item-master-and-invoice-lines.md`.
 *
 * ⭐ The test that carries the design is *"editing the item's pack size does not change what past
 * invoices say we paid"*. Everything else here is arithmetic; that one is the reason
 * `conversion_factor` is snapshotted on the line instead of read from the item, and it is the
 * difference between a price history and a price fiction.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { itemsRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import type { InvoiceLineDraft } from '@shareat/domain';
import {
  approveItemRequest,
  clearStoreSellability,
  createItem,
  createSupplier,
  declareSupplierItem,
  mergeItems,
  rejectItemRequest,
  requestItem,
  setStoreSellability,
  recordInvoice,
  setInvoiceLines,
  undeclareSupplierItem,
  updateItem,
  verifyInvoice,
  voidInvoice,
} from '@shareat/domain';
import { requestInput, testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`it-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [manager] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const [superAdmin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${superAdmin!.id}, ${orgId}, 'super_admin')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${superAdmin!.id}, ${store!.id})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  const [staff] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${store!.id})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${store!.id})`;
  const supplier = await asOrg(orgId, (tx) =>
    createSupplier(tx, actor(orgId, manager!.id), { name: `Supplier ${code}` }),
  );
  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${store!.id}, ${staff!.id}, ${uid('SE')}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId: store!.id, employmentId: staffEmployment!.id, personId: staff!.id, setBy: manager!.id,
  });
  return {
    orgId, storeId: store!.id, managerId: manager!.id, staffId: staff!.id,
    manager: actor(orgId, manager!.id), staff: actor(orgId, staff!.id),
    superAdmin: actor(orgId, superAdmin!.id), admin: actor(orgId, admin!.id),
    supplierId: supplier.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function evidence(f: Fixture): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${f.staffId})
    returning id`;
  return row!.id;
}

/** One verified invoice carrying `lines`, dated `invoiceDate`. */
async function invoiceWithLines(
  f: Fixture,
  invoiceDate: string,
  total: string,
  lines: Parameters<typeof recordInvoice>[2]['lines'],
): Promise<string> {
  const fileId = await evidence(f);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, {
      storeId: f.storeId, supplierId: f.supplierId, invoiceDate,
      totalAmount: total, receiptFileId: fileId, lines,
    }),
  );
  await asOrg(f.orgId, (tx) =>
    verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }),
  );
  return created.id;
}

async function porkBelly(f: Fixture): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: testItemCode(), name: `Pork belly ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg' }),
  );
  return id;
}

beforeAll(async () => { await sql`select 1`; });
afterAll(async () => { await closeDb(); await sql.end({ timeout: 5 }); });

describe('price history — the question this task exists to answer', () => {
  it('two invoices a month apart give two observations, in order, at the right ₱/kg', async () => {
    const f = await fixture('history');
    const item = await porkBelly(f);
    await invoiceWithLines(f, '2026-01-10', '2900.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
    ]);
    await invoiceWithLines(f, '2026-02-10', '3100.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '310', lineTotal: '3100.00' },
    ]);

    const history = await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, item));
    expect(history.map((h) => [h.invoiceDate, h.basePrice])).toEqual([
      ['2026-01-10', '290.0000'],
      ['2026-02-10', '310.0000'],
    ]);
  });

  it('⭐ buying by the CASE and by the KILO normalises to the same ₱/kg scale', async () => {
    const f = await fixture('units');
    const item = await porkBelly(f);
    // 2 cases of 24kg at ₱6,960 a case = ₱290/kg. Same price, billed differently.
    await invoiceWithLines(f, '2026-01-05', '13920.00', [
      { itemId: item, quantity: '2', purchaseUnit: 'case', conversionFactor: '24', unitPrice: '6960', lineTotal: '13920.00' },
    ]);
    await invoiceWithLines(f, '2026-01-20', '3100.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '310', lineTotal: '3100.00' },
    ]);

    const history = await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, item));
    expect(history.map((h) => h.basePrice)).toEqual(['290.0000', '310.0000']);

    // ⭐ WEIGHTED, not a mean of means: ₱17,020 over 58kg is ₱293.45, not (290+310)/2 = ₱300.
    const [month] = await asOrg(f.orgId, (tx) => itemsRepo.priceMovement(tx, f.orgId, item));
    expect(month!.avgPrice).toBe('293.4483');
    expect(month!.minPrice).toBe('290.0000');
    expect(month!.maxPrice).toBe('310.0000');
    expect(month!.observations).toBe(2);
  });

  it('⛔⭐ editing the item does NOT rewrite what past invoices say we paid', async () => {
    const f = await fixture('immutable');
    const item = await porkBelly(f);
    await invoiceWithLines(f, '2026-01-10', '13920.00', [
      { itemId: item, quantity: '2', purchaseUnit: 'case', conversionFactor: '24', unitPrice: '6960', lineTotal: '13920.00' },
    ]);
    const before = await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, item));
    expect(before[0]!.basePrice).toBe('290.0000');

    // The supplier changes their case size; someone renames the item. (T-378/0186: the unit is fixed once an item has an invoice line, so only the name changes.)
    await sql`update items set name = ${`Pork belly (renamed) ${uid('r')}`} where id = ${item}`;

    const after = await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, item));
    expect(
      after[0]!.basePrice,
      'the factor lives on the LINE — a past price is a fact about a past transaction',
    ).toBe('290.0000');
  });

  it('a voided invoice vanishes from price history, but stays on the books', async () => {
    const f = await fixture('voided');
    const item = await porkBelly(f);
    const invoiceId = await invoiceWithLines(f, '2026-01-10', '2900.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
    ]);
    expect(await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, item))).toHaveLength(1);

    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId, reason: 'Billed in error' }));

    expect(
      await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, item)),
      'a cancelled bill is not evidence of a price',
    ).toHaveLength(0);
    const [row] = await sql`select status from supplier_invoices where id = ${invoiceId}`;
    expect(row!.status).toBe('voided');
  });

  it('⭐ comparing suppliers for the same product — cheapest first', async () => {
    const f = await fixture('compare');
    const item = await porkBelly(f);
    const dearer = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `Dearer ${uid('s')}` }));

    await invoiceWithLines(f, '2026-01-10', '2900.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
    ]);
    const fileId = await evidence(f);
    const other = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: dearer.id, invoiceDate: '2026-01-12',
        totalAmount: '3300.00', receiptFileId: fileId,
        lines: [{ itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '330', lineTotal: '3300.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) =>
      verifyInvoice(tx, f.manager, other.id, { supplier: true, invoice: true, items: true, price: true }),
    );

    const bySupplier = await asOrg(f.orgId, (tx) => itemsRepo.priceBySupplier(tx, f.orgId, item));
    expect(bySupplier.map((s) => s.avgPrice)).toEqual(['290.0000', '330.0000']);
  });
});

describe('the rules a line must satisfy before it becomes a price', () => {
  it('⛔ lines that do not sum to the invoice total are refused', async () => {
    const f = await fixture('sum');
    const item = await porkBelly(f);
    await expect(
      invoiceWithLines(f, '2026-01-10', '5000.00', [
        { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
      ]),
    ).rejects.toThrow(/lines total ₱2,900\.00, but the goods on this bill come to ₱5,000\.00/);
  });

  it('⛔ a line whose own arithmetic does not close is refused', async () => {
    const f = await fixture('arith');
    const item = await porkBelly(f);
    await expect(
      invoiceWithLines(f, '2026-01-10', '999.00', [
        { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '999.00' },
      ]),
    ).rejects.toThrow(/does not add up/);
  });

  it("⛔ a conversion factor between IDENTICAL units must be 1 — v1's pack→pack pathology", async () => {
    const f = await fixture('samewn');
    const item = await porkBelly(f); // base unit kg
    await expect(
      invoiceWithLines(f, '2026-01-10', '2900.00', [
        { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '6', unitPrice: '290', lineTotal: '2900.00' },
      ]),
    ).rejects.toThrow(/already the item's own unit — the conversion factor must be 1/);
  });

  it('an invoice with NO lines is perfectly valid — a utility bill has none', async () => {
    const f = await fixture('nolines');
    const invoiceId = await invoiceWithLines(f, '2026-01-10', '4500.00', []);
    const [row] = await sql`select status from supplier_invoices where id = ${invoiceId}`;
    expect(row!.status).toBe('verified');
  });
});

describe('T-340 — a non-number never reaches the line arithmetic', () => {
  it('I1 (app path\'s exact shape): a typed "abc" price names the line and quotes "abc", not the computed line total', async () => {
    const f = await fixture('t340-i1');
    const item = await porkBelly(f);
    const fileId = await evidence(f);
    // ⛔ Amendment R1 §3: NOT invoiceWithLines — it verifies, and setInvoiceLines refuses a
    // non-pending invoice. recordInvoice directly, with no lines, left pending.
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
        totalAmount: '2900.00', receiptFileId: fileId, lines: [],
      }),
    );
    const bad: InvoiceLineDraft = {
      itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1',
      unitPrice: 'abc', lineTotal: (Number('10') * Number('abc')).toFixed(2),
    };
    await expect(
      asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [bad])),
    ).rejects.toThrow(/line 1 \(Pork belly .*\) — the unit price "abc" is not a number/);
    await expect(
      asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [bad])),
    ).rejects.not.toThrow(/line total/);
  });

  it('I2: unit price AND line total both "NaN" — price is checked first', async () => {
    const f = await fixture('t340-i2');
    const item = await porkBelly(f);
    const fileId = await evidence(f);
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
        totalAmount: '2900.00', receiptFileId: fileId, lines: [],
      }),
    );
    const bad: InvoiceLineDraft = {
      itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1',
      unitPrice: 'NaN', lineTotal: 'NaN',
    };
    await expect(
      asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [bad])),
    ).rejects.toThrow(/the unit price "NaN" is not a number/);
  });

  it('I3: an "Infinity" unit price is refused the same way', async () => {
    const f = await fixture('t340-i3');
    const item = await porkBelly(f);
    const fileId = await evidence(f);
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
        totalAmount: '2900.00', receiptFileId: fileId, lines: [],
      }),
    );
    const bad: InvoiceLineDraft = {
      itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1',
      unitPrice: 'Infinity', lineTotal: 'Infinity',
    };
    await expect(
      asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [bad])),
    ).rejects.toThrow(/the unit price "Infinity" is not a number/);
  });

  it('I4: a valid unit price but a "NaN" line total names the LINE TOTAL, not the price', async () => {
    const f = await fixture('t340-i4');
    const item = await porkBelly(f);
    const fileId = await evidence(f);
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
        totalAmount: '2900.00', receiptFileId: fileId, lines: [],
      }),
    );
    const bad: InvoiceLineDraft = {
      itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1',
      unitPrice: '290', lineTotal: 'NaN',
    };
    await expect(
      asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [bad])),
    ).rejects.toThrow(/the line total "NaN" is not a number/);
  });

  it(
    'I5 (RULED FLIP, S5.5w item 2 landed) — quantity "1e300" now names itself via parseQuantityInput\'s ' +
      'own "too large" sentence, never flattened into "does not add up" — was: the old bare finiteness ' +
      'refusal, since quantity reached `Number()` unparsed before this fix',
    async () => {
      const f = await fixture('t340-i5');
      const item = await porkBelly(f);
      const fileId = await evidence(f);
      const created = await asOrg(f.orgId, (tx) =>
        recordInvoice(tx, f.staff, {
          storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
          totalAmount: '2900.00', receiptFileId: fileId, lines: [],
        }),
      );
      const bad: InvoiceLineDraft = {
        itemId: item, quantity: '1e300', purchaseUnit: 'kg', conversionFactor: '1',
        unitPrice: '1e10', lineTotal: '1',
      };
      await expect(
        asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [bad])),
      ).rejects.toThrow(/is too large/i);
      await expect(
        asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [bad])),
      ).rejects.not.toThrow(/does not add up/);
    },
  );

  it(
    'I6 (T-351 M1, ruled edit) — unitPrice \'1e308\' now refuses at the cost PARSER, never reaching ' +
      'the header finiteness check it used to hit: 1e308 is itself finite, but parseFourDecimalCost\'s ' +
      'shape regex has no "e" in it, so it is "not a valid amount" before either line\'s sum is ever computed',
    async () => {
      const f = await fixture('t340-i6');
      const item = await porkBelly(f);
      const fileId = await evidence(f);
      const created = await asOrg(f.orgId, (tx) =>
        recordInvoice(tx, f.staff, {
          storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
          totalAmount: '2900.00', receiptFileId: fileId, lines: [],
        }),
      );
      const huge: InvoiceLineDraft = {
        itemId: item, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1',
        unitPrice: '1e308', lineTotal: '1e308',
      };
      await expect(
        asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [huge, { ...huge }])),
      ).rejects.toThrow(/is not a valid amount/i);
      await expect(
        asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [huge, { ...huge }])),
      ).rejects.not.toThrow(/the lines total/);
    },
  );

  it(
    'N1 (RULED FLIP, S5.5w item 2 landed) — an "abc" quantity now refuses via parseQuantityInput\'s ' +
      'own malformed-string sentence, not the old bare "needs a quantity above zero" guard',
    async () => {
      const f = await fixture('t340-n1');
      const item = await porkBelly(f);
      const fileId = await evidence(f);
      const created = await asOrg(f.orgId, (tx) =>
        recordInvoice(tx, f.staff, {
          storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
          totalAmount: '2900.00', receiptFileId: fileId, lines: [],
        }),
      );
      const bad: InvoiceLineDraft = {
        itemId: item, quantity: 'abc', purchaseUnit: 'kg', conversionFactor: '1',
        unitPrice: 'abc', lineTotal: 'NaN',
      };
      await expect(
        asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [bad])),
      ).rejects.toThrow(/is not a valid quantity/);
    },
  );

  it('N2: zero is a legitimate price and total (bible §12 landmine 8) — accepted, not refused', async () => {
    const f = await fixture('t340-n2');
    const item = await porkBelly(f);
    const fileId = await evidence(f);
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
        totalAmount: '2900.00', receiptFileId: fileId, lines: [],
      }),
    );
    const lines: InvoiceLineDraft[] = [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
      { itemId: item, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '0', lineTotal: '0.00' },
    ];
    const result = await asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, lines));
    expect(result.count).toBe(2);
    const rows = await sql`
      select unit_price from supplier_invoice_lines where supplier_invoice_id = ${created.id} order by line_no`;
    expect(rows[1]!.unit_price).toBe('0.0000');
  });

  it('N3: a 4dp unit price is accepted and stored exactly — no parser routes it through 2dp money', async () => {
    const f = await fixture('t340-n3');
    const item = await porkBelly(f);
    const fileId = await evidence(f);
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
        totalAmount: '24.69', receiptFileId: fileId, lines: [],
      }),
    );
    const lines: InvoiceLineDraft[] = [
      { itemId: item, quantity: '2', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '12.3456', lineTotal: '24.69' },
    ];
    const result = await asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, lines));
    expect(result.count).toBe(1);
    const [row] = await sql`
      select unit_price, line_total from supplier_invoice_lines where supplier_invoice_id = ${created.id}`;
    expect(row!.unit_price).toBe('12.3456');
    expect(row!.line_total).toBe('24.69');
  });

  it('N4: no partial state — a good set of lines survives a later rejected setInvoiceLines call untouched', async () => {
    const f = await fixture('t340-n4');
    const item = await porkBelly(f);
    const fileId = await evidence(f);
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
        totalAmount: '2900.00', receiptFileId: fileId, lines: [],
      }),
    );
    await asOrg(f.orgId, (tx) =>
      setInvoiceLines(tx, f.staff, created.id, [
        { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
      ]),
    );
    const bad: InvoiceLineDraft = {
      itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1',
      unitPrice: 'abc', lineTotal: (Number('10') * Number('abc')).toFixed(2),
    };
    await expect(
      asOrg(f.orgId, (tx) => setInvoiceLines(tx, f.staff, created.id, [bad])),
    ).rejects.toThrow(/the unit price "abc" is not a number/);
    const [row] = await sql`
      select count(*)::int as count, max(unit_price) as max_price
      from supplier_invoice_lines where supplier_invoice_id = ${created.id}`;
    expect(row!.count).toBe(1);
    expect(row!.max_price).toBe('290.0000');
  });
});

describe('item identity', () => {
  it('⛔ two items cannot share a name differing only by case', async () => {
    const f = await fixture('dupe');
    await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: 'Pork Belly', kind: 'raw_material', baseUnit: 'kg' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        createItem(tx, f.superAdmin, { code: testItemCode(), name: 'pork belly', kind: 'raw_material', baseUnit: 'kg' }),
      ),
      '187 duplicate names across v1 stores is exactly how a price chart stops summing',
    ).rejects.toThrow();
  });

  it('⛔ a container is not a base unit — box/pack are purchase units only', async () => {
    const f = await fixture('container');
    await expect(
      asOrg(f.orgId, (tx) =>
        // @ts-expect-error — 'box' is deliberately absent from BaseUnit; the DB refuses it too.
        createItem(tx, f.superAdmin, { code: testItemCode(), name: 'Boxed thing', kind: 'supply', baseUnit: 'box' }),
      ),
    ).rejects.toThrow();
  });

  it('org A cannot see org B’s items', async () => {
    const a = await fixture('orgA');
    const b = await fixture('orgB');
    await asOrg(a.orgId, (tx) =>
      createItem(tx, a.superAdmin, { code: testItemCode(), name: 'Org A secret item', kind: 'retail', baseUnit: 'pcs' }),
    );
    const seenByB = await asOrg(b.orgId, (tx) => itemsRepo.listItems(tx, b.orgId, { includeInactive: true }));
    expect(seenByB.map((i) => i.name)).not.toContain('Org A secret item');
  });
});

// =========================================================================================
// T-147 — the supplier-item catalogue. Observed is DERIVED; only declarations are stored.
// =========================================================================================

describe('the catalogue: who sells what', () => {
  it('⭐ an invoice line makes the item observed — and writes NO catalogue row', async () => {
    const f = await fixture('observed');
    const item = await porkBelly(f);
    await invoiceWithLines(f, '2026-01-10', '2900.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
    ]);

    const cat = await asOrg(f.orgId, (tx) => itemsRepo.itemsForSupplier(tx, f.orgId, f.supplierId));
    expect(cat).toHaveLength(1);
    expect(cat[0]!.source).toBe('observed');
    expect(cat[0]!.firstSeenOn).toBe('2026-01-10');
    expect(cat[0]!.timesBilled).toBe(1);

    // ⛔ The whole point: nothing was stored. The link is a query over the lines.
    // ⚠️ Scoped to THIS org: sibling tests in this file create declarations, and a global count
    // would fail for their reasons rather than this test's.
    const [row] = await sql<{ n: number }[]>`select count(*)::int n from supplier_items where org_id = ${f.orgId}`;
    expect(row!.n, 'an observed link must not be stored — that is DEF-075 again').toBe(0);
  });

  it('a second invoice keeps the FIRST date and counts twice', async () => {
    const f = await fixture('twice');
    const item = await porkBelly(f);
    await invoiceWithLines(f, '2026-01-10', '2900.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
    ]);
    await invoiceWithLines(f, '2026-02-10', '3100.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '310', lineTotal: '3100.00' },
    ]);
    const [entry] = await asOrg(f.orgId, (tx) => itemsRepo.itemsForSupplier(tx, f.orgId, f.supplierId));
    expect(entry!.firstSeenOn).toBe('2026-01-10');
    expect(entry!.timesBilled).toBe(2);
  });

  it('⭐ a declaration reports as declared, then as observed once billed — exactly once either way', async () => {
    const f = await fixture('promote');
    const item = await porkBelly(f);
    await asOrg(f.orgId, (tx) => declareSupplierItem(tx, f.manager, { supplierId: f.supplierId, itemId: item }));

    const before = await asOrg(f.orgId, (tx) => itemsRepo.itemsForSupplier(tx, f.orgId, f.supplierId));
    expect(before).toHaveLength(1);
    expect(before[0]!.source).toBe('declared');
    expect(before[0]!.firstSeenOn).toBeNull();

    await invoiceWithLines(f, '2026-03-01', '500.00', [
      { itemId: item, quantity: '2', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '250', lineTotal: '500.00' },
    ]);

    const after = await asOrg(f.orgId, (tx) => itemsRepo.itemsForSupplier(tx, f.orgId, f.supplierId));
    expect(after, 'the declaration must not double up with the observation').toHaveLength(1);
    expect(after[0]!.source).toBe('observed');
    expect(after[0]!.firstSeenOn).toBe('2026-03-01');
  });

  it('⛔ undeclaring removes a declaration but cannot touch an observation', async () => {
    const f = await fixture('undeclare');
    const item = await porkBelly(f);
    await asOrg(f.orgId, (tx) => declareSupplierItem(tx, f.manager, { supplierId: f.supplierId, itemId: item }));
    await invoiceWithLines(f, '2026-03-01', '500.00', [
      { itemId: item, quantity: '2', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '250', lineTotal: '500.00' },
    ]);

    const { removed } = await asOrg(f.orgId, (tx) =>
      undeclareSupplierItem(tx, f.manager, { supplierId: f.supplierId, itemId: item }),
    );
    expect(removed).toBe(true);

    // The observation survives, because it was never a row to delete.
    const after = await asOrg(f.orgId, (tx) => itemsRepo.itemsForSupplier(tx, f.orgId, f.supplierId));
    expect(after).toHaveLength(1);
    expect(after[0]!.source).toBe('observed');
  });

  it('a voided invoice still counts as observed — voiding corrects money, not the relationship', async () => {
    const f = await fixture('voidcat');
    const item = await porkBelly(f);
    const invoiceId = await invoiceWithLines(f, '2026-01-10', '2900.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
    ]);
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId, reason: 'Wrong bill' }));

    const cat = await asOrg(f.orgId, (tx) => itemsRepo.itemsForSupplier(tx, f.orgId, f.supplierId));
    expect(cat).toHaveLength(1);
    expect(cat[0]!.source).toBe('observed');
    // ...but the PRICE is gone, because a cancelled bill is not evidence of a price.
    expect(await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, item))).toHaveLength(0);
  });

  it('suppliersForItem is the reverse view — the sourcing-risk one', async () => {
    const f = await fixture('reverse');
    const item = await porkBelly(f);
    await invoiceWithLines(f, '2026-01-10', '2900.00', [
      { itemId: item, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
    ]);
    const sellers = await asOrg(f.orgId, (tx) => itemsRepo.suppliersForItem(tx, f.orgId, item));
    expect(sellers).toHaveLength(1);
    expect(sellers[0]!.supplierId).toBe(f.supplierId);
  });

  it('org A cannot see org B’s declarations', async () => {
    const a = await fixture('catA');
    const b = await fixture('catB');
    const itemA = await porkBelly(a);
    await asOrg(a.orgId, (tx) => declareSupplierItem(tx, a.manager, { supplierId: a.supplierId, itemId: itemA }));
    const seenByB = await asOrg(b.orgId, (tx) => itemsRepo.itemsForSupplier(tx, b.orgId, a.supplierId));
    expect(seenByB).toHaveLength(0);
  });
});

// =========================================================================================
// T-148 — governance: nearly impossible to duplicate an item
// =========================================================================================

describe('it is hard to duplicate an item on purpose, and harder by accident', () => {
  it('a MANAGER cannot create an item at all — they must ask', async () => {
    const f = await fixture('nocreate');
    await expect(
      asOrg(f.orgId, (tx) =>
        createItem(tx, f.manager, { code: testItemCode(), name: 'Sneaky item', kind: 'supply', baseUnit: 'pcs' }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('the trigram check flags v1 real duplicates, and stays quiet on unrelated names', async () => {
    const f = await fixture('trigram');
    await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: 'Bean sprout', kind: 'raw_material', baseUnit: 'kg' }),
    );

    // The pair that genuinely exists in v1 live data, at two different units.
    const dupe = await asOrg(f.orgId, (tx) =>
      requestItem(tx, f.manager, requestInput({ name: 'Beans Sprout', kind: 'raw_material', baseUnit: 'pcs' })),
    );
    expect(dupe.similar).toHaveLength(1);
    expect(dupe.similarWarning).toMatch(/Bean sprout/);

    // An unrelated name must NOT be flagged, or the warning becomes noise people click past.
    const fine = await asOrg(f.orgId, (tx) =>
      requestItem(tx, f.manager, requestInput({ name: 'Charcoal', kind: 'supply', baseUnit: 'kg' })),
    );
    expect(fine.similar).toHaveLength(0);
    expect(fine.similarWarning).toBeNull();
  });

  it('a request approved by a super-admin mints the item and links the two', async () => {
    const f = await fixture('approve');
    const req = await asOrg(f.orgId, (tx) =>
      requestItem(tx, f.manager, requestInput({ name: 'Charcoal', kind: 'supply', baseUnit: 'kg' })),
    );
    const { itemId } = await asOrg(f.orgId, (tx) =>
      approveItemRequest(tx, f.superAdmin, { requestId: req.requestId }),
    );
    const item = await asOrg(f.orgId, (tx) => itemsRepo.getItemById(tx, f.orgId, itemId));
    expect(item!.name).toBe('Charcoal');
    const [row] = await sql`select status, created_item_id from item_requests where id = ${req.requestId}`;
    expect(row!.status).toBe('approved');
    expect(row!.created_item_id).toBe(itemId);
  });

  it('an ADMIN cannot approve — only a super-admin', async () => {
    const f = await fixture('adminapprove');
    const req = await asOrg(f.orgId, (tx) =>
      requestItem(tx, f.manager, requestInput({ name: 'Charcoal', kind: 'supply', baseUnit: 'kg' })),
    );
    await expect(
      asOrg(f.orgId, (tx) => approveItemRequest(tx, f.admin, { requestId: req.requestId })),
    ).rejects.toThrow(AuthorizationError);
  });

  it('a rejection needs a reason, and one request cannot be decided twice', async () => {
    const f = await fixture('reject');
    const req = await asOrg(f.orgId, (tx) =>
      requestItem(tx, f.manager, requestInput({ name: 'Charcoal', kind: 'supply', baseUnit: 'kg' })),
    );
    await expect(
      asOrg(f.orgId, (tx) => rejectItemRequest(tx, f.superAdmin, { requestId: req.requestId, note: '  ' })),
    ).rejects.toThrow(/say why/);

    await asOrg(f.orgId, (tx) =>
      rejectItemRequest(tx, f.superAdmin, { requestId: req.requestId, note: 'We already have Uling.' }),
    );
    await expect(
      asOrg(f.orgId, (tx) => approveItemRequest(tx, f.superAdmin, { requestId: req.requestId })),
    ).rejects.toThrow(/already rejected/);
  });
});

describe('merge — when two slipped through anyway', () => {
  it('repoints invoice lines, combines both histories, and leaves a trail', async () => {
    const f = await fixture('merge');
    const winner = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: `Pork belly W ${uid('w')}`, kind: 'raw_material', baseUnit: 'kg' }),
    );
    const loser = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: `Pork Belly L ${uid('l')}`, kind: 'raw_material', baseUnit: 'kg' }),
    );

    await invoiceWithLines(f, '2026-01-10', '2900.00', [
      { itemId: winner.id, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '290', lineTotal: '2900.00' },
    ]);
    await invoiceWithLines(f, '2026-02-10', '3100.00', [
      { itemId: loser.id, quantity: '10', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '310', lineTotal: '3100.00' },
    ]);

    const report = await asOrg(f.orgId, (tx) =>
      mergeItems(tx, f.superAdmin, { loserId: loser.id, winnerId: winner.id }),
    );
    expect(report.invoiceLines).toBe(1);

    // One history now, with both prices in it.
    const history = await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, winner.id));
    expect(history.map((h) => h.basePrice)).toEqual(['290.0000', '310.0000']);

    // The loser survives, marked and pointing at the winner — not deleted.
    const [row] = await sql`select status, merged_into_id from items where id = ${loser.id}`;
    expect(row!.status).toBe('merged');
    expect(row!.merged_into_id).toBe(winner.id);

    // And it disappears from the live catalogue.
    const live = await asOrg(f.orgId, (tx) => itemsRepo.listItems(tx, f.orgId, {}));
    expect(live.map((i) => i.id)).not.toContain(loser.id);
  });

  it('refuses to merge items measured differently — the v1 case that breaks every price', async () => {
    const f = await fixture('mergeunit');
    const kg = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: 'Bean sprout', kind: 'raw_material', baseUnit: 'kg' }),
    );
    const pcs = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: 'Beans Sprout', kind: 'raw_material', baseUnit: 'pcs' }),
    );
    await expect(
      asOrg(f.orgId, (tx) => mergeItems(tx, f.superAdmin, { loserId: pcs.id, winnerId: kg.id })),
      'kg and pcs cannot be one series — fix the unit first',
    ).rejects.toThrow(/Fix the unit on one of them first/);
  });

  it('an item cannot merge into itself, and a manager cannot merge at all', async () => {
    const f = await fixture('mergeguards');
    const a = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: `Thing A ${uid('t')}`, kind: 'supply', baseUnit: 'pcs' }),
    );
    await expect(
      asOrg(f.orgId, (tx) => mergeItems(tx, f.superAdmin, { loserId: a.id, winnerId: a.id })),
    ).rejects.toThrow(/cannot merge into itself/);
    const b = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: `Thing B ${uid('t')}`, kind: 'supply', baseUnit: 'pcs' }),
    );
    await expect(
      asOrg(f.orgId, (tx) => mergeItems(tx, f.manager, { loserId: b.id, winnerId: a.id })),
    ).rejects.toThrow(AuthorizationError);
  });
});

// =========================================================================================
// T-149 — what an item may be bought and sold as, per store
// =========================================================================================

describe('sellability: the bento box, the wholesale pack, and Milkis', () => {
  it('⛔ a bento box cannot appear on a supplier invoice — we make it, nobody bills us', async () => {
    const f = await fixture('bento');
    const bento = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(),
        name: `Samgyup bento ${uid('b')}`,
        kind: 'retail',
        baseUnit: 'pcs',
        isPurchasable: false,
        sellableRetail: true,
        sellableWholesale: false,
      }),
    );
    await expect(
      invoiceWithLines(f, '2026-01-10', '500.00', [
        { itemId: bento.id, quantity: '5', purchaseUnit: 'pcs', conversionFactor: '1', unitPrice: '100', lineTotal: '500.00' },
      ]),
    ).rejects.toThrow(/does not buy/);
  });

  it('a wholesale pack IS accepted on an invoice, and Milkis is accepted as both', async () => {
    const f = await fixture('both');
    const pack = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(), name: `Beef Premium 5kg ${uid('p')}`, kind: 'meat_sliced', baseUnit: 'kg',
        isPurchasable: true, sellableRetail: false, sellableWholesale: true,
      }),
    );
    const milkis = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(), name: `Milkis ${uid('m')}`, kind: 'retail', baseUnit: 'pcs',
        isPurchasable: true, sellableRetail: true, sellableWholesale: true,
      }),
    );
    await invoiceWithLines(f, '2026-01-10', '1250.00', [
      { itemId: pack.id, quantity: '5', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '200', lineTotal: '1000.00' },
      { itemId: milkis.id, quantity: '10', purchaseUnit: 'pcs', conversionFactor: '1', unitPrice: '25', lineTotal: '250.00' },
    ]);
    const hist = await asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, pack.id));
    expect(hist).toHaveLength(1);
  });

  it('⭐ the bulgogi sauce case — Lipa MAKES it, another store BUYS it, one item either way', async () => {
    const f = await fixture('bulgogi');
    // The org's default answer: it is something we buy.
    const sauce = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(), name: `Bulgogi sauce ${uid('s')}`, kind: 'raw_material', baseUnit: 'ltr',
        isPurchasable: true, sellableRetail: false, sellableWholesale: false,
      }),
    );

    // At THIS store, we make it and sell it wholesale — so nobody bills us for it here.
    await asOrg(f.orgId, (tx) =>
      setStoreSellability(tx, f.superAdmin, {
        storeId: f.storeId,
        itemId: sauce.id,
        isPurchasable: false,
        sellableWholesale: true,
        note: 'Made in-house here and sold to franchisees.',
      }),
    );

    const here = await asOrg(f.orgId, (tx) => itemsRepo.sellabilityAt(tx, f.orgId, sauce.id, f.storeId));
    expect(here!.isPurchasable).toBe(false);
    expect(here!.sellableWholesale).toBe(true);
    // ⭐ Untouched by the override, so it still tracks the org default rather than a frozen copy.
    expect(here!.sellableRetail).toBe(false);
    expect(here!.overridden).toBe(true);

    // An invoice AT THIS STORE is refused, because this store makes it.
    await expect(
      invoiceWithLines(f, '2026-01-10', '600.00', [
        { itemId: sauce.id, quantity: '6', purchaseUnit: 'ltr', conversionFactor: '1', unitPrice: '100', lineTotal: '600.00' },
      ]),
    ).rejects.toThrow(/this store does not buy/);

    // Clearing the override returns this store to the org's answer, and buying works again.
    await asOrg(f.orgId, (tx) =>
      clearStoreSellability(tx, f.superAdmin, { storeId: f.storeId, itemId: sauce.id }),
    );
    await invoiceWithLines(f, '2026-01-11', '600.00', [
      { itemId: sauce.id, quantity: '6', purchaseUnit: 'ltr', conversionFactor: '1', unitPrice: '100', lineTotal: '600.00' },
    ]);
    const back = await asOrg(f.orgId, (tx) => itemsRepo.sellabilityAt(tx, f.orgId, sauce.id, f.storeId));
    expect(back!.isPurchasable).toBe(true);
    expect(back!.overridden).toBe(false);
  });

  it('⛔ an override that overrides nothing is refused', async () => {
    const f = await fixture('emptyoverride');
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: `Thing ${uid('x')}`, kind: 'supply', baseUnit: 'pcs' }),
    );
    await expect(
      asOrg(f.orgId, (tx) => setStoreSellability(tx, f.superAdmin, { storeId: f.storeId, itemId: item.id })),
    ).rejects.toThrow(/overrides nothing/);
  });

  it('a store override makes an item quotable on a price list even when the org default says no', async () => {
    const f = await fixture('anywhere');
    const sauce = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(), name: `Sauce ${uid('s')}`, kind: 'raw_material', baseUnit: 'ltr',
        sellableWholesale: false,
      }),
    );
    expect(await asOrg(f.orgId, (tx) => itemsRepo.sellableWholesaleAnywhere(tx, f.orgId, sauce.id))).toBe(false);

    await asOrg(f.orgId, (tx) =>
      setStoreSellability(tx, f.superAdmin, { storeId: f.storeId, itemId: sauce.id, sellableWholesale: true }),
    );
    // ⚠️ A price list is an ORG-wide rate card, so one store selling it wholesale makes it quotable.
    expect(await asOrg(f.orgId, (tx) => itemsRepo.sellableWholesaleAnywhere(tx, f.orgId, sauce.id))).toBe(true);
  });

  // ⭐ DEF-130. Until 2026-09-03 nothing outside this file ever set a flag: the create screen never
  // passed them and there was no edit screen at all, so every item made through the app was
  // sold to nobody. These two tests cover what the item screen now reads and writes.
  it('⭐ DEF-130 — the org default can be changed on an EXISTING item, and every store follows it', async () => {
    const f = await fixture('flagedit');
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: `Milkis ${uid('m')}`, kind: 'retail', baseUnit: 'pcs' }),
    );
    const before = await asOrg(f.orgId, (tx) => itemsRepo.sellabilityAt(tx, f.orgId, item.id, f.storeId));
    expect(before!.sellableWholesale).toBe(false);

    // An ADMIN may do this — manage_items, not approve_item. Creating is super-admin only;
    // deciding what an existing item is sold as is ordinary master-data upkeep.
    await asOrg(f.orgId, (tx) =>
      updateItem(tx, f.admin, item.id, { isPurchasable: true, sellableRetail: true, sellableWholesale: true }),
    );
    const after = await asOrg(f.orgId, (tx) => itemsRepo.sellabilityAt(tx, f.orgId, item.id, f.storeId));
    expect(after).toMatchObject({ isPurchasable: true, sellableRetail: true, sellableWholesale: true, overridden: false });

    // Staff may not.
    await expect(
      asOrg(f.orgId, (tx) => updateItem(tx, f.staff, item.id, { sellableWholesale: false })),
    ).rejects.toThrow(/manage_items/);
  });

  it('⭐ DEF-130 — a store’s raw override is listable, nulls and all, and vanishes when cleared', async () => {
    const f = await fixture('overridelist');
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: `Sauce ${uid('s')}`, kind: 'raw_material', baseUnit: 'ltr' }),
    );
    expect(await asOrg(f.orgId, (tx) => itemsRepo.listStoreSellabilityOverrides(tx, f.orgId, item.id))).toEqual([]);

    await asOrg(f.orgId, (tx) =>
      setStoreSellability(tx, f.admin, { storeId: f.storeId, itemId: item.id, sellableWholesale: true, note: 'made here' }),
    );
    const rows = await asOrg(f.orgId, (tx) => itemsRepo.listStoreSellabilityOverrides(tx, f.orgId, item.id));
    expect(rows).toHaveLength(1);
    // ⚠️ The untouched flags come back NULL — "no opinion" — never as a frozen copy of the default.
    expect(rows[0]).toMatchObject({
      storeId: f.storeId, isPurchasable: null, sellableRetail: null, sellableWholesale: true, note: 'made here',
    });

    await asOrg(f.orgId, (tx) => clearStoreSellability(tx, f.admin, { storeId: f.storeId, itemId: item.id }));
    expect(await asOrg(f.orgId, (tx) => itemsRepo.listStoreSellabilityOverrides(tx, f.orgId, item.id))).toEqual([]);
  });
});
