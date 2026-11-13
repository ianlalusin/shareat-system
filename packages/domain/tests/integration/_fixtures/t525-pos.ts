/**
 * T-525 (TESTER) - the shared fixture for the POS v2 inbox, snapshot and state tests (domain file + apps/erp route file).
 * Raw SQL builds the world, so the DATABASE is the oracle. Every `fixture()` call is a fresh org: files and cases never share rows.
 * Nothing here names a lane database: the guard in t401-menu accepts any "_test" database (TEST_DATABASE_URL).
 *
 * People (each fixture): admin (admin role, both stores), manager (manager role, store A, approve_pos_correction grant), managerOther (manager of
 * store B only), counter (everyday position access = record_sale, employment SE-001), kitchen (serve_pos_ticket + request_pos_refill, NO record_sale,
 * employment SE-002). `makeStaff` adds more; `makeServer0240` makes a Server whose rows come from the REAL B0240 block of migration 0240.
 * A person sends events only after `signedIn` gives them a PIN session on the pairing (R4 clause 3); nothing here signs anyone in by itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql as dsql } from 'drizzle-orm';

import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { hashPin, newSessionToken, pinLookupHash, posTabletTokenHash, sessionTokenHash, type Actor } from '@shareat/auth';
import { grantEverydayPositionAccess } from './staff-everyday-access';
import { insRule, menuFixture, newItem, sql, uid } from '../../../../db/tests/integration/_fixtures/t401-menu';

export { sql, uid };

/** afterAll for a test file: closes the seeding pool and the app pool. */
export async function closeAll(): Promise<void> {
  await sql.end({ timeout: 5 });
  await closeDb();
}

export const uuid = (): string => globalThis.crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const DAY = 24 * 3600e3;
export const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });
/** The injectable rule reader (T-524 pattern): 12% VAT, 20% senior/PWD, business day starts at 04:00. Basis points. */
export const RATES = { readRules: async () => ({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, tableWarnMinutes: 90, saleVarianceToleranceCentavos: 1n }) };
export const HOLDER = 'Zyxwv Quillfeather'; // a senior's name: lives in statutory_discount_records and NOWHERE else
export const IDNO = 'OSCA-9990042';

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export type Item = { itemId: string; variantId: string };
let pinSeq = 0;
const nextPin = () => String(600000 + ++pinSeq * 17);
let standSeq = 100;
let terminalSeqCounter = 5000;

export async function fixture(mode: 'off' | 'test' | 'live' = 'test') {
  const m = await menuFixture(`t525-${mode}`);
  const { orgId, storeId, store2Id } = m;
  await seedChartOfAccounts(sql, orgId);
  await sql`update organizations set tax_type = 'vat' where id = ${orgId}`;
  const [store] = await sql<{ code: string; name: string }[]>`select code, name from stores where id = ${storeId}`;

  const mkPerson = async (name: string, role: string | null, scope: string[], kind: string | null = null) => {
    const [p] = kind
      ? await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, ${name}, ${kind}) returning id`
      : await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mkPerson('Alice Admin', 'admin', [storeId, store2Id]);
  const managerId = await mkPerson('Manny Manager', 'manager', [storeId]);
  const managerOtherId = await mkPerson('Mona Manager', 'manager', [store2Id]);
  await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id)
            values (${managerId}, 'approve_pos_correction', ${adminId}, 'grant', ${storeId})`;
  await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id)
            values (${managerOtherId}, 'approve_pos_correction', ${adminId}, 'grant', ${store2Id})`;

  const base = { orgId, storeId, store2Id, adminId, personId: m.personId };
  const staffCodes = new Map<string, string>();
  const counterId = await makeStaff(base, 'Cara Counter');
  const kitchenId = await makeStaff(base, 'Kit Kitchen', ['serve_pos_ticket', 'request_pos_refill']);
  for (const id of [counterId, kitchenId]) {
    const [e] = await sql<{ staff_code: string }[]>`select staff_code from employments where person_id = ${id}`;
    staffCodes.set(id, e!.staff_code);
  }

  // The store's terminal link (T-424): the domain resolves the void-approval PIN bucket's terminal person from it (T-524 audit F8).
  const terminalPerson = await mkPerson('Terminal A', null, [], 'terminal');
  await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${terminalPerson}, 'firebase', ${storeId}, ${uid('fbuid')})`;
  const [channel] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [v1link] = await sql<{ id: string }[]>`
    insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${orgId}, ${storeId}, ${uid('posstore')}, 'POS store', ${channel!.id}, 'vat_inclusive', ${adminId}) returning id`;
  await sql`insert into pos_terminal_links (org_id, store_id, pos_v1_store_link_id, terminal_no, device_id, terminal_person_id, created_by)
            values (${orgId}, ${storeId}, ${v1link!.id}, 1, ${uuid()}, ${terminalPerson}, ${adminId})`;

  // ---- menu + kitchen
  const station = async (name: string) =>
    (await sql<{ id: string }[]>`insert into kitchen_stations (org_id, store_id, name, created_by) values (${orgId}, ${storeId}, ${name}, ${m.personId}) returning id`)[0]!.id;
  const grill = await station('Grill');
  const sellable = async (type: 'a_la_carte' | 'package' | 'refill', name: string, o: { amount?: string; station?: string } = {}): Promise<Item> => {
    const it = await newItem(m, type, name);
    await insRule(m, it.variantId);
    if (type === 'refill' || o.amount !== undefined) {
      await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
                values (${orgId}, ${storeId}, ${it.variantId}, 'store', ${null}, ${type === 'refill' ? null : o.amount ?? null}, ${null}, ${null}, false, ${m.personId})`;
    }
    if (o.station) await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${orgId}, ${storeId}, ${it.itemId}, ${o.station}, ${m.personId})`;
    return it;
  };
  const unli = await sellable('package', 'Unli Grill', { amount: '449.00', station: grill });
  const pork = await sellable('a_la_carte', 'Pork belly', { amount: '250.00', station: grill });
  const cola = await sellable('a_la_carte', 'Cola', { amount: '80.00', station: grill });
  const refillRice = await sellable('refill', 'Rice refill', { station: grill });
  await sql`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by) values (${orgId}, ${unli.variantId}, ${refillRice.itemId}, ${m.personId})`;

  // ---- POS rows. Pairings carry REAL cookie tokens so the route tests can send them.
  await sql`insert into pos_stores (org_id, store_id, mode, live_from, changed_by)
            values (${orgId}, ${storeId}, ${mode}, ${mode === 'live' ? '2026-01-01' : null}, ${m.personId})`;
  const pairing = async (store: string, revoked = false) => {
    const token = newSessionToken();
    const [row] = await sql<{ id: string }[]>`
      insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by, revoked_at, revoked_by)
      values (${orgId}, ${store}, ${uid('tablet')}, ${posTabletTokenHash(token)}, ${adminId}, ${revoked ? new Date() : null}, ${revoked ? adminId : null}) returning id`;
    return { id: row!.id, token };
  };
  const revoked = await pairing(storeId, true);
  const live = await pairing(storeId);
  const other = await pairing(store2Id); // store B: it has NO pos_stores row
  await sql`insert into pos_terminals (org_id, store_id, terminal_no, pairing_id, created_by) values (${orgId}, ${storeId}, 1, ${live.id}, ${m.personId})`;
  const stand7 = (await sql<{ id: string }[]>`insert into pos_stands (org_id, store_id, number, status, created_by) values (${orgId}, ${storeId}, 7, 'active', ${m.personId}) returning id`)[0]!.id;
  const standRetired = (await sql<{ id: string }[]>`insert into pos_stands (org_id, store_id, number, status, created_by) values (${orgId}, ${storeId}, 8, 'retired', ${m.personId}) returning id`)[0]!.id;
  const standB = (await sql<{ id: string }[]>`insert into pos_stands (org_id, store_id, number, status, created_by) values (${orgId}, ${store2Id}, 1, 'active', ${m.personId}) returning id`)[0]!.id;

  // ---- tenders and presets
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${storeId}, 'GCash wallet', 'bank', '1140', 'office') returning id`;
  const tender = async (st: string, name: string, kind: 'cash' | 'wallet', active = true) =>
    (await sql<{ id: string }[]>`
      insert into tenders (org_id, store_id, name, kind, money_account_id, is_active) values (${orgId}, ${st}, ${name}, ${kind}, ${kind === 'wallet' ? acct!.id : null}, ${active}) returning id`)[0]!.id;
  const cash = await tender(storeId, 'Cash', 'cash');
  const gcash = await tender(storeId, 'GCash', 'wallet');
  const mayaOff = await tender(storeId, 'Maya', 'wallet', false);
  const cashB = await tender(store2Id, 'Cash', 'cash');
  const preset = async (st: string, name: string, valueType: 'percent' | 'fixed', value: string, status = 'active') =>
    (await sql<{ id: string }[]>`
      insert into pos_discount_presets (org_id, store_id, name, value_type, value, status, created_by) values (${orgId}, ${st}, ${name}, ${valueType}, ${value}, ${status}, ${m.personId}) returning id`)[0]!.id;
  const emp10 = await preset(storeId, 'Employee 10%', 'percent', '10');
  const promo50 = await preset(storeId, 'Promo 50 off', 'fixed', '50');
  const presetRetired = await preset(storeId, 'Old promo', 'percent', '5', 'retired');
  const presetB = await preset(store2Id, 'Other store promo', 'percent', '15');

  return {
    ...m, mode, storeCode: store!.code, storeName: store!.name, staffCodes,
    pairingId: live.id, pairingToken: live.token,
    pairingRevokedId: revoked.id, pairingRevokedToken: revoked.token,
    pairingBId: other.id, pairingBToken: other.token,
    stand7, standRetired, standB, grill, menu: { unli, pork, cola, refillRice },
    cash, gcash, mayaOff, cashB, emp10, promo50, presetRetired, presetB,
    adminId, managerId, managerOtherId, counterId, kitchenId,
    admin: actorOf(orgId, adminId), manager: actorOf(orgId, managerId), managerOther: actorOf(orgId, managerOtherId),
    counter: actorOf(orgId, counterId), kitchen: actorOf(orgId, kitchenId),
  };
}
export type Fx = Awaited<ReturnType<typeof fixture>>;

type StaffBase = { orgId: string; storeId: string; adminId: string };

/** A 'staff' person at store A with an open employment (staff code SE-nnn, the next free one) and position grants (default: the 21 everyday ones = record_sale). */
export async function makeStaff(b: StaffBase, name: string, capabilities?: string[]): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${b.orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${b.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${b.storeId})`;
  const [n] = await sql<{ n: number }[]>`select count(*)::int n from employments where org_id = ${b.orgId} and store_id = ${b.storeId}`;
  const code = `SE-${String(n!.n + 1).padStart(3, '0')}`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${b.orgId}, ${b.storeId}, ${p!.id}, ${code}, 'regular', '2025-01-01') returning id`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await grantEverydayPositionAccess(sql, { orgId: b.orgId, storeId: b.storeId, employmentId: emp!.id, personId: p!.id, setBy: b.adminId, ...(capabilities ? { capabilities: capabilities as any } : {}) });
  return p!.id;
}

/**
 * A Server whose capabilities are exactly what migration 0240's REAL B0240 block gives the canonical Server position (request_pos_refill,
 * confirm_pos_heads; NOT serve_pos_ticket, NOT record_sale). The block runs committed on the owner connection: it is idempotent and also touches other test orgs.
 */
export async function makeServer0240(f: Fx): Promise<Actor> {
  const [pos] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${f.orgId}, null, 'Server', true, true) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Sam Server') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
  const [n] = await sql<{ n: number }[]>`select count(*)::int n from employments where org_id = ${f.orgId} and store_id = ${f.storeId}`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${f.orgId}, ${f.storeId}, ${p!.id}, ${`SE-${String(n!.n + 1).padStart(3, '0')}`}, 'regular', '2025-01-01') returning id`;
  await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;
  const text = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'db', 'migrations', '0240_t524_receipt_append_guard.sql'), 'utf8');
  const begin = text.indexOf('-- B0240:begin');
  const end = text.indexOf('-- B0240:end');
  if (begin < 0 || end < begin) throw new Error('B0240 block not found in migration 0240');
  const statements = text.slice(begin, end).split(/-->\s*statement-breakpoint/).map((x) => x.trim()).filter((x) => x.length > 0);
  await sql.begin(async (tx) => {
    for (const s of statements) await tx.unsafe(s);
  });
  return actorOf(f.orgId, p!.id);
}

// ------------------------------------------------------------------------------------------------------------------------------
// PIN sessions (R4 clause 3) and cookies
// ------------------------------------------------------------------------------------------------------------------------------
const pins = new Map<string, { pin: string; credentialId: string }>();
async function pinCredential(f: { orgId: string; storeId: string }, personId: string): Promise<{ pin: string; credentialId: string }> {
  const have = pins.get(personId);
  if (have) return have;
  const pin = nextPin();
  const [c] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${f.storeId}, ${await hashPin(pin)}, ${pinLookupHash(f.orgId, pin)}) returning id`;
  const made = { pin, credentialId: c!.id };
  pins.set(personId, made);
  return made;
}
/** The person's PIN (creating the credential on first use). The manager's PIN approves an online void. */
export const pinOf = async (f: Fx, personId: string) => (await pinCredential(f, personId)).pin;

export interface SessionOpts {
  pairingId?: string;
  storeId?: string;
  issuedAt?: Date;
  /** Ended by this reason (ended one hour after issue). */
  ended?: 'signed_out' | 'shift_end' | 'revoked' | 'superseded';
  kind?: 'pin' | 'firebase';
}
/** A session row for the person ON a pairing (device_id = pairing id), issued at `issuedAt` (default now). Returns the token (a cookie value). */
export async function pinSession(f: Fx, personId: string, o: SessionOpts = {}): Promise<string> {
  const issuedAt = o.issuedAt ?? new Date();
  const kind = o.kind ?? 'pin';
  let credentialId: string;
  if (kind === 'pin') credentialId = (await pinCredential(f, personId)).credentialId;
  else {
    const [c] = await sql<{ id: string }[]>`
      insert into person_credentials (person_id, kind, store_id, external_id) values (${personId}, 'firebase', ${f.storeId}, ${uid('fbuid')}) returning id`;
    credentialId = c!.id;
  }
  const token = newSessionToken();
  const expires = new Date(issuedAt.getTime() + 12 * 3600e3);
  const endedAt = o.ended ? new Date(issuedAt.getTime() + 3600e3) : null;
  await sql`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, device_id, issued_at, expires_at, ended_at, ended_reason)
    values (${sessionTokenHash(token)}, ${personId}, ${credentialId}, ${kind}, ${o.storeId ?? f.storeId}, ${o.pairingId ?? f.pairingId}, ${issuedAt}, ${expires}, ${endedAt}, ${o.ended ?? null})`;
  return token;
}
/** Every named person gets a live PIN session on the till pairing (the normal state: they signed in on the tablet today). Returns their tokens by person id. */
export async function signedIn(f: Fx, ...personIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of personIds) out[id] = await pinSession(f, id);
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------
// The tablet's events, built the way the outbox builds them (R2/R3): the payload is the domain input MINUS storeId and pairingId.
// ------------------------------------------------------------------------------------------------------------------------------
export interface Ev { seq: number; kind: string; personId: string; occurredAtDevice: string; payload: Record<string, unknown> }
export const ev = (seq: number, kind: string, personId: string, payload: Record<string, unknown>, at: Date = new Date()): Ev => ({
  seq, kind, personId, occurredAtDevice: at.toISOString(), payload,
});
export async function newStand(f: Fx): Promise<{ id: string; number: number }> {
  const number = ++standSeq;
  const [s] = await sql<{ id: string }[]>`insert into pos_stands (org_id, store_id, number, created_by) values (${f.orgId}, ${f.storeId}, ${number}, ${f.personId}) returning id`;
  return { id: s!.id, number };
}
export const standOpenedPayload = (sessionId: string, standId: string, heads = 2) => ({ sessionId, mode: 'dine_in', standId, headsCashier: heads, openedAtDevice: nowIso() });
export const linesAddedPayload = (sessionId: string, lines: { lineId: string; item: Item; qty: number }[]) => ({
  sessionId, lines: lines.map((l) => ({ lineId: l.lineId, menuItemId: l.item.itemId, variantId: l.item.variantId, qty: l.qty, addedAtDevice: nowIso() })),
});
const fmt = (c: number) => (c / 100).toFixed(2);
/** A sale.completed payload for one 250.00 pork line x qty. `cashPaid` defaults to the exact figure; a senior sale passes a bigger cash amount (change). */
export function salePayload(f: Fx, o: { sessionId: string; porkLineId: string; qty?: number; terminalSeq?: number; cashPaid?: string; seniors?: unknown[]; receiptId?: string }) {
  const gross = 25000 * (o.qty ?? 2);
  return {
    sessionId: o.sessionId, receiptId: o.receiptId ?? uuid(), terminalNo: 1, terminalSeq: o.terminalSeq ?? ++terminalSeqCounter, issuedAtDevice: nowIso(), offline: false,
    device: { subtotal: fmt(gross), discountTotal: '0.00', total: fmt(gross), lines: [{ lineId: o.porkLineId, gross: fmt(gross), discountTotal: '0.00', net: fmt(gross) }] },
    payments: [{ tenderId: f.cash, amount: o.cashPaid ?? fmt(gross), toCheck: false }],
    seniors: o.seniors ?? [],
  };
}
export const seniorEntry = (dinerNo = 1) => ({ dinerNo, kind: 'senior', idNumber: IDNO, holderName: HOLDER });

/** The standard three-event day: open a stand, add 2 pork, pay. Returns the events and the ids the assertions need. */
export function plainDay(f: Fx, startSeq = 1, who = f.counterId) {
  const sessionId = uuid();
  const stand = f.stand7;
  const porkLineId = uuid();
  const saleSeq = ++terminalSeqCounter;
  const payload = salePayload(f, { sessionId, porkLineId, terminalSeq: saleSeq });
  const events = [
    ev(startSeq, 'stand.opened', who, standOpenedPayload(sessionId, stand)),
    ev(startSeq + 1, 'lines.added', who, linesAddedPayload(sessionId, [{ lineId: porkLineId, item: f.menu.pork, qty: 2 }])),
    ev(startSeq + 2, 'sale.completed', who, payload),
  ];
  return { sessionId, porkLineId, receiptId: payload.receiptId as string, terminalSeq: saleSeq, events };
}
/** The same day with ONE senior on the pork and the card details on the sale: needs the rules (the default reader since T-539 S2). 4 events. */
export function seniorDay(f: Fx, startSeq = 1, who = f.counterId) {
  const sessionId = uuid();
  const porkLineId = uuid();
  const saleSeq = ++terminalSeqCounter;
  const payload = salePayload(f, { sessionId, porkLineId, terminalSeq: saleSeq, cashPaid: '1000.00', seniors: [seniorEntry(1)] });
  const events = [
    ev(startSeq, 'stand.opened', who, standOpenedPayload(sessionId, f.stand7)),
    ev(startSeq + 1, 'lines.added', who, linesAddedPayload(sessionId, [{ lineId: porkLineId, item: f.menu.pork, qty: 2 }])),
    ev(startSeq + 2, 'discount.added', who, { discountId: uuid(), lineId: porkLineId, kind: 'senior', qty: 1, dinerNo: 1, appliedAtDevice: nowIso() }),
    ev(startSeq + 3, 'sale.completed', who, payload),
  ];
  return { sessionId, porkLineId, receiptId: payload.receiptId as string, events };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Raw readers: the database is the oracle
// ------------------------------------------------------------------------------------------------------------------------------
export interface EventRow {
  id: string; pairing_id: string; seq: string; kind: string; status: string; error: string | null; payload: Record<string, unknown>;
  person_id: string | null; occurred_at_device: Date; received_at: Date; resolved_by: string | null; resolved_at: Date | null; resolution: string | null;
}
export const eventsOf = (f: Fx) => sql<EventRow[]>`
  select id, pairing_id, seq::text, kind, status, error, payload, person_id, occurred_at_device, received_at, resolved_by, resolved_at, resolution
    from pos_events where org_id = ${f.orgId} order by pairing_id, seq`;
export async function counts(f: Fx) {
  const n = async (t: string) => Number((await sql.unsafe(`select count(*)::int n from ${t} where org_id = '${f.orgId}'`))[0]!.n);
  return {
    events: await n('pos_events'), receipts: await n('pos_sales_receipts'), statutory: await n('statutory_discount_records'),
    sessions: await n('table_sessions'), lines: await n('table_session_lines'), discounts: await n('table_session_line_discounts'),
  };
}
export const stateVersionOf = async (f: Fx) => Number((await sql<{ v: string }[]>`select state_version::text v from pos_stores where store_id = ${f.storeId}`)[0]!.v);
export const receiptOfSession = async (sessionId: string) =>
  (await sql<{ id: string; terminal_id: string; receipt_seq: number; total: string }[]>`select id, terminal_id, receipt_seq, total::text from pos_sales_receipts where table_session_id = ${sessionId}`)[0];
export const sessionRow = async (sessionId: string) =>
  (await sql<{ status: string; heads_cashier: number; void_reason: string | null }[]>`select status, heads_cashier, void_reason from table_sessions where id = ${sessionId}`)[0];
export const auditRows = (f: Fx, action: string) => sql<{ action: string; actor_person_id: string | null; store_id: string | null; entity_id: string; before: unknown; after: unknown }[]>`
  select action, actor_person_id, store_id, entity_id, before, after from audit_log where org_id = ${f.orgId} and action = ${action} order by recorded_at, id`;
