/*
 * MOVES TO S3 (t375-s3-*): L5 REVERSE
 * Exact text relocated from this file (uses its fixture(), link(), asOrg(), minimalTypedDay(), dayCount()):
 *   it('REVERSE (refusal owned by S3, red until then): B links first and commits; A\'s typed createSalesDay then refuses and writes ZERO days; the unlinked store still types freely', async () => {
 *     const f = await fixture('l5r');
 *     await link(f, f.admin);
 *     const err = await asOrg(f.orgId, (tx) => createSalesDay(tx, f.manager, minimalTypedDay(f.storeId))).then(() => null, (e) => e);
 *     expect(err, 'a typed create on a linked store must refuse (S3 owns the sentence)').toBeInstanceOf(Error);
 *     expect(await dayCount(f.storeId)).toBe(0);
 *     // positive control: the UNLINKED store keeps the typed path
 *     await expect(asOrg(f.orgId, (tx) => createSalesDay(tx, f.manager, minimalTypedDay(f.store2Id)))).resolves.toHaveProperty('id');
 *     expect(await dayCount(f.store2Id)).toBe(1);
 *   });
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-375 S1 - the store link and the channel guard. `docs/tasks/375-pos-v1-day-feed.md` section S1, tests L1-L5.
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET behaviour (the spec's sentences, R7, R13, review changes
 * V6 / W6 / W7), and every refusal has a positive control in the same file.
 *
 * ## Why these are red on HEAD
 * `packages/domain/src/pos/store-link.ts` and `pos_v1_store_links` (migration 0183) do not exist. `linkStoreToPos`
 * is imported DYNAMICALLY inside each test (`link()` below), so each leg fails on its own line with
 * "Failed to resolve import ../../src/pos/store-link" - a missing module is the honest red for a new file. Once the
 * module exists, the legs fail (or pass) on the assertions named in each test. L3's refusals call code that EXISTS on
 * HEAD (`updateSalesChannel`, `setSalesChannelActive`), but they need a link row first, so they too go red on the
 * missing module/table and then on the V6 sentence.
 *
 * ## How the target is read where the spec is silent (a question to the tester, not a test edit)
 *  - `linkStoreToPos(tx, actor, { storeId, posStoreId, posStoreName, salesChannelId, posTaxType })` THROWS every
 *    refusal (a RefusalError carrying `userMessage`); the helper `sentence()` reads `userMessage ?? message`;
 *  - the link row is read back by raw SQL (`pos_v1_store_links`), so the return value is not asserted;
 *  - `{dates}` in the L4 sentence is `humanDate(date)` (the spec's I8: dates via `humanDate`); two dates are joined
 *    by whatever separator, so the test asserts each date appears, not the separator;
 *  - the audit row is found by `action = 'link_store_to_pos'` (the spec names that action; the entity name is not given);
 *  - L5's REVERSE leg ("B links first and commits; A's createSalesDay refuses") is owned by S3: the typed-create refusal
 *    does not exist until S3. It is in this file because the spec lists it in S1's L5, and it is NAMED so the gate
 *    reader sees why it stays red after S1. The forward leg needs only S1 (the INSERT's own FK check takes
 *    FOR KEY SHARE on the store row, which `linkStoreToPos`'s FOR UPDATE then waits for).
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
import { createSalesDay } from '../../src/sales-days/create';
import { setSalesChannelActive, updateSalesChannel } from '../../src/sales-channels';
import { humanDate as humanDateOf } from '../../src/shared/refusal-leaf';
import { parseBusinessDate } from '@shareat/core/datetime';

/** `humanDate` takes a branded BusinessDate; `parseBusinessDate` is the project's validating constructor. */
const humanDate = (d: string) => humanDateOf(parseBusinessDate(d));

const sql = postgres(url, { max: 12 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

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
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

type LinkInput = { storeId: string; posStoreId: string; posStoreName: string; salesChannelId: string; posTaxType: 'vat_inclusive' | 'vat_exclusive' | 'non_vat' };
async function link(f: Fixture, who: Actor, input: Partial<LinkInput> = {}) {
  const { linkStoreToPos } = await import('../../src/pos/store-link');
  const full: LinkInput = {
    storeId: f.storeId,
    posStoreId: f.posId,
    posStoreName: 'Lipa (POS)',
    salesChannelId: f.walkInId,
    posTaxType: 'vat_inclusive',
    ...input,
  };
  return asOrg(f.orgId, (tx) => linkStoreToPos(tx, who, full));
}

/** The sentence a person would read: a RefusalError's userMessage, else the message. */
const sentence = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'the call must refuse').toBeInstanceOf(Error);
  return sentence(err);
}

async function linkRows(storeId: string) {
  return sql<{ pos_store_id: string; pos_store_name: string; sales_channel_id: string; pos_tax_type: string; store_id: string; created_by: string }[]>`
    select pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, store_id, created_by from pos_v1_store_links where store_id = ${storeId}`;
}

async function fixture(hint: string) {
  const code = uid(`t375s1l-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('Lipa');
  const store2Id = await mkStore('Batangas');
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of [storeId, store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');
  const staffId = await mkPerson('Staff', 'staff');
  const mkChannel = async (sid: string, name: string, remitted: boolean) => {
    const [c] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${sid}, ${name}, ${remitted}, ${remitted ? null : '1220'}) returning id`;
    return c!.id;
  };
  const walkInId = await mkChannel(storeId, 'Walk-in', true);
  const otherRemittedId = await mkChannel(storeId, 'Counter 2', true);
  const spareRemittedId = await mkChannel(storeId, 'Counter 3', true);
  const platformId = await mkChannel(storeId, 'Foodpanda', false);
  const store2ChannelId = await mkChannel(store2Id, 'Walk-in', true);
  return {
    orgId,
    // POS store ids are unique GLOBALLY (one POS store, one org), so every fixture owns a distinct one.
    posId: uid('pos-lipa'),
    storeId,
    store2Id,
    walkInId,
    otherRemittedId,
    spareRemittedId,
    platformId,
    store2ChannelId,
    adminId,
    managerId,
    staffId,
    admin: actorOf(orgId, adminId),
    manager: actorOf(orgId, managerId),
    staff: actorOf(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function typedDay(f: Fixture, date: string, status: 'open' | 'submitted' | 'verified' | 'voided') {
  const [d] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by,
                            verified_by, verified_at, voided_by, voided_at, void_reason)
    values (${f.orgId}, ${f.storeId}, ${date}, ${status}, 100, 0, 100, ${f.managerId},
            ${status === 'verified' ? f.adminId : null}, ${status === 'verified' ? new Date().toISOString() : null},
            ${status === 'voided' ? f.adminId : null}, ${status === 'voided' ? new Date().toISOString() : null}, ${status === 'voided' ? 'typed in error' : null})
    returning id`;
  return d!.id;
}

describe('L1 - who may link a store (manage_chart_of_accounts, admin and super admin only)', () => {
  it('admin links a store: one row with the POS id, name, channel, tax type and the actor; audited', async () => {
    const f = await fixture('l1a');
    await link(f, f.admin);
    const rows = await linkRows(f.storeId);
    expect(rows).toEqual([
      { pos_store_id: f.posId, pos_store_name: 'Lipa (POS)', sales_channel_id: f.walkInId, pos_tax_type: 'vat_inclusive', store_id: f.storeId, created_by: f.adminId },
    ]);
    const [audit] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${f.orgId} and action = 'link_store_to_pos'`;
    expect(audit!.n, 'link_store_to_pos is audited').toBeGreaterThanOrEqual(1);
  });

  it('a manager is refused with AuthorizationError and nothing is written - Mutant: capability manage_store_settings lets her in', async () => {
    const f = await fixture('l1m');
    await expect(link(f, f.manager)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await linkRows(f.storeId)).toHaveLength(0);
  });

  it('a staff member is refused with AuthorizationError and nothing is written', async () => {
    const f = await fixture('l1s');
    await expect(link(f, f.staff)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await linkRows(f.storeId)).toHaveLength(0);
  });

  it('I1: authorize() comes BEFORE the business refusals - a manager naming a non-remitted channel gets AuthorizationError, not the channel sentence', async () => {
    const f = await fixture('l1i');
    await expect(link(f, f.manager, { salesChannelId: f.platformId })).rejects.toBeInstanceOf(AuthorizationError);
    // control: the SAME input from an admin gets the channel sentence (so the order is what is being proven)
    expect(await sentenceOf(link(f, f.admin, { salesChannelId: f.platformId }))).toMatch(/remitted daily/);
  });
});

describe('L2 - the link refuses a wrong channel and a POS store linked elsewhere', () => {
  it('a channel of another store -> "That sales channel belongs to a different store."', async () => {
    const f = await fixture('l2a');
    expect(await sentenceOf(link(f, f.admin, { salesChannelId: f.store2ChannelId }))).toBe('That sales channel belongs to a different store.');
    expect(await linkRows(f.storeId)).toHaveLength(0);
  });

  it("a non-remitted channel -> \"POS's sales are paid at the till, so they need a channel whose money is remitted daily.\"", async () => {
    const f = await fixture('l2b');
    expect(await sentenceOf(link(f, f.admin, { salesChannelId: f.platformId }))).toBe(
      "POS's sales are paid at the till, so they need a channel whose money is remitted daily.",
    );
    expect(await linkRows(f.storeId)).toHaveLength(0);
  });

  it('a POS store already linked elsewhere -> "That POS store is already linked to {store}."', async () => {
    const f = await fixture('l2c');
    const shared = uid('pos-shared');
    await link(f, f.admin, { posStoreId: shared });
    expect(await sentenceOf(link(f, f.admin, { storeId: f.store2Id, salesChannelId: f.store2ChannelId, posStoreId: shared }))).toBe(
      'That POS store is already linked to Lipa.',
    );
    expect(await linkRows(f.store2Id)).toHaveLength(0);
  });

  it('GLOBAL uniqueness: a POS store id linked by org A cannot be linked by org B - the refusal names neither org A nor its store; control: org B links a different POS id', async () => {
    const a = await fixture('l2ga');
    const b = await fixture('l2gb');
    await sql`update stores set name = 'Secret Branch' where id = ${a.storeId}`;
    const shared = uid('pos-x');
    await link(a, a.admin, { posStoreId: shared });
    const text = await sentenceOf(link(b, b.admin, { posStoreId: shared }));
    expect(text).toMatch(/already linked/i);
    expect(text, 'must not leak the other business store name').not.toContain('Secret Branch');
    expect(text).not.toContain(a.storeId);
    expect(text).not.toContain(a.orgId);
    expect(await linkRows(b.storeId)).toHaveLength(0);
    // control: a different POS id links fine for org B (the refusal is about the id, not the org)
    await expect(link(b, b.admin, { posStoreId: uid('pos-y') })).resolves.toBeDefined();
    expect(await linkRows(b.storeId)).toHaveLength(1);
  });

  it('control: relinking the SAME store to a new POS id updates the one row (store id never changes, no second row)', async () => {
    const f = await fixture('l2d');
    const oldId = uid('pos-old');
    const newId = uid('pos-new');
    await link(f, f.admin, { posStoreId: oldId, posStoreName: 'Old', posTaxType: 'vat_inclusive' });
    await link(f, f.admin, { posStoreId: newId, posStoreName: 'New', salesChannelId: f.otherRemittedId, posTaxType: 'non_vat' });
    expect(await linkRows(f.storeId)).toEqual([
      { pos_store_id: newId, pos_store_name: 'New', sales_channel_id: f.otherRemittedId, pos_tax_type: 'non_vat', store_id: f.storeId, created_by: f.adminId },
    ]);
  });

  it('control: a good link (own store, remitted channel, a free POS id) is accepted', async () => {
    const f = await fixture('l2e');
    await expect(link(f, f.admin)).resolves.toBeDefined();
    expect(await linkRows(f.storeId)).toHaveLength(1);
  });
});

describe('L3 - the linked channel cannot be flipped or retired under the link (V6)', () => {
  const V6 = "POS's sales land in this channel, so it has to stay remitted daily and active. Change the POS link first.";

  it('flipping the linked channel to non-remitted -> the V6 sentence, and the channel is unchanged', async () => {
    const f = await fixture('l3a');
    await link(f, f.admin);
    const text = await sentenceOf(
      asOrg(f.orgId, (tx) =>
        updateSalesChannel(tx, f.admin, { channelId: f.walkInId, name: 'Walk-in', isRemittedDaily: false, receivableAccountCode: '1220', wastageTypeMode: 'tracked' }),
      ),
    );
    expect(text).toBe(V6);
    const [ch] = await sql<{ is_remitted_daily: boolean }[]>`select is_remitted_daily from sales_channels where id = ${f.walkInId}`;
    expect(ch!.is_remitted_daily).toBe(true);
  });

  it('retiring the linked channel -> the V6 sentence, and the channel stays active', async () => {
    const f = await fixture('l3b');
    await link(f, f.admin);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => setSalesChannelActive(tx, f.admin, { channelId: f.walkInId, isActive: false })))).toBe(V6);
    const [ch] = await sql<{ is_active: boolean }[]>`select is_active from sales_channels where id = ${f.walkInId}`;
    expect(ch!.is_active).toBe(true);
  });

  it('controls: another channel of the store flips and retires freely; the linked channel can still be renamed (stays remitted and active)', async () => {
    const f = await fixture('l3c');
    await link(f, f.admin);
    await asOrg(f.orgId, (tx) =>
      updateSalesChannel(tx, f.admin, { channelId: f.otherRemittedId, name: 'Counter 2', isRemittedDaily: false, receivableAccountCode: '1220', wastageTypeMode: 'tracked' }),
    );
    await asOrg(f.orgId, (tx) => setSalesChannelActive(tx, f.admin, { channelId: f.spareRemittedId, isActive: false }));
    await asOrg(f.orgId, (tx) =>
      updateSalesChannel(tx, f.admin, { channelId: f.walkInId, name: 'Walk-in renamed', isRemittedDaily: true, wastageTypeMode: 'tracked' }),
    );
    const rows = await sql<{ id: string; is_remitted_daily: boolean; is_active: boolean; name: string }[]>`
      select id, is_remitted_daily, is_active, name from sales_channels where id in (${f.otherRemittedId}, ${f.spareRemittedId}, ${f.walkInId})`;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[f.otherRemittedId]!.is_remitted_daily).toBe(false);
    expect(by[f.spareRemittedId]!.is_active).toBe(false);
    expect(by[f.walkInId]).toMatchObject({ name: 'Walk-in renamed', is_remitted_daily: true, is_active: true });
  });

  it('control: before any link exists the same flip is allowed (the guard keys on the link, not on the channel)', async () => {
    const f = await fixture('l3d');
    await expect(
      asOrg(f.orgId, (tx) =>
        updateSalesChannel(tx, f.admin, { channelId: f.walkInId, name: 'Walk-in', isRemittedDaily: false, receivableAccountCode: '1220', wastageTypeMode: 'tracked' }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('L4 - a store with an unverified typed day cannot be linked (W6)', () => {
  const tail = /Verify or withdraw them before linking it to POS\.$/;

  it('an OPEN typed day -> refused naming Lipa and the date; nothing linked', async () => {
    const f = await fixture('l4a');
    await typedDay(f, '2027-01-05', 'open');
    const text = await sentenceOf(link(f, f.admin));
    expect(text).toMatch(/^Lipa still has typed sales days that aren't verified \(/);
    expect(text).toContain(humanDate('2027-01-05'));
    expect(text).toMatch(tail);
    expect(await linkRows(f.storeId)).toHaveLength(0);
  });

  it('a SUBMITTED typed day is refused too, and both dates are named when there are two - Mutant: no open-typed-day check links the store', async () => {
    const f = await fixture('l4b');
    await typedDay(f, '2027-01-05', 'open');
    await typedDay(f, '2027-01-06', 'submitted');
    const text = await sentenceOf(link(f, f.admin));
    expect(text).toContain(humanDate('2027-01-05'));
    expect(text).toContain(humanDate('2027-01-06'));
    expect(await linkRows(f.storeId)).toHaveLength(0);
  });

  it('control: once that day is verified, the store links', async () => {
    const f = await fixture('l4c');
    const id = await typedDay(f, '2027-01-05', 'open');
    await expect(link(f, f.admin)).rejects.toBeInstanceOf(Error);
    await sql`update sales_days set status = 'verified', verified_by = ${f.adminId}, verified_at = now() where id = ${id}`;
    await expect(link(f, f.admin)).resolves.toBeDefined();
    expect(await linkRows(f.storeId)).toHaveLength(1);
  });

  it('control: a store with only VERIFIED and VOIDED typed days links', async () => {
    const f = await fixture('l4d');
    await typedDay(f, '2027-01-05', 'verified');
    await typedDay(f, '2027-01-06', 'voided');
    await expect(link(f, f.admin)).resolves.toBeDefined();
    expect(await linkRows(f.storeId)).toHaveLength(1);
  });

  it('control: another store\'s open typed day does not block this store', async () => {
    const f = await fixture('l4e');
    await sql`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.store2Id}, '2027-01-05', 100, 0, 100, ${f.managerId})`;
    await expect(link(f, f.admin)).resolves.toBeDefined();
  });
});

// ---- L5: the race (W7) --------------------------------------------------------------------------
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitingBackend(pid: Promise<number>, settled: Promise<unknown>, timeoutMs = 5000): Promise<boolean> {
  const done = settled.then(() => true, () => true);
  const p = await Promise.race([pid, done.then(() => 0)]);
  if (!p) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ pid: number }[]>`
      select pid from pg_stat_activity
      where datname = current_database() and pid = ${p} and wait_event_type = 'Lock' and wait_event = any(${['transactionid', 'tuple']})`;
    if (rows[0]) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const minimalTypedDay = (storeId: string) => ({
  storeId,
  businessDate: '2027-01-05',
  totalSales: '100.00',
  unliSales: '0.00',
  alaCarteSales: '100.00',
  cashCollected: '100.00',
});

const dayCount = async (storeId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sales_days where store_id = ${storeId} and business_date = '2027-01-05'`)[0]!.n;

describe('L5 - typed create and link of one store serialize (W7)', () => {
  it('FORWARD: A creates a typed day (uncommitted), B links and blocks, A commits, B then refuses for the new open day (and nothing is linked)', async () => {
    const f = await fixture('l5f');
    const { linkStoreToPos } = await import('../../src/pos/store-link');
    const aReady = deferred<void>();
    const gate = deferred<void>();
    const aP = asOrg(f.orgId, async (tx) => {
      try {
        const out = await createSalesDay(tx, f.manager, minimalTypedDay(f.storeId));
        return out;
      } finally {
        aReady.resolve();
        await gate.promise;
      }
    }).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await aReady.promise;

    const pid = deferred<number>();
    const bP = asOrg(f.orgId, async (tx) => {
      const rows = await tx.execute(dsql`select pg_backend_pid() as pid`);
      pid.resolve(Number((rows as unknown as { pid: number }[])[0]?.pid));
      return linkStoreToPos(tx, f.admin, {
        storeId: f.storeId,
        posStoreId: f.posId,
        posStoreName: 'Lipa (POS)',
        salesChannelId: f.walkInId,
        posTaxType: 'vat_inclusive',
      });
    }).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));

    const bWaited = await waitingBackend(pid.promise, bP);
    gate.resolve();
    const [a, b] = await Promise.all([aP, bP]);

    expect(bWaited, 'B (the link) must be blocked behind A, which holds the store row').toBe(true);
    expect(a.ok, 'A commits its typed day').toBe(true);
    expect(b.ok, 'B refuses once A has committed').toBe(false);
    expect(sentence((b as { e: unknown }).e)).toContain(humanDate('2027-01-05'));
    expect(await linkRows(f.storeId)).toHaveLength(0);
    expect(await dayCount(f.storeId)).toBe(1);
  });

  it('control: with no concurrent day, the same link succeeds and the order did not matter', async () => {
    const f = await fixture('l5c');
    await expect(link(f, f.admin)).resolves.toBeDefined();
    expect(await linkRows(f.storeId)).toHaveLength(1);
  });

});
