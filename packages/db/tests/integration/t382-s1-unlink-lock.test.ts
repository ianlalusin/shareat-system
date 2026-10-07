/**
 * T-382 S1 - migration 0187, the soft unlink and the hardened lock. `docs/tasks/382-pos-store-unlink.md`, section S1,
 * tests D0-D7 (the backfill, B1, is in `t382-s1-backfill.test.ts`).
 *
 * TESTER, not BUILDER. Raw SQL, so the DATABASE is what is proven. Every refusal asserts the SQLSTATE AND the exact
 * constraint name (postgres.js reports a transaction's FIRST error, so a leg that fails for another reason must not
 * pass). Every refusal has a positive control in the same test. Each attempt runs in a transaction that is ALWAYS
 * rolled back, so a write that wrongly succeeds cannot leak into the next leg.
 *
 * ## State at HEAD (no 0187: the three columns do not exist)
 * Red, "column unlinked_at does not exist", in the setup of D1-D6 and in D7. D0 is green on HEAD by design (it is a
 * pin of 0185's shape: a mutant of 0187 turns it red), except its "unlinked store" leg, which sets the columns.
 *
 * ## Where the spec is silent (a question to the builder, not a test edit)
 *  - The FK name on `unlinked_by` is not given (R10 says only "FK ... ON DELETE restrict"), so D6 asserts the
 *    SQLSTATE 23503 only for that leg.
 *  - The unlink columns are set with the owner connection (superuser/BYPASSRLS), as the spec says ("as the owner
 *    role"): the tests prove the DATABASE rule, not the domain.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';
import { closeDb, posV1Repo, transaction } from '@shareat/db';
import { insertDerivedSalesDayRow } from '../../../domain/tests/integration/_fixtures/pos-day';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const FIGURES_LOCKED = 'sales_days_figures_locked';
const TENDERS_LOCKED = 'sales_day_tenders_locked';
const CHANNELS_LOCKED = 'sales_day_channels_locked';
const POS_ID_UNIQUE = 'pos_v1_store_links_pos_store_id_unique';
const SHAPE_CHECK = 'pos_v1_store_links_unlink_shape_check';
const REASON_CHECK = 'pos_v1_store_links_unlink_reason_check';

type Tx = postgres.TransactionSql;
type PgErr = { code?: string; constraint_name?: string; message?: string } | null;

class Rollback extends Error {}

interface AttemptOpts {
  /** Run as the app role with the org set (default true). False: the owner connection (superuser/BYPASSRLS). */
  app?: boolean;
  /** app.org_id set (default true when `app`). */
  org?: boolean;
  /** `app.sales_day_derivation` on. */
  flag?: boolean;
}

/** Runs `fn` in a transaction that is ALWAYS rolled back; returns the error the body raised, or null. */
async function attempt(orgId: string, fn: (t: Tx) => Promise<unknown>, o: AttemptOpts = {}): Promise<PgErr> {
  const app = o.app !== false;
  let caught: unknown = null;
  try {
    await sql.begin(async (t) => {
      if (app) {
        await t.unsafe(`set local role ${APP_ROLE}`);
        await t`select set_config('app.principal_kind', 'staff', true)`;
        if (o.org !== false) await t`select set_config('app.org_id', ${orgId}, true)`;
      }
      if (o.flag) await t`select set_config('app.sales_day_derivation', 'on', true)`;
      try {
        await fn(t);
      } catch (e) {
        caught = e;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return caught as PgErr;
}

async function expectRefused(p: Promise<PgErr>, constraint: string, what: string, code = '23514') {
  const err = await p;
  expect(err, `${what}: expected the write to be refused by ${constraint}, but it succeeded`).not.toBeNull();
  expect({ what, code: err!.code, constraint: err!.constraint_name }).toEqual({ what, code, constraint });
}
async function expectAllowed(p: Promise<PgErr>, what: string) {
  const err = await p;
  expect(err, `${what}: expected the write to be allowed, got ${err?.code} ${err?.constraint_name ?? err?.message}`).toBeNull();
}

// ---- fixtures ---------------------------------------------------------------------------------------------------
async function mkOrg(hint: string) {
  const code = uid(`t382s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  return { orgId, personId: p!.id };
}
type Org = Awaited<ReturnType<typeof mkOrg>>;

/** A store with a remitted Walk-in channel, a non-remitted Foodpanda channel and two wallets; linked iff asked. */
async function mkStore(o: Org, opts: { linked: boolean; name?: string; posId?: string }) {
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${o.orgId}, ${uid('st')}, ${opts.name ?? 'Lipa'}) returning id`;
  const storeId = st!.id;
  const [walk] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${o.orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [fp] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${o.orgId}, ${storeId}, 'Foodpanda', false, '1220') returning id`;
  const wallet = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${o.orgId}, ${storeId}, ${name}, 'ewallet', '1140', 'cashier') returning id`)[0]!.id;
  const wallet1 = await wallet('GCash');
  const wallet2 = await wallet('Maya');
  const s = { storeId, walkInId: walk!.id, foodpandaId: fp!.id, wallet1, wallet2 };
  if (opts.linked) await link(o, s, opts.posId);
  return s;
}
type Store = Awaited<ReturnType<typeof mkStore>>;

/** The link row by raw SQL, as the test's own fixture (not through `linkStoreToPos`). */
async function link(o: Org, s: Pick<Store, 'storeId' | 'walkInId'>, posId?: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${o.orgId}, ${s.storeId}, ${posId ?? uid('pos-store')}, 'Test POS store', ${s.walkInId}, 'vat_inclusive', ${o.personId}) returning id`;
  return row!.id;
}

/** The unlink, as the owner role: the three columns of 0187 set together (R1, R10). */
const unlink = (o: Org, storeId: string, reason = 'wrong POS store') => sql`
  update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${o.personId}, unlink_reason = ${reason} where store_id = ${storeId}`;

/** A committed feed day on a LINKED store (through the fixture helper, which turns the flag on for its insert). */
const feedDay = (o: Org, s: Store, date: string, status: 'open' | 'submitted' | 'verified' = 'open') =>
  insertDerivedSalesDayRow(sql, { orgId: o.orgId, storeId: s.storeId, businessDate: date, createdBy: o.personId, status });

/** Commits `fn` with the flag on (what the derivation path does), for fixtures that need a tender / channel row. */
async function withFlag(fn: (t: Tx) => Promise<unknown>) {
  await sql.begin(async (t) => {
    await t`select set_config('app.sales_day_derivation', 'on', true)`;
    await fn(t);
  });
}
const addTender = (dayId: string, accountId: string, amount = '350.00') =>
  withFlag((t) => t`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${dayId}, ${accountId}, ${amount})`);
const addChannel = (dayId: string, channelId: string, amount = '1100.00') =>
  withFlag((t) => t`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${dayId}, ${channelId}, ${amount})`);

type Patch = Record<string, string | boolean | null>;
const update = (t: Tx, id: string, patch: Patch) => {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  return t.unsafe(`update sales_days set ${sets} where id = $1`, [id, ...keys.map((k) => patch[k] as never)]);
};

const typedInsert = (t: Tx, o: Org, storeId: string, date: string) => t`
  insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
  values (${o.orgId}, ${storeId}, ${date}, 100, 0, 100, ${o.personId})`;

// ======================================================================================================================
describe('D0 - the shape of the three lock functions is pinned (REV-5)', () => {
  const NAMES = ['sales_day_store_is_linked', 'sales_days_check_figure_lock', 'sales_day_child_row_allowed'];

  it('none of the three is SECURITY DEFINER (the owner role bypasses RLS: a definer would see every org links)', async () => {
    const rows = await sql<{ proname: string; prosecdef: boolean }[]>`select proname, prosecdef from pg_proc where proname = any(${NAMES})`;
    expect(rows.map((r) => r.proname).sort(), 'all three functions exist').toEqual([...NAMES].sort());
    expect(rows.filter((r) => r.prosecdef).map((r) => r.proname), 'SECURITY DEFINER functions').toEqual([]);
  });

  it('exactly one sales_day_store_is_linked, with TWO arguments (a one-argument version would be an overload the callers ignore)', async () => {
    const rows = await sql<{ nargs: number; lang: string }[]>`
      select p.pronargs::int as nargs, l.lanname as lang from pg_proc p join pg_language l on l.oid = p.prolang where p.proname = 'sales_day_store_is_linked'`;
    expect(rows.length, 'one pg_proc row (no overload)').toBe(1);
    expect(rows[0]).toEqual({ nargs: 2, lang: 'plpgsql' });
  });

  it('the function treats an unlinked store as not linked (called directly), and a live one as linked', async () => {
    const o = await mkOrg('d0f');
    const s = await mkStore(o, { linked: true });
    const call = () => sql<{ v: boolean }[]>`select sales_day_store_is_linked(${s.storeId}::uuid, 'sales_days_figures_locked') as v`;
    expect((await call())[0]!.v, 'live link').toBe(true);
    await unlink(o, s.storeId);
    expect((await call())[0]!.v, 'unlinked row').toBe(false);
  });

  it('a non-bypass session with NO org context is refused on a typed insert by name (the fail-closed block is kept): 23514 sales_days_figures_locked', async () => {
    const o = await mkOrg('d0n');
    const s = await mkStore(o, { linked: false });
    const [who] = await sql<{ bypass: boolean }[]>`select coalesce(rolsuper or rolbypassrls, false) as bypass from pg_roles where rolname = ${APP_ROLE}`;
    expect(who!.bypass, 'the app role must be a non-bypass role for this to mean anything').toBe(false);
    await expectRefused(attempt(o.orgId, (t) => typedInsert(t, o, s.storeId, '2027-01-10'), { org: false }), FIGURES_LOCKED, 'typed INSERT, app role, app.org_id unset');
    // control: the same insert with the org set is allowed on an unlinked store
    await expectAllowed(attempt(o.orgId, (t) => typedInsert(t, o, s.storeId, '2027-01-10')), 'typed INSERT, app role, org set, store unlinked');
  });
});

describe('D1 - an unlinked store takes typed days again (the function reads LIVE links only)', () => {
  it('linked: a typed INSERT under the app role is refused; after the unlink columns are set it succeeds', async () => {
    const o = await mkOrg('d1');
    const s = await mkStore(o, { linked: true });
    await expectRefused(attempt(o.orgId, (t) => typedInsert(t, o, s.storeId, '2027-01-10')), FIGURES_LOCKED, 'typed INSERT, store LINKED (control)');
    await unlink(o, s.storeId);
    await expectAllowed(attempt(o.orgId, (t) => typedInsert(t, o, s.storeId, '2027-01-10')), 'typed INSERT, store UNLINKED');
    // a typed day written for real, then its figures are editable (the typed branch reads the same function)
    await sql`insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
              values (${o.orgId}, ${s.storeId}, '2027-01-11', 100, 0, 100, ${o.personId})`;
    const [d] = await sql<{ id: string }[]>`select id from sales_days where store_id = ${s.storeId} and business_date = '2027-01-11'`;
    await expectAllowed(attempt(o.orgId, (t) => update(t, d!.id, { cash_collected: '5.00' })), 'figure UPDATE of an open typed day, store unlinked');
  });
});

describe('D2 - a VERIFIED feed day on an unlinked store stays frozen', () => {
  it('figure UPDATE (flag on), source -> legacy_typed, tender UPDATE and DELETE are all refused by name', async () => {
    const o = await mkOrg('d2');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10');
    await addTender(day.id, s.wallet1);
    await sql`update sales_days set status = 'verified', verified_by = ${o.personId}, verified_at = now() where id = ${day.id}`;
    await unlink(o, s.storeId);

    await expectRefused(attempt(o.orgId, (t) => update(t, day.id, { cash_collected: '5.00' }), { flag: true }), FIGURES_LOCKED, 'figure UPDATE, verified feed day, store unlinked, flag on');
    await expectRefused(
      attempt(o.orgId, (t) => update(t, day.id, { source: 'legacy_typed', pos_v1_day_feed_id: null, pos_sourced: false, pos_sourced_at: null })),
      FIGURES_LOCKED, 'source -> legacy_typed, verified feed day, store unlinked',
    );
    await expectRefused(attempt(o.orgId, (t) => t`update sales_day_tenders set amount = '5.00' where sales_day_id = ${day.id}`, { flag: true }), TENDERS_LOCKED, 'tender UPDATE, verified feed day, store unlinked, flag on');
    await expectRefused(attempt(o.orgId, (t) => t`delete from sales_day_tenders where sales_day_id = ${day.id}`, { flag: true }), TENDERS_LOCKED, 'tender DELETE, verified feed day, store unlinked, flag on');
    // control: status moves are never locked (void is allowed, REV-9), so the day is not simply unwritable
    await expectAllowed(
      attempt(o.orgId, (t) => update(t, day.id, { status: 'voided', voided_by: o.personId, voided_at: '2027-01-11T00:00:00Z', void_reason: 'test', updated_at: '2027-01-11T00:00:00Z' })),
      'void of a verified imported day',
    );
  });
});

describe('D3 - R4: an OPEN feed day on an unlinked store is frozen even with the flag on (figures, channels, tenders)', () => {
  it('every write the derivation could make is refused once unlinked; the SAME writes are allowed (flag on) while linked', async () => {
    const o = await mkOrg('d3');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10');
    const empty = await feedDay(o, s, '2027-01-11');
    await addTender(day.id, s.wallet1);
    await addChannel(day.id, s.walkInId);

    const figure = (t: Tx) => update(t, day.id, { cash_collected: '5.00' });
    const chanIns = (t: Tx) => t`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${empty.id}, ${s.walkInId}, '10.00')`;
    const chanUpd = (t: Tx) => t`update sales_day_channels set amount = '5.00' where sales_day_id = ${day.id}`;
    const tenderIns = (t: Tx) => t`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${empty.id}, ${s.wallet2}, '10.00')`;
    const tenderUpd = (t: Tx) => t`update sales_day_tenders set amount = '5.00' where sales_day_id = ${day.id}`;
    const tenderDel = (t: Tx) => t`delete from sales_day_tenders where sales_day_id = ${day.id}`;

    // controls, while LINKED: the derivation (flag on) may write every one of them
    await expectAllowed(attempt(o.orgId, figure, { flag: true }), 'control: figure UPDATE, linked, flag on');
    await expectAllowed(attempt(o.orgId, chanIns, { flag: true }), 'control: remitted channel INSERT, linked, flag on');
    await expectAllowed(attempt(o.orgId, chanUpd, { flag: true }), 'control: remitted channel UPDATE, linked, flag on');
    await expectAllowed(attempt(o.orgId, tenderIns, { flag: true }), 'control: tender INSERT, linked, flag on');
    await expectAllowed(attempt(o.orgId, tenderUpd, { flag: true }), 'control: tender UPDATE, linked, flag on');

    await unlink(o, s.storeId);

    await expectRefused(attempt(o.orgId, figure, { flag: true }), FIGURES_LOCKED, 'figure UPDATE, OPEN feed day, unlinked, flag on');
    await expectRefused(attempt(o.orgId, chanIns, { flag: true }), CHANNELS_LOCKED, 'remitted channel INSERT, unlinked, flag on');
    await expectRefused(attempt(o.orgId, chanUpd, { flag: true }), CHANNELS_LOCKED, 'remitted channel UPDATE, unlinked, flag on');
    // REV-6: a tender reaches the same branch as a remitted channel row (p_remitted is NULL); an "only when IS TRUE" mutant survives without these
    await expectRefused(attempt(o.orgId, tenderIns, { flag: true }), TENDERS_LOCKED, 'tender INSERT, unlinked, flag on');
    await expectRefused(attempt(o.orgId, tenderUpd, { flag: true }), TENDERS_LOCKED, 'tender UPDATE, unlinked, flag on');
    await expectRefused(attempt(o.orgId, tenderDel, { flag: true }), TENDERS_LOCKED, 'tender DELETE, unlinked, flag on');
  });

  it('the same refusal holds for a SUBMITTED feed day (R4 is about the link, not the status)', async () => {
    const o = await mkOrg('d3s');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10', 'submitted');
    await expectAllowed(attempt(o.orgId, (t) => update(t, day.id, { cash_collected: '5.00' }), { flag: true }), 'control: figure UPDATE, submitted feed day, linked, flag on');
    await unlink(o, s.storeId);
    await expectRefused(attempt(o.orgId, (t) => update(t, day.id, { cash_collected: '5.00' }), { flag: true }), FIGURES_LOCKED, 'figure UPDATE, SUBMITTED feed day, unlinked, flag on');
  });
});

describe('D4 - R4 leaves PLATFORM (non-remitted) channel rows alone', () => {
  it('a Foodpanda row on an open (and a submitted) feed day of the unlinked store is still writable; on a verified day it is not (existing rule)', async () => {
    const o = await mkOrg('d4');
    const s = await mkStore(o, { linked: true });
    const open = await feedDay(o, s, '2027-01-10');
    const submitted = await feedDay(o, s, '2027-01-11', 'submitted');
    const verified = await feedDay(o, s, '2027-01-12', 'verified');
    await unlink(o, s.storeId);
    const fp = (id: string) => (t: Tx) => t`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${id}, ${s.foodpandaId}, '500.00')`;
    await expectAllowed(attempt(o.orgId, fp(open.id)), 'Foodpanda INSERT, open feed day, unlinked, flag off');
    await expectAllowed(attempt(o.orgId, fp(open.id), { flag: true }), 'Foodpanda INSERT, open feed day, unlinked, flag on');
    await expectAllowed(attempt(o.orgId, fp(submitted.id)), 'Foodpanda INSERT, submitted feed day, unlinked');
    await expectRefused(attempt(o.orgId, fp(verified.id)), CHANNELS_LOCKED, 'Foodpanda INSERT, VERIFIED feed day, unlinked');
  });
});

describe('D5 - an unlinked store keeps its POS store (REV-1: the full UNIQUE stands; no double import)', () => {
  it('store B cannot link the POS id an unlinked store A still holds (23505 on the UNIQUE); A can relink its own row', async () => {
    const o = await mkOrg('d5');
    const posId = uid('P1');
    const a = await mkStore(o, { linked: true, posId, name: 'A' });
    const b = await mkStore(o, { linked: false, name: 'B' });
    await unlink(o, a.storeId);

    await expectRefused(
      attempt(o.orgId, (t) => t`
        insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
        values (${o.orgId}, ${b.storeId}, ${posId}, 'Test POS store', ${b.walkInId}, 'vat_inclusive', ${o.personId})`),
      POS_ID_UNIQUE, 'store B links the POS id of unlinked store A', '23505',
    );

    // the same store relinking is an UPDATE of its own row and is allowed (same POS id, the three unlink columns cleared)
    await expectAllowed(
      attempt(o.orgId, (t) => t`
        update pos_v1_store_links set unlinked_at = null, unlinked_by = null, unlink_reason = null, pos_store_id = ${posId}, updated_at = now(), updated_by = ${o.personId}
         where store_id = ${a.storeId}`),
      'A relinks to its own POS id',
    );
    // and the live row means A is linked again
    await sql`update pos_v1_store_links set unlinked_at = null, unlinked_by = null, unlink_reason = null where store_id = ${a.storeId}`;
    const [v] = await sql<{ v: boolean }[]>`select sales_day_store_is_linked(${a.storeId}::uuid, 'sales_days_figures_locked') as v`;
    expect(v!.v, 'A is linked again once the unlink columns are cleared').toBe(true);
  });
});

describe('D6 - R10: the unlink shape and the reason are enforced by the database', () => {
  it('unlinked_at without unlinked_by / reason, and the reverse, are refused by the shape CHECK; the all-set shape is allowed', async () => {
    const o = await mkOrg('d6a');
    const s = await mkStore(o, { linked: true });
    const upd = (set: string) => (t: Tx) => t.unsafe(`update pos_v1_store_links set ${set} where store_id = '${s.storeId}'`);
    await expectRefused(attempt(o.orgId, upd(`unlinked_at = now()`), { app: false }), SHAPE_CHECK, 'unlinked_at alone');
    await expectRefused(attempt(o.orgId, upd(`unlinked_at = now(), unlinked_by = '${o.personId}'`), { app: false }), SHAPE_CHECK, 'unlinked_at + unlinked_by, no reason');
    await expectRefused(attempt(o.orgId, upd(`unlinked_at = now(), unlink_reason = 'why'`), { app: false }), SHAPE_CHECK, 'unlinked_at + reason, no unlinked_by');
    await expectRefused(attempt(o.orgId, upd(`unlinked_by = '${o.personId}'`), { app: false }), SHAPE_CHECK, 'unlinked_by alone');
    await expectRefused(attempt(o.orgId, upd(`unlink_reason = 'why'`), { app: false }), SHAPE_CHECK, 'reason alone');
    await expectAllowed(attempt(o.orgId, upd(`unlinked_at = now(), unlinked_by = '${o.personId}', unlink_reason = 'why'`), { app: false }), 'control: the all-set shape');
  });

  it('a blank reason and a 501-character reason are refused by the reason CHECK; 500 characters is allowed', async () => {
    const o = await mkOrg('d6b');
    const s = await mkStore(o, { linked: true });
    const withReason = (reason: string) => (t: Tx) => t`
      update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${o.personId}, unlink_reason = ${reason} where store_id = ${s.storeId}`;
    await expectRefused(attempt(o.orgId, withReason('   '), { app: false }), REASON_CHECK, 'reason of three spaces');
    await expectRefused(attempt(o.orgId, withReason(''), { app: false }), REASON_CHECK, 'empty reason');
    await expectRefused(attempt(o.orgId, withReason('x'.repeat(501)), { app: false }), REASON_CHECK, '501-character reason');
    await expectAllowed(attempt(o.orgId, withReason('x'.repeat(500)), { app: false }), 'control: a 500-character reason');
    await expectAllowed(attempt(o.orgId, withReason('wrong POS store'), { app: false }), 'control: an ordinary reason');
  });

  it('unlinked_by must be a real person (FK, ON DELETE restrict): a random uuid is 23503', async () => {
    const o = await mkOrg('d6c');
    const s = await mkStore(o, { linked: true });
    const err = await attempt(
      o.orgId,
      (t) => t`update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${crypto.randomUUID()}, unlink_reason = 'why' where store_id = ${s.storeId}`,
      { app: false },
    );
    expect(err, 'expected an FK refusal').not.toBeNull();
    expect(err!.code).toBe('23503');
  });

  it('the app role may set the unlink columns (UPDATE is granted); there is still no DELETE', async () => {
    const o = await mkOrg('d6d');
    const s = await mkStore(o, { linked: true });
    await expectAllowed(
      attempt(o.orgId, (t) => t`update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${o.personId}, unlink_reason = 'why' where store_id = ${s.storeId}`),
      'unlink under the app role',
    );
    const err = await attempt(o.orgId, (t) => t`delete from pos_v1_store_links where store_id = ${s.storeId}`);
    expect(err?.code, 'DELETE stays ungranted (42501)').toBe('42501');
  });
});

describe('D7 - the repo: "live" filters on two reads, none on the other three', () => {
  async function asOrgTx<T>(orgId: string, fn: (tx: import('@shareat/db').Tx) => Promise<T>): Promise<T> {
    return transaction(async (tx) => {
      await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
      await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
      return fn(tx);
    });
  }

  it('live row: all five reads return it with unlinkedAt null; unlinked row: getLinkByStore / getLinkByChannel are undefined, the other three return it with unlinkedAt set', async () => {
    const o = await mkOrg('d7');
    const posId = uid('P1');
    const s = await mkStore(o, { linked: true, posId });
    const readAll = () =>
      asOrgTx(o.orgId, async (tx) => ({
        byStore: await posV1Repo.getLinkByStore(tx, o.orgId, s.storeId),
        byChannel: await posV1Repo.getLinkByChannel(tx, o.orgId, s.walkInId),
        byPos: await posV1Repo.getLinkByPosStoreId(tx, o.orgId, posId),
        forUpdate: await posV1Repo.getLinkByStoreForUpdate(tx, o.orgId, s.storeId),
        list: await posV1Repo.listLinks(tx, o.orgId),
      }));

    const live = await readAll();
    expect(live.byStore?.storeId, 'control: live getLinkByStore').toBe(s.storeId);
    expect(live.byChannel?.storeId, 'control: live getLinkByChannel').toBe(s.storeId);
    expect(live.byPos?.storeId, 'control: live getLinkByPosStoreId').toBe(s.storeId);
    expect(live.forUpdate?.storeId, 'control: live getLinkByStoreForUpdate').toBe(s.storeId);
    expect(live.list.length, 'control: live listLinks').toBe(1);

    await unlink(o, s.storeId, 'wrong POS store');

    const gone = await readAll();
    expect(gone.byStore, 'getLinkByStore must not return an unlinked row').toBeUndefined();
    expect(gone.byChannel, 'getLinkByChannel must not return an unlinked row').toBeUndefined();
    expect(gone.byPos?.unlinkedAt, 'getLinkByPosStoreId stays UNFILTERED (REV-1): the POS id is still held').toBeInstanceOf(Date);
    expect(gone.byPos?.storeId).toBe(s.storeId);
    expect(gone.forUpdate?.unlinkedAt, 'getLinkByStoreForUpdate returns the unlinked row, so a relink re-uses it').toBeInstanceOf(Date);
    expect(gone.list.length).toBe(1);
    expect(gone.list[0]?.unlinkedAt).toBeInstanceOf(Date);
    expect(gone.list[0]?.unlinkReason).toBe('wrong POS store');
    expect(gone.list[0]?.unlinkedBy).toBe(o.personId);
  });
});
