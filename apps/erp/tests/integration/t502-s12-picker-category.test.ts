import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-502 S12 / test 9 (TESTER, red first) - the invoice-line picker data carries each item's expense category, so the screens can group
 * lines by category without a second lookup. `itemPickerFor` (apps/erp/src/app/ap/lib.ts) and its `CatalogueEntry` (packages/db/src/repo/items.ts).
 * The property is named `expenseCategoryId` (camelCase of the column `expense_category_id`); null when the item has no category.
 * Spec: docs/tasks/502-expense-item-catalog.md section 12 "Tests" 9.
 *
 * MUTANTS: only `known` carries it (not `others`); `others` carries it but `known` does not; the category of a DIFFERENT item; an
 * uncategorised item reported as '' or undefined instead of null.
 *
 * NOT TESTED HERE (it.todo below): the two screens' markup - the spec fixes no testable markup yet.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called - fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));

import { closeDb, itemsRepo } from '@shareat/db';
import { ap475Fixture, asOrg } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';
import { itemPickerFor } from '../../src/app/ap/lib';

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type WithCat = { expenseCategoryId?: string | null };

async function world(hint: string) {
  const f = await ap475Fixture(sql, hint);
  const [cat] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${f.orgId} and is_active and account_code is not null order by category limit 1`;
  const item = async (name: string, categoryId: string | null) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by, expense_category_id)
      values (${f.orgId}, ${testItemCode()}, ${name}, 'raw_material', 'kg', ${f.adminId}, ${categoryId}) returning id`)[0]!.id;
  const billed = await item('Billed Pork', cat!.id); // supplier has an invoice line for it -> `known`
  const uncategorisedBilled = await item('Billed Mystery', null);
  const other = await item('Never Billed Veg', cat!.id); // -> `others`
  const otherNone = await item('Never Billed Misc', null);
  const inv = await f.invoice({ total: '20.00' });
  let n = 0;
  for (const itemId of [billed, uncategorisedBilled]) {
    n += 1;
    await sql`insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
              values (${inv}, ${n}, ${itemId}, '1', 'pcs', '1', '10.00', '10.00')`;
  }
  return { f, catId: cat!.id, billed, uncategorisedBilled, other, otherNone };
}

describe('T-502 S12 / 9 - the picker data carries expense_category_id', () => {
  it('itemPickerFor: `known` and `others` entries both carry expenseCategoryId (the item\'s own), null when the item has none', async () => {
    const w = await world('s12-9');
    const picker = await itemPickerFor(w.f.orgId, w.f.supplierId);
    const known = new Map(picker.known.map((k) => [k.itemId, k as unknown as WithCat]));
    const others = new Map(picker.others.map((o) => [o.id, o as unknown as WithCat]));

    expect(known.has(w.billed), 'fixture: the billed item is known to the supplier').toBe(true);
    expect(known.get(w.billed)!.expenseCategoryId, 'known + categorised').toBe(w.catId);
    expect(known.get(w.uncategorisedBilled)!.expenseCategoryId, 'known + uncategorised is null, not undefined or empty').toBeNull();
    expect(others.get(w.other)!.expenseCategoryId, 'others + categorised').toBe(w.catId);
    expect(others.get(w.otherNone)!.expenseCategoryId, 'others + uncategorised is null').toBeNull();
  });

  it('itemPickerFor with no supplier chosen: every item is in `others` and still carries it', async () => {
    const w = await world('s12-9b');
    const picker = await itemPickerFor(w.f.orgId, null);
    const byId = new Map(picker.others.map((o) => [o.id, o as unknown as WithCat]));
    expect(byId.get(w.billed)!.expenseCategoryId).toBe(w.catId);
    expect(byId.get(w.otherNone)!.expenseCategoryId).toBeNull();
  });

  it('itemsRepo.itemsForSupplier (CatalogueEntry) carries it too, so the shape lives in the repo and not only the page', async () => {
    const w = await world('s12-9c');
    const rows = await asOrg(w.f.orgId, (tx) => itemsRepo.itemsForSupplier(tx, w.f.orgId, w.f.supplierId));
    const byId = new Map(rows.map((r) => [r.itemId, r as unknown as WithCat]));
    expect(byId.get(w.billed)!.expenseCategoryId).toBe(w.catId);
    expect(byId.get(w.uncategorisedBilled)!.expenseCategoryId).toBeNull();
  });

  it('screens: a lineless bill shows the "not itemised yet" panel linking to the invoice; an itemised one lists each part with what is left (full parts disabled); the invoice page batch lists the parts to tick', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { InvoicePartsPicker } = await import('../../src/components/expenses/InvoicePartsPicker');
    const { InvoiceBatchRecord } = await import('../../src/components/expenses/InvoiceBatchRecord');
    const { EXPENSE_CREATE_RULES } = await import('@shareat/domain/field-rules');
    const cats = [{ id: 'c1', group: 'COGS' as const, category: 'Meat', accountCode: '5100', isActive: true }];
    const bare = { invoiceId: 'inv-bare', itemised: false, linesExceedTotal: false, parts: [] };
    const lined = {
      invoiceId: 'inv-lined',
      itemised: true,
      linesExceedTotal: false,
      parts: [
        { key: 'c1', kind: 'category' as const, categoryId: 'c1', label: 'Meat', itemNames: ['Pork kasim', 'Pork belly'], total: '4250.00', left: '4250.00' },
        { key: 'c2', kind: 'category' as const, categoryId: 'c2', label: 'Veg', itemNames: ['Kangkong'], total: '750.00', left: '0.00' },
        { key: 'uncategorised', kind: 'uncategorised' as const, categoryId: null, label: 'Uncategorised', itemNames: ['Mystery'], total: '100.00', left: '100.00' },
      ],
    };
    const picker = (v: typeof bare | typeof lined) =>
      renderToStaticMarkup(createElement(InvoicePartsPicker, { views: { [v.invoiceId]: v }, categories: cats, fixedInvoiceId: v.invoiceId, particularsRule: EXPENSE_CREATE_RULES.particulars }));
    const bareHtml = picker(bare);
    expect(bareHtml).toContain("This bill isn&#x27;t itemised yet");
    expect(bareHtml).toContain('href="/ap/invoices/inv-bare"');
    const html = picker(lined);
    expect(html).toContain('Which part of this bill?');
    expect(html).toMatch(/Meat — ₱4,250\.00 left/);
    expect(html).toMatch(/<option value="c2" disabled="">Veg — ₱0\.00 left/);
    const batch = renderToStaticMarkup(
      createElement(InvoiceBatchRecord, {
        action: async () => {}, invoiceId: 'inv-lined', storeId: 's', supplierId: 'sup', supplierName: 'Alberto', supplierCreditTermsDays: null,
        invoiceStatus: 'pending', view: lined, categories: cats, returnTo: '/ap/invoices/inv-lined',
        moneyLines: { sources: [], staff: [] },
      }),
    );
    expect(batch).toContain('Record expenses');
    expect(batch).toContain('name="partOn_0"');
    expect(batch).toContain('name="partOn_1"'); // Uncategorised; the full Veg part is not offered
    expect(batch).not.toContain('Include Veg');
  });
});
