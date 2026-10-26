import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-472 S2 - the nightly POS receipt bridge job (`posReceiptBridgeSweep`) and its repo (`posBridgeRepo`).
 * `docs/tasks/472-pos-nightly-receipt-bridge.md` Rulings 2, 3, 5, 6, 7, 8 and T-478. Real Postgres via TEST_DATABASE_URL
 * (`_test` name guard); a hand-written FAKE PORT stands in for Firebase, so nothing here touches the network.
 *
 * TESTER, not BUILDER. Red on HEAD: `packages/domain/src/pos/receipt-bridge-job.ts` and `posBridgeRepo` do not exist. The job
 * is loaded DYNAMICALLY (`sweep()`), so each leg fails on its own, never the file at collection.
 *
 * MUTANTS: window not walked -> W1; missing-client-time docs not read -> W3; non-centavo money dropped or unflagged -> M1;
 * an identical hash mints a version -> V1; a changed hash does not -> V3; no gone version -> V4; floor ignored -> F1;
 * dry run writes -> D1; race not skipped -> C2; wrong check -> K1-K3; personal field copied -> P1; another org's rows
 * visible -> S1; an unlinked store read -> L1; a child row dated other than its header -> R0; a Postgres error quoting
 * row values in the failure line -> E1.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { decimal } from '@shareat/core/money';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { PosReceiptBridgePort } from '../../src/pos/receipt-bridge-port';
import { posV1SalesBody } from '../../../db/src/pos-v1/fixtures';
import { DEC_NOW, FakePort, NOW, YESTERDAY, receipt, sha } from './_fixtures/pos-bridge';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const NEXT = '2027-01-13T22:30:00.000Z';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture(hint: string, opts: { linked?: boolean; unlinked?: boolean } = {}) {
  const code = uid(`t472s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Alpha') returning id`;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin A') returning id`;
  const [chan] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${orgId}, ${storeId}, 'Walk-in', true, null) returning id`;
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${storeId}, 'GCash - Alpha', 'ewallet', '1140', 'cashier') returning id`;
  const [cash] = await sql<{ id: string }[]>`
    insert into tenders (org_id, store_id, name, kind, pos_v1_alias) values (${orgId}, ${storeId}, 'Cash', 'cash', 'Cash') returning id`;
  const [gcash] = await sql<{ id: string }[]>`
    insert into tenders (org_id, store_id, name, kind, money_account_id, pos_v1_alias) values (${orgId}, ${storeId}, 'GCash', 'wallet', ${acct!.id}, 'G-Cash') returning id`;
  const posStoreId = uid('pos-store');
  if (opts.linked !== false) {
    const [link] = await sql<{ id: string }[]>`
      insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
      values (${orgId}, ${storeId}, ${posStoreId}, 'Test POS store', ${chan!.id}, 'vat_inclusive', ${person!.id}) returning id`;
    if (opts.unlinked) {
      await sql`update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${person!.id}, unlink_reason = 'closed for good' where id = ${link!.id}`;
    }
  }
  return { orgId, storeId, posStoreId, personId: person!.id, cashTenderId: cash!.id, gcashTenderId: gcash!.id };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function sweep(o: { orgId: string; port: PosReceiptBridgePort; now?: string; dryRun?: boolean; date?: string }) {
  const { posReceiptBridgeSweep } = await import('../../src/pos/receipt-bridge-job');
  return posReceiptBridgeSweep({ orgId: o.orgId, port: o.port, now: new Date(o.now ?? NOW), dryRun: o.dryRun, date: o.date });
}

interface HeaderRow {
  id: string;
  firestore_doc_id: string;
  version: number;
  kind: string;
  status: string;
  pos_calendar_date: string;
  total_centavos: string;
  subtotal_centavos: string;
  discount_centavos: string;
  money_flag: boolean;
  raw: Record<string, unknown>;
}
const headers = (orgId: string) =>
  sql<HeaderRow[]>`select id, firestore_doc_id, version, kind, status, pos_calendar_date::text, total_centavos::text, subtotal_centavos::text,
    discount_centavos::text, money_flag, raw from pos_bridge_receipts where org_id = ${orgId} order by firestore_doc_id, version`;
const countRows = async (orgId: string, table: string): Promise<number> =>
  Number((await sql.unsafe(`select count(*)::int as n from ${table} where org_id = '${orgId}'`))[0]!.n);
const runs = (orgId: string) => sql<{ outcome: string; posted_count: number }[]>`
  select outcome, posted_count from scheduler_runs where org_id = ${orgId} and job = 'pos_receipt_bridge'`;

async function addFeed(f: F, date: string, totalSales: number | null) {
  const obj = posV1SalesBody(totalSales === null ? { found: false } : { paidTotal: totalSales, receiptCount: 1 });
  const body = JSON.stringify(obj);
  await sql`insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_by)
    values (${f.orgId}, ${f.storeId}, ${date}, 'sales', 'import', ${crypto.randomUUID()}, ${f.posStoreId}, ${body}, ${body}::jsonb, ${sha(body)}, ${f.personId})`;
}
const checkOf = async (f: F, date: string) =>
  (
    await sql<{ result: string; receipt_count: number; net_sales_centavos: string; feed_total_centavos: string | null; difference_centavos: string | null }[]>`
      select result, receipt_count, net_sales_centavos::text, feed_total_centavos::text, difference_centavos::text from pos_bridge_day_checks
      where org_id = ${f.orgId} and store_id = ${f.storeId} and pos_calendar_date = ${date}`
  )[0];

describe('W: the window and what is read', () => {
  it('W1: reads every Manila day of the 7-day window up to yesterday, for the live-linked store, with the POS store id', async () => {
    const f = await fixture('w1');
    const port = new FakePort();
    const r = await sweep({ orgId: f.orgId, port });
    expect(r.hadFailures).toBe(false);
    const days = port.datesCalled(f.posStoreId, 'listDay');
    expect(days).toEqual(['2027-01-06', '2027-01-07', '2027-01-08', '2027-01-09', '2027-01-10', '2027-01-11', '2027-01-12']);
    expect(port.datesCalled(f.posStoreId, 'cross')).toEqual(days);
    expect(port.datesCalled(f.posStoreId, 'listMissing')).toEqual(days);
  });

  it('W2: change-time queries run for voidedAt, editedAt and createdAt, since the window start on a first-ever run', async () => {
    const f = await fixture('w2');
    const port = new FakePort();
    await sweep({ orgId: f.orgId, port });
    expect(port.calls.filter((c) => c.startsWith('changed|')).map((c) => c.split('|')[2]).sort()).toEqual(['createdAt', 'editedAt', 'voidedAt']);
    // Window start: Manila midnight of 2027-01-06 = 2027-01-05T16:00Z.
    expect(port.sinceSeen.every((d) => d.toISOString() === '2027-01-05T16:00:00.000Z')).toBe(true);
  });

  it('W2b: after a successful run, the next change-time queries start from that run (minus a small overlap), not the window start', async () => {
    const f = await fixture('w2b');
    await sweep({ orgId: f.orgId, port: new FakePort() });
    const second = new FakePort();
    await sweep({ orgId: f.orgId, port: second, now: NEXT });
    const since = second.sinceSeen[0]!.getTime();
    const prev = Date.parse(NOW);
    expect(since).toBeLessThanOrEqual(prev);
    expect(since).toBeGreaterThan(prev - 6 * 3_600_000);
  });

  it('W3: receipts with a server day but no client time are read and imported (T-478); a named id that was not read is a failure', async () => {
    const f = await fixture('w3');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a' }));
    port.putMissing(f.posStoreId, YESTERDAY, receipt({ id: 'b', noClientTime: true }));
    const r = await sweep({ orgId: f.orgId, port });
    expect(r.hadFailures).toBe(false);
    expect((await headers(f.orgId)).map((h) => h.firestore_doc_id)).toEqual(['a', 'b']);
    const f2 = await fixture('w3b');
    const p2 = new FakePort();
    p2.put(f2.posStoreId, YESTERDAY, receipt({ id: 'a' }));
    p2.crossCheckOverride = (_s, d, base) => (d === YESTERDAY ? { ...base, missingClientMs: 1, missingClientMsIds: ['ghost'] } : base);
    const r2 = await sweep({ orgId: f2.orgId, port: p2 });
    expect(r2.hadFailures).toBe(true);
    expect(JSON.stringify(r2.outcomes)).toContain('ghost');
  });

  it('W4: fewer receipts read than POS counted by client time is a failure line, and what was read is still imported', async () => {
    const f = await fixture('w4');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a' }));
    port.crossCheckOverride = (_s, d, base) => (d === YESTERDAY ? { ...base, byClientMs: 3 } : base);
    const r = await sweep({ orgId: f.orgId, port });
    expect(r.hadFailures).toBe(true);
    expect((await headers(f.orgId)).length).toBe(1);
  });

  it('L1: an UNLINKED store is never read, and a store with no link is not read either (live links only)', async () => {
    const f = await fixture('l1', { unlinked: true });
    const port = new FakePort();
    const r = await sweep({ orgId: f.orgId, port });
    expect(port.calls.filter((c) => c.includes(f.posStoreId))).toEqual([]);
    expect(r.hadFailures).toBe(false);
    const g = await fixture('l1b', { linked: false });
    const p2 = new FakePort();
    await sweep({ orgId: g.orgId, port: p2 });
    expect(p2.calls).toEqual([]);
  });
});

describe('R: what is written', () => {
  it('R0: a sale lands as header + lines + tenders in whole centavos, each child with the header org and calendar date', async () => {
    const f = await fixture('r0');
    const port = new FakePort();
    port.put(
      f.posStoreId,
      YESTERDAY,
      receipt({
        id: 'sale-1',
        total: '1250.50',
        discounts: '50.00',
        lines: [
          { itemName: 'Unli Pork', unitPrice: '399.00' as never, qtyOrdered: 2 },
          { itemName: 'Iced Tea', unitPrice: '75.25' as never },
        ],
        tenders: [
          { methodName: 'Cash', alias: 'cash', amount: '800.50' as never },
          { methodName: 'G-Cash', alias: 'gcash', amount: '450.00' as never },
          { methodName: 'Mystery Pay', alias: 'mysterypay', amount: '0.00' as never },
        ],
      }),
    );
    const r = await sweep({ orgId: f.orgId, port });
    expect(r.hadFailures).toBe(false);
    const [h] = await headers(f.orgId);
    expect(h).toMatchObject({
      firestore_doc_id: 'sale-1',
      version: 1,
      kind: 'sale',
      status: 'final',
      pos_calendar_date: YESTERDAY,
      total_centavos: '125050',
      discount_centavos: '5000',
      subtotal_centavos: '130050',
      money_flag: false,
    });
    const lines = await sql<{ line_no: number; org_id: string; pos_calendar_date: string; unit_price_centavos: string; quantity: string }[]>`
      select line_no, org_id, pos_calendar_date::text, unit_price_centavos::text, quantity::text from pos_bridge_receipt_lines where receipt_id = ${h!.id} order by line_no`;
    expect(lines.map((l) => [l.line_no, l.unit_price_centavos, l.org_id, l.pos_calendar_date])).toEqual([
      [1, '39900', f.orgId, YESTERDAY],
      [2, '7525', f.orgId, YESTERDAY],
    ]);
    expect(lines[0]!.quantity).toBe('2.000');
    const tenders = await sql<{ method_alias: string; tender_id: string | null; amount_centavos: string; pos_calendar_date: string; org_id: string }[]>`
      select method_alias, tender_id, amount_centavos::text, pos_calendar_date::text, org_id from pos_bridge_receipt_tenders where receipt_id = ${h!.id} order by seq`;
    // Matched through the normalised alias ("G-Cash" and "GCash" are one tender); an unknown method stays unmatched, never dropped.
    expect(tenders.map((t) => [t.method_alias, t.tender_id, t.amount_centavos, t.pos_calendar_date, t.org_id])).toEqual([
      ['Cash', f.cashTenderId, '80050', YESTERDAY, f.orgId],
      ['G-Cash', f.gcashTenderId, '45000', YESTERDAY, f.orgId],
      ['Mystery Pay', null, '0', YESTERDAY, f.orgId],
    ]);
  });

  it('R1: a refund keeps its kind and negative total; a voided receipt is stored as voided', async () => {
    const f = await fixture('r1');
    const port = new FakePort();
    port.put(
      f.posStoreId,
      YESTERDAY,
      receipt({ id: 'rf-1', total: '-100.00', kind: 'refund' }),
      receipt({ id: 'void-1', status: 'voided', voidedAt: '2027-01-12T05:00:00.000Z' }),
    );
    await sweep({ orgId: f.orgId, port });
    const hs = await headers(f.orgId);
    expect(hs.find((h) => h.firestore_doc_id === 'rf-1')).toMatchObject({ kind: 'refund', total_centavos: '-10000' });
    expect(hs.find((h) => h.firestore_doc_id === 'void-1')).toMatchObject({ status: 'voided' });
  });

  it('M1: a non-centavo money value is stored rounded WITH money_flag, and the receipt is never dropped', async () => {
    const f = await fixture('m1');
    const port = new FakePort();
    port.put(
      f.posStoreId,
      YESTERDAY,
      receipt({
        id: 'odd',
        total: '648.65',
        moneyFlag: true,
        lines: [{ unitPrice: '648.65' as never, moneyFlag: true }],
        tenders: [{ amount: '648.65' as never, moneyFlag: true }],
      }),
    );
    const r = await sweep({ orgId: f.orgId, port });
    expect(r.hadFailures).toBe(false);
    const [h] = await headers(f.orgId);
    expect(h).toMatchObject({ firestore_doc_id: 'odd', total_centavos: '64865', money_flag: true });
    const [l] = await sql<{ money_flag: boolean }[]>`select money_flag from pos_bridge_receipt_lines where receipt_id = ${h!.id}`;
    const [t] = await sql<{ money_flag: boolean }[]>`select money_flag from pos_bridge_receipt_tenders where receipt_id = ${h!.id}`;
    expect([l!.money_flag, t!.money_flag]).toEqual([true, true]);
  });
});

describe('V: versions by hash', () => {
  it('V1: the same hash on a second night mints NO version and rewrites nothing', async () => {
    const f = await fixture('v1');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', v: 1 }));
    const first = await sweep({ orgId: f.orgId, port });
    expect(first.outcomes[0]!.posted).toBe(1);
    const second = await sweep({ orgId: f.orgId, port, now: NEXT });
    expect(second.outcomes[0]!.posted).toBe(0);
    expect((await headers(f.orgId)).map((h) => h.version)).toEqual([1]);
    expect(await countRows(f.orgId, 'pos_bridge_receipt_lines')).toBe(1);
  });

  it('V3: a changed hash mints version 2 with its own lines/tenders; version 1 is kept as it was', async () => {
    const f = await fixture('v3');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', v: 1, total: '100.00' }));
    await sweep({ orgId: f.orgId, port });
    port.clear(f.posStoreId, YESTERDAY);
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', v: 2, total: '120.00' }));
    await sweep({ orgId: f.orgId, port, now: NEXT, date: YESTERDAY });
    expect((await headers(f.orgId)).map((h) => [h.version, h.total_centavos])).toEqual([[1, '10000'], [2, '12000']]);
    expect(await countRows(f.orgId, 'pos_bridge_receipt_lines')).toBe(2);
    expect(await countRows(f.orgId, 'pos_bridge_receipt_tenders')).toBe(2);
  });

  it('V3b: a void found by the change-time query becomes a new voided version', async () => {
    const f = await fixture('v3b');
    const port = new FakePort();
    port.put(f.posStoreId, '2027-01-08', receipt({ id: 'old', date: '2027-01-08', v: 1 }));
    await sweep({ orgId: f.orgId, port });
    port.clear(f.posStoreId, '2027-01-08');
    const voided = receipt({ id: 'old', date: '2027-01-08', v: 2, status: 'voided', voidedAt: '2027-01-12T03:00:00.000Z' });
    port.put(f.posStoreId, '2027-01-08', voided);
    port.changed.voidedAt.push(voided);
    await sweep({ orgId: f.orgId, port, now: NEXT });
    expect((await headers(f.orgId)).map((h) => [h.version, h.status])).toEqual([[1, 'final'], [2, 'voided']]);
  });

  it('V3c: a receipt older than the window, found only by a change-time query, is written on its own calendar date', async () => {
    const f = await fixture('v3c');
    const port = new FakePort();
    port.changed.createdAt.push(receipt({ id: 'late', date: '2027-01-02' }));
    await sweep({ orgId: f.orgId, port });
    expect((await headers(f.orgId)).map((h) => [h.firestore_doc_id, h.pos_calendar_date])).toEqual([['late', '2027-01-02']]);
  });

  it('V4: a document missing from a re-read day gets a GONE version, drops out of the day figures, and coming back mints a new version', async () => {
    const f = await fixture('v4');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', v: 1 }), receipt({ id: 'b', v: 1 }));
    await sweep({ orgId: f.orgId, port });
    port.clear(f.posStoreId, YESTERDAY);
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', v: 1 }));
    // gone is only seen on a day that is actually re-read (the read budget), so the day is named.
    await sweep({ orgId: f.orgId, port, now: NEXT, date: YESTERDAY });
    let hs = await headers(f.orgId);
    expect(hs.filter((h) => h.firestore_doc_id === 'b').map((h) => [h.version, h.status])).toEqual([[1, 'final'], [2, 'gone']]);
    expect(hs.filter((h) => h.firestore_doc_id === 'a').length).toBe(1);
    expect((await checkOf(f, YESTERDAY))!.receipt_count).toBe(1);
    await sweep({ orgId: f.orgId, port, now: '2027-01-14T22:30:00.000Z', date: YESTERDAY });
    hs = await headers(f.orgId);
    expect(hs.filter((h) => h.firestore_doc_id === 'b').length).toBe(2);
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'b', v: 1 }));
    await sweep({ orgId: f.orgId, port, now: '2027-01-15T22:30:00.000Z', date: YESTERDAY });
    hs = await headers(f.orgId);
    expect(hs.filter((h) => h.firestore_doc_id === 'b').map((h) => [h.version, h.status])).toEqual([[1, 'final'], [2, 'gone'], [3, 'final']]);
  });

  it('V5: a document found by a change-time query is not marked gone just because the day list did not hold it', async () => {
    const f = await fixture('v5');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', v: 1 }));
    await sweep({ orgId: f.orgId, port });
    port.clear(f.posStoreId, YESTERDAY);
    port.changed.editedAt.push(receipt({ id: 'a', v: 1 }));
    await sweep({ orgId: f.orgId, port, now: NEXT });
    expect((await headers(f.orgId)).map((h) => h.status)).toEqual(['final']);
  });
});

describe('F + D: the 2027-01-01 write floor and the dry run', () => {
  it('F1: a live run on 31 Dec 2026 READS yesterday but writes nothing before the floor; the first 2027 day is written', async () => {
    const f = await fixture('f1');
    const port = new FakePort();
    port.put(f.posStoreId, '2026-12-30', receipt({ id: 'dec', date: '2026-12-30' }));
    const r = await sweep({ orgId: f.orgId, port, now: DEC_NOW });
    expect(port.datesCalled(f.posStoreId, 'listDay')).toContain('2026-12-30');
    expect(await countRows(f.orgId, 'pos_bridge_receipts')).toBe(0);
    expect(await countRows(f.orgId, 'pos_bridge_day_checks')).toBe(0);
    expect(r.hadFailures).toBe(false);
    expect(r.outcomes[0]!.detail ?? '').toMatch(/before 1 Jan 2027/);
    const p2 = new FakePort();
    p2.put(f.posStoreId, '2027-01-01', receipt({ id: 'jan1', date: '2027-01-01' }));
    p2.put(f.posStoreId, '2026-12-31', receipt({ id: 'dec31', date: '2026-12-31' }));
    await sweep({ orgId: f.orgId, port: p2, now: '2027-01-01T22:30:00.000Z' });
    expect((await headers(f.orgId)).map((h) => h.firestore_doc_id)).toEqual(['jan1']);
  });

  it('F2: a change-time hit on a pre-2027 receipt is read, not written', async () => {
    const f = await fixture('f2');
    const port = new FakePort();
    port.changed.voidedAt.push(receipt({ id: 'ancient', date: '2026-11-05' }));
    await sweep({ orgId: f.orgId, port });
    expect(await countRows(f.orgId, 'pos_bridge_receipts')).toBe(0);
  });

  it('D1: a dry run reads and reports what it would write, and writes NOTHING (no receipts, checks or run row)', async () => {
    const f = await fixture('d1');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a' }), receipt({ id: 'b' }));
    const r = await sweep({ orgId: f.orgId, port, dryRun: true });
    expect(port.datesCalled(f.posStoreId, 'listDay')).toEqual([YESTERDAY]);
    expect(r.outcomes[0]!.posted).toBe(2);
    for (const t of ['pos_bridge_receipts', 'pos_bridge_receipt_lines', 'pos_bridge_receipt_tenders', 'pos_bridge_day_checks']) {
      expect(await countRows(f.orgId, t), t).toBe(0);
    }
    expect((await runs(f.orgId)).length).toBe(0);
  });

  it('D2: the December rehearsal: a dry run on 31 Dec 2026 reports yesterday as readable and writes nothing', async () => {
    const f = await fixture('d2');
    const port = new FakePort();
    port.put(f.posStoreId, '2026-12-30', receipt({ id: 'dec', date: '2026-12-30' }));
    const r = await sweep({ orgId: f.orgId, port, now: DEC_NOW, dryRun: true });
    expect(r.outcomes[0]!.posted).toBe(1);
    expect(await countRows(f.orgId, 'pos_bridge_receipts')).toBe(0);
  });

  it('N1: a live run records a scheduler_runs row for job pos_receipt_bridge with the counts', async () => {
    const f = await fixture('n1');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a' }));
    await sweep({ orgId: f.orgId, port });
    const rs = await runs(f.orgId);
    expect(rs.length).toBe(1);
    expect(rs[0]).toMatchObject({ outcome: 'ok', posted_count: 1 });
  });
});

describe('B: the Firestore read budget (about 8.4k reads a night, not 7 days of them)', () => {
  it('B1: a night with every check present reads exactly ONE day (yesterday)', async () => {
    const f = await fixture('b1');
    await sweep({ orgId: f.orgId, port: new FakePort() }); // first night: no checks yet, so the whole window
    const port = new FakePort();
    await sweep({ orgId: f.orgId, port, now: NEXT });
    expect(port.datesCalled(f.posStoreId, 'listDay')).toEqual(['2027-01-13']);
    expect(port.datesCalled(f.posStoreId, 'cross')).toEqual(['2027-01-13']);
    expect(port.datesCalled(f.posStoreId, 'listMissing')).toEqual(['2027-01-13']);
  });

  it('B2: one missing check means that day is read too (a host that was down, a store linked late)', async () => {
    const f = await fixture('b2');
    await sweep({ orgId: f.orgId, port: new FakePort() });
    await sql`delete from pos_bridge_day_checks where org_id = ${f.orgId} and pos_calendar_date = '2027-01-10'`;
    const port = new FakePort();
    await sweep({ orgId: f.orgId, port, now: NEXT });
    expect(port.datesCalled(f.posStoreId, 'listDay')).toEqual(['2027-01-10', '2027-01-13']);
  });

  it('B3: days before the write floor never get a check, so they are not re-read every night: a December night reads yesterday only', async () => {
    const f = await fixture('b3');
    await sweep({ orgId: f.orgId, port: new FakePort(), now: DEC_NOW });
    const port = new FakePort();
    await sweep({ orgId: f.orgId, port, now: '2026-12-31T22:30:00.000Z' });
    expect(port.datesCalled(f.posStoreId, 'listDay')).toEqual(['2026-12-31']);
  });

  it('B4: --date reads exactly that day, live or dry', async () => {
    const f = await fixture('b4');
    const port = new FakePort();
    await sweep({ orgId: f.orgId, port, date: '2027-01-09', dryRun: true });
    expect(port.datesCalled(f.posStoreId, 'listDay')).toEqual(['2027-01-09']);
  });
});

describe('C: concurrent runs', () => {
  it('C1: two runs at once leave exactly one version per document and no failures', async () => {
    const f = await fixture('c1');
    const mk = () => new FakePort().put(f.posStoreId, YESTERDAY, receipt({ id: 'a' }), receipt({ id: 'b' }), receipt({ id: 'c' }));
    const [x, y] = await Promise.all([sweep({ orgId: f.orgId, port: mk() }), sweep({ orgId: f.orgId, port: mk() })]);
    expect(x.hadFailures).toBe(false);
    expect(y.hadFailures).toBe(false);
    expect((await headers(f.orgId)).map((h) => [h.firestore_doc_id, h.version])).toEqual([['a', 1], ['b', 1], ['c', 1]]);
    expect(await countRows(f.orgId, 'pos_bridge_receipt_lines')).toBe(3);
  });

  it('C2: the repo answers "raced" (a skip), not an error, when another transaction wins the same version (the 23505 case)', async () => {
    const f = await fixture('c2');
    const { posBridgeRepo } = await import('@shareat/db');
    const header = {
      orgId: f.orgId, storeId: f.storeId, posStoreId: f.posStoreId, firestoreDocId: 'a', kind: 'sale' as const, status: 'final' as const,
      receiptNumber: null, terminalNo: null, parentDocId: null, clientAt: null, posCalendarDate: YESTERDAY,
      subtotalCentavos: 100, discountCentavos: 0, totalCentavos: 100, moneyFlag: false, raw: {}, docHash: sha('x'),
    };
    const lines = [{ lineNo: 1, posItemId: null, itemName: 'x', quantity: decimal('1.000', '14,3'), unitPriceCentavos: 100, discountCentavos: 0, lineTotalCentavos: 100, moneyFlag: false }];
    const results = await Promise.all([
      asOrg(f.orgId, (tx) => posBridgeRepo.insertVersion(tx, header, lines, [], 1)),
      asOrg(f.orgId, (tx) => posBridgeRepo.insertVersion(tx, header, lines, [], 1)),
    ]);
    expect([...results].sort()).toEqual(['raced', 'written']);
    expect(await countRows(f.orgId, 'pos_bridge_receipts')).toBe(1);
    expect(await countRows(f.orgId, 'pos_bridge_receipt_lines')).toBe(1);
  });
});

describe('K: day checks against the day feed (Ruling 6)', () => {
  it('K1: final sales minus refunds equal to the feed is a match; voided receipts do not count; sales_days is untouched', async () => {
    const f = await fixture('k1');
    const before = await countRows(f.orgId, 'sales_days');
    await addFeed(f, YESTERDAY, 900);
    const port = new FakePort();
    port.put(
      f.posStoreId,
      YESTERDAY,
      receipt({ id: 's1', total: '600.00' }),
      receipt({ id: 's2', total: '400.00' }),
      receipt({ id: 'rf-1', total: '-100.00', kind: 'refund' }),
      receipt({ id: 'v1', total: '999.00', status: 'voided' }),
    );
    await sweep({ orgId: f.orgId, port });
    expect(await checkOf(f, YESTERDAY)).toMatchObject({ result: 'match', receipt_count: 3, net_sales_centavos: '90000', feed_total_centavos: '90000', difference_centavos: '0' });
    expect(await countRows(f.orgId, 'sales_days')).toBe(before);
  });

  it('K2: a difference above 1 centavo per receipt is a mismatch carrying the difference; within it is a match', async () => {
    const f = await fixture('k2');
    await addFeed(f, YESTERDAY, 1000);
    await addFeed(f, '2027-01-11', 600.02);
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', total: '400.00' }), receipt({ id: 'b', total: '300.00' }));
    port.put(f.posStoreId, '2027-01-11', receipt({ id: 'c', date: '2027-01-11', total: '300.00' }), receipt({ id: 'd', date: '2027-01-11', total: '300.00' }));
    await sweep({ orgId: f.orgId, port });
    expect(await checkOf(f, YESTERDAY)).toMatchObject({ result: 'mismatch', net_sales_centavos: '70000', difference_centavos: '-30000' });
    expect(await checkOf(f, '2027-01-11')).toMatchObject({ result: 'match', difference_centavos: '-2' });
  });

  it('K3: no feed yet (or found:false) is pending with null feed figures; the check is recomputed in place the next night', async () => {
    const f = await fixture('k3');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', total: '500.00' }));
    await sweep({ orgId: f.orgId, port });
    expect(await checkOf(f, YESTERDAY)).toMatchObject({ result: 'pending', feed_total_centavos: null, difference_centavos: null, net_sales_centavos: '50000' });
    await addFeed(f, YESTERDAY, 500);
    await sweep({ orgId: f.orgId, port, now: NEXT, date: YESTERDAY });
    expect(await checkOf(f, YESTERDAY)).toMatchObject({ result: 'match' });
    // 2027-01-06..12 on the first night; the re-check of 12 Jan updated its row in place (still 7 rows).
    expect(await countRows(f.orgId, 'pos_bridge_day_checks')).toBe(7);
  });

  it('K4: a mismatch is said as a notice on the run (the Sales days note), not as a failure', async () => {
    const f = await fixture('k4');
    await addFeed(f, YESTERDAY, 1);
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', total: '500.00' }));
    const r = await sweep({ orgId: f.orgId, port });
    expect(r.hadFailures).toBe(false);
    expect(r.outcomes[0]!.failures.some((x) => x.kind === 'notice' && /Jan 12, 2027|2027-01-12/.test(x.reason))).toBe(true);
  });
});

describe('K5: the Sales days note reads mismatches through the repo (T-472 S3)', () => {
  it('lists only mismatches, newest first, for this org only', async () => {
    const f = await fixture('k5');
    const other = await fixture('k5b');
    await addFeed(f, YESTERDAY, 1);
    await addFeed(f, '2027-01-11', 500);
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', total: '500.00' }));
    port.put(f.posStoreId, '2027-01-11', receipt({ id: 'b', date: '2027-01-11', total: '500.00' }));
    await sweep({ orgId: f.orgId, port });
    const { posBridgeRepo } = await import('@shareat/db');
    const mine = await asOrg(f.orgId, (tx) => posBridgeRepo.recentMismatches(tx, f.orgId, '2027-01-01'));
    expect(mine).toEqual([{ storeId: f.storeId, posCalendarDate: YESTERDAY, differenceCentavos: 49900 }]);
    expect(await asOrg(other.orgId, (tx) => posBridgeRepo.recentMismatches(tx, other.orgId, '2027-01-01'))).toEqual([]);
    expect(await asOrg(f.orgId, (tx) => posBridgeRepo.recentMismatches(tx, f.orgId, '2027-01-13'))).toEqual([]);
  });
});

describe('P: no personal data (Ruling 7)', () => {
  it('P1: even a port that hands over personal fields gets them stripped from raw and from every column', async () => {
    const f = await fixture('p1');
    const port = new FakePort();
    port.put(
      f.posStoreId,
      YESTERDAY,
      receipt({
        id: 'pii',
        raw: {
          status: 'final',
          customerName: 'Juan Dela Cruz',
          customerTin: '123-456-789',
          customerAddress: '1 Rizal St',
          statutoryDiners: [{ kind: 'senior', name: 'Lola Basyang', idNo: 'OSCA-99', share: 1, discount: 10 }],
          nested: { customerName: 'Pedro' },
          lines: [{ id: 'l1', customerName: 'Pedro' }],
        },
      }),
    );
    await sweep({ orgId: f.orgId, port });
    const [h] = await headers(f.orgId);
    const text = JSON.stringify(h);
    for (const secret of ['Juan Dela Cruz', '123-456-789', '1 Rizal St', 'Lola Basyang', 'OSCA-99', 'Pedro']) expect(text, secret).not.toContain(secret);
    const diner = (h!.raw as { statutoryDiners: Record<string, unknown>[] }).statutoryDiners[0]!;
    expect(diner).toMatchObject({ kind: 'senior', share: 1, discount: 10 });
    expect(diner).not.toHaveProperty('name');
    expect(diner).not.toHaveProperty('idNo');
    const dump =
      JSON.stringify(await sql`select * from pos_bridge_receipt_lines where org_id = ${f.orgId}`) +
      JSON.stringify(await sql`select * from pos_bridge_receipt_tenders where org_id = ${f.orgId}`);
    for (const secret of ['Juan', 'Pedro', 'Lola']) expect(dump, secret).not.toContain(secret);
  });
});

describe('S: isolation and error text', () => {
  it('S1: RLS - org B sees none of org A, and a run for org A leaves org B untouched', async () => {
    const a = await fixture('s1a');
    const b = await fixture('s1b');
    const port = new FakePort().put(a.posStoreId, YESTERDAY, receipt({ id: 'only-a' }));
    await sweep({ orgId: a.orgId, port });
    expect(await countRows(b.orgId, 'pos_bridge_receipts')).toBe(0);
    const n = async (orgId: string) =>
      Number(((await asOrg(orgId, (tx) => tx.execute(dsql`select count(*)::int as n from pos_bridge_receipts`))) as unknown as { n: number }[])[0]!.n);
    expect(await n(b.orgId)).toBe(0);
    expect(await n(a.orgId)).toBe(1);
    expect((await runs(b.orgId)).length).toBe(0);
  });

  it('E1: a database refusal is said without row values (the hash and receipt number never reach the failure line)', async () => {
    const f = await fixture('e1');
    const port = new FakePort();
    port.put(f.posStoreId, YESTERDAY, receipt({ id: 'bad', hash: 'NOT-A-HASH-SECRET-VALUE', receiptNumber: 'RN-SECRET-123' }));
    const r = await sweep({ orgId: f.orgId, port });
    expect(r.hadFailures).toBe(true);
    const text = JSON.stringify(r.outcomes);
    expect(text).not.toContain('NOT-A-HASH-SECRET-VALUE');
    expect(text).not.toContain('RN-SECRET-123');
    expect(text).not.toMatch(/Failed query|insert into/i);
    expect(text).toContain('bad');
  });

  it('E2: a port failure stops that store and is a failure line, not a quiet success', async () => {
    const f = await fixture('e2');
    const port = new FakePort();
    port.failListDay = new Error('Firestore unavailable');
    const r = await sweep({ orgId: f.orgId, port });
    expect(r.hadFailures).toBe(true);
    expect(JSON.stringify(r.outcomes)).toContain('Firestore unavailable');
  });
});

describe('X: T-490 (DEF-781) - a day older than yesterday is re-checked when a late receipt, void or day feed changes it', () => {
  const D = '2027-01-09'; // inside the window of both nights, older than yesterday on each

  it('X1: a late receipt dated D (found by a change-time query) recomputes D\'s existing check: match becomes mismatch, with a notice', async () => {
    const f = await fixture('x1');
    await addFeed(f, D, 100);
    const night1 = new FakePort();
    night1.put(f.posStoreId, D, receipt({ id: 'a', date: D, total: '100.00' }));
    await sweep({ orgId: f.orgId, port: night1 });
    expect(await checkOf(f, D)).toMatchObject({ result: 'match', receipt_count: 1, net_sales_centavos: '10000' });

    const night2 = new FakePort();
    night2.changed.createdAt = [receipt({ id: 'late', date: D, total: '50.00' })];
    const r = await sweep({ orgId: f.orgId, port: night2, now: NEXT });
    expect(await checkOf(f, D)).toMatchObject({ result: 'mismatch', receipt_count: 2, net_sales_centavos: '15000', feed_total_centavos: '10000', difference_centavos: '5000' });
    expect(r.outcomes[0]!.failures.some((x) => x.kind === 'notice' && x.reason.includes('POS\'s day total'))).toBe(true);
  });

  it('X2: a pending day whose day feed landed in Postgres before the next night becomes match or mismatch with no receipt changing', async () => {
    const f = await fixture('x2');
    const night1 = new FakePort();
    night1.put(f.posStoreId, D, receipt({ id: 'a', date: D, total: '100.00' }));
    await sweep({ orgId: f.orgId, port: night1 });
    expect(await checkOf(f, D)).toMatchObject({ result: 'pending', feed_total_centavos: null });

    await addFeed(f, D, 100);
    const night2 = new FakePort();
    await sweep({ orgId: f.orgId, port: night2, now: NEXT });
    expect(await checkOf(f, D)).toMatchObject({ result: 'match', feed_total_centavos: '10000', difference_centavos: '0' });

    // and a feed that disagrees on another pending day is a mismatch
    const g = await fixture('x2b');
    const n1 = new FakePort();
    n1.put(g.posStoreId, D, receipt({ id: 'a', date: D, total: '100.00' }));
    await sweep({ orgId: g.orgId, port: n1 });
    await addFeed(g, D, 700);
    await sweep({ orgId: g.orgId, port: new FakePort(), now: NEXT });
    expect(await checkOf(g, D)).toMatchObject({ result: 'mismatch', difference_centavos: '-60000' });
  });

  it('X3: a refreshed day never mints a gone version (change-time reads are not a full inventory of the day)', async () => {
    const f = await fixture('x3');
    await addFeed(f, D, 100);
    const night1 = new FakePort();
    night1.put(f.posStoreId, D, receipt({ id: 'a', date: D, total: '100.00' }), receipt({ id: 'b', date: D, total: '30.00' }));
    await sweep({ orgId: f.orgId, port: night1 });
    const night2 = new FakePort();
    night2.changed.createdAt = [receipt({ id: 'late', date: D, total: '50.00' })]; // a and b are NOT in the change-time result
    await sweep({ orgId: f.orgId, port: night2, now: NEXT });
    const hs = await headers(f.orgId);
    expect(hs.filter((h) => h.status === 'gone')).toEqual([]);
    expect(hs.filter((h) => h.firestore_doc_id === 'a' || h.firestore_doc_id === 'b').map((h) => h.version)).toEqual([1, 1]);
    expect(await checkOf(f, D)).toMatchObject({ receipt_count: 3, net_sales_centavos: '18000' });
  });

  it('X4: the read budget is unchanged: refreshing days adds no Firestore day read (same listDay / cross / listMissing dates as B1)', async () => {
    const f = await fixture('x4');
    await addFeed(f, D, 100);
    const night1 = new FakePort();
    night1.put(f.posStoreId, D, receipt({ id: 'a', date: D, total: '100.00' }));
    await sweep({ orgId: f.orgId, port: night1 });
    const night2 = new FakePort();
    night2.changed.voidedAt = [receipt({ id: 'a', date: D, total: '100.00', status: 'voided', v: 2 })];
    night2.changed.createdAt = [receipt({ id: 'late', date: '2027-01-08', total: '20.00' })];
    await sweep({ orgId: f.orgId, port: night2, now: NEXT });
    expect(night2.datesCalled(f.posStoreId, 'listDay')).toEqual(['2027-01-13']);
    expect(night2.datesCalled(f.posStoreId, 'cross')).toEqual(['2027-01-13']);
    expect(night2.datesCalled(f.posStoreId, 'listMissing')).toEqual(['2027-01-13']);
    // the void did change D's check (a in-place void), though: net is now 0 against a feed of 100
    expect(await checkOf(f, D)).toMatchObject({ result: 'mismatch', receipt_count: 0, net_sales_centavos: '0' });
    expect(await checkOf(f, '2027-01-08')).toMatchObject({ receipt_count: 1, net_sales_centavos: '2000' });
  });

  it('Y1: a partly-read day gets NO check tonight (even with a change-time receipt on it) and is re-read in full the next night', async () => {
    const f = await fixture('y1');
    const night = new FakePort();
    night.put(f.posStoreId, YESTERDAY, receipt({ id: 'a', total: '100.00' }));
    night.crossCheckOverride = (_s, date, d) => (date === YESTERDAY ? { ...d, byClientMs: d.byClientMs + 1 } : d); // POS counts one more than was read
    night.changed.createdAt = [receipt({ id: 'late', total: '50.00' })];
    await sweep({ orgId: f.orgId, port: night });
    expect(await checkOf(f, YESTERDAY)).toBeUndefined();
    const night2 = new FakePort();
    await sweep({ orgId: f.orgId, port: night2, now: NEXT });
    expect(night2.datesCalled(f.posStoreId, 'listDay')).toEqual([YESTERDAY, '2027-01-13']);
  });

  it('Y2: a match day whose day feed is revised later is re-checked to mismatch within the window', async () => {
    const f = await fixture('y2');
    await addFeed(f, D, 100);
    const night1 = new FakePort();
    night1.put(f.posStoreId, D, receipt({ id: 'a', date: D, total: '100.00' }));
    await sweep({ orgId: f.orgId, port: night1 });
    expect(await checkOf(f, D)).toMatchObject({ result: 'match' });
    await addFeed(f, D, 400);
    await sweep({ orgId: f.orgId, port: new FakePort(), now: NEXT });
    expect(await checkOf(f, D)).toMatchObject({ result: 'mismatch', feed_total_centavos: '40000', difference_centavos: '-30000' });
  });

  it('Y3: a window day with no change is re-checked and comes out the same, with no new notice', async () => {
    const f = await fixture('y3');
    await addFeed(f, D, 100);
    const night1 = new FakePort();
    night1.put(f.posStoreId, D, receipt({ id: 'a', date: D, total: '100.00' }));
    await sweep({ orgId: f.orgId, port: night1 });
    const r = await sweep({ orgId: f.orgId, port: new FakePort(), now: NEXT });
    expect(await checkOf(f, D)).toMatchObject({ result: 'match', receipt_count: 1, net_sales_centavos: '10000' });
    expect(r.outcomes[0]!.failures.filter((x) => x.kind === 'notice')).toEqual([]);
    expect(r.outcomes[0]!.detail).toContain('re-checked from Postgres 6'); // 01-07..01-12 minus the freshly read 01-13
  });

  it('Y4: a date older than the window start with no change is NOT re-checked', async () => {
    const f = await fixture('y4');
    await sweep({ orgId: f.orgId, port: new FakePort() });
    await sql`insert into pos_bridge_day_checks (org_id, store_id, pos_store_id, pos_calendar_date, receipt_count, net_sales_centavos, result)
      values (${f.orgId}, ${f.storeId}, ${f.posStoreId}, '2027-01-02', 0, 0, 'pending') on conflict do nothing`;
    await addFeed(f, '2027-01-02', 0);
    await sweep({ orgId: f.orgId, port: new FakePort(), now: NEXT });
    expect(await checkOf(f, '2027-01-02')).toMatchObject({ result: 'pending', feed_total_centavos: null });
  });

  it('Y5: a --date run refreshes nothing beyond its own date', async () => {
    const f = await fixture('y5');
    await addFeed(f, D, 100);
    const night1 = new FakePort();
    night1.put(f.posStoreId, D, receipt({ id: 'a', date: D, total: '100.00' }));
    await sweep({ orgId: f.orgId, port: night1 });
    await addFeed(f, D, 400);
    await sweep({ orgId: f.orgId, port: new FakePort(), now: NEXT, date: '2027-01-12' });
    expect(await checkOf(f, D)).toMatchObject({ result: 'match', feed_total_centavos: '10000' });
  });

  it('X5: a change-time receipt dated before the write floor creates no check (and no receipt)', async () => {
    const f = await fixture('x5');
    await sweep({ orgId: f.orgId, port: new FakePort() });
    const night2 = new FakePort();
    night2.changed.createdAt = [receipt({ id: 'old', date: '2026-12-30', total: '10.00' })];
    await sweep({ orgId: f.orgId, port: night2, now: NEXT });
    expect(await checkOf(f, '2026-12-30')).toBeUndefined();
    expect(await headers(f.orgId)).toEqual([]);
  });
});
