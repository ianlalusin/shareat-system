import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { config } from 'dotenv';

import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { closeDb } from '@shareat/db';
import { plain, render, session } from './t435-fixture';
import { ap475Fixture, asOrg, actorOf, uid, type Fixture } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

/**
 * T-502 S5 (TESTER, red first) - the page /reports/expense-items. Spec: docs/tasks/502-expense-item-catalog.md section 4 S5, section 11.
 * Names fixed here: apps/erp/src/app/reports/expense-items/page.tsx (default export, searchParams from / to / store), reached through
 * reportScope('/reports/expense-items', 'view_financial_reports', store) like the other reports. The domain function behind it is covered in
 * packages/domain/tests/integration/t502-s5-expense-items-report.test.ts; this file pins what a PERSON sees and who sees it.
 *
 * Markers are chosen so no figure of one store is a substring of another's: Lipa 12,345.00 on "Siling Lipa", Malvar 7,777.00 on "Kalamansi Malvar".
 * MUTANTS: a manager reads Malvar through a forged ?store=; the "all stores" view of a Lipa-only manager adds Malvar; floor staff read the page;
 * a raw empty/unknown label ("(unitemised)" shown as null, "NaN", "undefined", a snake_case column name or an id) reaches the screen.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL!;
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const page = () => import('../../src/app/reports/expense-items/page');

interface W {
  f: Fixture;
  boss: Actor;
  lipaItem: string;
  malvarItem: string;
}
let cached: Promise<W> | null = null;
const world = (): Promise<W> => (cached ??= build());

async function build(): Promise<W> {
  const f = await ap475Fixture(sql, 's5-page');
  const [boss] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Boss') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${boss!.id}, ${f.orgId}, 'admin')`;
  for (const s of [f.storeId, f.store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${boss!.id}, ${s})`;
  const bossActor = actorOf(f.orgId, boss!.id);
  const [cashM] = await sql<{ id: string; gl_account_code: string }[]>`
    select id, gl_account_code from money_accounts where store_id = ${f.store2Id} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const { postEntry } = await import('../../../../packages/domain/src/ledger/post-entry');
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('fund2'), idempotencyKey: uid('fund2'), memo: 'fixture funding', postedBy: f.adminId,
      lines: [{ accountCode: cashM!.gl_account_code, storeId: f.store2Id, debit: '100000.00' }, { accountCode: '3900', storeId: f.store2Id, credit: '100000.00' }],
    }),
  );
  const [cat] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${f.orgId} and is_active and account_code is not null and "group" = 'COGS' order by category limit 1`;
  const item = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by, expense_category_id)
      values (${f.orgId}, ${testItemCode()}, ${name}, 'raw_material', 'kg', ${f.adminId}, ${cat!.id}) returning id`)[0]!.id;
  const lipaItem = await item('Siling Lipa');
  const malvarItem = await item('Kalamansi Malvar');
  const bill = async (storeId: string, itemId: string, total: string, cashId: string) => {
    const inv = await f.invoice({ total, status: 'verified', on: '2026-01-10', storeId, receiptFileId: await f.file(storeId) });
    await sql`
      insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
      values (${inv}, 1, ${itemId}, '1', 'pcs', '1', ${total}, ${total})`;
    await asOrg(f.orgId, (tx) =>
      domain.recordExpenseForInvoice(tx, bossActor, {
        storeId, supplierInvoiceId: inv, supplierId: f.supplierId, categoryId: cat!.id, particulars: 'T-502 S5 page',
        payments: [{ method: 'cash', amount: total, moneyAccountId: cashId }],
      }),
    );
  };
  await bill(f.storeId, lipaItem, '12345.00', f.cashId);
  await bill(f.store2Id, malvarItem, '7777.00', cashM!.id);
  return { f, boss: bossActor, lipaItem, malvarItem };
}

const SEARCH = { from: '2026-01-01', to: '2026-01-31' };
async function pageFor(actor: Actor, extra: Record<string, string> = {}): Promise<string> {
  try {
    return await render(page, actor, { search: { ...SEARCH, ...extra } });
  } catch (e) {
    return `THROWN ${e instanceof Error ? e.message : String(e)}`;
  }
}
void session;

describe('T-502 S5 page - what a person reads', () => {
  it('an admin sees the tree with pesos, a percent of total, times bought and average price, in plain labels', async () => {
    const w = await world();
    const html = await pageFor(w.boss);
    expect(html).not.toMatch(/^THROWN/);
    const t = plain(html);
    for (const n of ['Siling Lipa', 'Kalamansi Malvar', '12,345.00', '7,777.00', '20,122.00']) expect(t, n).toContain(n);
    expect(t).toMatch(/% of total/i);
    expect(t).toMatch(/times bought/i);
    expect(t).toMatch(/average (unit )?price/i);
    expect(t).toMatch(/\(none\)/);
    expect(t).toMatch(/COGS|cost of goods/i);
    expect(t).toMatch(/61\.4\s*%|61\.4/); // 12,345.00 / 20,122.00 of the total
    for (const bad of ['undefined', 'NaN', '[object', 'null', 'expense_', 'subcategory_id']) expect(t.includes(bad) || html.includes(bad), `raw "${bad}" on screen`).toBe(false);
  });

  it('with a store chosen only that store is shown; "all stores" shows the store-vs-store split for an item', async () => {
    const w = await world();
    const lipa = plain(await pageFor(w.boss, { store: w.f.storeId }));
    expect(lipa).toContain('12,345.00');
    expect(lipa).not.toContain('7,777.00');
    const all = plain(await pageFor(w.boss));
    expect(all).toContain('Lipa');
    expect(all).toContain('Malvar');
  });

  it('the date range is applied: a range with no posted expenses shows an empty state and none of the figures', async () => {
    const w = await world();
    const t = plain(await pageFor(w.boss, { from: '2026-03-01', to: '2026-03-31' }));
    expect(t).not.toContain('12,345.00');
    expect(t).not.toContain('7,777.00');
    expect(t).not.toMatch(/NaN|undefined/);
  });
});

describe('T-502 S5 page - who reads it (the X tests)', () => {
  it('a manager held at Lipa sees Lipa; no Malvar item or peso figure, also through a forged ?store=<Malvar> and in the "all stores" view', async () => {
    const w = await world();
    for (const extra of [{}, { store: w.f.storeId }, { store: w.f.store2Id }] as Record<string, string>[]) {
      const html = await pageFor(w.f.manager, extra);
      const t = plain(html);
      for (const n of ['Kalamansi Malvar', '7,777.00', '20,122.00']) expect(t.includes(n) || html.includes(n), `${JSON.stringify(extra)} leaks ${n}`).toBe(false);
    }
    expect(plain(await pageFor(w.f.manager))).toContain('12,345.00');
  });

  it('floor staff (no view_financial_reports) get no item name and no figure on the page', async () => {
    const w = await world();
    const html = await pageFor(w.f.staff);
    const t = plain(html);
    for (const n of ['Siling Lipa', 'Kalamansi Malvar', '12,345.00', '7,777.00']) expect(t.includes(n) || html.includes(n), `staff sees ${n}`).toBe(false);
  });
});
