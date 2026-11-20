import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-614 S1 (DEF-940) - a refund bigger than its method's takings at the Z: the sales day floors the method at 0 and its refunds figure drops by the same excess, and the
 * excess posts as its own entry (Dr 4950 / Cr the money place) beside the day. docs/POSTING-PATTERNS.md `sale.pos-refund-excess`. Real Postgres on a scratch "_test" database.
 *
 * NOT tested, on purpose: "voiding the day reverses the excess entry". A sales day built from a Z can never be voided (T-531), so the entry is permanent, like a Convert's.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { recordRefund, verifySalesDay } from '../../src';
import { D1, D2, asOrg, close, closeAll, closesOf, gcashAccountId, journalLines, manila, pinOf, porkSale, reading, salesDaysOf, sell, sql, uuid, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const AT = manila(D1, '22:30');
const AT2 = manila(D2, '22:30');
const GC_REF = 'GC-REFUND-01';

interface Made { receiptId: string; lines: { id: string }[]; pays: { id: string; tender_id: string }[] }
/** 4 pork = 1,000.00 on D1, paid `cash` in cash and the rest in GCash. */
async function thousand(w: World, cash: string): Promise<Made> {
  const s = await sell(w, {
    at: manila(D1, '12:00'), items: [{ item: w.menu.pork, qty: 4 }], expectTotal: '1000.00',
    pay: [{ tenderId: w.cash, amount: cash }, ...(Number(cash) < 1000 ? [{ tenderId: w.gcash, amount: (1000 - Number(cash)).toFixed(2), ref: 'GC-SALE-001' }] : [])],
  });
  const lines = await sql<Made['lines']>`select id from pos_sales_receipt_lines where receipt_id = ${s.receiptId} order by line_no`;
  const pays = await sql<Made['pays']>`select id, tender_id from pos_sales_receipt_payments where receipt_id = ${s.receiptId} order by id`;
  return { receiptId: s.receiptId, lines, pays };
}
const refund = (w: World, m: Made, qty: number, pays: [number, string, string?][]) =>
  asOrg(w.orgId, (tx) =>
    recordRefund(tx, w.manager, {
      storeId: w.storeId, pairingId: w.pairingId, requestId: uuid(), receiptId: m.receiptId,
      lines: [{ receiptLineId: m.lines[0]!.id, qty }],
      payments: pays.map(([i, amount, ref]) => ({ paymentId: m.pays[i]!.id, amount, ...(ref ? { referenceNo: ref } : {}) })),
      reason: 'Customer returned it',
    }),
  );
const excessEntries = (w: World) => sql<{ id: string; source_type: string; idempotency_key: string; entry_date: string }[]>`
  select id, source_type, idempotency_key, entry_date::text from journal_entries where org_id = ${w.orgId} and idempotency_key like 'pos_refund_excess:%' order by idempotency_key`;
const partyLines = (entryId: string) => sql<{ code: string; party_type: string | null; party_id: string | null; store_id: string | null }[]>`
  select a.code, jl.party_type, jl.party_id, jl.store_id from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId} order by a.code`;
const cents = (s: string) => Math.round(Number(s) * 100);
/** Every entry of the org balances, debit = credit. */
async function ledgerBalances(w: World) {
  const rows = await sql<{ entry_id: string; d: string; c: string }[]>`
    select jl.entry_id, sum(jl.debit)::text d, sum(jl.credit)::text c from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.org_id = ${w.orgId} group by jl.entry_id`;
  for (const r of rows) expect(r.d, `entry ${r.entry_id}`).toBe(r.c);
}

/** D1: 1,000.00 all cash, Z1. Then 3 pork (750.00) of it is refunded in cash, and 250.00 of cash is taken on D2. Cash refunds 750 vs 250 taken: excess 500. */
async function cashCase() {
  const w = await world();
  const m = await thousand(w, '1000.00');
  await close(w, AT, await pinOf(w, w.managerId));
  await refund(w, m, 3, [[0, '750.00']]);
  await porkSale(w, manila(D2, '12:00'));
  const z = await close(w, AT2, await pinOf(w, w.managerId));
  return { w, z };
}

describe('T-614 S1 - the cash excess', () => {
  it('cash refunded 750 of an earlier day against 250 taken today: the Z closes, the day shows cash 0 and refunds 250, the excess 500 posts Dr 4950 / Cr 1110 and the ledger balances [kills: no floor; excess not posted]', async () => {
    const { w, z } = await cashCase();
    expect(z.salesDayId).not.toBeNull();
    const day = (await salesDaysOf(w)).find((d) => d.pos_day_close_id === z.dayCloseId)!;
    expect(day).toMatchObject({ total_sales: '250.00', cash_collected: '0.00', online_collected: '0.00', refunds: '250.00' });
    const entries = await excessEntries(w);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source_type: 'pos_refund_excess', idempotency_key: `pos_refund_excess:${z.dayCloseId}:cash` });
    const close2 = (await closesOf(w)).find((c) => c.id === z.dayCloseId)!;
    expect(entries[0]!.entry_date).toBe(close2.business_date);
    expect((await journalLines(entries[0]!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([['1110', '0.00', '500.00'], ['4950', '500.00', '0.00']]);
    expect((await partyLines(entries[0]!.id)).every((l) => l.store_id === w.storeId)).toBe(true);

    // the day itself posts and balances, and the two entries together leave the drawer 500 lower, sales 250, returns 750
    const res = await asOrg(w.orgId, (tx) => verifySalesDay(tx, w.manager, day.id));
    const lines = await journalLines(res.journalEntryId);
    expect(lines.reduce((a, l) => a + cents(l.debit), 0)).toBe(lines.reduce((a, l) => a + cents(l.credit), 0));
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([['4150', '0.00', '250.00'], ['4950', '250.00', '0.00']]);
    await ledgerBalances(w);
  });

  it('replaying the Z writes one entry, not two', async () => {
    const { w, z } = await cashCase();
    const again = await close(w, AT2, await pinOf(w, w.managerId), { closeId: z.dayCloseId });
    expect(again.wrote).toBe(false);
    expect(await excessEntries(w)).toHaveLength(1);
  });

  it('a refund-only Z (nothing sold, all of it excess) now closes: no sales day, one excess entry [replaces the T-613 D3 refusal]', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    await close(w, AT, await pinOf(w, w.managerId));
    await refund(w, m, 1, [[0, '250.00']]);
    expect(((await reading(w, AT2)) as unknown as { refunds: { count: number } }).refunds.count).toBe(1);
    const z = await close(w, AT2, await pinOf(w, w.managerId));
    expect(z.wrote).toBe(true);
    expect(z.salesDayId).toBeNull();
    const entries = await excessEntries(w);
    expect(entries).toHaveLength(1);
    expect((await journalLines(entries[0]!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([['1110', '0.00', '250.00'], ['4950', '250.00', '0.00']]);
    await ledgerBalances(w);
  });

  it('a refund no bigger than the takings posts no excess entry', async () => {
    const w = await world();
    const m = await thousand(w, '1000.00');
    await refund(w, m, 1, [[0, '250.00']]);
    await close(w, AT, await pinOf(w, w.managerId));
    expect(await excessEntries(w)).toHaveLength(0);
    const [day] = await salesDaysOf(w);
    expect(day).toMatchObject({ cash_collected: '750.00', refunds: '250.00' });
  });
});

describe('T-614 S1 - the wallet excess', () => {
  it('GCash refunded 400 vs 250 taken, cash refunded 100 vs 0 taken: two entries, the wallet one on 1140 with its money account as party [kills: wallet excess not floored or not posted]', async () => {
    const w = await world();
    const m = await thousand(w, '600.00'); // cash 600 + GCash 400
    await close(w, AT, await pinOf(w, w.managerId));
    await refund(w, m, 2, [[0, '100.00'], [1, '400.00', GC_REF]]);
    await sell(w, { at: manila(D2, '12:00'), items: [{ item: w.menu.pork, qty: 1 }], expectTotal: '250.00', pay: [{ tenderId: w.gcash, amount: '250.00', ref: 'GC-SALE-002' }] });
    const z = await close(w, AT2, await pinOf(w, w.managerId));
    const day = (await salesDaysOf(w)).find((d) => d.pos_day_close_id === z.dayCloseId)!;
    expect(day).toMatchObject({ total_sales: '250.00', cash_collected: '0.00', online_collected: '0.00', refunds: '250.00' }); // 500 refunded less 250 of excess (150 GCash + 100 cash)
    const acct = await gcashAccountId(w);
    const entries = await excessEntries(w);
    expect(entries.map((e) => e.idempotency_key)).toEqual([`pos_refund_excess:${z.dayCloseId}:${acct}`, `pos_refund_excess:${z.dayCloseId}:cash`].sort());
    const byKey = new Map(entries.map((e) => [e.idempotency_key, e.id]));
    const wallet = byKey.get(`pos_refund_excess:${z.dayCloseId}:${acct}`)!;
    expect((await journalLines(wallet)).map((l) => [l.code, l.debit, l.credit])).toEqual([['1140', '0.00', '150.00'], ['4950', '150.00', '0.00']]);
    expect((await partyLines(wallet)).find((l) => l.code === '1140')).toMatchObject({ party_type: 'money_account', party_id: acct, store_id: w.storeId });
    expect((await journalLines(byKey.get(`pos_refund_excess:${z.dayCloseId}:cash`)!)).map((l) => [l.code, l.debit, l.credit])).toEqual([['1110', '0.00', '100.00'], ['4950', '100.00', '0.00']]);
    const res = await asOrg(w.orgId, (tx) => verifySalesDay(tx, w.manager, day.id));
    expect(res.journalEntryId).toBeTruthy();
    await ledgerBalances(w);
  });
});

describe('T-614 S1 - test mode', () => {
  it('a TEST store books nothing: no sales day, no excess entry, no journal entry at all', async () => {
    const w = await world('test');
    const m = await thousand(w, '1000.00');
    await close(w, AT, await pinOf(w, w.managerId));
    await refund(w, m, 3, [[0, '750.00']]);
    await porkSale(w, manila(D2, '12:00'));
    const z = await close(w, AT2, await pinOf(w, w.managerId));
    expect(z.salesDayId).toBeNull();
    expect(await excessEntries(w)).toHaveLength(0);
    expect((await sql<{ n: number }[]>`select count(*)::int n from journal_entries where org_id = ${w.orgId}`)[0]!.n).toBe(0);
  });
});
