import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-472 audit fixes: incomplete day reads, the personal-data ALLOW-LIST, one rounding helper, refund line sign, the change-time
 * cutoff, and a savepoint per receipt. Same harness as t472-s2-receipt-bridge.test.ts (fake port, real Postgres, `_test` guard).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import type { PosReceiptBridgePort } from '../../src/pos/receipt-bridge-port';
import { DEC_NOW, FakePort, NOW, YESTERDAY, receipt } from './_fixtures/pos-bridge';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const NEXT = '2027-01-13T22:30:00.000Z';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t472au-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Alpha') returning id`;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin A') returning id`;
  const [chan] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${orgId}, ${store!.id}, 'Walk-in', true, null) returning id`;
  await sql`insert into tenders (org_id, store_id, name, kind, pos_v1_alias) values (${orgId}, ${store!.id}, 'Cash', 'cash', 'Cash')`;
  const posStoreId = uid('pos-store');
  await sql`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${orgId}, ${store!.id}, ${posStoreId}, 'Test POS store', ${chan!.id}, 'vat_inclusive', ${person!.id})`;
  return { orgId, storeId: store!.id, posStoreId };
}

async function sweep(o: { orgId: string; port: PosReceiptBridgePort; now?: string; dryRun?: boolean; date?: string }) {
  const { posReceiptBridgeSweep } = await import('../../src/pos/receipt-bridge-job');
  return posReceiptBridgeSweep({ orgId: o.orgId, port: o.port, now: new Date(o.now ?? NOW), dryRun: o.dryRun, date: o.date });
}

const headers = (orgId: string) =>
  sql<{ id: string; firestore_doc_id: string; version: number; status: string; total_centavos: string; money_flag: boolean; raw: Record<string, unknown> }[]>`
    select id, firestore_doc_id, version, status, total_centavos::text, money_flag, raw from pos_bridge_receipts where org_id = ${orgId} order by firestore_doc_id, version`;
const countRows = async (orgId: string, table: string): Promise<number> =>
  Number((await sql.unsafe(`select count(*)::int as n from ${table} where org_id = '${orgId}'`))[0]!.n);

describe('audit 1: an incomplete read never mints gone versions or a day check', () => {
  it('A1: POS counted 2 by client time, 1 came back: b stays final, no day check is written', async () => {
    const f = await fixture('a1');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a' }), receipt({ id: 'b' }));
    await sweep({ orgId: f.orgId, port, date: YESTERDAY });
    port.clear(f.posStoreId, YESTERDAY);
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a' }));
    port.crossCheckOverride = (_s, _d, base) => ({ ...base, byClientMs: 2 });
    await sql`delete from pos_bridge_day_checks where org_id = ${f.orgId}`;
    const r = await sweep({ orgId: f.orgId, port, now: NEXT, date: YESTERDAY });
    expect(r.hadFailures).toBe(true);
    expect((await headers(f.orgId)).filter((h) => h.firestore_doc_id === 'b').map((h) => h.status)).toEqual(['final']);
    expect(await countRows(f.orgId, 'pos_bridge_day_checks')).toBe(0);
  });

  it('A1b: a named missing-client-time id that could not be read blocks gone and the check too', async () => {
    const f = await fixture('a1b');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a' }), receipt({ id: 'b' }));
    await sweep({ orgId: f.orgId, port, date: YESTERDAY });
    port.clear(f.posStoreId, YESTERDAY);
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a' }));
    port.crossCheckOverride = (_s, _d, base) => ({ ...base, missingClientMs: 1, missingClientMsIds: ['ghost'] });
    await sql`delete from pos_bridge_day_checks where org_id = ${f.orgId}`;
    await sweep({ orgId: f.orgId, port, now: NEXT, date: YESTERDAY });
    expect((await headers(f.orgId)).filter((h) => h.firestore_doc_id === 'b').length).toBe(1);
    expect(await countRows(f.orgId, 'pos_bridge_day_checks')).toBe(0);
  });
});

describe('audit 2: personal data is an ALLOW-LIST (Ruling 7)', () => {
  it('P2: identity fields of every spelling never reach raw or a column; known fields survive', async () => {
    const f = await fixture('p2');
    const port = new FakePort();
    port.put(
      f.posStoreId,
      YESTERDAY,
      receipt({
        id: 'allow',
        raw: {
          status: 'final',
          total: 100,
          customerSnap: { name: 'Snap Name', phone: '0917-SECRET' },
          guestName: 'Guest Gina',
          phone: '0917-1234567',
          email: 'x@y.example',
          pin: '4321',
          cardNo: '4111-SECRET',
          lines: [{ id: 'l1', itemName: 'Pork', unitPrice: 100, qtyOrdered: 1, note: 'no onions for Mr Santos' }],
          statutoryDiners: [
            { kind: 'pwd', idNumber: 'PWD-SECRET', seniorId: 'SR-SECRET', pwdId: 'P-SECRET', scId: 'SC-SECRET', cardNo: 'C-SECRET', name: 'Diner Dina', share: 1, discount: 20 },
          ],
        },
      }),
    );
    await sweep({ orgId: f.orgId, port });
    const [h] = await headers(f.orgId);
    const text = JSON.stringify(h!.raw);
    for (const secret of ['SECRET', 'Snap Name', 'Guest Gina', '0917', 'x@y.example', '4321', 'Santos', 'Diner Dina']) expect(text, secret).not.toContain(secret);
    expect(h!.raw).toMatchObject({ status: 'final', total: 100 });
    expect((h!.raw as { lines: Record<string, unknown>[] }).lines[0]).toMatchObject({ id: 'l1', itemName: 'Pork', unitPrice: 100 });
    expect((h!.raw as { statutoryDiners: Record<string, unknown>[] }).statutoryDiners[0]).toEqual({ kind: 'pwd', share: 1, discount: 20 });
  });
});

describe('audit 3+4: one rounding helper, refund line sign', () => {
  it('M3: half AWAY from zero, fractional quantity or percent sets money_flag, sale and refund are mirror images, nothing dropped', async () => {
    const f = await fixture('m3');
    const port = new FakePort();
    const fixedLine = { unitPrice: '100.00' as never, qtyOrdered: 3, discountType: 'fixed', discountFixed: '0.33' as never, discountQty: 1.5 };
    const pctLine = { unitPrice: '99.99' as never, qtyOrdered: 1, discountType: 'percent', discountPercent: 10, discountQty: 1 };
    port.put(
      f.posStoreId,
      YESTERDAY,
      receipt({ id: 'sale', total: '299.50', lines: [fixedLine, pctLine] }),
      receipt({ id: 'rf-sale', total: '-299.50', kind: 'refund', lines: [fixedLine] }),
    );
    const r = await sweep({ orgId: f.orgId, port });
    expect(r.hadFailures).toBe(false);
    const rows = await sql<{ fd: string; line_no: number; discount_centavos: string; line_total_centavos: string; quantity: string; money_flag: boolean }[]>`
      select h.firestore_doc_id as fd, l.line_no, l.discount_centavos::text, l.line_total_centavos::text, l.quantity::text, l.money_flag
        from pos_bridge_receipt_lines l join pos_bridge_receipts h on h.id = l.receipt_id where h.org_id = ${f.orgId} order by h.firestore_doc_id, l.line_no`;
    const get = (fd: string, n: number) => rows.find((x) => x.fd === fd && x.line_no === n)!;
    // 33c x 1.5 = 49.5c -> 50 (half away), flagged; 3 x 100.00 - 0.50 = 299.50
    expect(get('sale', 1)).toMatchObject({ discount_centavos: '50', line_total_centavos: '29950', money_flag: true });
    // 10% of 99.99 = 999.9c -> 1000, flagged
    expect(get('sale', 2)).toMatchObject({ discount_centavos: '1000', line_total_centavos: '8999', money_flag: true });
    expect(get('rf-sale', 1)).toMatchObject({ discount_centavos: '-50', line_total_centavos: '-29950', quantity: '-3.000', money_flag: true });
    const hs = await headers(f.orgId);
    expect(hs.find((h) => h.firestore_doc_id === 'sale')!.money_flag).toBe(true);
  });

  it("R4: a plain refund's line totals add up to its negative header total", async () => {
    const f = await fixture('r4');
    const port = new FakePort();
    port.put(
      f.posStoreId,
      YESTERDAY,
      receipt({ id: 'rf-plain', total: '-250.00', kind: 'refund', lines: [{ unitPrice: '100.00' as never, qtyOrdered: 2 }, { unitPrice: '50.00' as never, qtyOrdered: 1 }] }),
    );
    await sweep({ orgId: f.orgId, port });
    const [sum] = await sql<{ s: string }[]>`select sum(line_total_centavos)::text as s from pos_bridge_receipt_lines where org_id = ${f.orgId}`;
    const [h] = await headers(f.orgId);
    expect(h!.total_centavos).toBe('-25000');
    expect(sum!.s).toBe('-25000');
  });
});

describe('audit 5+7: the change-time cutoff and a savepoint per receipt', () => {
  it('S5: a dry run and a first live run cut off at the start of the earliest day actually read, never the window start', async () => {
    const f = await fixture('s5');
    const dry = new FakePort();
    await sweep({ orgId: f.orgId, port: dry, dryRun: true });
    expect(dry.sinceSeen.length).toBeGreaterThan(0);
    expect(dry.sinceSeen.every((d) => d.toISOString() === '2027-01-11T16:00:00.000Z')).toBe(true);
    const dec = new FakePort();
    await sweep({ orgId: f.orgId, port: dec, now: DEC_NOW });
    expect(dec.sinceSeen.length).toBeGreaterThan(0);
    expect(dec.sinceSeen.every((d) => d.toISOString() === '2026-12-29T16:00:00.000Z')).toBe(true);
  });

  it('S7: one bad receipt among three: the others are written, posted counts only those, one failure line', async () => {
    const f = await fixture('s7');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'ok1' }), receipt({ id: 'bad', hash: 'NOT-A-HASH' }), receipt({ id: 'ok2' }));
    const r = await sweep({ orgId: f.orgId, port, date: YESTERDAY });
    expect((await headers(f.orgId)).map((h) => h.firestore_doc_id)).toEqual(['ok1', 'ok2']);
    expect(r.outcomes[0]!.posted).toBe(2);
    expect(r.outcomes[0]!.failed).toBe(1);
  });
});
