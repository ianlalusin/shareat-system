/**
 * T-523 (migration 0238) - POS v2 schema: stands, terminals, table sessions, sales receipts, day close,
 * the event inbox, the per-store switch, the SC/PWD discount rows. Tests written FIRST (TESTER).
 * docs/tasks/523-pos-v2-schema.md rulings R1-R12 and its "Tests" list (1-11, 10a); bible rows 436-437
 * (purge class) and the planner's R13 ruling (6 Nov: a discount per item line, as v1; replaces row 437's `for_diner` and the per-diner receipt discounts).
 *
 * Raw SQL against the DATABASE, so what is proven is the schema, not a repo. Real Postgres via
 * TEST_DATABASE_URL (any `_test` database; no database name is assumed anywhere in this file).
 * Owner statements go through the admin connection (privileges bypassed, so a refusal there is the
 * TRIGGER or CHECK); app-role statements go through `asApp` (shareat_app + an org principal, always
 * rolled back).
 *
 * SQLSTATEs: 23505 unique - 23514 check (also what the spec calls "check_violation" for the
 * forward-only triggers) - 23503 FK - 42501 privilege / RLS - 23001 restrict_violation (the frozen and
 * append-only triggers).
 *
 * ERRCODES, as ruled by the planner (task spec "Rulings on the tester's questions", 1): a status transition a forward-only trigger refuses is
 * 23514 check_violation; a frozen column, a second write to a once-only column, an UPDATE/DELETE of an append-only row and a line inserted into a
 * paid or voided session are 23001 restrict_violation (as pay_rates_append_only does).
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { APP_ROLE } from '../../src/rls/registry';
import { asApp, menuFixture, refusal, sql, uid, type PgErr } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------------------------
// the fourteen new tables, and what each is allowed to UPDATE (R1-R13 "Column UPDATE grant")
// ---------------------------------------------------------------------------------------------
const UPDATABLE: Readonly<Record<string, readonly string[]>> = {
  pos_stores: ['mode', 'live_from', 'state_version', 'changed_by', 'changed_at'],
  pos_stands: ['status', 'updated_at'],
  pos_terminals: ['pairing_id', 'updated_at'],
  table_sessions: ['heads_cashier', 'heads_server', 'status', 'voided_by', 'voided_at_device', 'void_reason', 'voided_offline'],
  table_session_lines: ['kitchen_status', 'served_at_device', 'served_by'],
  pos_sales_receipts: ['day_close_id'],
  pos_sales_receipt_lines: [],
  pos_sales_receipt_payments: ['checked_by', 'checked_at'],
  pos_day_closes: [],
  pos_day_close_tenders: [],
  pos_events: ['resolved_by', 'resolved_at', 'resolution'],
  pos_discount_presets: ['name', 'value_type', 'value', 'status', 'updated_at'],
  table_session_line_discounts: ['status', 'removed_by', 'removed_at_device'],
  pos_sales_receipt_line_discounts: [],
};
const TABLES = Object.keys(UPDATABLE);
/** Tables whose rows are history: a trigger (ENABLE ALWAYS) guards them (R4-R10, R12). */
const GUARDED = [
  'table_sessions',
  'table_session_lines',
  'pos_sales_receipts',
  'pos_sales_receipt_lines',
  'pos_sales_receipt_payments',
  'pos_day_closes',
  'pos_day_close_tenders',
  'pos_events',
  'table_session_line_discounts',
  'pos_sales_receipt_line_discounts',
];
/** Person columns: each needs the single FK AND the (org_id, x) -> persons(org_id, id) twin. */
const PERSON_COLS: Readonly<Record<string, readonly string[]>> = {
  pos_stores: ['changed_by'],
  pos_stands: ['created_by'],
  pos_terminals: ['created_by'],
  table_sessions: ['opened_by', 'voided_by'],
  table_session_lines: ['served_by', 'added_by'],
  pos_sales_receipts: ['cashier_id'],
  pos_sales_receipt_payments: ['checked_by'],
  pos_day_closes: ['closed_by', 'approved_by'],
  pos_events: ['person_id', 'resolved_by'],
  pos_discount_presets: ['created_by'],
  table_session_line_discounts: ['applied_by', 'approved_by', 'removed_by'],
};
const STORE_TABLES = ['pos_stores', 'pos_stands', 'pos_terminals', 'table_sessions', 'table_session_lines', 'pos_sales_receipts', 'pos_day_closes', 'pos_events', 'pos_discount_presets', 'table_session_line_discounts'];

const code = (e: PgErr | undefined) => e?.code;
const expectCode = (e: PgErr | undefined, ...codes: string[]) => {
  expect(e, `statement was ACCEPTED, expected ${codes.join('/')}`).toBeDefined();
  expect(codes, `got ${e?.code}: ${e?.message}`).toContain(e!.code);
};

// ---------------------------------------------------------------------------------------------
// fixture helpers (raw SQL; every column the spec makes NOT NULL is passed, defaults only where stated)
// ---------------------------------------------------------------------------------------------
const T = () => new Date();
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const [r] = await sql<{ id: string }[]>`insert into ${sql(table)} ${sql(row as never)} returning id`;
  return r!.id;
}
async function upd(table: string, id: string, set: Record<string, unknown>): Promise<void> {
  await sql`update ${sql(table)} set ${sql(set as never)} where id = ${id}`;
}
/** UPDATE as the owner with replication-role triggers disabled: an ENABLE ALWAYS trigger must still fire. */
const updReplica = (table: string, id: string, set: Record<string, unknown>) =>
  refusal(() =>
    sql.begin(async (tx) => {
      await tx.unsafe(`set local session_replication_role = 'replica'`);
      await tx`update ${tx(table)} set ${tx(set as never)} where id = ${id}`;
    }),
  );
const count = async (table: string, where: string, ...args: string[]) =>
  (await sql.unsafe<{ n: number }[]>(`select count(*)::int n from ${table} where ${where}`, args))[0]!.n;

type W = Awaited<ReturnType<typeof world>>;

/** One organisation with two stores, two people, a pairing per store, a cash tender and a menu item: nothing from the new tables, so the statutory/legacy tests can run before 0238. */
async function baseWorld(hint: string) {
  const f = await menuFixture(`t523-${hint}`);
  const person2 = await ins('persons', { org_id: f.orgId, display_name: 'Manager' });
  const pairingId = await ins('pos_tablet_pairings', { org_id: f.orgId, store_id: f.storeId, label: 'Tablet 1', cookie_digest: uid('dg'), paired_by: f.personId });
  const pairing2Id = await ins('pos_tablet_pairings', { org_id: f.orgId, store_id: f.store2Id, label: 'Tablet B', cookie_digest: uid('dg'), paired_by: f.personId });
  const tenderId = await ins('tenders', { org_id: f.orgId, store_id: f.storeId, name: uid('Cash'), kind: 'cash' });
  return { ...f, person2, pairingId, pairing2Id, tenderId };
}

/** baseWorld plus a terminal and two stands. */
async function world(hint: string) {
  const b = await baseWorld(hint);
  const terminalId = await ins('pos_terminals', { org_id: b.orgId, store_id: b.storeId, terminal_no: 1, pairing_id: b.pairingId, created_by: b.personId, created_at: T() });
  const stand1 = await ins('pos_stands', { org_id: b.orgId, store_id: b.storeId, number: 1, created_by: b.personId, created_at: T() });
  const stand2 = await ins('pos_stands', { org_id: b.orgId, store_id: b.storeId, number: 2, created_by: b.personId, created_at: T() });
  return { ...b, terminalId, stand1, stand2 };
}
type B = Awaited<ReturnType<typeof baseWorld>>;

const sessionRow = (w: W, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  store_id: w.storeId,
  stand_id: w.stand1,
  mode: 'dine_in',
  heads_cashier: 4,
  opened_by: w.personId,
  opened_at_device: T(),
  opened_on_pairing_id: w.pairingId,
  opened_at: T(),
  ...o,
});
const session = (w: W, o: Record<string, unknown> = {}) => ins('table_sessions', sessionRow(w, o));
/** A take-out session needs no stand, so any number can be open at once. */
const takeOut = (w: W, o: Record<string, unknown> = {}) => session(w, { mode: 'take_out', stand_id: null, heads_cashier: 0, ...o });

const lineRow = (w: W, sessionId: string, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  store_id: w.storeId,
  session_id: sessionId,
  kind: 'item',
  menu_item_id: w.itemId,
  name: 'Pork belly',
  qty: 2,
  unit_price: '120.00',
  added_by: w.personId,
  added_on_pairing_id: w.pairingId,
  added_at_device: T(),
  added_at: T(),
  ...o,
});
const line = (w: W, sessionId: string, o: Record<string, unknown> = {}) => ins('table_session_lines', lineRow(w, sessionId, o));

let seqN = 0;
const receiptRow = (w: W, sessionId: string, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  store_id: w.storeId,
  terminal_id: w.terminalId,
  receipt_seq: ++seqN,
  table_session_id: sessionId,
  cashier_id: w.personId,
  issued_at_device: T(),
  received_at: T(),
  subtotal: '500.00',
  total: '500.00',
  device_total: '500.00',
  offline: false,
  ...o,
});
const receipt = (w: W, sessionId: string, o: Record<string, unknown> = {}) => ins('pos_sales_receipts', receiptRow(w, sessionId, o));
/** A take-out session and its sales receipt. */
async function sale(w: W, o: Record<string, unknown> = {}) {
  const sessionId = await takeOut(w);
  return { sessionId, receiptId: await receipt(w, sessionId, o) };
}

const rLineRow = (w: W, receiptId: string, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  receipt_id: receiptId,
  line_no: 1,
  kind: 'item',
  name: 'Pork belly',
  qty: 2,
  unit_price: '120.00',
  gross: '240.00',
  discount_total: '0.00',
  net: '240.00',
  ...o,
});
const paymentRow = (w: W, receiptId: string, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  receipt_id: receiptId,
  tender_id: w.tenderId,
  amount: '500.00',
  ...o,
});
const dayCloseRow = (w: W, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  store_id: w.storeId,
  terminal_id: w.terminalId,
  z_no: 1,
  business_date: '2026-12-07',
  window_start: later(-60),
  window_end: later(0),
  receipt_count: 1,
  gross_total: '500.00',
  closed_by: w.personId,
  approved_by: w.person2,
  closed_at: T(),
  ...o,
});
const dayClose = (w: W, o: Record<string, unknown> = {}) => ins('pos_day_closes', dayCloseRow(w, o));

let evSeq = 0;
const eventRow = (w: W, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  store_id: w.storeId,
  pairing_id: w.pairingId,
  seq: ++evSeq,
  kind: 'stand.opened',
  payload: sql.json({ stand: 1 }),
  occurred_at_device: T(),
  received_at: T(),
  status: 'applied',
  ...o,
});
const event = (w: W, o: Record<string, unknown> = {}) => ins('pos_events', eventRow(w, o));
const quarantined = (w: W, o: Record<string, unknown> = {}) => event(w, { status: 'quarantined', error: 'unknown stand', ...o });

let invN = 0;
const statutory = (w: B, o: Record<string, unknown> = {}) =>
  ins('statutory_discount_records', {
    org_id: w.orgId,
    store_id: w.storeId,
    business_date: '2026-12-07',
    invoice_number: `LIPA-01-${String(++invN).padStart(6, '0')}`,
    kind: 'senior',
    id_number: uid('OSCA'),
    holder_name: 'Lola Remedios',
    gross_amount: '300.00',
    discount_amount: '50.00',
    source: 'pos',
    recorded_by: w.personId,
    ...o,
  });
const presetRow = (w: B, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  store_id: w.storeId,
  name: uid('Promo'),
  value_type: 'percent',
  value: '10.00',
  created_by: w.personId,
  created_at: T(),
  ...o,
});
const preset = (w: B, o: Record<string, unknown> = {}) => ins('pos_discount_presets', presetRow(w, o));
/** A custom (manager-typed) discount on one session line: 1 unit, 10 percent. */
const lineDiscountRow = (w: W, sessionLineId: string, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  store_id: w.storeId,
  session_line_id: sessionLineId,
  kind: 'custom',
  value_type: 'percent',
  value: '10.00',
  qty: 1,
  applied_by: w.personId,
  applied_at_device: T(),
  ...o,
});
const lineDiscount = (w: W, sessionLineId: string, o: Record<string, unknown> = {}) => ins('table_session_line_discounts', lineDiscountRow(w, sessionLineId, o));
/** A discount on a frozen receipt line: custom, 1 unit, 24.00. A statutory one needs a statutory record. */
const rLineDiscountRow = (w: W, receiptLineId: string, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  receipt_line_id: receiptLineId,
  kind: 'custom',
  label: 'Manager discount',
  value_type: 'percent',
  value: '10.00',
  qty: 1,
  discount_amount: '24.00',
  ...o,
});
const rLineDiscount = (w: W, receiptLineId: string, o: Record<string, unknown> = {}) => ins('pos_sales_receipt_line_discounts', rLineDiscountRow(w, receiptLineId, o));

// ---------------------------------------------------------------------------------------------
// T-524 R11 (migration 0240): a sales receipt's children (lines, payments, line discounts) can be written ONLY by the transaction that wrote the
// receipt. So a case that adds children writes the receipt and them in ONE transaction (`saleTx`); each statement under test is an `attempt`
// (a savepoint), so an expected refusal does not end the transaction. Cases that only UPDATE / DELETE children run after the commit, as before.
// ---------------------------------------------------------------------------------------------
type Q = postgres.TransactionSql;
const insQ = async (tx: Q, table: string, row: Record<string, unknown>): Promise<string> =>
  ((await tx`insert into ${tx(table)} ${tx(row as never)} returning id`)[0] as { id: string }).id;
async function attempt(tx: Q, fn: (q: Q) => Promise<unknown>): Promise<PgErr | undefined> {
  try {
    await tx.savepoint(async (sp) => {
      await fn(sp as Q);
    });
    return undefined;
  } catch (e) {
    return e as PgErr;
  }
}
async function saleTx<T>(w: W, fn: (r: { tx: Q; sessionId: string; receiptId: string }) => Promise<T>, o: { sessionId?: string } = {}): Promise<T> {
  return (await sql.begin(async (tx) => {
    const sessionId = o.sessionId ?? (await insQ(tx, 'table_sessions', sessionRow(w, { mode: 'take_out', stand_id: null, heads_cashier: 0 })));
    const receiptId = await insQ(tx, 'pos_sales_receipts', receiptRow(w, sessionId));
    return fn({ tx, sessionId, receiptId });
  })) as T;
}
let dayN = 0;
const salesDayRow = (w: B, o: Record<string, unknown> = {}) => ({
  org_id: w.orgId,
  store_id: w.storeId,
  business_date: `2026-11-${String(1 + (++dayN % 28)).padStart(2, '0')}`,
  total_sales: '100.00',
  unli_sales: '100.00',
  ala_carte_sales: '0.00',
  created_by: w.personId,
  ...o,
});

/** A row in every one of the fourteen tables for this org (for the RLS test). */
async function fillAll(w: W) {
  await ins('pos_stores', { org_id: w.orgId, store_id: w.storeId, changed_by: w.personId, changed_at: T() });
  const sessionId = await takeOut(w);
  const lineId = await line(w, sessionId);
  const rLineId = await saleTx(
    w,
    async ({ tx, receiptId }) => {
      const id = await insQ(tx, 'pos_sales_receipt_lines', rLineRow(w, receiptId, { session_line_id: lineId }));
      await insQ(tx, 'pos_sales_receipt_payments', paymentRow(w, receiptId));
      await insQ(tx, 'pos_sales_receipt_line_discounts', rLineDiscountRow(w, id, {}));
      return id;
    },
    { sessionId },
  );
  const dc = await dayClose(w);
  await ins('pos_day_close_tenders', { org_id: w.orgId, day_close_id: dc, tender_id: w.tenderId, amount: '500.00' });
  await event(w);
  await preset(w);
  await lineDiscount(w, lineId);
  void rLineId; // its receipt-line discount was written with the receipt (0240)
}

// =================================================================================================
describe('catalog - the fourteen tables exist, forced RLS, same-org twins, no DELETE, ENABLE ALWAYS guards (tests 8, 9, 11)', () => {
  it.each(TABLES)('%s exists with RLS enabled + forced and a <t>_org_isolation policy', async (t) => {
    const rel = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class where oid = to_regclass(${`public.${t}`})`;
    expect(rel.length, `${t} does not exist`).toBe(1);
    expect(rel[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await sql<{ polname: string }[]>`select polname from pg_policy where polrelid = to_regclass(${`public.${t}`})`;
    expect(pol.map((p) => p.polname)).toContain(`${t}_org_isolation`);
  });

  it.each(TABLES)('%s: org_id -> organizations, and (org_id, store_id) same-org twin where it has a store', async (t) => {
    const fks = await sql<{ conname: string; cols: string[]; parent: string }[]>`
      select c.conname,
             array(select a.attname::text from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.o) cols,
             c.confrelid::regclass::text parent
        from pg_constraint c where c.contype = 'f' and c.conrelid = to_regclass(${`public.${t}`})`;
    expect(fks.length, `${t} does not exist`).toBeGreaterThan(0);
    expect(fks.some((f) => f.parent === 'organizations' && f.cols.join() === 'org_id')).toBe(true);
    if (STORE_TABLES.includes(t)) {
      expect(fks.some((f) => f.parent === 'stores' && f.cols.join() === 'org_id,store_id'), `${t}: no (org_id, store_id) -> stores twin`).toBe(true);
      expect(fks.some((f) => f.parent === 'stores' && f.cols.join() === 'store_id'), `${t}: no single store_id -> stores FK`).toBe(true);
    }
    for (const p of PERSON_COLS[t] ?? []) {
      expect(fks.some((f) => f.parent === 'persons' && f.cols.join() === p), `${t}.${p}: no single FK to persons`).toBe(true);
      expect(fks.some((f) => f.parent === 'persons' && f.cols.join() === `org_id,${p}`), `${t}.${p}: no same-org twin`).toBe(true);
    }
  });

  it.each(TABLES)('%s: shareat_app has SELECT + INSERT, never DELETE, and UPDATE only on the named columns (test 9)', async (t) => {
    const cols = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${t}`;
    expect(cols.length, `${t} does not exist`).toBeGreaterThan(0);
    const [p] = await sql<{ sel: boolean; ins: boolean; del: boolean; upd: boolean }[]>`
      select has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'SELECT') sel, has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'INSERT') ins,
             has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'DELETE') del, has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'UPDATE') upd`;
    expect(p).toEqual({ sel: true, ins: true, del: false, upd: false }); // table-level UPDATE is never granted
    const allowed = new Set(UPDATABLE[t]);
    for (const { column_name } of cols) {
      const [g] = await sql<{ ok: boolean }[]>`select has_column_privilege(${APP_ROLE}, ${`public.${t}`}, ${column_name}, 'UPDATE') ok`;
      expect(g!.ok, `${t}.${column_name} UPDATE grant`).toBe(allowed.has(column_name));
    }
    for (const a of allowed) expect(cols.map((c) => c.column_name), `${t}: named updatable column ${a} does not exist`).toContain(a);
  });

  it.each(GUARDED)('%s: has at least one guard trigger and every one is ENABLE ALWAYS', async (t) => {
    const trg = await sql<{ tgname: string; tgenabled: string }[]>`
      select tgname, tgenabled from pg_trigger where tgrelid = to_regclass(${`public.${t}`}) and not tgisinternal`;
    expect(trg.length, `${t}: no trigger (or no table)`).toBeGreaterThan(0);
    for (const x of trg) expect(x.tgenabled, `${t}.${x.tgname}`).toBe('A');
  });
});

// =================================================================================================
describe('R1 pos_stores - the per-store switch (test 10)', () => {
  it('mode defaults to off, live_from to NULL, state_version to 0', async () => {
    const w = await world('r1a');
    const id = await ins('pos_stores', { org_id: w.orgId, store_id: w.storeId, changed_by: w.personId, changed_at: T() });
    const [r] = await sql<{ mode: string; live_from: string | null; state_version: string }[]>`select mode, live_from::text, state_version::text from pos_stores where id = ${id}`;
    expect(r).toEqual({ mode: 'off', live_from: null, state_version: '0' });
  });

  it('live needs live_from, and live_from needs live (23514 both ways); test and off take no date', async () => {
    const w = await world('r1b');
    const base = { org_id: w.orgId, changed_by: w.personId, changed_at: T() };
    expectCode(await refusal(() => ins('pos_stores', { ...base, store_id: w.storeId, mode: 'live' })), '23514');
    expectCode(await refusal(() => ins('pos_stores', { ...base, store_id: w.storeId, mode: 'off', live_from: '2026-12-07' })), '23514');
    expectCode(await refusal(() => ins('pos_stores', { ...base, store_id: w.storeId, mode: 'test', live_from: '2026-12-07' })), '23514');
    expect(await refusal(() => ins('pos_stores', { ...base, store_id: w.storeId, mode: 'live', live_from: '2026-12-07' }))).toBeUndefined();
    expect(await refusal(() => ins('pos_stores', { ...base, store_id: w.store2Id, mode: 'test' }))).toBeUndefined();
  });

  it('mode outside off/test/live and a negative state_version are refused; one row per store (23505)', async () => {
    const w = await world('r1c');
    const base = { org_id: w.orgId, store_id: w.storeId, changed_by: w.personId, changed_at: T() };
    expectCode(await refusal(() => ins('pos_stores', { ...base, mode: 'beta' })), '23514');
    expectCode(await refusal(() => ins('pos_stores', { ...base, state_version: -1 })), '23514');
    await ins('pos_stores', base);
    expectCode(await refusal(() => ins('pos_stores', base)), '23505');
  });

  it('shareat_app may flip the mode and bump state_version (granted columns)', async () => {
    const w = await world('r1d');
    const id = await ins('pos_stores', { org_id: w.orgId, store_id: w.storeId, changed_by: w.personId, changed_at: T() });
    const r = await asApp(w.orgId, (tx) => tx`update pos_stores set mode = 'test', state_version = state_version + 1, changed_by = ${w.person2}, changed_at = now() where id = ${id} returning mode`);
    expect(r.err, r.err?.message).toBeUndefined();
    expect(r.value?.[0]?.mode).toBe('test');
  });
});

// =================================================================================================
describe('R2 pos_stands / R3 pos_terminals', () => {
  it('stand number 1..999, unique per store (retired numbers never reused), status active|retired', async () => {
    const w = await world('r2a');
    const base = { org_id: w.orgId, created_by: w.personId, created_at: T() };
    expectCode(await refusal(() => ins('pos_stands', { ...base, store_id: w.storeId, number: 0 })), '23514');
    expectCode(await refusal(() => ins('pos_stands', { ...base, store_id: w.storeId, number: 1000 })), '23514');
    expectCode(await refusal(() => ins('pos_stands', { ...base, store_id: w.storeId, number: 3, status: 'closed' })), '23514');
    expectCode(await refusal(() => ins('pos_stands', { ...base, store_id: w.storeId, number: 1 })), '23505'); // world() made 1
    await upd('pos_stands', w.stand1, { status: 'retired' });
    expectCode(await refusal(() => ins('pos_stands', { ...base, store_id: w.storeId, number: 1 })), '23505'); // a retired number stays taken
    expect(await refusal(() => ins('pos_stands', { ...base, store_id: w.store2Id, number: 1 }))).toBeUndefined(); // another store may use it
  });

  it('shareat_app may change a stand status, never its number (42501)', async () => {
    const w = await world('r2b');
    const ok = await asApp(w.orgId, (tx) => tx`update pos_stands set status = 'retired', updated_at = now() where id = ${w.stand2}`);
    expect(ok.err, ok.err?.message).toBeUndefined();
    const bad = await asApp(w.orgId, (tx) => tx`update pos_stands set number = 77 where id = ${w.stand2}`);
    expectCode(bad.err, '42501');
  });

  it('terminal_no 1..99, unique per store, one terminal per pairing (partial unique), NULL pairings may repeat', async () => {
    const w = await world('r3a');
    const base = { org_id: w.orgId, store_id: w.storeId, created_by: w.personId, created_at: T() };
    expectCode(await refusal(() => ins('pos_terminals', { ...base, terminal_no: 0 })), '23514');
    expectCode(await refusal(() => ins('pos_terminals', { ...base, terminal_no: 100 })), '23514');
    expectCode(await refusal(() => ins('pos_terminals', { ...base, terminal_no: 1 })), '23505'); // world() made 1
    expectCode(await refusal(() => ins('pos_terminals', { ...base, terminal_no: 2, pairing_id: w.pairingId })), '23505'); // pairing already acts as terminal 1
    expect(await refusal(() => ins('pos_terminals', { ...base, terminal_no: 2 }))).toBeUndefined();
    expect(await refusal(() => ins('pos_terminals', { ...base, terminal_no: 3 }))).toBeUndefined();
  });

  it('a tablet swap: the pairing moves to another terminal row, the receipt series stays on the terminal; shareat_app may update pairing_id only', async () => {
    const w = await world('r3b');
    const t2 = await ins('pos_terminals', { org_id: w.orgId, store_id: w.storeId, terminal_no: 2, created_by: w.personId, created_at: T() });
    const freed = await asApp(w.orgId, (tx) => tx`update pos_terminals set pairing_id = null, updated_at = now() where id = ${w.terminalId}`);
    expect(freed.err, freed.err?.message).toBeUndefined();
    const bad = await asApp(w.orgId, (tx) => tx`update pos_terminals set terminal_no = 9 where id = ${t2}`);
    expectCode(bad.err, '42501');
  });
});

// =================================================================================================
describe('R4 table_sessions (tests 1, 2)', () => {
  it('1: a second open session on the same stand is refused (23505); a different stand is fine', async () => {
    const w = await world('s1a');
    await session(w);
    expectCode(await refusal(() => session(w)), '23505');
    expect(await refusal(() => session(w, { stand_id: w.stand2 }))).toBeUndefined();
  });

  it('1: a paid session frees its stand, and so does a voided one', async () => {
    const w = await world('s1b');
    const a = await session(w);
    await upd('table_sessions', a, { status: 'paid' });
    const b = await session(w);
    await upd('table_sessions', b, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: 'wrong table' });
    expect(await refusal(() => session(w))).toBeUndefined();
    expect(await count('table_sessions', `stand_id = '${w.stand1}'`)).toBe(3);
  });

  it('1: take-out needs no stand (and any number may be open); dine-in must have a stand; take-out with a stand is refused', async () => {
    const w = await world('s1c');
    await takeOut(w);
    expect(await refusal(() => takeOut(w))).toBeUndefined();
    expectCode(await refusal(() => session(w, { stand_id: null })), '23514'); // dine_in, no stand
    expectCode(await refusal(() => takeOut(w, { stand_id: w.stand1 })), '23514'); // take_out, with a stand
  });

  it('heads are bounded: heads_cashier 0..200 (0 allowed for take-out), heads_server 1..200 or NULL; mode and status are closed lists', async () => {
    const w = await world('s1d');
    expectCode(await refusal(() => session(w, { heads_cashier: 201 })), '23514');
    expectCode(await refusal(() => session(w, { heads_cashier: -1 })), '23514');
    expectCode(await refusal(() => session(w, { heads_server: 0 })), '23514');
    expectCode(await refusal(() => session(w, { heads_server: 201 })), '23514');
    expectCode(await refusal(() => session(w, { mode: 'delivery' })), '23514');
    expectCode(await refusal(() => session(w, { status: 'pending' })), '23514');
    expect(await refusal(() => takeOut(w, { heads_cashier: 0 }))).toBeUndefined();
    expect(await refusal(() => session(w, { heads_server: 200 }))).toBeUndefined();
  });

  it('void shape: voided needs a person and a non-blank reason; voided_offline only on a voided session', async () => {
    const w = await world('s1e');
    const a = await session(w);
    expectCode(await refusal(() => upd('table_sessions', a, { status: 'voided' })), '23514');
    expectCode(await refusal(() => upd('table_sessions', a, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: '   ' })), '23514');
    expectCode(await refusal(() => upd('table_sessions', a, { voided_offline: true })), '23514');
    expectCode(await refusal(() => upd('table_sessions', a, { void_reason: 'stray', voided_by: w.person2 })), '23514'); // reason without voided status
    await upd('table_sessions', a, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: 'wrong table', voided_offline: true });
    const [r] = await sql<{ status: string; voided_offline: boolean }[]>`select status, voided_offline from table_sessions where id = ${a}`;
    expect(r).toEqual({ status: 'voided', voided_offline: true });
  });

  it('the device may supply the id (uuidv7 made offline); the default still applies when it does not', async () => {
    const w = await world('s1f');
    const mine = randomUUID();
    expect(await session(w, { id: mine })).toBe(mine);
    expect((await takeOut(w)).length).toBeGreaterThan(10);
  });

  it('2: forward-only - open -> paid is fine; paid -> open, voided -> paid and paid -> voided are refused (23514) and the row is unchanged', async () => {
    const w = await world('s2a');
    const a = await session(w);
    await upd('table_sessions', a, { status: 'paid' });
    expectCode(await refusal(() => upd('table_sessions', a, { status: 'open' })), '23514');
    expectCode(await refusal(() => upd('table_sessions', a, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: 'late void' })), '23514');
    expect((await sql<{ status: string }[]>`select status from table_sessions where id = ${a}`)[0]!.status).toBe('paid');

    const b = await session(w, { stand_id: w.stand2 });
    await upd('table_sessions', b, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: 'walked out' });
    expectCode(await refusal(() => upd('table_sessions', b, { status: 'paid' })), '23514');
    expectCode(await refusal(() => upd('table_sessions', b, { status: 'open', voided_by: null, void_reason: null, voided_at_device: null })), '23514');
    expect((await sql<{ status: string }[]>`select status from table_sessions where id = ${b}`)[0]!.status).toBe('voided');
  });

  it('2: forward-only also holds under session_replication_role = replica (ENABLE ALWAYS)', async () => {
    const w = await world('s2b');
    const a = await session(w);
    await upd('table_sessions', a, { status: 'paid' });
    expectCode(await updReplica('table_sessions', a, { status: 'open' }), '23514');
  });

  it('2: opened_by (and id, org_id, store_id, stand_id, mode, opened_*) cannot change, even for the owner', async () => {
    const w = await world('s2c');
    const a = await session(w);
    for (const set of [
      { opened_by: w.person2 },
      { stand_id: w.stand2 },
      { mode: 'take_out', stand_id: null },
      { store_id: w.store2Id }, // fails the FK or the trigger; either way not accepted
      { opened_at_device: later(5) },
      { opened_on_pairing_id: w.pairing2Id },
      { id: randomUUID() },
    ]) {
      expect(await refusal(() => upd('table_sessions', a, set)), `accepted ${JSON.stringify(Object.keys(set))}`).toBeDefined();
    }
    expectCode(await refusal(() => upd('table_sessions', a, { opened_by: w.person2 })), '23001');
    const [r] = await sql<{ opened_by: string }[]>`select opened_by from table_sessions where id = ${a}`;
    expect(r!.opened_by).toBe(w.personId);
  });

  it('2: the granted columns still move on an open session (heads corrected by the server count)', async () => {
    const w = await world('s2d');
    const a = await session(w);
    const r = await asApp(w.orgId, (tx) => tx`update table_sessions set heads_server = 5, heads_cashier = 6 where id = ${a} returning heads_server`);
    expect(r.err, r.err?.message).toBeUndefined();
    expect(r.value?.[0]?.heads_server).toBe(5);
  });
});

// =================================================================================================
describe('R5 table_session_lines (test 3)', () => {
  it('3: a line cannot be added to a paid or a voided session; an open one takes it', async () => {
    const w = await world('l3a');
    const open = await session(w);
    expect(await refusal(() => line(w, open))).toBeUndefined();
    const paid = await session(w, { stand_id: w.stand2 });
    await upd('table_sessions', paid, { status: 'paid' });
    expectCode(await refusal(() => line(w, paid)), '23001');
    const voided = await takeOut(w);
    await upd('table_sessions', voided, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: 'test' });
    expectCode(await refusal(() => line(w, voided)), '23001');
    expect(await count('table_session_lines', `session_id in ('${paid}','${voided}')`)).toBe(0);
  });

  it('3: a refill with a price is refused (23514); a free refill is accepted; package and item lines may carry a price', async () => {
    const w = await world('l3b');
    const s = await session(w);
    expectCode(await refusal(() => line(w, s, { kind: 'refill', unit_price: '10.00' })), '23514');
    expect(await refusal(() => line(w, s, { kind: 'refill', unit_price: '0.00' }))).toBeUndefined();
    expect(await refusal(() => line(w, s, { kind: 'package', unit_price: '399.00', qty: 4 }))).toBeUndefined();
  });

  it('line bounds: kind list, qty > 0, price >= 0, note <= 200, served needs its device time', async () => {
    const w = await world('l3c');
    const s = await session(w);
    expectCode(await refusal(() => line(w, s, { kind: 'drink' })), '23514');
    expectCode(await refusal(() => line(w, s, { qty: 0 })), '23514');
    expectCode(await refusal(() => line(w, s, { unit_price: '-1.00' })), '23514');
    expectCode(await refusal(() => line(w, s, { note: 'x'.repeat(201) })), '23514');
    expect(await refusal(() => line(w, s, { note: 'x'.repeat(200) }))).toBeUndefined();
    expectCode(await refusal(() => line(w, s, { kitchen_status: 'served' })), '23514'); // served without served_at_device
    expectCode(await refusal(() => line(w, s, { kitchen_status: 'ready' })), '23514');
    expectCode(await refusal(() => line(w, s, { served_at_device: T() })), '23514'); // a time while still queued
  });

  it('3: kitchen_status is forward-only - queued -> served|cancelled once; served -> queued, served -> cancelled, cancelled -> served refused (23514)', async () => {
    const w = await world('l3e');
    const s = await session(w);
    const served = await line(w, s);
    await upd('table_session_lines', served, { kitchen_status: 'served', served_at_device: T(), served_by: w.person2 });
    expectCode(await refusal(() => upd('table_session_lines', served, { kitchen_status: 'queued', served_at_device: null, served_by: null })), '23514');
    expectCode(await refusal(() => upd('table_session_lines', served, { kitchen_status: 'cancelled', served_at_device: null })), '23514');
    expectCode(await updReplica('table_session_lines', served, { kitchen_status: 'queued', served_at_device: null }), '23514');
    const cancelled = await line(w, s);
    await upd('table_session_lines', cancelled, { kitchen_status: 'cancelled' });
    expectCode(await refusal(() => upd('table_session_lines', cancelled, { kitchen_status: 'served', served_at_device: T() })), '23514');
    expectCode(await refusal(() => upd('table_session_lines', cancelled, { kitchen_status: 'queued' })), '23514');
    expect((await sql<{ kitchen_status: string }[]>`select kitchen_status from table_session_lines where id = ${served}`)[0]!.kitchen_status).toBe('served');
  });

  it('every other line column is immutable (qty, unit_price, name, kind), even for the owner', async () => {
    const w = await world('l3f');
    const s = await session(w);
    const l = await line(w, s);
    for (const set of [{ qty: 3 }, { unit_price: '1.00' }, { name: 'Renamed' }, { kind: 'package' }, { added_by: w.person2 }]) {
      expectCode(await refusal(() => upd('table_session_lines', l, set)), '23001');
    }
    const [r] = await sql<{ qty: number }[]>`select qty from table_session_lines where id = ${l}`;
    expect(r!.qty).toBe(2);
  });

  it('a line points at a session and a kitchen station of its own store (composite FKs, 23503)', async () => {
    const w = await world('l3g');
    const st = await ins('kitchen_stations', { org_id: w.orgId, store_id: w.storeId, name: uid('Grill'), created_by: w.personId });
    const other = await ins('kitchen_stations', { org_id: w.orgId, store_id: w.store2Id, name: uid('Grill'), created_by: w.personId });
    const s = await session(w);
    expect(await refusal(() => line(w, s, { kitchen_station_id: st }))).toBeUndefined();
    expectCode(await refusal(() => line(w, s, { kitchen_station_id: other })), '23503');
    expectCode(await refusal(() => line(w, s, { store_id: w.store2Id })), '23503'); // session belongs to store 1
  });

  it('a line may be added from a phone browser (added_on_pairing_id NULL) and its id may come from the device', async () => {
    const w = await world('l3h');
    const s = await session(w);
    const mine = randomUUID();
    expect(await line(w, s, { id: mine, added_on_pairing_id: null })).toBe(mine);
  });
});

// =================================================================================================
describe('R6 pos_sales_receipts (test 4)', () => {
  it('4: UNIQUE (terminal_id, receipt_seq) - the same number twice on one terminal is 23505; another terminal may reuse it', async () => {
    const w = await world('c4a');
    await sale(w, { receipt_seq: 41 });
    const s2 = await takeOut(w);
    expectCode(await refusal(() => receipt(w, s2, { receipt_seq: 41 })), '23505');
    const t2 = await ins('pos_terminals', { org_id: w.orgId, store_id: w.storeId, terminal_no: 2, created_by: w.personId, created_at: T() });
    expect(await refusal(() => receipt(w, s2, { receipt_seq: 41, terminal_id: t2 }))).toBeUndefined();
  });

  it('4: a second sales receipt for one session is refused (23505)', async () => {
    const w = await world('c4b');
    const { sessionId } = await sale(w);
    expectCode(await refusal(() => receipt(w, sessionId)), '23505');
  });

  it('4: UPDATE of total (and any other column) is refused even for the table owner and in replica mode (23001); the row is unchanged', async () => {
    const w = await world('c4c');
    const { receiptId } = await sale(w);
    expectCode(await refusal(() => upd('pos_sales_receipts', receiptId, { total: '1.00', subtotal: '1.00' })), '23001');
    expectCode(await updReplica('pos_sales_receipts', receiptId, { total: '1.00', subtotal: '1.00' }), '23001');
    expectCode(await refusal(() => upd('pos_sales_receipts', receiptId, { cashier_id: w.person2 })), '23001');
    expectCode(await refusal(() => upd('pos_sales_receipts', receiptId, { device_total: '9.00' })), '23001');
    expect((await sql<{ total: string }[]>`select total::text from pos_sales_receipts where id = ${receiptId}`)[0]!.total).toBe('500.00');
  });

  it('4: day_close_id goes NULL -> a value once, then refused (23001), including back to NULL or to another close', async () => {
    const w = await world('c4d');
    const { receiptId } = await sale(w);
    const z1 = await dayClose(w);
    const z2 = await dayClose(w, { z_no: 2, business_date: '2026-12-08' });
    await upd('pos_sales_receipts', receiptId, { day_close_id: z1 });
    expectCode(await refusal(() => upd('pos_sales_receipts', receiptId, { day_close_id: z2 })), '23001');
    expectCode(await refusal(() => upd('pos_sales_receipts', receiptId, { day_close_id: null })), '23001');
    expect((await sql<{ day_close_id: string }[]>`select day_close_id from pos_sales_receipts where id = ${receiptId}`)[0]!.day_close_id).toBe(z1);
  });

  it('4: shareat_app may set day_close_id (granted) and nothing else (42501)', async () => {
    const w = await world('c4e');
    const { receiptId } = await sale(w);
    const z = await dayClose(w);
    const ok = await asApp(w.orgId, (tx) => tx`update pos_sales_receipts set day_close_id = ${z} where id = ${receiptId} returning day_close_id`);
    expect(ok.err, ok.err?.message).toBeUndefined();
    const bad = await asApp(w.orgId, (tx) => tx`update pos_sales_receipts set total = 1 where id = ${receiptId}`);
    expectCode(bad.err, '42501');
  });

  it('money shape: total = subtotal - discount_total, discount_total >= 0 (default 0), total >= 0, receipt_seq > 0; a total/device_total mismatch is NOT a constraint', async () => {
    const w = await world('c4f');
    const s = () => takeOut(w);
    expectCode(await refusal(async () => receipt(w, await s(), { total: '499.00' })), '23514');
    expectCode(await refusal(async () => receipt(w, await s(), { discount_total: '-1.00', total: '501.00' })), '23514');
    expectCode(await refusal(async () => receipt(w, await s(), { subtotal: '-5.00', total: '-5.00', device_total: '0.00' })), '23514');
    expectCode(await refusal(async () => receipt(w, await s(), { receipt_seq: 0 })), '23514');
    const id = await receipt(w, await s(), { subtotal: '600.00', discount_total: '100.00', total: '500.00' });
    expect(id).toBeDefined();
    const mismatch = await receipt(w, await s(), { device_total: '480.00' }); // the server's figure wins; T-524 raises a finding
    expect((await sql<{ dt: string }[]>`select discount_total::text dt from pos_sales_receipts where id = ${mismatch}`)[0]!.dt).toBe('0.00');
  });

  it('a receipt names a terminal and a session of its own store (composite FKs, 23503)', async () => {
    const w = await world('c4g');
    const t2 = await ins('pos_terminals', { org_id: w.orgId, store_id: w.store2Id, terminal_no: 1, created_by: w.personId, created_at: T() });
    expectCode(await refusal(async () => receipt(w, await takeOut(w), { terminal_id: t2 })), '23503');
    const otherStoreSession = await session(w, { store_id: w.store2Id, stand_id: null, mode: 'take_out', heads_cashier: 0, opened_on_pairing_id: w.pairing2Id });
    expectCode(await refusal(() => receipt(w, otherStoreSession)), '23503');
  });
});

// =================================================================================================
describe('R7 pos_sales_receipt_lines - append-only', () => {
  it('gross = qty * unit_price, net = gross - discount_total, discount_total within gross (23514); a refill appears at amount 0; (receipt_id, line_no) is unique (23505)', async () => {
    const w = await world('rl1');
    await saleTx(w, async ({ tx, receiptId }) => {
      const ln = (o: Record<string, unknown> = {}) => (q: Q) => insQ(q, 'pos_sales_receipt_lines', rLineRow(w, receiptId, o));
      expectCode(await attempt(tx, ln({ gross: '239.00', net: '239.00' })), '23514');
      expect(await attempt(tx, ln())).toBeUndefined();
      expectCode(await attempt(tx, ln()), '23505');
      expect(await attempt(tx, ln({ line_no: 2, kind: 'refill', qty: 3, unit_price: '0.00', gross: '0.00', net: '0.00' }))).toBeUndefined();
    });
  });

  it('UPDATE and DELETE are refused even for the owner and in replica mode (23001)', async () => {
    const w = await world('rl2');
    const id = await saleTx(w, ({ tx, receiptId }) => insQ(tx, 'pos_sales_receipt_lines', rLineRow(w, receiptId)));
    expectCode(await refusal(() => upd('pos_sales_receipt_lines', id, { name: 'Edited' })), '23001');
    expectCode(await updReplica('pos_sales_receipt_lines', id, { name: 'Edited' }), '23001');
    expectCode(await refusal(() => sql`delete from pos_sales_receipt_lines where id = ${id}`), '23001');
    expect(await count('pos_sales_receipt_lines', `id = '${id}'`)).toBe(1);
  });

  it('session_line_id is optional and, when given, must be a real session line (23503)', async () => {
    const w = await world('rl3');
    await saleTx(w, async ({ tx, receiptId }) => {
      expectCode(await attempt(tx, (q) => insQ(q, 'pos_sales_receipt_lines', rLineRow(w, receiptId, { session_line_id: randomUUID() }))), '23503');
    });
  });
});

// =================================================================================================
describe('R8 pos_sales_receipt_payments (test 5)', () => {
  it('5: to_check without a reference is refused (23514); with a 4..40 character reference it is accepted', async () => {
    const w = await world('p5a');
    await saleTx(w, async ({ tx, receiptId }) => {
      const pay = (o: Record<string, unknown> = {}) => (q: Q) => insQ(q, 'pos_sales_receipt_payments', paymentRow(w, receiptId, o));
      expectCode(await attempt(tx, pay({ to_check: true })), '23514');
      expectCode(await attempt(tx, pay({ to_check: true, reference_no: 'abc' })), '23514');
      expectCode(await attempt(tx, pay({ reference_no: 'x'.repeat(41) })), '23514');
      expect(await attempt(tx, pay({ to_check: true, reference_no: 'GC1234567' }))).toBeUndefined();
      expect(await attempt(tx, pay({ amount: '10.00' }))).toBeUndefined(); // no reference, not to_check
    });
  });

  it('amount > 0, change_given >= 0, checked_* come as a pair and only on a to_check payment (23514)', async () => {
    const w = await world('p5b');
    await saleTx(w, async ({ tx, receiptId }) => {
      const pay = (o: Record<string, unknown> = {}) => (q: Q) => insQ(q, 'pos_sales_receipt_payments', paymentRow(w, receiptId, o));
      expectCode(await attempt(tx, pay({ amount: '0.00' })), '23514');
      expectCode(await attempt(tx, pay({ change_given: '-1.00' })), '23514');
      expectCode(await attempt(tx, pay({ to_check: true, reference_no: 'GC1234567', checked_at: T() })), '23514'); // time without person
      expectCode(await attempt(tx, pay({ checked_by: w.person2, checked_at: T() })), '23514'); // not a to_check payment
      expect(await attempt(tx, pay({ change_given: '20.00' }))).toBeUndefined();
    });
  });

  it('5: checked_by / checked_at are set once (NULL -> value), then refused (23001); amount is frozen', async () => {
    const w = await world('p5c');
    const p = await saleTx(w, ({ tx, receiptId }) => insQ(tx, 'pos_sales_receipt_payments', paymentRow(w, receiptId, { to_check: true, reference_no: 'GC1234567' })));
    expectCode(await refusal(() => upd('pos_sales_receipt_payments', p, { amount: '1.00' })), '23001');
    expectCode(await refusal(() => upd('pos_sales_receipt_payments', p, { reference_no: 'EDITED12345' })), '23001');
    expectCode(await refusal(() => upd('pos_sales_receipt_payments', p, { to_check: false })), '23001');
    await upd('pos_sales_receipt_payments', p, { checked_by: w.person2, checked_at: T() });
    expectCode(await refusal(() => upd('pos_sales_receipt_payments', p, { checked_by: w.personId })), '23001');
    expectCode(await refusal(() => upd('pos_sales_receipt_payments', p, { checked_at: later(9) })), '23001');
    expectCode(await updReplica('pos_sales_receipt_payments', p, { checked_by: w.personId }), '23001');
    expect((await sql<{ checked_by: string }[]>`select checked_by from pos_sales_receipt_payments where id = ${p}`)[0]!.checked_by).toBe(w.person2);
  });

  it('shareat_app may set the check (granted) and may not change the amount (42501)', async () => {
    const w = await world('p5d');
    const p = await saleTx(w, ({ tx, receiptId }) => insQ(tx, 'pos_sales_receipt_payments', paymentRow(w, receiptId, { to_check: true, reference_no: 'GC1234567' })));
    const ok = await asApp(w.orgId, (tx) => tx`update pos_sales_receipt_payments set checked_by = ${w.person2}, checked_at = now() where id = ${p} returning id`);
    expect(ok.err, ok.err?.message).toBeUndefined();
    expectCode((await asApp(w.orgId, (tx) => tx`update pos_sales_receipt_payments set amount = 1 where id = ${p}`)).err, '42501');
  });
});

// =================================================================================================
describe('R9 pos_day_closes + pos_day_close_tenders', () => {
  it('(terminal_id, z_no) and (store_id, business_date, terminal_id) are unique (23505)', async () => {
    const w = await world('d9a');
    await dayClose(w);
    expectCode(await refusal(() => dayClose(w, { business_date: '2026-12-08' })), '23505'); // same z_no on the terminal
    expectCode(await refusal(() => dayClose(w, { z_no: 2 })), '23505'); // same business date on the terminal
    expect(await refusal(() => dayClose(w, { z_no: 2, business_date: '2026-12-08' }))).toBeUndefined();
  });

  it('bounds: z_no > 0, window_end > window_start, receipt_count >= 0, gross_total >= 0 (23514)', async () => {
    const w = await world('d9b');
    expectCode(await refusal(() => dayClose(w, { z_no: 0 })), '23514');
    expectCode(await refusal(() => dayClose(w, { window_start: later(10), window_end: later(0) })), '23514');
    const t = later(0);
    expectCode(await refusal(() => dayClose(w, { window_start: t, window_end: t })), '23514');
    expectCode(await refusal(() => dayClose(w, { receipt_count: -1 })), '23514');
    expectCode(await refusal(() => dayClose(w, { gross_total: '-0.01' })), '23514');
  });

  it('a day close and its tender totals are append-only: UPDATE and DELETE refused (23001); (day_close_id, tender_id) unique (23505)', async () => {
    const w = await world('d9c');
    const z = await dayClose(w);
    const t = await ins('pos_day_close_tenders', { org_id: w.orgId, day_close_id: z, tender_id: w.tenderId, amount: '500.00' });
    expectCode(await refusal(() => ins('pos_day_close_tenders', { org_id: w.orgId, day_close_id: z, tender_id: w.tenderId, amount: '1.00' })), '23505');
    expectCode(await refusal(() => upd('pos_day_closes', z, { gross_total: '1.00' })), '23001');
    expectCode(await updReplica('pos_day_closes', z, { gross_total: '1.00' }), '23001');
    expectCode(await refusal(() => sql`delete from pos_day_closes where id = ${z}`), '23001');
    expectCode(await refusal(() => upd('pos_day_close_tenders', t, { amount: '1.00' })), '23001');
    expectCode(await refusal(() => sql`delete from pos_day_close_tenders where id = ${t}`), '23001');
    expect((await sql<{ g: string }[]>`select gross_total::text g from pos_day_closes where id = ${z}`)[0]!.g).toBe('500.00');
  });

  it('a day close names a terminal of its own store (23503)', async () => {
    const w = await world('d9d');
    const t2 = await ins('pos_terminals', { org_id: w.orgId, store_id: w.store2Id, terminal_no: 1, created_by: w.personId, created_at: T() });
    expectCode(await refusal(() => dayClose(w, { terminal_id: t2 })), '23503');
  });
});

// =================================================================================================
describe('R10 pos_events - the outbox inbox (test 6)', () => {
  it('6: the same (pairing_id, seq) twice is 23505 (the domain reads it as "already applied"); another pairing may reuse the number', async () => {
    const w = await world('e6a');
    await event(w, { seq: 7 });
    expectCode(await refusal(() => event(w, { seq: 7 })), '23505');
    expect(await refusal(() => event(w, { seq: 7, store_id: w.store2Id, pairing_id: w.pairing2Id }))).toBeUndefined();
  });

  it('kind shape ^[a-z]+(\\.[a-z_]+)+$, payload is a JSON object, seq > 0, status applied|quarantined', async () => {
    const w = await world('e6b');
    for (const kind of ['stand', 'Stand.opened', 'stand.Opened', 'stand opened', 'stand.']) expectCode(await refusal(() => event(w, { kind })), '23514');
    for (const kind of ['stand.opened', 'lines.added', 'sale.completed', 'xslip.printed', 'day.close_requested']) expect(await refusal(() => event(w, { kind })), kind).toBeUndefined();
    expectCode(await refusal(() => event(w, { payload: sql.json([1, 2]) })), '23514');
    expectCode(await refusal(() => event(w, { payload: sql.json('text') })), '23514');
    expectCode(await refusal(() => event(w, { seq: 0 })), '23514');
    expectCode(await refusal(() => event(w, { status: 'pending' })), '23514');
  });

  it('6: a quarantined row needs an error, and an applied row cannot carry one (23514)', async () => {
    const w = await world('e6c');
    expectCode(await refusal(() => event(w, { status: 'quarantined' })), '23514');
    expectCode(await refusal(() => event(w, { status: 'applied', error: 'oops' })), '23514');
    expect(await refusal(() => quarantined(w))).toBeUndefined();
  });

  it('6: resolution only on a quarantined row (23514) and only once (23001); partial or unknown resolutions are refused', async () => {
    const w = await world('e6d');
    const applied = await event(w);
    expectCode(await refusal(() => upd('pos_events', applied, { resolved_by: w.person2, resolved_at: T(), resolution: 'discarded' })), '23514');

    const q = await quarantined(w);
    expectCode(await refusal(() => upd('pos_events', q, { resolved_at: T() })), '23514'); // time alone
    expectCode(await refusal(() => upd('pos_events', q, { resolved_by: w.person2, resolved_at: T() })), '23514'); // no resolution
    expectCode(await refusal(() => upd('pos_events', q, { resolved_by: w.person2, resolved_at: T(), resolution: 'ignored' })), '23514');
    await upd('pos_events', q, { resolved_by: w.person2, resolved_at: T(), resolution: 'replayed' });
    expectCode(await refusal(() => upd('pos_events', q, { resolution: 'discarded' })), '23001');
    expectCode(await refusal(() => upd('pos_events', q, { resolved_by: w.personId })), '23001');
    expectCode(await updReplica('pos_events', q, { resolution: 'discarded' }), '23001');
    expect((await sql<{ resolution: string }[]>`select resolution from pos_events where id = ${q}`)[0]!.resolution).toBe('replayed');
  });

  it('every other column is frozen, even for the owner: payload, error, status, seq, kind (23001)', async () => {
    const w = await world('e6e');
    const q = await quarantined(w);
    for (const set of [{ payload: sql.json({ a: 2 }) }, { error: 'rewritten' }, { status: 'applied', error: null }, { seq: 99 }, { kind: 'lines.added' }]) {
      expectCode(await refusal(() => upd('pos_events', q, set)), '23001');
    }
  });

  it('the manager list is indexed: a partial index on (store_id, status) WHERE status = quarantined', async () => {
    const idx = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'pos_events'`;
    expect(idx.length, 'pos_events does not exist').toBeGreaterThan(0);
    expect(idx.some((i) => /\(store_id, status\)/.test(i.indexdef) && /quarantined/.test(i.indexdef)), idx.map((i) => i.indexdef).join('\n')).toBe(true);
  });

  it('shareat_app may resolve (granted columns) and may not touch the payload (42501)', async () => {
    const w = await world('e6f');
    const q = await quarantined(w);
    const ok = await asApp(w.orgId, (tx) => tx`update pos_events set resolved_by = ${w.person2}, resolved_at = now(), resolution = 'discarded' where id = ${q} returning id`);
    expect(ok.err, ok.err?.message).toBeUndefined();
    expectCode((await asApp(w.orgId, (tx) => tx`update pos_events set payload = '{}'::jsonb where id = ${q}`)).err, '42501');
  });
});

// =================================================================================================
describe('R11 sales_days learns its third source (test 7)', () => {
  it('7: source pos_receipts with a day close is accepted; the check list is now legacy_typed | pos_v1_day_feed | pos_receipts', async () => {
    const w = await world('sd7a');
    const z = await dayClose(w);
    expect(await refusal(() => ins('sales_days', salesDayRow(w, { source: 'pos_receipts', pos_day_close_id: z })))).toBeUndefined();
    const [d] = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) def from pg_constraint where conname = 'sales_days_source_check' and conrelid = 'public.sales_days'::regclass`;
    for (const v of ['legacy_typed', 'pos_v1_day_feed', 'pos_receipts']) expect(d!.def).toContain(v);
  });

  it('7: source pos_receipts WITHOUT pos_day_close_id is refused by the new CHECK (23514, not the old source list), and the reverse is refused too', async () => {
    const w = await world('sd7b');
    await dayClose(w); // the world is only complete once the new tables exist
    const missing = await refusal(() => ins('sales_days', salesDayRow(w, { source: 'pos_receipts' })));
    expectCode(missing, '23514');
    expect((missing as PgErr & { constraint_name?: string }).constraint_name, 'refused by the OLD source list, not the new pairing CHECK').not.toBe('sales_days_source_check');
    const z = await dayClose(w, { z_no: 2, business_date: '2026-12-08' });
    expectCode(await refusal(() => ins('sales_days', salesDayRow(w, { source: 'legacy_typed', pos_day_close_id: z }))), '23514');
  });

  it('7: existing legacy rows still satisfy every CHECK (the column defaults are untouched), and pos_day_close_id is NULL for them', async () => {
    const w = await baseWorld('sd7c');
    const id = await ins('sales_days', salesDayRow(w));
    const [r] = await sql<{ source: string; pos_day_close_id: string | null }[]>`select source, pos_day_close_id from sales_days where id = ${id}`;
    expect(r).toEqual({ source: 'legacy_typed', pos_day_close_id: null });
  });

  it('7: a pos_v1_day_feed row (linked store, derivation flag on) still satisfies every CHECK after 0238, has no day close, and cannot carry one', async () => {
    const w = await baseWorld('sd7e');
    const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${w.orgId}, ${w.storeId}, 'Walk-in', true) returning id`;
    await sql`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
      values (${w.orgId}, ${w.storeId}, ${uid('pos')}, 'POS store', ${ch!.id}, 'vat_inclusive', ${w.personId})`;
    const hashOf = (date: string) => 'b'.repeat(63) + date.slice(-1);
    const feed = async (date: string) =>
      (await sql<{ id: string }[]>`
        insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_at, fetched_by)
        values (${w.orgId}, ${w.storeId}, ${date}, 'sales', 'import', ${randomUUID()}, 'pos-abc', '{"found":true}', '{"found":true}'::jsonb, ${hashOf(date)}, now(), ${w.personId}) returning id`)[0]!.id;
    const feedDay = (date: string, extra: Record<string, unknown> = {}) =>
      sql.begin(async (t) => {
        await t`select set_config('app.sales_day_derivation', 'on', true)`;
        await t`insert into sales_days ${t({ ...salesDayRow(w, { business_date: date }), source: 'pos_v1_day_feed', pos_v1_day_feed_id: await feed(date), pos_sourced: true, pos_sourced_at: new Date(), refunds: '10.00', ...extra } as never)} returning id`;
      });
    expect(await refusal(() => feedDay('2027-02-01'))).toBeUndefined();
    const [r] = await sql<{ source: string; pos_day_close_id: string | null }[]>`select source, pos_day_close_id from sales_days where store_id = ${w.storeId} and source = 'pos_v1_day_feed'`;
    expect(r).toEqual({ source: 'pos_v1_day_feed', pos_day_close_id: null });
    const z = await dayClose(await world('sd7e-z'));
    const carrying = await refusal(() => feedDay('2027-02-02', { pos_day_close_id: z }));
    expect(carrying, 'a feed day carrying a day close was ACCEPTED').toBeDefined();
    expect(carrying!.code, carrying!.message).toBe('23514'); // the new link CHECK (a cross-org twin would also refuse, as 23503, but the CHECK runs first)
  });

  it('7: the 0185 figure-lock and 0188 verify triggers on sales_days are unchanged: same two names, same definitions, still enabled', async () => {
    const trg = await sql<{ tgname: string; tgenabled: string; def: string }[]>`
      select tgname, tgenabled, pg_get_triggerdef(oid) def from pg_trigger where tgrelid = 'public.sales_days'::regclass and not tgisinternal order by tgname`;
    expect(trg.map((t) => t.tgname)).toEqual(['sales_days_figure_lock', 'sales_days_verify_requires_submitted']);
    expect(trg.map((t) => t.tgenabled)).toEqual(['O', 'O']);
    expect(trg[0]!.def).toBe('CREATE TRIGGER sales_days_figure_lock BEFORE INSERT OR UPDATE ON public.sales_days FOR EACH ROW EXECUTE FUNCTION sales_days_check_figure_lock()');
    expect(trg[1]!.def).toContain('BEFORE UPDATE ON public.sales_days');
    expect(trg[1]!.def).toContain('sales_days_check_verify_requires_submitted()');
    // the functions behind them name no source other than the feed (0238 added 'pos_receipts' to the CHECK, not to the lock)
    const fn = await sql<{ src: string }[]>`select prosrc src from pg_proc where proname = 'sales_days_check_figure_lock'`;
    expect(fn[0]!.src).toContain("NEW.source <> 'pos_v1_day_feed'");
    expect(fn[0]!.src).not.toContain('pos_receipts');
  });

  it('7: pos_day_close_id names a day close of the same organisation (same-org twin, 23503)', async () => {
    const w = await world('sd7d');
    const other = await world('sd7d-other');
    const foreign = await dayClose(other);
    expectCode(await refusal(() => ins('sales_days', salesDayRow(w, { source: 'pos_receipts', pos_day_close_id: foreign }))), '23503');
  });
});

// =================================================================================================
describe('R12 + test 10a - senior/PWD: one live statutory record per CARD per bill (statutory_discount_records index)', () => {
  it('10a: the live-invoice unique index is now keyed on id_number as well (catalog)', async () => {
    const [i] = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'statutory_discount_records_live_invoice_key'`;
    expect(i, 'index missing').toBeDefined();
    expect(i!.indexdef).toMatch(/id_number/);
    expect(i!.indexdef).toMatch(/voided_at IS NULL/i);
    expect(i!.indexdef).toMatch(/UNIQUE/i);
  });

  it('10a: two seniors on one invoice (different id numbers) are accepted - two rows', async () => {
    const w = await baseWorld('x10a');
    const invoice = 'LIPA-01-000900';
    await statutory(w, { invoice_number: invoice, id_number: 'OSCA-1001' });
    expect(await refusal(() => statutory(w, { invoice_number: invoice, id_number: 'OSCA-1002' }))).toBeUndefined();
    expect(await count('statutory_discount_records', `invoice_number = '${invoice}' and org_id = '${w.orgId}'`)).toBe(2);
  });

  it('10a: the SAME id number twice on one live invoice is refused (23505) - a PWD who is also a senior claims one 20%; a voided row frees the card; another invoice is fine', async () => {
    const w = await baseWorld('x10b');
    const invoice = 'LIPA-01-000901';
    const first = await statutory(w, { invoice_number: invoice, id_number: 'PWD-77', kind: 'pwd' });
    expectCode(await refusal(() => statutory(w, { invoice_number: invoice, id_number: 'PWD-77', kind: 'senior' })), '23505');
    expect(await refusal(() => statutory(w, { invoice_number: invoice, id_number: 'PWD-78' })), 'a different card on the same invoice').toBeUndefined();
    expect(await refusal(() => statutory(w, { invoice_number: 'LIPA-01-000902', id_number: 'PWD-77' }))).toBeUndefined();
    await upd('statutory_discount_records', first, { voided_by: w.person2, voided_at: T(), void_reason: 'wrong card' });
    expect(await refusal(() => statutory(w, { invoice_number: invoice, id_number: 'PWD-77' }))).toBeUndefined();
  });

  it('10a: existing manual (typed) rows still satisfy the new index - one live row per card per invoice', async () => {
    const w = await baseWorld('x10c');
    await statutory(w, { source: 'manual', invoice_number: 'T-1', id_number: 'OSCA-1' });
    expect(await refusal(() => statutory(w, { source: 'manual', invoice_number: 'T-2', id_number: 'OSCA-2' }))).toBeUndefined();
    expectCode(await refusal(() => statutory(w, { source: 'manual', invoice_number: 'T-1', id_number: 'OSCA-1' })), '23505');
    expect(await refusal(() => statutory(w, { source: 'manual', invoice_number: 'T-1', id_number: 'OSCA-3' }))).toBeUndefined();
  });

  it('10a: two seniors on ONE bill: two statutory records, and two receipt-line discounts that share one record per diner (no UNIQUE on statutory_record_id)', async () => {
    const w = await world('x10d');
    const a = await statutory(w, { invoice_number: 'LIPA-01-000903', id_number: 'OSCA-2001' });
    const b = await statutory(w, { invoice_number: 'LIPA-01-000903', id_number: 'OSCA-2002' });
    const sen = (rec: string, o: Record<string, unknown> = {}) => ({ kind: 'senior', label: 'Senior citizen', diner_no: 1, statutory_record_id: rec, vat_removed: '12.86', discount_amount: '21.43', ...o });
    await saleTx(w, async ({ tx, receiptId }) => {
      const l1 = await insQ(tx, 'pos_sales_receipt_lines', rLineRow(w, receiptId, { line_no: 1 }));
      const l2 = await insQ(tx, 'pos_sales_receipt_lines', rLineRow(w, receiptId, { line_no: 2, name: 'Pork belly 2' }));
      const disc = (line: string, o: Record<string, unknown>) => (q: Q) => insQ(q, 'pos_sales_receipt_line_discounts', rLineDiscountRow(w, line, o));
      expect(await attempt(tx, disc(l1, sen(a)))).toBeUndefined();
      expect(await attempt(tx, disc(l2, sen(a)))).toBeUndefined(); // the same diner's record on a second line
      expect(await attempt(tx, disc(l1, sen(b, { diner_no: 2 })))).toBeUndefined();
      const n = (await tx`select count(*)::int n from pos_sales_receipt_line_discounts where receipt_line_id in (${l1}, ${l2})`)[0] as { n: number };
      expect(n.n).toBe(3);
    });
  });
});

// =================================================================================================
describe('R13 per-line discounts - pos_discount_presets, table_session_line_discounts, pos_sales_receipt_line_discounts', () => {
  it('presets: name 1..40 trimmed, percent <= 100, value > 0, status list; one ACTIVE name per store (case-insensitive), a retired name frees it', async () => {
    const w = await world('r13a');
    expectCode(await refusal(() => preset(w, { name: '   ' })), '23514');
    expectCode(await refusal(() => preset(w, { name: 'x'.repeat(41) })), '23514');
    expectCode(await refusal(() => preset(w, { value: '0.00' })), '23514');
    expectCode(await refusal(() => preset(w, { value: '100.01' })), '23514');
    expectCode(await refusal(() => preset(w, { value_type: 'amount' })), '23514');
    expectCode(await refusal(() => preset(w, { status: 'gone' })), '23514');
    expect(await refusal(() => preset(w, { value: '100.00' }))).toBeUndefined();
    expect(await refusal(() => preset(w, { value_type: 'fixed', value: '250.00' }))).toBeUndefined(); // a fixed amount may exceed 100
    const id = await preset(w, { name: 'Employee Meal' });
    expectCode(await refusal(() => preset(w, { name: 'employee meal' })), '23505');
    expect(await refusal(() => preset(w, { name: 'employee meal', store_id: w.store2Id }))).toBeUndefined(); // another store
    await upd('pos_discount_presets', id, { status: 'retired' });
    expect(await refusal(() => preset(w, { name: 'EMPLOYEE MEAL' }))).toBeUndefined();
  });

  it('shareat_app may edit a preset (granted columns) and never its store (42501); no DELETE', async () => {
    const w = await world('r13b');
    const id = await preset(w);
    const ok = await asApp(w.orgId, (tx) => tx`update pos_discount_presets set name = 'Renamed', value = 15, status = 'retired', updated_at = now() where id = ${id} returning id`);
    expect(ok.err, ok.err?.message).toBeUndefined();
    expectCode((await asApp(w.orgId, (tx) => tx`update pos_discount_presets set store_id = ${w.store2Id} where id = ${id}`)).err, '42501');
  });

  it('a discount covering 1 of 3 units of a line is accepted; qty 0 and a negative qty are refused (23514)', async () => {
    const w = await world('r13c');
    const s = await session(w);
    const l = await line(w, s, { qty: 3 });
    expect(await refusal(() => lineDiscount(w, l, { qty: 1 }))).toBeUndefined();
    expectCode(await refusal(() => lineDiscount(w, l, { qty: 0 })), '23514');
    expectCode(await refusal(() => lineDiscount(w, l, { qty: -1 })), '23514');
    expectCode(await refusal(() => lineDiscount(w, l, { value: '0.00' })), '23514');
    expectCode(await refusal(() => lineDiscount(w, l, { value: '101.00' })), '23514'); // percent over 100
    expect(await refusal(() => lineDiscount(w, l, { value_type: 'fixed', value: '101.00' }))).toBeUndefined();
    expectCode(await refusal(() => lineDiscount(w, l, { kind: 'coupon' })), '23514');
  });

  it('kind preset needs a preset_id (and only preset takes one); senior and pwd need a diner_no (and only they take one)', async () => {
    const w = await world('r13d');
    const s = await session(w);
    const l = await line(w, s);
    const p = await preset(w);
    expectCode(await refusal(() => lineDiscount(w, l, { kind: 'preset' })), '23514');
    expectCode(await refusal(() => lineDiscount(w, l, { kind: 'custom', preset_id: p })), '23514');
    expect(await refusal(() => lineDiscount(w, l, { kind: 'preset', preset_id: p }))).toBeUndefined();
    expectCode(await refusal(() => lineDiscount(w, l, { kind: 'senior' })), '23514');
    expectCode(await refusal(() => lineDiscount(w, l, { kind: 'pwd' })), '23514');
    expectCode(await refusal(() => lineDiscount(w, l, { kind: 'custom', diner_no: 1 })), '23514');
    expectCode(await refusal(() => lineDiscount(w, l, { kind: 'senior', diner_no: 0 })), '23514');
    expectCode(await refusal(() => lineDiscount(w, l, { kind: 'senior', diner_no: 201 })), '23514');
    expect(await refusal(() => lineDiscount(w, l, { kind: 'senior', diner_no: 1, value: '20.00', approved_by: w.person2 }))).toBeUndefined();
  });

  it('the preset and the line must be of the discount\'s own store (composite FKs, 23503)', async () => {
    const w = await world('r13e');
    const s = await session(w);
    const l = await line(w, s);
    const otherStorePreset = await preset(w, { store_id: w.store2Id });
    expectCode(await refusal(() => lineDiscount(w, l, { kind: 'preset', preset_id: otherStorePreset })), '23503');
    expectCode(await refusal(() => lineDiscount(w, l, { store_id: w.store2Id })), '23503');
  });

  it('removal: active -> removed once (needs removed_by); removed -> active is refused (23514); every other column is frozen (23001)', async () => {
    const w = await world('r13f');
    const s = await session(w);
    const l = await line(w, s);
    const d = await lineDiscount(w, l);
    expectCode(await refusal(() => upd('table_session_line_discounts', d, { status: 'removed' })), '23514'); // no removed_by: the shape CHECK
    for (const set of [{ qty: 2 }, { value: '50.00' }, { kind: 'pwd' }, { applied_by: w.person2 }, { diner_no: 3 }]) {
      expect(await refusal(() => upd('table_session_line_discounts', d, set)), JSON.stringify(set)).toBeDefined();
    }
    expectCode(await refusal(() => upd('table_session_line_discounts', d, { qty: 2 })), '23001');
    await upd('table_session_line_discounts', d, { status: 'removed', removed_by: w.person2, removed_at_device: T() });
    expectCode(await refusal(() => upd('table_session_line_discounts', d, { status: 'active', removed_by: null, removed_at_device: null })), '23514');
    expectCode(await updReplica('table_session_line_discounts', d, { status: 'active', removed_by: null }), '23514');
    expectCode(await refusal(() => upd('table_session_line_discounts', d, { removed_by: w.personId })), '23001'); // removal is once
    expect((await sql<{ status: string }[]>`select status from table_session_line_discounts where id = ${d}`)[0]!.status).toBe('removed');
  });

  it('a discount cannot be added to a line of a paid or voided session (23001); an open one takes it', async () => {
    const w = await world('r13g');
    const open = await session(w);
    const lOpen = await line(w, open);
    expect(await refusal(() => lineDiscount(w, lOpen))).toBeUndefined();
    const paid = await session(w, { stand_id: w.stand2 });
    const lPaid = await line(w, paid);
    await upd('table_sessions', paid, { status: 'paid' });
    expectCode(await refusal(() => lineDiscount(w, lPaid)), '23001');
    const voided = await takeOut(w);
    const lVoid = await line(w, voided);
    await upd('table_sessions', voided, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: 'test' });
    expectCode(await refusal(() => lineDiscount(w, lVoid)), '23001');
    expect(await count('table_session_line_discounts', `session_line_id in ('${lPaid}','${lVoid}')`)).toBe(0);
  });

  it('grants: shareat_app may remove a discount (granted columns) and may not change its qty (42501)', async () => {
    const w = await world('r13h');
    const s = await session(w);
    const d = await lineDiscount(w, await line(w, s));
    const ok = await asApp(w.orgId, (tx) => tx`update table_session_line_discounts set status = 'removed', removed_by = ${w.person2}, removed_at_device = now() where id = ${d} returning id`);
    expect(ok.err, ok.err?.message).toBeUndefined();
    expectCode((await asApp(w.orgId, (tx) => tx`update table_session_line_discounts set qty = 5 where id = ${d}`)).err, '42501');
  });

  it('receipt line: net must equal gross - discount_total, discount_total within gross and >= 0, gross = qty * unit_price (23514)', async () => {
    const w = await world('r13i');
    await saleTx(w, async ({ tx, receiptId }) => {
      const ln = (o: Record<string, unknown>) => (q: Q) => insQ(q, 'pos_sales_receipt_lines', rLineRow(w, receiptId, o));
      expectCode(await attempt(tx, ln({ discount_total: '24.00', net: '240.00' })), '23514'); // net not reduced
      expectCode(await attempt(tx, ln({ discount_total: '240.01', net: '-0.01' })), '23514');
      expectCode(await attempt(tx, ln({ discount_total: '-1.00', net: '241.00' })), '23514');
      expectCode(await attempt(tx, ln({ gross: '239.00', net: '239.00' })), '23514');
      expect(await attempt(tx, ln({ discount_total: '24.00', net: '216.00' }))).toBeUndefined();
      expect(await attempt(tx, ln({ line_no: 2, discount_total: '240.00', net: '0.00' }))).toBeUndefined();
    });
  });

  it('receipt line discount: preset needs preset_id; senior needs a statutory record and a statutory record only comes with senior/pwd; vat_removed only on senior/pwd; qty > 0; discount_amount > 0 (23514)', async () => {
    const w = await world('r13j');
    const rec = await statutory(w);
    const p = await preset(w);
    await saleTx(w, async ({ tx, receiptId }) => {
      const rl = await insQ(tx, 'pos_sales_receipt_lines', rLineRow(w, receiptId));
      const d = (o: Record<string, unknown>) => (q: Q) => insQ(q, 'pos_sales_receipt_line_discounts', rLineDiscountRow(w, rl, o));
      expectCode(await attempt(tx, d({ kind: 'preset' })), '23514');
      expect(await attempt(tx, d({ kind: 'preset', preset_id: p, label: 'Employee meal' }))).toBeUndefined();
      expectCode(await attempt(tx, d({ kind: 'senior', diner_no: 1, vat_removed: '10.00' })), '23514'); // senior without a statutory record
      expectCode(await attempt(tx, d({ kind: 'custom', statutory_record_id: rec })), '23514'); // record without senior/pwd
      expectCode(await attempt(tx, d({ kind: 'preset', preset_id: p, vat_removed: '5.00' })), '23514'); // vat_removed on a preset
      expectCode(await attempt(tx, d({ vat_removed: '5.00' })), '23514'); // ... or a custom discount
      expectCode(await attempt(tx, d({ qty: 0 })), '23514');
      expectCode(await attempt(tx, d({ discount_amount: '0.00' })), '23514');
      expectCode(await attempt(tx, d({ vat_removed: '-0.01', kind: 'senior', statutory_record_id: rec, diner_no: 1 })), '23514');
      expect(await attempt(tx, d({ kind: 'senior', diner_no: 1, statutory_record_id: rec, vat_removed: '12.86' }))).toBeUndefined();
    });
  });

  it('receipt line discount: append-only (UPDATE/DELETE refused, 23001, even in replica mode), and it stores NO holder name or id number (row 353)', async () => {
    const w = await world('r13k');
    const id = await saleTx(w, async ({ tx, receiptId }) => {
      const rl = await insQ(tx, 'pos_sales_receipt_lines', rLineRow(w, receiptId));
      return insQ(tx, 'pos_sales_receipt_line_discounts', rLineDiscountRow(w, rl, {}));
    });
    expectCode(await refusal(() => upd('pos_sales_receipt_line_discounts', id, { discount_amount: '1.00' })), '23001');
    expectCode(await updReplica('pos_sales_receipt_line_discounts', id, { discount_amount: '1.00' }), '23001');
    expectCode(await refusal(() => sql`delete from pos_sales_receipt_line_discounts where id = ${id}`), '23001');
    const cols = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_schema = 'public' and table_name in ('pos_sales_receipt_line_discounts', 'table_session_line_discounts')`;
    expect(cols.length, 'tables missing').toBeGreaterThan(0);
    const names = cols.map((c) => c.column_name);
    for (const banned of ['holder_name', 'id_number', 'card_number']) expect(names).not.toContain(banned);
  });

  it('receipt line discount: the receipt line, the preset and the statutory record are same-org FKs (23503)', async () => {
    const w = await world('r13l');
    const other = await world('r13l-other');
    const otherStatutory = await statutory(other);
    const otherPreset = await preset(other);
    await saleTx(w, async ({ tx, receiptId }) => {
      const rl = await insQ(tx, 'pos_sales_receipt_lines', rLineRow(w, receiptId));
      const d = (line: string, o: Record<string, unknown>) => (q: Q) => insQ(q, 'pos_sales_receipt_line_discounts', rLineDiscountRow(w, line, o));
      expectCode(await attempt(tx, d(rl, { kind: 'senior', diner_no: 1, statutory_record_id: otherStatutory })), '23503');
      expectCode(await attempt(tx, d(rl, { kind: 'preset', preset_id: otherPreset })), '23503');
      expectCode(await attempt(tx, d(randomUUID(), {})), '23503');
    });
  });
});

// =================================================================================================
describe('audit fixes (planner rulings, 6 Nov): closed sessions, dine-in heads, card index, same-store integrity', () => {
  it('a closed session is closed: after void, the reason / person / offline flag cannot be rewritten; on a paid session the head counts cannot change (23001); on an open one they still can', async () => {
    const w = await world('f2a');
    const v = await session(w);
    await upd('table_sessions', v, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: 'wrong table' });
    expectCode(await refusal(() => upd('table_sessions', v, { void_reason: 'rewritten' })), '23001');
    expectCode(await refusal(() => upd('table_sessions', v, { voided_by: w.personId })), '23001');
    expectCode(await refusal(() => upd('table_sessions', v, { voided_offline: true })), '23001');
    expectCode(await refusal(() => upd('table_sessions', v, { voided_at_device: later(5) })), '23001');
    expectCode(await updReplica('table_sessions', v, { void_reason: 'rewritten' }), '23001');
    expect((await sql<{ r: string }[]>`select void_reason r from table_sessions where id = ${v}`)[0]!.r).toBe('wrong table');
    const p = await session(w, { stand_id: w.stand2 });
    await upd('table_sessions', p, { heads_cashier: 5 }); // open: still moves
    await upd('table_sessions', p, { status: 'paid' });
    expectCode(await refusal(() => upd('table_sessions', p, { heads_cashier: 6 })), '23001');
    expectCode(await refusal(() => upd('table_sessions', p, { heads_server: 6 })), '23001');
    expectCode(await updReplica('table_sessions', p, { heads_cashier: 6 }), '23001');
  });

  it('dine-in needs at least 1 head (table_sessions_dine_in_heads_check, 23514); take-out may be 0', async () => {
    const w = await world('f3a');
    const err = await refusal(() => session(w, { heads_cashier: 0 }));
    expectCode(err, '23514');
    expect((err as PgErr & { constraint_name?: string }).constraint_name).toBe('table_sessions_dine_in_heads_check');
    expect(await refusal(() => session(w, { heads_cashier: 1 }))).toBeUndefined();
    expect(await refusal(() => takeOut(w, { heads_cashier: 0 }))).toBeUndefined();
  });

  it('closed session: a line cannot be CANCELLED and a line discount cannot be REMOVED (23001), but a line can still be marked served late; an open session cancels and removes fine', async () => {
    const w = await world('f4a');
    const open = await session(w);
    const lOpen = await line(w, open);
    const dOpen = await lineDiscount(w, lOpen);
    await upd('table_session_lines', lOpen, { kitchen_status: 'cancelled' });
    await upd('table_session_line_discounts', dOpen, { status: 'removed', removed_by: w.person2, removed_at_device: T() });

    const s2 = await session(w, { stand_id: w.stand2 });
    const lServe = await line(w, s2);
    const lCancel = await line(w, s2);
    const d = await lineDiscount(w, lServe);
    await upd('table_sessions', s2, { status: 'paid' });
    expectCode(await refusal(() => upd('table_session_lines', lCancel, { kitchen_status: 'cancelled' })), '23001');
    expectCode(await refusal(() => upd('table_session_line_discounts', d, { status: 'removed', removed_by: w.person2, removed_at_device: T() })), '23001');
    expect(await refusal(() => upd('table_session_lines', lServe, { kitchen_status: 'served', served_at_device: T(), served_by: w.person2 }))).toBeUndefined(); // late 'served' is allowed
    expect((await sql<{ k: string }[]>`select kitchen_status k from table_session_lines where id = ${lCancel}`)[0]!.k).toBe('queued');
    const s3 = await takeOut(w);
    const lVoid = await line(w, s3);
    await upd('table_sessions', s3, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: 'test' });
    expectCode(await refusal(() => upd('table_session_lines', lVoid, { kitchen_status: 'cancelled' })), '23001');
  });

  it("statutory index: 'OSCA-1', 'osca-1' and 'OSCA-1 ' on one invoice are ONE card - the second and third cannot go live (23505); a different card can", async () => {
    const w = await baseWorld('f5a');
    const invoice = 'LIPA-01-000950';
    await statutory(w, { invoice_number: invoice, id_number: 'OSCA-1' });
    expectCode(await refusal(() => statutory(w, { invoice_number: invoice, id_number: 'osca-1' })), '23505');
    expectCode(await refusal(() => statutory(w, { invoice_number: invoice, id_number: 'OSCA-1 ' })), '23505');
    expectCode(await refusal(() => statutory(w, { invoice_number: invoice, id_number: '  Osca-1' })), '23505');
    expect(await refusal(() => statutory(w, { invoice_number: invoice, id_number: 'OSCA-2' }))).toBeUndefined();
  });

  it('same-store integrity: a pairing of ANOTHER store is refused (23503) as a terminal pairing, a session opener, a line adder and an event pairing; a pairing of its own store is fine', async () => {
    const w = await world('f6a');
    expectCode(await refusal(() => ins('pos_terminals', { org_id: w.orgId, store_id: w.storeId, terminal_no: 7, pairing_id: w.pairing2Id, created_by: w.personId, created_at: T() })), '23503');
    expectCode(await refusal(() => session(w, { opened_on_pairing_id: w.pairing2Id })), '23503');
    const s = await session(w);
    expectCode(await refusal(() => line(w, s, { added_on_pairing_id: w.pairing2Id })), '23503');
    expect(await refusal(() => line(w, s, { added_on_pairing_id: w.pairingId }))).toBeUndefined();
    expect(await refusal(() => line(w, s, { added_on_pairing_id: null }))).toBeUndefined();
    expectCode(await refusal(() => event(w, { pairing_id: w.pairing2Id })), '23503');
    expect(await refusal(() => event(w))).toBeUndefined();
  });

  it("same-store integrity: a sales receipt's day close must be of its own store (23503, also on UPDATE)", async () => {
    const w = await world('f6b');
    const other = await world('f6b-other');
    const foreignZ = await dayClose(other);
    expectCode(await refusal(async () => receipt(w, await takeOut(w), { day_close_id: foreignZ })), '23503');
    const store2Terminal = await ins('pos_terminals', { org_id: w.orgId, store_id: w.store2Id, terminal_no: 1, created_by: w.personId, created_at: T() });
    const z2 = await dayClose(w, { store_id: w.store2Id, terminal_id: store2Terminal });
    const { receiptId } = await sale(w);
    expectCode(await refusal(() => upd('pos_sales_receipts', receiptId, { day_close_id: z2 })), '23503'); // same org, other store
    const z = await dayClose(w);
    await upd('pos_sales_receipts', receiptId, { day_close_id: z });
  });

  it('a sales receipt cannot be inserted for a VOIDED session (23001); open and paid sessions take it', async () => {
    const w = await world('f6c');
    const voided = await takeOut(w);
    await upd('table_sessions', voided, { status: 'voided', voided_by: w.person2, voided_at_device: T(), void_reason: 'test' });
    expectCode(await refusal(() => receipt(w, voided)), '23001');
    expect(await count('pos_sales_receipts', `table_session_id = '${voided}'`)).toBe(0);
    const paid = await takeOut(w);
    await upd('table_sessions', paid, { status: 'paid' });
    expect(await refusal(() => receipt(w, paid))).toBeUndefined();
    const open = await takeOut(w);
    expect(await refusal(() => receipt(w, open))).toBeUndefined();
  });
});

// =================================================================================================
describe('test 8 - RLS and the same-org FKs', () => {
  it('a second organisation sees none of these rows; the owning organisation sees every one', async () => {
    const a = await world('rls-a');
    const b = await baseWorld('rls-b'); // baseWorld, not world(): world() itself inserts two stands and a terminal, which b would then rightly see
    await fillAll(a);
    for (const t of TABLES) {
      const own = await asApp(a.orgId, (tx) => tx.unsafe(`select count(*)::int n from ${t}`));
      expect(own.err, `${t}: ${own.err?.message}`).toBeUndefined();
      expect(own.value?.[0]?.n, `${t} (owner org) shows no row`).toBeGreaterThan(0);
      const foreign = await asApp(b.orgId, (tx) => tx.unsafe(`select count(*)::int n from ${t}`));
      expect(foreign.err, `${t}: ${foreign.err?.message}`).toBeUndefined();
      expect(foreign.value?.[0]?.n, `${t} leaks to another organisation`).toBe(0);
    }
  });

  it('shareat_app can INSERT for its own org and is refused (42501, RLS) for another org; no table takes a DELETE (42501)', async () => {
    const a = await world('rls-c');
    const b = await world('rls-d');
    const mine = await asApp(a.orgId, (tx) => tx`insert into pos_stands (org_id, store_id, number, created_by, created_at) values (${a.orgId}, ${a.storeId}, 9, ${a.personId}, now()) returning id`);
    expect(mine.err, mine.err?.message).toBeUndefined();
    const theirs = await asApp(a.orgId, (tx) => tx`insert into pos_stands (org_id, store_id, number, created_by, created_at) values (${b.orgId}, ${b.storeId}, 9, ${b.personId}, now())`);
    expectCode(theirs.err, '42501');
    await fillAll(a);
    for (const t of TABLES) {
      const del = await asApp(a.orgId, (tx) => tx.unsafe(`delete from ${t}`));
      expectCode(del.err, '42501');
    }
  });

  it('cross-org composite FKs: a store, a person and a stand of another org (or another store) are refused (23503)', async () => {
    const a = await world('xfk-a');
    const b = await world('xfk-b');
    expectCode(await refusal(() => session(a, { store_id: b.storeId, stand_id: null, mode: 'take_out', heads_cashier: 0 })), '23503'); // store of another org
    expectCode(await refusal(() => session(a, { opened_by: b.personId })), '23503'); // person of another org: single FK passes, same-org twin refuses
    expectCode(await refusal(() => session(a, { stand_id: b.stand1 })), '23503');
    const otherStoreStand = await ins('pos_stands', { org_id: a.orgId, store_id: a.store2Id, number: 1, created_by: a.personId, created_at: T() });
    expectCode(await refusal(() => session(a, { stand_id: otherStoreStand })), '23503'); // stand of another store, same org
    expectCode(await refusal(() => ins('pos_stands', { org_id: a.orgId, store_id: a.storeId, number: 5, created_by: b.personId, created_at: T() })), '23503');
    expectCode(await refusal(async () => line(a, await session(a), { menu_item_id: b.itemId })), '23503'); // menu item of another org
    expectCode(await refusal(() => ins('pos_sales_receipt_payments', paymentRow(a, '00000000-0000-0000-0000-000000000000'))), '23503');
    const foreignTender = await ins('tenders', { org_id: b.orgId, store_id: b.storeId, name: uid('Cash'), kind: 'cash' });
    await saleTx(a, async ({ tx, receiptId }) => {
      expectCode(await attempt(tx, (q) => insQ(q, 'pos_sales_receipt_payments', paymentRow(a, receiptId, { tender_id: foreignTender }))), '23503');
    });
    expectCode(await refusal(() => event(a, { person_id: b.personId })), '23503');
  });
});
