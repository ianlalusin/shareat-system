import { describe, expect, it } from 'vitest';
import { buildSalePayload, payBlockerDetail, receiptViewOf, type PayInput } from '../_payment/logic';
import { priceBill } from '../_payment/logic';
import {
  checkDeposit, checkReservation, depositForSession, depositTakenEvent, needsSettling, projectReservations, reasonProblem, reservationCreatedEvent, reservationSeatedEvent, reservationStatusEvent,
  seatTableEvent, sortReservations, type ReservationRow,
} from './logic';

/**
 * T-628 - the pure half of the Reservations tab and the Pay screen's deposit: the offline events, the checks in the server's sentences, the list with the outbox on top, and the
 * sale payload that carries a deposit as a part-payment. Each named mutant must turn its test red.
 */
const row = (o: Partial<ReservationRow> = {}): ReservationRow => ({
  id: '11111111-1111-4111-8111-111111111111', customerName: 'Santos', phone: null, partySize: 8, reservedFor: '2026-11-23T11:00:00.000Z', standId: null, note: null, status: 'booked', sessionId: null, held: '0.00', ...o,
});
const NOW = new Date('2026-11-22T07:00:00.000Z');
const cash = { id: 'c0', name: 'Cash', kind: 'cash' };
const gcash = { id: 'g0', name: 'GCash', kind: 'wallet' };

describe('T-628 checks', () => {
  it('a reservation needs a name, 1 to 500 guests and a time [kills: the name or party rule dropped]', () => {
    expect(checkReservation({ name: 'Santos', phone: '', partySize: 4, reservedFor: NOW.toISOString(), note: '' })).toBeNull();
    expect(checkReservation({ name: '  ', phone: '', partySize: 4, reservedFor: NOW.toISOString(), note: '' })).not.toBeNull();
    expect(checkReservation({ name: 'Santos', phone: '', partySize: 0, reservedFor: NOW.toISOString(), note: '' })).toMatch(/party size/i);
    expect(checkReservation({ name: 'Santos', phone: '', partySize: 4, reservedFor: '', note: '' })).toMatch(/date and time/i);
  });
  it('a deposit needs a method and an amount above zero; a wallet needs its reference [kills: the wallet reference rule dropped]', () => {
    expect(checkDeposit({ amount: '500', tender: cash, referenceNo: '' })).toBeNull();
    expect(checkDeposit({ amount: '0', tender: cash, referenceNo: '' })).toMatch(/more than zero/);
    expect(checkDeposit({ amount: '500', tender: undefined, referenceNo: '' })).toMatch(/how the deposit is paid/);
    expect(checkDeposit({ amount: '500', tender: gcash, referenceNo: '' })).not.toBeNull();
    expect(checkDeposit({ amount: '500', tender: gcash, referenceNo: 'GC-0001' })).toBeNull();
    expect(checkDeposit({ amount: '1000000.01', tender: cash, referenceNo: '' })).toMatch(/at most/);
  });
  it('a settle reason is 3 to 200 characters', () => {
    expect(reasonProblem('ok')).not.toBeNull();
    expect(reasonProblem('No call, no show')).toBeNull();
  });
});

describe('T-628 events', () => {
  it('each tap is one event with its own ids and times', () => {
    const created = reservationCreatedEvent({ personId: 'p', now: NOW, reservationId: 'r1', name: ' Santos ', phone: '', partySize: 8, reservedFor: NOW, note: '' });
    expect(created).toMatchObject({ kind: 'reservation.created', payload: { reservationId: 'r1', customerName: 'Santos', partySize: 8 } });
    expect(created.payload).not.toHaveProperty('phone'); // blank optional text is not sent
    expect(depositTakenEvent({ personId: 'p', now: NOW, depositId: 'd1', reservationId: 'r1', tenderId: 'c0', amount: '500' }).payload).toMatchObject({ depositId: 'd1', amount: '500.00' });
    expect(reservationSeatedEvent({ personId: 'p', now: NOW, reservationId: 'r1', sessionId: 's1' }).kind).toBe('reservation.seated');
    expect(seatTableEvent({ personId: 'p', now: NOW, sessionId: 's1', standId: 'st', heads: 8 })).toMatchObject({ kind: 'stand.opened', payload: { sessionId: 's1', standId: 'st', headsCashier: 8, mode: 'dine_in' } });
    expect(reservationStatusEvent({ personId: 'p', now: NOW, reservationId: 'r1', status: 'no_show' }).payload).toMatchObject({ status: 'no_show' });
  });
});

describe('T-628 the list with the outbox on top', () => {
  it('a booking, a deposit, a seating and a no-show not yet sent all show [kills: projectReservations ignores pending events]', () => {
    const rows = projectReservations([row({ id: 'a' })], [
      { kind: 'reservation.created', payload: { reservationId: 'b', customerName: 'Reyes', partySize: 2, reservedFor: NOW.toISOString() } },
      { kind: 'deposit.taken', payload: { reservationId: 'a', amount: '300.00' } },
      { kind: 'deposit.taken', payload: { reservationId: 'a', amount: '200.50' } },
      { kind: 'reservation.seated', payload: { reservationId: 'a', sessionId: 's1' } },
      { kind: 'reservation.status_set', payload: { reservationId: 'b', status: 'no_show' } },
    ]);
    expect(rows.find((r) => r.id === 'a')).toMatchObject({ status: 'seated', sessionId: 's1', held: '500.50' });
    expect(rows.find((r) => r.id === 'b')).toMatchObject({ status: 'no_show', customerName: 'Reyes', held: '0.00' });
  });
  it('the ones a manager must settle come first, then soonest first', () => {
    const rows = sortReservations([
      row({ id: 'late', reservedFor: '2026-11-24T11:00:00.000Z' }),
      row({ id: 'soon', reservedFor: '2026-11-23T11:00:00.000Z' }),
      row({ id: 'settle', status: 'no_show', held: '500.00', reservedFor: '2026-11-25T11:00:00.000Z' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['settle', 'soon', 'late']);
    expect(needsSettling(rows[0]!)).toBe(true);
    expect(needsSettling(row({ status: 'cancelled', held: '0.00' }))).toBe(false);
  });
  it('the Pay screen offers the deposit of the reservation seated at that table, only while something is held [kills: depositForSession matches by name or ignores the table]', () => {
    const base = [row({ id: 'a', status: 'seated', sessionId: 's1', held: '500.00' }), row({ id: 'b', status: 'seated', sessionId: 's2', held: '0.00' })];
    expect(depositForSession(base, [], 's1')).toEqual({ reservationId: 'a', held: '500.00', customerName: 'Santos' });
    expect(depositForSession(base, [], 's2')).toBeUndefined();
    expect(depositForSession(base, [], 's9')).toBeUndefined();
    expect(depositForSession(undefined, undefined, 's1')).toBeUndefined();
  });
});

describe('T-628 the sale payload with a deposit', () => {
  const priced = priceBill({ lines: [{ lineId: 'l1', qty: 4, unitPrice: '250.00', bundleHeads: null, discounts: [] }], rules: { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 }, vatRegistered: true });
  const base = { sessionId: 's1', receiptId: 'rc', terminalNo: 1, terminalSeq: 1, now: NOW, online: true, priced, tenders: [cash], seniors: [] };
  it('carries the deposit beside the payments, and none when unused [kills: the payload drops the deposit]', () => {
    const withDeposit = buildSalePayload({ ...base, rows: [{ tenderId: 'c0', amount: '500.00' }], deposit: { reservationId: 'r1', amount: '500' } });
    expect(withDeposit.deposit).toEqual({ reservationId: 'r1', amount: '500.00' });
    expect((withDeposit.payments as unknown[]).length).toBe(1);
    expect(buildSalePayload({ ...base, rows: [{ tenderId: 'c0', amount: '1000.00' }] })).not.toHaveProperty('deposit');
  });
  it('a deposit can cover the whole bill: no payment row is needed [kills: the no-payment blocker ignores what is left to pay]', () => {
    expect(payBlockerDetail({ total: '0.00', rows: [], tenders: [cash], diners: [], holders: {} })).toBeNull();
    expect(payBlockerDetail({ total: '500.00', rows: [], tenders: [cash], diners: [], holders: {} })?.message).toMatch(/Add a payment/);
  });
  it('the receipt shows the deposit and works the change out against the rest', () => {
    const input = {
      ...base, rows: [{ tenderId: 'c0', amount: '600.00' }], deposit: { reservationId: 'r1', amount: '500.00' }, vatRateLabel: '12%', layout: { width: 58 as const, font: 'normal' as const }, copies: 1,
      receipt: { header: { businessName: 'S', addressLines: [], tin: null, vatRegistered: true }, tableLabel: null, heads: null, cashierName: 'Joy', issuedAtLocal: '', footerLines: [], lines: [], scPwdDiscount: '0.00' as never },
      personId: 'p',
    } as unknown as PayInput;
    const view = receiptViewOf(input, 'LIP-01-000001');
    expect(String(view.deposit)).toBe('500.00');
    expect(String(view.change)).toBe('100.00'); // paid 600 against 1,000 - 500 = 500 to pay
  });
});
