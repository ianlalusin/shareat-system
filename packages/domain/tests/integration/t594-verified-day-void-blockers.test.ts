import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-594 (DEF-877, DEF-904) - a VERIFIED sales day is voided only when nothing counts against it, and nothing can start counting
 * against a day that is being voided. `docs/tasks/594-money-transfers-remittance-sales-day-void.md` section 3 and 3b.
 *
 * Before: `voidSalesDay` ran the blocker check only for an unverified day; the verified path went straight to `reverseEntry`, so a
 * posted remittance, a posted channel settlement, posted usage or recorded wastage was left pointing at a voided day.
 *
 * Refusal order (pull, wastage, remittance, settlement); every refusal leaves the day `verified` and writes no entry.
 * Real Postgres. Fixture: `_fixtures/t511-s6b-world.ts` (verified Foodpanda day on `DATE`, admin). The held race: `_fixtures/held-race.ts`.
 *
 * MUTANTS (each turns the named tests red; none is planted): delete the blocker call in the verified branch -> every refusal;
 * delete the `channelSettlement` field -> the settlement refusal and the race.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { heldRace } from './_fixtures/held-race';
import { DATE, asOrg, fx, sentenceOf, type Fx } from './_fixtures/t511-s6b-world';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const S = {
  pull: 'Stock usage was pulled from POS for this day. Void that usage first under Inventory › Usage & wastage.',
  wastage: "Wastage is recorded against this day, so it can't be voided.",
  remittance: 'Cash handed over has been counted against this day. Reverse that handover first.',
  settlement: 'A delivery-platform payout has been settled against this day. Void that settlement first under Channel settlements.',
};

const world = () => fx(sql, 't594', { staff: '11000.00', file: '10000.00' });
const voidDay = (f: Fx) => asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.admin, f.dayId, 'wrong day'));
const dayStatus = async (f: Fx) => (await sql<{ status: string }[]>`select status from sales_days where id = ${f.dayId}`)[0]!.status;
const entryCount = async (f: Fx) => Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId}`)[0]!.n);

async function remittance(f: Fx, status: 'posted' | 'reversed'): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into remittances (org_id, store_id, remitted_on, accepted_by, created_by)
    values (${f.orgId}, ${f.storeA}, ${DATE}, ${f.admin.personId}, ${f.admin.personId}) returning id`;
  await sql`insert into remittance_allocations (remittance_id, business_date, sales_day_id, amount, source) values (${r!.id}, ${DATE}, ${f.dayId}, '1000.00', 'cash')`;
  if (status === 'reversed') await sql`update remittances set status = 'reversed', reversed_on = ${DATE}, reverse_reason = 'fixture reversal' where id = ${r!.id}`;
  return r!.id;
}
async function wastage(f: Fx): Promise<void> {
  await sql`insert into order_wastages (org_id, store_id, sales_day_id, channel, channel_id, type_mode, amount, reason, created_by)
            values (${f.orgId}, ${f.storeA}, ${f.dayId}, 'Foodpanda', ${f.channelId}, 'instant', '50.00', 'spoiled in transit', ${f.admin.personId})`;
}
/** `posted`: a section is finalized (stock usage was POSTED). Otherwise a merely planned pull, which posts nothing. */
async function pull(f: Fx, posted: boolean): Promise<void> {
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${f.storeA}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${f.admin.personId}) returning id`;
  await sql`insert into pos_usage_pulls (org_id, store_id, sales_day_id, location_id, snapshot_taken_at, status, direct_finalized_at)
            values (${f.orgId}, ${f.storeA}, ${f.dayId}, ${loc!.id}, now(), 'planned', ${posted ? new Date() : null})`;
}
const recordSettlement = (f: Fx) =>
  asOrg(f.orgId, (tx) =>
    D.recordChannelSettlement(tx, f.admin, { storeId: f.storeA, channelId: f.channelId, salesDayId: f.dayId, businessDate: DATE, grossAmount: '10000.00', netDeposited: '10000.00', settledOn: '2026-10-20' }),
  );

async function expectRefused(f: Fx, sentence: string): Promise<void> {
  const before = await entryCount(f);
  expect(await sentenceOf(voidDay(f))).toBe(sentence);
  expect(await dayStatus(f), 'a refused void changed the day').toBe('verified');
  expect(await entryCount(f), 'a refused void wrote an entry').toBe(before);
}

// =====================================================================================================
describe('T-594 DEF-877 - a verified day with something counted against it cannot be voided', () => {
  it('a posted remittance (allocation by sales_day_id)', async () => {
    const f = await world();
    await remittance(f, 'posted');
    await expectRefused(f, S.remittance);
  });

  it('recorded wastage', async () => {
    const f = await world();
    await wastage(f);
    await expectRefused(f, S.wastage);
  });

  it('a POS usage pull that POSTED usage (a finalized section)', async () => {
    const f = await world();
    await pull(f, true);
    await expectRefused(f, S.pull);
  });

  it('a posted channel settlement', async () => {
    const f = await world();
    await recordSettlement(f);
    await expectRefused(f, S.settlement);
  });

  it('refusal order: pull, then wastage, then remittance, then settlement', async () => {
    const f = await world();
    await remittance(f, 'posted');
    await expectRefused(f, S.remittance);
    await wastage(f);
    await expectRefused(f, S.wastage);
    await pull(f, true);
    await expectRefused(f, S.pull);
  });
});

describe('T-594 DEF-877 - positive controls: what is not counting does not block', () => {
  it('a REVERSED remittance: the day voids and its entry is reversed', async () => {
    const f = await world();
    await remittance(f, 'reversed');
    const out = await voidDay(f);
    expect(out.reversalEntryId).not.toBeNull();
    expect(await dayStatus(f)).toBe('voided');
  });

  it('a VOIDED settlement: the day voids', async () => {
    const f = await world();
    const s = await recordSettlement(f);
    await asOrg(f.orgId, (tx) => D.voidChannelSettlement(tx, f.admin, { settlementId: s.settlementId, reason: 'fixture' }));
    const out = await voidDay(f);
    expect(out.reversalEntryId).not.toBeNull();
    expect(await dayStatus(f)).toBe('voided');
  });

  it('a merely PLANNED pull (nothing posted): the day voids', async () => {
    const f = await world();
    await pull(f, false);
    const out = await voidDay(f);
    expect(out.reversalEntryId).not.toBeNull();
    expect(await dayStatus(f)).toBe('voided');
  });
});

describe('T-594 DEF-877 - race: a settlement being recorded against the day, held open, and a void of the day', () => {
  it('A records the settlement (held); B voids the day: B parks on the day row, then is refused with the settlement sentence', async () => {
    const f = await world();
    const [a, b] = await heldRace(
      asOrg,
      f.orgId,
      (tx) => D.recordChannelSettlement(tx, f.admin, { storeId: f.storeA, channelId: f.channelId, salesDayId: f.dayId, businessDate: DATE, grossAmount: '10000.00', netDeposited: '10000.00', settledOn: '2026-10-20' }),
      (tx) => D.voidSalesDay(tx, f.admin, f.dayId, 'wrong day').then(() => 'voided' as const, (e: unknown) => String((e as { userMessage?: string }).userMessage ?? e)),
      700,
      { sql },
    );
    expect(a.settlementId).toBeTruthy();
    expect(b).toBe(S.settlement);
    expect(await dayStatus(f)).toBe('verified');
  });
});

// =====================================================================================================
// DEF-904 - the opposite race: a handover or a payout settlement read the day as verified, and a void of the day commits first.
// The void takes the day row FOR UPDATE; the writer now takes it FOR SHARE through `lockLiveSalesDay` and re-checks, so it parks,
// then sees the day voided and refuses. MUTANTS: delete the `lockHandoverDays` call in `createRemittance` -> the remittance test
// goes red (it commits against the voided day); delete the `lockLiveSalesDay` call in `recordChannelSettlement` -> the settlement test.
// =====================================================================================================
const voidedSentence = (what: string) =>
  new RegExp(`^The sales day for .+ has been voided, so ${what} can't be recorded against it\\.$`);
const sentenceOrOk = (p: Promise<unknown>) => p.then(() => 'ok' as const, (e: unknown) => String((e as { userMessage?: string }).userMessage ?? e));

/** Cash in the till on DATE (a non-transfer document), so the verified day owes something a handover can settle. */
async function tillTakings(f: Fx, amount: string): Promise<{ till: string; safe: string }> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} and starts_on <= ${DATE} and ends_on >= ${DATE} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${DATE}, ${period!.id}, 'sale', ${`t594-takings-${f.dayId}`}, 'draft') returning id`;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [sales] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '4100'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${f.storeA}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${sales!.id}, ${f.storeA}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
  const [till] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeA} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [safe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeA} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return { till: till!.id, safe: safe!.id };
}

describe('T-594 DEF-904 - a writer racing a void of the day', () => {
  it('remittance: A voids the verified day (held); B hands over cash against it: B parks on the day row, then is refused; no allocation, no remittance', async () => {
    const f = await world();
    const { till, safe } = await tillTakings(f, '1000.00');
    const [a, b] = await heldRace(
      asOrg,
      f.orgId,
      (tx) => D.voidSalesDay(tx, f.admin, f.dayId, 'wrong day'),
      (tx) => sentenceOrOk(D.createRemittance(tx, f.admin, { storeId: f.storeA, remittedOn: '2026-10-13', lines: [{ fromMoneyAccountId: till, toMoneyAccountId: safe, amount: '1000.00' }] })),
      700,
      { sql },
    );
    expect(a.reversalEntryId).not.toBeNull();
    expect(b).toMatch(voidedSentence('a cash handover'));
    expect(await dayStatus(f)).toBe('voided');
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from remittances where org_id = ${f.orgId}`)[0]!.n), 'a remittance was written').toBe(0);
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from remittance_allocations ra join remittances r on r.id = ra.remittance_id where r.org_id = ${f.orgId}`)[0]!.n)).toBe(0);
  });

  it('settlement: A voids the verified day (held); B records a payout against it: B parks, then is refused; no settlement row', async () => {
    const f = await world();
    const [a, b] = await heldRace(
      asOrg,
      f.orgId,
      (tx) => D.voidSalesDay(tx, f.admin, f.dayId, 'wrong day'),
      (tx) => sentenceOrOk(D.recordChannelSettlement(tx, f.admin, { storeId: f.storeA, channelId: f.channelId, salesDayId: f.dayId, businessDate: DATE, grossAmount: '10000.00', netDeposited: '10000.00', settledOn: '2026-10-20' })),
      700,
      { sql },
    );
    expect(a.reversalEntryId).not.toBeNull();
    expect(b).toMatch(voidedSentence('a payout settlement'));
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from channel_settlements where org_id = ${f.orgId}`)[0]!.n), 'a settlement was written').toBe(0);
  });

  it('positive: with no void in flight both post against a verified day', async () => {
    const f = await world();
    const { till, safe } = await tillTakings(f, '1000.00');
    await asOrg(f.orgId, (tx) => D.createRemittance(tx, f.admin, { storeId: f.storeA, remittedOn: '2026-10-13', lines: [{ fromMoneyAccountId: till, toMoneyAccountId: safe, amount: '1000.00' }] }));
    const g = await world();
    const s = await recordSettlement(g);
    expect(s.settlementId).toBeTruthy();
  });
});
