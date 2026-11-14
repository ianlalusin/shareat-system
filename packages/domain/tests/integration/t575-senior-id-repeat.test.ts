import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-575 (TESTER) - warn when a senior/PWD card number was already used at this store (DEF-843, bible row 462). docs/tasks/575-pos-repeat-senior-id-warning.md
 * as amended by the planner review (13 Nov 2026): the rule is `pos.senior_id_repeat_days` (org-wide, default 1 = the same business day), the comparison is ALWAYS the same store,
 * and the answer never carries the holder's name.
 *
 * THE CONTRACT UNDER TEST (names are the spec's):
 *   - `checkSeniorIdRepeat(tx, actor, { storeId, pairingId, idNumber }, deps?)` -> { used: number, lastReceiptNo: string | null, lastAt: string | null }.
 *     Counts LIVE rows of statutory_discount_records of this store whose lower(btrim(id_number)) matches and whose business_date is in [today - (days - 1), today].
 *     Needs `record_sale` for the store and a live pairing of it (pairingId null = refused). A blank number answers used 0.
 *   - `completeSale`: after the statutory rows are written, when an EARLIER live row of the same store and window matches a diner's card, it writes ONE audit row
 *     `pos.senior_id_repeat` { receiptId, earlierReceiptIds } (no ID, no name). The sale itself is never blocked or changed.
 * Compared against statutory_discount_records (which keeps the BIR ID), never pos_events (scrubbed by T-572).
 *
 * RED NOW FOR THE RIGHT REASON: `checkSeniorIdRepeat` is not exported and the audit action is not in the catalogue.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { catalogueEntry } from '@shareat/db';
import { toBusinessDate } from '@shareat/core/datetime';
import * as pos from '../../src/pos';
import { putRule } from './_fixtures/t512-rules';
import { HOLDER, IDNO } from './_fixtures/t525-pos';
import { RATES, actorOf, addDays, asOrg, auditsOf, closeAll, sell, sql, uuid, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const KEY = 'pos.senior_id_repeat_days';
const ACTION = 'pos.senior_id_repeat';
type Check = { used: number; lastReceiptNo: string | null; lastAt: string | null };
const checkFn = (): ((tx: unknown, actor: unknown, input: Record<string, unknown>, deps?: unknown) => Promise<Check>) => {
  const fn = (pos as Record<string, unknown>).checkSeniorIdRepeat;
  if (typeof fn !== 'function') throw new Error('MISSING EXPORT: checkSeniorIdRepeat is not exported from packages/domain/src/pos (T-575 not built).');
  return fn as never;
};

/** The business date "now" is on: the 4 a.m. start hour, no Z yet. */
const businessToday = (): string => toBusinessDate(new Date(Date.now() - 4 * 3600e3));
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const printed = (w: World, seq: number) => `${w.storeCode}-01-${pad(seq, 6)}`;

async function world75(): Promise<World> {
  return world('live', addDays(businessToday(), -12));
}
const check = (w: World, idNumber: unknown, o: { who?: { personId: string; orgId: string }; pairingId?: string | null; storeId?: string } = {}): Promise<Check> =>
  asOrg(w.orgId, (tx) =>
    checkFn()(tx, o.who ?? w.counter, { storeId: o.storeId ?? w.storeId, pairingId: o.pairingId === undefined ? w.pairingId : o.pairingId, idNumber }, { now: () => new Date() }));

/** An earlier register row, written straight to the table (a sale made some other day or at another store). */
async function priorUse(w: World, o: { storeId?: string; date: string; invoice: string; id?: string; voided?: boolean }): Promise<void> {
  await sql`
    insert into statutory_discount_records (org_id, store_id, business_date, invoice_number, kind, id_number, holder_name, gross_amount, discount_amount, source, recorded_by,
                                            voided_by, voided_at, void_reason)
    values (${w.orgId}, ${o.storeId ?? w.storeId}, ${o.date}, ${o.invoice}, 'senior', ${o.id ?? IDNO}, ${HOLDER}, '100.00', '20.00', 'pos', ${w.counterId},
            ${o.voided ? w.managerId : null}, ${o.voided ? new Date() : null}, ${o.voided ? 'Mistyped' : null})`;
}
const seniorSale = (w: World, at: Date, o: { id?: string; capture?: (i: Record<string, unknown>) => void; beforeComplete?: () => Promise<void>; afterComplete?: () => Promise<void> } = {}) =>
  sell(w, {
    at, items: [{ item: w.menu.pork, qty: 1 }], discounts: [{ lineIndex: 0, kind: 'senior', qty: 1, dinerNo: 1 }],
    pay: [{ tenderId: w.cash, amount: '300.00' }], beforeComplete: o.beforeComplete, afterComplete: o.afterComplete,
    mutate: (i) => {
      if (o.id) (i.seniors as { idNumber: string }[])[0]!.idNumber = o.id;
      o.capture?.(structuredClone(i));
    },
  });
const repeatAudits = (w: World) => auditsOf(w, ACTION);

describe('T-575 the audit action is catalogued', () => {
  it('pos.senior_id_repeat: order / high, store scope, owned by T-575, live (not reserved), server-only [kills: an action the writer refuses; a client-writable one]', () => {
    expect(catalogueEntry(ACTION)).toMatchObject({ category: 'order', sensitivity: 'high', scope: 'store', owner: 'T-575', reserved: false, clientSources: [] });
  });
});

describe('T-575 same store, same day: the second use warns, the first does not', () => {
  it('first use answers used 0; after one sale the same card (any case, any padding) answers used 1 with that receipt number and time; Finish on the repeat still succeeds and writes ONE audit row with both receipt ids and no ID or name [kills: a lookup that matches case-sensitively; a block on the second sale; a missing or duplicated audit row; an ID or name in the trail]', async () => {
    const w = await world75();
    expect(await check(w, IDNO)).toEqual({ used: 0, lastReceiptNo: null, lastAt: null });

    const at1 = new Date();
    const s1 = await seniorSale(w, at1);
    expect(await repeatAudits(w)).toHaveLength(0); // the first use leaves no trail

    const again = await check(w, `  ${IDNO.toLowerCase()} `);
    expect(again.used).toBe(1);
    expect(again.lastReceiptNo).toBe(printed(w, s1.terminalSeq));
    expect(new Date(again.lastAt!).getTime()).toBe(at1.getTime());
    expect(Object.keys(again).sort()).toEqual(['lastAt', 'lastReceiptNo', 'used']); // never a name

    const at2 = new Date();
    const s2 = await seniorSale(w, at2, { id: IDNO.toLowerCase() }); // completes: no block
    const rows = await repeatAudits(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(s2.receiptId);
    expect(rows[0]!.after).toEqual({ receiptId: s2.receiptId, earlierReceiptIds: [s1.receiptId] });
    const everything = JSON.stringify([again, rows]);
    expect(everything).not.toContain(HOLDER);
    expect(everything.toLowerCase()).not.toContain(IDNO.toLowerCase());
    // both sales are recorded and frozen
    const [n] = await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipts where org_id = ${w.orgId}`;
    expect(n!.n).toBe(2);
  });

  it('a different card number on the second sale writes no trail [kills: an audit row for every senior sale]', async () => {
    const w = await world75();
    await seniorSale(w, new Date());
    await seniorSale(w, new Date(), { id: 'OSCA-0000777' });
    expect(await repeatAudits(w)).toHaveLength(0);
  });

  it('replaying the same sale is a no-op: still ONE audit row [kills: a second audit row on a replay]', async () => {
    const w = await world75();
    await seniorSale(w, new Date());
    let input: Record<string, unknown> = {};
    await seniorSale(w, new Date(), { capture: (i) => (input = i) });
    expect(await repeatAudits(w)).toHaveLength(1);
    const r = await asOrg(w.orgId, (tx) => pos.completeSale(tx, w.counter, input as never, { ...RATES, now: () => new Date() }));
    expect(r.wrote).toBe(false);
    expect(await repeatAudits(w)).toHaveLength(1);
  });
});

describe('T-575 always the same store', () => {
  it('a use at the OTHER store the same day does not warn, and its sale leaves no trail [kills: dropping the store condition]', async () => {
    const w = await world75();
    await priorUse(w, { storeId: w.store2Id, date: businessToday(), invoice: 'OTHER-01-000001' });
    expect(await check(w, IDNO)).toEqual({ used: 0, lastReceiptNo: null, lastAt: null });
    await seniorSale(w, new Date());
    expect(await repeatAudits(w)).toHaveLength(0);
  });

  it('a use in ANOTHER ORG never shows [kills: a lookup that is not scoped to the org]', async () => {
    const w = await world75();
    const other = await world75();
    await priorUse(other, { date: businessToday(), invoice: 'FOREIGN-01-000001' });
    expect((await check(w, IDNO)).used).toBe(0);
  });
});

describe('T-575 the window is the rule pos.senior_id_repeat_days', () => {
  it('default 1 = today only: yesterday does not warn; a voided row today does not count; a live row today does [kills: a window that is always wider; counting a voided register row]', async () => {
    const w = await world75();
    await priorUse(w, { date: addDays(businessToday(), -1), invoice: 'LIPA-01-000001' });
    expect((await check(w, IDNO)).used).toBe(0);
    await priorUse(w, { date: businessToday(), invoice: 'LIPA-01-000002', voided: true });
    expect((await check(w, IDNO)).used).toBe(0);
    await priorUse(w, { date: businessToday(), invoice: 'LIPA-01-000003' });
    expect(await check(w, IDNO)).toMatchObject({ used: 1, lastReceiptNo: 'LIPA-01-000003' });
  });

  it('days = 7: a use 6 days ago warns, a use 7 days ago does not [kills: an off-by-one at either edge of the window]', async () => {
    const w = await world75();
    await putRule(sql, w.orgId, KEY, '7.000000', '2000-01-01');
    await priorUse(w, { date: addDays(businessToday(), -7), invoice: 'LIPA-01-000010' });
    expect((await check(w, IDNO)).used).toBe(0);
    await priorUse(w, { date: addDays(businessToday(), -6), invoice: 'LIPA-01-000011' });
    expect(await check(w, IDNO)).toMatchObject({ used: 1, lastReceiptNo: 'LIPA-01-000011' });
    await priorUse(w, { date: addDays(businessToday(), -2), invoice: 'LIPA-01-000012' });
    expect(await check(w, IDNO)).toMatchObject({ used: 2, lastReceiptNo: 'LIPA-01-000012' }); // the most recent one is named
  });
});

describe('T-575 who may ask, and what may be asked', () => {
  it('a blank number answers used 0 without a lookup; a non-text or over-long number is refused [kills: a 500 on an empty box; an unbounded string]', async () => {
    const w = await world75();
    expect(await check(w, '   ')).toEqual({ used: 0, lastReceiptNo: null, lastAt: null });
    await expect(check(w, 12345)).rejects.toThrow();
    await expect(check(w, 'X'.repeat(61))).rejects.toThrow();
  });

  it("refused without a tablet (pairingId null), on a revoked tablet, for a person without record_sale (the kitchen) and for a person of the other store [kills: a lookup open to a phone, an old tablet or another store's staff]", async () => {
    const w = await world75();
    await expect(check(w, IDNO, { pairingId: null })).rejects.toThrow();
    await expect(check(w, IDNO, { pairingId: w.pairingRevokedId })).rejects.toThrow();
    await expect(check(w, IDNO, { who: w.kitchen })).rejects.toThrow();
    await expect(check(w, IDNO, { who: w.managerOther })).rejects.toThrow();
    await expect(check(w, IDNO, { who: actorOf(w.orgId, uuid()) })).rejects.toThrow();
  });
});

describe('T-575 follow-up: two tills, one new card at the same moment', () => {
  // ⚠ Sales of one store already queue behind each other at the END of completeSale (bumpStateVersion locks the pos_stores row until commit), so "B finishes while A is open" can
  // never hold. What matters is where B waits: BEFORE it reads the register (the card lock, a Postgres advisory lock) or only after (the state-version row, a transactionid lock).
  const waiters = async (type: 'advisory' | 'transactionid'): Promise<number> =>
    (await sql<{ n: number }[]>`
      select count(*)::int n from pg_locks l join pg_stat_activity s on s.pid = l.pid where l.locktype = ${type} and not l.granted and s.datname = current_database()`)[0]!.n;
  const until = async (ok: () => Promise<boolean>, ms = 10000): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await ok()) return true;
    return false;
  };

  /** A senior sale prepared (stand, lines, discount) but not yet completed: `go()` starts completeSale, then the transaction is held open until `release()` (or rolled back by release(true)). */
  function till(w: World, id: string) {
    let rollback = false;
    let go!: () => void;
    const goP = new Promise<void>((r) => (go = r));
    let release!: () => void;
    const relP = new Promise<void>((r) => (release = r));
    let prepared!: () => void;
    const preparedP = new Promise<void>((r) => (prepared = r));
    let parked!: () => void;
    const parkedP = new Promise<void>((r) => (parked = r));
    const done = seniorSale(w, new Date(), {
      id,
      beforeComplete: async () => { prepared(); await goP; },
      afterComplete: async () => { parked(); await relP; if (rollback) throw new Error('ROLLBACK-A'); },
    });
    done.catch(() => undefined); // a rolled-back till is expected; the test awaits it itself
    const orFails = (p: Promise<void>) => Promise.race([p, done.then(() => undefined)]); // a failed prepare must fail the test, not hang it
    return { done, go, release: (rb = false) => { rollback = rb; release(); }, prepared: () => orFails(preparedP), parked: () => orFails(parkedP) };
  }
  const receipts = async (w: World) => (await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipts where org_id = ${w.orgId}`)[0]!.n;

  it('(c1) the second till waits on the CARD lock, then writes ONE trail on its receipt naming the first [kills: both sales missing each other uncommitted row, so no trail is written]', async () => {
    const w = await world75();
    const card = 'OSCA-5750001';
    const a = till(w, card);
    const b = till(w, ` ${card.toLowerCase()} `); // another case, padded
    b.release();
    let queued = false;
    try {
      await Promise.all([a.prepared(), b.prepared()]);
      a.go();
      await a.parked(); // A has run completeSale and is held before commit
      b.go();
      queued = await until(async () => (await waiters('advisory')) === 1); // B is queued on the card lock, not past it
    } finally {
      a.release();
      b.go();
    }
    const sa = await a.done;
    const sb = await b.done;
    expect(await receipts(w)).toBe(2);
    const rows = await repeatAudits(w);
    expect.soft(rows).toHaveLength(1);
    expect.soft(rows[0]?.entity_id).toBe(sb.receiptId);
    expect.soft(rows[0]?.after).toEqual({ receiptId: sb.receiptId, earlierReceiptIds: [sa.receiptId] });
    expect(queued).toBe(true);
  });

  it('(c2) two different cards at the same moment do not queue on the card lock, and leave no trail [kills: a lock that serialises every senior sale of the store]', async () => {
    const w = await world75();
    const a = till(w, 'OSCA-5750002');
    const b = till(w, 'OSCA-5750003');
    b.release();
    let atBump = false;
    let cardWaiters = -1;
    try {
      await Promise.all([a.prepared(), b.prepared()]);
      a.go();
      await a.parked();
      b.go();
      atBump = await until(async () => (await waiters('transactionid')) === 1); // B went past the card step and now waits only behind A's store row
      cardWaiters = await waiters('advisory');
    } finally {
      a.release();
      b.go();
    }
    await a.done;
    await b.done;
    expect(atBump).toBe(true);
    expect(cardWaiters).toBe(0);
    expect(await receipts(w)).toBe(2);
    expect(await repeatAudits(w)).toHaveLength(0);
  });

  it('(c3) the first till is rolled back: the second finishes with NO trail and nothing is left locked [kills: a lock that outlives a rollback, or a phantom repeat]', async () => {
    const w = await world75();
    const card = 'OSCA-5750004';
    const a = till(w, card);
    const b = till(w, card);
    b.release();
    try {
      await Promise.all([a.prepared(), b.prepared()]);
      a.go();
      await a.parked();
      b.go();
      await until(async () => (await waiters('advisory')) === 1);
    } finally {
      a.release(true);
      b.go();
    }
    await expect(a.done).rejects.toThrow('ROLLBACK-A');
    await b.done;
    expect(await receipts(w)).toBe(1);
    expect(await repeatAudits(w)).toHaveLength(0);
    expect(await waiters('advisory')).toBe(0);
  });
});
