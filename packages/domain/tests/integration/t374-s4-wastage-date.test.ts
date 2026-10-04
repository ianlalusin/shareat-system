import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-374 S4 (DEF-576 + two DEF-577 sites in wastage/orders.ts) - a wastage is dated by its sales day.
 * `docs/tasks/374-money-push-follow-ups.md` section S4 and R4; tests T1-T6.
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET behaviour. Every refusal has a positive control.
 * Fixture shape from `t373-s1-voided-day-writers.test.ts` (trimmed: no stock, no POS pull).
 * Mutants (spec): date check before authorize -> T4 red; drop the check -> T1/T3 red; revert the
 * backstop's `entryDate` to the UTC date -> T5 red. (The spec struck "check after the write": the
 * refusal still unwinds the one transaction, so it is unobservable.)
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as D from '@shareat/domain';
import { recordOrderWastage, runOrderWastageBackstop } from '../../src/wastage/orders';
import { postEntry } from '../../src/ledger/post-entry';
import { humanDate } from '../../src/shared/refusal-leaf';

const sql = postgres(url, { max: 6 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

const DAY = '2027-02-10';
const OTHER = '2027-02-09';

async function fixture(hint: string, opts: { instant?: boolean } = {}) {
  const code = uid(`t374s4-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values
    (${orgId}, '2027-01-01', '2027-01-31', 'open'),
    (${orgId}, '2027-02-01', '2027-02-28', 'open'),
    (${orgId}, '2027-03-01', '2027-03-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, 'multi_room') returning id`;
  const storeId = store!.id;
  const mkPerson = async (name: string, role: string | null) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mkPerson('Manager', 'manager');
  const nobodyId = await mkPerson('Nobody', null);
  const mkChannel = async (name: string, remitted: boolean, receivable: string | null, mode: string) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, wastage_type_mode)
      values (${orgId}, ${storeId}, ${name}, ${remitted}, ${receivable}, ${mode}) returning id`)[0]!.id;
  const walkIn = await mkChannel('Walk-in', true, null, 'tracked');
  const foodpanda = await mkChannel('Foodpanda', false, '1220', opts.instant ? 'instant' : 'tracked');
  const manager = actor(orgId, managerId);
  const { id: salesDayId } = await asOrg(orgId, (tx) =>
    D.createSalesDay(tx, manager, {
      storeId, businessDate: DAY, totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00',
      cashCollected: '1000.00', channels: [{ channelId: walkIn, amount: '1000.00' }],
    }),
  );
  // A Foodpanda receivable so an absorbed/backstop posting has something to draw on.
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2027-01-10', sourceType: 'sales_day', sourceId: salesDayId,
      idempotencyKey: `sales_day:${salesDayId}:500`, memo: 'Channel day', postedBy: managerId,
      lines: [
        { accountCode: '1220', storeId, debit: '500.00', partyType: 'channel', partyId: foodpanda },
        { accountCode: '4150', storeId, credit: '500.00' },
      ],
    }),
  );
  return { orgId, storeId, managerId, manager, nobody: actor(orgId, nobodyId), salesDayId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const input = (f: Fixture, extra: Record<string, unknown> = {}) => ({
  storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda', amount: '100.00', reason: 'remade order', openedOn: DAY, ...extra,
});
const record = (f: Fixture, extra: Record<string, unknown> = {}, who: Actor = f.manager) =>
  asOrg(f.orgId, (tx) => recordOrderWastage(tx, who, input(f, extra) as Parameters<typeof recordOrderWastage>[2]));
const instant = { disposition: 'absorbed' };

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED - ${what} succeeded instead (the defect this leg targets)`);
}
const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await q) as unknown as { n: string }[])[0]!.n);
const wastageRows = (f: Fixture) => count(sql`select count(*)::text as n from order_wastages where org_id = ${f.orgId}`);
const wastageEntries = (f: Fixture) => count(sql`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = 'order_wastage'`);
const entryDateOf = async (entryId: string) =>
  (await sql<{ d: string }[]>`select entry_date::text as d from journal_entries where id = ${entryId}`)[0]!.d;

const mismatchSentence = (given: string, day: string) =>
  `This wastage is dated ${humanDate(given as never)}, but the sales day it's recorded against is ${humanDate(day as never)}.`;

describe('T1/T2 - instant channel: openedOn must equal the sales day', () => {
  it('T1: openedOn 2027-02-09 against day 2027-02-10 is refused with both dates; nothing written', async () => {
    const f = await fixture('t1', { instant: true });
    const r = await rejection(record(f, { ...instant, openedOn: OTHER }), 'a wastage dated a different day than its sales day');
    expect(r.userMessage).toBe(mismatchSentence(OTHER, DAY));
    expect(r.userMessage).not.toMatch(UUID);
    expect(await wastageRows(f)).toBe(0);
    expect(await wastageEntries(f)).toBe(0);
  });

  it('T2 (control): equal openedOn posts, entry_date is the sales day', async () => {
    const f = await fixture('t2', { instant: true });
    const rec = await record(f, instant);
    expect(rec.journalEntryId).toBeTruthy();
    expect(await entryDateOf(rec.journalEntryId!)).toBe(DAY);
    expect(await wastageRows(f)).toBe(1);
  });
});

describe('T3 - tracked channel: the same rule', () => {
  it('mismatch refused, no row; control: equal openedOn records', async () => {
    const f = await fixture('t3');
    const r = await rejection(record(f, { openedOn: OTHER }), 'a tracked wastage dated a different day');
    expect(r.userMessage).toBe(mismatchSentence(OTHER, DAY));
    expect(await wastageRows(f)).toBe(0);
    const ok = await record(f);
    expect(ok.status).toBe('open');
    expect(await wastageRows(f)).toBe(1);
  });
});

describe('T4 - authorize() before the date check (I1)', () => {
  it('no record_order_wastage + mismatched date -> AuthorizationError, not the date sentence', async () => {
    const f = await fixture('t4', { instant: true });
    const r = await rejection(record(f, { ...instant, openedOn: OTHER }, f.nobody), 'an unauthorized wastage');
    expect(r.err).toBeInstanceOf(AuthorizationError);
    expect(r.userMessage ?? r.message).not.toBe(mismatchSentence(OTHER, DAY));
    expect(await wastageRows(f)).toBe(0);
  });
});

async function dueTracked(f: Fixture) {
  const rec = await record(f);
  await sql`update order_wastages set opened_at = '2027-02-01T00:00:00Z' where id = ${rec.id}`;
  return rec;
}
const backstop = (f: Fixture, now: Date) => asOrg(f.orgId, (tx) => runOrderWastageBackstop(tx, f.orgId, { now, postedBy: null }));
const resolvedEntry = async (id: string) =>
  (await sql<{ j: string | null }[]>`select journal_entry_id as j from order_wastages where id = ${id}`)[0]!.j;

describe('T5/T6 - the backstop dates its charge by the Manila business date', () => {
  it('T5: now 2027-03-01T18:00Z (2 March, 02:00 Manila) posts on 2027-03-02; a second run is a no-op', async () => {
    const f = await fixture('t5');
    const rec = await dueTracked(f);
    const now = new Date('2027-03-01T18:00:00Z');
    const first = await backstop(f, now);
    expect(first.failures).toHaveLength(0);
    expect(first.outcomes.map((o) => o.wastageId)).toContain(rec.id);
    const entryId = await resolvedEntry(rec.id);
    expect(entryId, 'the backstop must have posted an entry').toBeTruthy();
    expect(await entryDateOf(entryId!)).toBe('2027-03-02');

    const entriesAfterFirst = await wastageEntries(f);
    const second = await backstop(f, now);
    expect(second.outcomes).toHaveLength(0);
    expect(await wastageEntries(f)).toBe(entriesAfterFirst);
  });

  it('T6 (control): now 2027-03-02T04:00Z posts on 2027-03-02', async () => {
    const f = await fixture('t6');
    const rec = await dueTracked(f);
    const first = await backstop(f, new Date('2027-03-02T04:00:00Z'));
    expect(first.failures).toHaveLength(0);
    const entryId = await resolvedEntry(rec.id);
    expect(entryId).toBeTruthy();
    expect(await entryDateOf(entryId!)).toBe('2027-03-02');
  });
});
