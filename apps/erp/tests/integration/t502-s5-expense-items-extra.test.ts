import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { config } from 'dotenv';

import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { closeDb } from '@shareat/db';
import { session } from './t435-fixture';
import { ap475Fixture, asOrg, actorOf, type Fixture } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

/**
 * T-502 S5 (builder additions, rulings 3, 5 and 6): the centavo tie goes to the LOWEST line_no; the "(unitemised)" drill lists the
 * EXPENSES; the CSV export carries the same figures and the same store scope, and every cell goes through escapeCsvCell.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

config({ path: '.env.local' });
const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const RANGE = { from: '2026-01-01', to: '2026-01-31', storeId: null as string | null };
interface W {
  f: Fixture;
  boss: Actor;
  cat: string;
  bill: (lines: { item: string; total: string }[], fee?: string) => Promise<string>;
  item: (name: string) => Promise<string>;
  post: (invoiceId: string, amount: string, particulars?: string) => Promise<string>;
}
async function world(hint: string): Promise<W> {
  const f = await ap475Fixture(sql, `s5x-${hint}`);
  const [boss] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Boss') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${boss!.id}, ${f.orgId}, 'admin')`;
  for (const s of [f.storeId, f.store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${boss!.id}, ${s})`;
  const [cat] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${f.orgId} and is_active and account_code is not null and "group" = 'COGS' order by category limit 1`;
  const boss2 = actorOf(f.orgId, boss!.id);
  return {
    f,
    boss: boss2,
    cat: cat!.id,
    item: async (name) =>
      (await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by, expense_category_id)
        values (${f.orgId}, ${testItemCode()}, ${name}, 'raw_material', 'kg', ${f.adminId}, ${cat!.id}) returning id`)[0]!.id,
    bill: async (lines, fee = '0.00') => {
      const total = (lines.reduce((s, l) => s + Math.round(Number(l.total) * 100), 0) + Math.round(Number(fee) * 100)) / 100;
      const id = await f.invoice({ total: total.toFixed(2), status: 'verified', on: '2026-01-10', receiptFileId: await f.file(f.storeId) });
      let n = 0;
      for (const l of lines) {
        n += 1;
        await sql`
          insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
          values (${id}, ${n}, ${l.item}, '1', 'pcs', '1', ${l.total}, ${l.total})`;
      }
      return id;
    },
    post: async (invoiceId, amount, particulars = 'T-502 S5 extra') =>
      (
        await asOrg(f.orgId, (tx) =>
          domain.recordExpenseForInvoice(tx, boss2, {
            storeId: f.storeId,
            supplierInvoiceId: invoiceId,
            supplierId: f.supplierId,
            categoryId: cat!.id,
            particulars,
            payments: [{ method: 'cash', amount, moneyAccountId: f.cashId }],
          }),
        )
      ).expenseId,
  };
}

describe('T-502 S5 extra / ruling 3 - an exact tie takes the remainder on the LOWEST line_no', () => {
  it('1.01 over two 1.00 lines -> line 1 gets 0.51, line 2 gets 0.50 (kills: remainder to the last line)', async () => {
    const w = await world('tie');
    const a = await w.item('Tie A');
    const b = await w.item('Tie B');
    const inv = await w.bill([{ item: a, total: '1.00' }, { item: b, total: '1.00' }]);
    await w.post(inv, '1.01');
    const r = await asOrg(w.f.orgId, async (tx) => ({
      a: await domain.expenseItemLines(tx, w.boss, { ...RANGE, itemId: a }),
      b: await domain.expenseItemLines(tx, w.boss, { ...RANGE, itemId: b }),
    }));
    expect(r.a.map((l) => l.attributed)).toEqual(['0.51']);
    expect(r.b.map((l) => l.attributed)).toEqual(['0.50']);
  });
});

describe('T-502 S5 extra / ruling 5 - the "(unitemised)" drill lists the expenses', () => {
  it('lists the expense (date, store, amount, particulars, bill) of a category that overflowed its lines; none for a fully itemised one', async () => {
    const w = await world('loose');
    const a = await w.item('Itemised');
    const over = await w.bill([{ item: a, total: '100.00' }], '30.00');
    const e1 = await w.post(over, '130.00', 'Delivery fee included');
    const clean = await w.bill([{ item: a, total: '50.00' }]);
    await w.post(clean, '50.00', 'Fully itemised');
    const got = await asOrg(w.f.orgId, (tx) => domain.unitemisedExpenses(tx, w.boss, { ...RANGE, categoryId: w.cat }));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ expenseId: e1, invoiceId: over, storeId: w.f.storeId, businessDate: '2026-01-10', amount: '130.00', particulars: 'Delivery fee included' });
  });
});

describe('T-502 S5 extra / ruling 6 - the CSV export', () => {
  const exportRoute = () => import('../../src/app/reports/expense-items/export/route');
  const get = async (who: Actor, extra = ''): Promise<{ status: number; body: string; type: string | null }> => {
    session.actor = who;
    try {
      const { GET } = await exportRoute();
      const res = await GET(new Request(`http://localhost/reports/expense-items/export?from=2026-01-01&to=2026-01-31${extra}`));
      return { status: res.status, body: await res.text(), type: res.headers.get('Content-Type') };
    } catch (e) {
      return { status: 500, body: `THROWN ${e instanceof Error ? e.message : String(e)}`, type: null };
    }
  };

  it('an admin gets the rows with escaped cells; a formula-looking item name is neutralised; floor staff get no figure', async () => {
    const w = await world('csv');
    const nasty = await w.item('=SUM(1,2) Siling');
    const plainItem = await w.item('Plain, with comma');
    const inv = await w.bill([{ item: nasty, total: '600.00' }, { item: plainItem, total: '400.00' }]);
    await w.post(inv, '1000.00');
    const ok = await get(w.boss);
    expect(ok.status).toBe(200);
    expect(ok.type).toMatch(/text\/csv/);
    const lines = ok.body.trim().split('\r\n');
    expect(lines[0]).toMatch(/^Group,Category,Sub-category,Item,Spent,/);
    expect(ok.body).toContain("\"'=SUM(1,2) Siling\"");
    expect(ok.body).toContain('"Plain, with comma"');
    expect(lines[lines.length - 1]).toMatch(/^Total,,,,/);
    const staff = await get(w.f.staff);
    expect(staff.body).not.toContain('Siling');
    expect(staff.body).not.toContain('600.00');
  });

  it('a forged ?store=<Malvar> from a manager held at Lipa falls back to Lipa (the export goes through reportScope)', async () => {
    const w = await world('csvscope');
    const a = await w.item('Scoped CSV item');
    await w.post(await w.bill([{ item: a, total: '70.00' }]), '70.00');
    const res = await get(w.f.manager, `&store=${w.f.store2Id}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Scoped CSV item');
  });
});
