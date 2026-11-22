import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-628 - table reservations with deposits on POS v2. docs/tasks/628-pos-reservations-deposits.md. Real Postgres on a scratch "_test" database, through the T-531 day-close fixture.
 *
 * Tests 1-4 of the spec, each with the mutant that must turn it red noted as [kills: ...]:
 *   1  a deposit taken offline (inbox) syncs, counts on that day's Z and posts Dr cash / Cr 2170
 *   2  applying is consume-once (the partial unique, the domain refusal, the quarantine of a late second apply)
 *   3  a void needs the manager PIN, is online only and is refused once the deposit was applied
 *   4  a cancelled or no-show reservation with money held cannot close without refund-or-keep; keep posts to 4500
 * Test 5 (the posting patterns balanced and on the right accounts) is tests/integration/posting-patterns.test.ts over tests/worked-examples/fixtures.ts, plus the routing test below.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { RefusalError } from '@shareat/db';
import { getUnpaidLiabilities, verifySalesDay } from '@shareat/domain';
import { routeSalesDay } from '../../src/sales-days/routing';
import { money } from '@shareat/core/money';
import { applyPosEvents } from '../../src/pos/inbox';
import {
  closeReservation, completeSale, createReservation, DEPOSIT_ALREADY_USED, DEPOSIT_NOT_SEATED, DEPOSIT_VOID_AFTER_APPLY, keepDeposit, refundDeposit, RESERVATION_CLOSE_WITH_MONEY, seatReservation,
  setReservationStatus, takeDeposit, voidDeposit,
} from '../../src/pos';
import { ev, RATES } from './_fixtures/t525-pos';
import { D1, D2, asOrg, close, closeAll, journalLines, manila, pinOf, reading, salesDaysOf, sell, sql, uuid, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const AT = manila(D1, '22:30');
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------------------------------
async function book(w: World, o: { name?: string } = {}): Promise<string> {
  const id = uuid();
  await asOrg(w.orgId, (tx) =>
    createReservation(tx, w.counter, {
      storeId: w.storeId, pairingId: w.pairingId, reservationId: id, customerName: o.name ?? 'Santos', phone: '0917 123 4567', partySize: 8, reservedFor: manila(D1, '19:00'), createdAtDevice: nowIso(),
    }));
  return id;
}
async function take(w: World, reservationId: string, amount: string, tender = w.cash): Promise<string> {
  const id = uuid();
  await asOrg(w.orgId, (tx) =>
    takeDeposit(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, depositId: id, reservationId, tenderId: tender, amount, ...(tender === w.cash ? {} : { referenceNo: 'GC-DEP-0001' }), occurredAtDevice: nowIso() }));
  return id;
}
const held = async (reservationId: string) => (await sql<{ h: string }[]>`
  select coalesce(sum(case when kind = 'taken' then amount else -amount end), 0)::text h from pos_reservation_deposits where reservation_id = ${reservationId}`)[0]!.h;
const statusOf = async (reservationId: string) => (await sql<{ status: string }[]>`select status from pos_reservations where id = ${reservationId}`)[0]!.status;
/** Seats the reservation at the table `sell` is about to pay (the newest open one), then the sale applies `amount` of its deposit and pays the rest as given. */
function applyingSale(w: World, reservationId: string, amount: string, cash: string | null, at = manila(D1, '19:30')) {
  return sell(w, {
    at, items: [{ item: w.menu.pork, qty: 4 }], expectTotal: '1000.00', pay: cash === null ? [] : [{ tenderId: w.cash, amount: cash }],
    beforeComplete: async () => {
      const [s] = await sql<{ id: string }[]>`select id from table_sessions where store_id = ${w.storeId} and status = 'open' order by opened_at_device desc, id desc limit 1`;
      await asOrg(w.orgId, (tx) => seatReservation(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId, sessionId: s!.id, seatedAtDevice: at }));
    },
    mutate: (i) => {
      i.deposit = { reservationId, amount };
    },
  });
}
const depositEntries = (w: World) => sql<{ id: string; idempotency_key: string; source_type: string; entry_date: string }[]>`
  select id, idempotency_key, source_type, entry_date::text from journal_entries where org_id = ${w.orgId} and source_type = 'pos_deposit' order by idempotency_key`;
const cents = (s: string) => Math.round(Number(s) * 100);
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof RefusalError) return err.userMessage;
    throw err;
  }
  throw new Error('expected a refusal');
};
const pg = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? 'no-code';
  }
  return 'ok';
};

// ---------------------------------------------------------------------------------------------------------------------
describe('T-628 test 1 - a deposit taken offline syncs, counts on that day\'s Z and posts Dr cash / Cr 2170', () => {
  it('reservation.created + deposit.taken through the inbox; the X shows it in the drawer; the Z collects it once and posts Dr 1110 / Cr 2170 [kills: postDepositsForZ posts nothing; the reading ignores deposit events]', async () => {
    const w = await world();
    const resId = uuid();
    const depId = uuid();
    const r = await applyPosEvents(
      {
        pairing: { pairingId: w.pairingId, orgId: w.orgId, storeId: w.storeId },
        events: [
          ev(1, 'reservation.created', w.counterId, { reservationId: resId, customerName: 'Santos', phone: '0917 123 4567', partySize: 8, reservedFor: manila(D1, '19:00').toISOString(), createdAtDevice: nowIso() }),
          ev(2, 'deposit.taken', w.counterId, { depositId: depId, reservationId: resId, tenderId: w.cash, amount: '1000.00', occurredAtDevice: nowIso() }),
          // a replay of the same two events is a no-op, never a second deposit
          ev(2, 'deposit.taken', w.counterId, { depositId: depId, reservationId: resId, tenderId: w.cash, amount: '1000.00', occurredAtDevice: nowIso() }),
        ],
      },
      RATES,
    );
    expect(r.results.map((x) => x.status).slice(0, 2)).toEqual(['applied', 'applied']);
    expect(await held(resId)).toBe('1000.00');

    const x = await reading(w, AT);
    expect(x.deposits).toMatchObject({ taken: '1000.00', voided: '0.00', refunded: '0.00', kept: '0.00', applied: '0.00', cashNet: '1000.00', cashTaken: '1000.00', cashReturned: '0.00', count: 1 });
    expect(x.receiptCount).toBe(0);

    const z = await close(w, AT, await pinOf(w, w.managerId));
    expect(z.salesDayId).toBeNull(); // nothing was sold: the deposit posts beside, there is no sales day
    expect(z.reading.deposits).toMatchObject({ taken: '1000.00', cashNet: '1000.00', count: 1 });
    const closed = await sql<{ day_close_id: string | null }[]>`select day_close_id from pos_reservation_deposits where id = ${depId}`;
    expect(closed[0]!.day_close_id).toBe(z.dayCloseId);

    const entries = await depositEntries(w);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source_type: 'pos_deposit', idempotency_key: `pos_deposit:${z.dayCloseId}:taken:cash`, entry_date: D1 });
    const lines = await journalLines(entries[0]!.id);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([['1110', '1000.00', '0.00'], ['2170', '0.00', '1000.00']]);
    const storeLines = await sql<{ store_id: string | null }[]>`select store_id from journal_lines where entry_id = ${entries[0]!.id}`;
    expect(storeLines.every((l) => l.store_id === w.storeId)).toBe(true);

    // the next window starts empty: the deposit is in this Z only
    expect((await reading(w, manila(D1, '23:30'))).deposits.count).toBe(0);
  });

  it('a GCash deposit posts Dr 1140 (the money account) / Cr 2170 and does not move the drawer', async () => {
    const w = await world();
    const resId = await book(w);
    await take(w, resId, '300.00', w.gcash);
    const x = await reading(w, AT);
    expect(x.deposits).toMatchObject({ taken: '300.00', cashNet: '0.00', cashTaken: '0.00', cashReturned: '0.00', count: 1 }); // a GCash deposit is in `taken`, not in the drawer
    await close(w, AT, await pinOf(w, w.managerId));
    const [e] = await depositEntries(w);
    const lines = await sql<{ code: string; debit: string; credit: string; party_type: string | null }[]>`
      select a.code, jl.debit::text, jl.credit::text, jl.party_type from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${e!.id} order by a.code`;
    expect(lines.map((l) => [l.code, l.debit, l.credit, l.party_type])).toEqual([['1140', '300.00', '0.00', 'money_account'], ['2170', '0.00', '300.00', null]]);
  });

  it('a deposit event the server does not know offline-first is refused: void, refund and keep have NO outbox kind (online only)', async () => {
    const w = await world();
    const resId = await book(w);
    const dep = await take(w, resId, '500.00');
    const r = await applyPosEvents(
      { pairing: { pairingId: w.pairingId, orgId: w.orgId, storeId: w.storeId }, events: [ev(1, 'deposit.voided', w.counterId, { reservationId: resId, voidsDepositId: dep, reason: 'mistake' })] },
      RATES,
    );
    expect(r.results[0]!.status).toBe('quarantined');
    expect(r.results[0]!.error).toContain('POS_EVENT_UNKNOWN_KIND');
    expect(await held(resId)).toBe('500.00');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-628 test 2 - applying a deposit is consume-once', () => {
  it('the bill takes the deposit as a tender: the receipt, the reservation, the Z, the sales day (deposits_applied) and the verified entry Dr 1110 + Dr 2170 / Cr 4150 [kills: deposit not counted as paid; deposits_applied dropped from the day or the router]', async () => {
    const w = await world();
    const resId = await book(w);
    await take(w, resId, '500.00');
    const sale = await applyingSale(w, resId, '500.00', '500.00');
    const [rec] = await sql<{ total: string; deposit_applied: string }[]>`select total::text, deposit_applied::text from pos_sales_receipts where id = ${sale.receiptId}`;
    expect(rec).toEqual({ total: '1000.00', deposit_applied: '500.00' });
    const applied = await sql<{ amount: string; receipt_id: string }[]>`select amount::text, receipt_id from pos_reservation_deposits where reservation_id = ${resId} and kind = 'applied'`;
    expect(applied).toEqual([{ amount: '500.00', receipt_id: sale.receiptId }]);
    expect(await held(resId)).toBe('0.00');
    expect(await statusOf(resId)).toBe('closed'); // nothing left held, the table is paid
    expect(await sql`select 1 from audit_log where org_id = ${w.orgId} and action in ('pos.sale_payment_variance', 'pos.sale_payment_shortfall')`).toHaveLength(0);

    const z = await close(w, AT, await pinOf(w, w.managerId));
    expect(z.reading).toMatchObject({ grossTotal: '1000.00' });
    expect(z.reading.deposits).toMatchObject({ taken: '500.00', applied: '500.00', cashNet: '500.00' });
    const [day] = await salesDaysOf(w);
    const [d] = await sql<{ deposits_applied: string; cash_collected: string; total_sales: string }[]>`select deposits_applied::text, cash_collected::text, total_sales::text from sales_days where id = ${day!.id}`;
    expect(d).toEqual({ deposits_applied: '500.00', cash_collected: '500.00', total_sales: '1000.00' });

    const v = await asOrg(w.orgId, (tx) => verifySalesDay(tx, w.manager, day!.id));
    const lines = await journalLines(v.journalEntryId);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([['1110', '500.00', '0.00'], ['2170', '500.00', '0.00'], ['4150', '0.00', '1000.00']]);
    expect(lines.reduce((a, l) => a + cents(l.debit), 0)).toBe(lines.reduce((a, l) => a + cents(l.credit), 0));
    // 2170 nets to zero across the take (Z) and the apply (the sales day)
    const net = await sql<{ n: string }[]>`
      select coalesce(sum(jl.credit - jl.debit), 0)::text n from journal_lines jl join accounts a on a.id = jl.account_id join journal_entries je on je.id = jl.entry_id
       where je.org_id = ${w.orgId} and a.code = '2170'`;
    expect(net[0]!.n).toBe('0.00');
  });

  it('the whole bill can be paid from the deposit (no cash line); a deposit larger than the bill is refused; what is left over stays held and the reservation stays open for the manager', async () => {
    const w = await world();
    const a = await book(w);
    await take(w, a, '1000.00');
    const s = await applyingSale(w, a, '1000.00', null);
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipt_payments where receipt_id = ${s.receiptId}`)[0]!.n).toBe(0);
    expect(await statusOf(a)).toBe('closed');

    const b = await book(w, { name: 'Reyes' });
    await take(w, b, '1500.00');
    expect(await refusal(applyingSale(w, b, '1200.00', null, manila(D1, '20:00')))).toContain('more than the bill');
    const c = await book(w, { name: 'Cruz' });
    await take(w, c, '1500.00');
    await applyingSale(w, c, '1000.00', null, manila(D1, '20:30'));
    expect(await held(c)).toBe('500.00');
    expect(await statusOf(c)).toBe('seated'); // 500 still held: a manager refunds or keeps it before it can close
  });

  it('a second apply is refused in words, and the database refuses it on its own [kills: drop pos_reservation_deposits_applied_once_key; drop the domain check]', async () => {
    const w = await world();
    const resId = await book(w);
    await take(w, resId, '800.00');
    const first = await applyingSale(w, resId, '500.00', '500.00');
    // the DATABASE: a second applied row for the same reservation, under another receipt, hits the partial unique
    const other = await sell(w, { at: manila(D1, '20:30'), items: [{ item: w.menu.pork, qty: 1 }], expectTotal: '250.00', pay: [{ tenderId: w.cash, amount: '250.00' }] });
    const code = await pg(sql`
      insert into pos_reservation_deposits (org_id, store_id, reservation_id, kind, amount, receipt_id, recorded_by, occurred_at_device)
      values (${w.orgId}, ${w.storeId}, ${resId}, 'applied', 100, ${other.receiptId}, ${w.counterId}, now())`);
    expect(code).toBe('23505');
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_reservation_deposits where reservation_id = ${resId} and kind = 'applied'`)[0]!.n).toBe(1);
    expect(first.receiptId).not.toBe(other.receiptId);
  });

  it('a sale arriving later that applies a deposit already used is QUARANTINED by the inbox, with the sentence, and nothing is written [the sentence comes from the domain check; with that check removed the database unique still refuses it, with the same sentence, so this test alone does not kill that mutant: the unique-drop mutant in the test above does]', async () => {
    const w = await world();
    // a plain sale whose receipt the first apply is (wrongly) pinned on, by hand: the state a stale tablet's sale meets
    const earlier = await sell(w, { at: manila(D1, '18:00'), items: [{ item: w.menu.pork, qty: 1 }], expectTotal: '250.00', pay: [{ tenderId: w.cash, amount: '250.00' }] });
    const sessionId = uuid();
    const stand = await w.stand();
    const { openStand, addLines } = await import('../../src/pos');
    await asOrg(w.orgId, (tx) => openStand(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, sessionId, mode: 'dine_in', standId: stand.id, headsCashier: 2, openedAtDevice: nowIso() }));
    const lineId = uuid();
    await asOrg(w.orgId, (tx) => addLines(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, sessionId, lines: [{ lineId, menuItemId: w.menu.pork.itemId, variantId: w.menu.pork.variantId, qty: 1, addedAtDevice: nowIso() }] }));
    const resId = uuid();
    await sql`insert into pos_reservations (id, org_id, store_id, customer_name, party_size, reserved_for, created_by, created_at_device) values (${resId}, ${w.orgId}, ${w.storeId}, 'Cruz', 2, now(), ${w.counterId}, now())`;
    await sql`insert into pos_reservation_deposits (org_id, store_id, reservation_id, kind, amount, tender_id, terminal_id, recorded_by, occurred_at_device) values (${w.orgId}, ${w.storeId}, ${resId}, 'taken', 300, ${w.cash}, ${w.terminalId}, ${w.counterId}, now())`;
    await sql`update pos_reservations set status = 'seated', session_id = ${sessionId} where id = ${resId}`;
    await sql`insert into pos_reservation_deposits (org_id, store_id, reservation_id, kind, amount, receipt_id, recorded_by, occurred_at_device) values (${w.orgId}, ${w.storeId}, ${resId}, 'applied', 100, ${earlier.receiptId}, ${w.counterId}, now())`;
    const sale = (seq: number, offline: boolean) => ({
      sessionId, receiptId: uuid(), terminalNo: 1, terminalSeq: seq, issuedAtDevice: nowIso(), offline,
      device: { subtotal: '250.00', discountTotal: '0.00', total: '250.00', lines: [{ lineId, gross: '250.00', discountTotal: '0.00', net: '250.00' }] },
      payments: [{ tenderId: w.cash, amount: '150.00', toCheck: false }], seniors: [], deposit: { reservationId: resId, amount: '100.00' },
    });
    const msg = await refusal(asOrg(w.orgId, (tx) => completeSale(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, ...sale(9101, false) }, RATES)));
    expect(msg).toBe(DEPOSIT_ALREADY_USED);
    const r = await applyPosEvents({ pairing: { pairingId: w.pairingId, orgId: w.orgId, storeId: w.storeId }, events: [ev(1, 'sale.completed', w.counterId, sale(9102, true))] }, RATES);
    expect(r.results[0]!.status).toBe('quarantined');
    expect(r.results[0]!.error).toContain('already used');
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipts where table_session_id = ${sessionId}`)[0]!.n).toBe(0);
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_reservation_deposits where reservation_id = ${resId} and kind = 'applied'`)[0]!.n).toBe(1);
  });
});

describe('T-628 audit fixes - apply needs a seated reservation, two days, the keep cap', () => {
  it('a deposit of a reservation cancelled after seating is refused in words, not by a database code; its money stays held [kills: the not-seated refusal in completeSale]', async () => {
    const w = await world();
    const resId = await book(w);
    await take(w, resId, '500.00');
    const attempt = sell(w, {
      at: manila(D1, '19:30'), items: [{ item: w.menu.pork, qty: 4 }], expectTotal: '1000.00', pay: [{ tenderId: w.cash, amount: '500.00' }],
      beforeComplete: async () => {
        const [s] = await sql<{ id: string }[]>`select id from table_sessions where store_id = ${w.storeId} and status = 'open' order by opened_at_device desc, id desc limit 1`;
        await asOrg(w.orgId, (tx) => seatReservation(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId: resId, sessionId: s!.id, seatedAtDevice: manila(D1, '19:30') }));
        await asOrg(w.orgId, (tx) => setReservationStatus(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId: resId, status: 'cancelled', atDevice: nowIso() }));
      },
      mutate: (i) => {
        i.deposit = { reservationId: resId, amount: '500.00' };
      },
    });
    expect(await refusal(attempt)).toBe(DEPOSIT_NOT_SEATED);
    expect(await held(resId)).toBe('500.00');
    expect(await statusOf(resId)).toBe('cancelled');
  });

  it('taken on day 1, applied on day 2: each day\'s books are right and 2170 nets to zero across the two Zs; the unpaid view shows it while held and not after [kills: depositsApplied dropped from the day; 2170 missing from the unpaid view]', async () => {
    const w = await world();
    const resId = await book(w);
    await take(w, resId, '500.00');
    const pin = await pinOf(w, w.managerId);
    const unpaid2170 = async () => {
      const r = await asOrg(w.orgId, (tx) => getUnpaidLiabilities(tx, w.manager, { storeId: w.storeId }));
      return r.kinds.find((k) => k.id === 'other_ledger')!.lines.filter((l) => l.accountCode === '2170').map((l) => l.amount);
    };
    // day 1: the Z holds the deposit alone (nothing was sold): Dr 1110 / Cr 2170, no sales day
    const z1 = await close(w, AT, pin);
    expect(z1.salesDayId).toBeNull();
    expect(z1.reading.deposits).toMatchObject({ taken: '500.00', applied: '0.00', cashTaken: '500.00', cashNet: '500.00' });
    const day1 = await depositEntries(w);
    expect(day1).toHaveLength(1);
    expect(day1[0]).toMatchObject({ entry_date: D1 });
    expect(await unpaid2170()).toEqual(['500.00']); // held money is owed: it shows in what we owe
    // day 2: the bill takes the deposit; its Z applies it, takes nothing
    await applyingSale(w, resId, '500.00', '500.00', manila(D2, '19:30'));
    const z2 = await close(w, manila(D2, '22:30'), pin);
    expect(z2.businessDate).toBe(D2);
    expect(z2.reading.deposits).toMatchObject({ taken: '0.00', applied: '500.00', cashTaken: '0.00', cashNet: '0.00', count: 0 });
    expect(await depositEntries(w)).toHaveLength(1); // day 2 posts no deposit entry of its own
    const [d2] = await salesDaysOf(w);
    const v = await asOrg(w.orgId, (tx) => verifySalesDay(tx, w.manager, d2!.id));
    expect((await journalLines(v.journalEntryId)).map((l) => [l.code, l.debit, l.credit])).toEqual([['1110', '500.00', '0.00'], ['2170', '500.00', '0.00'], ['4150', '0.00', '1000.00']]);
    const net = await sql<{ n: string }[]>`
      select coalesce(sum(jl.credit - jl.debit), 0)::text n from journal_lines jl join accounts a on a.id = jl.account_id join journal_entries je on je.id = jl.entry_id where je.org_id = ${w.orgId} and a.code = '2170'`;
    expect(net[0]!.n).toBe('0.00');
    expect(await unpaid2170()).toEqual([]);
  });

  it('a keep cannot take more than is held, in words; the exact amount works [kills: the held cap in keepDeposit]', async () => {
    const w = await world();
    const resId = await book(w);
    await take(w, resId, '300.00');
    const pin = await pinOf(w, w.managerId);
    const keep = (amount: string) =>
      asOrg(w.orgId, (tx) => keepDeposit(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, depositId: uuid(), reservationId: resId, amount, reason: 'No-show, no call', approval: { pin } }));
    expect(await refusal(keep('300.01'))).toContain('more than the reservation holds');
    expect(await held(resId)).toBe('300.00');
    await keep('300.00');
    expect(await held(resId)).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-628 test 3 - void needs the manager PIN, is online only and is refused once applied', () => {
  it('a cashier alone is refused; with the manager\'s PIN (or as the manager) it works; a wrong PIN is refused [kills: the approver is not asked (cashier allowed)]', async () => {
    const w = await world();
    const resId = await book(w);
    const dep = await take(w, resId, '500.00');
    const call = (who: typeof w.counter, pin?: string, id = uuid()) =>
      asOrg(w.orgId, (tx) =>
        voidDeposit(tx, who, { storeId: w.storeId, pairingId: w.pairingId, depositId: id, reservationId: resId, voidsDepositId: dep, reason: 'Wrong amount typed', ...(pin ? { approval: { pin } } : {}) }));
    expect(await refusal(call(w.counter))).toMatch(/manager/i);
    expect(await held(resId)).toBe('500.00');
    await expect(call(w.counter, '000000')).rejects.toThrow();
    expect(await held(resId)).toBe('500.00');
    const id = uuid();
    expect(await call(w.counter, await pinOf(w, w.managerId), id)).toEqual({ wrote: true, id });
    expect(await held(resId)).toBe('0.00');
    // a retry of the same event is a no-op
    expect(await call(w.counter, await pinOf(w, w.managerId), id)).toEqual({ wrote: false, id });
    // the void reaches the books at the Z: Dr 2170 / Cr 1110, beside the take
    await close(w, AT, await pinOf(w, w.managerId));
    const entries = await depositEntries(w);
    expect(entries.map((e) => e.idempotency_key.split(':').slice(2).join(':'))).toEqual(['taken:cash', 'voided:cash']);
    const lines = await journalLines(entries[1]!.id);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([['1110', '0.00', '500.00'], ['2170', '500.00', '0.00']]);
  });

  it('a void after the deposit was applied is refused, by the domain in words and by the database on its own [kills: drop the void-after-apply check (domain); drop the guard trigger (database)]', async () => {
    const w = await world();
    const resId = await book(w);
    const dep = await take(w, resId, '600.00');
    await applyingSale(w, resId, '500.00', '500.00');
    const pin = await pinOf(w, w.managerId);
    const msg = await refusal(
      asOrg(w.orgId, (tx) => voidDeposit(tx, w.manager, { storeId: w.storeId, pairingId: w.pairingId, depositId: uuid(), reservationId: resId, voidsDepositId: dep, reason: 'Changed my mind', approval: { pin } })),
    );
    expect(msg).toBe(DEPOSIT_VOID_AFTER_APPLY);
    const code = await pg(sql`
      insert into pos_reservation_deposits (org_id, store_id, reservation_id, kind, amount, tender_id, terminal_id, voids_deposit_id, reason, recorded_by, approved_by, occurred_at_device)
      values (${w.orgId}, ${w.storeId}, ${resId}, 'voided', 600, ${w.cash}, ${w.terminalId}, ${dep}, 'x reason', ${w.counterId}, ${w.managerId}, now())`);
    expect(code).toBe('23001');
  });

  it('refund and keep need the manager too; neither can take more than is held; the Z posts the refund Dr 2170 / Cr cash [kills: refundDeposit skips the approver or the held cap]', async () => {
    const w = await world();
    const resId = await book(w);
    await take(w, resId, '700.00');
    const pin = await pinOf(w, w.managerId);
    const refund = (amount: string, o: { who?: typeof w.counter; pin?: string } = {}) =>
      asOrg(w.orgId, (tx) =>
        refundDeposit(tx, o.who ?? w.counter, { storeId: w.storeId, pairingId: w.pairingId, depositId: uuid(), reservationId: resId, amount, tenderId: w.cash, reason: 'Cancelled in time', ...(o.pin ? { approval: { pin: o.pin } } : {}) }));
    expect(await refusal(refund('100.00'))).toMatch(/manager/i);
    expect(await refusal(refund('700.01', { pin }))).toContain('more than the reservation holds');
    await refund('200.00', { pin });
    expect(await held(resId)).toBe('500.00');
    const keepCall = (who: typeof w.counter, p?: string) =>
      asOrg(w.orgId, (tx) => keepDeposit(tx, who, { storeId: w.storeId, pairingId: w.pairingId, depositId: uuid(), reservationId: resId, amount: '500.00', reason: 'No-show', ...(p ? { approval: { pin: p } } : {}) }));
    expect(await refusal(keepCall(w.counter))).toMatch(/manager/i);
    await close(w, AT, pin);
    const keys = (await depositEntries(w)).map((e) => e.idempotency_key.split(':').slice(2).join(':'));
    expect(keys).toEqual(['refunded:cash', 'taken:cash']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-628 test 4 - a cancelled or no-show reservation with money held cannot close without refund-or-keep', () => {
  it('close is refused while money is held (domain and database); a keep with a reason closes it and the Z posts Dr 2170 / Cr 4500 [kills: close ignores the held balance (domain); drop pos_reservations_guard (database)]', async () => {
    const w = await world();
    const resId = await book(w);
    await take(w, resId, '1000.00');
    await asOrg(w.orgId, (tx) => setReservationStatus(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId: resId, status: 'no_show', atDevice: nowIso() }));
    expect(await statusOf(resId)).toBe('no_show');
    // no choice: refused in words, nothing changes
    const msg = await refusal(asOrg(w.orgId, (tx) => closeReservation(tx, w.manager, { storeId: w.storeId, pairingId: w.pairingId, reservationId: resId })));
    expect(msg).toContain(RESERVATION_CLOSE_WITH_MONEY);
    expect(await statusOf(resId)).toBe('no_show');
    // and the database on its own refuses a close with money held
    expect(await pg(sql`update pos_reservations set status = 'closed', closed_at = now() where id = ${resId}`)).toBe('23001');
    // a choice without a manager's PIN is refused too
    const keepId = uuid();
    const bare = await refusal(
      asOrg(w.orgId, (tx) => closeReservation(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId: resId, resolution: { choice: 'keep', eventId: keepId, reason: 'No call, no show' } })),
    );
    expect(bare).toMatch(/manager/i);
    // the manager decides: keep, with a reason
    const pin = await pinOf(w, w.managerId);
    await asOrg(w.orgId, (tx) =>
      closeReservation(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId: resId, resolution: { choice: 'keep', eventId: keepId, reason: 'No call, no show' }, approval: { pin } }));
    expect(await statusOf(resId)).toBe('closed');
    expect(await held(resId)).toBe('0.00');
    const z = await close(w, AT, pin);
    expect(z.reading.deposits).toMatchObject({ taken: '1000.00', kept: '1000.00', cashNet: '1000.00', count: 2 });
    const kept = (await depositEntries(w)).find((e) => e.idempotency_key.endsWith(':kept:4500'))!;
    const lines = await journalLines(kept.id);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([['2170', '1000.00', '0.00'], ['4500', '0.00', '1000.00']]);
  });

  it('a cancelled reservation can be refunded through close, by the method chosen; no money held closes with no choice; a booked one cannot be closed', async () => {
    const w = await world();
    const pin = await pinOf(w, w.managerId);
    const closeIt = (resId: string, resolution?: Parameters<typeof closeReservation>[2]['resolution']) =>
      asOrg(w.orgId, (tx) => closeReservation(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId: resId, ...(resolution ? { resolution, approval: { pin } } : {}) }));
    const a = await book(w);
    expect(await refusal(closeIt(a))).toContain('Cancel or seat');
    await take(w, a, '400.00');
    await asOrg(w.orgId, (tx) => setReservationStatus(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId: a, status: 'cancelled', atDevice: nowIso() }));
    await closeIt(a, { choice: 'refund', eventId: uuid(), reason: 'Cancelled in time', tenderId: w.cash });
    expect(await statusOf(a)).toBe('closed');
    const b = await book(w, { name: 'Reyes' });
    await asOrg(w.orgId, (tx) => setReservationStatus(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId: b, status: 'cancelled', atDevice: nowIso() }));
    expect(await closeIt(b)).toEqual({ wrote: true });
    expect(await statusOf(b)).toBe('closed');
    // a deposit cannot be taken on a closed or cancelled reservation
    expect(await refusal(asOrg(w.orgId, (tx) => takeDeposit(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, depositId: uuid(), reservationId: b, tenderId: w.cash, amount: '10.00', occurredAtDevice: nowIso() })))).toContain('booked or seated');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('T-628 test 5 (routing) - the deposit applied is a tender of the sale: balanced, on 2170 [kills: depositsApplied left out of the collected side or of the lines]', () => {
  const base = {
    totalSales: money('1000.00'), unliSales: money('0'), alaCarteSales: money('1000.00'), seniorDiscount: money('0'), pwdDiscount: money('0'), otherDiscount: money('0'), comps: money('0'),
    serviceCharge: money('0'), otherCharges: money('0'), cashCollected: money('500.00'), onlineCollected: money('0'), creditSales: money('0'), channels: [], tenders: [],
  };
  it('cash 500 + deposit 500 = a 1,000 sale: Dr 1110 500, Dr 2170 500, Cr 4150 1,000', () => {
    const r = routeSalesDay({ ...base, depositsApplied: money('500.00') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => [l.accountCode, l.side, String(l.amount)])).toEqual([['1110', 'debit', '500.00'], ['2170', 'debit', '500.00'], ['4150', 'credit', '1000.00']]);
  });
  it('without the deposit the same day does NOT reconcile (the 500 is not collected)', () => {
    expect(routeSalesDay({ ...base }).ok).toBe(false);
  });
});
