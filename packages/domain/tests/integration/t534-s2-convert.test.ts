import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-534 S2 - Convert (GCash cash-in / cash-out): recordConversion / voidConversion / listOpenConversions, the Convert block on the X and the Z, and the books.
 * docs/tasks/534-pos-convert-correction-refund.md S2. Real Postgres on a scratch "_test" database; the sales day is the standard one (T-531 fixture).
 *
 * DIRECTION, stated once: From = the money that LEAVES the store, To = the money that comes in.
 *   cash -> GCash   the drawer pays cash out          => "cash out"
 *   GCash -> cash   the drawer takes cash in          => "cash in"
 *   Expected drawer cash moves by (cash in - cash out), so cash->GCash 500 and GCash->cash 200 is Convert in 200 / out 500 and the drawer is 300 LOWER.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { AuthorizationError } from '@shareat/auth';
import { RefusalError } from '@shareat/db';
import { listOpenConversions, recordConversion, voidConversion } from '../../src/pos';
import { CONVERT_CLOSED, CONVERT_SAME_TENDER, CONVERT_TENDER_NOT_AVAILABLE, CONVERT_VOID_WHO } from '../../src/pos/convert';
import { RECORDED_DIFFERENTLY } from '../../src/pos/shared';
import { actorOf, makeStaff } from './_fixtures/t525-pos';
import { D1, DC, asOrg, close, closeAll, closesOf, manila, pinOf, reading, salesDaysOf, sql, standardDay, uuid, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const AT = manila(D1, '22:30');

interface Conv { from: string; to: string; amount: string; note?: string; requestId?: string; who?: World['counter']; storeId?: string }
const record = (w: World, c: Conv) =>
  asOrg(w.orgId, (tx) => recordConversion(tx, c.who ?? w.counter, { storeId: c.storeId ?? w.storeId, pairingId: w.pairingId, requestId: c.requestId ?? uuid(), fromTenderId: c.from, toTenderId: c.to, amount: c.amount, note: c.note ?? null }));
const voidIt = (w: World, id: string, who: World['counter'] = w.counter) => asOrg(w.orgId, (tx) => voidConversion(tx, who, { storeId: w.storeId, pairingId: w.pairingId, conversionId: id }));
const rows = (w: World) => sql<{ id: string; day_close_id: string | null; voided_at: Date | null; amount: string }[]>`select id, day_close_id, voided_at, amount::text from pos_payment_conversions where org_id = ${w.orgId} order by recorded_at, id`;

async function expectRefusal(p: Promise<unknown>, sentence: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toBe(sentence);
}

/** The standard day plus cash->GCash 500 and GCash->cash 200. */
async function convertedDay(mode: 'live' | 'test' = 'live') {
  const w = await world(mode);
  await standardDay(w);
  const out = await record(w, { from: w.cash, to: w.gcash, amount: '500.00', note: 'customer took cash' });
  const inn = await record(w, { from: w.gcash, to: w.cash, amount: '200.00' });
  return { w, out, inn };
}

const entriesOfZ = (w: World) => sql<{ id: string; memo: string }[]>`select id, memo from journal_entries where org_id = ${w.orgId} and idempotency_key like 'pos_convert:%' order by id`;
const linesOf = (entryId: string) => sql<{ code: string; debit: string; credit: string; party_id: string | null; store_id: string | null }[]>`
  select a.code, jl.debit::text, jl.credit::text, jl.party_id, jl.store_id from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId} order by a.code, jl.line_no`;

describe('T-534 S2 - the Convert block on the X and the Z', () => {
  it('cash->GCash 500 and GCash->cash 200: Convert in 200 / out 500, the drawer is 300 LOWER (net -300), and sales do not change', async () => {
    const w = await world();
    await standardDay(w);
    const before = await reading(w, AT);
    await record(w, { from: w.cash, to: w.gcash, amount: '500.00' });
    await record(w, { from: w.gcash, to: w.cash, amount: '200.00' });
    const x = await reading(w, AT);
    expect(x.convert).toEqual({ cashIn: '200.00', cashOut: '500.00', net: '-300.00', count: 2 });
    // sales are untouched: the same tenders, the same gross, the same receipts
    expect({ ...x, convert: undefined }).toEqual({ ...before, convert: undefined });
    expect(before.convert).toEqual({ cashIn: '0.00', cashOut: '0.00', net: '0.00', count: 0 });

    const z = await close(w, AT, await pinOf(w, w.managerId));
    expect(z.reading.convert).toEqual({ cashIn: '200.00', cashOut: '500.00', net: '-300.00', count: 2 });
    const [day] = await salesDaysOf(w);
    expect(day).toMatchObject({ total_sales: '3075.00', cash_collected: '2396.71', online_collected: '500.00', refunds: '0.00' });
    // every Convert is frozen to the Z, once
    const all = await rows(w);
    expect(all.map((r) => r.day_close_id)).toEqual([z.dayCloseId, z.dayCloseId]);
    // the Z's figures, read again from the database, are the same block (the history and a reprint)
    const listed = await asOrg(w.orgId, (tx) => DC.listDayCloses(tx, w.counter, { storeId: w.storeId }));
    expect((await closesOf(w)).length).toBe(1);
    expect(listed.closes[0]).toBeDefined();
    const again = await close(w, AT, await pinOf(w, w.managerId), { closeId: z.dayCloseId });
    expect(again.wrote).toBe(false);
    expect(again.reading.convert).toEqual(z.reading.convert);
  });

  it('a voided Convert is in neither block: it is not counted, not posted, but it is frozen to the Z with the others', async () => {
    const w = await world();
    await standardDay(w);
    const a = await record(w, { from: w.cash, to: w.gcash, amount: '500.00' });
    await record(w, { from: w.gcash, to: w.cash, amount: '200.00' });
    await voidIt(w, a.id);
    const x = await reading(w, AT);
    expect(x.convert).toEqual({ cashIn: '200.00', cashOut: '0.00', net: '200.00', count: 1 });
    const z = await close(w, AT, await pinOf(w, w.managerId));
    expect(z.reading.convert).toEqual({ cashIn: '200.00', cashOut: '0.00', net: '200.00', count: 1 });
    expect((await rows(w)).every((r) => r.day_close_id === z.dayCloseId)).toBe(true);
    const lines = await linesOf((await entriesOfZ(w))[0]!.id);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([['1110', '200.00', '0.00'], ['1140', '0.00', '200.00']]);
  });

  it('after a Z the next X starts at zero (the Converts belong to the closed day)', async () => {
    const { w } = await convertedDay();
    await close(w, AT, await pinOf(w, w.managerId));
    const next = await reading(w, manila(D1, '23:30'));
    expect(next.convert).toEqual({ cashIn: '0.00', cashOut: '0.00', net: '0.00', count: 0 });
  });
});

describe('T-534 S2 - record and void', () => {
  it('the same request_id twice is ONE row (and the second answer says it wrote nothing); the same id with other figures is refused', async () => {
    const w = await world();
    const requestId = uuid();
    const first = await record(w, { from: w.cash, to: w.gcash, amount: '500.00', requestId });
    const second = await record(w, { from: w.cash, to: w.gcash, amount: '500.00', requestId });
    expect(first.wrote).toBe(true);
    expect(second).toEqual({ wrote: false, id: first.id });
    expect((await rows(w)).length).toBe(1);
    await expectRefusal(record(w, { from: w.cash, to: w.gcash, amount: '501.00', requestId }), RECORDED_DIFFERENTLY);
    expect((await rows(w)).length).toBe(1);
  });

  it('a void after the Z is refused; before the Z the recorder voids, anyone else without the right is refused, and a manager may; a second void is a no-op', async () => {
    const w = await world();
    await standardDay(w);
    const other = actorOf(w.orgId, await makeStaff({ orgId: w.orgId, storeId: w.storeId, adminId: w.adminId }, 'Dee Cashier'));
    const mine = await record(w, { from: w.cash, to: w.gcash, amount: '100.00' });
    const hers = await record(w, { from: w.cash, to: w.gcash, amount: '120.00', who: other });
    await expectRefusal(voidIt(w, hers.id), CONVERT_VOID_WHO); // another cashier's Convert
    await expect(voidIt(w, mine.id)).resolves.toEqual({ wrote: true });
    await expect(voidIt(w, mine.id)).resolves.toEqual({ wrote: false });
    await expect(voidIt(w, hers.id, w.manager), 'a holder of approve_pos_correction may').resolves.toEqual({ wrote: true });
    const open = await record(w, { from: w.gcash, to: w.cash, amount: '40.00' });
    await close(w, AT, await pinOf(w, w.managerId));
    await expectRefusal(voidIt(w, open.id), CONVERT_CLOSED);
    expect((await rows(w)).filter((r) => r.voided_at !== null).length).toBe(2);
  });

  it('refuses: staff without record_sale, the same method twice, an inactive method, another store\'s method, an amount of zero or with a stray decimal', async () => {
    const w = await world();
    await expect(record(w, { from: w.cash, to: w.gcash, amount: '10.00', who: w.kitchen })).rejects.toBeInstanceOf(AuthorizationError);
    await expectRefusal(record(w, { from: w.cash, to: w.cash, amount: '10.00' }), CONVERT_SAME_TENDER);
    await expectRefusal(record(w, { from: w.cash, to: w.mayaOff, amount: '10.00' }), CONVERT_TENDER_NOT_AVAILABLE);
    await expectRefusal(record(w, { from: w.cash, to: w.cashB, amount: '10.00' }), CONVERT_TENDER_NOT_AVAILABLE);
    await expect(record(w, { from: w.cash, to: w.gcash, amount: '0' })).rejects.toBeInstanceOf(RefusalError);
    await expect(record(w, { from: w.cash, to: w.gcash, amount: '1.234' })).rejects.toHaveProperty('userMessage'); // the shared money-input refusal
    expect((await rows(w)).length).toBe(0);
  });

  it('the Till list shows the open Converts, voided ones marked, and Void only where this person may void', async () => {
    const w = await world();
    const a = await record(w, { from: w.cash, to: w.gcash, amount: '500.00', note: 'x' });
    const b = await record(w, { from: w.gcash, to: w.cash, amount: '200.00' });
    await voidIt(w, b.id);
    const own = await asOrg(w.orgId, (tx) => listOpenConversions(tx, w.counter, { storeId: w.storeId }));
    expect(own.conversions.map((c) => [c.id, c.fromName, c.toName, c.amount, c.voided, c.canVoid])).toEqual([
      [a.id, 'Cash', 'GCash', '500.00', false, true],
      [b.id, 'GCash', 'Cash', '200.00', true, false],
    ]);
    const other = actorOf(w.orgId, await makeStaff({ orgId: w.orgId, storeId: w.storeId, adminId: w.adminId }, 'Eli Cashier'));
    const theirs = await asOrg(w.orgId, (tx) => listOpenConversions(tx, other, { storeId: w.storeId }));
    expect(theirs.conversions.map((c) => c.canVoid)).toEqual([false, false]);
    const mgr = await asOrg(w.orgId, (tx) => listOpenConversions(tx, w.manager, { storeId: w.storeId }));
    expect(mgr.conversions.map((c) => c.canVoid)).toEqual([true, false]);
  });
});

describe('T-534 S2 - the books (POSTING-PATTERNS transfer.cash.simple: DR the account the money arrives in, CR the one it leaves)', () => {
  it('cash->GCash 500 and GCash->cash 200 post ONE entry for the pair, NET: DR GCash 300 (party = its money account) / CR cash 300; it balances', async () => {
    const { w } = await convertedDay();
    await close(w, AT, await pinOf(w, w.managerId));
    const entries = await entriesOfZ(w);
    expect(entries.length).toBe(1);
    const lines = await linesOf(entries[0]!.id);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([['1110', '0.00', '300.00'], ['1140', '300.00', '0.00']]);
    const wallet = (await sql<{ money_account_id: string }[]>`select money_account_id from tenders where id = ${w.gcash}`)[0]!.money_account_id;
    expect(lines.find((l) => l.code === '1140')!.party_id).toBe(wallet);
    expect(lines.every((l) => l.store_id === w.storeId)).toBe(true);
    const cents = (s: string) => Math.round(Number(s) * 100);
    expect(lines.reduce((a, l) => a + cents(l.debit) - cents(l.credit), 0)).toBe(0);
    // sales are posted by the sales day, not by this entry: the day's own verification is untouched (no entry yet)
    expect((await salesDaysOf(w))[0]!.journal_entry_id).toBeNull();
  });

  it('one entry per PAIR of methods: a second wallet is its own entry; a pair that nets to zero posts nothing', async () => {
    const w = await world();
    await standardDay(w);
    await sql`update tenders set is_active = true where id = ${w.mayaOff}`;
    await record(w, { from: w.cash, to: w.gcash, amount: '500.00' });
    await record(w, { from: w.cash, to: w.mayaOff, amount: '70.00' });
    await record(w, { from: w.gcash, to: w.mayaOff, amount: '25.00' });
    await record(w, { from: w.mayaOff, to: w.gcash, amount: '25.00' }); // GCash<->Maya nets to nothing
    await close(w, AT, await pinOf(w, w.managerId));
    const entries = await entriesOfZ(w);
    expect(entries.length).toBe(2);
    const totals = await Promise.all(entries.map(async (e) => (await linesOf(e.id)).filter((l) => l.code === '1110').map((l) => l.credit)));
    expect(totals.flat().sort()).toEqual(['500.00', '70.00']);
  });

  it('a store in TEST mode closes with the Convert block but books nothing (test mode never books)', async () => {
    const { w } = await convertedDay('test');
    const z = await close(w, AT, await pinOf(w, w.managerId));
    expect(z.reading.convert.count).toBe(2);
    expect((await entriesOfZ(w)).length).toBe(0);
    expect((await rows(w)).every((r) => r.day_close_id === z.dayCloseId)).toBe(true);
  });

  it('a Convert recorded by one till is not in another till\'s Z (the drawer is the till\'s)', async () => {
    const w = await world();
    await standardDay(w);
    await record(w, { from: w.cash, to: w.gcash, amount: '500.00' });
    // a Convert of a different terminal of the same store
    const [t2] = await sql<{ id: string }[]>`insert into pos_terminals (org_id, store_id, terminal_no, pairing_id, created_by) values (${w.orgId}, ${w.storeId}, 2, null, ${w.adminId}) returning id`;
    await sql`insert into pos_payment_conversions (org_id, store_id, terminal_id, from_tender_id, to_tender_id, amount, recorded_by, request_id) values (${w.orgId}, ${w.storeId}, ${t2!.id}, ${w.cash}, ${w.gcash}, 999.00, ${w.counterId}, ${uuid()})`;
    const z = await close(w, AT, await pinOf(w, w.managerId));
    expect(z.reading.convert).toMatchObject({ cashOut: '500.00', count: 1 });
    expect((await rows(w)).map((r) => r.day_close_id === z.dayCloseId)).toEqual([true, false]);
  });
});

describe('T-613 D3 - a Z is also for Converts when nothing was sold', () => {
  it('a cash -> GCash Convert and no receipts: the Z closes (it said "no sales to close"), books the Convert, and derives no sales day [kills: the receipt-count gate]', async () => {
    const w = await world();
    const conv = await record(w, { from: w.cash, to: w.gcash, amount: '500.00', note: 'customer took cash' });
    const z = await close(w, AT, await pinOf(w, w.managerId));
    expect(z.wrote).toBe(true);
    expect(z.reading).toMatchObject({ receiptCount: 0, convert: { count: 1 } });
    expect(z.salesDayId).toBeNull();
    expect((await rows(w)).find((r) => r.id === conv.id)!.day_close_id).toBe(z.dayCloseId);
    expect((await entriesOfZ(w)).length).toBeGreaterThan(0);
  });
  it('nothing sold, refunded or converted still says there is nothing to close', async () => {
    const w = await world();
    await expectRefusal(close(w, AT, await pinOf(w, w.managerId)), 'There are no sales to close since the last Z.');
  });
});
