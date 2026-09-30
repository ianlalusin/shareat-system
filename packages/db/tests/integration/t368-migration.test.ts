import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';

/**
 * T-368 S0 (DEF-424, DEF-426, DEF-435, DEF-436 backstops) — migration `0174` (T-367 took 0173;
 * Ian, 2026-09-30: T-366 = 0172, T-368 next, T-372 after — T-368's own slot moved to 0174 when
 * T-367 landed first), legs M1-M11.
 * `docs/tasks/368-periods-depreciation.md` §S0. Raw SQL against the (not yet migrated) test DB —
 * same convention as `t366-0172-migration.test.ts`/`t367-s1-migration.test.ts`.
 *
 * ⛔ TESTER, not BUILDER. Migration 0174 does not exist. Every leg below is red on the TARGET
 * behaviour for a real, verified reason (not "table does not exist" — every table involved
 * already exists; only the new CHECK/trigger/index changes are absent). M3 (the pre-flight DO
 * block) is a migration-APPLICATION-time check, the same class `t366-0172-migration.test.ts`'s
 * own header excludes — flagged, not faked, as that file's convention.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// -----------------------------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------------------------

async function org(hint: string) {
  const code = uid(`t368m-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  // M7-M10b post through 6700/1590 (postedEntry) — without a seeded chart those account lookups
  // return undefined and the legs crash in fixture setup rather than failing on the TARGET.
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  return { orgId, storeId: store!.id, adminId: admin!.id };
}
type Org = Awaited<ReturnType<typeof org>>;

async function period(orgId: string, startsOn: string, endsOn: string, status: 'open' | 'closed' | 'locked' = 'open') {
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${startsOn}, ${endsOn}, ${status})`;
}
function monthBounds(month: string): { startsOn: string; endsOn: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { startsOn: `${month}-01`, endsOn: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
async function monthPeriod(orgId: string, month: string, status: 'open' | 'closed' | 'locked' = 'open') {
  const { startsOn, endsOn } = monthBounds(month);
  await period(orgId, startsOn, endsOn, status);
}
async function periodIdFor(orgId: string, month: string): Promise<string> {
  const { startsOn } = monthBounds(month);
  const [row] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} and starts_on = ${startsOn}`;
  if (!row) throw new Error(`no fiscal period for ${month}`);
  return row.id;
}
async function statusOf(orgId: string, month: string): Promise<string> {
  const { startsOn } = monthBounds(month);
  const [row] = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${orgId} and starts_on = ${startsOn}`;
  return row!.status;
}

/** A posted, balanced 2-line journal entry: DR `debitCode` / CR `creditCode`. Draft -> lines ->
 *  posted, same convention as `t367-s1-migration.test.ts`'s `postedEntry`. */
async function postedEntry(
  o: Org,
  opts: { month: string; sourceType: string; sourceId: string; idemKey: string; debitCode: string; creditCode: string; amount: string },
): Promise<string> {
  const periodId = await periodIdFor(o.orgId, opts.month);
  return sql.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, idempotency_key)
      values (${o.orgId}, ${`${opts.month}-15`}, ${periodId}, ${opts.sourceType}, ${opts.sourceId}, 'draft', ${opts.idemKey}) returning id`;
    const [debit] = await tx<{ id: string }[]>`select id from accounts where org_id = ${o.orgId} and code = ${opts.debitCode}`;
    const [credit] = await tx<{ id: string }[]>`select id from accounts where org_id = ${o.orgId} and code = ${opts.creditCode}`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${entry!.id}, 1, ${debit!.id}, ${o.storeId}, ${opts.amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${entry!.id}, 2, ${credit!.id}, ${o.storeId}, '0', ${opts.amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${entry!.id}`;
    return entry!.id;
  });
}

/** Mirrors `reverseEntry`'s own committed shape (`ledger/reverse-entry.ts`): a NEW posted entry
 *  with `reversal_of_entry_id` pointing at the original and the SAME source_type/source_id, then
 *  the original flipped `posted -> reversed`. Raw SQL — this file never calls the domain layer. */
async function reverseEntryDirectly(o: Org, originalId: string, month: string, debitCode: string, creditCode: string, amount: string): Promise<string> {
  const periodId = await periodIdFor(o.orgId, month);
  const [original] = await sql<{ source_type: string; source_id: string }[]>`select source_type, source_id from journal_entries where id = ${originalId}`;
  return sql.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, idempotency_key, reversal_of_entry_id)
      values (${o.orgId}, ${`${month}-20`}, ${periodId}, ${original!.source_type}, ${original!.source_id}, 'draft', ${uid('rev-key')}, ${originalId}) returning id`;
    // Opposite of the original: CR debitCode / DR creditCode.
    const [debit] = await tx<{ id: string }[]>`select id from accounts where org_id = ${o.orgId} and code = ${creditCode}`;
    const [credit] = await tx<{ id: string }[]>`select id from accounts where org_id = ${o.orgId} and code = ${debitCode}`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${entry!.id}, 1, ${debit!.id}, ${o.storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${entry!.id}, 2, ${credit!.id}, ${o.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${entry!.id}`;
    await tx`update journal_entries set status = 'reversed' where id = ${originalId}`;
    return entry!.id;
  });
}

async function missedMonthLink(o: Org, opts: { fixedAssetId: string; belongsToPeriod: string; journalEntryId: string }) {
  return sql`
    insert into missed_month_adjustments (org_id, schedule, fixed_asset_id, belongs_to_period, journal_entry_id, reason, booked_by)
    values (${o.orgId}, 'depreciation', ${opts.fixedAssetId}, ${opts.belongsToPeriod}, ${opts.journalEntryId}, 'catch-up', ${o.adminId})`;
}

async function fixedAsset(o: Org, overrides: { usefulLifeMonths?: number; interval?: string; salvageValue?: string; cost?: string } = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost, salvage_value, useful_life_months, interval, status, in_service_on, in_service_source, created_by)
    values (${o.orgId}, ${o.storeId}, ${uid('Asset')}, 'equipment', '2027-02-01', ${overrides.cost ?? '120000.00'}, ${overrides.salvageValue ?? '0'},
      ${overrides.usefulLifeMonths ?? 24}, ${overrides.interval ?? 'monthly'}, 'active', '2027-02-01', 'acquired', ${o.adminId})
    returning id`;
  return row!.id;
}

// -----------------------------------------------------------------------------------------------
// DEF-426 — an OPEN period is a whole calendar month (M1-M3)
// -----------------------------------------------------------------------------------------------

describe('M1 — an open period that is not a whole calendar month', () => {
  it('insert open 2027-03-10..2027-03-31: refused with 23514 — Mutant: CHECK dropped, red', async () => {
    const o = await org('m1');
    const err = await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${o.orgId}, '2027-03-10', '2027-03-31', 'open')`.catch((e) => e);
    expect(err, 'today: fiscal_periods_open_whole_month_check does not exist yet, so this insert succeeds').toBeInstanceOf(Error);
    expect((err as { code?: string }).code, 'expected 23514 check_violation').toBe('23514');
  });
});

describe('M2 — +control: a closed part-month piece, and an open whole month, both succeed', () => {
  it('a T-344-shaped closed piece and a whole open month both insert', async () => {
    const o = await org('m2');
    await expect(sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${o.orgId}, '2027-03-10', '2027-03-31', 'closed')`).resolves.toBeDefined();
    await expect(sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${o.orgId}, '2027-04-01', '2027-04-30', 'open')`).resolves.toBeDefined();
  });
});

describe('M3 — pre-flight DO block (migration-application-time only)', () => {
  it('not expressible as a standing assertion against an already-migrated DB — flagged, not faked (same convention as t366-0172-migration.test.ts)', () => {
    expect(true).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// DEF-424 — no close or lock over a missing month (M4-M6)
// -----------------------------------------------------------------------------------------------

describe('M4 — closing over a missing earlier month', () => {
  it('02 closed, 03 missing, 04 open -> close 04: refused naming 2027-03-01 — Mutant: guard deleted, red (succeeds today)', async () => {
    const o = await org('m4');
    await monthPeriod(o.orgId, '2027-02', 'closed');
    await monthPeriod(o.orgId, '2027-04', 'open');
    const err = await sql`update fiscal_periods set status = 'closed' where org_id = ${o.orgId} and starts_on = '2027-04-01'`.catch((e) => e);
    expect(err, 'today: no DEF-424 trigger exists, so this update succeeds').toBeInstanceOf(Error);
    expect((err as { message?: string }).message ?? '').toMatch(/2027-03-01/);
  });
});

describe('M5 — +control: filling the hole first lets the later close through', () => {
  it('02 closed, 03 filled as a closed piece, then close 04: succeeds', async () => {
    const o = await org('m5');
    await monthPeriod(o.orgId, '2027-02', 'closed');
    await period(o.orgId, '2027-03-01', '2027-03-31', 'closed');
    await monthPeriod(o.orgId, '2027-04', 'open');
    await expect(sql`update fiscal_periods set status = 'closed' where org_id = ${o.orgId} and starts_on = '2027-04-01'`).resolves.toBeDefined();
    expect(await statusOf(o.orgId, '2027-04')).toBe('closed');
  });
});

describe('M6 — a multi-row year lock over a missing month', () => {
  it('2026 all closed except one missing month -> lockYearPeriods-style closed->locked: refused — Mutant: guard firing only on open->closed, red (succeeds today)', async () => {
    const o = await org('m6');
    for (let m = 1; m <= 12; m++) {
      if (m === 6) continue; // June missing
      await monthPeriod(o.orgId, `2026-${String(m).padStart(2, '0')}`, 'closed');
    }
    const err = await sql`update fiscal_periods set status = 'locked' where org_id = ${o.orgId} and starts_on >= '2026-01-01' and ends_on <= '2026-12-31' and status = 'closed'`.catch((e) => e);
    expect(err, 'today: no DEF-424 trigger exists, so this multi-row update succeeds').toBeInstanceOf(Error);
  });
});

// -----------------------------------------------------------------------------------------------
// DEF-435 — a reversed catch-up can be linked again (M7-M8)
// -----------------------------------------------------------------------------------------------

describe('M7 — a reversed catch-up can be re-linked', () => {
  it('link A (entry reversed), insert link B for the same asset+period with a posted #2 entry: succeeds — Mutant: unique index kept, red (23505 today)', async () => {
    const o = await org('m7');
    // missed_month_adjustments_guard()'s existing checks 1-5 refuse a link into a still-OPEN
    // period ("the monthly run books it in its own month") — a catch-up only makes sense once the
    // month is closed, which is the whole point of this fixture.
    await monthPeriod(o.orgId, '2027-02', 'closed');
    await monthPeriod(o.orgId, '2027-03', 'open');
    const assetId = await fixedAsset(o);
    const entryA = await postedEntry(o, { month: '2027-03', sourceType: 'depreciation', sourceId: assetId, idemKey: `asset:${assetId}:depreciation:2027-02`, debitCode: '6700', creditCode: '1590', amount: '5000.00' });
    await missedMonthLink(o, { fixedAssetId: assetId, belongsToPeriod: '2027-02', journalEntryId: entryA });
    await reverseEntryDirectly(o, entryA, '2027-03', '6700', '1590', '5000.00');
    const entryB = await postedEntry(o, { month: '2027-03', sourceType: 'depreciation', sourceId: assetId, idemKey: `asset:${assetId}:depreciation:2027-02#2`, debitCode: '6700', creditCode: '1590', amount: '5000.00' });

    // postgres.js resolves a no-RETURNING insert to [] — success is "did not reject", not undefined.
    const err = await missedMonthLink(o, { fixedAssetId: assetId, belongsToPeriod: '2027-02', journalEntryId: entryB }).then(() => null, (e) => e);
    expect(err, 'the insert must succeed: the reversed original no longer blocks a re-link').toBeNull();
  });
});

describe('M8 — +control for M7: a STILL-posted original refuses the second link', () => {
  it("link A's entry is still posted -> insert link B: raises check 7's own message, not a raw 23505 — Mutant: check 7 missing, red (today's 23505 is a DIFFERENT error)", async () => {
    const o = await org('m8');
    // Same as M7: an existing check on missed_month_adjustments_guard() requires the linked
    // period to be closed already.
    await monthPeriod(o.orgId, '2027-02', 'closed');
    await monthPeriod(o.orgId, '2027-03', 'open');
    const assetId = await fixedAsset(o);
    const entryA = await postedEntry(o, { month: '2027-03', sourceType: 'depreciation', sourceId: assetId, idemKey: `asset:${assetId}:depreciation:2027-02`, debitCode: '6700', creditCode: '1590', amount: '5000.00' });
    await missedMonthLink(o, { fixedAssetId: assetId, belongsToPeriod: '2027-02', journalEntryId: entryA });
    // Entry A is NOT reversed here — still posted.
    const entryB = await postedEntry(o, { month: '2027-03', sourceType: 'depreciation', sourceId: assetId, idemKey: `asset:${assetId}:depreciation:2027-02#2`, debitCode: '6700', creditCode: '1590', amount: '5000.00' });

    const err = await missedMonthLink(o, { fixedAssetId: assetId, belongsToPeriod: '2027-02', journalEntryId: entryB }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error).message ?? '');
    expect(msg, `expected check 7's own message; got: ${msg}`).toMatch(/already has a posted link for/);
  });
});

// -----------------------------------------------------------------------------------------------
// DEF-436 — a posted month's terms never change (M9-M10b)
// -----------------------------------------------------------------------------------------------

describe('M9 — an asset with a posted depreciation entry: terms are immutable', () => {
  async function assetWithPostedEntry(o: Org) {
    await monthPeriod(o.orgId, '2027-02', 'open');
    const assetId = await fixedAsset(o);
    await postedEntry(o, { month: '2027-02', sourceType: 'depreciation', sourceId: assetId, idemKey: `asset:${assetId}:depreciation:2027-02`, debitCode: '6700', creditCode: '1590', amount: '5000.00' });
    return assetId;
  }

  it('updating useful_life_months is refused — Mutant: WHEN list missing the column, red (succeeds today)', async () => {
    const o = await org('m9a');
    const assetId = await assetWithPostedEntry(o);
    const err = await sql`update fixed_assets set useful_life_months = 36 where id = ${assetId}`.catch((e) => e);
    expect(err, 'today: no DEF-436 trigger exists').toBeInstanceOf(Error);
  });
  it('updating interval is refused — red (succeeds today)', async () => {
    const o = await org('m9b');
    const assetId = await assetWithPostedEntry(o);
    const err = await sql`update fixed_assets set interval = 'quarterly' where id = ${assetId}`.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });
  it('updating salvage_value is refused — red (succeeds today)', async () => {
    const o = await org('m9c');
    const assetId = await assetWithPostedEntry(o);
    const err = await sql`update fixed_assets set salvage_value = '1000.00' where id = ${assetId}`.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });
  it('updating cost is refused — red (succeeds today)', async () => {
    const o = await org('m9d');
    const assetId = await assetWithPostedEntry(o);
    const err = await sql`update fixed_assets set cost = '999999.00' where id = ${assetId}`.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('M10 — +control: unguarded fields, and an asset with only a REVERSED entry', () => {
  it('name/category/notes stay editable on an asset with a posted entry', async () => {
    const o = await org('m10a');
    await monthPeriod(o.orgId, '2027-02', 'open');
    const assetId = await fixedAsset(o);
    await postedEntry(o, { month: '2027-02', sourceType: 'depreciation', sourceId: assetId, idemKey: `asset:${assetId}:depreciation:2027-02`, debitCode: '6700', creditCode: '1590', amount: '5000.00' });
    await expect(sql`update fixed_assets set name = 'Renamed asset' where id = ${assetId}`).resolves.toBeDefined();
    await expect(sql`update fixed_assets set notes = 'a note' where id = ${assetId}`).resolves.toBeDefined();
  });

  it('an asset whose only entry is REVERSED: life changes are unaffected by the guard', async () => {
    const o = await org('m10b');
    await monthPeriod(o.orgId, '2027-02', 'open');
    await monthPeriod(o.orgId, '2027-03', 'open');
    const assetId = await fixedAsset(o);
    const entryA = await postedEntry(o, { month: '2027-03', sourceType: 'depreciation', sourceId: assetId, idemKey: `asset:${assetId}:depreciation:2027-02`, debitCode: '6700', creditCode: '1590', amount: '5000.00' });
    await reverseEntryDirectly(o, entryA, '2027-03', '6700', '1590', '5000.00');
    await expect(sql`update fixed_assets set useful_life_months = 36 where id = ${assetId}`).resolves.toBeDefined();
  });
});

describe('M10b — a re-posted (post-reversal) asset stays editable until it posts again', () => {
  it('post, reverse via the real reversal shape (reversal_of_entry_id set, same source_type/source_id, original -> reversed): a terms edit succeeds — Mutant: the reversal_of_entry_id IS NULL filter dropped would wrongly refuse this', async () => {
    const o = await org('m10c');
    await monthPeriod(o.orgId, '2027-02', 'open');
    await monthPeriod(o.orgId, '2027-03', 'open');
    const assetId = await fixedAsset(o);
    const original = await postedEntry(o, { month: '2027-02', sourceType: 'depreciation', sourceId: assetId, idemKey: `asset:${assetId}:depreciation:2027-02`, debitCode: '6700', creditCode: '1590', amount: '5000.00' });
    await reverseEntryDirectly(o, original, '2027-03', '6700', '1590', '5000.00');
    const [row] = await sql<{ status: string }[]>`select status from journal_entries where id = ${original}`;
    expect(row!.status, 'the original must read reversed, not posted').toBe('reversed');
    await expect(sql`update fixed_assets set useful_life_months = 36 where id = ${assetId}`).resolves.toBeDefined();
  });
});

// -----------------------------------------------------------------------------------------------
// M11 — trigger registry
// -----------------------------------------------------------------------------------------------

async function loadRegistry(): Promise<{ TRIGGER_REGISTRY: Record<string, { table: string; mode: string; kind: string }> } | undefined> {
  try {
    const registryPath = ['..', '..', 'src', 'triggers', 'registry'].join('/');
    return await import(registryPath);
  } catch {
    return undefined;
  }
}
async function livePgTriggers(table: string): Promise<{ tgname: string; tgenabled: string }[]> {
  return sql<{ tgname: string; tgenabled: string }[]>`
    select t.tgname, t.tgenabled::text as tgenabled from pg_trigger t
    join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = 'public' and c.relname = ${table}`;
}

describe('M11 — the two new triggers are registered origin/validator and live \'O\'', () => {
  it('a DEF-424 trigger on fiscal_periods, and a DEF-436 trigger on fixed_assets, both classified origin/validator — pinned; fails today (neither trigger, nor its registration, exists)', async () => {
    const mod = await loadRegistry();
    expect(mod, 'triggers/registry.ts exists today; the two NEW entries do not').toBeDefined();
    const reg = mod!.TRIGGER_REGISTRY;

    const fpTriggers = await livePgTriggers('fiscal_periods');
    const faTriggers = await livePgTriggers('fixed_assets');
    const newFpTrigger = fpTriggers.find((t) => !['fiscal_periods_fill_immutable_trg', 'fiscal_periods_order_guard_ins_trg', 'fiscal_periods_order_guard_upd_trg'].includes(t.tgname));
    const newFaTrigger = faTriggers.find((t) => !['fixed_assets_in_service_a_fill_ins_trg', 'fixed_assets_in_service_a_fill_upd_trg', 'fixed_assets_in_service_b_guard_trg'].includes(t.tgname));

    expect(newFpTrigger, 'no new fiscal_periods trigger exists yet (DEF-424)').toBeDefined();
    expect(newFaTrigger, 'no new fixed_assets trigger exists yet (DEF-436)').toBeDefined();
    if (newFpTrigger) {
      const entry = reg[newFpTrigger.tgname];
      expect(entry, `${newFpTrigger.tgname} not in the registry`).toBeDefined();
      expect(entry?.mode).toBe('origin');
      expect(entry?.kind).toBe('validator');
      expect(newFpTrigger.tgenabled).toBe('O');
    }
    if (newFaTrigger) {
      const entry = reg[newFaTrigger.tgname];
      expect(entry, `${newFaTrigger.tgname} not in the registry`).toBeDefined();
      expect(entry?.mode).toBe('origin');
      expect(entry?.kind).toBe('validator');
      expect(newFaTrigger.tgenabled).toBe('O');
    }
  });
});
