import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-379 S3a (DEF-601, DEF-602, R10) - landed cost across a multi-item bill, voided bills, and
 * "one bill is one receive". `docs/tasks/379-erp-small-follow-ups.md` S3a, tests L1-L8.
 *
 * Every bill goes through `recordInvoice` / `verifyInvoice` / `voidInvoice`, never a raw insert.
 * Money is compared as integer ten-thousandths (the repo prints 4 dp) or exact numeric text,
 * never a float. `trade.test.ts` (T-151) stays the single-item control (L5 re-proves it here
 * with a no-fee bill).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, itemsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createSupplier,
  createItem,
  recordInvoice,
  verifyInvoice,
  voidInvoice,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';

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
  const code = uid(`lc-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [st] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Store lipa') returning id`;
  const storeId = st!.id;
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const superAdminId = await mkPerson('Super', 'super_admin');
  const managerId = await mkPerson('Manager', 'manager');
  const staffId = await mkPerson('Staff', 'staff');
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId,
  });
  const supplier = await asOrg(orgId, (tx) =>
    createSupplier(tx, actor(orgId, managerId), { name: `Supplier ${uid('s')}` }),
  );
  return {
    orgId, storeId, supplierId: supplier.id,
    superAdmin: actor(orgId, superAdminId),
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function itemKg(f: Fixture, name: string): Promise<string> {
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, {
      code: testItemCode(), name: `${name} ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg',
    }),
  );
  return item.id;
}

async function evidenceFile(f: Fixture): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${f.manager.personId})
    returning id`;
  return row!.id;
}

/** Centavos from a peso string with at most 2 dp. Integer arithmetic only. */
function centavos(peso: string): bigint {
  const [i = '0', d = ''] = peso.split('.');
  return BigInt(i) * 100n + BigInt((d + '00').slice(0, 2));
}
const peso = (c: bigint): string => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;

interface BillLine { itemId: string; qty: string; lineTotal: string }
interface Bill { date?: string; lines: BillLine[]; deliveryFee?: string; otherFees?: string }

/** Record (not yet verify) one bill inside the caller's tx. */
async function record(tx: Tx, f: Fixture, fileId: string, b: Bill): Promise<string> {
  const fees = centavos(b.deliveryFee ?? '0') + centavos(b.otherFees ?? '0');
  const goods = b.lines.reduce((s, l) => s + centavos(l.lineTotal), 0n);
  const created = await recordInvoice(tx, f.staff, {
    storeId: f.storeId,
    supplierId: f.supplierId,
    invoiceDate: b.date ?? '2026-01-10',
    totalAmount: peso(goods + fees),
    ...(b.deliveryFee ? { deliveryFee: b.deliveryFee } : {}),
    ...(b.otherFees ? { otherFees: b.otherFees } : {}),
    receiptFileId: fileId,
    lines: b.lines.map((l) => ({
      itemId: l.itemId, quantity: l.qty, purchaseUnit: 'kg', conversionFactor: '1',
      unitPrice: peso(centavos(l.lineTotal) / BigInt(l.qty)),
      lineTotal: l.lineTotal,
    })),
  });
  return created.id;
}

async function verify(f: Fixture, id: string): Promise<void> {
  await asOrg(f.orgId, (tx) =>
    verifyInvoice(tx, f.manager, id, { supplier: true, invoice: true, items: true, price: true }),
  );
}

/** One bill in its own transaction, verified. */
async function bill(f: Fixture, b: Bill): Promise<string> {
  const fileId = await evidenceFile(f);
  const id = await asOrg(f.orgId, (tx) => record(tx, f, fileId, b));
  await verify(f, id);
  return id;
}

const history = (f: Fixture, itemId: string) =>
  asOrg(f.orgId, (tx) => itemsRepo.priceHistory(tx, f.orgId, itemId));
const basis = async (f: Fixture, itemId: string) =>
  (await asOrg(f.orgId, (tx) => itemsRepo.costBasisFor(tx, f.orgId, itemId)))?.basis;

/** "105.0000000000" -> "105"; "192.5000" -> "192.5". Exact text compare, no float. */
const norm = (s: string | undefined): string | undefined =>
  s == null ? s : s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
/** A 4 dp price string x whole kg -> ten-thousandths of a peso. */
const tenThousandths = (price4dp: string, kg: number): bigint => {
  const [i = '0', d = ''] = price4dp.split('.');
  return (BigInt(i) * 10000n + BigInt((d + '0000').slice(0, 4))) * BigInt(kg);
};

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** L1/L2/L6 fixture: X 10 kg 1,000 + Y 10 kg 9,000, delivery fee 500. */
async function l1Fixture(hint: string) {
  const f = await fixture(hint);
  const x = await itemKg(f, 'X');
  const y = await itemKg(f, 'Y');
  await bill(f, {
    lines: [{ itemId: x, qty: '10', lineTotal: '1000.00' }, { itemId: y, qty: '10', lineTotal: '9000.00' }],
    deliveryFee: '500.00',
  });
  return { f, x, y };
}

describe('T-379 S3a - landed cost over the WHOLE bill (DEF-602)', () => {
  it('L1 priceHistory: a 500 fee splits 50/450 by value (kills: item-only denominator, total_amount denominator, fix only lastTwoLandedMax)', async () => {
    const { f, x, y } = await l1Fixture('l1');
    expect((await history(f, x)).map((h) => h.landedBasePrice)).toEqual(['105.0000']);
    expect((await history(f, y)).map((h) => h.landedBasePrice)).toEqual(['945.0000']);
  });

  it('L2 costBasisFor uses the same split (kills: fix only priceHistory)', async () => {
    const { f, x, y } = await l1Fixture('l2');
    expect(norm(await basis(f, x))).toBe('105');
    expect(norm(await basis(f, y))).toBe('945');
  });

  it('L3 conservation: landed line totals sum to goods + fees exactly (kills: item-only / total_amount denominator)', async () => {
    const f = await fixture('l3');
    const x = await itemKg(f, 'X');
    const y = await itemKg(f, 'Y');
    await bill(f, {
      lines: [
        { itemId: x, qty: '10', lineTotal: '1000.00' },
        { itemId: x, qty: '10', lineTotal: '1000.00' },
        { itemId: y, qty: '10', lineTotal: '8000.00' },
      ],
      otherFees: '1000.00',
    });
    const hx = await history(f, x);
    const hy = await history(f, y);
    expect(hx.map((h) => h.landedBasePrice)).toEqual(['110.0000', '110.0000']);
    expect(hy.map((h) => h.landedBasePrice)).toEqual(['880.0000']);
    const total = [...hx, ...hy].reduce((s, h) => s + tenThousandths(h.landedBasePrice, 10), 0n);
    expect(total).toBe(110000000n); // 11,000.00 in ten-thousandths
  });

  it('L6 an unrelated bill (Z 50,000 + 2,000 fee) moves nothing (kills: denominator summed over all bills)', async () => {
    const { f, x, y } = await l1Fixture('l6');
    const z = await itemKg(f, 'Z');
    await bill(f, { date: '2026-01-12', lines: [{ itemId: z, qty: '10', lineTotal: '50000.00' }], deliveryFee: '2000.00' });
    expect((await history(f, x)).map((h) => h.landedBasePrice)).toEqual(['105.0000']);
    expect((await history(f, y)).map((h) => h.landedBasePrice)).toEqual(['945.0000']);
    expect(norm(await basis(f, x))).toBe('105');
    expect(norm(await basis(f, y))).toBe('945');
    expect(norm(await basis(f, z))).toBe('5200');
  });
});

describe('T-379 S3a - voided bills leave the basis (DEF-601)', () => {
  it('L4 void B1 (fee) then re-log B2 (no fee): basis is 100 (kills: restoring status <> void)', async () => {
    const f = await fixture('l4');
    const x = await itemKg(f, 'X');
    const b1 = await bill(f, { lines: [{ itemId: x, qty: '10', lineTotal: '1000.00' }], deliveryFee: '500.00' });
    expect(norm(await basis(f, x))).toBe('150');
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId: b1, reason: 'Fee was keyed wrong' }));
    const b2 = await bill(f, { lines: [{ itemId: x, qty: '10', lineTotal: '1000.00' }] });
    expect(norm(await basis(f, x))).toBe('100');
    // control, already true on HEAD
    const h = await history(f, x);
    expect(h).toHaveLength(1);
    expect(h[0]!.invoiceId).toBe(b2);
  });
});

describe('T-379 S3a - controls', () => {
  it('L5 no fee: landed = raw base price, on one item and on a two-item bill (control, green on HEAD)', async () => {
    const f = await fixture('l5');
    const x = await itemKg(f, 'X');
    const y = await itemKg(f, 'Y');
    await bill(f, {
      lines: [{ itemId: x, qty: '100', lineTotal: '10000.00' }, { itemId: y, qty: '10', lineTotal: '300.00' }],
    });
    const hx = (await history(f, x))[0]!;
    const hy = (await history(f, y))[0]!;
    expect(hx.landedBasePrice).toBe(hx.basePrice);
    expect(hx.landedBasePrice).toBe('100.0000');
    expect(hy.landedBasePrice).toBe('30.0000');
    expect(norm(await basis(f, x))).toBe('100');
  });
});

describe('T-379 S3a - one bill is one receive (R10)', () => {
  async function l7(hint: string, withB0: boolean) {
    const f = await fixture(hint);
    const x = await itemKg(f, 'X');
    if (withB0) await bill(f, { date: '2026-01-05', lines: [{ itemId: x, qty: '10', lineTotal: '3000.00' }] });
    await bill(f, {
      date: '2026-01-10',
      lines: [{ itemId: x, qty: '10', lineTotal: '1000.00' }, { itemId: x, qty: '30', lineTotal: '6000.00' }],
      deliveryFee: '700.00',
    });
    return { f, x };
  }

  it('L7 B1 (two X lines) is ONE receive, weighted 192.50; basis = max(192.50, B0 300) = 300 (kills: per-line HEAD)', async () => {
    const { f, x } = await l7('l7a', true);
    expect((await history(f, x)).map((h) => h.landedBasePrice)).toEqual(['300.0000', '110.0000', '220.0000']);
    expect(norm(await basis(f, x))).toBe('300');
  });

  it('L7 leg 2, no B0: basis is the weighted 192.5 (kills: bill = max of its lines 220, bill = mean of lines 165)', async () => {
    const { f, x } = await l7('l7b', false);
    expect(norm(await basis(f, x))).toBe('192.5');
  });

  it('L8 same-date bills, each in its own tx: last two are B3 (50) and B2 (100) -> 100, five times (kills: asc ordering -> 300)', async () => {
    const f = await fixture('l8a');
    const x = await itemKg(f, 'X');
    for (const total of ['3000.00', '1000.00', '500.00']) {
      await bill(f, { date: '2026-01-10', lines: [{ itemId: x, qty: '10', lineTotal: total }] });
    }
    for (let i = 0; i < 5; i++) expect(norm(await basis(f, x))).toBe('100');
  });

  it('L8 leg 2, three bills in ONE tx (equal created_at): id desc decides -> 100 (kills: id asc / no tie-break)', async () => {
    const f = await fixture('l8b');
    const x = await itemKg(f, 'X');
    const files = [await evidenceFile(f), await evidenceFile(f), await evidenceFile(f)];
    const ids = await asOrg(f.orgId, async (tx) => {
      const out: string[] = [];
      for (const [i, total] of ['3000.00', '1000.00', '500.00'].entries()) {
        out.push(await record(tx, f, files[i]!, { date: '2026-01-10', lines: [{ itemId: x, qty: '10', lineTotal: total }] }));
      }
      return out;
    });
    for (const id of ids) await verify(f, id);
    for (let i = 0; i < 5; i++) expect(norm(await basis(f, x))).toBe('100');
  });

  it('L8 source: lastTwoLandedMax orders by invoice_date desc, created_at desc, id desc (kills: dropped id tie-break)', () => {
    const src = readFileSync(resolve(__dirname, '../../../db/src/repo/items.ts'), 'utf8');
    const start = src.indexOf('async function lastTwoLandedMax');
    const body = src.slice(start, src.indexOf('export async function costBasisFor', start));
    expect(body).toMatch(/invoice_date\s+desc\s*,\s*(\w+\.)?created_at\s+desc\s*,\s*(\w+\.)?id\s+desc/i);
    expect(body).toMatch(/limit\s+2/i);
    expect(body).not.toMatch(/<>\s*'void'/);
  });
});
