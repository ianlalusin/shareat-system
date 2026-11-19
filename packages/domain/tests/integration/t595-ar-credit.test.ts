import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-595 - the store credit guards (DEF-878 void, DEF-879 race, DEF-880 spend only where earned).
 * `docs/tasks/595-money-ar-credit-settlement-day.md`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { arRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, recordCharge, recordCollection, voidCollection } from '@shareat/domain';

const sql = postgres(url, { max: 6 });
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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** Two stores (Lipa, Malvar), one admin scoped to both, one customer, a cashier drawer at each store. */
async function fixture(hint: string) {
  const code = uid(`t595-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const lipaId = await mkStore('lipa');
  const malvarId = await mkStore('malvar');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  for (const s of [lipaId, malvarId]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  const drawer = async (storeId: string) =>
    (await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`)[0]!.id;
  const admin = actor(orgId, p!.id);
  const customer = await asOrg(orgId, (tx) => createCustomer(tx, admin, { name: `Resto ${code}` }));
  return {
    orgId, lipaId, malvarId, admin, adminId: p!.id, customerId: customer.id,
    drawerLipa: await drawer(lipaId), drawerMalvar: await drawer(malvarId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

type StoreKey = 'lipa' | 'malvar';
const storeOf = (f: Fixture, k: StoreKey) => (k === 'lipa' ? f.lipaId : f.malvarId);
const drawerOf = (f: Fixture, k: StoreKey) => (k === 'lipa' ? f.drawerLipa : f.drawerMalvar);

async function charge(f: Fixture, amount: string, at: StoreKey = 'lipa') {
  return asOrg(f.orgId, (tx) =>
    recordCharge(tx, f.admin, {
      storeId: storeOf(f, at), customerId: f.customerId, chargeDate: '2026-01-10', dueDate: null,
      totalAmount: amount, revenueAccountCode: '4150',
    }),
  );
}

interface CollectOpts { amount: string; applied: string; creditApplied?: string; at?: StoreKey }
const collectIn = (tx: Tx, f: Fixture, chargeId: string, o: CollectOpts) =>
  recordCollection(tx, f.admin, {
    storeId: storeOf(f, o.at ?? 'lipa'), customerId: f.customerId, collectionDate: '2026-01-20',
    amount: o.amount, moneyAccountId: drawerOf(f, o.at ?? 'lipa'),
    ...(o.creditApplied ? { creditApplied: o.creditApplied } : {}),
    allocations: [{ chargeId, amountApplied: o.applied }],
  });
const collect = (f: Fixture, chargeId: string, o: CollectOpts) => asOrg(f.orgId, (tx) => collectIn(tx, f, chargeId, o));

const creditOf = (f: Fixture, storeIds?: string[]) => asOrg(f.orgId, (tx) => arRepo.creditBalanceOf(tx, f.orgId, f.customerId, storeIds));
const voidIt = (f: Fixture, collectionId: string) => asOrg(f.orgId, (tx) => voidCollection(tx, f.admin, { collectionId, reason: 'test' }));

async function status(collectionId: string) {
  return (await sql<{ status: string }[]>`select status from ar_collections where id = ${collectionId}`)[0]!.status;
}
async function reversalsOf(f: Fixture) {
  return (await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and reversal_of_entry_id is not null`)[0]!.n;
}
async function collectionRows(f: Fixture) {
  return (await sql<{ n: string }[]>`select count(*)::text as n from ar_collections where org_id = ${f.orgId}`)[0]!.n;
}
async function refusal(p: Promise<unknown>): Promise<{ message: string; userMessage: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; userMessage?: string };
    return { message: err.message, userMessage: err.userMessage ?? err.message };
  }
  throw new Error('NOT REFUSED');
}

/** Overpay a charge of 1000 by `over` at `at`: leaves `over` of store credit at that store. */
async function overpay(f: Fixture, over: number, at: StoreKey = 'lipa') {
  const c = await charge(f, '1000.00', at);
  return collect(f, c.chargeId, { amount: `${1000 + over}.00`, applied: '1000.00', at });
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('DEF-878 - a collection that left store credit cannot be voided once the credit is spent', () => {
  it('positive: the credit is still there, so the void goes through and the credit is gone', async () => {
    const f = await fixture('v-pos');
    const col = await overpay(f, 500);
    expect(await creditOf(f)).toBe('500.00');
    await voidIt(f, col.collectionId);
    expect(await status(col.collectionId)).toBe('voided');
    expect(await creditOf(f)).toBe('0.00');
  });

  it('refusal: 300 of the 500 credit was spent, so the void is refused, nothing is reversed, the collection stays posted', async () => {
    const f = await fixture('v-refuse');
    const col = await overpay(f, 500);
    const second = await charge(f, '300.00');
    await collect(f, second.chargeId, { amount: '300.00', applied: '300.00', creditApplied: '300.00' });
    expect(await creditOf(f)).toBe('200.00');
    const before = await reversalsOf(f);
    const said = await refusal(voidIt(f, col.collectionId));
    expect(said.message).toMatch(/left 500\.00 of store credit and only 200\.00 is held/);
    expect(said.userMessage).toMatch(/300\.00 of the store credit this collection created has already been spent/);
    expect(await status(col.collectionId)).toBe('posted');
    expect(await reversalsOf(f)).toBe(before);
    expect(await creditOf(f)).toBe('200.00');
  });

  it('a collection that only SPENT credit voids, and the credit comes back', async () => {
    const f = await fixture('v-spent');
    await overpay(f, 500);
    const second = await charge(f, '300.00');
    const spender = await collect(f, second.chargeId, { amount: '300.00', applied: '300.00', creditApplied: '300.00' });
    expect(await creditOf(f)).toBe('200.00');
    await voidIt(f, spender.collectionId);
    expect(await status(spender.collectionId)).toBe('voided');
    expect(await creditOf(f)).toBe('500.00');
  });

  it('RACE: a spend of the credit holds its transaction open; the void of the overpaying collection waits, then is refused [kills: no customer lock in voidCollection]', async () => {
    const f = await fixture('v-race');
    const col = await overpay(f, 500);
    const second = await charge(f, '300.00');
    let release!: () => void;
    const hold = new Promise<void>((res) => { release = res; });
    let spent!: () => void;
    const spentP = new Promise<void>((res) => { spent = res; });
    const first = asOrg(f.orgId, async (tx) => {
      const r = await collectIn(tx, f, second.chargeId, { amount: '300.00', applied: '300.00', creditApplied: '300.00' });
      spent();
      await hold;
      return r;
    });
    await spentP;
    const voiding = refusal(voidIt(f, col.collectionId));
    await new Promise((res) => setTimeout(res, 1500)); // let the void reach its balance read (and block, if locked)
    release();
    await first;
    const said = await voiding;
    expect(said.userMessage).toMatch(/already been spent/);
    expect(await status(col.collectionId)).toBe('posted');
    expect(await creditOf(f)).toBe('200.00');
  });
});

describe('DEF-879 - two collections cannot spend the same store credit', () => {
  it('RACE: 500 credit, two charges, both collections spend 500 at once: the second is refused and the credit ends at 0.00, not -500.00 [kills: no customer lock in recordCollection]', async () => {
    const f = await fixture('s-race');
    await overpay(f, 500);
    const a = await charge(f, '500.00');
    const b = await charge(f, '500.00');
    let release!: () => void;
    const hold = new Promise<void>((res) => { release = res; });
    let spent!: () => void;
    const spentP = new Promise<void>((res) => { spent = res; });
    const first = asOrg(f.orgId, async (tx) => {
      const r = await collectIn(tx, f, a.chargeId, { amount: '500.00', applied: '500.00', creditApplied: '500.00' });
      spent();
      await hold;
      return r;
    });
    await spentP;
    const second = refusal(collect(f, b.chargeId, { amount: '500.00', applied: '500.00', creditApplied: '500.00' }));
    await new Promise((res) => setTimeout(res, 1500));
    release();
    await first;
    await second; // refused (the wording belongs to DEF-880)
    expect(await creditOf(f)).toBe('0.00');
  });
});
