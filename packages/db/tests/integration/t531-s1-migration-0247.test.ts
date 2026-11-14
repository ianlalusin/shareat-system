import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-531 R1 - migration 0247_t531_pos_receipts_sales_day.sql, the figure-lock amendment. `docs/tasks/531-pos-day-close.md` R1 and R8 "Migration and DB".
 *
 * TESTER, not BUILDER. Raw SQL as the app role, so the DATABASE is what is proven (the t375-s4-lock pattern). Every attempt runs in a transaction that is
 * ALWAYS rolled back. Every refusal has a positive control in the same test (the same write, allowed by the one thing that differs).
 *
 * ## Why these are red on HEAD
 * 0247 does not exist: the 0185 trigger refuses EVERY `pos_receipts` INSERT on a store linked to v1 (it allows only `pos_v1_day_feed`), so the "allowed" legs
 * fail with "expected the write to be allowed, got 23514 sales_days_figures_locked", and the v1-feed-after-live_from guard does not exist, so that write succeeds.
 * Legs that pass on HEAD are guards a mutant must turn red (regression legs).
 *
 * ## Where the spec is silent or short (questions in the hand-back)
 *  - Q-R1a (a GAP in R1): `sales_day_child_row_allowed` (0185) answers a tender row of a day whose source is not the feed by "the store must be unlinked".
 *    So on Lipa (linked) a `pos_receipts` day's `sales_day_tenders` rows are refused even with the flag on. R1 amends only the sales-days INSERT. The T8 legs
 *    below assume 0247 ALSO lets the derivation write the tender rows of a `pos_receipts` day (flag on, open/submitted). Without it the close cannot work.
 *  - Q-R1b: the constraint NAME of the new feed-after-live_from refusal is not named. Asserted here: SQLSTATE 23514 and the exact sentence only.
 *  - Q-R1c: an UNLINKED store with a live pos_stores row: the spec lists only the linked case. T7 pins "allowed with the flag"; "without the flag" is not asserted.
 *  - Q-R1d: `t523-pos-v2-schema.test.ts` line ~992 asserts `sales_days_check_figure_lock`'s source does NOT contain 'pos_receipts'. 0247 makes that false
 *    by design; the builder must change that one assertion (it is not a spec change, a consequence).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';
import { world, closeAll, sql, D1, D2, type World } from '../../../domain/tests/integration/_fixtures/t531-day-close';

afterAll(closeAll);

const FIGURES_LOCKED = 'sales_days_figures_locked';
const TENDERS_LOCKED = 'sales_day_tenders_locked';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

type Tx = postgres.TransactionSql;
type PgErr = { code?: string; constraint_name?: string; message?: string } | null;
class Rollback extends Error {}

/** Runs `fn` in a transaction ALWAYS rolled back, as the app role with the org set; returns the error the body raised, or null. */
async function attempt(orgId: string, fn: (t: Tx) => Promise<unknown>, o: { flag?: boolean } = {}): Promise<PgErr> {
  let caught: unknown = null;
  try {
    await sql.begin(async (t) => {
      await t.unsafe(`set local role ${APP_ROLE}`);
      await t`select set_config('app.principal_kind', 'staff', true)`;
      await t`select set_config('app.org_id', ${orgId}, true)`;
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

// ---- fixtures -----------------------------------------------------------------------------------------------------------------
/** A committed Z (pos_day_closes row) on the world's terminal, by raw SQL. Each call needs its own business date (UNIQUE store+date+terminal). */
async function zRow(w: World, businessDate: string, zNo = 1): Promise<string> {
  const [z] = await sql<{ id: string }[]>`
    insert into pos_day_closes (org_id, store_id, terminal_id, z_no, business_date, window_start, window_end, receipt_count, gross_total, closed_by, approved_by)
    values (${w.orgId}, ${w.storeId}, ${w.terminalId}, ${zNo}, ${businessDate}, ${`${businessDate}T04:00:00+08:00`}, ${`${businessDate}T22:00:00+08:00`}, 1, 250.00, ${w.counterId}, ${w.managerId})
    returning id`;
  return z!.id;
}
/** A pos_receipts sales day, balanced (unli + a la carte = total; cash = total), linked to the Z. */
const receiptsDay = (t: Tx, w: World, date: string, zId: string, o: { storeId?: string } = {}) => t`
  insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by, source, pos_day_close_id)
  values (${w.orgId}, ${o.storeId ?? w.storeId}, ${date}, 'open', 250.00, 0, 250.00, 250.00, ${w.counterId}, 'pos_receipts', ${zId}) returning id`;
const feedDayAt = async (t: Tx, w: World, date: string) => {
  const [f] = await t<{ id: string }[]>`
    insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_at, fetched_by)
    values (${w.orgId}, ${w.storeId}, ${date}, 'sales', 'import', ${crypto.randomUUID()}, ${w.posStoreId}, '{"found":true}', '{"found":true}'::jsonb, ${sha(`${date}-${Math.random()}`)}, now(), ${w.counterId})
    returning id`;
  return t`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by, source, pos_v1_day_feed_id, pos_sourced, pos_sourced_at)
    values (${w.orgId}, ${w.storeId}, ${date}, 100, 0, 100, 100, ${w.counterId}, 'pos_v1_day_feed', ${f!.id}, true, now())`;
};
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

// ======================================================================================================================
describe('R1 - the migration is in the repo and in the journal', () => {
  it('packages/db/migrations/0247_t531_pos_receipts_sales_day.sql exists, is listed last in meta/_journal.json, and says why in its header', () => {
    const dir = join(process.cwd(), 'packages', 'db', 'migrations');
    const text = readFileSync(join(dir, '0247_t531_pos_receipts_sales_day.sql'), 'utf8');
    expect(text).toMatch(/^-- 0247/);
    expect(text).toContain('CREATE OR REPLACE FUNCTION "sales_days_check_figure_lock"');
    const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain('0247_t531_pos_receipts_sales_day');
  });

  it('regression: the trigger is still the same one, enabled, on INSERT OR UPDATE (a CREATE OR REPLACE of the function, not a new trigger)', async () => {
    const trg = await sql<{ tgname: string; tgenabled: string; def: string }[]>`
      select tgname, tgenabled, pg_get_triggerdef(oid) def from pg_trigger where tgrelid = 'public.sales_days'::regclass and not tgisinternal order by tgname`;
    expect(trg.map((t) => t.tgname)).toEqual(['sales_days_figure_lock', 'sales_days_verify_requires_submitted']);
    expect(trg[0]!.tgenabled).toBe('O');
    expect(trg[0]!.def).toBe('CREATE TRIGGER sales_days_figure_lock BEFORE INSERT OR UPDATE ON public.sales_days FOR EACH ROW EXECUTE FUNCTION sales_days_check_figure_lock()');
  });
});

describe('T1/T2 - a pos_receipts sales day on a LINKED live store: only inside the derivation flag', () => {
  it('T1 allowed: live store, business_date = live_from and after it, flag on, a day close linked', async () => {
    const w = await world('live', D1);
    const z1 = await zRow(w, D1, 1);
    const z2 = await zRow(w, D2, 2);
    await expectAllowed(attempt(w.orgId, (t) => receiptsDay(t, w, D1, z1), { flag: true }), 'pos_receipts day ON live_from, flag on');
    await expectAllowed(attempt(w.orgId, (t) => receiptsDay(t, w, D2, z2), { flag: true }), 'pos_receipts day AFTER live_from, flag on');
  });

  it('T2 refused WITHOUT the flag (the positive control is T1)', async () => {
    const w = await world('live', D1);
    const z = await zRow(w, D1);
    await expectRefused(attempt(w.orgId, (t) => receiptsDay(t, w, D1, z)), FIGURES_LOCKED, 'pos_receipts day, flag off, linked live store');
  });

  it('T2 refused BEFORE live_from, flag on (one day before)', async () => {
    const w = await world('live', D2);
    const z = await zRow(w, D2);
    const before = addDays(D2, -1);
    // the Z of the day before would be a later Z in life; only its date matters to the trigger
    const zBefore = await zRow(w, before, 2);
    await expectAllowed(attempt(w.orgId, (t) => receiptsDay(t, w, D2, z), { flag: true }), 'control: the same store, on live_from');
    await expectRefused(attempt(w.orgId, (t) => receiptsDay(t, w, before, zBefore), { flag: true }), FIGURES_LOCKED, 'pos_receipts day before live_from');
  });

  it('T2 refused in TEST mode (flag on): test mode never books', async () => {
    const live = await world('live', D1);
    const test = await world('test');
    const zTest = await zRow(test, D1);
    const zLive = await zRow(live, D1);
    await expectAllowed(attempt(live.orgId, (t) => receiptsDay(t, live, D1, zLive), { flag: true }), 'control: a live store');
    await expectRefused(attempt(test.orgId, (t) => receiptsDay(t, test, D1, zTest), { flag: true }), FIGURES_LOCKED, 'pos_receipts day, store in test mode');
  });

  it('T2 refused when the store is switched OFF again (flag on)', async () => {
    const w = await world('live', D1);
    const z = await zRow(w, D1);
    await expectAllowed(attempt(w.orgId, (t) => receiptsDay(t, w, D1, z), { flag: true }), 'control: live');
    await sql`update pos_stores set mode = 'off', live_from = null where store_id = ${w.storeId}`;
    await expectRefused(attempt(w.orgId, (t) => receiptsDay(t, w, D1, z), { flag: true }), FIGURES_LOCKED, 'pos_receipts day, store off');
  });

  it('T2 a typed day on the linked store is still refused with the flag on (the new branch is for pos_receipts only)', async () => {
    const w = await world('live', D1);
    const err = await attempt(w.orgId, (t) => t`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${w.orgId}, ${w.storeId}, ${D1}, 100, 0, 100, ${w.counterId})`, { flag: true });
    expect({ code: err?.code, constraint: err?.constraint_name }).toEqual({ code: '23514', constraint: FIGURES_LOCKED });
  });
});

describe('T3 - the row-436 guard: a v1 feed day at or after live_from on a live store is refused, in words', () => {
  const sentence = (date: string) => `This store is on the new POS from ${date}; its sales days come from POS receipts.`;

  it('refused ON live_from and AFTER it (the 06:00 import must not double-book); the message is the sentence, SQLSTATE 23514', async () => {
    const w = await world('live', D2);
    for (const day of [D2, addDays(D2, 5)]) {
      const err = await attempt(w.orgId, (t) => feedDayAt(t, w, day), { flag: true });
      expect(err, `a v1 feed day for ${day} was ACCEPTED on a live store`).not.toBeNull();
      expect(err!.code).toBe('23514');
      expect(err!.message).toContain(sentence(D2));
    }
  });

  it('a v1 feed day BEFORE live_from still works (flag on), and is still refused without the flag', async () => {
    const w = await world('live', D2);
    await expectAllowed(attempt(w.orgId, (t) => feedDayAt(t, w, D1), { flag: true }), 'feed day before live_from, flag on');
    await expectRefused(attempt(w.orgId, (t) => feedDayAt(t, w, D1)), FIGURES_LOCKED, 'feed day before live_from, flag off (0185 unchanged)');
  });

  it('a TEST-mode store has no live_from: its feed days are not blocked by the new guard', async () => {
    const w = await world('test');
    await expectAllowed(attempt(w.orgId, (t) => feedDayAt(t, w, D2), { flag: true }), 'feed day on a linked store in test mode');
  });
});

describe('T7 - an UNLINKED live store (a store opened after v1) can take a pos_receipts day too', () => {
  it('allowed with the flag on; a refusal outside live mode still holds', async () => {
    const w = await world('live', D1);
    // store B of the fixture has no v1 link: give it a live pos_stores row, a pairing and a terminal
    await sql`insert into pos_stores (org_id, store_id, mode, live_from, changed_by) values (${w.orgId}, ${w.store2Id}, 'live', ${D1}, ${w.adminId})`;
    const [p] = await sql<{ id: string }[]>`select id from pos_tablet_pairings where store_id = ${w.store2Id} limit 1`;
    const [term] = await sql<{ id: string }[]>`
      insert into pos_terminals (org_id, store_id, terminal_no, pairing_id, created_by) values (${w.orgId}, ${w.store2Id}, 1, ${p!.id}, ${w.adminId}) returning id`;
    const [z] = await sql<{ id: string }[]>`
      insert into pos_day_closes (org_id, store_id, terminal_id, z_no, business_date, window_start, window_end, receipt_count, gross_total, closed_by, approved_by)
      values (${w.orgId}, ${w.store2Id}, ${term!.id}, 1, ${D1}, ${`${D1}T04:00:00+08:00`}, ${`${D1}T22:00:00+08:00`}, 1, 250.00, ${w.adminId}, ${w.adminId}) returning id`;
    await expectAllowed(attempt(w.orgId, (t) => receiptsDay(t, w, D1, z!.id, { storeId: w.store2Id }), { flag: true }), 'unlinked live store, flag on');
    await sql`update pos_stores set mode = 'off', live_from = null where store_id = ${w.store2Id}`;
    await expectRefused(attempt(w.orgId, (t) => receiptsDay(t, w, D1, z!.id, { storeId: w.store2Id }), { flag: true }), FIGURES_LOCKED, 'unlinked store switched off');
  });
});

describe('T8 - the tender rows of a pos_receipts day (R1 gap Q-R1a): written by the derivation, locked afterwards', () => {
  const tenderRow = async (t: Tx, w: World, dayId: string) => {
    const [acct] = await t<{ money_account_id: string }[]>`select money_account_id from tenders where id = ${w.gcash}`;
    return t`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${dayId}, ${acct!.money_account_id}, 100.00)`;
  };

  it('with the flag on, on an open pos_receipts day: allowed; with the flag off: refused (sales_day_tenders_locked)', async () => {
    const w = await world('live', D1);
    const z = await zRow(w, D1);
    await expectAllowed(attempt(w.orgId, async (t) => {
      const [d] = await receiptsDay(t, w, D1, z);
      await tenderRow(t, w, d!.id);
    }, { flag: true }), 'tender row of a pos_receipts day, flag on');
    await expectRefused(attempt(w.orgId, async (t) => {
      await t`select set_config('app.sales_day_derivation', 'on', true)`;
      const [d] = await receiptsDay(t, w, D1, z);
      await t`select set_config('app.sales_day_derivation', 'off', true)`;
      await tenderRow(t, w, d!.id);
    }), TENDERS_LOCKED, 'tender row of a pos_receipts day, flag off');
  });

  it('a verified pos_receipts day takes no tender row even with the flag on (verified is never rewritten)', async () => {
    const w = await world('live', D1);
    const z = await zRow(w, D1);
    await expectRefused(attempt(w.orgId, async (t) => {
      const [d] = await receiptsDay(t, w, D1, z);
      await t`update sales_days set status = 'submitted', submitted_by = ${w.counterId}, submitted_at = now() where id = ${d!.id}`;
      await t`update sales_days set status = 'verified', verified_by = ${w.managerId}, verified_at = now() where id = ${d!.id}`;
      await tenderRow(t, w, d!.id);
    }, { flag: true }), TENDERS_LOCKED, 'tender row on a verified pos_receipts day');
  });

  it('the figures of a pos_receipts day on a linked store are locked outside the flag; submit is never locked', async () => {
    const w = await world('live', D1);
    const z = await zRow(w, D1);
    await expectRefused(attempt(w.orgId, async (t) => {
      await t`select set_config('app.sales_day_derivation', 'on', true)`;
      const [d] = await receiptsDay(t, w, D1, z);
      await t`select set_config('app.sales_day_derivation', 'off', true)`;
      await t`update sales_days set cash_collected = 1.00 where id = ${d!.id}`;
    }), FIGURES_LOCKED, 'figure UPDATE on a pos_receipts day, flag off');
    await expectAllowed(attempt(w.orgId, async (t) => {
      const [d] = await receiptsDay(t, w, D1, z);
      await t`update sales_days set status = 'submitted', submitted_by = ${w.counterId}, submitted_at = now() where id = ${d!.id}`;
    }, { flag: true }), 'submit (open -> submitted) of a pos_receipts day');
  });
});

// ======================================================================================================================
// T9 - added by the BUILDER (not in the tester's list): the channel-row branch of 0247's `sales_day_child_row_allowed`. A POS-derived day takes the PLATFORM
// rows a person types beside it (Foodpanda and the like, exactly as a feed day does, so verify's channel-completeness rule can be met); it owns no REMITTED row.
describe('T9 - the channel rows of a pos_receipts day', () => {
  const channelRow = async (t: Tx, w: World, dayId: string, remitted: boolean) => {
    const [ch] = await t<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${w.orgId}, ${w.storeId}, ${`T9 ${remitted ? 'till' : 'platform'} ${crypto.randomUUID().slice(0, 8)}`}, ${remitted}, ${remitted ? null : '1220'}) returning id`;
    return t`insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales) values (${dayId}, ${ch!.id}, 50.00, false)`;
  };

  it('a platform (non-remitted) row on an open pos_receipts day is allowed with the flag off; a remitted row is refused (sales_day_channels_locked)', async () => {
    const w = await world('live', D1);
    const z = await zRow(w, D1);
    await expectAllowed(attempt(w.orgId, async (t) => {
      const [d] = await receiptsDay(t, w, D1, z);
      await channelRow(t, w, d!.id, false);
    }, { flag: true }), 'platform row of an open pos_receipts day');
    await expectRefused(attempt(w.orgId, async (t) => {
      const [d] = await receiptsDay(t, w, D1, z);
      await channelRow(t, w, d!.id, true);
    }, { flag: true }), 'sales_day_channels_locked', 'remitted row of a pos_receipts day (the POS has none)');
  });

  it('a verified pos_receipts day takes no platform row', async () => {
    const w = await world('live', D1);
    const z = await zRow(w, D1);
    await expectRefused(attempt(w.orgId, async (t) => {
      const [d] = await receiptsDay(t, w, D1, z);
      await t`update sales_days set status = 'submitted', submitted_by = ${w.counterId}, submitted_at = now() where id = ${d!.id}`;
      await t`update sales_days set status = 'verified', verified_by = ${w.managerId}, verified_at = now() where id = ${d!.id}`;
      await channelRow(t, w, d!.id, false);
    }, { flag: true }), 'sales_day_channels_locked', 'platform row on a verified pos_receipts day');
  });
});

// ======================================================================================================================
// T10 - BOSS: the POS cannot take a platform tender. v2 tenders are cash | wallet only (tenders_kind_check, T-375), so no receipt can carry Foodpanda or Grab money and a
// typed platform row on a POS day cannot overlap a receipt. Plus row 270 on an UNLINKED live store: the figures of a pos_receipts day are not typed there either.
describe('T10 - no platform tender; no typed figure on a pos_receipts day (unlinked store too)', () => {
  it('a tender of kind platform, foodpanda or grab (anything but cash / wallet) is refused by tenders_kind_check', async () => {
    const w = await world('live', D1);
    for (const kind of ['platform', 'foodpanda', 'grab', 'delivery']) {
      let caught: PgErr = null;
      try {
        await sql`insert into tenders (org_id, store_id, name, kind) values (${w.orgId}, ${w.storeId}, ${`T10 ${kind}`}, ${kind})`;
      } catch (e) {
        caught = e as PgErr;
      }
      expect({ kind, code: caught?.code, constraint: caught?.constraint_name }).toEqual({ kind, code: '23514', constraint: 'tenders_kind_check' });
    }
    // control: cash is accepted
    await expect(sql`insert into tenders (org_id, store_id, name, kind) values (${w.orgId}, ${w.storeId}, 'T10 cash', 'cash')`).resolves.toBeDefined();
  });

  it('on an UNLINKED live store a pos_receipts day\'s figures are locked outside the derivation flag too, and its tender rows are', async () => {
    const w = await world('live', D1);
    await sql`insert into pos_stores (org_id, store_id, mode, live_from, changed_by) values (${w.orgId}, ${w.store2Id}, 'live', ${D1}, ${w.adminId})`;
    const [p] = await sql<{ id: string }[]>`select id from pos_tablet_pairings where store_id = ${w.store2Id} limit 1`;
    const [term] = await sql<{ id: string }[]>`insert into pos_terminals (org_id, store_id, terminal_no, pairing_id, created_by) values (${w.orgId}, ${w.store2Id}, 1, ${p!.id}, ${w.adminId}) returning id`;
    const [z] = await sql<{ id: string }[]>`
      insert into pos_day_closes (org_id, store_id, terminal_id, z_no, business_date, window_start, window_end, receipt_count, gross_total, closed_by, approved_by)
      values (${w.orgId}, ${w.store2Id}, ${term!.id}, 1, ${D1}, ${`${D1}T04:00:00+08:00`}, ${`${D1}T22:00:00+08:00`}, 1, 250.00, ${w.adminId}, ${w.adminId}) returning id`;
    const err = await attempt(w.orgId, async (t) => {
      await t`select set_config('app.sales_day_derivation', 'on', true)`;
      const [d] = await receiptsDay(t, w, D1, z!.id, { storeId: w.store2Id });
      await t`select set_config('app.sales_day_derivation', 'off', true)`;
      await t`update sales_days set cash_collected = 1.00, total_sales = 1.00, unli_sales = 0, ala_carte_sales = 1.00 where id = ${d!.id}`;
    });
    expect({ code: err?.code, constraint: err?.constraint_name }).toEqual({ code: '23514', constraint: FIGURES_LOCKED });
  });
});
