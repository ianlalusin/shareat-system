import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-592 - a store code belongs only on a settle-later channel, and a store has one ACTIVE channel per platform.
 * `docs/tasks/592-sales-channels-store-code.md` R1 + R2. Real Postgres on a scratch database whose name contains "_test".
 *
 * Each refusal below has a positive twin and was mutated (domain check deleted): the test that asserts the SENTENCE goes red, while the
 * database CHECK / unique index still refuses the write (raw 23514 / 23505, not a RefusalError) - the database is the authority, the
 * domain only words the refusal.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { APP_ROLE, closeDb, RefusalError, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { setSalesChannelActive, setSalesChannelPlatformCode, updateSalesChannel } from '../../src/sales-channels';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function person(orgId: string, role: string, name: string, stores: string[]) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return p!.id;
}

async function channel(orgId: string, storeId: string, name: string, daily: boolean) {
  const [c] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
    values (${orgId}, ${storeId}, ${name}, ${daily}, ${daily ? null : '1220'}) returning id`;
  return c!.id;
}

/** Store A: Dine-in (daily), Foodpanda and Foodpanda 2 (settle later), Grab (settle later). Store B: Foodpanda B (settle later). */
async function fixture(hint: string) {
  const code = uid(`t592-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('Store A');
  const storeB = await mkStore('Store B');
  const adminId = await person(orgId, 'admin', 'Admin', [storeA, storeB]);
  const managerId = await person(orgId, 'manager', 'Manager', [storeA, storeB]);
  return {
    orgId,
    storeA,
    storeB,
    dineIn: await channel(orgId, storeA, 'Dine-in', true),
    fp1: await channel(orgId, storeA, 'Foodpanda', false),
    fp2: await channel(orgId, storeA, 'Foodpanda 2', false),
    grab: await channel(orgId, storeA, 'Grab', false),
    fpB: await channel(orgId, storeB, 'Foodpanda B', false),
    admin: actorOf(orgId, adminId),
    manager: actorOf(orgId, managerId),
  };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

interface ChannelRow {
  platform: string | null;
  platform_store_code: string | null;
  is_remitted_daily: boolean;
  is_active: boolean;
  updated_at: Date | null;
}
async function row(id: string): Promise<ChannelRow> {
  const [r] = await sql<ChannelRow[]>`
    select platform, platform_store_code, is_remitted_daily, is_active, updated_at from sales_channels where id = ${id}`;
  return r!;
}
async function auditCount(f: Fx, channelId: string): Promise<number> {
  const [r] = await sql<{ n: string }[]>`
    select count(*) as n from audit_log where org_id = ${f.orgId} and action = 'sales_channel.platform_code_edited' and entity_id = ${channelId}`;
  return Number(r!.n);
}

const setCode = (f: Fx, channelId: string, platform: 'grab' | 'foodpanda' | null, code: string | null) =>
  asOrg(f.orgId, (tx) => setSalesChannelPlatformCode(tx, f.admin, { channelId, platform, code }));
const toDaily = (f: Fx, channelId: string, name: string) =>
  asOrg(f.orgId, (tx) =>
    updateSalesChannel(tx, f.manager, { channelId, name, isRemittedDaily: true, receivableAccountCode: null, wastageTypeMode: 'tracked' }),
  );
const setActive = (f: Fx, channelId: string, isActive: boolean) =>
  asOrg(f.orgId, (tx) => setSalesChannelActive(tx, f.manager, { channelId, isActive }));

/** The refusal must be a RefusalError (a sentence for a person), never the raw database error. */
async function expectSentence(p: Promise<unknown>, sentence: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message).slice(0, 160)}`).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toBe(sentence);
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

describe('T-592 R1 - only a settle-later channel carries a store code', () => {
  it('positive: a code on a settle-later channel saves, with its audit row', async () => {
    const f = await fixture('r1-pos');
    expect(await setCode(f, f.fp1, 'foodpanda', 'ab12cd')).toEqual({ wrote: true });
    const r = await row(f.fp1);
    expect([r.platform, r.platform_store_code]).toEqual(['foodpanda', 'ab12cd']);
    expect(await auditCount(f, f.fp1)).toBe(1);
  });

  it('a code on a daily channel is refused with a sentence; no row change, no audit row; clearing stays allowed', async () => {
    const f = await fixture('r1-daily');
    const before = await row(f.dineIn);
    await expectSentence(setCode(f, f.dineIn, 'foodpanda', 'ab12cd'), '"Dine-in" reaches the till, so it has no store code.');
    expect(await row(f.dineIn)).toEqual(before);
    expect(await auditCount(f, f.dineIn)).toBe(0);
    expect(await setCode(f, f.dineIn, null, null)).toEqual({ wrote: false });
  });

  it('a coded channel cannot be switched to daily (sentence, row unchanged); after clearing the code it can', async () => {
    const f = await fixture('r1-switch');
    await setCode(f, f.fp1, 'foodpanda', 'ab12cd');
    const before = await row(f.fp1);
    await expectSentence(toDaily(f, f.fp1, 'Foodpanda'), '"Foodpanda" has a Foodpanda store code. Ask an admin to clear it first.');
    expect(await row(f.fp1)).toEqual(before);
    await setCode(f, f.fp1, null, null);
    await toDaily(f, f.fp1, 'Foodpanda');
    expect((await row(f.fp1)).is_remitted_daily).toBe(true);
  });

  it('the database is the authority: raw SQL cannot put a code on a daily channel either (CHECK 23514)', async () => {
    const f = await fixture('r1-db');
    const err = await sql`update sales_channels set platform = 'foodpanda', platform_store_code = 'ab12cd' where id = ${f.dineIn}`.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe('23514');
    expect((err as { constraint_name?: string }).constraint_name).toBe('sales_channels_platform_only_settle_later_check');
  });
});

describe('T-592 R2 - one active channel per platform per store', () => {
  it('a second active channel on the same platform at the same store is refused (sentence, no row change, no audit); the other store and the other platform are fine', async () => {
    const f = await fixture('r2-second');
    await setCode(f, f.fp1, 'foodpanda', 'ab12cd');
    await expectSentence(
      setCode(f, f.fp2, 'foodpanda', 'zz99yy'),
      'This store already has an active Foodpanda channel, "Foodpanda". A store can have only one.',
    );
    expect((await row(f.fp2)).platform).toBeNull();
    expect(await auditCount(f, f.fp2)).toBe(0);
    expect(await setCode(f, f.fpB, 'foodpanda', 'qq11ww')).toEqual({ wrote: true });
    expect(await setCode(f, f.grab, 'grab', '11111111-1111-4111-8111-111111111111')).toEqual({ wrote: true });
  });

  it('a retired channel on the platform does not count: the second channel may take the platform', async () => {
    const f = await fixture('r2-retired');
    await setCode(f, f.fp1, 'foodpanda', 'ab12cd');
    await setActive(f, f.fp1, false);
    expect(await setCode(f, f.fp2, 'foodpanda', 'zz99yy')).toEqual({ wrote: true });
  });

  it('reactivating a retired coded channel into a clash is refused with the sentence; without a clash it reactivates', async () => {
    const f = await fixture('r2-react');
    await setCode(f, f.fp1, 'foodpanda', 'ab12cd');
    await setActive(f, f.fp1, false);
    await setCode(f, f.fp2, 'foodpanda', 'zz99yy');
    await expectSentence(setActive(f, f.fp1, true), 'This store already has an active Foodpanda channel, "Foodpanda 2". A store can have only one.');
    expect((await row(f.fp1)).is_active).toBe(false);
    await setActive(f, f.fp2, false);
    await setActive(f, f.fp1, true);
    expect((await row(f.fp1)).is_active).toBe(true);
  });

  it('the database is the authority: raw SQL cannot make a second active channel on the platform (unique 23505)', async () => {
    const f = await fixture('r2-db');
    await setCode(f, f.fp1, 'foodpanda', 'ab12cd');
    const err = await sql`update sales_channels set platform = 'foodpanda', platform_store_code = 'zz99yy' where id = ${f.fp2}`.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe('23505');
    expect((err as { constraint_name?: string }).constraint_name).toBe('sales_channels_store_platform_active_key');
  });
});
