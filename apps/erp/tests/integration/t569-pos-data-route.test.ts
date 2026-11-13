/**
 * T-569 R3-R5 (docs/tasks/569-pos-data-download.md) - the download route, called as the app calls it: the real handler, the session mocked to a real actor.
 * The domain half (every table, scoping, refusals, the audit row) is packages/domain/tests/integration/t569-pos-data-download.test.ts; this file is what only the
 * route can show: the HTTP answer (400 / 403 with a sentence), the headers (attachment, no-store), the UTF-8 BOM, and test 6 - a cell that starts with `=` is
 * made inert while money is never prefixed.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { session } from './t435-fixture';
import { parseCsv } from '@shareat/core/csv';
import { insRule, newItem } from '../../../../packages/db/tests/integration/_fixtures/t401-menu';
import { D1, auditsOf, closeAll, manila, sell, sql, world, type Actor, type World } from '../../../../packages/domain/tests/integration/_fixtures/t531-day-close';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());

config({ path: '.env.local' });
afterAll(closeAll);

const TODAY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // the Manila date the fixture runs on
let w: World;

const get = async (who: Actor, params: Record<string, string | undefined>) => {
  session.actor = who;
  const { GET } = await import('../../src/app/reports/pos-data/export/route');
  const u = new URL('http://localhost/reports/pos-data/export');
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  const res = await GET(new Request(u));
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes, body: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) };
};
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10); // unclosed receipts before the 04:00 day start belong to the previous business day
const q = (table: string, o: Record<string, string | undefined> = {}) => ({ store: w.storeId, from: YESTERDAY, to: TODAY, table, ...o });
const audits = async () => (await auditsOf(w, 'data.export_downloaded')).length;

beforeAll(async () => {
  w = await world();
  for (const [name, amount] of [['=1+1 combo', '10.00'], ['Piña colada', '95.50']] as const) {
    const it = await newItem(w, 'a_la_carte', name);
    await insRule(w, it.variantId);
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by) values (${w.orgId}, ${w.storeId}, ${it.variantId}, 'store', ${null}, ${amount}, false, ${w.personId})`;
    await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${w.orgId}, ${w.storeId}, ${it.itemId}, ${w.grill}, ${w.personId})`;
    await sell(w, { at: manila(D1, '12:00'), items: [{ item: it, qty: 1 }], expectTotal: amount, pay: [{ tenderId: w.cash, amount }] });
  }
});

describe('R5 - a good download', () => {
  it('200, a CSV attachment named pos-<store code>-<table>-<from>-to-<to>.csv, not cached, with a UTF-8 BOM, and one audit row', async () => {
    const before = await audits();
    const { res, bytes, body } = await get(w.manager, q('receipt-lines'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="pos-${w.storeCode.toLowerCase()}-receipt-lines-${YESTERDAY}-to-${TODAY}.csv"`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // the UTF-8 BOM, then the header row
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body.endsWith('\r\n')).toBe(true);
    expect(await audits()).toBe(before + 1);
  });

  it('6 - a line named =1+1 is written as text (leading apostrophe); money is never prefixed; n-tilde survives; NULL is an empty cell', async () => {
    const { body } = await get(w.manager, q('receipt-lines'));
    const [head, ...rows] = parseCsv(body);
    const col = (name: string) => head!.cells.indexOf(name);
    expect(head!.cells.slice(0, 4)).toEqual(['id', 'org_id', 'receipt_id', 'line_no']);
    const byName = new Map(rows.map((r) => [r.cells[col('name')]!, r.cells]));
    expect([...byName.keys()].sort()).toEqual(["'=1+1 combo", 'Piña colada']);
    expect(byName.get("'=1+1 combo")![col('unit_price')]).toBe('10.00');
    expect(byName.get('Piña colada')![col('unit_price')]).toBe('95.50');
    expect(byName.get('Piña colada')![col('session_line_id')]).not.toBe(''); // a real id
    const receipts = parseCsv((await get(w.manager, q('receipts'))).body);
    const dc = receipts[0]!.cells.indexOf('day_close_id');
    expect(receipts.slice(1).every((r) => r.cells[dc] === '')).toBe(true); // unclosed receipts: NULL is an empty cell
    expect(receipts.slice(1).map((r) => r.cells[receipts[0]!.cells.indexOf('total')]).sort()).toEqual(['10.00', '95.50']);
  });
});

describe('R3 - refused with a sentence, and no audit row', () => {
  it('no store -> 400; a store that is not yours or no capability -> 403; bad table, bad range, too long -> 400', async () => {
    const before = await audits();
    const noStore = await get(w.admin, q('receipts', { store: undefined }));
    expect(noStore.res.status).toBe(400);
    expect(noStore.body).toMatch(/one store/i);
    expect((await get(w.manager, q('receipts', { store: w.store2Id }))).res.status).toBe(403);
    expect((await get(w.counter, q('receipts'))).res.status).toBe(403);
    expect((await get(w.admin, q('pos_sales_receipts'))).res.status).toBe(400);
    expect((await get(w.admin, q('receipts', { from: TODAY, to: '2020-01-01' }))).res.status).toBe(400);
    expect((await get(w.admin, q('receipts', { from: '2026-01-01', to: '2026-12-31' }))).res.status).toBe(400);
    for (const r of [noStore, await get(w.counter, q('receipts'))]) {
      expect(r.res.headers.get('cache-control')).toBe('private, no-store');
      expect(r.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i); // a sentence, never an id
      expect(r.body).not.toContain('1+1');
    }
    expect(await audits()).toBe(before);
  });
});

const insertEvent = (x: World, seq: number, payload: string) => sql`
  insert into pos_events (org_id, store_id, pairing_id, seq, kind, payload, person_id, occurred_at_device, received_at, status)
  values (${x.orgId}, ${x.storeId}, ${x.pairingId}, ${seq}, 'sale.completed', ${payload}::text::jsonb, ${x.adminId}, now(), now(), 'applied')`;

describe('F1 - a senior/PWD holder ID number and name never reach the file, at any depth; other numbers are untouched', () => {
  it('device-events: neither the ID nor the name appears in the CSV bytes, "[redacted]" does, 1234.50 is byte-exact', async () => {
    const x = await world();
    await insertEvent(x, 9501, '{"total": 1234.50, "seniors": [{"dinerNo": 1, "kind": "senior", "idNumber": "SC-123456", "holderName": "Juan Dela Cruz"}]}');
    await insertEvent(x, 9502, '{"a": {"b": [{"c": {"idNumber": "PWD-777", "holderName": "Maria Santos", "ok": 0.10}}]}, "idNumber": {"n": "SC-NESTED-OBJ"}}');
    const { res, body, bytes } = await get(x.manager, { store: x.storeId, from: YESTERDAY, to: TODAY, table: 'device-events' });
    expect(res.status).toBe(200);
    const raw = new TextDecoder('latin1').decode(bytes) + body;
    for (const secret of ['SC-123456', 'Juan Dela Cruz', 'PWD-777', 'Maria Santos', 'SC-NESTED-OBJ']) expect(raw, secret).not.toContain(secret);
    expect(body).toContain('[redacted]');
    expect(body).toContain('""total"":1234.50');
    expect(body).toContain('""ok"":0.10');
    expect(body).toContain('""dinerNo"":1');
  });
});

describe('F2 - a store code with quotes or non-ASCII letters cannot break the filename', () => {
  it('only a-z, 0-9 and hyphens remain; a code that strips to nothing uses the store id', async () => {
    const x = await world();
    await sql`update stores set code = ${'Niño "Lipa" #1'} where id = ${x.storeId}`;
    const a = await get(x.manager, { store: x.storeId, from: YESTERDAY, to: TODAY, table: 'receipts' });
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get('content-disposition')).toBe(`attachment; filename="pos-niolipa1-receipts-${YESTERDAY}-to-${TODAY}.csv"`);
    await sql`update stores set code = ${'ñ"é'} where id = ${x.storeId}`;
    const b = await get(x.manager, { store: x.storeId, from: YESTERDAY, to: TODAY, table: 'receipts' });
    expect(b.res.status).toBe(200);
    expect(b.res.headers.get('content-disposition')).toBe(`attachment; filename="pos-${x.storeId}-receipts-${YESTERDAY}-to-${TODAY}.csv"`);
  });
});

describe('O - another organisation receipt and device event never appear', () => {
  it('receipts, lines, payments and the device log hold none of the other org rows', async () => {
    const o = await world();
    const rid = await sql.begin(async (t) => {
      const [sess] = await t<{ id: string }[]>`
        insert into table_sessions (org_id, store_id, stand_id, mode, heads_cashier, status, opened_by, opened_at_device, opened_at, opened_on_pairing_id)
        values (${o.orgId}, ${o.storeId}, ${o.stand7}, 'dine_in', 2, 'paid', ${o.adminId}, now(), now(), ${o.pairingId}) returning id`;
      const [r] = await t<{ id: string }[]>`
        insert into pos_sales_receipts (org_id, store_id, terminal_id, receipt_seq, table_session_id, cashier_id, issued_at_device, received_at, subtotal, discount_total, total, device_total, offline)
        values (${o.orgId}, ${o.storeId}, ${o.terminalId}, 9601, ${sess!.id}, ${o.adminId}, now(), now(), 55.55, 0, 55.55, 55.55, false) returning id`;
      await t`insert into pos_sales_receipt_lines (org_id, receipt_id, line_no, kind, name, qty, unit_price, gross, discount_total, net)
              values (${o.orgId}, ${r!.id}, 1, 'item', 'OTHERORG line', 1, 55.55, 55.55, 0, 55.55)`;
      await t`insert into pos_sales_receipt_payments (org_id, receipt_id, tender_id, amount, change_given) values (${o.orgId}, ${r!.id}, ${o.cash}, 55.55, 0)`;
      return r!.id;
    });
    await insertEvent(o, 9602, '{"note": "OTHERORG event", "total": 55.55}');
    // the other org sees its own rows (so the rows are real) ...
    const own = await get(o.manager, { store: o.storeId, from: YESTERDAY, to: TODAY, table: 'receipts' });
    expect(own.body).toContain(rid);
    // ... and this org never does, in any of the four tables
    for (const table of ['receipts', 'receipt-lines', 'payments', 'device-events']) {
      const { res, body } = await get(w.manager, q(table));
      expect(res.status, table).toBe(200);
      expect(body, table).not.toContain('55.55');
      expect(body, table).not.toContain('OTHERORG');
      expect(body, table).not.toContain(rid);
    }
  });
});
