/**
 * T-375 S4 - migration 0185, the link-aware lock. `docs/tasks/375-pos-v1-day-feed.md` R6 and section S4, tests
 * K1-K6, K8, K10, K11, K12 (K7, the sentence map, is in `apps/erp/tests/integration/t375-s4-day-page.test.ts`).
 *
 * TESTER, not BUILDER. Raw SQL, so the DATABASE is what is proven. Every refusal asserts the TARGET: SQLSTATE 23514
 * and the exact constraint name. Every refusal has a positive control in the same test (flag on, store unlinked, or
 * the derivation path).
 *
 * ## Why these are red on HEAD
 * 0185 does not exist, so no trigger fires: the write the spec says must be refused SUCCEEDS. Each refused leg is
 * written as "expected the write to be refused by <constraint>, but it succeeded". Every attempt runs in a
 * transaction that is ALWAYS rolled back, so a write that wrongly succeeds on HEAD cannot leak into the next leg.
 * Legs that already pass on HEAD (the controls, K11, K12's RLS legs, which the spec says RLS stops first) are the
 * guards a mutant must turn red; the report lists them.
 *
 * ## Where the spec is silent (a question to the builder, not a test edit)
 *  - R6 writes the three trigger constraint names as `sales_days_figures_locked` and "`…_tenders_locked`,
 *    `…_channels_locked`". Read here as `sales_day_tenders_locked` and `sales_day_channels_locked` (the table names,
 *    which also keeps the prefix pattern of the first). One place to change if the builder spells them otherwise:
 *    the constants below and K7 in the apps test.
 *  - The `pos_sourced` leg of K1 can only be changed alone by breaking `sales_days_feed_source_pos_sourced_check`
 *    (a feed day must be pos_sourced); on HEAD that CHECK is what refuses it (so that leg is red on the constraint
 *    NAME, not on "it succeeded"). With 0185 the BEFORE UPDATE trigger fires first and names the lock.
 *  - `source` / `pos_sourced` / the feed id are changed in the one statement that keeps the row's CHECKs satisfied
 *    where a single column cannot (the `source` leg changes the four provenance columns together).
 */
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';
import { closeDb, transaction } from '@shareat/db';
import { withSalesDayDerivation } from '../../src/repo/sales-days';
import { insertDerivedSalesDayRow } from '../../../domain/tests/integration/_fixtures/pos-day';

const sql = postgres(url, { max: 8 });
/** ONE connection: the same pooled session serves consecutive transactions (K6). */
const one = postgres(url, { max: 1 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await one.end({ timeout: 5 });
  await sql.end({ timeout: 5 });
});

const FIGURES_LOCKED = 'sales_days_figures_locked';
const TENDERS_LOCKED = 'sales_day_tenders_locked';
const CHANNELS_LOCKED = 'sales_day_channels_locked';
const STORE_FIXED = 'pos_v1_store_links_store_fixed';

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

async function expectRefused(p: Promise<PgErr>, constraint: string, what: string) {
  const err = await p;
  expect(err, `${what}: expected the write to be refused by ${constraint}, but it succeeded`).not.toBeNull();
  expect({ what, code: err!.code, constraint: err!.constraint_name }).toEqual({ what, code: '23514', constraint });
}
async function expectAllowed(p: Promise<PgErr>, what: string) {
  const err = await p;
  expect(err, `${what}: expected the write to be allowed, got ${err?.code} ${err?.constraint_name ?? err?.message}`).toBeNull();
}

// ---- fixtures ---------------------------------------------------------------------------------------------------
async function mkOrg(hint: string) {
  const code = uid(`t375s4l-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  return { orgId, personId: p!.id };
}
type Org = Awaited<ReturnType<typeof mkOrg>>;

/** A store with a remitted Walk-in channel, a non-remitted Foodpanda channel and two wallets; linked iff asked. */
async function mkStore(o: Org, opts: { linked: boolean; name?: string }) {
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
  if (opts.linked) await link(o, s);
  return s;
}
type Store = Awaited<ReturnType<typeof mkStore>>;

/** The link row by raw SQL, as the test's own fixture (not through `linkStoreToPos`). */
async function link(o: Org, s: Pick<Store, 'storeId' | 'walkInId'>) {
  const [row] = await sql<{ id: string }[]>`
    insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${o.orgId}, ${s.storeId}, ${uid('pos-store')}, 'Test POS store', ${s.walkInId}, 'vat_inclusive', ${o.personId}) returning id`;
  return row!.id;
}

async function feedRow(o: Org, storeId: string, date: string): Promise<string> {
  const [f] = await sql<{ id: string }[]>`
    insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_at, fetched_by)
    values (${o.orgId}, ${storeId}, ${date}, 'sales', 'import', ${crypto.randomUUID()}, 'pos-fixture', '{"found":true}', '{"found":true}'::jsonb,
            ${createHash('sha256').update(uid('h')).digest('hex')}, now(), ${o.personId}) returning id`;
  return f!.id;
}

/** A committed feed day on a LINKED store (through the fixture helper, which turns the flag on for its insert). */
const feedDay = (o: Org, s: Store, date: string, status: 'open' | 'submitted' | 'verified' = 'open') =>
  insertDerivedSalesDayRow(sql, { orgId: o.orgId, storeId: s.storeId, businessDate: date, createdBy: o.personId, status });

/** A committed TYPED day (raw insert, no flag, no source: the column default), made BEFORE the store is linked. */
async function typedDay(o: Org, storeId: string, date: string, status: 'open' | 'verified' = 'open'): Promise<string> {
  const [d] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by, verified_by, verified_at)
    values (${o.orgId}, ${storeId}, ${date}, ${status}, 100, 0, 100, 100, ${o.personId}, ${status === 'verified' ? o.personId : null},
            ${status === 'verified' ? new Date().toISOString() : null}) returning id`;
  return d!.id;
}

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

const rawInsert = (t: Tx, o: Org, storeId: string, date: string, x: { source?: string; feedId?: string | null } = {}) => t`
  insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by,
                          source, pos_v1_day_feed_id, pos_sourced, pos_sourced_at)
  values (${o.orgId}, ${storeId}, ${date}, 100, 0, 100, ${o.personId}, ${x.source ?? 'legacy_typed'}, ${x.feedId ?? null},
          ${x.feedId != null}, ${x.feedId != null ? new Date().toISOString() : null})`;

// ======================================================================================================================
describe('K1 - a LINKED store\'s feed day: every protected column refuses an UPDATE without the flag', () => {
  it('each of the twelve figures, refunds, store_id, business_date, source, the feed id, pos_sourced, pos_sourced_at is refused (sales_days_figures_locked); status moves are allowed', async () => {
    const o = await mkOrg('k1');
    const s = await mkStore(o, { linked: true });
    const s2 = await mkStore(o, { linked: false, name: 'Batangas' });
    const day = await feedDay(o, s, '2027-01-10');
    const otherFeed = await feedRow(o, s.storeId, '2027-01-10');

    const patches: Record<string, Patch> = {
      total_sales: { total_sales: '1101.00', ala_carte_sales: '501.00' },
      unli_sales: { unli_sales: '599.00', ala_carte_sales: '501.00' },
      ala_carte_sales: { ala_carte_sales: '499.00', unli_sales: '601.00' },
      // single-column patches: the lock must fire on EACH of the three revenue columns by itself (it fires before the CHECK)
      'total_sales (alone)': { total_sales: '1101.00' },
      'unli_sales (alone)': { unli_sales: '599.00' },
      'ala_carte_sales (alone)': { ala_carte_sales: '499.00' },
      senior_discount: { senior_discount: '5.00' },
      pwd_discount: { pwd_discount: '5.00' },
      other_discount: { other_discount: '5.00' },
      comps: { comps: '5.00' },
      service_charge: { service_charge: '5.00' },
      other_charges: { other_charges: '5.00' },
      cash_collected: { cash_collected: '5.00' },
      online_collected: { online_collected: '5.00' },
      credit_sales: { credit_sales: '5.00' },
      refunds: { refunds: '10.00' },
      store_id: { store_id: s2.storeId },
      business_date: { business_date: '2027-02-02' },
      // the four provenance columns together, so no CHECK fires first on HEAD: only the lock can refuse this
      source: { source: 'legacy_typed', pos_v1_day_feed_id: null, pos_sourced: false, pos_sourced_at: null },
      pos_v1_day_feed_id: { pos_v1_day_feed_id: otherFeed },
      pos_sourced: { pos_sourced: false },
      pos_sourced_at: { pos_sourced_at: '2027-03-03T00:00:00Z' },
    };
    // collect every column's outcome, so one run names ALL the columns the lock misses
    const bad: string[] = [];
    for (const [col, patch] of Object.entries(patches)) {
      const err = await attempt(o.orgId, (t) => update(t, day.id, patch));
      if (!err) bad.push(`${col}: succeeded`);
      else if (err.code !== '23514' || err.constraint_name !== FIGURES_LOCKED) bad.push(`${col}: refused by ${err.code} ${err.constraint_name}`);
    }
    expect(bad, 'columns an UPDATE without the flag must be refused on (sales_days_figures_locked)').toEqual([]);
    // controls: the derivation path (flag on, open day) may change a figure; submit, verify and withdraw are never locked
    await expectAllowed(attempt(o.orgId, (t) => update(t, day.id, patches.cash_collected!), { flag: true }), 'a figure UPDATE with the flag on, open feed day');
    await expectAllowed(
      attempt(o.orgId, (t) => update(t, day.id, { status: 'submitted', submitted_by: o.personId, submitted_at: '2027-01-11T00:00:00Z', updated_at: '2027-01-11T00:00:00Z' })),
      'submit (markSubmitted)',
    );
    await expectAllowed(
      attempt(o.orgId, (t) => update(t, day.id, { status: 'verified', verified_by: o.personId, verified_at: '2027-01-11T00:00:00Z', updated_at: '2027-01-11T00:00:00Z' })),
      'verify (markVerified)',
    );
    await expectAllowed(
      attempt(o.orgId, (t) => update(t, day.id, { status: 'voided', voided_by: o.personId, voided_at: '2027-01-11T00:00:00Z', void_reason: 'test', updated_at: '2027-01-11T00:00:00Z' })),
      'withdraw (markUnverifiedVoided)',
    );
  });
});

describe('K2 - a LINKED store: INSERT needs the flag AND source = pos_v1_day_feed', () => {
  it('flag off -> refused; flag on but legacy_typed -> refused; control: flag on + feed -> allowed', async () => {
    const o = await mkOrg('k2');
    const s = await mkStore(o, { linked: true });
    const feedId = await feedRow(o, s.storeId, '2027-01-10');
    await expectRefused(attempt(o.orgId, (t) => rawInsert(t, o, s.storeId, '2027-01-10', { source: 'pos_v1_day_feed', feedId })), FIGURES_LOCKED, 'feed INSERT, flag off');
    await expectRefused(attempt(o.orgId, (t) => rawInsert(t, o, s.storeId, '2027-01-10'), { flag: true }), FIGURES_LOCKED, 'legacy_typed INSERT, flag ON');
    await expectAllowed(attempt(o.orgId, (t) => rawInsert(t, o, s.storeId, '2027-01-10', { source: 'pos_v1_day_feed', feedId }), { flag: true }), 'feed INSERT, flag on');
  });
});

describe('K3 - verified days are never rewritten, flag or not', () => {
  it('a VERIFIED feed day: a figure UPDATE with the flag ON is refused', async () => {
    const o = await mkOrg('k3a');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10', 'verified');
    await expectRefused(attempt(o.orgId, (t) => update(t, day.id, { cash_collected: '5.00' }), { flag: true }), FIGURES_LOCKED, 'figure UPDATE on a verified feed day, flag on');
    // control: the same UPDATE while open and flagged is allowed
    const open = await feedDay(o, s, '2027-01-11');
    await expectAllowed(attempt(o.orgId, (t) => update(t, open.id, { cash_collected: '5.00' }), { flag: true }), 'same UPDATE, open feed day');
  });

  it('a legacy_typed VERIFIED day of the now-linked store: a figure UPDATE is refused, flag on or off', async () => {
    const o = await mkOrg('k3b');
    const s = await mkStore(o, { linked: false });
    const id = await typedDay(o, s.storeId, '2027-01-05', 'verified');
    await expectAllowed(attempt(o.orgId, (t) => update(t, id, { cash_collected: '5.00' })), 'control: typed day, store still UNLINKED');
    await link(o, s);
    await expectRefused(attempt(o.orgId, (t) => update(t, id, { cash_collected: '5.00' })), FIGURES_LOCKED, 'typed verified day, linked, flag off');
    await expectRefused(attempt(o.orgId, (t) => update(t, id, { cash_collected: '5.00' }), { flag: true }), FIGURES_LOCKED, 'typed verified day, linked, flag on');
  });
});

describe('K4 - sales_day_tenders on a LINKED feed day', () => {
  it('INSERT / UPDATE / DELETE without the flag are refused; with the flag allowed', async () => {
    const o = await mkOrg('k4');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10');
    await addTender(day.id, s.wallet1);
    await expectRefused(
      attempt(o.orgId, (t) => t`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${day.id}, ${s.wallet2}, '10.00')`),
      TENDERS_LOCKED, 'tender INSERT, flag off',
    );
    await expectRefused(attempt(o.orgId, (t) => t`update sales_day_tenders set amount = '5.00' where sales_day_id = ${day.id}`), TENDERS_LOCKED, 'tender UPDATE, flag off');
    await expectRefused(attempt(o.orgId, (t) => t`delete from sales_day_tenders where sales_day_id = ${day.id}`), TENDERS_LOCKED, 'tender DELETE, flag off');
    // controls: the same three with the flag on
    await expectAllowed(
      attempt(o.orgId, (t) => t`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${day.id}, ${s.wallet2}, '10.00')`, { flag: true }),
      'tender INSERT, flag on',
    );
    await expectAllowed(attempt(o.orgId, (t) => t`update sales_day_tenders set amount = '5.00' where sales_day_id = ${day.id}`, { flag: true }), 'tender UPDATE, flag on');
    await expectAllowed(attempt(o.orgId, (t) => t`delete from sales_day_tenders where sales_day_id = ${day.id}`, { flag: true }), 'tender DELETE, flag on');
  });

  it('a tender row on a TYPED day needs the store UNLINKED: allowed while unlinked (control), refused once linked', async () => {
    const o = await mkOrg('k4t');
    const s = await mkStore(o, { linked: false });
    const id = await typedDay(o, s.storeId, '2027-01-05');
    const ins = (t: Tx) => t`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${id}, ${s.wallet1}, '10.00')`;
    await expectAllowed(attempt(o.orgId, ins), 'typed day tender INSERT, store unlinked');
    await link(o, s);
    await expectRefused(attempt(o.orgId, ins), TENDERS_LOCKED, 'typed day tender INSERT, store now linked');
    await expectRefused(attempt(o.orgId, ins, { flag: true }), TENDERS_LOCKED, 'typed day tender INSERT, store linked, flag on');
  });
});

describe('K4b - flagged child-row writes on a FEED day need the day open or submitted', () => {
  it('a VERIFIED feed day, flag ON: a tender UPDATE and a remitted channel UPDATE are refused by name; control: the same on an OPEN feed day are allowed', async () => {
    const o = await mkOrg('k4b');
    const s = await mkStore(o, { linked: true });
    const open = await feedDay(o, s, '2027-01-10');
    const verified = await feedDay(o, s, '2027-01-11');
    for (const d of [open, verified]) {
      await addTender(d.id, s.wallet1);
      await addChannel(d.id, s.walkInId);
    }
    // children are written while open (the derivation), then the day is verified (status moves are never locked)
    await sql`update sales_days set status = 'verified', verified_by = ${o.personId}, verified_at = now() where id = ${verified.id}`;
    const tender = (id: string) => (t: Tx) => t`update sales_day_tenders set amount = '5.00' where sales_day_id = ${id}`;
    const channel = (id: string) => (t: Tx) => t`update sales_day_channels set amount = '5.00' where sales_day_id = ${id}`;
    await expectAllowed(attempt(o.orgId, tender(open.id), { flag: true }), 'tender UPDATE, open feed day, flag on');
    await expectAllowed(attempt(o.orgId, channel(open.id), { flag: true }), 'remitted channel UPDATE, open feed day, flag on');
    await expectRefused(attempt(o.orgId, tender(verified.id), { flag: true }), TENDERS_LOCKED, 'tender UPDATE, VERIFIED feed day, flag on');
    await expectRefused(attempt(o.orgId, channel(verified.id), { flag: true }), CHANNELS_LOCKED, 'remitted channel UPDATE, VERIFIED feed day, flag on');
  });
});

describe('K5 - sales_day_channels on a LINKED feed day: remitted rows are locked; platform rows follow the day\'s status', () => {
  it('a REMITTED channel row: INSERT / UPDATE / DELETE without the flag refused; with the flag allowed', async () => {
    const o = await mkOrg('k5');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10');
    await addChannel(day.id, s.walkInId);
    const empty = await feedDay(o, s, '2027-01-11');
    await expectRefused(attempt(o.orgId, (t) => t`update sales_day_channels set amount = '5.00' where sales_day_id = ${day.id}`), CHANNELS_LOCKED, 'Walk-in UPDATE, flag off');
    await expectRefused(attempt(o.orgId, (t) => t`delete from sales_day_channels where sales_day_id = ${day.id}`), CHANNELS_LOCKED, 'Walk-in DELETE, flag off');
    await expectRefused(
      attempt(o.orgId, (t) => t`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${empty.id}, ${s.walkInId}, '10.00')`),
      CHANNELS_LOCKED, 'Walk-in INSERT, flag off',
    );
    await expectAllowed(attempt(o.orgId, (t) => t`update sales_day_channels set amount = '5.00' where sales_day_id = ${day.id}`, { flag: true }), 'Walk-in UPDATE, flag on');
    await expectAllowed(
      attempt(o.orgId, (t) => t`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${empty.id}, ${s.walkInId}, '10.00')`, { flag: true }),
      'Walk-in INSERT, flag on',
    );
  });

  it('a NON-remitted (platform) row: allowed without the flag on an OPEN or SUBMITTED day; refused on a VERIFIED day', async () => {
    const o = await mkOrg('k5p');
    const s = await mkStore(o, { linked: true });
    const open = await feedDay(o, s, '2027-01-10');
    const submitted = await feedDay(o, s, '2027-01-11', 'submitted');
    const verified = await feedDay(o, s, '2027-01-12', 'verified');
    const fp = (id: string) => (t: Tx) => t`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${id}, ${s.foodpandaId}, '500.00')`;
    await expectAllowed(attempt(o.orgId, fp(open.id)), 'Foodpanda INSERT, open day, no flag');
    await expectAllowed(attempt(o.orgId, fp(submitted.id)), 'Foodpanda INSERT, submitted day, no flag');
    await expectRefused(attempt(o.orgId, fp(verified.id)), CHANNELS_LOCKED, 'Foodpanda INSERT, VERIFIED day');
    await expectRefused(attempt(o.orgId, fp(verified.id), { flag: true }), CHANNELS_LOCKED, 'Foodpanda INSERT, VERIFIED day, flag on');
  });

  it('a channel row on a TYPED day needs the store UNLINKED', async () => {
    const o = await mkOrg('k5t');
    const s = await mkStore(o, { linked: false });
    const id = await typedDay(o, s.storeId, '2027-01-05');
    const ins = (t: Tx) => t`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${id}, ${s.walkInId}, '100.00')`;
    await expectAllowed(attempt(o.orgId, ins), 'typed day Walk-in INSERT, store unlinked');
    await link(o, s);
    await expectRefused(attempt(o.orgId, ins), CHANNELS_LOCKED, 'typed day Walk-in INSERT, store linked');
  });
});

describe('K6 - the flag is transaction-local', () => {
  it('after a derivation transaction COMMITS, the next transaction on the same connection updating a figure is refused', async () => {
    const o = await mkOrg('k6');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10');
    const asApp = async (flag: boolean, fn: (t: Tx) => Promise<unknown>) =>
      one.begin(async (t) => {
        await t.unsafe(`set local role ${APP_ROLE}`);
        await t`select set_config('app.principal_kind', 'staff', true)`;
        await t`select set_config('app.org_id', ${o.orgId}, true)`;
        if (flag) await t`select set_config('app.sales_day_derivation', 'on', true)`;
        return fn(t);
      });
    await asApp(true, (t) => update(t, day.id, { cash_collected: '5.00' })); // the derivation commits
    const err = await asApp(false, (t) => update(t, day.id, { cash_collected: '6.00' })).then(() => null, (e) => e as PgErr);
    expect(err, 'expected the next transaction on the same connection to be refused, but it succeeded (the flag leaked)').not.toBeNull();
    expect({ code: err!.code, constraint: err!.constraint_name }).toEqual({ code: '23514', constraint: FIGURES_LOCKED });
  });
});

describe('K8 / K11 - withSalesDayDerivation (R6, W4)', () => {
  async function asOrgTx<T>(orgId: string, fn: (tx: import('@shareat/db').Tx) => Promise<T>): Promise<T> {
    return transaction(async (tx) => {
      await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
      await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
      return fn(tx);
    });
  }
  const chainOf = (e: unknown): { code?: string; constraint_name?: string }[] => {
    const out: { code?: string; constraint_name?: string }[] = [];
    for (let x: unknown = e, i = 0; x && i < 6; i++, x = (x as { cause?: unknown }).cause) out.push(x as never);
    return out;
  };

  it('K8: in ONE transaction, after withSalesDayDerivation returns, a figure UPDATE is refused', async () => {
    const o = await mkOrg('k8');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10');
    let inside: unknown = 'not run';
    const err = await asOrgTx(o.orgId, async (tx) => {
      await withSalesDayDerivation(tx, async () => {
        await tx.execute(dsql`update sales_days set cash_collected = '5.00' where id = ${day.id}`);
        inside = 'updated';
      });
      await tx.execute(dsql`update sales_days set cash_collected = '6.00' where id = ${day.id}`);
    }).then(() => null, (e) => e);
    expect(inside, 'the update INSIDE the derivation must be allowed').toBe('updated');
    expect(err, 'expected the update after withSalesDayDerivation returned to be refused by the lock, but it succeeded').not.toBeNull();
    expect(chainOf(err).some((c) => c.code === '23514' && c.constraint_name === FIGURES_LOCKED), 'the refusal names the lock').toBe(true);
  });

  it('K11: an error raised INSIDE withSalesDayDerivation escapes it as the REAL 23514 + constraint name, not 25P02 (the flag is not reset after an error)', async () => {
    // WHY THE OLD K11 WAS BLIND: it looked at the error leaving `transaction()`, and postgres.js reports the FIRST error of
    // an aborted transaction there whatever the callback threw last. A reset moved into `finally` throws 25P02 INSIDE the
    // callback, so the error has to be caught inside the transaction, right where it leaves withSalesDayDerivation.
    const o = await mkOrg('k11');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10');
    let escaped: unknown = null;
    await asOrgTx(o.orgId, async (tx) => {
      try {
        await withSalesDayDerivation(tx, async () => {
          await tx.execute(dsql`update sales_days set ala_carte_sales = '1.00' where id = ${day.id}`); // 600 + 1 <> 1100: 23514
        });
      } catch (e) {
        escaped = e;
      }
    }).catch(() => undefined); // the aborted transaction rolls back and re-raises its first error at commit; `escaped` is what is asserted
    expect(escaped, 'the revenue identity must refuse').not.toBeNull();
    const chain = chainOf(escaped);
    const seen = JSON.stringify(chain.map((c) => [c.code, c.constraint_name]));
    expect(chain.some((c) => c.code === '23514' && c.constraint_name === 'sales_days_revenue_identity_check'), `the error leaving withSalesDayDerivation is the real constraint (chain: ${seen})`).toBe(true);
    expect(chain.some((c) => c.code === '25P02'), `no 25P02 hiding it (chain: ${seen})`).toBe(false);
  });

  it('K6b: withSalesDayDerivation itself is transaction-local: on ONE connection, after a derivation transaction COMMITS the setting is blank/off and a locked write is refused', async () => {
    const o = await mkOrg('k6b');
    const s = await mkStore(o, { linked: true });
    const day = await feedDay(o, s, '2027-01-10');
    const client = postgres(url!, { max: 1 }); // the same session serves both transactions
    try {
      const db = drizzle(client);
      type T = import('@shareat/db').Tx;
      const asApp = async <R>(fn: (tx: T) => Promise<R>): Promise<R> =>
        db.transaction(async (tx) => {
          await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
          await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
          await tx.execute(dsql`select set_config('app.org_id', ${o.orgId}, true)`);
          return fn(tx as unknown as T);
        });
      const setting = async (tx: T) =>
        ((await tx.execute(dsql`select current_setting('app.sales_day_derivation', true) as v`)) as unknown as { v: string | null }[])[0]!.v;

      let inside: string | null = null;
      await asApp((tx) =>
        withSalesDayDerivation(tx, async () => {
          inside = await setting(tx);
          await tx.execute(dsql`update sales_days set cash_collected = '5.00' where id = ${day.id}`);
        }),
      ); // commits
      expect(inside, 'control: inside the derivation the setting is on').toBe('on');

      let after: string | null = 'unset';
      let err: unknown = null;
      await asApp(async (tx) => {
        after = await setting(tx);
        try {
          await tx.execute(dsql`update sales_days set cash_collected = '6.00' where id = ${day.id}`);
        } catch (e) {
          err = e;
        }
      }).catch(() => undefined); // aborted tx: rollback re-raises at commit; `err` is asserted
      expect(['', 'off', null], `the setting must not outlive the derivation transaction (saw ${String(after)})`).toContain(after);
      expect(err, 'expected the locked write on the same connection to be refused, but it succeeded').not.toBeNull();
      expect(chainOf(err).some((c) => c.code === '23514' && c.constraint_name === FIGURES_LOCKED)).toBe(true);
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

describe('K10 - the switch is the link row (V2b)', () => {
  it('LINKED: a raw legacy_typed INSERT is refused; a feed INSERT without the flag is refused', async () => {
    const o = await mkOrg('k10a');
    const s = await mkStore(o, { linked: true });
    const feedId = await feedRow(o, s.storeId, '2027-01-10');
    await expectRefused(attempt(o.orgId, (t) => rawInsert(t, o, s.storeId, '2027-01-10')), FIGURES_LOCKED, 'legacy_typed INSERT on a linked store, flag off');
    await expectRefused(attempt(o.orgId, (t) => rawInsert(t, o, s.storeId, '2027-01-10', { source: 'pos_v1_day_feed', feedId })), FIGURES_LOCKED, 'feed INSERT on a linked store, flag off');
  });

  it('UNLINKED controls: a no-source INSERT lands as legacy_typed; an open typed day\'s figure UPDATE is allowed; a feed INSERT is refused (it needs a link)', async () => {
    const o = await mkOrg('k10b');
    const s = await mkStore(o, { linked: false });
    const [r] = await sql<{ id: string; source: string }[]>`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${o.orgId}, ${s.storeId}, '2027-01-05', 100, 0, 100, ${o.personId}) returning id, source`;
    expect(r!.source).toBe('legacy_typed');
    await expectAllowed(attempt(o.orgId, (t) => update(t, r!.id, { cash_collected: '5.00' })), 'figure UPDATE on an open typed day, store unlinked');
    const feedId = await feedRow(o, s.storeId, '2027-01-06');
    await expectRefused(attempt(o.orgId, (t) => rawInsert(t, o, s.storeId, '2027-01-06', { source: 'pos_v1_day_feed', feedId }), { flag: true }), FIGURES_LOCKED, 'feed INSERT on an UNLINKED store, flag on');
    await expectAllowed(attempt(o.orgId, (t) => rawInsert(t, o, s.storeId, '2027-01-06')), 'legacy_typed INSERT on an unlinked store');
  });

  it('after linking (raw SQL, leaving the open typed day under a linked store): that typed day\'s figure UPDATE is refused', async () => {
    const o = await mkOrg('k10c');
    const s = await mkStore(o, { linked: false });
    const id = await typedDay(o, s.storeId, '2027-01-05', 'open');
    await expectAllowed(attempt(o.orgId, (t) => update(t, id, { cash_collected: '5.00' })), 'control, still unlinked');
    await link(o, s);
    await expectRefused(attempt(o.orgId, (t) => update(t, id, { cash_collected: '5.00' })), FIGURES_LOCKED, 'typed open day, store now linked, flag off');
    await expectRefused(attempt(o.orgId, (t) => update(t, id, { cash_collected: '5.00' }), { flag: true }), FIGURES_LOCKED, 'typed open day, store now linked, flag on');
    // status moves stay writable (submit, verify, withdraw)
    await expectAllowed(attempt(o.orgId, (t) => update(t, id, { status: 'submitted', submitted_by: o.personId, submitted_at: '2027-01-06T00:00:00Z' })), 'submit the typed day');
  });

  it('pos_v1_store_links.store_id UPDATE is refused (pos_v1_store_links_store_fixed), as the owner and as the app; control: another column updates', async () => {
    const o = await mkOrg('k10d');
    const s = await mkStore(o, { linked: true });
    const s2 = await mkStore(o, { linked: false, name: 'Batangas' });
    const moveStore = (t: Tx) => t`update pos_v1_store_links set store_id = ${s2.storeId} where store_id = ${s.storeId}`;
    await expectRefused(attempt(o.orgId, moveStore, { app: false }), STORE_FIXED, 'store_id UPDATE as the owner');
    await expectRefused(attempt(o.orgId, moveStore), STORE_FIXED, 'store_id UPDATE as the app role');
    await expectAllowed(attempt(o.orgId, (t) => t`update pos_v1_store_links set pos_store_name = 'Renamed' where store_id = ${s.storeId}`), 'a rename of the link');
  });
});

describe('K12 - a missing org context (R6, Y3)', () => {
  it('as the app role with app.org_id UNSET: a raw legacy_typed INSERT for a LINKED store fails and 0 rows land; an UNLINKED store\'s typed figure UPDATE touches 0 rows (RLS hides it first; no mutant claimed)', async () => {
    const o = await mkOrg('k12a');
    const linked = await mkStore(o, { linked: true });
    const unlinked = await mkStore(o, { linked: false, name: 'Batangas' });
    const id = await typedDay(o, unlinked.storeId, '2027-01-05');

    const insErr = await attempt(o.orgId, (t) => rawInsert(t, o, linked.storeId, '2027-01-10'), { org: false });
    expect(insErr, 'the INSERT must fail with no org context').not.toBeNull();

    let touched = -1;
    let figure = '';
    const updErr = await attempt(
      o.orgId,
      async (t) => {
        const r = await update(t, id, { cash_collected: '5.00' });
        touched = r.count;
        // read back inside the same transaction (the write rolls back after): with no org the row is not visible either
        figure = String((await t`select count(*)::int as n from sales_days where id = ${id}`)[0]!.n);
      },
      { org: false },
    );
    expect(updErr, 'a hidden row is zero rows, not an error').toBeNull();
    expect({ touched, visibleRows: figure }).toEqual({ touched: 0, visibleRows: '0' });
    const [still] = await sql<{ cash_collected: string }[]>`select cash_collected::text from sales_days where id = ${id}`;
    expect(still!.cash_collected).toBe('100.00');
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from sales_days where store_id = ${linked.storeId}`;
    expect(n!.n, '0 rows inserted on the linked store').toBe(0);
  });

  it('control, as a superuser/BYPASSRLS session with app.org_id UNSET: the link is seen - a legacy_typed INSERT for the LINKED store is refused by the trigger; for an UNLINKED store it is accepted', async () => {
    const o = await mkOrg('k12b');
    const linked = await mkStore(o, { linked: true });
    const unlinked = await mkStore(o, { linked: false, name: 'Batangas' });
    const [who] = await sql<{ bypass: boolean }[]>`select coalesce(rolsuper or rolbypassrls, false) as bypass from pg_roles where rolname = current_user`;
    expect(who!.bypass, 'the owner connection must be superuser or BYPASSRLS for this control to mean anything').toBe(true);
    await expectRefused(attempt(o.orgId, (t) => rawInsert(t, o, linked.storeId, '2027-01-10'), { app: false }), FIGURES_LOCKED, 'owner, org unset, linked store');
    await expectAllowed(attempt(o.orgId, (t) => rawInsert(t, o, unlinked.storeId, '2027-01-10'), { app: false }), 'owner, org unset, unlinked store');
  });
});
