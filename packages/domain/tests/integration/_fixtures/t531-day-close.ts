/**
 * T-531 (TESTER) - the shared fixture for the POS v2 day close tests (reading, close, backlog, posting, bridge, routes).
 * docs/tasks/531-pos-day-close.md R2-R5, R8, R10, R11. Built on the T-525 fixture (a fresh org per `world()` call), so nothing here names a lane database.
 *
 * ## How the days are made
 * Sales are made through the REAL domain (openStand / addLines / addLineDiscount / completeSale), at a chosen Manila time, and every device figure
 * comes from `priceSession` run over the rows the database holds (never typed by hand). The hand-computed literal figures of the standard day are
 * asserted once in `t531-reading.test.ts` against `priceSession`'s own output, so a drift in either is loud.
 *
 * ## The standard day (`standardDay`), business date D1, VAT org (12%), senior/PWD 20%, day starts 04:00
 *   R1  3 unli heads (449.00) + 1 cola (80.00) + 1 rice refill (0.00)            subtotal 1,427.00  total 1,427.00  cash 2,000.00 tendered, change 573.00
 *   R2  2 unli heads, ONE senior on 1 head (VAT 48.11 + 80.18 = 128.29), 1 pork  subtotal 1,148.00  discount 128.29  total 1,019.71  GCash 500.00 + cash 600.00 (change 80.29)
 *   R3  2 pork (250.00) with the Employee 10% preset (qty 2)                      subtotal   500.00  discount  50.00  total   450.00  cash 500.00 (change 50.00)
 *   => receipts 3, subtotal 3,075.00, senior 128.29, pwd 0.00, other 50.00, discounts 178.29, gross 2,896.71,
 *      unli 2,245.00 + a la carte 830.00 = 3,075.00, heads 5, package sessions 2, senior/PWD diners 1,
 *      cash net of change 2,396.71 + GCash 500.00 = 2,896.71.
 */
import { priceSession, type PriceSnapshot } from '../../../src/pos';
import type { Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  asOrg, closeAll, fixture, newStand, pinOf, sql, uuid, uid, RATES, HOLDER, IDNO, actorOf, signedIn,
  type Fx, type Item,
} from './t525-pos';
import { openStand, addLines, addLineDiscount, completeSale, requestRefill } from '../../../src/pos';

export { asOrg, closeAll, fixture, pinOf, sql, uuid, uid, RATES, actorOf, signedIn };
export type { Fx, Item, Tx, Actor };

// ------------------------------------------------------------------------------------------------------------------------------
// Time: Manila (UTC+8). The business day starts at 04:00 (RATES), so 02:00 on D2 is still business day D1.
// ------------------------------------------------------------------------------------------------------------------------------
/**
 * The test days are the two-days-from-now Manila date and the four after it (not fixed dates): the fixture's menu offers start "now", and the menu is read AT the
 * sale's device time, so a day before the fixture existed reads "item not on the store menu". Keep D1 <= 2026-12-31 (the bridge's last day) - true until about 26 Dec 2026.
 */
export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
export const D1 = addDays(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), 2);
export const D2 = addDays(D1, 1);
export const D3 = addDays(D1, 2);
export const D4 = addDays(D1, 3);
export const D5 = addDays(D1, 4);
/** A live_from far after every test day (a store "live from" later than the day a feed day is made on). */
export const FAR = '2027-06-01';
export const ymd = (date: string): string => date.replace(/-/g, '');
/** `manila(D1, '19:30')` as an instant. */
export const manila = (date: string, hm: string): Date => new Date(`${date}T${hm}:00+08:00`);
export const iso = (d: Date): string => d.toISOString();

// ------------------------------------------------------------------------------------------------------------------------------
// The subject, loaded lazily so a missing module fails each case with its own message instead of killing the file at import.
// ------------------------------------------------------------------------------------------------------------------------------
// ASSUMED API (packages/domain/src/pos/day-close.ts, re-exported by pos/index.ts):
//   readingFor(tx, actor, { storeId, terminalId, at }, deps?)            -> Reading
//   xReading(tx, actor, { storeId, terminalId?, pairingId? }, deps?)      -> Reading   (the paired terminal; capability record_sale; writes nothing)
//   closeDay(tx, actor, { storeId, pairingId, terminalId, closeId, approval: { pin } }, deps?) -> { wrote, dayCloseId, zNo, reading, salesDayId }
//   closeBacklog(tx, actor, { storeId, pairingId, terminalId, closeRunId, approval: { pin } }, deps?) -> { wrote, closes: { dayCloseId, zNo, businessDate, salesDayId }[] }
//   sendV1Bridge(tx, actor, { storeId, businessDates: string[] }, { writer }) -> { results: { businessDate, status: 'sent' | 'failed' | 'skipped', reason? }[] }
//   resendV1Bridge(tx, actor, { storeId, businessDate }, { writer })     -> { sent: true }
//   listDayCloses(tx, actor, { storeId, limit? }, deps?)                 -> { closes: { id, zNo, businessDate, grossTotal, byTender, v1Status }[] }
//   deps = { readRules?, now? }  (the T-524 PosDeps: `now` is the server clock this module uses as `at`)
// and packages/domain/src/pos/v1-bridge-payload.ts: buildV1BridgePayload(input) (pure), V1_BRIDGE_LAST_DATE.
export type Deps = { readRules?: typeof RATES.readRules; now?: () => Date };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W<R = any> = (tx: Tx, actor: Actor, input: any, deps?: any) => Promise<R>;
export interface TenderLine { tenderId: string; amount: string }
export interface Reading {
  storeId?: string; terminalId?: string; windowStart: Date; windowEnd: Date; receiptCount: number; grossTotal: string; subtotal: string; discountTotal: string;
  discounts: { senior: string; pwd: string; other: string }; seniorPwdDiners: number; unliSales: string; alaCarteSales: string;
  byTender: TenderLine[] | Record<string, string>;
  /** T-558 (R3): Sum of the receipts' short payments (gaps > 0), and how many of them are above the tolerance (findings). */
  varianceTotal?: string; shortfallCount?: number;
  toCheckCount: number; heads: number; packageSessions: number; lateCount: number; spansTwoDates: boolean;
}
export interface CloseResult { wrote: boolean; dayCloseId: string; zNo: number; reading: Reading; salesDayId: string | null }
interface DayCloseApi {
  readingFor: W<Reading>;
  xReading: W<Reading>;
  closeDay: W<CloseResult>;
  closeBacklog: W<{ wrote: boolean; closes: { dayCloseId: string; zNo: number; businessDate: string; salesDayId: string | null }[] }>;
  sendV1Bridge: W<{ results: { businessDate: string; status: string; reason?: string }[] }>;
  resendV1Bridge: W<{ sent: boolean }>;
  listDayCloses: W<{ closes: { id: string; zNo: number; businessDate: string; grossTotal: string; byTender: unknown; v1Status: string }[] }>;
}
let loaded: Record<string, unknown> | null | undefined;
async function api(name: string): Promise<(...a: unknown[]) => Promise<unknown>> {
  if (loaded === undefined) loaded = await import(/* @vite-ignore */ '../../../src/pos/day-close').catch(() => null);
  const fn = loaded?.[name];
  if (typeof fn !== 'function') throw new Error(`MISSING EXPORT: packages/domain/src/pos/day-close.ts does not export ${name} (T-531 not built).`);
  return fn as (...a: unknown[]) => Promise<unknown>;
}
export const DC = new Proxy({} as DayCloseApi, { get: (_t, name: string) => (...args: unknown[]) => api(name).then((fn) => fn(...args)) });

/** `byTender` as { tenderId: amount }, whichever of the two natural shapes the builder returns (array of rows or a record). */
export function tenderMap(r: Pick<Reading, 'byTender'>): Record<string, string> {
  if (Array.isArray(r.byTender)) return Object.fromEntries(r.byTender.map((t) => [t.tenderId, t.amount]));
  return r.byTender;
}

// ------------------------------------------------------------------------------------------------------------------------------
// The world
// ------------------------------------------------------------------------------------------------------------------------------
export type World = Fx & { terminalId: string; posStoreId: string; liveFrom: string | null; stand: (n?: number) => Promise<{ id: string; number: number }> };

/**
 * A fresh org on the T-525 fixture, in `mode`, with `live_from` = `liveFrom` (live only), the terminal id, the v1 link's POS store id, and the v1 method names
 * (`tenders.pos_v1_alias`) the bridge maps through: Cash -> 'Cash', GCash -> 'GCash'. Everyone the close needs is signed in on the tablet.
 */
export async function world(mode: 'test' | 'live' = 'live', liveFrom: string = D1): Promise<World> {
  const f = await fixture(mode);
  if (mode === 'live') await sql`update pos_stores set live_from = ${liveFrom} where store_id = ${f.storeId}`;
  const [t] = await sql<{ id: string }[]>`select id from pos_terminals where store_id = ${f.storeId} and terminal_no = 1`;
  const [l] = await sql<{ pos_store_id: string }[]>`select pos_store_id from pos_v1_store_links where store_id = ${f.storeId}`;
  await sql`update tenders set pos_v1_alias = 'Cash' where id = ${f.cash}`;
  await sql`update tenders set pos_v1_alias = 'GCash' where id = ${f.gcash}`;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${f.orgId}, d::date, (d + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2026-10-01'::date, '2027-06-01'::date, interval '1 month') d`;
  await signedIn(f, f.counterId, f.managerId, f.adminId);
  return { ...f, terminalId: t!.id, posStoreId: l!.pos_store_id, liveFrom: mode === 'live' ? liveFrom : null, stand: () => newStand(f) };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Making a sale, through the real domain, with device figures from priceSession
// ------------------------------------------------------------------------------------------------------------------------------
let seqCounter = 7000;
export interface DiscountSpec {
  /** index into `items` of the line it goes on */
  lineIndex: number;
  kind: 'senior' | 'pwd' | 'preset' | 'custom';
  qty: number;
  presetId?: string;
  valueType?: 'percent' | 'fixed';
  value?: string;
  dinerNo?: number;
}
export interface PaySpec { tenderId: string; amount: string; ref?: string; toCheck?: boolean }
export interface SaleSpec {
  at: Date;
  items: { item: Item; qty: number }[];
  heads?: number;
  discounts?: DiscountSpec[];
  pay: PaySpec[];
  offline?: boolean;
  /** a rice refill on the table, requested after the items */
  refill?: boolean;
  who?: Actor;
  /** Sell on terminal 2 of the store (default terminal 1). */
  terminal?: SecondTerminal;
  /** Internal: the terminal number written on the sale. */
  terminalNo?: number;
  /** When given, the helper fails loudly unless priceSession produced exactly this total (the hand figure of the case). */
  expectTotal?: string;
  /** T-558: the rule reader the sale runs with (default RATES; `{}` = the real reader over the database). `now` is always the sale's own time. */
  deps?: Omit<Deps, 'now'>;
  /** T-558: edit the completeSale input after priceSession built it (e.g. a device total that differs from the server's). */
  mutate?: (input: Record<string, unknown>) => void;
}
export interface MadeSale { receiptId: string; sessionId: string; subtotal: string; discountTotal: string; total: string; terminalSeq: number }

export async function sell(f: World, o: SaleSpec): Promise<MadeSale> {
  if (o.terminal) {
    const { terminal, ...rest } = o;
    return terminal.use(() => sell(f, { ...rest, terminalNo: terminal.no }));
  }
  const who = o.who ?? f.counter;
  const deps = { ...(o.deps ?? RATES), now: () => o.at };
  const sessionId = uuid();
  const pairing = f.pairingId;
  const stand = await f.stand();
  const packageQty = o.items.filter((i) => i.item === f.menu.unli).reduce((a, i) => a + i.qty, 0);
  const heads = o.heads ?? (packageQty > 0 ? packageQty : 2);
  await asOrg(f.orgId, (tx) =>
    openStand(tx, who, { storeId: f.storeId, pairingId: pairing, sessionId, mode: 'dine_in', standId: stand.id, headsCashier: heads, openedAtDevice: iso(o.at) }));
  const lineIds = o.items.map(() => uuid());
  await asOrg(f.orgId, (tx) =>
    addLines(tx, who, {
      storeId: f.storeId, pairingId: pairing, sessionId,
      lines: o.items.map((l, i) => ({ lineId: lineIds[i]!, menuItemId: l.item.itemId, variantId: l.item.variantId, qty: l.qty, addedAtDevice: iso(o.at) })),
    }));
  if (o.refill) {
    await asOrg(f.orgId, (tx) =>
      requestRefill(tx, f.admin, { storeId: f.storeId, pairingId: pairing, sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: iso(o.at) }] }));
  }
  const seniors: { dinerNo: number; kind: 'senior' | 'pwd'; idNumber: string; holderName: string }[] = [];
  for (const d of o.discounts ?? []) {
    await asOrg(f.orgId, (tx) =>
      addLineDiscount(tx, who, {
        storeId: f.storeId, pairingId: pairing, discountId: uuid(), lineId: lineIds[d.lineIndex]!, kind: d.kind, qty: d.qty,
        ...(d.presetId ? { presetId: d.presetId } : {}), ...(d.valueType ? { valueType: d.valueType } : {}), ...(d.value ? { value: d.value } : {}),
        ...(d.dinerNo !== undefined ? { dinerNo: d.dinerNo } : {}), appliedAtDevice: iso(o.at),
      }, deps));
    if (d.kind === 'senior' || d.kind === 'pwd') seniors.push({ dinerNo: d.dinerNo ?? 1, kind: d.kind, idNumber: IDNO, holderName: HOLDER });
  }

  // The device's own figures: priceSession over what the database now holds (live lines, active discounts).
  const lines = await sql<{ id: string; qty: number; unit_price: string; bundle_heads: number | null }[]>`
    select id, qty, unit_price::text, bundle_heads from table_session_lines where session_id = ${sessionId} and kitchen_status <> 'cancelled' order by added_at, id`;
  const discounts = await sql<{ id: string; session_line_id: string; kind: string; value_type: string; value: string; qty: number }[]>`
    select id, session_line_id, kind, value_type, value::text, qty from table_session_line_discounts
     where session_line_id = any(${lines.map((l) => l.id)}) and status = 'active' order by applied_at_device, id`;
  const snap: PriceSnapshot = {
    vatRegistered: true, vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n,
    lines: lines.map((l) => ({
      lineId: l.id, qty: l.qty, unitPrice: l.unit_price, bundleHeads: l.bundle_heads,
      discounts: discounts.filter((d) => d.session_line_id === l.id).map((d) => ({ discountId: d.id, kind: d.kind as 'senior', valueType: d.value_type as 'percent', value: d.value, qty: d.qty })),
    })),
  };
  const priced = priceSession(snap);
  if (o.expectTotal !== undefined && priced.total !== o.expectTotal) throw new Error(`FIXTURE DRIFT: priceSession total ${priced.total}, the case expects ${o.expectTotal}`);

  const terminalSeq = ++seqCounter;
  const receiptId = uuid();
  const wallet = new Set([f.gcash, f.mayaOff]);
  const input = {
    storeId: f.storeId, pairingId: pairing, sessionId, receiptId, terminalNo: o.terminalNo ?? 1, terminalSeq, issuedAtDevice: iso(o.at), offline: o.offline === true,
    device: {
      subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total,
      lines: priced.lines.map((l) => ({ lineId: l.lineId, gross: l.gross, discountTotal: l.discountTotal, net: l.net })),
    },
    payments: o.pay.map((p) => ({
      tenderId: p.tenderId, amount: p.amount, toCheck: p.toCheck ?? (o.offline === true && wallet.has(p.tenderId)),
      ...(wallet.has(p.tenderId) ? { referenceNo: p.ref ?? `REF-${terminalSeq}` } : {}),
    })),
    seniors,
  };
  o.mutate?.(input as unknown as Record<string, unknown>);
  await asOrg(f.orgId, (tx) => completeSale(tx, who, input, deps));
  return { receiptId, sessionId, subtotal: priced.subtotal, discountTotal: priced.discountTotal, total: priced.total, terminalSeq };
}

/**
 * A second till of the store (terminal 2). ONE live pairing per store is a database rule (row 313), so terminal 2 cannot be paired at the same time as terminal 1:
 * `use(fn)` hands the store's live pairing to terminal 2 (terminal 1 gets a revoked one), runs `fn`, and gives it back. `sell({ terminal })` does this itself.
 */
export interface SecondTerminal { no: number; terminalId: string; pairingId: string; use: <T>(fn: () => Promise<T>) => Promise<T> }
export async function secondTerminal(f: World): Promise<SecondTerminal> {
  const revoked = async (label: string) =>
    (await sql<{ id: string }[]>`
      insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by, revoked_at, revoked_by)
      values (${f.orgId}, ${f.storeId}, ${uid(label)}, ${uid('digest')}, ${f.adminId}, now(), ${f.adminId}) returning id`)[0]!.id;
  const parkedFor1 = await revoked('park1');
  const parkedFor2 = await revoked('park2');
  const [t] = await sql<{ id: string }[]>`
    insert into pos_terminals (org_id, store_id, terminal_no, pairing_id, created_by) values (${f.orgId}, ${f.storeId}, 2, ${parkedFor2}, ${f.adminId}) returning id`;
  const use = async <T>(fn: () => Promise<T>): Promise<T> => {
    await sql`update pos_terminals set pairing_id = ${parkedFor1} where id = ${f.terminalId}`;
    await sql`update pos_terminals set pairing_id = ${f.pairingId} where id = ${t!.id}`;
    try {
      return await fn();
    } finally {
      await sql`update pos_terminals set pairing_id = ${parkedFor2} where id = ${t!.id}`;
      await sql`update pos_terminals set pairing_id = ${f.pairingId} where id = ${f.terminalId}`;
    }
  };
  return { no: 2, terminalId: t!.id, pairingId: f.pairingId, use };
}

/** The standard three-receipt day (see the header) on `date`: R1 at 12:00, R2 at 19:30, R3 at 21:00. */
export async function standardDay(f: World, date: string = D1): Promise<MadeSale[]> {
  const m = f.menu;
  const r1 = await sell(f, {
    at: manila(date, '12:00'), items: [{ item: m.unli, qty: 3 }, { item: m.cola, qty: 1 }], refill: true, expectTotal: '1427.00',
    pay: [{ tenderId: f.cash, amount: '2000.00' }],
  });
  const r2 = await sell(f, {
    at: manila(date, '19:30'), items: [{ item: m.unli, qty: 2 }, { item: m.pork, qty: 1 }], discounts: [{ lineIndex: 0, kind: 'senior', qty: 1, dinerNo: 1 }], expectTotal: '1019.71',
    pay: [{ tenderId: f.gcash, amount: '500.00' }, { tenderId: f.cash, amount: '600.00' }],
  });
  const r3 = await sell(f, {
    at: manila(date, '21:00'), items: [{ item: m.pork, qty: 2 }], discounts: [{ lineIndex: 0, kind: 'preset', qty: 2, presetId: f.emp10 }], expectTotal: '450.00',
    pay: [{ tenderId: f.cash, amount: '500.00' }],
  });
  return [r1, r2, r3];
}
/** One plain pork x1 (250.00) cash sale at `at`. */
export const porkSale = (f: World, at: Date): Promise<MadeSale> =>
  sell(f, { at, items: [{ item: f.menu.pork, qty: 1 }], expectTotal: '250.00', pay: [{ tenderId: f.cash, amount: '250.00' }] });

// ------------------------------------------------------------------------------------------------------------------------------
// Calling the subject
// ------------------------------------------------------------------------------------------------------------------------------
export const clockAt = (at: Date): Deps => ({ ...RATES, now: () => at });
export const closeInput = (f: World, pin: string, o: { closeId?: string; terminalId?: string } = {}) => ({
  storeId: f.storeId, pairingId: f.pairingId, terminalId: o.terminalId ?? f.terminalId, closeId: o.closeId ?? uuid(), approval: { pin },
});
/** closeDay as `who` (default the counter), approved by `pin`, at server time `at`, in ONE transaction that rolls back on a throw. */
export const close = (f: World, at: Date, pin: string, o: { who?: Actor; closeId?: string } = {}) =>
  asOrg(f.orgId, (tx) => DC.closeDay(tx, o.who ?? f.counter, closeInput(f, pin, { closeId: o.closeId }), clockAt(at)));
export const backlog = (f: World, at: Date, pin: string, o: { who?: Actor; closeRunId?: string } = {}) =>
  asOrg(f.orgId, (tx) => DC.closeBacklog(tx, o.who ?? f.manager, { storeId: f.storeId, pairingId: f.pairingId, terminalId: f.terminalId, closeRunId: o.closeRunId ?? uuid(), approval: { pin } }, clockAt(at)));
export const reading = (f: World, at: Date, o: { who?: Actor } = {}) =>
  asOrg(f.orgId, (tx) => DC.readingFor(tx, o.who ?? f.counter, { storeId: f.storeId, terminalId: f.terminalId, at }, clockAt(at)));

// ------------------------------------------------------------------------------------------------------------------------------
// Raw readers: the database is the oracle
// ------------------------------------------------------------------------------------------------------------------------------
export interface CloseRow {
  id: string; z_no: number; business_date: string; window_start: Date; window_end: Date; receipt_count: number; gross_total: string; closed_by: string; approved_by: string; terminal_id: string;
}
export const closesOf = (f: World) => sql<CloseRow[]>`
  select id, z_no, business_date::text, window_start, window_end, receipt_count, gross_total::text, closed_by, approved_by, terminal_id
    from pos_day_closes where org_id = ${f.orgId} order by z_no`;
export const closeTendersOf = (closeId: string) => sql<{ tender_id: string; amount: string }[]>`
  select tender_id, amount::text from pos_day_close_tenders where day_close_id = ${closeId} order by pos_day_close_tenders.amount desc`; // (qualified: a bare `amount` would sort by the TEXT alias, '500.00' after '2396.71')
export const openReceiptCount = async (f: World) => Number((await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipts where org_id = ${f.orgId} and day_close_id is null`)[0]!.n);
export const receiptsOfClose = (closeId: string) => sql<{ id: string }[]>`select id from pos_sales_receipts where day_close_id = ${closeId} order by id`;
export interface DayRow {
  id: string; business_date: string; status: string; source: string; pos_day_close_id: string | null; total_sales: string; unli_sales: string; ala_carte_sales: string;
  senior_discount: string; pwd_discount: string; other_discount: string; comps: string; refunds: string; service_charge: string; other_charges: string;
  cash_collected: string; online_collected: string; credit_sales: string; submitted_by: string | null; created_by: string; journal_entry_id: string | null; verified_by: string | null;
}
export const salesDaysOf = (f: World) => sql<DayRow[]>`
  select id, business_date::text, status, source, pos_day_close_id, total_sales::text, unli_sales::text, ala_carte_sales::text, senior_discount::text, pwd_discount::text,
         other_discount::text, comps::text, refunds::text, service_charge::text, other_charges::text, cash_collected::text, online_collected::text, credit_sales::text,
         submitted_by, created_by, journal_entry_id, verified_by
    from sales_days where org_id = ${f.orgId} order by business_date, created_at`;
export const salesDayTendersOf = (dayId: string) => sql<{ money_account_id: string; amount: string }[]>`
  select money_account_id, amount::text from sales_day_tenders where sales_day_id = ${dayId} order by sales_day_tenders.amount desc`;
export const channelRowsOf = async (dayId: string) => Number((await sql<{ n: number }[]>`select count(*)::int n from sales_day_channels where sales_day_id = ${dayId}`)[0]!.n);
export const auditsOf = (f: World, action: string) => sql<{ action: string; actor_person_id: string | null; store_id: string | null; entity_id: string; before: unknown; after: unknown }[]>`
  select action, actor_person_id, store_id, entity_id, before, after from audit_log where org_id = ${f.orgId} and action = ${action} order by recorded_at, id`;
export const journalLines = (entryId: string) => sql<{ code: string; debit: string; credit: string }[]>`
  select a.code, jl.debit::text, jl.credit::text from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId} order by a.code, jl.line_no`;
export const stateVersion = async (f: World) => Number((await sql<{ v: string }[]>`select state_version::text v from pos_stores where store_id = ${f.storeId}`)[0]!.v);

/** The id of the cash and the GCash tender's money account (the sales-day tender rows point at the account). */
export const gcashAccountId = async (f: World) => (await sql<{ money_account_id: string }[]>`select money_account_id from tenders where id = ${f.gcash}`)[0]!.money_account_id;

// ------------------------------------------------------------------------------------------------------------------------------
// The fake v1 bridge writer (R5: no real Firestore in CI)
// ------------------------------------------------------------------------------------------------------------------------------
export interface BridgeCall { path: string; data: Record<string, unknown>; opts: { merge: boolean } }
/** A writer with the shape `{ set(path, data, opts) }` that records every call; `failWith` makes the next calls reject. */
export function fakeWriter() {
  const calls: BridgeCall[] = [];
  const state: { failWith: Error | null } = { failWith: null };
  const writer = {
    async set(path: string, data: Record<string, unknown>, opts: { merge: boolean }) {
      if (state.failWith) throw state.failWith;
      calls.push({ path, data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>, opts });
    },
  };
  return { writer, calls, state };
}
