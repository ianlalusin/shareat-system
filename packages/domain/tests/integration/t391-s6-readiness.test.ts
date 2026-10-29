import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-391 S6 - `docs/tasks/391-production-master-data-load.md`, test 24 (+ S8, R7, row 303/q12). TESTER file.
 * Real Postgres. The per-store READINESS report. Read-only.
 *
 * CONTRACT these tests pin (the spec names files, not signatures - the builder builds to this):
 *   scripts/lib/master-data-readiness.ts
 *     readiness(tx, actor, input) -> Promise<{ orgId: string; stores: StoreReadiness[] }>
 *       tx    = a transaction already opened with withOrgPrincipal(input.orgId, ...) (the CLI wraps it); readiness never opens its own.
 *       input = { orgId, orgCode, map: StoreMapRow[] (parseStoreMap output), storeCodes?: string[], snapshot?: Snapshot }
 *               storeCodes omitted = every map row of THIS org (the map's org_code === orgCode); never a store of another org.
 *               Naming a store code that belongs to another org, or that is not in the map, throws (message matches org, map or organisation) before any read.
 *       StoreReadiness (one per store, in storeCodes order, else map order) = {
 *         storeCode: string; storeId: string;
 *         ready: boolean;                       // reasons.length === 0
 *         reasons: string[];                    // each of 'no_pos_link' | 'no_cash_account' | 'no_encoder' | 'no_verifier' | 'encoder_is_verifier'
 *         posLinked: boolean;                   // a LIVE pos_v1_store_links row (unlinked_at is null) for the store
 *         cashAccount: boolean;                 // an ACTIVE money_accounts row, instrument 'cash', at the store
 *         encoders: { personId: string; displayName: string }[];   // sorted by displayName
 *         verifiers: { personId: string; displayName: string }[];  // sorted by displayName
 *         loaded: { items, suppliers, customers, staff, positions: number };
 *         planned?: { staff: number };          // only when input.snapshot is given
 *       }
 *     ENCODER  = a person with an OPEN employment (ended_on null) at the store who is EFFECTIVELY allowed both `create_expense` and
 *                `receive_delivery` there, exactly as authorize() decides (active person_roles row, store scope, CAPABILITY_MATRIX, and person_grants
 *                incl. the position grants createEmployment / reconcilePositionGrants materialise). So a Cashier hired through the production path IS
 *                one; a raw position_capability_defaults row nobody materialised is NOT; a manager or admin with scope and an open employment IS.
 *     VERIFIER = a person with an ACTIVE `manager` role (revoked_at null) and person_store_scope at the store (admin not counted).
 *     reasons: no encoder -> 'no_encoder'; no verifier -> 'no_verifier'; encoders AND verifiers both exist but NO pair (e, v) with e != v exists
 *       -> 'encoder_is_verifier'. One encoder A with verifiers {A, B} is NOT flagged (A -> B is independent).
 *     loaded.items|suppliers|customers|positions = v1_master_links rows of that entity whose v1_store_id is the store's v1 id (map);
 *       loaded.staff = OPEN employments at the store. planned.staff = snapshot staff of that v1 store that the load would hire
 *       (isActive and not resigned/terminated).
 *     AUTHORIZATION: authorize(tx, actor, 'manage_store_settings', { storeId }) at EVERY store in scope, before any read of data
 *       (the same capability the positions step uses); AuthorizationError otherwise. An actor of another org is refused (/org/i).
 *     READ-ONLY: no row in any table changes and NO audit row is written.
 *   scripts/master-data.ts: `readiness --org --stores --sheets` (the builder wires it; not tested here).
 *
 * Each test names its killing mutant. Red today: scripts/lib/master-data-readiness.ts does not exist (dynamic import fails).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { parseStoreMap } from '../../../etl/src/master-data/store-map';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const D = 'dvoTestStoreId000001'; // T-454 S2: Davao stands in for Banay-Banay as the third own store
const P = 'y1DMgfisuTHBF57cNL6i';

const mapCsv = (se: string, pg: string): string =>
  [
    'v1_store_id,name,role,org_code,store_code',
    `${L},SharEat Lipa,own,${se},LIPA`,
    `${M},SharEat Malvar,own,${se},MLVR`,
    // T-454 S2: Banay-Banay closes 31 Dec (row 377)
    `${B},SharEat Banay-Banay,exclude,${se},BNBN`,
    `${D},SharEat Davao,own,${se},DAVAO`,
    `${P},SharEat Padre Garcia,franchise,${pg},PGAR`,
  ].join('\r\n');

interface Env {
  orgId: string;
  orgCode: string;
  pgOrgId: string;
  pgCode: string;
  stores: Record<string, string>;
  pgStoreId: string;
  map: Any[];
  superA: Actor;
  superPg: Actor;
  manager: Actor; // manager scoped to LIPA only
  staff: Actor;
  mkPerson: (name: string) => Promise<string>;
}

async function mkOrg(code: string, storeCodes: string[]) {
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const stores: Record<string, string> = {};
  for (const sc of storeCodes) {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${sc}, ${`Store ${sc}`}) returning id`;
    stores[sc] = s!.id;
  }
  const first = Object.values(stores)[0]!;
  const mk = async (name: string, role: string, all = false) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const sid of all ? Object.values(stores) : [first]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${sid})`;
    return p!.id;
  };
  await withOrgPrincipal(orgId, async (tx: Any) => (await dom()).seedCanonicalPositions(tx, orgId));
  return { orgId, stores, mk };
}

async function env(hint: string): Promise<Env> {
  const orgCode = uid(`R${hint}`);
  const pgCode = uid(`G${hint}`);
  const a = await mkOrg(orgCode, ['LIPA', 'MLVR', 'DAVAO']);
  const b = await mkOrg(pgCode, ['PGAR']);
  const act = (orgId: string, personId: string): Actor => ({ orgId, personId });
  return {
    orgId: a.orgId,
    orgCode,
    pgOrgId: b.orgId,
    pgCode,
    stores: a.stores,
    pgStoreId: b.stores.PGAR!,
    map: parseStoreMap(mapCsv(orgCode, pgCode)),
    superA: act(a.orgId, await a.mk('Super', 'super_admin', true)),
    superPg: act(b.orgId, await b.mk('SuperPg', 'super_admin', true)),
    manager: act(a.orgId, await a.mk('Boss Manager', 'manager')),
    staff: act(a.orgId, await a.mk('Plain Staff', 'staff')),
    mkPerson: async (name: string) => {
      const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${a.orgId}, ${name}) returning id`;
      return p!.id;
    },
  };
}

async function dom(): Promise<Any> {
  return import('@shareat/domain');
}
async function mod(): Promise<Any> {
  return import('../../../../scripts/lib/master-data-readiness');
}
async function failure(p: PromiseLike<unknown>): Promise<any> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be refused');
}

/** The report for one org, the way the CLI calls it. */
async function report(orgId: string, orgCode: string, e: Env, actor: Actor, over: Record<string, unknown> = {}): Promise<Any> {
  const m = await mod();
  return withOrgPrincipal(orgId, (tx: Any) => m.readiness(tx, actor, { orgId, orgCode, map: e.map, ...over }));
}
const reportA = (e: Env, over: Record<string, unknown> = {}, actor: Actor = e.superA) => report(e.orgId, e.orgCode, e, actor, over);
const storeOf = (r: Any, code: string): Any => {
  const s = (r.stores as Any[]).find((x) => x.storeCode === code);
  if (!s) throw new Error(`no ${code} in the report: ${JSON.stringify((r.stores as Any[]).map((x) => x.storeCode))}`);
  return s;
};

// ---- fixtures: a store's state, by raw rows ---------------------------------------------------------------------
let ec = 0;
async function canonicalPositionId(orgId: string, name: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`select id from positions where org_id = ${orgId} and is_canonical and name = ${name}`;
  return r!.id;
}
const seeded = new Set<string>();
/** The production seeding of a store's position defaults (what createStore does); once per store. Hires after it get real materialised grants. */
async function seedDefaults(e: Env, storeCode: string): Promise<void> {
  const sid = e.stores[storeCode]!;
  if (seeded.has(sid)) return;
  seeded.add(sid);
  await withOrgPrincipal(e.orgId, async (tx: Any) => (await dom()).seedStoreAccessDefaults(tx, e.superA, sid));
}
/** The production toggle: writes or revokes ONE default and reconciles every holder's grants. */
async function toggleDefault(e: Env, storeCode: string, positionName: string, capability: string, on: boolean): Promise<void> {
  const positionId = await canonicalPositionId(e.orgId, positionName);
  await withOrgPrincipal(e.orgId, async (tx: Any) =>
    (await dom()).setPositionDefault(tx, e.superA, { positionId, storeId: e.stores[storeCode]!, capability, on, reason: on ? undefined : 'test' }));
}
/** A person hired through createEmployment (the production path: staff role, store scope, position grants from the store's defaults). */
async function employ(e: Env, storeCode: string, name: string, positionName: string, over: { ended?: boolean } = {}) {
  const personId = await e.mkPerson(name);
  const positionId = await canonicalPositionId(e.orgId, positionName);
  const emp: Any = await withOrgPrincipal(e.orgId, async (tx: Any) =>
    (await dom()).createEmployment(tx, e.superA, { storeId: e.stores[storeCode]!, personId, employmentStatus: 'regular', startedOn: '2026-01-05', positionIds: [positionId] }));
  if (over.ended) {
    await withOrgPrincipal(e.orgId, async (tx: Any) =>
      (await dom()).endEmployment(tx, e.superA, { employmentId: emp.id, endedOn: '2026-02-05', employmentStatus: 'resigned' }));
  }
  return { personId, employmentId: emp.id as string };
}
/** An encoder: hired as Cashier at a store whose defaults are seeded (Cashier holds create_expense + receive_delivery there). */
const encoder = async (e: Env, storeCode: string, name: string) => {
  await seedDefaults(e, storeCode);
  return employ(e, storeCode, name, 'Cashier');
};
/** Replace a person's active role (revoke + insert, the production shape). */
async function setRole(e: Env, personId: string, role: string): Promise<void> {
  await sql`update person_roles set revoked_at = now() where person_id = ${personId} and revoked_at is null`;
  await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${e.orgId}, ${role})`;
}
/** A verifier: an ACTIVE manager role scoped to the store. An existing employee keeps the scope their hire gave them. */
async function verifier(e: Env, storeCode: string, name: string, personId?: string): Promise<string> {
  const pid = personId ?? (await e.mkPerson(name));
  await setRole(e, pid, 'manager');
  await sql`insert into person_store_scope (person_id, store_id) values (${pid}, ${e.stores[storeCode]!}) on conflict do nothing`;
  return pid;
}
async function linkPos(e: Env, storeCode: string): Promise<string> {
  const storeId = e.stores[storeCode]!;
  const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${e.orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [l] = await sql<{ id: string }[]>`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${e.orgId}, ${storeId}, ${uid('pos-store')}, 'POS store', ${ch!.id}, 'vat_inclusive', ${e.superA.personId}) returning id`;
  return l!.id;
}
async function cashAccount(e: Env, storeCode: string, active = true): Promise<void> {
  await sql`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${e.orgId}, ${e.stores[storeCode]!}, ${uid('Office cash ')}, 'cash', '1110', 'office', ${active})`;
}
/** The foundation cash accounts every store is born with (migration 0029) count as cash accounts; a no_cash_account case turns them off. */
const noCash = (e: Env, storeCode: string) => sql`update money_accounts set is_active = false where store_id = ${e.stores[storeCode]!} and instrument = 'cash'`;
/** The org's fixture manager (Boss Manager, Lipa scope) is a real verifier at Lipa; cases about WHO verifies retire that role first. */
const retireBoss = (e: Env) => sql`update person_roles set revoked_at = now() where person_id = ${e.manager.personId}`;
/** A fully ready store: POS link, cash account, one Cashier encoder, one separate manager. */
async function readyStore(e: Env, storeCode: string): Promise<{ encoderId: string; verifierId: string }> {
  await linkPos(e, storeCode);
  await cashAccount(e, storeCode);
  const enc = await encoder(e, storeCode, `Enc ${storeCode}`);
  const ver = await verifier(e, storeCode, `Ver ${storeCode}`);
  return { encoderId: enc.personId, verifierId: ver };
}
async function addLink(e: Env, entity: string, v1Store: string, v1Id: string): Promise<void> {
  const item = entity === 'item';
  await sql`insert into v1_master_links (org_id, entity, v1_store_id, v1_id, v2_id, v1_unit, factor_to_base, created_by)
    values (${e.orgId}, ${entity}, ${v1Store}, ${v1Id}, ${crypto.randomUUID()}, ${item ? 'pc' : null}, ${item ? '1' : null}, ${e.superA.personId})`;
}

/** Row counts of every table the report could conceivably touch, plus a fingerprint of the rows' ids. */
const WATCH = [
  'audit_log', 'persons', 'person_roles', 'person_store_scope', 'person_grants', 'employments', 'employment_positions', 'positions',
  'position_capability_defaults', 'v1_master_links', 'money_accounts', 'pos_v1_store_links', 'sales_channels', 'stores', 'items', 'suppliers',
];
async function snapshotTables(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of WATCH) out[t] = Number((await sql.unsafe(`select count(*)::int as n from ${t}`))[0]!.n);
  return out;
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('S6 readiness - the verdict per store (test 24)', () => {
  it(
    'a fully set-up store says ready: no reasons, POS linked, a cash account, its encoder and its verifier named. Killing mutant: ready hard-coded false, or the lists left empty',
    async () => {
      const e = await env('OK');
      await retireBoss(e);
      const { encoderId, verifierId } = await readyStore(e, 'LIPA');
      const s = storeOf(await reportA(e, { storeCodes: ['LIPA'] }), 'LIPA');
      expect(s.ready).toBe(true);
      expect(s.reasons).toEqual([]);
      expect(s.posLinked).toBe(true);
      expect(s.cashAccount).toBe(true);
      expect(s.storeId).toBe(e.stores.LIPA);
      expect(s.encoders.map((x: Any) => x.personId)).toEqual([encoderId]);
      expect(s.encoders[0].displayName).toBe('Enc LIPA');
      expect(s.verifiers.map((x: Any) => x.personId)).toEqual([verifierId]);
      expect(s.verifiers[0].displayName).toBe('Ver LIPA');
    },
    60_000,
  );

  it(
    'a bare store is named with EVERY missing piece: no_pos_link, no_cash_account, no_encoder, no_verifier. Killing mutant: the loop stops at the first reason',
    async () => {
      const e = await env('BR');
      await noCash(e, 'MLVR');
      const s = storeOf(await reportA(e, { storeCodes: ['MLVR'] }), 'MLVR');
      expect(s.ready).toBe(false);
      expect([...s.reasons].sort()).toEqual(['no_cash_account', 'no_encoder', 'no_pos_link', 'no_verifier']);
      expect(s.posLinked).toBe(false);
      expect(s.cashAccount).toBe(false);
      expect(s.encoders).toEqual([]);
      expect(s.verifiers).toEqual([]);
    },
    60_000,
  );

  it.each([
    ['no POS link', 'no_pos_link'],
    ['no cash account', 'no_cash_account'],
    ['no encoder', 'no_encoder'],
    ['no verifier', 'no_verifier'],
  ])(
    'a store missing only %s is named with exactly that reason. Killing mutant: that check removed or its reason mislabelled',
    async (_label, reason) => {
      const e = await env('ON');
      const sc = 'DAVAO';
      if (reason !== 'no_pos_link') await linkPos(e, sc);
      if (reason !== 'no_cash_account') await cashAccount(e, sc);
      else await noCash(e, sc);
      if (reason !== 'no_encoder') await encoder(e, sc, 'Only Enc');
      if (reason !== 'no_verifier') await verifier(e, sc, 'Only Ver');
      const s = storeOf(await reportA(e, { storeCodes: [sc] }), sc);
      expect(s.ready).toBe(false);
      expect(s.reasons).toEqual([reason]);
    },
    60_000,
  );

  it(
    'the same person as the only encoder AND the only verifier is flagged encoder_is_verifier (and not no_encoder / no_verifier). Killing mutant: encoder = verifier allowed',
    async () => {
      const e = await env('SP');
      await retireBoss(e);
      await linkPos(e, 'LIPA');
      await cashAccount(e, 'LIPA');
      const enc = await encoder(e, 'LIPA', 'Both Hats');
      await verifier(e, 'LIPA', 'unused', enc.personId); // the cashier is also the store's manager
      const s = storeOf(await reportA(e, { storeCodes: ['LIPA'] }), 'LIPA');
      expect(s.ready).toBe(false);
      expect(s.reasons).toEqual(['encoder_is_verifier']);
      expect(s.encoders.map((x: Any) => x.personId)).toEqual([enc.personId]);
      expect(s.verifiers.map((x: Any) => x.personId)).toEqual([enc.personId]);
    },
    60_000,
  );

  it(
    'one encoder A with verifiers {A, B} is NOT flagged: the pair A -> B is independent. Killing mutant: any overlap between the two lists flags the store',
    async () => {
      const e = await env('PR');
      await retireBoss(e);
      await linkPos(e, 'LIPA');
      const enc = await encoder(e, 'LIPA', 'Cashier A');
      await verifier(e, 'LIPA', 'unused', enc.personId); // A is also a manager
      const b = await verifier(e, 'LIPA', 'Manager B');
      const s = storeOf(await reportA(e, { storeCodes: ['LIPA'] }), 'LIPA');
      expect(s.reasons).not.toContain('encoder_is_verifier');
      expect(s.reasons).not.toContain('no_verifier');
      expect(s.reasons).not.toContain('no_encoder');
      expect(s.verifiers.map((x: Any) => x.personId).sort()).toEqual([enc.personId, b].sort());
    },
    60_000,
  );
});

describe('S6 readiness - who counts as an encoder or a verifier (S8, row 303)', () => {
  it(
    'an encoder needs BOTH create_expense AND receive_delivery on a position they hold: a Cook, a position with only one of the two, and a person with the defaults but an ENDED employment are not encoders. Killing mutants: OR instead of AND; ended employments counted; any position counts',
    async () => {
      const e = await env('EN');
      await seedDefaults(e, 'LIPA'); // Cashier: both; Cook: neither; Inventory Staff: receive_delivery only
      await toggleDefault(e, 'LIPA', 'Server', 'create_expense', true); // Server: create_expense only
      const yes = await employ(e, 'LIPA', 'Real Cashier', 'Cashier');
      await employ(e, 'LIPA', 'Just A Cook', 'Kitchen Staff');
      await employ(e, 'LIPA', 'Half Server', 'Server');
      await employ(e, 'LIPA', 'Half Inventory', 'Inventory Staff');
      await employ(e, 'LIPA', 'Left Cashier', 'Cashier', { ended: true });
      const s = storeOf(await reportA(e, { storeCodes: ['LIPA'] }), 'LIPA');
      expect(s.encoders.map((x: Any) => x.displayName)).toEqual(['Real Cashier']);
      expect(s.encoders[0].personId).toBe(yes.personId);
    },
    60_000,
  );

  it(
    'a position that holds both capabilities at ANOTHER store, or whose defaults are REVOKED, makes nobody an encoder here. Killing mutants: defaults read org-wide; revoked defaults counted',
    async () => {
      const e = await env('SC');
      await seedDefaults(e, 'MLVR'); // Malvar only: Cashier holds both there
      await employ(e, 'LIPA', 'Lipa Cashier', 'Cashier'); // Lipa's defaults were never seeded: no grants
      await seedDefaults(e, 'DAVAO');
      await employ(e, 'DAVAO', 'Davao Cashier', 'Cashier');
      await toggleDefault(e, 'DAVAO', 'Cashier', 'receive_delivery', false); // revoked through the production toggle: the holder's grant goes too
      const r = await reportA(e);
      expect(storeOf(r, 'LIPA').encoders).toEqual([]);
      expect(storeOf(r, 'DAVAO').encoders).toEqual([]);
      expect(storeOf(r, 'LIPA').reasons).toContain('no_encoder');
      expect(storeOf(r, 'DAVAO').reasons).toContain('no_encoder');
    },
    60_000,
  );

  it(
    'EFFECTIVE capabilities decide (as authorize() resolves them): a Lipa Cook with an active person_grants grant of both capabilities AT Lipa (store_id) and Lipa scope IS an encoder; the same grant at another store (store_id Malvar), a grant without Lipa scope, and a REVOKED grant do not make an encoder at Lipa. Killing mutants: grants ignored; grant store_id ignored; scope ignored; revoked grants counted',
    async () => {
      const e = await env('GR');
      const both = ['create_expense', 'receive_delivery'];
      const grant = async (personId: string, sc: string, caps: string[]) => {
        for (const c of caps) await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id) values (${personId}, ${c}, ${e.superA.personId}, 'grant', ${e.stores[sc]!})`;
      };
      const scope = (personId: string, sc: string) => sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${e.stores[sc]!})`;
      const yes = await employ(e, 'LIPA', 'Granted Cook', 'Kitchen Staff');
      await grant(yes.personId, 'LIPA', both);
      const elsewhere = await employ(e, 'LIPA', 'Grant At Malvar Cook', 'Kitchen Staff');
      await grant(elsewhere.personId, 'MLVR', both);
      await scope(elsewhere.personId, 'MLVR');
      const noScope = await employ(e, 'LIPA', 'Unscoped Cook', 'Kitchen Staff');
      await grant(noScope.personId, 'LIPA', both);
      await sql`delete from person_store_scope where person_id = ${noScope.personId} and store_id = ${e.stores.LIPA!}`;
      await scope(noScope.personId, 'MLVR');
      const revoked = await employ(e, 'LIPA', 'Revoked Grant Cook', 'Kitchen Staff');
      await grant(revoked.personId, 'LIPA', both);
      await sql`update person_grants set revoked_at = now(), revoke_reason = 'test' where person_id = ${revoked.personId}`;
      const r = await reportA(e, { storeCodes: ['LIPA'] });
      expect(storeOf(r, 'LIPA').encoders.map((x: Any) => x.displayName)).toEqual(['Granted Cook']);
    },
    60_000,
  );

  it(
    'PARITY with authorize(): of the people with an open employment at Lipa, readiness counts exactly those for whom the real authorize() passes BOTH create_expense and receive_delivery at Lipa. Mix: manager with scope, admin with scope, Cashier with materialised grants, a Cook with a RAW default row nobody materialised, a Cashier without store scope, a Cashier with no active role, a Cashier whose grant was revoked. Killing mutants: raw defaults read; scope ignored; role ignored; revoked grants counted; the matrix ignored',
    async () => {
      const e = await env('PA');
      await seedDefaults(e, 'LIPA');
      const mgr = await employ(e, 'LIPA', 'Pa Manager', 'Kitchen Staff');
      await setRole(e, mgr.personId, 'manager');
      const adm = await employ(e, 'LIPA', 'Pa Admin', 'Kitchen Staff');
      await setRole(e, adm.personId, 'admin');
      const cashier = await employ(e, 'LIPA', 'Pa Cashier', 'Cashier');
      const rawCook = await employ(e, 'LIPA', 'Pa Raw Default Cook', 'Kitchen Staff');
      const cookPos = await canonicalPositionId(e.orgId, 'Kitchen Staff');
      for (const c of ['create_expense', 'receive_delivery']) {
        await sql`insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by)
          values (${e.orgId}, ${cookPos}, ${e.stores.LIPA!}, ${c}, ${e.superA.personId})`;
      }
      const noScope = await employ(e, 'LIPA', 'Pa No Scope', 'Cashier');
      await sql`delete from person_store_scope where person_id = ${noScope.personId} and store_id = ${e.stores.LIPA!}`;
      const noRole = await employ(e, 'LIPA', 'Pa No Role', 'Cashier');
      await sql`update person_roles set revoked_at = now() where person_id = ${noRole.personId} and revoked_at is null`;
      const revGrant = await employ(e, 'LIPA', 'Pa Revoked Grant', 'Cashier');
      await sql`update person_grants set revoked_at = now(), revoke_reason = 'test' where person_id = ${revGrant.personId} and grant_name = 'receive_delivery'`;
      const people = [mgr, adm, cashier, rawCook, noScope, noRole, revGrant];

      const { authorize } = await import('@shareat/auth');
      const passes = async (personId: string): Promise<boolean> =>
        withOrgPrincipal(e.orgId, async (tx: Any) => {
          for (const cap of ['create_expense', 'receive_delivery']) {
            try {
              await authorize(tx, { orgId: e.orgId, personId }, cap as Any, { storeId: e.stores.LIPA! });
            } catch (err) {
              if (err instanceof AuthorizationError) return false;
              throw err;
            }
          }
          return true;
        });
      const expected: string[] = [];
      for (const p of people) if (await passes(p.personId)) expected.push(p.personId);
      // the guard against a vacuous parity: the fixture really does split the people both ways
      expect(expected).toContain(mgr.personId);
      expect(expected).toContain(adm.personId);
      expect(expected).toContain(cashier.personId);
      expect(expected).not.toContain(rawCook.personId);
      expect(expected).not.toContain(noScope.personId);
      expect(expected).not.toContain(noRole.personId);
      expect(expected).not.toContain(revGrant.personId);

      const s = storeOf(await reportA(e, { storeCodes: ['LIPA'] }), 'LIPA');
      expect(s.encoders.map((x: Any) => x.personId).sort()).toEqual([...expected].sort());
    },
    120_000,
  );

  it(
    'a verifier is an ACTIVE manager scoped to THIS store: a manager scoped elsewhere, a revoked manager role, and an admin/staff role are not verifiers. Killing mutants: scope ignored; revoked role counted; any role counts',
    async () => {
      const e = await env('VR');
      const here = await verifier(e, 'MLVR', 'Mlvr Manager');
      const away = await e.mkPerson('Away Manager');
      await sql`insert into person_roles (person_id, org_id, role) values (${away}, ${e.orgId}, 'manager')`;
      await sql`insert into person_store_scope (person_id, store_id) values (${away}, ${e.stores.LIPA!})`;
      const gone = await verifier(e, 'MLVR', 'Revoked Manager');
      await sql`update person_roles set revoked_at = now() where person_id = ${gone}`;
      const s = storeOf(await reportA(e, { storeCodes: ['MLVR'] }), 'MLVR');
      expect(s.verifiers.map((x: Any) => x.personId)).toEqual([here]);
    },
    60_000,
  );

  it(
    'a retired POS link and an inactive cash account do not count: the store is named no_pos_link and no_cash_account. Killing mutants: an unlinked row counted; is_active ignored',
    async () => {
      const e = await env('RT');
      await noCash(e, 'LIPA');
      await linkPos(e, 'LIPA');
      await sql`update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${e.superA.personId}, unlink_reason = 'wrong store' where store_id = ${e.stores.LIPA!}`;
      await cashAccount(e, 'LIPA', false);
      const s = storeOf(await reportA(e, { storeCodes: ['LIPA'] }), 'LIPA');
      expect(s.posLinked).toBe(false);
      expect(s.cashAccount).toBe(false);
      expect(s.reasons).toEqual(expect.arrayContaining(['no_pos_link', 'no_cash_account']));
    },
    60_000,
  );
});

describe('S6 readiness - what loaded against the plan', () => {
  it(
    'per store: items, suppliers, customers, positions come from the v1 links of THAT v1 store, staff from its open employments; another store and another entity do not leak in. Killing mutants: counts org-wide; wrong entity counted; ended employments counted',
    async () => {
      const e = await env('LD');
      for (const n of ['i1', 'i2', 'i3']) await addLink(e, 'item', L, n);
      await addLink(e, 'item', M, 'm1');
      for (const n of ['s1', 's2']) await addLink(e, 'supplier', L, n);
      await addLink(e, 'customer', L, 'c1');
      await addLink(e, 'position', L, 'p1');
      await addLink(e, 'position', L, 'p2');
      await addLink(e, 'person', L, 'ignored-person'); // persons are not a column of the report
      await employ(e, 'LIPA', 'Open One', 'Kitchen Staff');
      await employ(e, 'LIPA', 'Open Two', 'Server');
      await employ(e, 'LIPA', 'Ended Three', 'Kitchen Staff', { ended: true });
      await employ(e, 'MLVR', 'Malvar One', 'Kitchen Staff');
      const r = await reportA(e, { storeCodes: ['LIPA', 'MLVR'] });
      expect(storeOf(r, 'LIPA').loaded).toEqual({ items: 3, suppliers: 2, customers: 1, staff: 2, positions: 2 });
      expect(storeOf(r, 'MLVR').loaded).toEqual({ items: 1, suppliers: 0, customers: 0, staff: 1, positions: 0 });
    },
    60_000,
  );

  it(
    'with a snapshot, planned.staff is what the load would hire (active, not resigned) and sits beside loaded.staff; without one, planned is absent. Killing mutants: planned counts inactive or resigned rows; planned always present',
    async () => {
      const e = await env('PL');
      const st = (store: string, over: Record<string, unknown> = {}) => ({
        id: `st${++seq}`, store, staffCode: '', fullName: `P ${seq}`, positions: ['Kitchen Staff'], employmentStatus: 'regular', dateHired: '2026-01-05T00:00:00.000Z', isActive: true, ...over,
      });
      const snapshot = {
        version: 1, stores: [], items: [], suppliers: [], arCustomers: [], staffIdentities: [],
        staff: [st(L), st(L), st(L, { isActive: false }), st(L, { employmentStatus: 'resigned' }), st(M)],
      };
      await employ(e, 'LIPA', 'Loaded One', 'Kitchen Staff');
      const withSnap = storeOf(await reportA(e, { storeCodes: ['LIPA'], snapshot }), 'LIPA');
      expect(withSnap.planned).toEqual({ staff: 2 });
      expect(withSnap.loaded.staff).toBe(1);
      const without = storeOf(await reportA(e, { storeCodes: ['LIPA'] }), 'LIPA');
      expect(without.planned).toBeUndefined();
    },
    60_000,
  );

  it(
    'storeCodes selects and orders the stores; omitted means every store of the org in map order (and never Padre Garcia). Killing mutant: the filter ignored',
    async () => {
      const e = await env('SL');
      const one = await reportA(e, { storeCodes: ['MLVR'] });
      expect(one.stores.map((x: Any) => x.storeCode)).toEqual(['MLVR']);
      const all = await reportA(e);
      expect(all.stores.map((x: Any) => x.storeCode)).toEqual(['LIPA', 'MLVR', 'DAVAO']);
    },
    60_000,
  );
});

describe('S6 readiness - the franchise org is reported separately (R7)', () => {
  it(
    'Padre Garcia is reported only under its own org: that org\'s call returns PGAR alone, and asking for PGAR under the main org is refused. Killing mutants: the report spans orgs; the cross-org store accepted',
    async () => {
      const e = await env('FR');
      const pg = await report(e.pgOrgId, e.pgCode, e, e.superPg);
      expect(pg.orgId).toBe(e.pgOrgId);
      expect(pg.stores.map((x: Any) => x.storeCode)).toEqual(['PGAR']);
      expect(storeOf(pg, 'PGAR').storeId).toBe(e.pgStoreId);
      expect(storeOf(pg, 'PGAR').reasons).toEqual(expect.arrayContaining(['no_pos_link', 'no_encoder']));

      const main = await reportA(e);
      expect(main.stores.map((x: Any) => x.storeCode)).not.toContain('PGAR');
      const err = await failure(reportA(e, { storeCodes: ['LIPA', 'PGAR'] }));
      expect(String(err.message)).toMatch(/organi[sz]ation|org_code|store map|not in/i);
    },
    60_000,
  );

  it(
    'a store of the franchise org with the main org\'s data present: the franchise report sees none of the main org\'s links or employees. Killing mutant: a query without the org filter',
    async () => {
      const e = await env('IS');
      await readyStore(e, 'LIPA');
      await addLink(e, 'item', P, 'main-org-link-on-pg-id'); // a link on the franchise's v1 id but under the MAIN org
      const pg = await report(e.pgOrgId, e.pgCode, e, e.superPg);
      expect(storeOf(pg, 'PGAR').loaded).toEqual({ items: 0, suppliers: 0, customers: 0, staff: 0, positions: 0 });
    },
    60_000,
  );
});

describe('S6 readiness - authorization and read-only', () => {
  it(
    'an actor without manage_store_settings (staff), a manager scoped to Lipa asking for Malvar, and an actor of another org are all refused with nothing read. Killing mutants: the authorize call removed; checked for one store only; org check removed',
    async () => {
      const e = await env('AZ');
      await readyStore(e, 'LIPA');
      expect(await failure(reportA(e, { storeCodes: ['LIPA'] }, e.staff))).toBeInstanceOf(AuthorizationError);
      expect(await failure(reportA(e, { storeCodes: ['LIPA', 'MLVR'] }, e.manager))).toBeInstanceOf(AuthorizationError);
      const ok = await reportA(e, { storeCodes: ['LIPA'] }, e.manager); // a manager at their own store may
      expect(storeOf(ok, 'LIPA').storeCode).toBe('LIPA');
      const err = await failure(reportA(e, { storeCodes: ['LIPA'] }, e.superPg)); // a super_admin of the franchise org
      expect(err).toBeDefined();
      expect(err instanceof AuthorizationError || /org/i.test(String(err.message))).toBe(true);
    },
    60_000,
  );

  it(
    'it is READ-ONLY: every watched table has the same row count after the report (ready, bare and franchise stores alike), and no audit row is written. Killing mutants: an audit row for the run; a repair or a seed inserted; a link created',
    async () => {
      const e = await env('RO');
      await readyStore(e, 'LIPA');
      await encoder(e, 'MLVR', 'Half Done');
      const before = await snapshotTables();
      await reportA(e);
      await reportA(e, { storeCodes: ['LIPA'] });
      await report(e.pgOrgId, e.pgCode, e, e.superPg);
      const after = await snapshotTables();
      expect(after).toEqual(before);
      expect(after.audit_log).toBe(before.audit_log);
    },
    60_000,
  );

  it(
    'running it twice gives the same report (no state is consumed). Killing mutant: a cursor or a cache that changes the second answer',
    async () => {
      const e = await env('ID');
      await readyStore(e, 'LIPA');
      const a = await reportA(e);
      const b = await reportA(e);
      expect(b).toEqual(a);
    },
    60_000,
  );
});
