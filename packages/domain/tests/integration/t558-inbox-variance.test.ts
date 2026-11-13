import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-558 R2 (TESTER) - the T-525 inbox and a short-paid offline sale: P-002. docs/tasks/558-pos-sale-variance-tolerance.md R2 ("The T-525 inbox needs no change: a short payment is
 * no longer a refusal, so it is no longer quarantined"), bible row 453.
 *
 * The events are built the way the outbox builds them (the T-525 fixture helpers) but the SALE's device figures are priceSession's, never typed: a 100.00 line, qty 1.
 *   - a sale paid 99.99 (the P-002 case) arrives APPLIED, with no quarantined row, one variance audit; resent it is a duplicate and the audit does not double;
 *   - a sale paid 99.50 arrives applied too, with the high-severity finding;
 *   - an old quarantined sale (here: one that arrived before its table did, so it was quarantined for a reason of its own) is REPLAYED by a manager and is APPLIED, with the
 *     variance flag, instead of refusing again as it did when the short payment was the refusal.
 *
 * RED NOW FOR THE RIGHT REASON: the sale event is quarantined POS_EVENT_REFUSED "The payments add up to less than the total." (and the replay refuses with the same sentence).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { applyPosEvents, replayQuarantinedEvent } from '../../src/pos/inbox';
import {
  asOrg, closeAll, ev, eventsOf, fixture, linesAddedPayload, newStand, nowIso, receiptOfSession, signedIn, sql, standOpenedPayload, uuid, type Ev, type Fx,
} from './_fixtures/t525-pos';
import { auditRowsOf, hundredItem, jsonText, priceOne, ratesWith } from './_fixtures/t558-variance';

afterAll(closeAll);

const VARIANCE = 'pos.sale_payment_variance';
const SHORTFALL = 'pos.sale_payment_shortfall';
const RULES = ratesWith(1n);
let terminalSeq = 9000;

/** The inbox world: a test-mode store, the cashier signed in on the tablet, and the 100.00 item. */
async function inboxWorld() {
  const f = await fixture();
  await signedIn(f, f.counterId);
  return { f, hundred: await hundredItem(f) };
}

/** stand.opened + lines.added for one 100.00 line, and the sale.completed payload for it paid `cash`; the device figures come from priceSession. */
async function dayParts(f: Fx, hundred: Awaited<ReturnType<typeof hundredItem>>, cash: string, firstSeq = 1) {
  const sessionId = uuid();
  const lineId = uuid();
  const stand = await newStand(f);
  const priced = priceOne('100.00', 1, lineId);
  const sale = {
    sessionId, receiptId: uuid(), terminalNo: 1, terminalSeq: ++terminalSeq, issuedAtDevice: nowIso(), offline: true,
    device: { subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total, lines: priced.lines.map((l) => ({ lineId: l.lineId, gross: l.gross, discountTotal: l.discountTotal, net: l.net })) },
    payments: [{ tenderId: f.cash, amount: cash, toCheck: false }],
    seniors: [],
  };
  const open = ev(firstSeq, 'stand.opened', f.counterId, standOpenedPayload(sessionId, stand.id));
  const lines = ev(firstSeq + 1, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId, item: hundred, qty: 1 }]));
  const saleEvent = ev(firstSeq + 2, 'sale.completed', f.counterId, sale);
  return { sessionId, receiptId: sale.receiptId, open, lines, saleEvent };
}
const send = (f: Fx, events: Ev[]) => applyPosEvents({ pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId }, events }, RULES);
const statuses = (r: Awaited<ReturnType<typeof send>>) => r.results.map((x) => x.status);

describe('R2 inbox - an offline sale paid a little short is applied, never quarantined', () => {
  it('P-002: stand.opened + lines.added + sale.completed (99.99 against 100.00) are three APPLIED; the receipt is at 100.00; no row is quarantined; one variance audit, no finding', async () => {
    const { f, hundred } = await inboxWorld();
    const d = await dayParts(f, hundred, '99.99');
    const r = await send(f, [d.open, d.lines, d.saleEvent]);
    expect(statuses(r), JSON.stringify(r.results)).toEqual(['applied', 'applied', 'applied']);
    expect((await receiptOfSession(d.sessionId))?.total).toBe('100.00');
    expect((await eventsOf(f)).filter((x) => x.status === 'quarantined')).toHaveLength(0);
    expect(await auditRowsOf(f.orgId, VARIANCE)).toHaveLength(1);
    expect(await auditRowsOf(f.orgId, SHORTFALL)).toHaveLength(0);
  });

  it('the same batch resent is three duplicates and the variance audit does not double [kills: a flag written on a replay]', async () => {
    const { f, hundred } = await inboxWorld();
    const d = await dayParts(f, hundred, '99.99');
    await send(f, [d.open, d.lines, d.saleEvent]);
    const again = await send(f, [d.open, d.lines, d.saleEvent]);
    expect(statuses(again)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(await auditRowsOf(f.orgId, VARIANCE)).toHaveLength(1);
  });

  it('a 0.50 gap arrives applied too, with ONE high-severity shortfall audit (the finding) and no quarantine', async () => {
    const { f, hundred } = await inboxWorld();
    const d = await dayParts(f, hundred, '99.50');
    const r = await send(f, [d.open, d.lines, d.saleEvent]);
    expect(statuses(r)).toEqual(['applied', 'applied', 'applied']);
    const rows = await auditRowsOf(f.orgId, SHORTFALL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sensitivity: 'high', severity: 4 });
    expect(jsonText(rows[0]!.after)).toContain('0.50');
    expect((await eventsOf(f)).filter((x) => x.status === 'quarantined')).toHaveLength(0);
  });
});

describe('R2 inbox - the replay of the P-002 case is applied, not refused again', () => {
  it('a sale quarantined because its table had not arrived is replayed by a manager once the table is there: applied, resolution replayed, the variance flagged [kills: the replay refusing "less than the total"]', async () => {
    const { f, hundred } = await inboxWorld();
    const d = await dayParts(f, hundred, '99.99');
    const first = await send(f, [d.saleEvent]);
    expect(statuses(first), 'the sale came before its table: quarantined for THAT reason').toEqual(['quarantined']);
    expect(await receiptOfSession(d.sessionId)).toBeUndefined();

    // The table arrives (the later events of the queue).
    const later = await send(f, [ev(10, 'stand.opened', f.counterId, d.open.payload), ev(11, 'lines.added', f.counterId, d.lines.payload)]);
    expect(statuses(later)).toEqual(['applied', 'applied']);

    const [row] = (await eventsOf(f)).filter((x) => x.kind === 'sale.completed');
    const res = await asOrg(f.orgId, (tx) => replayQuarantinedEvent(tx, f.manager, { storeId: f.storeId, eventId: row!.id }, RULES));
    expect(res, JSON.stringify(res)).toEqual({ replayed: true });
    expect((await receiptOfSession(d.sessionId))?.total).toBe('100.00');
    const after = (await sql<{ resolution: string | null }[]>`select resolution from pos_events where id = ${row!.id}`)[0]!;
    expect(after.resolution).toBe('replayed');
    expect(await auditRowsOf(f.orgId, VARIANCE)).toHaveLength(1);
  });
});
