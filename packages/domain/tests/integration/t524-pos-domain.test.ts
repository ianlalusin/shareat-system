import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-524 (TESTER) - the POS v2 domain, spec tests 2-10. docs/tasks/524-pos-v2-domain.md (branch docs/t524-spec).
 * Real Postgres on a scratch database whose name contains "_test". Raw SQL is the oracle for what was written; the domain is the subject.
 * Test 1 (priceSession, R7) is the unit file packages/domain/src/pos/price.test.ts.
 *
 * ASSUMED SIGNATURES (the spec names the functions and their inputs, not every field; the builder matches these or says why not).
 * Every function is `fn(tx, actor, input)`. EVERY input carries `storeId` and `pairingId` (R1: explicit context, never from the actor);
 * `pairingId` is null only for a phone-browser call and only on the functions the spec marks *phone ok* (addLines, confirmHeads,
 * requestRefill, serveLine). Device-made uuids: sessionId, lineId, discountId, receiptId.
 *   currentBusinessDate(tx, storeId, deps?) -> 'YYYY-MM-DD'
 *   openStand(.., { storeId, pairingId, sessionId, mode: 'dine_in'|'take_out', standId?, headsCashier, openedAtDevice, lines? }) -> { wrote, sessionId }
 *   addLines(.., { storeId, pairingId|null, sessionId, lines: [{ lineId, menuItemId, variantId?, qty, note?, addedAtDevice }] }) -> { wrote }
 *       a PACKAGE line's input qty is the HEADS (per-head: one line qty = heads; "(up to N)" bundle: line 1 qty 1 + line 2 qty heads - N at extraHeadAmount;
 *       the server makes the second line's id; tests find lines by session, never by the device id of the second line)
 *   confirmHeads(.., { storeId, pairingId|null, sessionId, headsServer });  setHeadsCashier(.., { storeId, pairingId, sessionId, headsCashier })
 *   requestRefill(.., { storeId, pairingId|null, sessionId, lines: [{ lineId, menuItemId, qty, addedAtDevice }] })
 *   serveLine(.., { storeId, pairingId|null, lineId, servedAtDevice });  cancelLine(.., { storeId, pairingId, lineId, reason })
 *   addLineDiscount(.., { storeId, pairingId, discountId, lineId, kind, presetId?, valueType?, value?, qty, dinerNo?, appliedAtDevice }) -> { wrote }
 *   removeLineDiscount(.., { storeId, pairingId, discountId, removedAtDevice })   (ruling 7)
 *   applyPresetToAllLines(.., { storeId, pairingId, sessionId, presetId, applyId, appliedAtDevice }) -> { wrote, applied, skipped }   (ruling 6: each discount id = uuidv5(lineId, applyId))
 *   voidUnpaidSession(.., { storeId, pairingId, sessionId, reason, voidedAtDevice, offline, approval?: { pin } })   (audit F8: the terminal person is resolved in the domain from the store's terminal link)
 *   completeSale(.., input, deps?) -> { wrote, receiptId }   input exactly as spec R9
 *   getSessionBill(.., { storeId, sessionId }, deps?) -> { stateVersion, ...lines, discounts, pricing }  (tests only look for the figures and stateVersion)
 *   listOpenStands(.., { storeId });  listKitchenQueue(.., { storeId, stationId? });  listRefillQueue(.., { storeId });  listTodaysSalesReceipts(.., { storeId })
 *       each returns an object with `stateVersion` (T-525 answers 304 from it); tests look for ids with a JSON search, not for field names.
 *
 * RULES (R7; BOSS rulings 6 Nov): `business_rule_values` (T-511 S5c) is NOT on this branch, and this file does not invent it. The rule source is
 * INJECTABLE: the last argument of completeSale / getSessionBill / addLineDiscount (a senior stores its rate) / currentBusinessDate is
 *   deps?: { readRules?: (tx, orgId, businessDate) => Promise<{ vatPercentBasisPoints: bigint; scPwdPercentBasisPoints: bigint; businessDayStartHour: number }>; now?: () => Date }
 * Since T-539 S2 the default reader is `readPosRules`: without `readRules` the rules come from the org's dated rows, and an org with none gets the
 * registry defaults (12%, 20%, 4). There is no "rate not set up" refusal.
 *
 * RED NOW FOR THE RIGHT REASON: packages/domain/src/pos/index.ts does not exist. The module is loaded lazily, so every case that needs it
 * fails "MISSING EXPORT ... not built" AFTER its fixture ran; the raw-SQL cases (fixture sanity, R11 append guard, catalogue) run for real.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { APP_ROLE, catalogueEntry, closeDb, RefusalError, transaction, type Tx } from '@shareat/db';
import { AuthenticationError, AuthorizationError, CAPABILITY_MATRIX, CAPABILITY_SCOPE, hashPin, pinLookupHash, POS_APPROVAL_REFUSED, POS_TERMINAL_NOT_REGISTERED, type Actor } from '@shareat/auth';
import { loadStoreMenu, setBusinessRule } from '@shareat/domain';
import { addDays, toBusinessDate } from '@shareat/core/datetime';
import { uuidv5 } from '../../src/pos/shared';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { insDaypart, insDaypartOffer, insOptionOffer, insRule, menuFixture, newItem, newOption, sql, uid } from '../../../db/tests/integration/_fixtures/t401-menu';

// ------------------------------------------------------------------------------------------------------------------------------
// The subject, loaded lazily so a missing module fails each case with its own message instead of killing the file at import.
// ------------------------------------------------------------------------------------------------------------------------------
type Deps = { readRules?: (tx: Tx, orgId: string, businessDate: string) => Promise<{ vatPercentBasisPoints: bigint; scPwdPercentBasisPoints: bigint; businessDayStartHour: number; saleVarianceToleranceCentavos?: bigint }>; now?: () => Date };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W<R = any> = (tx: Tx, actor: Actor, input: any, deps?: Deps) => Promise<R>;
interface PosApi {
  currentBusinessDate(tx: Tx, storeId: string, deps?: Deps): Promise<string>;
  openStand: W<{ wrote: boolean; sessionId: string }>;
  addLines: W<{ wrote: boolean }>;
  confirmHeads: W;
  setHeadsCashier: W;
  requestRefill: W<{ wrote: boolean }>;
  serveLine: W;
  cancelLine: W;
  addLineDiscount: W<{ wrote: boolean }>;
  removeLineDiscount: W;
  applyPresetToAllLines: W<{ applied: number; skipped: number }>;
  voidUnpaidSession: W;
  completeSale: W<{ wrote: boolean; receiptId: string }>;
  getSessionBill: W<{ stateVersion: number; lines: { id: string; name: string; menuItemId: string; note: string | null }[] }>;
  listOpenStands: W<{ stateVersion: number }>;
  listKitchenQueue: W<{ stateVersion: number }>;
  listRefillQueue: W<{ stateVersion: number }>;
  listTodaysSalesReceipts: W<{ stateVersion: number }>;
}
const POS_MODULE = '../../src/pos';
let loaded: Record<string, unknown> | null | undefined;
async function api(name: string): Promise<(...a: unknown[]) => Promise<unknown>> {
  if (loaded === undefined) loaded = await import(/* @vite-ignore */ POS_MODULE).catch(() => null);
  const fn = loaded?.[name];
  if (typeof fn !== 'function') throw new Error(`MISSING EXPORT: packages/domain/src/pos does not export ${name} (T-524 not built).`);
  return fn as (...a: unknown[]) => Promise<unknown>;
}
const P = new Proxy({} as PosApi, { get: (_t, name: string) => (...args: unknown[]) => api(name).then((fn) => fn(...args)) });

// ------------------------------------------------------------------------------------------------------------------------------
// Plumbing
// ------------------------------------------------------------------------------------------------------------------------------
const uuid = (): string => globalThis.crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });
// BOSS ruling 6 Nov: one injectable reader; percents are basis points (12% = 1200n); the business day starts at an integer hour (4 = 04:00).
const RATES: Deps = { readRules: async () => ({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, saleVarianceToleranceCentavos: 1n }) };
const HOLDER = 'Zyxwv Quillfeather'; // a senior's name: must appear in statutory_discount_records and NOWHERE else
const IDNO = 'OSCA-9990042';
const SAME_ID_SENTENCE = 'This change was already recorded differently on the till.';
const NOT_ON_SENTENCE = 'The new POS is not switched on for this store yet.';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let pinSeq = 0;
const nextPin = () => String(500000 + ++pinSeq * 19);
let standSeq = 100;
let terminalSeq = 1000;
const fmt = (cents: number) => (cents / 100).toFixed(2);
const cents = (s: string) => Math.round(Number(s) * 100);

async function expectRefusal(p: Promise<unknown>, sentence?: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  const msg = (err as RefusalError).userMessage;
  expect(msg.length).toBeGreaterThan(10);
  expect(msg, 'no UUID in a sentence').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  if (sentence !== undefined) expect(msg).toBe(sentence);
  return msg;
}
/** Any of the three refusal types (a sentence, an authorization refusal, a PIN refusal): for rules whose type the spec does not fix. */
async function expectAnyRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(
    err instanceof RefusalError || err instanceof AuthorizationError || err instanceof AuthenticationError,
    `expected a refusal, got ${String((err as Error)?.message)}`,
  ).toBe(true);
}
/** A PIN refusal: the AuthenticationError and its one sentence (no oracle for "right PIN, wrong person"). */
async function expectAuthn(p: Promise<unknown>, sentence: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authentication refusal, got success').not.toBeNull();
  expect(err, `expected AuthenticationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthenticationError);
  expect((err as Error).message).toBe(sentence);
}
async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

// ------------------------------------------------------------------------------------------------------------------------------
// Fixture: one VAT org, store A (the store under test) and store B (another store of the same org), a menu with stations, stands, a
// terminal, tenders, presets and people. Each call is a fresh org, so files and cases never share rows.
// ------------------------------------------------------------------------------------------------------------------------------
type Item = { itemId: string; variantId: string };

async function fixture(mode: 'off' | 'test' | 'live' = 'test') {
  const m = await menuFixture(`t524-${mode}`);
  const { orgId, storeId, store2Id } = m;
  await seedChartOfAccounts(sql, orgId);
  await sql`update organizations set tax_type = 'vat' where id = ${orgId}`;
  const [store] = await sql<{ code: string }[]>`select code from stores where id = ${storeId}`;

  // ---- people
  const mkPerson = async (name: string, role: string | null, scope: string[], kind: string | null = null) => {
    const [p] = kind
      ? await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, ${name}, ${kind}) returning id`
      : await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const pinFor = async (personId: string, store: string) => {
    const pin = nextPin();
    await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
              values (${personId}, 'pin', ${store}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return pin;
  };
  const adminId = await mkPerson('Alice Admin', 'admin', [storeId, store2Id]);
  const managerId = await mkPerson('Manny Manager', 'manager', [storeId]);
  const managerOtherId = await mkPerson('Mona Manager', 'manager', [store2Id]);
  await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id)
            values (${managerId}, 'approve_pos_correction', ${adminId}, 'grant', ${storeId})`;
  const staff = async (name: string, capabilities?: string[]) => {
    const id = await mkPerson(name, 'staff', [storeId]);
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: id, setBy: adminId, ...(capabilities ? { capabilities: capabilities as any } : {}) });
    return id;
  };
  const EVERYDAY_PLUS = async (name: string, extra: string[]) => {
    const { EVERYDAY_CAPABILITIES } = await import('./_fixtures/staff-everyday-access');
    return staff(name, [...EVERYDAY_CAPABILITIES, ...extra]);
  };
  const counterId = await staff('Cara Counter'); // the 21 everyday grants (record_sale ...) and none of the three new ones
  const serverId = await EVERYDAY_PLUS('Sam Server', ['request_pos_refill', 'serve_pos_ticket', 'confirm_pos_heads']);
  const kitchenId = await staff('Kit Kitchen', ['serve_pos_ticket', 'request_pos_refill']); // no record_sale
  const bareId = await staff('Bea Bare', []); // nothing at all
  const counterPin = await pinFor(counterId, storeId);
  const managerPin = await pinFor(managerId, storeId);
  const terminalId = await mkPerson('Terminal A', null, [], 'terminal');
  await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${terminalId}, 'firebase', ${storeId}, ${uid('fbuid')})`;
  // The store's terminal link (T-424): the domain resolves the approval PIN bucket's terminal person from it (audit F8), never from the input.
  const [channel] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [v1link] = await sql<{ id: string }[]>`
    insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${orgId}, ${storeId}, ${uid('posstore')}, 'POS store', ${channel!.id}, 'vat_inclusive', ${adminId}) returning id`;
  await sql`insert into pos_terminal_links (org_id, store_id, pos_v1_store_link_id, terminal_no, device_id, terminal_person_id, created_by)
            values (${orgId}, ${storeId}, ${v1link!.id}, 1, ${globalThis.crypto.randomUUID()}, ${terminalId}, ${adminId})`;

  // ---- menu + kitchen
  const station = async (name: string) =>
    (await sql<{ id: string }[]>`insert into kitchen_stations (org_id, store_id, name, created_by) values (${orgId}, ${storeId}, ${name}, ${m.personId}) returning id`)[0]!.id;
  const grill = await station('Grill');
  const bar = await station('Bar');
  const sellable = async (
    type: 'a_la_carte' | 'package' | 'refill',
    name: string,
    o: { amount?: string; station?: string; bundle?: [number, string]; daypart?: string } = {},
  ): Promise<Item> => {
    const it = await newItem(m, type, name);
    await insRule(m, it.variantId);
    if (type === 'refill' || o.amount !== undefined) { // a refill offer carries no amount (a zero-price serving)
      await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
                values (${orgId}, ${storeId}, ${it.variantId}, 'store', ${o.daypart ?? null}, ${type === 'refill' ? null : o.amount ?? null},
                        ${o.bundle?.[0] ?? null}, ${o.bundle?.[1] ?? null}, false, ${m.personId})`;
    }
    if (o.station) await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${orgId}, ${storeId}, ${it.itemId}, ${o.station}, ${m.personId})`;
    return it;
  };
  const unli = await sellable('package', 'Unli Grill', { amount: '449.00', station: grill });
  const family = await sellable('package', 'Family Pack', { amount: '1200.00', bundle: [6, '199.00'], station: grill });
  const pork = await sellable('a_la_carte', 'Pork belly', { amount: '250.00', station: grill });
  const cola = await sellable('a_la_carte', 'Cola', { amount: '80.00', station: bar });
  const noStation = await sellable('a_la_carte', 'Mystery dish', { amount: '100.00' }); // offered, routed nowhere: notOnPos
  const lookalike = await sellable('package', 'Combo (up to 4)', { amount: '300.00', station: grill }); // a PER-HEAD package whose name ends like a bundle's (audit F1)
  // A one-hour window that is NOT now (offers and rules cannot be back-dated, so device time is always ~now): the item is outside its hours now.
  const hourNow = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  const closedHour = (hourNow + 6) % 24 === 23 ? 22 : (hourNow + 6) % 24;
  const pad = (n: number) => String(n).padStart(2, '0');
  const lunchDp = (await insDaypart(m, { name: 'Closed now', start: `${pad(closedHour)}:00`, end: `${pad(closedHour + 1)}:00` }))[0]!.id;
  const lunchOnly = await sellable('a_la_carte', 'Off-hours special', { amount: '120.00', station: grill, daypart: lunchDp });
  const refillRice = await sellable('refill', 'Rice refill', { station: grill });
  const refillPork = await sellable('refill', 'Pork refill', { station: grill });
  const refillNoodles = await sellable('refill', 'Noodle refill', { station: grill }); // NOT in the package
  for (const r of [refillRice, refillPork]) {
    await sql`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by) values (${orgId}, ${unli.variantId}, ${r.itemId}, ${m.personId})`;
  }
  const unoffered: Item = { itemId: m.itemId, variantId: m.variantId }; // menuFixture's own item: no offer at all
  // Ruling 9: option values with a store price delta. One single-choice group on the pork (Large +30.00; "Extra sauce" has NO store offer), one on the cola (+5.00).
  const optionOn = async (itemId: string, delta: string) => {
    const o = await newOption(m);
    await sql`update menu_option_groups set min_selections = 0 where id = ${o.groupId}`; // T-552: newOption makes a REQUIRED group; these tests add the item with no choice
    await insOptionOffer(m, o.valueId, delta);
    await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, status, created_by) values (${orgId}, ${o.groupId}, ${itemId}, 'active', ${m.personId})`;
    return o;
  };
  const porkOpt = await optionOn(pork.itemId, '30.00');
  const colaOpt = await optionOn(cola.itemId, '5.00');
  const [noOffer] = await sql<{ id: string }[]>`
    insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${orgId}, ${porkOpt.groupId}, 'Extra sauce', 1, 'active', ${m.personId}) returning id`;
  const options = { porkLarge: porkOpt.valueId, colaIce: colaOpt.valueId, porkNoOffer: noOffer!.id };

  // ---- POS rows
  await sql`insert into pos_stores (org_id, store_id, mode, live_from, changed_by)
            values (${orgId}, ${storeId}, ${mode}, ${mode === 'live' ? '2026-01-01' : null}, ${m.personId})`;
  const pairing = async (store: string, revoked = false) =>
    (await sql<{ id: string }[]>`
      insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by, revoked_at, revoked_by)
      values (${orgId}, ${store}, ${uid('tablet')}, ${uid('digest')}, ${adminId}, ${revoked ? new Date() : null}, ${revoked ? adminId : null}) returning id`)[0]!.id;
  const pairingRevoked = await pairing(storeId, true);
  const pairingId = await pairing(storeId);
  const pairingB = await pairing(store2Id);
  const [term] = await sql<{ id: string }[]>`
    insert into pos_terminals (org_id, store_id, terminal_no, pairing_id, created_by) values (${orgId}, ${storeId}, 1, ${pairingId}, ${m.personId}) returning id`;
  const mkStand = async (store: string, number: number, status = 'active') =>
    (await sql<{ id: string }[]>`insert into pos_stands (org_id, store_id, number, status, created_by) values (${orgId}, ${store}, ${number}, ${status}, ${m.personId}) returning id`)[0]!.id;
  const stand7 = await mkStand(storeId, 7);
  const standRetired = await mkStand(storeId, 8, 'retired');
  const standB = await mkStand(store2Id, 1);

  // ---- tenders and presets
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${storeId}, 'GCash wallet', 'bank', '1140', 'office') returning id`;
  const tender = async (store: string, name: string, kind: 'cash' | 'wallet', active = true) =>
    (await sql<{ id: string }[]>`
      insert into tenders (org_id, store_id, name, kind, money_account_id, is_active) values (${orgId}, ${store}, ${name}, ${kind}, ${kind === 'wallet' ? acct!.id : null}, ${active}) returning id`)[0]!.id;
  const cash = await tender(storeId, 'Cash', 'cash');
  const gcash = await tender(storeId, 'GCash', 'wallet');
  const mayaOff = await tender(storeId, 'Maya', 'wallet', false);
  const cashB = await tender(store2Id, 'Cash', 'cash');
  const preset = async (store: string, name: string, valueType: 'percent' | 'fixed', value: string, status = 'active') =>
    (await sql<{ id: string }[]>`
      insert into pos_discount_presets (org_id, store_id, name, value_type, value, status, created_by) values (${orgId}, ${store}, ${name}, ${valueType}, ${value}, ${status}, ${m.personId}) returning id`)[0]!.id;
  const emp10 = await preset(storeId, 'Employee 10%', 'percent', '10');
  const promo50 = await preset(storeId, 'Promo 50 off', 'fixed', '50');
  const presetRetired = await preset(storeId, 'Old promo', 'percent', '5', 'retired');
  const presetB = await preset(store2Id, 'Other store promo', 'percent', '15');

  return {
    ...m, mode, storeCode: store!.code, terminalRowId: term!.id,
    pairingId, pairingB, pairingRevoked, stand7, standRetired, standB, grill, bar,
    menu: { lookalike, unli, family, pork, cola, noStation, lunchOnly, refillRice, refillPork, refillNoodles, unoffered }, options,
    cash, gcash, mayaOff, cashB, emp10, promo50, presetRetired, presetB,
    admin: actorOf(orgId, adminId), manager: actorOf(orgId, managerId), managerOther: actorOf(orgId, managerOtherId),
    counter: actorOf(orgId, counterId), server: actorOf(orgId, serverId), kitchen: actorOf(orgId, kitchenId), bare: actorOf(orgId, bareId),
    counterPin, managerPin, terminalPersonId: terminalId,
  };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

// ---- small helpers over the fixture
async function newStand(f: Fx) {
  const number = ++standSeq;
  const [s] = await sql<{ id: string }[]>`insert into pos_stands (org_id, store_id, number, created_by) values (${f.orgId}, ${f.storeId}, ${number}, ${f.personId}) returning id`;
  return { id: s!.id, number };
}
async function open(f: Fx, o: { heads?: number; who?: Actor; mode?: 'dine_in' | 'take_out'; extra?: Record<string, unknown> } = {}) {
  const mode = o.mode ?? 'dine_in';
  const st = mode === 'dine_in' ? await newStand(f) : null;
  const sessionId = uuid();
  const input = {
    storeId: f.storeId, pairingId: f.pairingId, sessionId, mode, ...(st ? { standId: st.id } : {}),
    headsCashier: o.heads ?? (mode === 'dine_in' ? 4 : 0), openedAtDevice: nowIso(), ...o.extra,
  };
  const res = await asOrg(f.orgId, (tx) => P.openStand(tx, o.who ?? f.counter, input));
  return { sessionId, standId: st?.id ?? null, standNo: st?.number ?? null, res };
}
async function add(f: Fx, sessionId: string, lines: { item: Item; qty: number; at?: Date }[], o: { who?: Actor; pairingId?: string | null } = {}) {
  const lineIds = lines.map(() => uuid());
  const input = {
    storeId: f.storeId, pairingId: o.pairingId === undefined ? f.pairingId : o.pairingId, sessionId,
    lines: lines.map((l, i) => ({ lineId: lineIds[i]!, menuItemId: l.item.itemId, variantId: l.item.variantId, qty: l.qty, addedAtDevice: (l.at ?? new Date()).toISOString() })),
  };
  const res = await asOrg(f.orgId, (tx) => P.addLines(tx, o.who ?? f.counter, input));
  return { lineIds, res };
}
interface LineRow { id: string; kind: string; name: string; qty: number; unit_price: string; kitchen_station_id: string | null; kitchen_status: string; menu_item_id: string; added_by: string; added_on_pairing_id: string | null; served_by: string | null }
const linesOf = (sessionId: string) => sql<LineRow[]>`
  select id, kind, name, qty, unit_price::text, kitchen_station_id, kitchen_status, menu_item_id, added_by, added_on_pairing_id, served_by
    from table_session_lines where session_id = ${sessionId} order by added_at, id`;
const liveLines = async (sessionId: string) => (await linesOf(sessionId)).filter((l) => l.kitchen_status !== 'cancelled');
const sessionRow = async (sessionId: string) =>
  (await sql<{ status: string; mode: string; stand_id: string | null; heads_cashier: number; heads_server: number | null; voided_by: string | null; void_reason: string | null; voided_offline: boolean; voided_at_device: Date | null }[]>`
    select status, mode, stand_id, heads_cashier, heads_server, voided_by, void_reason, voided_offline, voided_at_device from table_sessions where id = ${sessionId}`)[0]!;
const discountsOf = (lineId: string) => sql<{ id: string; kind: string; value: string; value_type: string; qty: number; diner_no: number | null; status: string; removed_by: string | null; preset_id: string | null }[]>`
  select id, kind, value::text, value_type, qty, diner_no, status, removed_by, preset_id from table_session_line_discounts where session_line_id = ${lineId} order by applied_at_device, id`;
const stateVersion = async (f: Fx) => Number((await sql<{ v: string }[]>`select state_version::text v from pos_stores where store_id = ${f.storeId}`)[0]!.v);
interface AuditRow { action: string; store_id: string | null; entity_id: string; source: string; actor_person_id: string | null; device_id: string | null; sensitivity: string; occurred_at: Date; before: unknown; after: unknown }
const audits = (f: Fx, action: string) => sql<AuditRow[]>`
  select action, store_id, entity_id, source, actor_person_id, device_id, sensitivity, occurred_at, before, after
    from audit_log where org_id = ${f.orgId} and action = ${action} order by recorded_at, id`;
const receiptOf = async (sessionId: string) =>
  (await sql<{ id: string; terminal_id: string; receipt_seq: number; cashier_id: string; subtotal: string; discount_total: string; total: string; device_total: string; offline: boolean }[]>`
    select id, terminal_id, receipt_seq, cashier_id, subtotal::text, discount_total::text, total::text, device_total::text, offline from pos_sales_receipts where table_session_id = ${sessionId}`)[0];
const receiptLines = (receiptId: string) => sql<{ id: string; line_no: number; kind: string; name: string; qty: number; unit_price: string; gross: string; discount_total: string; net: string; session_line_id: string | null }[]>`
  select id, line_no, kind, name, qty, unit_price::text, gross::text, discount_total::text, net::text, session_line_id from pos_sales_receipt_lines where receipt_id = ${receiptId} order by line_no`;
const receiptPayments = (receiptId: string) => sql<{ tender_id: string; amount: string; change_given: string; reference_no: string | null; to_check: boolean }[]>`
  select tender_id, amount::text, change_given::text, reference_no, to_check from pos_sales_receipt_payments where receipt_id = ${receiptId} order by id`;
const receiptLineDiscounts = (receiptId: string) => sql<{ kind: string; label: string; qty: number; diner_no: number | null; vat_removed: string; discount_amount: string; statutory_record_id: string | null; preset_id: string | null; receipt_line_id: string }[]>`
  select d.kind, d.label, d.qty, d.diner_no, d.vat_removed::text, d.discount_amount::text, d.statutory_record_id, d.preset_id, d.receipt_line_id
    from pos_sales_receipt_line_discounts d join pos_sales_receipt_lines l on l.id = d.receipt_line_id where l.receipt_id = ${receiptId} order by d.id`;
const printedNumber = (f: Fx, seq: number, terminalNo = 1) => `${f.storeCode}-${String(terminalNo).padStart(2, '0')}-${String(seq).padStart(6, '0')}`;

async function discount(f: Fx, lineId: string, o: { kind: 'senior' | 'pwd' | 'preset' | 'custom'; qty: number; presetId?: string; valueType?: string; value?: string; dinerNo?: number; who?: Actor; discountId?: string; pairingId?: string | null }) {
  const discountId = o.discountId ?? uuid();
  const input = {
    storeId: f.storeId, pairingId: o.pairingId === undefined ? f.pairingId : o.pairingId, discountId, lineId, kind: o.kind, qty: o.qty,
    ...(o.presetId ? { presetId: o.presetId } : {}), ...(o.valueType ? { valueType: o.valueType } : {}), ...(o.value ? { value: o.value } : {}),
    ...(o.dinerNo !== undefined ? { dinerNo: o.dinerNo } : {}), appliedAtDevice: nowIso(),
  };
  const res = await asOrg(f.orgId, (tx) => P.addLineDiscount(tx, o.who ?? f.counter, input, RATES));
  return { discountId, res };
}
const senior = (f: Fx, lineId: string, dinerNo = 1, kind: 'senior' | 'pwd' = 'senior') => discount(f, lineId, { kind, qty: 1, dinerNo });

/** The tablet's own figures, computed here from the DB lines and the discount totals per line (cents). Honest unless a test tampers. */
async function deviceFor(sessionId: string, discountByLine: Record<string, string> = {}) {
  const lines = (await liveLines(sessionId)).map((l) => {
    const gross = cents(l.unit_price) * l.qty;
    const dt = cents(discountByLine[l.id] ?? '0');
    return { lineId: l.id, gross: fmt(gross), discountTotal: fmt(dt), net: fmt(gross - dt) };
  });
  const subtotal = lines.reduce((a, l) => a + cents(l.gross), 0);
  const discountTotal = lines.reduce((a, l) => a + cents(l.discountTotal), 0);
  return { subtotal: fmt(subtotal), discountTotal: fmt(discountTotal), total: fmt(subtotal - discountTotal), lines };
}
async function saleInput(f: Fx, sessionId: string, over: Record<string, unknown> = {}, discountByLine: Record<string, string> = {}) {
  const device = await deviceFor(sessionId, discountByLine);
  return {
    storeId: f.storeId, pairingId: f.pairingId, sessionId, receiptId: uuid(), terminalNo: 1, terminalSeq: ++terminalSeq, issuedAtDevice: nowIso(), offline: false,
    device, payments: [{ tenderId: f.cash, amount: device.total, toCheck: false }], seniors: [] as unknown[], ...over,
  };
}
const complete = (f: Fx, input: unknown, o: { who?: Actor; deps?: Deps } = {}) =>
  asOrg(f.orgId, (tx) => P.completeSale(tx, o.who ?? f.counter, input, o.deps ?? RATES));
const seniorEntry = (dinerNo: number, kind: 'senior' | 'pwd' = 'senior', holderName = HOLDER, idNumber = IDNO) => ({ dinerNo, kind, idNumber, holderName });

/** pork x2 = 500.00 (small, easy numbers for payment cases). */
async function porkSession(f: Fx) {
  const s = await open(f, { heads: 2 });
  const { lineIds } = await add(f, s.sessionId, [{ item: f.menu.pork, qty: 2 }]);
  return { ...s, porkLine: lineIds[0]! };
}
/** unli x heads (449.00 each) + pork x2 (250.00 each). */
async function fullSession(f: Fx, heads = 4) {
  const s = await open(f, { heads });
  const { lineIds } = await add(f, s.sessionId, [{ item: f.menu.unli, qty: heads }, { item: f.menu.pork, qty: 2 }]);
  return { ...s, pkgLine: lineIds[0]!, porkLine: lineIds[1]! };
}

// ==============================================================================================================================
describe('fixture sanity (runs now: proves the menu, the stations and the POS rows are what the cases below assume)', () => {
  it('the store menu projects as designed: package, bundle, dishes and refills orderable with a station; notOnPos / not offered / outside hours as intended', async () => {
    const f = await fixture();
    const at = new Date();
    const { menu } = (await asOrg(f.orgId, (tx) => loadStoreMenu(tx, f.orgId, f.storeId, at))) as unknown as {
      menu: { items: { id: string; stationId: string | null; variants: { channels: { store: Record<string, unknown> }; refillItemIds: string[] }[] }[]; notOnPos: { itemId: string }[] };
    };
    const byId = new Map(menu.items.map((i) => [i.id, i]));
    for (const [name, it] of Object.entries({ unli: f.menu.unli, family: f.menu.family, pork: f.menu.pork, cola: f.menu.cola, refillRice: f.menu.refillRice })) {
      const item = byId.get(it.itemId);
      expect(item, `${name} is on the menu`).toBeDefined();
      expect(item!.stationId, `${name} has a station`).not.toBeNull();
      expect(item!.variants[0]!.channels.store, `${name} orderable`).toMatchObject({ orderable: true });
    }
    expect(byId.get(f.menu.family.itemId)!.variants[0]!.channels.store).toMatchObject({ amount: '1200.00', bundleHeads: 6, extraHeadAmount: '199.00' });
    expect(byId.get(f.menu.unli.itemId)!.variants[0]!.refillItemIds.sort()).toEqual([f.menu.refillRice.itemId, f.menu.refillPork.itemId].sort());
    expect(menu.notOnPos.map((n) => n.itemId)).toContain(f.menu.noStation.itemId);
    expect(byId.has(f.menu.noStation.itemId)).toBe(false);
    expect(byId.has(f.menu.unoffered.itemId), 'an item with no store offer is not on the POS menu').toBe(false);
    // the off-hours special is outside its one-hour window right now
    expect(byId.get(f.menu.lunchOnly.itemId)!.variants[0]!.channels.store).toMatchObject({ orderable: false, notOffered: 'outside_hours' });
  });

  it('the POS rows exist: store mode, two live pairings (one per store) plus a revoked one, a terminal 1, stands, tenders and presets', async () => {
    const f = await fixture('live');
    const [s] = await sql<{ mode: string; state_version: string }[]>`select mode, state_version::text from pos_stores where store_id = ${f.storeId}`;
    expect(s).toEqual({ mode: 'live', state_version: '0' });
    expect((await sql`select 1 from pos_terminals where store_id = ${f.storeId} and terminal_no = 1 and pairing_id = ${f.pairingId}`).length).toBe(1);
    expect((await sql`select 1 from tenders where store_id = ${f.storeId} and is_active`).length).toBe(2);
  });
});

// ==============================================================================================================================
describe('R1 / test 2 - the store must be switched on and the tablet must belong to it', () => {
  it('mode off refuses EVERY write with the one sentence; nothing is written', async () => {
    const f = await fixture();
    // build real rows while the store is on, then switch it off
    const s = await fullSession(f);
    const d = await discount(f, s.porkLine, { kind: 'preset', qty: 1, presetId: f.emp10 });
    await sql`update pos_stores set mode = 'off', live_from = null where store_id = ${f.storeId}`;
    const before = { sv: await stateVersion(f), lines: (await linesOf(s.sessionId)).length };
    const st2 = await newStand(f);
    const who = f.admin; // holds every capability, so the refusal is the mode, not a capability
    const base = { storeId: f.storeId, pairingId: f.pairingId };
    const live = (await liveLines(s.sessionId)).find((l) => l.kind === 'item')!;
    const calls: [string, () => Promise<unknown>][] = [
      ['openStand', () => asOrg(f.orgId, (tx) => P.openStand(tx, who, { ...base, sessionId: uuid(), mode: 'dine_in', standId: st2.id, headsCashier: 2, openedAtDevice: nowIso() }))],
      ['addLines', () => add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }], { who })],
      ['confirmHeads', () => asOrg(f.orgId, (tx) => P.confirmHeads(tx, who, { ...base, sessionId: s.sessionId, headsServer: 5 }))],
      ['setHeadsCashier', () => asOrg(f.orgId, (tx) => P.setHeadsCashier(tx, who, { ...base, sessionId: s.sessionId, headsCashier: 5 }))],
      ['requestRefill', () => asOrg(f.orgId, (tx) => P.requestRefill(tx, who, { ...base, sessionId: s.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillPork.itemId, qty: 1, addedAtDevice: nowIso() }] }))],
      ['serveLine', () => asOrg(f.orgId, (tx) => P.serveLine(tx, who, { ...base, lineId: live.id, servedAtDevice: nowIso() }))],
      ['cancelLine', () => asOrg(f.orgId, (tx) => P.cancelLine(tx, who, { ...base, lineId: live.id, reason: 'Customer changed mind' }))],
      ['addLineDiscount', () => discount(f, live.id, { kind: 'preset', qty: 1, presetId: f.promo50, who })],
      ['removeLineDiscount', () => asOrg(f.orgId, (tx) => P.removeLineDiscount(tx, who, { ...base, discountId: d.discountId, removedAtDevice: nowIso() }))],
      ['applyPresetToAllLines', () => asOrg(f.orgId, (tx) => P.applyPresetToAllLines(tx, who, { ...base, sessionId: s.sessionId, presetId: f.emp10, applyId: uuid(), appliedAtDevice: nowIso() }))],
      ['voidUnpaidSession', () => asOrg(f.orgId, (tx) => P.voidUnpaidSession(tx, who, { ...base, sessionId: s.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false }))],
      ['completeSale', async () => complete(f, await saleInput(f, s.sessionId), { who })],
    ];
    for (const [name, call] of calls) {
      const msg = await expectRefusal(call(), NOT_ON_SENTENCE).then(() => 'ok', (e: Error) => `${name}: ${e.message}`);
      expect(msg, name).toBe('ok');
    }
    expect({ sv: await stateVersion(f), lines: (await linesOf(s.sessionId)).length }).toEqual(before);
    expect((await sessionRow(s.sessionId)).status).toBe('open');
  });

  it('modes test and live both allow writes', async () => {
    const t = await fixture('test');
    expect((await open(t)).res).toMatchObject({ wrote: true });
    const l = await fixture('live');
    expect((await open(l)).res).toMatchObject({ wrote: true });
  });

  it('a pairing of another store, a revoked pairing and a null pairing on a till-only write are refused', async () => {
    const f = await fixture();
    const stand = await newStand(f);
    const input = (pairingId: string | null) => ({ storeId: f.storeId, pairingId, sessionId: uuid(), mode: 'dine_in', standId: stand.id, headsCashier: 2, openedAtDevice: nowIso() });
    await expectAnyRefusal(asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, input(f.pairingB))));
    await expectAnyRefusal(asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, input(f.pairingRevoked))));
    await expectAnyRefusal(asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, input(null))));
    expect((await sql`select 1 from table_sessions where store_id = ${f.storeId}`).length).toBe(0);
  });

  it('phone ok: addLines, confirmHeads, requestRefill and serveLine accept pairingId null; the till-only writes do not', async () => {
    const f = await fixture();
    const s = await fullSession(f);
    const phoneAdd = await add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }], { who: f.admin, pairingId: null });
    expect(phoneAdd.res).toMatchObject({ wrote: true });
    const colaLine = (await linesOf(s.sessionId)).find((l) => l.id === phoneAdd.lineIds[0])!;
    expect(colaLine.added_on_pairing_id).toBeNull();
    await asOrg(f.orgId, (tx) => P.confirmHeads(tx, f.admin, { storeId: f.storeId, pairingId: null, sessionId: s.sessionId, headsServer: 4 }));
    await asOrg(f.orgId, (tx) =>
      P.requestRefill(tx, f.admin, { storeId: f.storeId, pairingId: null, sessionId: s.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() }] }),
    );
    await asOrg(f.orgId, (tx) => P.serveLine(tx, f.admin, { storeId: f.storeId, pairingId: null, lineId: colaLine.id, servedAtDevice: nowIso() }));
    const base = { storeId: f.storeId, pairingId: null };
    await expectAnyRefusal(asOrg(f.orgId, (tx) => P.setHeadsCashier(tx, f.admin, { ...base, sessionId: s.sessionId, headsCashier: 6 })));
    await expectAnyRefusal(asOrg(f.orgId, (tx) => P.cancelLine(tx, f.admin, { ...base, lineId: s.porkLine, reason: 'Customer changed mind' })));
    await expectAnyRefusal(discount(f, s.porkLine, { kind: 'preset', qty: 1, presetId: f.emp10, who: f.admin, pairingId: null }));
    await expectAnyRefusal(asOrg(f.orgId, (tx) => P.applyPresetToAllLines(tx, f.admin, { ...base, sessionId: s.sessionId, presetId: f.emp10, applyId: uuid(), appliedAtDevice: nowIso() })));
    await expectAnyRefusal(asOrg(f.orgId, (tx) => P.voidUnpaidSession(tx, f.admin, { ...base, sessionId: s.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false })));
    await expectAnyRefusal(saleInput(f, s.sessionId, { pairingId: null }).then((i) => complete(f, i, { who: f.admin })));
  });
});

// ==============================================================================================================================
describe('R3 / test 3 - openStand', () => {
  it('opens a dine-in session on a free stand: one open row, heads, opener, the stand_opened audit row from the till', async () => {
    const f = await fixture();
    const st = await newStand(f);
    const sessionId = uuid();
    const device = new Date(Date.now() - 3600e3);
    const res = await asOrg(f.orgId, (tx) =>
      P.openStand(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId, mode: 'dine_in', standId: st.id, headsCashier: 5, openedAtDevice: device.toISOString() }),
    );
    expect(res).toMatchObject({ wrote: true });
    expect(await sessionRow(sessionId)).toMatchObject({ status: 'open', mode: 'dine_in', stand_id: st.id, heads_cashier: 5, heads_server: null });
    const [row] = await sql<{ opened_by: string; opened_on_pairing_id: string }[]>`select opened_by, opened_on_pairing_id from table_sessions where id = ${sessionId}`;
    expect(row).toEqual({ opened_by: f.counter.personId, opened_on_pairing_id: f.pairingId });
    const [a] = await audits(f, 'pos.stand_opened');
    expect(a, 'pos.stand_opened written').toBeDefined();
    expect(a).toMatchObject({ source: 'pos', actor_person_id: f.counter.personId, device_id: f.pairingId, store_id: f.storeId });
    expect(new Date(a!.occurred_at).getTime()).toBe(device.getTime());
  });

  it('a stand already in use: the plain sentence, and no second open session', async () => {
    const f = await fixture();
    const open7 = (sessionId: string) =>
      asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId, mode: 'dine_in', standId: f.stand7, headsCashier: 2, openedAtDevice: nowIso() }));
    await open7(uuid());
    await expectRefusal(open7(uuid()), 'Stand 7 is already in use.');
    expect((await sql`select 1 from table_sessions where stand_id = ${f.stand7} and status = 'open'`).length).toBe(1);
  });

  it('a retired stand, another store\'s stand and a dine-in with no stand are refused', async () => {
    const f = await fixture();
    const go = (extra: Record<string, unknown>) =>
      asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: uuid(), mode: 'dine_in', headsCashier: 2, openedAtDevice: nowIso(), ...extra }));
    await expectRefusal(go({ standId: f.standRetired }));
    await expectRefusal(go({ standId: f.standB }));
    await expectRefusal(go({}));
    expect((await sql`select 1 from table_sessions where store_id = ${f.storeId}`).length).toBe(0);
  });

  it('take-out has no stand and may have 0 heads; dine-in needs heads of at least 1', async () => {
    const f = await fixture();
    const t = await open(f, { mode: 'take_out' });
    expect(await sessionRow(t.sessionId)).toMatchObject({ status: 'open', mode: 'take_out', stand_id: null, heads_cashier: 0 });
    const st = await newStand(f);
    await expectRefusal(
      asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: uuid(), mode: 'dine_in', standId: st.id, headsCashier: 0, openedAtDevice: nowIso() })),
    );
  });

  it('idempotent by device id: the same sessionId with the same content writes nothing; different content is the "recorded differently" refusal', async () => {
    const f = await fixture();
    const st = await newStand(f);
    const input = { storeId: f.storeId, pairingId: f.pairingId, sessionId: uuid(), mode: 'dine_in', standId: st.id, headsCashier: 3, openedAtDevice: nowIso() };
    expect(await asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, input))).toMatchObject({ wrote: true });
    const v = await stateVersion(f);
    expect(await asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, input))).toMatchObject({ wrote: false });
    expect(await stateVersion(f)).toBe(v);
    await expectRefusal(asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, { ...input, headsCashier: 6 })), SAME_ID_SENTENCE);
    expect((await sessionRow(input.sessionId)).heads_cashier).toBe(3);
  });

  it('the first order can ride along: a package and an a-la-carte line together, priced by the server (row 358)', async () => {
    const f = await fixture();
    const st = await newStand(f);
    const sessionId = uuid();
    await asOrg(f.orgId, (tx) =>
      P.openStand(tx, f.counter, {
        storeId: f.storeId, pairingId: f.pairingId, sessionId, mode: 'dine_in', standId: st.id, headsCashier: 4, openedAtDevice: nowIso(),
        lines: [
          { lineId: uuid(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 4, addedAtDevice: nowIso() },
          { lineId: uuid(), menuItemId: f.menu.cola.itemId, variantId: f.menu.cola.variantId, qty: 2, addedAtDevice: nowIso() },
        ],
      }),
    );
    const lines = await linesOf(sessionId);
    expect(lines.map((l) => [l.kind, l.qty, l.unit_price])).toEqual([['package', 4, '449.00'], ['item', 2, '80.00']]);
  });

  it('a take-out session cannot take a package', async () => {
    const f = await fixture();
    const t = await open(f, { mode: 'take_out' });
    await expectRefusal(add(f, t.sessionId, [{ item: f.menu.unli, qty: 2 }]));
    expect((await linesOf(t.sessionId)).length).toBe(0);
  });
});

// ==============================================================================================================================
describe('R4 / test 4 - addLines: the server\'s menu decides', () => {
  it('a device-sent price and name are ignored: price, name, kind and station come from the menu', async () => {
    const f = await fixture();
    const s = await open(f);
    const lineId = uuid();
    await asOrg(f.orgId, (tx) =>
      P.addLines(tx, f.counter, {
        storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId,
        lines: [{ lineId, menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 3, note: 'well done', addedAtDevice: nowIso(), unitPrice: '1.00', name: 'Free pork', kind: 'refill', kitchenStationId: f.bar }],
      }),
    );
    const [l] = await linesOf(s.sessionId);
    expect(l).toMatchObject({ id: lineId, kind: 'item', qty: 3, unit_price: '250.00', kitchen_station_id: f.grill, kitchen_status: 'queued', added_by: f.counter.personId, added_on_pairing_id: f.pairingId });
    expect(l!.name).toContain('Pork belly');
    expect(l!.name).not.toContain('Free');
    expect((await audits(f, 'pos.lines_added')).length).toBe(1);
  });

  it('an item not on the store menu, an item outside its hours, and an item with no station are refused; nothing is written', async () => {
    const f = await fixture();
    const s = await open(f);
    await expectRefusal(add(f, s.sessionId, [{ item: f.menu.unoffered, qty: 1 }]));
    await expectRefusal(add(f, s.sessionId, [{ item: f.menu.noStation, qty: 1 }])); // notOnPos
    await expectRefusal(add(f, s.sessionId, [{ item: f.menu.lunchOnly, qty: 1 }])); // outside_hours
    expect((await linesOf(s.sessionId)).length).toBe(0);
  });

  it('a whole batch is all-or-nothing: one bad line refuses the lot', async () => {
    const f = await fixture();
    const s = await open(f);
    await expectRefusal(add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }, { item: f.menu.noStation, qty: 1 }]));
    expect((await linesOf(s.sessionId)).length).toBe(0);
  });

  it('qty must be a whole number of at least 1', async () => {
    const f = await fixture();
    const s = await open(f);
    await expectRefusal(add(f, s.sessionId, [{ item: f.menu.cola, qty: 0 }]));
    await expectRefusal(add(f, s.sessionId, [{ item: f.menu.cola, qty: -2 }]));
    await expectRefusal(add(f, s.sessionId, [{ item: f.menu.cola, qty: 1.5 }]));
  });

  it('per-head package: one package line, qty = heads, unit price = the amount', async () => {
    const f = await fixture();
    const s = await open(f, { heads: 6 });
    await add(f, s.sessionId, [{ item: f.menu.unli, qty: 6 }]);
    const lines = await linesOf(s.sessionId);
    expect(lines.map((l) => [l.kind, l.qty, l.unit_price, l.kitchen_station_id])).toEqual([['package', 6, '449.00', f.grill]]);
  });

  it('bundle "(up to 6)" for 8 heads: one package line qty 1 at the bundle amount named "(up to 6)", plus a package line of 2 extra heads at the extra-head amount', async () => {
    const f = await fixture();
    const s = await open(f, { heads: 8 });
    await add(f, s.sessionId, [{ item: f.menu.family, qty: 8 }]);
    const lines = await linesOf(s.sessionId);
    expect(lines.every((l) => l.kind === 'package')).toBe(true);
    expect(lines.map((l) => [l.qty, l.unit_price]).sort()).toEqual([[1, '1200.00'], [2, '199.00']].sort());
    expect(lines.find((l) => l.unit_price === '1200.00')!.name).toMatch(/up to 6/i);
  });

  it('F1: bundle_heads is a column written from the menu: a bundle line carries N, every other line null; a per-head package NAMED "(up to 4)" is NOT a bundle; the column is frozen', async () => {
    const f = await fixture();
    const b = await open(f, { heads: 8 });
    await add(f, b.sessionId, [{ item: f.menu.family, qty: 8 }]);
    const rows = await sql<{ id: string; qty: number; bundle_heads: number | null }[]>`select id, qty, bundle_heads from table_session_lines where session_id = ${b.sessionId} order by added_at`;
    expect(rows.map((r) => [r.qty, r.bundle_heads])).toEqual([[1, 6], [2, null]]);
    // the look-alike: per-head, 6 heads, name ends "(up to 4)"; its discount capacity is its QTY (6), not 4
    const s = await open(f, { heads: 6 });
    const { lineIds } = await add(f, s.sessionId, [{ item: f.menu.lookalike, qty: 6 }]);
    const [l] = await sql<{ name: string; qty: number; unit_price: string; bundle_heads: number | null }[]>`select name, qty, unit_price::text, bundle_heads from table_session_lines where id = ${lineIds[0]!}`;
    expect(l).toMatchObject({ qty: 6, unit_price: '300.00', bundle_heads: null });
    expect(l!.name).toMatch(/\(up to 4\)$/);
    expect((await discount(f, lineIds[0]!, { kind: 'preset', qty: 6, presetId: f.emp10 })).res).toMatchObject({ wrote: true });
    const bill = await asOrg(f.orgId, (tx) => P.getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId: s.sessionId }, RATES));
    expect(JSON.stringify(bill)).toContain('1800.00'); // 6 x 300.00, never read as a one-line bundle
    // frozen: the line guard refuses a rewrite (23001), and the CHECK refuses 0 and 201
    const err = await sql`update table_session_lines set bundle_heads = 3 where id = ${rows[0]!.id}`.then(() => null, (e: unknown) => e);
    expect((err as { code?: string }).code).toBe('23001');
    const err0 = await sql`insert into table_session_lines (org_id, store_id, session_id, kind, menu_item_id, name, qty, unit_price, bundle_heads, added_by, added_at_device) values (${f.orgId}, ${f.storeId}, ${s.sessionId}, 'package', ${f.menu.family.itemId}, 'x', 1, 1, 0, ${f.counter.personId}, now())`.then(() => null, (e: unknown) => e);
    expect((err0 as { code?: string }).code).toBe('23514');
  });

  it('ruling 3: the bundle\'s extra-head line id is DERIVED (uuidv5 of the first line id, "extra-heads"), so a replay writes nothing and makes no second pair', async () => {
    const f = await fixture();
    const s = await open(f, { heads: 8 });
    const { lineIds } = await add(f, s.sessionId, [{ item: f.menu.family, qty: 8 }]);
    const ids = (await linesOf(s.sessionId)).map((l) => l.id).sort();
    expect(ids).toEqual([lineIds[0]!, uuidv5('extra-heads', lineIds[0]!)].sort());
    const line = { lineId: lineIds[0]!, menuItemId: f.menu.family.itemId, variantId: f.menu.family.variantId, qty: 8, addedAtDevice: nowIso() };
    expect(await asOrg(f.orgId, (tx) => P.addLines(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, lines: [line] }))).toMatchObject({ wrote: false });
    expect(await linesOf(s.sessionId)).toHaveLength(2);
  });

  it('ruling 9: a chosen option adds the store\'s price delta to the unit price; a value of another item, a value with no store offer, or two choices in a single-choice group are refused', async () => {
    const f = await fixture();
    const s = await open(f);
    const withOpt = (optionValueIds: string[]) =>
      asOrg(f.orgId, (tx) =>
        P.addLines(tx, f.counter, {
          storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId,
          lines: [{ lineId: uuid(), menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 2, addedAtDevice: nowIso(), optionValueIds }],
        }),
      );
    await expectRefusal(withOpt([f.options.colaIce])); // another item's value
    await expectRefusal(withOpt([f.options.porkNoOffer])); // no store offer
    await expectRefusal(withOpt([f.options.porkLarge, f.options.porkNoOffer])); // two in a single-choice group
    expect(await linesOf(s.sessionId)).toHaveLength(0);
    await withOpt([f.options.porkLarge]);
    const [l] = await linesOf(s.sessionId);
    expect(l).toMatchObject({ qty: 2, unit_price: '280.00' }); // 250.00 + 30.00
  });

  it('T-527 ruling 3: getSessionBill lines also carry menuItemId and note, keep the stored name (which carries the chosen option), carry no optionLabels, and still omit a cancelled line', async () => {
    const f = await fixture();
    const s = await open(f);
    const [optLine, plainLine, goneLine] = [uuid(), uuid(), uuid()];
    const at = { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId };
    await asOrg(f.orgId, (tx) =>
      P.addLines(tx, f.counter, {
        ...at,
        lines: [
          { lineId: optLine, menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 1, note: 'no chili', addedAtDevice: nowIso(), optionValueIds: [f.options.porkLarge] },
          { lineId: plainLine, menuItemId: f.menu.cola.itemId, variantId: f.menu.cola.variantId, qty: 2, addedAtDevice: nowIso() },
          { lineId: goneLine, menuItemId: f.menu.cola.itemId, variantId: f.menu.cola.variantId, qty: 1, addedAtDevice: nowIso() },
        ],
      }),
    );
    await asOrg(f.orgId, (tx) => P.cancelLine(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, lineId: goneLine, reason: 'Wrong item' }));
    const optionName = (await sql<{ name: string }[]>`select name from menu_option_values where id = ${f.options.porkLarge}`)[0]!.name;
    const bill = await asOrg(f.orgId, (tx) => P.getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId: s.sessionId }, RATES));
    expect(bill.lines.map((l) => l.id).sort()).toEqual([optLine, plainLine].sort());
    const withOpt = bill.lines.find((l) => l.id === optLine)!;
    expect(withOpt).toMatchObject({ menuItemId: f.menu.pork.itemId, note: 'no chili' });
    expect(Object.keys(withOpt)).not.toContain('optionLabels');
    expect(withOpt.name).toContain(optionName);
    expect(bill.lines.find((l) => l.id === plainLine)).toMatchObject({ menuItemId: f.menu.cola.itemId, note: null });
  });

  it('bundle for 5 heads (fewer than 6): the single bundle line only', async () => {
    const f = await fixture();
    const s = await open(f, { heads: 5 });
    await add(f, s.sessionId, [{ item: f.menu.family, qty: 5 }]);
    expect((await linesOf(s.sessionId)).map((l) => [l.qty, l.unit_price])).toEqual([[1, '1200.00']]);
  });

  it('idempotent by lineId: same content writes nothing; different content is the "recorded differently" refusal; a closed session refuses', async () => {
    const f = await fixture();
    const s = await open(f);
    const line = { lineId: uuid(), menuItemId: f.menu.cola.itemId, variantId: f.menu.cola.variantId, qty: 2, addedAtDevice: nowIso() };
    const input = (l: object) => ({ storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, lines: [l] });
    expect(await asOrg(f.orgId, (tx) => P.addLines(tx, f.counter, input(line)))).toMatchObject({ wrote: true });
    expect(await asOrg(f.orgId, (tx) => P.addLines(tx, f.counter, input(line)))).toMatchObject({ wrote: false });
    await expectRefusal(asOrg(f.orgId, (tx) => P.addLines(tx, f.counter, input({ ...line, qty: 3 }))), SAME_ID_SENTENCE);
    expect(await linesOf(s.sessionId)).toHaveLength(1);
    await asOrg(f.orgId, (tx) => P.voidUnpaidSession(tx, f.admin, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false }));
    await expectRefusal(add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }]));
  });
});

// ==============================================================================================================================
describe('R5 / test 5 - heads, and the package line that follows them', () => {
  it('billed heads = greatest(heads_cashier, heads_server): a server count below the cashier\'s changes nothing on the bill', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await asOrg(f.orgId, (tx) => P.confirmHeads(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsServer: 3 }));
    expect((await sessionRow(s.sessionId)).heads_server).toBe(3);
    expect((await liveLines(s.sessionId)).filter((l) => l.kind === 'package').map((l) => [l.id, l.qty])).toEqual([[s.pkgLine, 4]]);
  });

  it('a higher server count re-makes the package line: old cancelled, new queued at the new qty; the dish line is untouched; heads_changed audited', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await asOrg(f.orgId, (tx) => P.confirmHeads(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsServer: 6 }));
    const all = await linesOf(s.sessionId);
    expect(all.find((l) => l.id === s.pkgLine)!.kitchen_status).toBe('cancelled');
    const live = all.filter((l) => l.kind === 'package' && l.kitchen_status !== 'cancelled');
    expect(live.map((l) => [l.qty, l.unit_price, l.kitchen_status])).toEqual([[6, '449.00', 'queued']]);
    expect(all.find((l) => l.id === s.porkLine)).toMatchObject({ qty: 2, kitchen_status: 'queued' });
    expect((await audits(f, 'pos.heads_changed')).length).toBeGreaterThanOrEqual(1);
  });

  it('the cashier raising heads past the server\'s count re-makes it too (setHeadsCashier, record_sale)', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await asOrg(f.orgId, (tx) => P.confirmHeads(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsServer: 6 }));
    await asOrg(f.orgId, (tx) => P.setHeadsCashier(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsCashier: 7 }));
    expect((await sessionRow(s.sessionId)).heads_cashier).toBe(7);
    expect((await liveLines(s.sessionId)).filter((l) => l.kind === 'package').map((l) => l.qty)).toEqual([7]);
  });

  it('a package line that was already SERVED is not re-made: it stays, and the difference goes on a new package line', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await asOrg(f.orgId, (tx) => P.serveLine(tx, f.kitchen, { storeId: f.storeId, pairingId: f.pairingId, lineId: s.pkgLine, servedAtDevice: nowIso() }));
    await asOrg(f.orgId, (tx) => P.confirmHeads(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsServer: 6 }));
    const pk = (await linesOf(s.sessionId)).filter((l) => l.kind === 'package');
    expect(pk.find((l) => l.id === s.pkgLine)).toMatchObject({ kitchen_status: 'served', qty: 4 });
    const live = pk.filter((l) => l.kitchen_status !== 'cancelled');
    expect(live.reduce((a, l) => a + l.qty, 0)).toBe(6);
    expect(live).toHaveLength(2);
  });

  it('discounts on the cancelled package line are removed with it; the new line starts with none', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const { discountId } = await senior(f, s.pkgLine, 1);
    await asOrg(f.orgId, (tx) => P.confirmHeads(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsServer: 6 }));
    const [d] = await discountsOf(s.pkgLine);
    expect(d).toMatchObject({ id: discountId, status: 'removed' });
    expect(d!.removed_by).not.toBeNull();
    const newLine = (await liveLines(s.sessionId)).find((l) => l.kind === 'package')!;
    expect(await discountsOf(newLine.id)).toHaveLength(0);
  });

  it('ruling 1: a heads DECREASE is refused while a package line is served (sentence, nothing changes); with nothing served the line is re-made at the lower count', async () => {
    const f = await fixture();
    const a = await fullSession(f, 4);
    await asOrg(f.orgId, (tx) => P.setHeadsCashier(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: a.sessionId, headsCashier: 3 }));
    expect((await liveLines(a.sessionId)).filter((l) => l.kind === 'package').map((l) => l.qty)).toEqual([3]);
    const b = await fullSession(f, 4);
    await asOrg(f.orgId, (tx) => P.serveLine(tx, f.kitchen, { storeId: f.storeId, pairingId: f.pairingId, lineId: b.pkgLine, servedAtDevice: nowIso() }));
    const v = await stateVersion(f);
    await expectRefusal(
      asOrg(f.orgId, (tx) => P.setHeadsCashier(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: b.sessionId, headsCashier: 3 })),
      'The package was already served. Void the stand or keep the heads.',
    );
    expect((await sessionRow(b.sessionId)).heads_cashier).toBe(4);
    expect((await liveLines(b.sessionId)).filter((l) => l.kind === 'package').map((l) => l.qty)).toEqual([4]);
    expect(await stateVersion(f)).toBe(v);
  });

  it('F2: a heads DECREASE that would leave more senior/PWD guests than heads is refused with the sentence; nothing changes', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await senior(f, s.pkgLine, 1);
    await senior(f, s.pkgLine, 2, 'pwd');
    const v = await stateVersion(f);
    await expectRefusal(
      asOrg(f.orgId, (tx) => P.setHeadsCashier(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsCashier: 1 })),
      'Remove a senior/PWD discount first: there would be more senior/PWD guests than heads.',
    );
    expect((await sessionRow(s.sessionId)).heads_cashier).toBe(4);
    expect((await discountsOf(s.pkgLine)).filter((d) => d.status === 'active')).toHaveLength(2);
    expect(await stateVersion(f)).toBe(v);
    // at 2 heads the two guests still fit: allowed (the package line is re-made and its discounts go with it, as before)
    await asOrg(f.orgId, (tx) => P.setHeadsCashier(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsCashier: 2 }));
    expect((await sessionRow(s.sessionId)).heads_cashier).toBe(2);
  });

  it('heads can only change while the session is open', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await asOrg(f.orgId, (tx) => P.voidUnpaidSession(tx, f.admin, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false }));
    await expectRefusal(asOrg(f.orgId, (tx) => P.confirmHeads(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsServer: 9 })));
    await expectRefusal(asOrg(f.orgId, (tx) => P.setHeadsCashier(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, headsCashier: 9 })));
  });

  it('serveLine: queued -> served, by the actor; allowed on a paid session (late serve); cancelLine is not', async () => {
    const f = await fixture();
    const s = await porkSession(f);
    await asOrg(f.orgId, (tx) => P.serveLine(tx, f.kitchen, { storeId: f.storeId, pairingId: f.pairingId, lineId: s.porkLine, servedAtDevice: nowIso() }));
    expect((await linesOf(s.sessionId))[0]).toMatchObject({ kitchen_status: 'served', served_by: f.kitchen.personId });
    expect((await audits(f, 'pos.line_served')).length).toBe(1);
    // a second line, still queued, when the sale closes
    const cola = await add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }]);
    await complete(f, await saleInput(f, s.sessionId));
    expect((await sessionRow(s.sessionId)).status).toBe('paid');
    await asOrg(f.orgId, (tx) => P.serveLine(tx, f.kitchen, { storeId: f.storeId, pairingId: f.pairingId, lineId: cola.lineIds[0], servedAtDevice: nowIso() }));
    expect((await linesOf(s.sessionId)).find((l) => l.id === cola.lineIds[0])!.kitchen_status).toBe('served');
    await expectRefusal(asOrg(f.orgId, (tx) => P.cancelLine(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, lineId: cola.lineIds[0], reason: 'Customer changed mind' })));
  });

  it('cancelLine: queued only, open session only, reason 3-200 characters kept in the audit row', async () => {
    const f = await fixture();
    const s = await porkSession(f);
    const cola = await add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }, { item: f.menu.cola, qty: 2 }]);
    const cancel = (lineId: string, reason: string) => asOrg(f.orgId, (tx) => P.cancelLine(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, lineId, reason }));
    await expectRefusal(cancel(cola.lineIds[0]!, 'no'));
    await expectRefusal(cancel(cola.lineIds[0]!, 'x'.repeat(201)));
    await cancel(cola.lineIds[0]!, 'Customer changed mind');
    expect((await linesOf(s.sessionId)).find((l) => l.id === cola.lineIds[0])!.kitchen_status).toBe('cancelled');
    const [a] = await audits(f, 'pos.line_cancelled');
    expect(JSON.stringify([a!.before, a!.after])).toContain('Customer changed mind');
    // served lines cannot be cancelled
    await asOrg(f.orgId, (tx) => P.serveLine(tx, f.kitchen, { storeId: f.storeId, pairingId: f.pairingId, lineId: cola.lineIds[1], servedAtDevice: nowIso() }));
    await expectRefusal(cancel(cola.lineIds[1]!, 'Customer changed mind'));
  });
});

// ==============================================================================================================================
describe('R5 / test 6 - refills', () => {
  it('a refill of an item in the package is accepted: kind refill, price 0, queued at its station, audited', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const lineId = uuid();
    await asOrg(f.orgId, (tx) =>
      P.requestRefill(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, lines: [{ lineId, menuItemId: f.menu.refillPork.itemId, qty: 2, addedAtDevice: nowIso() }] }),
    );
    const l = (await linesOf(s.sessionId)).find((x) => x.id === lineId)!;
    expect(l).toMatchObject({ kind: 'refill', qty: 2, unit_price: '0.00', kitchen_status: 'queued', kitchen_station_id: f.grill });
    expect((await audits(f, 'pos.refill_requested')).length).toBe(1);
  });

  it('a refill of an item NOT in the session\'s package is refused; so is any item that is not a refill at all; so is a session with no package', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const refill = (sessionId: string, item: Item) =>
      asOrg(f.orgId, (tx) =>
        P.requestRefill(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId, lines: [{ lineId: uuid(), menuItemId: item.itemId, qty: 1, addedAtDevice: nowIso() }] }),
      );
    await expectRefusal(refill(s.sessionId, f.menu.refillNoodles));
    await expectRefusal(refill(s.sessionId, f.menu.pork)); // an a-la-carte dish is not a refill
    const noPackage = await porkSession(f);
    await expectRefusal(refill(noPackage.sessionId, f.menu.refillRice));
    expect((await linesOf(s.sessionId)).filter((l) => l.kind === 'refill')).toHaveLength(0);
    expect((await linesOf(noPackage.sessionId)).filter((l) => l.kind === 'refill')).toHaveLength(0);
  });
});

describe('F6 - a replay is answered before the table is judged', () => {
  it('requestRefill and cancelLine written before the sale was paid return wrote false when replayed after it; a NEW refill after payment is still refused', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const refill = { lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() };
    const doRefill = (r: typeof refill) => asOrg(f.orgId, (tx) => P.requestRefill(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, lines: [r] }));
    expect(await doRefill(refill)).toMatchObject({ wrote: true });
    const cola = await add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }]);
    const cancel = () => asOrg(f.orgId, (tx) => P.cancelLine(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, lineId: cola.lineIds[0]!, reason: 'Customer changed mind' }));
    expect(await cancel()).toMatchObject({ wrote: true });
    await complete(f, await saleInput(f, s.sessionId));
    expect((await sessionRow(s.sessionId)).status).toBe('paid');
    const v = await stateVersion(f);
    expect(await doRefill(refill)).toMatchObject({ wrote: false });
    expect(await cancel()).toMatchObject({ wrote: false });
    expect(await stateVersion(f)).toBe(v);
    await expectRefusal(doRefill({ ...refill, lineId: uuid() })); // a different id: a new refill on a paid table
    await expectRefusal(doRefill({ ...refill, qty: 2 }), SAME_ID_SENTENCE); // same id, different content
  });
});

// ==============================================================================================================================
describe('R6 / test 7 - per-line discounts', () => {
  it('a line\'s active discounts never cover more than its qty; the conflict is refused with how many units are free', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4); // pork x2
    await expectRefusal(discount(f, s.porkLine, { kind: 'preset', qty: 3, presetId: f.emp10 }));
    await discount(f, s.porkLine, { kind: 'preset', qty: 1, presetId: f.emp10 });
    await expectRefusal(discount(f, s.porkLine, { kind: 'preset', qty: 2, presetId: f.promo50 }), undefined).then((m) => expect(m).toMatch(/\b1\b/));
    await discount(f, s.porkLine, { kind: 'preset', qty: 1, presetId: f.promo50 });
    await expectRefusal(discount(f, s.porkLine, { kind: 'custom', qty: 1, valueType: 'percent', value: '5' }), undefined).then((m) => expect(m).toMatch(/\b0\b|no unit|none/i));
    expect((await discountsOf(s.porkLine)).filter((d) => d.status === 'active')).toHaveLength(2);
  });

  it('a unit covered by senior/PWD carries no other discount, and the reverse: refused with the free units', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4); // package x4
    // a preset on every unit first -> a senior has no free unit
    const all = await discount(f, s.pkgLine, { kind: 'preset', qty: 4, presetId: f.emp10 });
    await expectRefusal(senior(f, s.pkgLine, 1), undefined).then((m) => expect(m).toMatch(/free|\b0\b/i));
    await asOrg(f.orgId, (tx) => P.removeLineDiscount(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, discountId: all.discountId, removedAtDevice: nowIso() }));
    // a senior first -> a preset can take only the other 3
    await senior(f, s.pkgLine, 1);
    await expectRefusal(discount(f, s.pkgLine, { kind: 'preset', qty: 4, presetId: f.emp10 }), undefined).then((m) => expect(m).toMatch(/\b3\b/));
    await discount(f, s.pkgLine, { kind: 'preset', qty: 3, presetId: f.emp10 });
    expect((await discountsOf(s.pkgLine)).filter((d) => d.status === 'active').map((d) => [d.kind, d.qty])).toEqual([['senior', 1], ['preset', 3]]);
  });

  it('two seniors on one table need two diner numbers, each on its own head; a senior needs a dinerNo', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await expectRefusal(discount(f, s.pkgLine, { kind: 'senior', qty: 1 })); // no dinerNo
    await senior(f, s.pkgLine, 1);
    await senior(f, s.pkgLine, 2, 'pwd');
    expect((await discountsOf(s.pkgLine)).map((d) => [d.kind, d.diner_no, d.qty])).toEqual([['senior', 1, 1], ['pwd', 2, 1]]);
  });

  it('a preset takes its value and type from the store\'s active preset (the device cannot say otherwise); custom takes the input within its limits', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4); // pork 250.00
    const p = await discount(f, s.porkLine, { kind: 'preset', qty: 1, presetId: f.emp10, valueType: 'fixed', value: '99' });
    const q = await discount(f, s.pkgLine, { kind: 'preset', qty: 1, presetId: f.promo50 });
    const c = await discount(f, s.porkLine, { kind: 'custom', qty: 1, valueType: 'percent', value: '15' });
    const get = async (lineId: string, id: string) => (await discountsOf(lineId)).find((d) => d.id === id)!;
    expect(await get(s.porkLine, p.discountId)).toMatchObject({ kind: 'preset', value_type: 'percent', value: '10.00', preset_id: f.emp10 });
    expect(await get(s.pkgLine, q.discountId)).toMatchObject({ value_type: 'fixed', value: '50.00', preset_id: f.promo50 });
    expect(await get(s.porkLine, c.discountId)).toMatchObject({ kind: 'custom', value_type: 'percent', value: '15.00', preset_id: null });
  });

  it('custom limits: percent 0-100, fixed no more than the unit price; a retired preset and another store\'s preset are refused', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await expectRefusal(discount(f, s.porkLine, { kind: 'custom', qty: 1, valueType: 'percent', value: '101' }));
    await expectRefusal(discount(f, s.porkLine, { kind: 'custom', qty: 1, valueType: 'percent', value: '0' }));
    await expectRefusal(discount(f, s.porkLine, { kind: 'custom', qty: 1, valueType: 'fixed', value: '250.01' }));
    await discount(f, s.porkLine, { kind: 'custom', qty: 1, valueType: 'fixed', value: '250.00' });
    await expectRefusal(discount(f, s.pkgLine, { kind: 'preset', qty: 1, presetId: f.presetRetired }));
    await expectRefusal(discount(f, s.pkgLine, { kind: 'preset', qty: 1, presetId: f.presetB }));
    expect(await discountsOf(s.pkgLine)).toHaveLength(0);
  });

  it('any cashier may add or remove, no PIN (row 440); removing frees the units and is audited; the same discountId twice writes once', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const d = await discount(f, s.porkLine, { kind: 'preset', qty: 2, presetId: f.emp10, who: f.counter });
    expect(d.res).toMatchObject({ wrote: true });
    const again = await discount(f, s.porkLine, { kind: 'preset', qty: 2, presetId: f.emp10, discountId: d.discountId });
    expect(again.res).toMatchObject({ wrote: false });
    await expectRefusal(discount(f, s.porkLine, { kind: 'preset', qty: 1, presetId: f.emp10, discountId: d.discountId }), SAME_ID_SENTENCE);
    await asOrg(f.orgId, (tx) => P.removeLineDiscount(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, discountId: d.discountId, removedAtDevice: nowIso() }));
    expect(await discountsOf(s.porkLine)).toMatchObject([{ id: d.discountId, status: 'removed', removed_by: f.counter.personId }]);
    await discount(f, s.porkLine, { kind: 'preset', qty: 2, presetId: f.promo50 });
    expect((await audits(f, 'pos.discount_added')).length).toBeGreaterThanOrEqual(2);
    expect((await audits(f, 'pos.discount_removed')).length).toBe(1);
  });

  it('"apply to all lines": one discount per line over every unit not already covered; lines with no free unit are skipped and counted', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4); // package x4, pork x2
    const cola = await add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }]);
    await senior(f, s.pkgLine, 1); // 1 of 4 package units covered
    await discount(f, s.porkLine, { kind: 'preset', qty: 2, presetId: f.promo50 }); // pork full
    const res = await asOrg(f.orgId, (tx) =>
      P.applyPresetToAllLines(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, presetId: f.emp10, applyId: uuid(), appliedAtDevice: nowIso() }),
    );
    expect(res).toMatchObject({ applied: 2, skipped: 1 });
    expect((await discountsOf(s.pkgLine)).filter((d) => d.status === 'active').map((d) => [d.kind, d.qty])).toEqual([['senior', 1], ['preset', 3]]);
    expect((await discountsOf(s.porkLine)).filter((d) => d.status === 'active').map((d) => [d.kind, d.qty])).toEqual([['preset', 2]]);
    expect((await discountsOf(cola.lineIds[0]!)).map((d) => [d.kind, d.qty, d.preset_id])).toEqual([['preset', 1, f.emp10]]);
  });

  it('ruling 6: apply-to-all derives each discount id from applyId and the line id; the same applyId again writes nothing', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const applyId = uuid();
    const run = () =>
      asOrg(f.orgId, (tx) => P.applyPresetToAllLines(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, presetId: f.emp10, applyId, appliedAtDevice: nowIso() }));
    expect(await run()).toMatchObject({ wrote: true, applied: 2, skipped: 0 });
    expect((await discountsOf(s.pkgLine))[0]!.id).toBe(uuidv5(s.pkgLine, applyId));
    expect((await discountsOf(s.porkLine))[0]!.id).toBe(uuidv5(s.porkLine, applyId));
    const v = await stateVersion(f);
    expect(await run()).toMatchObject({ wrote: false, applied: 2, skipped: 0 });
    expect(await stateVersion(f)).toBe(v);
    expect(await discountsOf(s.pkgLine)).toHaveLength(1);
  });

  it('ruling 10: on the package a diner gets ONE head (one unit, once) and never more seniors than guests; on a dish any units the cashier marks with a dinerNo; one card kind per diner', async () => {
    const f = await fixture();
    const s = await fullSession(f, 2); // package x2, pork x2
    await expectRefusal(discount(f, s.pkgLine, { kind: 'senior', qty: 2, dinerNo: 1 })); // one head per diner on the package
    await senior(f, s.pkgLine, 1);
    await expectRefusal(senior(f, s.pkgLine, 1)); // diner 1 already has their head
    await expectRefusal(senior(f, s.pkgLine, 1, 'pwd')); // and one card kind per diner
    await senior(f, s.pkgLine, 2, 'pwd');
    await expectRefusal(senior(f, s.pkgLine, 3)); // two heads, two seniors: a third is more seniors than guests (also no free unit)
    // a dish: both units marked for diner 1 (the cashier attests it is only for them)
    const d = await discount(f, s.porkLine, { kind: 'senior', qty: 2, dinerNo: 1 });
    expect(d.res).toMatchObject({ wrote: true });
    expect((await discountsOf(s.porkLine)).map((x) => [x.kind, x.diner_no, x.qty])).toEqual([['senior', 1, 2]]);
  });

  it('getSessionBill prices from the database: the PC-7 figures for a senior on a 449.00 package x4, and stateVersion', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await senior(f, s.pkgLine, 1);
    const bill = await asOrg(f.orgId, (tx) => P.getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId: s.sessionId }, RATES));
    expect(bill.stateVersion).toBe(await stateVersion(f));
    const text = JSON.stringify(bill);
    for (const figure of ['128.29', '48.11', '80.18', '2296.00', '2167.71']) expect(text, figure).toContain(figure);
  });
});

// ==============================================================================================================================
describe('R8 / test 8 - voidUnpaidSession (row 356)', () => {
  const voidIt = (f: Fx, who: Actor, sessionId: string, over: Record<string, unknown> = {}) =>
    asOrg(f.orgId, (tx) => P.voidUnpaidSession(tx, who, { storeId: f.storeId, pairingId: f.pairingId, sessionId, reason: 'Party walked out', voidedAtDevice: nowIso(), offline: false, ...over }));

  it('by a holder of approve_pos_correction (an admin): voided, lines cancelled, discounts removed, the stand freed, audited high', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const d = await senior(f, s.pkgLine, 1);
    await voidIt(f, f.admin, s.sessionId);
    expect(await sessionRow(s.sessionId)).toMatchObject({ status: 'voided', voided_by: f.admin.personId, void_reason: 'Party walked out', voided_offline: false });
    expect((await linesOf(s.sessionId)).every((l) => l.kitchen_status === 'cancelled')).toBe(true);
    expect((await discountsOf(s.pkgLine)).find((x) => x.id === d.discountId)!.status).toBe('removed');
    const [a] = await audits(f, 'pos.session_voided');
    expect(a).toMatchObject({ sensitivity: 'high', source: 'pos', device_id: f.pairingId });
    // the stand is free again
    await asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId: uuid(), mode: 'dine_in', standId: s.standId, headsCashier: 2, openedAtDevice: nowIso() }));
  });

  it('by a cashier with a valid manager PIN (online): voided; the approver is a manager of this store', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await voidIt(f, f.counter, s.sessionId, { approval: { pin: f.managerPin } });
    const row = await sessionRow(s.sessionId);
    expect(row.status).toBe('voided');
    expect([f.manager.personId, f.counter.personId]).toContain(row.voided_by);
  });

  it('refused without approval, with a wrong PIN, with the cashier\'s own PIN, and for an offline void by PIN; the session stays open', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await expectRefusal(voidIt(f, f.counter, s.sessionId), 'A manager must approve voiding a table. Ask for a manager PIN.');
    await expectAuthn(voidIt(f, f.counter, s.sessionId, { approval: { pin: '000000' } }), POS_APPROVAL_REFUSED); // a wrong PIN
    await expectAuthn(voidIt(f, f.counter, s.sessionId, { approval: { pin: f.counterPin } }), POS_APPROVAL_REFUSED); // the cashier's own PIN: no approve_pos_correction
    await expectRefusal(voidIt(f, f.counter, s.sessionId, { offline: true, approval: { pin: f.managerPin } }), 'A manager must approve voiding a table, and that needs the internet.');
    expect((await sessionRow(s.sessionId)).status).toBe('open');
  });

  it('F8: the PIN bucket\'s terminal person comes from the store\'s terminal link: one named in the input is ignored; with no link the plain refusal', async () => {
    const f = await fixture();
    const a = await fullSession(f, 4);
    await voidIt(f, f.counter, a.sessionId, { approval: { pin: f.managerPin, terminalPersonId: uuid() } }); // a bogus id is ignored
    expect((await sessionRow(a.sessionId)).status).toBe('voided');
    const b = await fullSession(f, 4);
    await sql`update pos_terminal_links set revoked_at = now(), revoked_by = ${f.admin.personId} where store_id = ${f.storeId}`;
    await expectRefusal(voidIt(f, f.counter, b.sessionId, { approval: { pin: f.managerPin } }), POS_TERMINAL_NOT_REGISTERED);
    expect((await sessionRow(b.sessionId)).status).toBe('open');
  });

  it('F6: a void already written is answered before the table is judged: the replay returns wrote false, with no second row and no counter bump', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    expect(await voidIt(f, f.admin, s.sessionId)).toMatchObject({ wrote: true });
    const v = await stateVersion(f);
    expect(await voidIt(f, f.counter, s.sessionId)).toMatchObject({ wrote: false }); // even by a cashier with no approval: it is a replay
    expect(await stateVersion(f)).toBe(v);
    expect((await audits(f, 'pos.session_voided')).length).toBe(1);
  });

  it('an administrator may void offline (voided_offline recorded); reason 3-200 characters; a paid session cannot be voided', async () => {
    const f = await fixture();
    const a = await fullSession(f, 4);
    await expectRefusal(voidIt(f, f.admin, a.sessionId, { reason: 'no' }));
    await expectRefusal(voidIt(f, f.admin, a.sessionId, { reason: 'x'.repeat(201) }));
    await voidIt(f, f.admin, a.sessionId, { offline: true });
    expect(await sessionRow(a.sessionId)).toMatchObject({ status: 'voided', voided_offline: true });
    const b = await porkSession(f);
    await complete(f, await saleInput(f, b.sessionId));
    await expectRefusal(voidIt(f, f.admin, b.sessionId));
    expect((await sessionRow(b.sessionId)).status).toBe('paid');
  });
});

// ==============================================================================================================================
describe('R9 / test 9 - completeSale: the server recomputes, then freezes', () => {
  it('writes the receipt with the server\'s figures, freezes lines in creation order, takes the payment, ends the session paid, audits once', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const input = await saleInput(f, s.sessionId);
    const v = await stateVersion(f);
    const res = await complete(f, input);
    expect(res).toMatchObject({ wrote: true, receiptId: input.receiptId });
    expect(await receiptOf(s.sessionId)).toEqual({
      id: input.receiptId, terminal_id: f.terminalRowId, receipt_seq: input.terminalSeq, cashier_id: f.counter.personId,
      subtotal: '2296.00', discount_total: '0.00', total: '2296.00', device_total: '2296.00', offline: false,
    });
    expect((await receiptLines(input.receiptId)).map((l) => [l.line_no, l.kind, l.qty, l.unit_price, l.gross, l.net, l.session_line_id])).toEqual([
      [1, 'package', 4, '449.00', '1796.00', '1796.00', s.pkgLine],
      [2, 'item', 2, '250.00', '500.00', '500.00', s.porkLine],
    ]);
    expect(await receiptPayments(input.receiptId)).toEqual([{ tender_id: f.cash, amount: '2296.00', change_given: '0.00', reference_no: null, to_check: false }]);
    expect((await sessionRow(s.sessionId)).status).toBe('paid');
    expect((await audits(f, 'pos.sale_completed')).length).toBe(1);
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length).toBe(0);
    expect(await stateVersion(f)).toBe(v + 1);
    expect(await receiptLineDiscounts(input.receiptId)).toHaveLength(0);
  });

  it('a mismatch is recorded, never refused: the receipt carries the SERVER\'s total, device_total what the tablet sent, and a high audit row shows both', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const input = await saleInput(f, s.sessionId);
    const lying = { ...input.device, total: '2000.00', discountTotal: '296.00' };
    await complete(f, { ...input, device: lying, payments: [{ tenderId: f.cash, amount: '2296.00', toCheck: false }] });
    const r = (await receiptOf(s.sessionId))!;
    expect(r).toMatchObject({ subtotal: '2296.00', discount_total: '0.00', total: '2296.00', device_total: '2000.00' });
    const [a] = await audits(f, 'pos.sale_recompute_mismatch');
    expect(a, 'mismatch audit row').toBeDefined();
    expect(a!.sensitivity).toBe('high');
    expect(JSON.stringify(a!.before)).toContain('2000.00');
    expect(JSON.stringify(a!.after)).toContain('2296.00');
    expect((await sessionRow(s.sessionId)).status).toBe('paid');
  });

  it('F4: the mismatch audit row keeps only {lineId, net} per device line and {lineId, qty, unitPrice, net} per server line, 200 lines at most, with a truncated flag', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const input = await saleInput(f, s.sessionId);
    await complete(f, { ...input, device: { ...input.device, total: '2000.00' }, payments: [{ tenderId: f.cash, amount: '2296.00', toCheck: false }] });
    const [a] = await audits(f, 'pos.sale_recompute_mismatch');
    const b = a!.before as { lines: Record<string, unknown>[]; truncated: boolean };
    const z = a!.after as { lines: Record<string, unknown>[]; truncated: boolean };
    expect(b.lines.map((l) => Object.keys(l).sort())).toEqual([['lineId', 'net'], ['lineId', 'net']]);
    expect(z.lines.map((l) => Object.keys(l).sort())).toEqual([['lineId', 'net', 'qty', 'unitPrice'], ['lineId', 'net', 'qty', 'unitPrice']]);
    expect([b.truncated, z.truncated]).toEqual([false, false]);
    // 201 lines: 200 kept, flagged
    const t = await open(f, { mode: 'take_out' });
    const at = new Date();
    await add(f, t.sessionId, Array.from({ length: 100 }, () => ({ item: f.menu.cola, qty: 1, at })));
    await add(f, t.sessionId, Array.from({ length: 100 }, () => ({ item: f.menu.cola, qty: 1, at })));
    await add(f, t.sessionId, [{ item: f.menu.cola, qty: 1, at }]);
    const big = await saleInput(f, t.sessionId);
    await complete(f, { ...big, device: { ...big.device, total: '1.00' }, payments: [{ tenderId: f.cash, amount: '16080.00', toCheck: false }] });
    const rows = await audits(f, 'pos.sale_recompute_mismatch');
    const big2 = rows[rows.length - 1]!;
    // Flagged either by the domain (`truncated`) or, because 200 lines of both sides exceed the audit writer's own 16 KB cap, by the writer (`__truncated`); the totals survive either way.
    const flagged = (o: unknown) => (o as Record<string, unknown>).truncated === true || (o as Record<string, unknown>).__truncated === true;
    expect([flagged(big2.before) || flagged(big2.after), JSON.stringify(big2.after)]).toEqual([true, expect.stringContaining('16080.00')]);
  });

  it('a single wrong LINE figure with correct totals is still a mismatch (exact centavos, no tolerance)', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const input = await saleInput(f, s.sessionId);
    const lines = input.device.lines.map((l, i) => (i === 1 ? { ...l, net: '499.99' } : l));
    await complete(f, { ...input, device: { ...input.device, lines } });
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length).toBe(1);
    // and a 1-centavo total difference too
    const s2 = await fullSession(f, 4);
    const i2 = await saleInput(f, s2.sessionId);
    await complete(f, { ...i2, device: { ...i2.device, total: '2295.99' } });
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length).toBe(2);
  });

  it('senior (PC-7): the server prices VAT 48.11 + 20% 80.18, writes the frozen line discount, one statutory row with source pos and the printed number, no mismatch', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await senior(f, s.pkgLine, 1);
    const input = await saleInput(f, s.sessionId, { seniors: [seniorEntry(1)] }, { [s.pkgLine]: '128.29' });
    await complete(f, input);
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length, 'tablet and server agree on the PC-7 figures').toBe(0);
    expect(await receiptOf(s.sessionId)).toMatchObject({ subtotal: '2296.00', discount_total: '128.29', total: '2167.71', device_total: '2167.71' });
    const lines = await receiptLines(input.receiptId);
    expect(lines[0]).toMatchObject({ kind: 'package', gross: '1796.00', discount_total: '128.29', net: '1667.71' });
    const [rd] = await receiptLineDiscounts(input.receiptId);
    expect(rd).toMatchObject({ kind: 'senior', label: 'Senior', qty: 1, diner_no: 1, vat_removed: '48.11', discount_amount: '80.18', receipt_line_id: lines[0]!.id });
    expect(rd!.statutory_record_id).not.toBeNull();
    const businessDate = await asOrg(f.orgId, (tx) => P.currentBusinessDate(tx, f.storeId, RATES));
    expect(businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const recs = await sql<{ id: string; kind: string; source: string; invoice_number: string; business_date: string; gross_amount: string; discount_amount: string; id_number: string; holder_name: string }[]>`
      select id, kind, source, invoice_number, business_date::text, gross_amount::text, discount_amount::text, id_number, holder_name
        from statutory_discount_records where org_id = ${f.orgId} and invoice_number = ${printedNumber(f, input.terminalSeq)}`;
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ id: rd!.statutory_record_id, kind: 'senior', source: 'pos', business_date: businessDate, gross_amount: '449.00', discount_amount: '128.29', id_number: IDNO, holder_name: HOLDER });
  });

  it('a senior and a PWD at one table: two statutory rows (one per diner), two frozen discounts labelled Senior and PWD', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await senior(f, s.pkgLine, 1, 'senior');
    await senior(f, s.pkgLine, 2, 'pwd');
    const input = await saleInput(f, s.sessionId, { seniors: [seniorEntry(1, 'senior'), seniorEntry(2, 'pwd', 'Pia Dela Cruz', 'PWD-0001122')] }, { [s.pkgLine]: '256.58' });
    await complete(f, input);
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length).toBe(0);
    expect(await receiptOf(s.sessionId)).toMatchObject({ discount_total: '256.58', total: '2039.42' });
    const recs = await sql<{ kind: string; gross_amount: string; discount_amount: string }[]>`
      select kind, gross_amount::text, discount_amount::text from statutory_discount_records where org_id = ${f.orgId} and invoice_number = ${printedNumber(f, input.terminalSeq)} order by kind desc`;
    expect(recs).toEqual([{ kind: 'senior', gross_amount: '449.00', discount_amount: '128.29' }, { kind: 'pwd', gross_amount: '449.00', discount_amount: '128.29' }]);
    expect((await receiptLineDiscounts(input.receiptId)).map((d) => [d.kind, d.label, d.diner_no])).toEqual([['senior', 'Senior', 1], ['pwd', 'PWD', 2]]);
  });

  it('preset and custom discounts freeze with their label (the preset\'s name / "Discount"), no VAT removal, no statutory row', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await discount(f, s.porkLine, { kind: 'preset', qty: 1, presetId: f.emp10 }); // 25.00
    await discount(f, s.porkLine, { kind: 'custom', qty: 1, valueType: 'fixed', value: '40' }); // 40.00
    const input = await saleInput(f, s.sessionId, {}, { [s.porkLine]: '65.00' });
    await complete(f, input);
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length).toBe(0);
    expect(await receiptOf(s.sessionId)).toMatchObject({ discount_total: '65.00', total: '2231.00' });
    expect((await receiptLineDiscounts(input.receiptId)).map((d) => [d.kind, d.label, d.vat_removed, d.discount_amount, d.statutory_record_id, d.preset_id])).toEqual([
      ['preset', 'Employee 10%', '0.00', '25.00', null, f.emp10],
      ['custom', 'Discount', '0.00', '40.00', null, null],
    ]);
    expect((await sql`select 1 from statutory_discount_records where org_id = ${f.orgId}`).length).toBe(0);
  });

  it('F2: completeSale refuses when the senior/PWD guests on the package outnumber the billed heads (a rule breach, not a total mismatch); nothing is written', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await senior(f, s.pkgLine, 1);
    await senior(f, s.pkgLine, 2, 'pwd');
    await sql`update table_sessions set heads_cashier = 1 where id = ${s.sessionId}`; // the breach, made behind the domain's back
    const input = await saleInput(f, s.sessionId, { seniors: [seniorEntry(1), seniorEntry(2, 'pwd', 'Pia Dela Cruz', 'PWD-0001122')] }, { [s.pkgLine]: '256.58' });
    await expectRefusal(complete(f, input), 'There are more senior or PWD discounts than guests at this table. Remove one before paying.');
    expect(await receiptOf(s.sessionId)).toBeUndefined();
    expect((await sessionRow(s.sessionId)).status).toBe('open');
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length).toBe(0);
    expect((await sql`select 1 from statutory_discount_records where org_id = ${f.orgId}`).length).toBe(0);
  });

  it('a diner with a senior discount but no seniors entry, an entry with no discount, or an entry missing the card details: refused, nothing written', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await senior(f, s.pkgLine, 1);
    const dis = { [s.pkgLine]: '128.29' };
    await expectRefusal(saleInput(f, s.sessionId, { seniors: [] }, dis).then((i) => complete(f, i)));
    await expectRefusal(saleInput(f, s.sessionId, { seniors: [seniorEntry(1), seniorEntry(2)] }, dis).then((i) => complete(f, i))); // diner 2 has no discount
    await expectRefusal(saleInput(f, s.sessionId, { seniors: [seniorEntry(1, 'senior', HOLDER, '')] }, dis).then((i) => complete(f, i)));
    await expectRefusal(saleInput(f, s.sessionId, { seniors: [seniorEntry(1, 'senior', '', IDNO)] }, dis).then((i) => complete(f, i)));
    expect(await receiptOf(s.sessionId)).toBeUndefined();
    expect((await sessionRow(s.sessionId)).status).toBe('open');
    expect((await sql`select 1 from statutory_discount_records where org_id = ${f.orgId}`).length).toBe(0);
    // and an entry for a diner when the bill has no statutory discount at all
    const plain = await porkSession(f);
    await expectRefusal(saleInput(f, plain.sessionId, { seniors: [seniorEntry(1)] }).then((i) => complete(f, i)));
  });

  it('T-539 S2: with NO reader injected the default reads the rules from the database (registry defaults on a fresh org): a senior sale completes at 12% VAT and 20%', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await senior(f, s.pkgLine, 1);
    const input = await saleInput(f, s.sessionId, { seniors: [seniorEntry(1)] }, { [s.pkgLine]: '128.29' });
    expect(await complete(f, input, { deps: {} })).toMatchObject({ wrote: true });
    expect((await sessionRow(s.sessionId)).status).not.toBe('open');
    expect(await receiptOf(s.sessionId)).toMatchObject({ subtotal: '2296.00', discount_total: '128.29', total: '2167.71', device_total: '2167.71' });
    const recs = await sql`select kind, gross_amount::text, discount_amount::text from statutory_discount_records where org_id = ${f.orgId} and invoice_number = ${printedNumber(f, input.terminalSeq)}`;
    expect(recs).toEqual([{ kind: 'senior', gross_amount: '449.00', discount_amount: '128.29' }]);
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length).toBe(0);
    const plain = await porkSession(f);
    expect(await complete(f, await saleInput(f, plain.sessionId), { deps: {} })).toMatchObject({ wrote: true });
  });

  it('T-539 S2: at the day boundary with no Z, a sale at D 03:30 Manila belongs to D-1 (20%) and one at D 04:30 belongs to D (25%)', async () => {
    const f = await fixture();
    const d = addDays(toBusinessDate(), 1);
    await asOrg(f.orgId, (tx) => setBusinessRule(tx, f.admin, { key: 'pos.senior_pwd_discount_percent', value: '25', effectiveFrom: d, reason: 'Law changed' } as never));
    const sellAt = async (issuedAtDevice: string, off: string) => {
      const s = await fullSession(f, 4);
      await senior(f, s.pkgLine, 1);
      const input = await saleInput(f, s.sessionId, { seniors: [seniorEntry(1)], offline: true, issuedAtDevice }, { [s.pkgLine]: off });
      await complete(f, input, { deps: {} });
      const [rec] = await sql<{ business_date: string; discount_amount: string }[]>`select business_date::text, discount_amount::text from statutory_discount_records where org_id = ${f.orgId} and invoice_number = ${printedNumber(f, input.terminalSeq)}`;
      return rec!;
    };
    const dMinus1 = addDays(d, -1);
    // D 03:30 Manila = (D-1) 19:30Z; D 04:30 Manila = (D-1) 20:30Z
    expect(await sellAt(`${dMinus1}T19:30:00Z`, '128.29')).toEqual({ business_date: dMinus1, discount_amount: '128.29' });
    expect(await sellAt(`${dMinus1}T20:30:00Z`, '148.33')).toEqual({ business_date: d, discount_amount: '148.33' });
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length, 'each sale was priced at the rate of its own business day').toBe(0);
  });

  it('T-539 S2: a rule change dated from a later day (senior/PWD 25% from tomorrow) prices a sale on THAT business date at 25%, and a sale today stays at 20%', async () => {
    const f = await fixture();
    const from = addDays(toBusinessDate(), 1);
    await asOrg(f.orgId, (tx) => setBusinessRule(tx, f.admin, { key: 'pos.senior_pwd_discount_percent', value: '25', effectiveFrom: from, reason: 'Law changed' } as never));
    const later = await fullSession(f, 4);
    await senior(f, later.pkgLine, 1);
    // 12:00 Manila on the start day: 449.00 / 1.12 = 400.89 -> VAT 48.11, 25% of 400.89 = 100.22
    const input = await saleInput(f, later.sessionId, { seniors: [seniorEntry(1)], offline: true, issuedAtDevice: `${from}T04:00:00Z` }, { [later.pkgLine]: '148.33' });
    await complete(f, input, { deps: {} });
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length, 'the server priced 25%: the tablet figures match').toBe(0);
    expect(await receiptOf(later.sessionId)).toMatchObject({ subtotal: '2296.00', discount_total: '148.33', total: '2147.67' });
    const recs = await sql`select business_date::text, discount_amount::text from statutory_discount_records where org_id = ${f.orgId} and invoice_number = ${printedNumber(f, input.terminalSeq)}`;
    expect(recs).toEqual([{ business_date: from, discount_amount: '148.33' }]);
    // today is before the change: still 20%
    const now = await fullSession(f, 4);
    await senior(f, now.pkgLine, 1);
    await complete(f, await saleInput(f, now.sessionId, { seniors: [seniorEntry(1)] }, { [now.pkgLine]: '128.29' }), { deps: {} });
    expect(await receiptOf(now.sessionId)).toMatchObject({ discount_total: '128.29', total: '2167.71' });
  });

  it('a senior on a DISH line (ruling 10): VAT 26.79 + 20% 44.64 on the 250.00 pork, one statutory row for that diner', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await discount(f, s.porkLine, { kind: 'senior', qty: 1, dinerNo: 1 });
    const input = await saleInput(f, s.sessionId, { seniors: [seniorEntry(1)] }, { [s.porkLine]: '71.43' });
    await complete(f, input);
    expect((await audits(f, 'pos.sale_recompute_mismatch')).length).toBe(0);
    const [rd] = await receiptLineDiscounts(input.receiptId);
    expect(rd).toMatchObject({ kind: 'senior', qty: 1, diner_no: 1, vat_removed: '26.79', discount_amount: '44.64' });
    const recs = await sql<{ gross_amount: string; discount_amount: string }[]>`
      select gross_amount::text, discount_amount::text from statutory_discount_records where org_id = ${f.orgId} and invoice_number = ${printedNumber(f, input.terminalSeq)}`;
    expect(recs).toEqual([{ gross_amount: '250.00', discount_amount: '71.43' }]);
  });

  it('change comes only from cash: cash over-tender gives change on the cash row', async () => {
    const f = await fixture();
    const s = await porkSession(f); // 500.00
    const input = await saleInput(f, s.sessionId, { payments: [{ tenderId: f.cash, amount: '600.00', toCheck: false }] });
    await complete(f, input);
    expect(await receiptPayments(input.receiptId)).toEqual([{ tender_id: f.cash, amount: '600.00', change_given: '100.00', reference_no: null, to_check: false }]);
  });

  it('a mixed tender: a wallet plus cash over-tender puts the change on the cash row only', async () => {
    const f = await fixture();
    const s = await porkSession(f);
    const input = await saleInput(f, s.sessionId, {
      payments: [{ tenderId: f.gcash, amount: '400.00', referenceNo: 'GC1234567', toCheck: false }, { tenderId: f.cash, amount: '150.00', toCheck: false }],
    });
    await complete(f, input);
    const rows = await receiptPayments(input.receiptId);
    expect(rows.find((r) => r.tender_id === f.gcash)).toMatchObject({ amount: '400.00', change_given: '0.00', reference_no: 'GC1234567' });
    expect(rows.find((r) => r.tender_id === f.cash)).toMatchObject({ amount: '150.00', change_given: '50.00' });
    // and an exact split with no change
    const s2 = await porkSession(f);
    const i2 = await saleInput(f, s2.sessionId, { payments: [{ tenderId: f.cash, amount: '200.00', toCheck: false }, { tenderId: f.gcash, amount: '300.00', referenceNo: 'GC7654321', toCheck: false }] });
    await complete(f, i2);
    expect((await receiptPayments(i2.receiptId)).every((r) => r.change_given === '0.00')).toBe(true);
  });

  it('over-payment with a wallet only is refused; so is change larger than the cash tendered (under-payment is no longer refused: T-558, see the next case)', async () => {
    const f = await fixture();
    const s = await porkSession(f); // 500.00
    const pay = (payments: unknown[]) => saleInput(f, s.sessionId, { payments }).then((i) => complete(f, i));
    await expectRefusal(pay([{ tenderId: f.gcash, amount: '600.00', referenceNo: 'GC1234567', toCheck: false }]), 'Change can only be given in cash.');
    await expectRefusal(pay([{ tenderId: f.cash, amount: '10.00', toCheck: false }, { tenderId: f.gcash, amount: '505.00', referenceNo: 'GC1234567', toCheck: false }]), 'Change can only be given in cash.');
    expect(await receiptOf(s.sessionId)).toBeUndefined();
    expect((await sessionRow(s.sessionId)).status).toBe('open');
  });

  it('T-558 replaces "under-payment is refused": cash 499.99 on 500.00 is recorded (the sale is never lost), paid, with no change', async () => {
    const f = await fixture();
    const s = await porkSession(f); // 500.00
    await saleInput(f, s.sessionId, { payments: [{ tenderId: f.cash, amount: '499.99', toCheck: false }] }).then((i) => complete(f, i));
    expect(await receiptOf(s.sessionId)).toBeDefined();
    expect((await sessionRow(s.sessionId)).status).toBe('paid');
  });

  it('payment rows: 1 to 20 (21 refused, 20 fine); amounts above 0; an active tender of THIS store', async () => {
    const f = await fixture();
    const s = await porkSession(f); // 500.00
    const pay = (payments: unknown[], sess = s.sessionId) => saleInput(f, sess, { payments }).then((i) => complete(f, i));
    const cashRows = (n: number, each: string) => Array.from({ length: n }, () => ({ tenderId: f.cash, amount: each, toCheck: false }));
    await expectRefusal(pay([]));
    await expectRefusal(pay(cashRows(21, '24.00'))); // 504.00: the money is enough, the count is not
    await expectRefusal(pay([{ tenderId: f.cash, amount: '0.00', toCheck: false }, ...cashRows(1, '500.00')]));
    await expectRefusal(pay([{ tenderId: f.cash, amount: '-5.00', toCheck: false }, ...cashRows(1, '505.00')]));
    await expectRefusal(pay([{ tenderId: f.mayaOff, amount: '500.00', referenceNo: 'MY1234567', toCheck: false }]));
    await expectRefusal(pay([{ tenderId: f.cashB, amount: '500.00', toCheck: false }]));
    expect(await receiptOf(s.sessionId)).toBeUndefined();
    await pay(cashRows(20, '25.00'));
    expect(await receiptPayments((await receiptOf(s.sessionId))!.id)).toHaveLength(20);
  });

  it('toCheck only for a wallet taken offline, and always with its reference; an offline sale is flagged offline', async () => {
    const f = await fixture();
    const wallet = (over: Record<string, unknown> = {}) => [{ tenderId: f.gcash, amount: '500.00', referenceNo: 'GC1234567', toCheck: true, ...over }];
    const pay = (sessionId: string, payments: unknown[], offline: boolean) => saleInput(f, sessionId, { payments, offline }).then((i) => complete(f, i).then((r) => ({ r, i })));
    const a = await porkSession(f);
    await expectRefusal(pay(a.sessionId, wallet(), false)); // online: nothing is "to check"
    await expectRefusal(pay(a.sessionId, [{ tenderId: f.cash, amount: '500.00', referenceNo: 'CASH1234', toCheck: true }], true)); // cash is never to-check
    await expectRefusal(pay(a.sessionId, wallet({ referenceNo: undefined }), true)); // no reference
    expect(await receiptOf(a.sessionId)).toBeUndefined();
    const { i } = await pay(a.sessionId, wallet(), true);
    expect(await receiptOf(a.sessionId)).toMatchObject({ offline: true });
    expect(await receiptPayments(i.receiptId)).toEqual([{ tender_id: f.gcash, amount: '500.00', change_given: '0.00', reference_no: 'GC1234567', to_check: true }]);
  });

  it('ruling 5: every wallet payment needs its reference, online too (and is never "to check" online); cash needs none', async () => {
    const f = await fixture();
    const s = await porkSession(f); // 500.00
    const pay = (payments: unknown[]) => saleInput(f, s.sessionId, { payments }).then((i) => complete(f, i).then((r) => ({ r, i })));
    await expectRefusal(pay([{ tenderId: f.gcash, amount: '500.00', toCheck: false }])); // no reference
    await expectRefusal(pay([{ tenderId: f.gcash, amount: '500.00', referenceNo: 'abc', toCheck: false }])); // reference too short (4-40)
    expect(await receiptOf(s.sessionId)).toBeUndefined();
    const { i } = await pay([{ tenderId: f.gcash, amount: '500.00', referenceNo: 'GC1234567', toCheck: false }]);
    expect(await receiptPayments(i.receiptId)).toEqual([{ tender_id: f.gcash, amount: '500.00', change_given: '0.00', reference_no: 'GC1234567', to_check: false }]);
  });

  it('replay: the same receiptId with identical input returns the existing receipt and writes nothing more', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const input = await saleInput(f, s.sessionId);
    expect(await complete(f, input)).toMatchObject({ wrote: true, receiptId: input.receiptId });
    const v = await stateVersion(f);
    expect(await complete(f, input)).toMatchObject({ wrote: false, receiptId: input.receiptId });
    expect((await sql`select 1 from pos_sales_receipts where table_session_id = ${s.sessionId}`).length).toBe(1);
    expect((await receiptLines(input.receiptId)).length).toBe(2);
    expect((await receiptPayments(input.receiptId)).length).toBe(1);
    expect((await audits(f, 'pos.sale_completed')).length).toBe(1);
    expect(await stateVersion(f)).toBe(v);
  });

  it('a different receiptId for an already-paid session is refused; a terminalSeq already used on the terminal is refused with the sentence', async () => {
    const f = await fixture();
    const a = await porkSession(f);
    const first = await saleInput(f, a.sessionId);
    await complete(f, first);
    await expectRefusal(complete(f, { ...first, receiptId: uuid(), terminalSeq: ++terminalSeq }));
    const b = await porkSession(f);
    const dup = await saleInput(f, b.sessionId, { terminalSeq: first.terminalSeq });
    await expectRefusal(complete(f, dup), 'That receipt number is already used on this till.');
    expect((await sessionRow(b.sessionId)).status).toBe('open');
    expect(await receiptOf(b.sessionId)).toBeUndefined();
  });

  it('the session must be open with at least one line, and the terminal must be this store\'s', async () => {
    const f = await fixture();
    const empty = await open(f);
    await expectRefusal(saleInput(f, empty.sessionId).then((i) => complete(f, i)));
    const voided = await porkSession(f);
    const vi = await saleInput(f, voided.sessionId);
    await asOrg(f.orgId, (tx) => P.voidUnpaidSession(tx, f.admin, { storeId: f.storeId, pairingId: f.pairingId, sessionId: voided.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false }));
    await expectRefusal(complete(f, vi));
    const s = await porkSession(f);
    await expectRefusal(saleInput(f, s.sessionId, { terminalNo: 2 }).then((i) => complete(f, i)));
    expect(await receiptOf(s.sessionId)).toBeUndefined();
  });

  it('receipt lines are the NON-cancelled session lines; a refill is frozen at 0.00 and the total does not move', async () => {
    const f = await fixture();
    const s = await open(f, { heads: 4 });
    const added = await add(f, s.sessionId, [{ item: f.menu.unli, qty: 4 }, { item: f.menu.cola, qty: 1 }, { item: f.menu.cola, qty: 3 }]);
    await asOrg(f.orgId, (tx) => P.cancelLine(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, lineId: added.lineIds[1]!, reason: 'Customer changed mind' }));
    await asOrg(f.orgId, (tx) =>
      P.requestRefill(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 2, addedAtDevice: nowIso() }] }),
    );
    const input = await saleInput(f, s.sessionId); // 1796.00 + 240.00
    await complete(f, input);
    const lines = await receiptLines(input.receiptId);
    expect(lines.map((l) => [l.line_no, l.kind, l.qty, l.gross, l.net])).toEqual([
      [1, 'package', 4, '1796.00', '1796.00'],
      [2, 'item', 3, '240.00', '240.00'],
      [3, 'refill', 2, '0.00', '0.00'],
    ]);
    expect(await receiptOf(s.sessionId)).toMatchObject({ subtotal: '2036.00', total: '2036.00' });
  });
});

// ==============================================================================================================================
describe('R10 - reads for the screens', () => {
  it('each read returns stateVersion equal to the store\'s counter and shows the right rows', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const refillId = uuid();
    await asOrg(f.orgId, (tx) =>
      P.requestRefill(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, lines: [{ lineId: refillId, menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() }] }),
    );
    const cola = await add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }]);
    const sv = await stateVersion(f);
    const read = <T>(fn: (tx: Tx) => Promise<T>) => asOrg(f.orgId, fn);
    const stands = await read((tx) => P.listOpenStands(tx, f.counter, { storeId: f.storeId }));
    expect(stands.stateVersion).toBe(sv);
    expect(JSON.stringify(stands)).toContain(s.sessionId);
    const grillQ = await read((tx) => P.listKitchenQueue(tx, f.kitchen, { storeId: f.storeId, stationId: f.grill }));
    const barQ = await read((tx) => P.listKitchenQueue(tx, f.kitchen, { storeId: f.storeId, stationId: f.bar }));
    expect(grillQ.stateVersion).toBe(sv);
    expect(JSON.stringify(grillQ)).toContain(s.porkLine);
    expect(JSON.stringify(grillQ)).not.toContain(cola.lineIds[0]!);
    expect(JSON.stringify(barQ)).toContain(cola.lineIds[0]!);
    const refills = await read((tx) => P.listRefillQueue(tx, f.kitchen, { storeId: f.storeId }));
    expect(JSON.stringify(refills)).toContain(refillId);
    await asOrg(f.orgId, (tx) => P.serveLine(tx, f.kitchen, { storeId: f.storeId, pairingId: f.pairingId, lineId: refillId, servedAtDevice: nowIso() }));
    expect(JSON.stringify(await read((tx) => P.listRefillQueue(tx, f.kitchen, { storeId: f.storeId })))).not.toContain(refillId);
    const input = await saleInput(f, s.sessionId);
    await complete(f, input);
    expect(JSON.stringify(await read((tx) => P.listOpenStands(tx, f.counter, { storeId: f.storeId })))).not.toContain(s.sessionId);
    const today = await read((tx) => P.listTodaysSalesReceipts(tx, f.counter, { storeId: f.storeId }));
    expect(today.stateVersion).toBe(await stateVersion(f));
    expect(JSON.stringify(today)).toContain(input.receiptId);
  });

  it('F7: with no Z yet the sale\'s own device time decides the business day: an offline sale made at 03:30 and replayed at 05:00 belongs to the PREVIOUS day', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await senior(f, s.pkgLine, 1);
    const replayedAt505: Deps = { ...RATES, now: () => new Date('2026-11-06T21:00:00Z') }; // 05:00 Manila on the 7th (the server's clock at replay)
    const input = await saleInput(f, s.sessionId, { seniors: [seniorEntry(1)], offline: true, issuedAtDevice: '2026-11-06T19:30:00Z' }, { [s.pkgLine]: '128.29' }); // 03:30 Manila on the 7th
    await complete(f, input, { deps: replayedAt505 });
    const [rec] = await sql<{ business_date: string }[]>`select business_date::text from statutory_discount_records where org_id = ${f.orgId} and invoice_number = ${printedNumber(f, input.terminalSeq)}`;
    expect(rec!.business_date).toBe('2026-11-06'); // not the 7th (the replay's day)
  });

  it('ruling 8 (+ BOSS amendment): with no Z yet, the business day starts at the business-day-start hour (injected, 4): the Manila date of (time - 4 hours)', async () => {
    const f = await fixture();
    const at = (iso: string): Deps => ({ ...RATES, now: () => new Date(iso) });
    const bd = (iso: string) => asOrg(f.orgId, (tx) => P.currentBusinessDate(tx, f.storeId, at(iso)));
    expect(await bd('2026-11-06T19:30:00Z')).toBe('2026-11-06'); // 03:30 Manila on the 7th is still the 6th's day
    expect(await bd('2026-11-06T20:00:00Z')).toBe('2026-11-07'); // 04:00 Manila on the 7th starts the 7th
    expect(await bd('2026-11-06T04:00:00Z')).toBe('2026-11-06'); // 12:00 Manila
    // the hour is a business value, not a constant: a reader that says 6 moves the cut-off
    const six: Deps = { now: () => new Date('2026-11-06T20:00:00Z'), readRules: async () => ({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 6 }) };
    expect(await asOrg(f.orgId, (tx) => P.currentBusinessDate(tx, f.storeId, six))).toBe('2026-11-06');
    // no reader injected (T-539 S2): the default reads the database, a fresh org gets the registry default hour 4, so 04:00 Manila starts the 7th
    expect(await asOrg(f.orgId, (tx) => P.currentBusinessDate(tx, f.storeId, { now: () => new Date('2026-11-06T20:00:00Z') }))).toBe('2026-11-07');
  });

  // T-531 ruling 1 (8 Nov 2026) REPLACES the old test here ("the Manila date the open Z window started: the last Z's window_end"): a Z is dated with the business day it
  // CLOSES, so a sale carries max(lastZ.business_date + 1 day, startHourDate(the sale's time)); with no Z yet the start-hour rule alone (kept above: ruling 8, F7).
  describe('T-531 ruling 1: the business date after a Z is max(lastZ.business_date + 1, startHourDate(time))', () => {
    const zOn = async (f: Awaited<ReturnType<typeof fixture>>, n: number, bd: string, start: string, end: string) =>
      sql`insert into pos_day_closes (org_id, store_id, terminal_id, z_no, business_date, window_start, window_end, receipt_count, gross_total, closed_by, approved_by)
          values (${f.orgId}, ${f.storeId}, ${f.terminalRowId}, ${n}, ${bd}, ${start}, ${end}, 0, 0, ${f.counter.personId}, ${f.manager.personId})`;
    const bdAt = (f: Awaited<ReturnType<typeof fixture>>, iso: string) => asOrg(f.orgId, (tx) => P.currentBusinessDate(tx, f.storeId, { ...RATES, now: () => new Date(iso) }));

    it('a sale at 23:00 after a 22:00 Z is dated D+1 (the Z took D)', async () => {
      const f = await fixture();
      await zOn(f, 1, '2026-11-05', '2026-11-05T04:00:00+08:00', '2026-11-05T22:00:00+08:00');
      expect(await bdAt(f, '2026-11-05T23:00:00+08:00')).toBe('2026-11-06');
    });

    it('a sale at 10:00 the next morning is dated D+1', async () => {
      const f = await fixture();
      await zOn(f, 1, '2026-11-05', '2026-11-05T04:00:00+08:00', '2026-11-05T22:00:00+08:00');
      expect(await bdAt(f, '2026-11-06T10:00:00+08:00')).toBe('2026-11-06');
    });

    it('a sale at 02:00 on D+2, long after a Z dated D, is dated D+1 (still the business day of 02:00 minus 4 hours), not D+2', async () => {
      const f = await fixture();
      await zOn(f, 1, '2026-11-05', '2026-11-05T04:00:00+08:00', '2026-11-05T22:00:00+08:00');
      expect(await bdAt(f, '2026-11-07T02:00:00+08:00')).toBe('2026-11-06');
      expect(await bdAt(f, '2026-11-07T05:00:00+08:00')).toBe('2026-11-07');
    });

    it('a sale before any Z uses the start-hour rule', async () => {
      const f = await fixture();
      expect(await bdAt(f, '2026-11-06T03:30:00+08:00')).toBe('2026-11-05');
      expect(await bdAt(f, '2026-11-06T04:30:00+08:00')).toBe('2026-11-06');
    });

    it('the latest Z BY BUSINESS DATE decides (a later Z of another date wins)', async () => {
      const f = await fixture();
      await zOn(f, 1, '2026-11-05', '2026-11-05T04:00:00+08:00', '2026-11-05T22:00:00+08:00');
      await zOn(f, 2, '2026-11-06', '2026-11-05T22:00:00+08:00', '2026-11-06T22:00:00+08:00');
      expect(await bdAt(f, '2026-11-06T23:00:00+08:00')).toBe('2026-11-07');
    });
  });
});

// ==============================================================================================================================
describe('R2 - the three new capabilities: every ✅ has its ✗', () => {
  const NEW = ['request_pos_refill', 'serve_pos_ticket', 'confirm_pos_heads'] as const;

  it.each(NEW)('%s: super_admin, admin and manager yes; staff no (staff get it by position); store scope', (cap) => {
    expect(CAPABILITY_MATRIX[cap as never], `${cap} is in the matrix`).toEqual({ super_admin: true, admin: true, manager: true, staff: false });
    expect(CAPABILITY_SCOPE[cap as never]).toBe('store');
  });

  it('confirm_pos_heads: a server and a manager may; a counter cashier (record_sale only), a kitchen hand, nobody-at-all and a manager of ANOTHER store may not', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const confirm = (who: Actor, headsServer: number) =>
      asOrg(f.orgId, (tx) => P.confirmHeads(tx, who, { storeId: f.storeId, pairingId: null, sessionId: s.sessionId, headsServer }));
    for (const who of [f.counter, f.kitchen, f.bare, f.managerOther]) await expectAuthRefusal(confirm(who, 5));
    expect((await sessionRow(s.sessionId)).heads_server).toBeNull();
    await confirm(f.server, 5);
    await confirm(f.manager, 6);
    expect((await sessionRow(s.sessionId)).heads_server).toBe(6);
  });

  it('serve_pos_ticket: a kitchen hand, a server and a manager may; a counter cashier, nobody-at-all and a manager of another store may not', async () => {
    const f = await fixture();
    const s = await open(f, { heads: 2 });
    const { lineIds } = await add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }, { item: f.menu.cola, qty: 1 }, { item: f.menu.cola, qty: 1 }]);
    const serve = (who: Actor, lineId: string) =>
      asOrg(f.orgId, (tx) => P.serveLine(tx, who, { storeId: f.storeId, pairingId: null, lineId, servedAtDevice: nowIso() }));
    for (const who of [f.counter, f.bare, f.managerOther]) await expectAuthRefusal(serve(who, lineIds[0]!));
    expect((await linesOf(s.sessionId)).every((l) => l.kitchen_status === 'queued')).toBe(true);
    await serve(f.kitchen, lineIds[0]!);
    await serve(f.server, lineIds[1]!);
    await serve(f.manager, lineIds[2]!);
    expect((await linesOf(s.sessionId)).every((l) => l.kitchen_status === 'served')).toBe(true);
  });

  it('request_pos_refill: a kitchen hand, a server and a manager may; a counter cashier with record_sale only, nobody-at-all and a manager of another store may not', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const refill = (who: Actor) =>
      asOrg(f.orgId, (tx) =>
        P.requestRefill(tx, who, { storeId: f.storeId, pairingId: null, sessionId: s.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() }] }),
      );
    for (const who of [f.counter, f.bare, f.managerOther]) await expectAuthRefusal(refill(who));
    expect((await linesOf(s.sessionId)).filter((l) => l.kind === 'refill')).toHaveLength(0);
    await refill(f.kitchen);
    await refill(f.server);
    await refill(f.manager);
    expect((await linesOf(s.sessionId)).filter((l) => l.kind === 'refill')).toHaveLength(3);
  });

  it('every remaining mutator refuses a person with no grant and a manager of ANOTHER store, and changes nothing', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const d = await discount(f, s.porkLine, { kind: 'preset', qty: 1, presetId: f.emp10 });
    const refillId = uuid();
    await asOrg(f.orgId, (tx) => P.requestRefill(tx, f.server, { storeId: f.storeId, pairingId: f.pairingId, sessionId: s.sessionId, lines: [{ lineId: refillId, menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() }] }));
    const base = { storeId: f.storeId, pairingId: f.pairingId };
    const before = { sv: await stateVersion(f), lines: await linesOf(s.sessionId), discounts: await discountsOf(s.porkLine) };
    for (const who of [f.bare, f.managerOther]) {
      const run = (fn: (tx: Tx) => Promise<unknown>) => expectAuthRefusal(asOrg(f.orgId, fn));
      await run((tx) => P.setHeadsCashier(tx, who, { ...base, sessionId: s.sessionId, headsCashier: 6 }));
      await run((tx) => P.confirmHeads(tx, who, { ...base, sessionId: s.sessionId, headsServer: 6 }));
      await run((tx) => P.requestRefill(tx, who, { ...base, sessionId: s.sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() }] }));
      await run((tx) => P.serveLine(tx, who, { ...base, lineId: refillId, servedAtDevice: nowIso() }));
      await run((tx) => P.cancelLine(tx, who, { ...base, lineId: s.porkLine, reason: 'Customer changed mind' }));
      await run((tx) => P.removeLineDiscount(tx, who, { ...base, discountId: d.discountId, removedAtDevice: nowIso() }));
      await run((tx) => P.applyPresetToAllLines(tx, who, { ...base, sessionId: s.sessionId, presetId: f.emp10, applyId: uuid(), appliedAtDevice: nowIso() }));
      await run((tx) => P.voidUnpaidSession(tx, who, { ...base, sessionId: s.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false }));
    }
    expect({ sv: await stateVersion(f), lines: await linesOf(s.sessionId), discounts: await discountsOf(s.porkLine) }).toEqual(before);
    expect((await sessionRow(s.sessionId)).status).toBe('open');
  });

  it('the reads need the store: a manager of ANOTHER store is refused each of them with the one sentence', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const sentence = 'You do not have access to this store.';
    const other = (fn: (tx: Tx) => Promise<unknown>) => expectRefusal(asOrg(f.orgId, fn), sentence);
    await other((tx) => P.listOpenStands(tx, f.managerOther, { storeId: f.storeId }));
    await other((tx) => P.listKitchenQueue(tx, f.managerOther, { storeId: f.storeId }));
    await other((tx) => P.listRefillQueue(tx, f.managerOther, { storeId: f.storeId }));
    await other((tx) => P.listTodaysSalesReceipts(tx, f.managerOther, { storeId: f.storeId }));
    await other((tx) => P.getSessionBill(tx, f.managerOther, { storeId: f.storeId, sessionId: s.sessionId }, RATES));
  });

  it('record_sale (reused): a person with no grant, and a manager of another store, are refused at seating, ordering, discounting and paying', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    const st = await newStand(f);
    for (const who of [f.bare, f.managerOther]) {
      await expectAuthRefusal(asOrg(f.orgId, (tx) => P.openStand(tx, who, { storeId: f.storeId, pairingId: f.pairingId, sessionId: uuid(), mode: 'dine_in', standId: st.id, headsCashier: 2, openedAtDevice: nowIso() })));
      await expectAuthRefusal(add(f, s.sessionId, [{ item: f.menu.cola, qty: 1 }], { who }));
      await expectAuthRefusal(discount(f, s.porkLine, { kind: 'preset', qty: 1, presetId: f.emp10, who }));
      await expectAuthRefusal(saleInput(f, s.sessionId).then((i) => complete(f, i, { who })));
    }
    expect((await sql`select 1 from table_sessions where stand_id = ${st.id}`).length).toBe(0);
  });
});

// ==============================================================================================================================
describe('R12 / test 10 - the audit catalogue, the polling counter, and personal data', () => {
  it('the eleven pos.* actions are in the catalogue, owned by T-524; session_voided and sale_recompute_mismatch are high', () => {
    const actions = [
      'pos.stand_opened', 'pos.lines_added', 'pos.line_cancelled', 'pos.heads_changed', 'pos.refill_requested', 'pos.line_served',
      'pos.discount_added', 'pos.discount_removed', 'pos.session_voided', 'pos.sale_completed', 'pos.sale_recompute_mismatch',
    ];
    for (const a of actions) expect(catalogueEntry(a), a).toMatchObject({ owner: 'T-524' });
    expect(catalogueEntry('pos.session_voided')).toMatchObject({ sensitivity: 'high' });
    expect(catalogueEntry('pos.sale_recompute_mismatch')).toMatchObject({ sensitivity: 'high' });
  });

  it('state_version moves by exactly 1 for every write that changes something (one call = one bump, however many rows)', async () => {
    const f = await fixture();
    const bump = async (label: string, fn: () => Promise<unknown>) => {
      const before = await stateVersion(f);
      await fn();
      expect(await stateVersion(f) - before, label).toBe(1);
    };
    const st = await newStand(f);
    const sessionId = uuid();
    const base = { storeId: f.storeId, pairingId: f.pairingId };
    await bump('openStand', () => asOrg(f.orgId, (tx) => P.openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: st.id, headsCashier: 4, openedAtDevice: nowIso() })));
    let ids: string[] = [];
    await bump('addLines (3 lines)', async () => { ids = (await add(f, sessionId, [{ item: f.menu.unli, qty: 4 }, { item: f.menu.pork, qty: 2 }, { item: f.menu.cola, qty: 1 }])).lineIds; });
    await bump('confirmHeads', () => asOrg(f.orgId, (tx) => P.confirmHeads(tx, f.server, { ...base, sessionId, headsServer: 5 })));
    await bump('setHeadsCashier', () => asOrg(f.orgId, (tx) => P.setHeadsCashier(tx, f.counter, { ...base, sessionId, headsCashier: 6 })));
    await bump('serveLine', () => asOrg(f.orgId, (tx) => P.serveLine(tx, f.kitchen, { ...base, lineId: ids[2]!, servedAtDevice: nowIso() })));
    await bump('cancelLine', () => asOrg(f.orgId, (tx) => P.cancelLine(tx, f.counter, { ...base, lineId: ids[1]!, reason: 'Customer changed mind' })));
    let d = '';
    const pkg = (await liveLines(sessionId)).find((l) => l.kind === 'package')!;
    await bump('addLineDiscount', async () => { d = (await discount(f, pkg.id, { kind: 'preset', qty: 1, presetId: f.emp10 })).discountId; });
    await bump('removeLineDiscount', () => asOrg(f.orgId, (tx) => P.removeLineDiscount(tx, f.counter, { ...base, discountId: d, removedAtDevice: nowIso() })));
    await bump('applyPresetToAllLines', () => asOrg(f.orgId, (tx) => P.applyPresetToAllLines(tx, f.counter, { ...base, sessionId, presetId: f.emp10, applyId: uuid(), appliedAtDevice: nowIso() })));
    await bump('requestRefill', () => asOrg(f.orgId, (tx) => P.requestRefill(tx, f.server, { ...base, sessionId, lines: [{ lineId: uuid(), menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() }] })));
    const t = await porkSession(f);
    await bump('completeSale', async () => { await complete(f, await saleInput(f, t.sessionId)); });
    const u = await porkSession(f);
    await bump('voidUnpaidSession', () => asOrg(f.orgId, (tx) => P.voidUnpaidSession(tx, f.admin, { ...base, sessionId: u.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false })));
  });

  it('a senior\'s name and card number are in statutory_discount_records and in NO audit row (row 353)', async () => {
    const f = await fixture();
    const s = await fullSession(f, 4);
    await senior(f, s.pkgLine, 1);
    const input = await saleInput(f, s.sessionId, { seniors: [seniorEntry(1)] }, { [s.pkgLine]: '128.29' });
    await complete(f, input);
    expect((await audits(f, 'pos.sale_completed')).length, 'the sale was audited, so the search below is not vacuous').toBe(1);
    expect((await sql`select 1 from statutory_discount_records where org_id = ${f.orgId} and holder_name = ${HOLDER} and id_number = ${IDNO}`).length).toBe(1);
    const leaks = await sql<{ action: string }[]>`
      select action from audit_log where org_id = ${f.orgId}
        and (coalesce(before::text, '') || coalesce(after::text, '') || entity) ilike any (array[${'%' + HOLDER.split(' ')[1] + '%'}, ${'%' + IDNO + '%'}, ${'%Zyxwv%'}])`;
    expect(leaks).toEqual([]);
    const total = (await sql<{ n: string }[]>`select count(*)::text n from audit_log where org_id = ${f.orgId} and action like 'pos.%'`)[0]!.n;
    expect(Number(total)).toBeGreaterThanOrEqual(4);
  });
});

// ==============================================================================================================================
describe('R11 - the append guard (migration 0240): a sales receipt\'s children cannot be added after the receipt was written', () => {
  /** Raw SQL, no domain: this case runs now and FAILS until 0240 exists (the late insert is accepted today). */
  async function oldReceipt() {
    const f = await fixture();
    const st = await newStand(f);
    const [sess] = await sql<{ id: string }[]>`
      insert into table_sessions (org_id, store_id, stand_id, mode, heads_cashier, opened_by, opened_at_device, opened_on_pairing_id)
      values (${f.orgId}, ${f.storeId}, ${st.id}, 'dine_in', 2, ${f.counter.personId}, now(), ${f.pairingId}) returning id`;
    const receiptId = uuid();
    const lineId = uuid();
    // The legal path: parent and children in ONE transaction.
    await sql.begin(async (tx) => {
      await tx`insert into pos_sales_receipts (id, org_id, store_id, terminal_id, receipt_seq, table_session_id, cashier_id, issued_at_device, subtotal, discount_total, total, device_total, offline)
               values (${receiptId}, ${f.orgId}, ${f.storeId}, ${f.terminalRowId}, ${++terminalSeq}, ${sess!.id}, ${f.counter.personId}, now(), 100, 0, 100, 100, false)`;
      await tx`insert into pos_sales_receipt_lines (id, org_id, receipt_id, line_no, kind, name, qty, unit_price, gross, discount_total, net)
               values (${lineId}, ${f.orgId}, ${receiptId}, 1, 'item', 'Pork belly', 1, 100, 100, 0, 100)`;
      await tx`insert into pos_sales_receipt_payments (org_id, receipt_id, tender_id, amount) values (${f.orgId}, ${receiptId}, ${f.cash}, 100)`;
      await tx`insert into pos_sales_receipt_line_discounts (org_id, receipt_line_id, kind, preset_id, label, value_type, value, qty, discount_amount)
               values (${f.orgId}, ${lineId}, 'preset', ${f.emp10}, 'Employee 10%', 'percent', 10, 1, 10)`;
    });
    return { f, receiptId, lineId };
  }
  const code = (e: unknown) => (e as { code?: string }).code;

  it('the single transaction that writes a receipt may write all its children (R9\'s path still works)', async () => {
    const { receiptId } = await oldReceipt();
    expect((await sql`select 1 from pos_sales_receipt_lines where receipt_id = ${receiptId}`).length).toBe(1);
    expect((await sql`select 1 from pos_sales_receipt_payments where receipt_id = ${receiptId}`).length).toBe(1);
  });

  it('a payment added to yesterday\'s receipt in a NEW transaction is refused 23001', async () => {
    const { f, receiptId } = await oldReceipt();
    const err = await sql.begin(async (tx) => {
      await tx`insert into pos_sales_receipt_payments (org_id, receipt_id, tender_id, amount) values (${f.orgId}, ${receiptId}, ${f.cash}, 5)`;
    }).then(() => null, (e: unknown) => e);
    expect(err, 'the late payment was accepted: migration 0240 is not applied').not.toBeNull();
    expect(code(err)).toBe('23001');
  });

  it('a line added to an old receipt is refused 23001', async () => {
    const { f, receiptId } = await oldReceipt();
    const err = await sql.begin(async (tx) => {
      await tx`insert into pos_sales_receipt_lines (org_id, receipt_id, line_no, kind, name, qty, unit_price, gross, discount_total, net)
               values (${f.orgId}, ${receiptId}, 2, 'item', 'Late dish', 1, 50, 50, 0, 50)`;
    }).then(() => null, (e: unknown) => e);
    expect(err, 'the late line was accepted: migration 0240 is not applied').not.toBeNull();
    expect(code(err)).toBe('23001');
  });

  it('a discount added to an old receipt line is refused 23001', async () => {
    const { f, lineId } = await oldReceipt();
    const err = await sql.begin(async (tx) => {
      await tx`insert into pos_sales_receipt_line_discounts (org_id, receipt_line_id, kind, preset_id, label, value_type, value, qty, discount_amount)
               values (${f.orgId}, ${lineId}, 'preset', ${f.promo50}, 'Promo 50 off', 'fixed', 50, 1, 50)`;
    }).then(() => null, (e: unknown) => e);
    expect(err, 'the late discount was accepted: migration 0240 is not applied').not.toBeNull();
    expect(code(err)).toBe('23001');
  });
});

describe('T-528 R1: priceFromDb always passes the real rates', () => {
  it('a bill with NO senior/PWD discount still has the right VAT split (VAT-registered org, 12%): 2 x 250.00 -> VATable 446.43 + VAT 53.57', async () => {
    const f = await fixture();
    const s = await open(f, { heads: 2 });
    await add(f, s.sessionId, [{ item: f.menu.pork, qty: 2 }]);
    const bill = (await asOrg(f.orgId, (tx) => P.getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId: s.sessionId }, RATES))) as unknown as { pricing: { total: string; vat: Record<string, string> } };
    expect(bill.pricing.total).toBe('500.00');
    expect(bill.pricing.vat).toEqual({ vatableSales: '446.43', vatExemptSales: '0.00', vatAmount: '53.57', vatRemovedForScPwd: '0.00' });
  });
});
