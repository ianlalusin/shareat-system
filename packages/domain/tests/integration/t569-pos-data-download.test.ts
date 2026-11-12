/**
 * T-569 (docs/tasks/569-pos-data-download.md) - the POS v2 data download, R1-R4. Real Postgres on a scratch "_test" database.
 * The world is the T-531 fixture: real sales through the real domain, two days closed (Z), plus raw rows for ANOTHER store and for the device log.
 *
 * ASSUMED API (packages/domain/src/pos/data-export.ts, exported by pos/index.ts):
 *   exportPosData(tx, actor, { storeId, from, to, table }) -> { table, columns, rows: Record<string, string|null>[], filename }
 *   refusals are RefusalError (400-class: no store, bad date/range/table) or AuthorizationError (403-class: not your store / no view_financial_reports).
 *
 * Business date of a receipt = its Z's business_date (so the files agree with the Z readings); of a session = its receipt's; of a device event = the server's
 * received_at on the Manila calendar. Money comes out as the database prints it ('1234.50'), never through a JS number.
 * MUTANTS: money through formatMoney (test 1), org-wide download, child rows of other parents, audit written on a refusal, audit written twice.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

config({ path: '.env.local' });
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error('Refusing to run against a database whose name does not contain "_test".');
}

import { AuthorizationError } from '@shareat/auth';
import { posV2Repo, RefusalError } from '@shareat/db';
import { insRule, newItem } from '../../../db/tests/integration/_fixtures/t401-menu';
import {
  D1, D2, addDays, asOrg, auditsOf, close, closeAll, manila, pinOf, porkSale, sell, sql, standardDay, world, type Actor, type World,
} from './_fixtures/t531-day-close';
import { exportPosData, POS_EXPORT_MAX_DAYS } from '../../src/pos';
import { RATES } from './_fixtures/t531-day-close';

afterAll(closeAll);

const TABLES = posV2Repo.POS_EXPORT_TABLES;
const DB_TABLE: Record<(typeof TABLES)[number], string> = {
  receipts: 'pos_sales_receipts',
  'receipt-lines': 'pos_sales_receipt_lines',
  'receipt-line-discounts': 'pos_sales_receipt_line_discounts',
  payments: 'pos_sales_receipt_payments',
  'day-closes': 'pos_day_closes',
  'day-close-tenders': 'pos_day_close_tenders',
  'table-sessions': 'table_sessions',
  'device-events': 'pos_events',
};
const TODAY = addDays(D1, -2); // the Manila date the fixture runs on (D1 is two days on)
const ALL = { from: addDays(TODAY, -1), to: D2 };
const FORMULA_NAME = '=1+1 combo';

let w: World;
const exp = (who: Actor, input: { storeId?: string | null; from?: string | null; to?: string | null; table?: string | null }, deps?: Parameters<typeof exportPosData>[3]) =>
  asOrg(w.orgId, (tx) => exportPosData(tx, who, input, deps));
const rowsOf = async (table: (typeof TABLES)[number], range: { from: string; to: string } = ALL) =>
  (await exp(w.manager, { storeId: w.storeId, ...range, table })).rows;
const audits = async () => (await auditsOf(w, 'data.export_downloaded')).length;
const failure = (p: Promise<unknown>) => p.then(() => null, (x: unknown) => x);

async function pricedItem(name: string, amount: string) {
  const it = await newItem(w, 'a_la_carte', name);
  await insRule(w, it.variantId);
  await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
            values (${w.orgId}, ${w.storeId}, ${it.variantId}, 'store', ${null}, ${amount}, false, ${w.personId})`;
  await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${w.orgId}, ${w.storeId}, ${it.itemId}, ${w.grill}, ${w.personId})`;
  return it;
}

/** A receipt with one line and one payment, written in ONE transaction (the database refuses children added to a receipt after the transaction that wrote it). */
async function insertReceipt(o: { store: string; terminal: string; seq: number; session: string; at: string; tender: string; amount: string }): Promise<string> {
  return sql.begin(async (t) => {
    const [r] = await t<{ id: string }[]>`
      insert into pos_sales_receipts (org_id, store_id, terminal_id, receipt_seq, table_session_id, cashier_id, issued_at_device, received_at, subtotal, discount_total, total, device_total, offline)
      values (${w.orgId}, ${o.store}, ${o.terminal}, ${o.seq}, ${o.session}, ${w.adminId}, ${o.at}::timestamptz, ${o.at}::timestamptz, ${o.amount}, 0, ${o.amount}, ${o.amount}, false) returning id`;
    await t`insert into pos_sales_receipt_lines (org_id, receipt_id, line_no, kind, name, qty, unit_price, gross, discount_total, net)
            values (${w.orgId}, ${r!.id}, 1, 'item', 'Raw line', 1, ${o.amount}, ${o.amount}, 0, ${o.amount})`;
    await t`insert into pos_sales_receipt_payments (org_id, receipt_id, tender_id, amount, change_given) values (${w.orgId}, ${r!.id}, ${o.tender}, ${o.amount}, 0)`;
    return r!.id;
  });
}
const rawSession = async (store: string, stand: string, pairing: string, openedAt: string) =>
  (await sql<{ id: string }[]>`
    insert into table_sessions (org_id, store_id, stand_id, mode, heads_cashier, status, opened_by, opened_at_device, opened_at, opened_on_pairing_id)
    values (${w.orgId}, ${store}, ${stand}, 'dine_in', 2, 'paid', ${w.adminId}, ${openedAt}::timestamptz, ${openedAt}::timestamptz, ${pairing}) returning id`)[0]!.id;

beforeAll(async () => {
  w = await world();
  const big = await pricedItem('Banquet platter', '1234.50');
  const tiny = await pricedItem('Sauce cup', '0.01');
  const formula = await pricedItem(FORMULA_NAME, '10.00');
  // Day D1: the standard three receipts, a 1,234.50 receipt, a 0.01 receipt and one whose line is named like a formula. Then its Z.
  await standardDay(w, D1);
  await sell(w, { at: manila(D1, '13:00'), items: [{ item: big, qty: 1 }], expectTotal: '1234.50', pay: [{ tenderId: w.cash, amount: '1234.50' }] });
  await sell(w, { at: manila(D1, '13:30'), items: [{ item: tiny, qty: 1 }], expectTotal: '0.01', pay: [{ tenderId: w.cash, amount: '0.01' }] });
  await sell(w, { at: manila(D1, '14:00'), items: [{ item: formula, qty: 1 }], expectTotal: '10.00', pay: [{ tenderId: w.cash, amount: '10.00' }] });
  await close(w, manila(D1, '22:30'), await pinOf(w, w.managerId));
  // Day D2: one pork receipt, then its Z.
  await porkSale(w, manila(D2, '12:00'));
  await close(w, manila(D2, '22:30'), await pinOf(w, w.adminId));

  // The other store (B) and the device log: raw rows, so the scoping is proven against real neighbours.
  const [termB] = await sql<{ id: string }[]>`
    insert into pos_terminals (org_id, store_id, terminal_no, pairing_id, created_by) values (${w.orgId}, ${w.store2Id}, 1, ${w.pairingBId}, ${w.adminId}) returning id`;
  await sql`
    insert into pos_day_closes (org_id, store_id, terminal_id, z_no, business_date, window_start, window_end, receipt_count, gross_total, closed_by, approved_by)
    values (${w.orgId}, ${w.store2Id}, ${termB!.id}, 1, ${D1}, ${manila(D1, '04:00')}, ${manila(D1, '23:00')}, 0, 0, ${w.managerOtherId}, ${w.adminId})`;
  await sql`
    insert into table_sessions (org_id, store_id, stand_id, mode, heads_cashier, status, opened_by, opened_at_device, opened_on_pairing_id)
    values (${w.orgId}, ${w.store2Id}, ${w.standB}, 'dine_in', 2, 'open', ${w.adminId}, now(), ${w.pairingBId})`;
  // Store B has a receipt too (unclosed, received now) with a line and a payment: the receipt tables must not show it to store A.
  const [sessB] = await sql<{ id: string }[]>`select id from table_sessions where store_id = ${w.store2Id}`;
  await insertReceipt({ store: w.store2Id, terminal: termB!.id, seq: 1, session: sessB!.id, at: new Date().toISOString(), tender: w.cashB, amount: '77.70' });
  const ev = (store: string, pairing: string, seq: number, payload: string, receivedAt: string) => sql`
    insert into pos_events (org_id, store_id, pairing_id, seq, kind, payload, person_id, occurred_at_device, received_at, status)
    values (${w.orgId}, ${store}, ${pairing}, ${seq}, 'sale.completed', ${payload}::text::jsonb, ${w.adminId}, now(), ${receivedAt}::timestamptz, 'applied')`;
  await ev(w.storeId, w.pairingId, 9001, '{"total": 1234.50, "note": "a, b: c", "tags": [1, 2]}', new Date().toISOString());
  await ev(w.storeId, w.pairingId, 9002, '{"total": 1}', new Date(Date.now() - 10 * 86400e3).toISOString()); // outside the range
  await ev(w.store2Id, w.pairingBId, 9003, '{"total": 1}', new Date().toISOString()); // another store
});

describe('1 - every table: the header is the column list, money is the database text, NULL is empty', () => {
  for (const t of TABLES) {
    it(`${t}: header = ${DB_TABLE[t]} columns in table order; every row has every column`, async () => {
      const cols = (await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_schema = 'public' and table_name = ${DB_TABLE[t]} order by ordinal_position`).map((c) => c.column_name);
      const got = await exp(w.manager, { storeId: w.storeId, ...ALL, table: t });
      expect(got.columns).toEqual(cols);
      expect(got.rows.length, `${t} has rows`).toBeGreaterThan(0);
      for (const r of got.rows) expect(Object.keys(r)).toEqual(cols);
    });
  }

  it('a 1,234.50 receipt and a 0.01 receipt come out byte-exact in every table that carries them; trailing zeros are kept', async () => {
    const receipts = await rowsOf('receipts');
    const totals = receipts.map((r) => r.total);
    expect(totals).toContain('1234.50');
    expect(totals).toContain('0.01');
    expect(totals).toContain('1427.00');
    expect(receipts.map((r) => r.discount_total)).toContain('128.29');
    const big = receipts.find((r) => r.total === '1234.50')!;
    expect(big.subtotal).toBe('1234.50');
    expect(big.discount_total).toBe('0.00');
    expect(big.device_total).toBe('1234.50');
    const lines = await rowsOf('receipt-lines');
    expect(lines.filter((l) => l.receipt_id === big.id).map((l) => [l.unit_price, l.gross, l.net])).toEqual([['1234.50', '1234.50', '1234.50']]);
    const pays = await rowsOf('payments');
    expect(pays.filter((p) => p.receipt_id === big.id).map((p) => [p.amount, p.change_given])).toEqual([['1234.50', '0.00']]);
    expect(pays.map((p) => p.amount)).toContain('0.01');
    const senior = (await rowsOf('receipt-line-discounts')).find((d) => d.kind === 'senior')!;
    expect([senior.vat_removed, senior.discount_amount]).toEqual(['48.11', '80.18']); // 48.11 + 80.18 = the 128.29 on the receipt
    // every money cell of every table is a plain decimal: no peso sign, no thousands comma, never a JS-float tail
    for (const t of ['receipts', 'receipt-lines', 'payments', 'day-closes', 'day-close-tenders', 'receipt-line-discounts'] as const) {
      for (const r of await rowsOf(t)) {
        for (const c of ['subtotal', 'discount_total', 'total', 'device_total', 'unit_price', 'gross', 'net', 'amount', 'change_given', 'gross_total', 'value', 'vat_removed', 'discount_amount']) {
          if (c in r) expect(r[c], `${t}.${c}`).toMatch(/^-?\d+\.\d{2}$/);
        }
      }
    }
  });

  it('NULL is null (the CSV writes an empty cell); timestamps are ISO with an offset; jsonb is compact text in jsonb key order with every number untouched', async () => {
    const receipts = await rowsOf('receipts');
    expect(receipts.every((r) => r.day_close_id !== null)).toBe(true);
    const sessions = await rowsOf('table-sessions');
    expect(sessions.every((s) => s.heads_server === null && s.voided_by === null && s.void_reason === null)).toBe(true);
    expect(sessions[0]!.opened_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/);
    const events = await rowsOf('device-events');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toBe('{"note":"a, b: c","tags":[1,2],"total":1234.50}');
    expect(events[0]!.error).toBeNull();
    expect(events[0]!.resolved_by).toBeNull();
  });
});

describe('2 - rows outside the range or from another store are absent', () => {
  it('a one-day range holds only that business day (by Z date); the other day is absent', async () => {
    const d1 = await rowsOf('receipts', { from: D1, to: D1 });
    const d2 = await rowsOf('receipts', { from: D2, to: D2 });
    expect(d1).toHaveLength(6);
    expect(d2).toHaveLength(1);
    expect(d2[0]!.total).toBe('250.00');
    expect(new Set(d1.map((r) => r.id)).size).toBe(6);
    expect((await rowsOf('day-closes', { from: D1, to: D1 })).map((c) => c.business_date)).toEqual([D1]);
    expect((await rowsOf('day-closes', { from: D2, to: D2 })).map((c) => c.business_date)).toEqual([D2]);
    expect((await rowsOf('table-sessions', { from: D1, to: D1 })).length).toBe(6);
    expect((await rowsOf('table-sessions', { from: D2, to: D2 })).length).toBe(1);
    expect(await rowsOf('receipts', { from: addDays(D2, 1), to: addDays(D2, 2) })).toEqual([]);
  });

  it("another store's close, session and device event are absent; the other store's own download holds only its own", async () => {
    expect((await rowsOf('day-closes')).map((c) => c.store_id)).toEqual([w.storeId, w.storeId]);
    expect((await rowsOf('table-sessions')).every((s) => s.store_id === w.storeId)).toBe(true);
    expect((await rowsOf('table-sessions')).length).toBe(7);
    expect((await rowsOf('device-events')).map((e) => e.seq)).toEqual(['9001']);
    const b = await exp(w.admin, { storeId: w.store2Id, ...ALL, table: 'day-closes' });
    expect(b.rows.map((c) => c.store_id)).toEqual([w.store2Id]);
  });

  it("the device log is dated by the server's received time: the 10-day-old event appears only in a range that holds it", async () => {
    const got = await rowsOf('device-events', { from: addDays(TODAY, -11), to: addDays(TODAY, -9) });
    expect(got.map((e) => e.seq)).toEqual(['9002']);
  });
});

describe('3 - child tables hold only the children of the chosen parents', () => {
  it("payments, lines and discounts of D2 are exactly D2 receipts' children; D1 children are never in D2", async () => {
    const d2 = { from: D2, to: D2 };
    const d2Receipts = new Set((await rowsOf('receipts', d2)).map((r) => r.id!));
    const d2Lines = await rowsOf('receipt-lines', d2);
    expect(d2Lines.length).toBeGreaterThan(0);
    expect(d2Lines.every((l) => d2Receipts.has(l.receipt_id!))).toBe(true);
    const d2Pays = await rowsOf('payments', d2);
    expect(d2Pays.length).toBeGreaterThan(0);
    expect(d2Pays.every((p) => d2Receipts.has(p.receipt_id!))).toBe(true);
    expect(await rowsOf('receipt-line-discounts', d2)).toEqual([]); // the pork sale has no discount; D1's senior and preset discounts must not leak in
    // the oracle: the database's own count of the D2 receipts' lines
    const [row] = await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipt_lines l where l.receipt_id = any(${[...d2Receipts]})`;
    expect(d2Lines.length).toBe(row!.n);
  });

  it("D1: discounts belong to D1 lines; day-close tenders belong to the chosen close only", async () => {
    const d1 = { from: D1, to: D1 };
    const lineIds = new Set((await rowsOf('receipt-lines', d1)).map((l) => l.id!));
    const discounts = await rowsOf('receipt-line-discounts', d1);
    expect(discounts.length).toBe(2); // the senior line and the 10% preset line of the standard day
    expect(discounts.every((d) => lineIds.has(d.receipt_line_id!))).toBe(true);
    const closes = await rowsOf('day-closes', d1);
    const tenders = await rowsOf('day-close-tenders', d1);
    expect(tenders.length).toBeGreaterThan(0);
    expect(tenders.every((t) => t.day_close_id === closes[0]!.id)).toBe(true);
    const d2Tenders = await rowsOf('day-close-tenders', { from: D2, to: D2 });
    expect(d2Tenders.every((t) => t.day_close_id !== closes[0]!.id)).toBe(true);
  });
});

describe('4 - refused: no store, a store out of scope, no view_financial_reports, too many days, a bad table or date - and NO audit row', () => {
  let base = 0;
  beforeAll(async () => {
    base = await audits();
  });
  it('no store -> a sentence (no org-wide download)', async () => {
    for (const storeId of [undefined, null, '']) {
      const e = await failure(exp(w.admin, { storeId, from: D1, to: D1, table: 'receipts' }));
      expect(e).toBeInstanceOf(RefusalError);
      expect((e as RefusalError).userMessage).toMatch(/one store/i);
    }
    expect(await failure(exp(w.admin, { storeId: 'not-an-id', from: D1, to: D1, table: 'receipts' }))).toBeInstanceOf(RefusalError);
  });

  it("a store that is not the person's (manager of A asks for B; another organisation's store), and staff without view_financial_reports", async () => {
    const other = await world();
    const cases: [string, Actor, string][] = [
      ['manager of A, store B', w.manager, w.store2Id],
      ["admin, another org's store", w.admin, other.storeId],
      ['staff counter at A', w.counter, w.storeId],
      ['kitchen staff at A', w.kitchen, w.storeId],
    ];
    for (const [label, who, storeId] of cases) {
      const e = await failure(exp(who, { storeId, from: D1, to: D1, table: 'receipts' }));
      expect(e, label).not.toBeNull();
      expect(e instanceof AuthorizationError || e instanceof RefusalError, `${label}: ${String((e as Error)?.message)}`).toBe(true);
    }
    // the staff refusal is the capability, not a refusal of the request's shape
    expect(await failure(exp(w.counter, { storeId: w.storeId, from: D1, to: D1, table: 'receipts' }))).toBeInstanceOf(AuthorizationError);
    expect(await failure(exp(w.manager, { storeId: w.store2Id, from: D1, to: D1, table: 'receipts' }))).toBeInstanceOf(AuthorizationError);
  });

  it(`more than ${POS_EXPORT_MAX_DAYS} days, from after to, a bad date, a bad or missing table`, async () => {
    const from = '2026-12-01';
    const exactly62 = addDays(from, POS_EXPORT_MAX_DAYS - 1);
    expect((await exp(w.manager, { storeId: w.storeId, from, to: exactly62, table: 'receipts' })).table).toBe('receipts'); // 62 days passes (and writes the one audit row)
    for (const bad of [
      { from, to: addDays(from, POS_EXPORT_MAX_DAYS), table: 'receipts' },
      { from: D2, to: D1, table: 'receipts' },
      { from: '2026-02-30', to: '2026-03-01', table: 'receipts' },
      { from: 'yesterday', to: D1, table: 'receipts' },
      { from: D1, to: null, table: 'receipts' },
      { from: D1, to: D1, table: 'pos_sales_receipts' },
      { from: D1, to: D1, table: 'users' },
      { from: D1, to: D1, table: null },
    ]) {
      expect(await failure(exp(w.manager, { storeId: w.storeId, ...bad })), JSON.stringify(bad)).toBeInstanceOf(RefusalError);
    }
  });

  it('after every refusal above there is still no data.export_downloaded row, except the one successful 62-day call', async () => {
    expect(await audits()).toBe(base + 1);
  });
});

describe('5 - a successful download writes exactly one data.export_downloaded row, with the details', () => {
  it('one row per download: actor, org scope (no store), entity exports, details {kind, table, storeId, from, to, rowCount}', async () => {
    const before = await audits();
    const got = await exp(w.manager, { storeId: w.storeId, from: D1, to: D1, table: 'payments' });
    expect(await audits()).toBe(before + 1);
    const rows = await sql<{ actor_person_id: string; store_id: string | null; entity: string; after: unknown; category: string; source: string }[]>`
      select actor_person_id, store_id, entity, after, category, source from audit_log
       where org_id = ${w.orgId} and action = 'data.export_downloaded' order by recorded_at desc, id limit 1`;
    expect(rows[0]).toMatchObject({ actor_person_id: w.managerId, store_id: null, entity: 'exports', category: 'data', source: 'web' });
    expect(rows[0]!.after).toEqual({ kind: 'pos_data', table: 'payments', storeId: w.storeId, from: D1, to: D1, rowCount: got.rows.length });
    expect(got.filename).toBe(`pos-${w.storeCode.toLowerCase()}-payments-${D1}-to-${D1}.csv`);
    await exp(w.manager, { storeId: w.storeId, from: D1, to: D1, table: 'payments' });
    expect(await audits()).toBe(before + 2); // a second download is a second row
  });
});

describe('C - another store: its receipts, lines and payments never reach this stores files (and are in its own)', () => {
  it('store A holds none of the other stores receipt, line or payment; its own download holds exactly those', async () => {
    const aReceipts = await rowsOf('receipts');
    expect(aReceipts.every((r) => r.store_id === w.storeId)).toBe(true);
    expect(aReceipts.map((r) => r.total)).not.toContain('77.70');
    expect((await rowsOf('receipt-lines')).map((l) => l.name)).not.toContain('Raw line');
    expect((await rowsOf('payments')).map((p) => p.amount)).not.toContain('77.70');
    const bReceipts = (await exp(w.admin, { storeId: w.store2Id, ...ALL, table: 'receipts' })).rows;
    expect(bReceipts.map((r) => [r.store_id, r.total])).toEqual([[w.store2Id, '77.70']]);
    const bIds = new Set(bReceipts.map((r) => r.id));
    const bLines = (await exp(w.admin, { storeId: w.store2Id, ...ALL, table: 'receipt-lines' })).rows;
    const bPays = (await exp(w.admin, { storeId: w.store2Id, ...ALL, table: 'payments' })).rows;
    expect(bLines.map((l) => l.name)).toEqual(['Raw line']);
    expect(bPays.map((p) => p.amount)).toEqual(['77.70']);
    expect(bLines.every((l) => bIds.has(l.receipt_id))).toBe(true);
    expect(bPays.every((p) => bIds.has(p.receipt_id))).toBe(true);
  });
});

describe('B - a receipt or session with no Z yet takes the business day (start hour 4), not the calendar date', () => {
  it('02:00 Manila with no close lands on the PREVIOUS date; 05:00 on its own date; a session the same', async () => {
    const day = addDays(D1, 10);
    const prev = addDays(day, -1);
    const at = (hm: string) => manila(day, hm).toISOString();
    const [terminal] = await sql<{ id: string }[]>`select id from pos_terminals where store_id = ${w.storeId} and terminal_no = 1`;
    const early = await insertReceipt({ store: w.storeId, terminal: terminal!.id, seq: 9101, session: await rawSession(w.storeId, w.stand7, w.pairingId, at('02:00')), at: at('02:00'), tender: w.cash, amount: '11.10' });
    const late = await insertReceipt({ store: w.storeId, terminal: terminal!.id, seq: 9102, session: await rawSession(w.storeId, w.stand7, w.pairingId, at('05:00')), at: at('05:00'), tender: w.cash, amount: '22.20' });
    const ids = async (table: 'receipts' | 'table-sessions', d: string) => (await exp(w.manager, { storeId: w.storeId, from: d, to: d, table }, RATES)).rows.map((r) => r.id);
    expect(await ids('receipts', prev)).toEqual([early]);
    expect(await ids('receipts', day)).toEqual([late]);
    expect(await ids('table-sessions', prev)).toHaveLength(1); // the 02:00 session (its receipt has no Z)
    expect(await ids('table-sessions', day)).toHaveLength(1); // the 05:00 session
    // with a start hour of 0 the same receipt is on the calendar date
    const midnight = { readRules: async () => ({ ...(await RATES.readRules()), businessDayStartHour: 0 }) };
    expect((await exp(w.manager, { storeId: w.storeId, from: day, to: day, table: 'receipts' }, midnight)).rows.map((r) => r.id).sort()).toEqual([early, late].sort());
  });
});
