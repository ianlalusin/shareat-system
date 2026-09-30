import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

/**
 * DEF-546 — the DEF-497 existence oracle in `packages/domain/src/ar/index.ts`: `voidCharge`,
 * `voidCollection`, and the customer lookups in `recordCharge` / `recordCollection` answer
 * "does not exist" (with the uuid) for a missing id but an authorization refusal for a real one the
 * caller may not touch, so a forged id tells "not found" from "not yours". Same E15-twin shape as
 * `writeOffCharge` (t367-s1-write-off-once.test.ts), T-364 Q1 (a): ONE uniform refusal.
 *
 * Per site: (a) nonexistent id by an in-scope admin, (b) a real record outside the caller's scope by
 * the outsider -> same `userMessage`, present, no uuid in message/userMessage; (c) positive control.
 * The sentence's wording is NOT pinned, only equality / presence / absence of the id.
 *
 * NOTE recordCharge/recordCollection: customers are org-wide (no store scope), so the (b) leg there
 * is the outsider posting at a store they do not hold, against a real customer.
 *
 * Fixture copied from t367-s1-write-off-once.test.ts (second store + "outsider" admin).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, recordCharge, recordCollection, voidCharge, voidCollection } from '@shareat/domain';

const sql = postgres(url, { max: 10 });
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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`def546-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [otherStore] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}-other`)}, ${`Store ${hint} other`}) returning id`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-02-01', '2027-02-28', 'open')`;
  const mk = async (name: string, role: string, scopeStoreId: string = storeId) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${scopeStoreId})`;
    return p!.id;
  };
  const xId = await mk('X (author)', 'admin');
  const yId = await mk('Y', 'admin');
  const outsiderId = await mk('Outsider', 'admin', otherStore!.id);
  const [drawer] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const x = actor(orgId, xId);
  const customer = await asOrg(orgId, (tx) => createCustomer(tx, x, { name: `Resto ${code}` }));
  return { orgId, storeId, x, y: actor(orgId, yId), outsider: actor(orgId, outsiderId), customerId: customer.id, drawerId: drawer!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function charge(f: Fixture, amount = '1000.00', date = '2027-02-03') {
  return asOrg(f.orgId, (tx) =>
    recordCharge(tx, f.x, { storeId: f.storeId, customerId: f.customerId, chargeDate: date, dueDate: null, totalAmount: amount, revenueAccountCode: '4150' }),
  );
}
async function collection(f: Fixture, chargeId: string) {
  return asOrg(f.orgId, (tx) =>
    recordCollection(tx, f.x, { storeId: f.storeId, customerId: f.customerId, collectionDate: '2027-02-04', amount: '500.00', moneyAccountId: f.drawerId, allocations: [{ chargeId, amountApplied: '500.00' }] }),
  );
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
type Refusal = Error & { userMessage?: string };

async function rejection(p: Promise<unknown>): Promise<Refusal> {
  return p.then(
    () => {
      throw new Error('expected a refusal, but the call resolved');
    },
    (e: unknown) => e as Refusal,
  );
}

/** (a) and (b) must be indistinguishable to the caller, and must not echo either id. */
function expectUniform(errReal: Refusal, errFake: Refusal, fakeId: string, realId: string) {
  expect(errReal.userMessage, `real refusal has no userMessage: ${errReal.message}`).toBeTruthy();
  expect(errFake.userMessage, `nonexistent-id refusal has no userMessage: ${errFake.message}`).toBeTruthy();
  expect(errFake.userMessage, `not-found vs not-yours differ:
  real: ${errReal.userMessage}
  fake: ${errFake.userMessage}`).toBe(errReal.userMessage);
  for (const e of [errReal, errFake]) {
    expect(e.userMessage ?? '').not.toMatch(UUID_RE);
    expect(e.userMessage ?? '').not.toContain(fakeId);
    expect(e.userMessage ?? '').not.toContain(realId);
  }
}

describe('DEF-546 voidCharge', () => {
  it('(a)/(b) ONE actor (outsider): fake id vs real charge refuse identically; insider + fake id gets the same sentence', async () => {
    const f = await fixture('vc');
    const c = await charge(f);
    const fakeId = randomUUID();
    const errReal = await rejection(asOrg(f.orgId, (tx) => voidCharge(tx, f.outsider, { chargeId: c.chargeId, reason: 'nope' })));
    const errFake = await rejection(asOrg(f.orgId, (tx) => voidCharge(tx, f.outsider, { chargeId: fakeId, reason: 'nope' })));
    expectUniform(errReal, errFake, fakeId, c.chargeId);
    const errInsider = await rejection(asOrg(f.orgId, (tx) => voidCharge(tx, f.y, { chargeId: randomUUID(), reason: 'nope' })));
    expect(errInsider.userMessage, `insider+fake: ${errInsider.message}`).toBe(errReal.userMessage);
  });
  it('(c) positive control: in-scope admin voids the real charge', async () => {
    const f = await fixture('vc-pc');
    const c = await charge(f);
    await expect(asOrg(f.orgId, (tx) => voidCharge(tx, f.y, { chargeId: c.chargeId, reason: 'wrong customer' }))).resolves.toBeDefined();
  });
  it('survival: an already-voided charge voided again by an in-scope admin reads as itself, not the uniform sentence', async () => {
    const f = await fixture('vc-surv');
    const c = await charge(f);
    await asOrg(f.orgId, (tx) => voidCharge(tx, f.y, { chargeId: c.chargeId, reason: 'first' }));
    const uniform = (await rejection(asOrg(f.orgId, (tx) => voidCharge(tx, f.outsider, { chargeId: c.chargeId, reason: 'x' })))).userMessage;
    const err = await rejection(asOrg(f.orgId, (tx) => voidCharge(tx, f.y, { chargeId: c.chargeId, reason: 'second' })));
    expect(err.message).toMatch(/is voided, not posted/);
    expect(err.userMessage).not.toBe(uniform);
  });
});

describe('DEF-546 voidCollection', () => {
  it('(a)/(b) ONE actor (outsider): fake id vs real collection refuse identically; insider + fake id gets the same sentence', async () => {
    const f = await fixture('vcol');
    const c = await charge(f);
    const col = await collection(f, c.chargeId);
    const fakeId = randomUUID();
    const errReal = await rejection(asOrg(f.orgId, (tx) => voidCollection(tx, f.outsider, { collectionId: col.collectionId, reason: 'nope' })));
    const errFake = await rejection(asOrg(f.orgId, (tx) => voidCollection(tx, f.outsider, { collectionId: fakeId, reason: 'nope' })));
    expectUniform(errReal, errFake, fakeId, col.collectionId);
    const errInsider = await rejection(asOrg(f.orgId, (tx) => voidCollection(tx, f.y, { collectionId: randomUUID(), reason: 'nope' })));
    expect(errInsider.userMessage, `insider+fake: ${errInsider.message}`).toBe(errReal.userMessage);
  });
  it('(c) positive control: in-scope admin voids the real collection', async () => {
    const f = await fixture('vcol-pc');
    const c = await charge(f);
    const col = await collection(f, c.chargeId);
    await expect(asOrg(f.orgId, (tx) => voidCollection(tx, f.y, { collectionId: col.collectionId, reason: 'bounced' }))).resolves.toBeDefined();
  });
  it('survival: an already-voided collection voided again by an in-scope admin reads as itself, not the uniform sentence', async () => {
    const f = await fixture('vcol-surv');
    const c = await charge(f);
    const col = await collection(f, c.chargeId);
    await asOrg(f.orgId, (tx) => voidCollection(tx, f.y, { collectionId: col.collectionId, reason: 'first' }));
    const uniform = (await rejection(asOrg(f.orgId, (tx) => voidCollection(tx, f.outsider, { collectionId: col.collectionId, reason: 'x' })))).userMessage;
    const err = await rejection(asOrg(f.orgId, (tx) => voidCollection(tx, f.y, { collectionId: col.collectionId, reason: 'second' })));
    expect(err.message).toMatch(/is voided, not posted/);
    expect(err.userMessage).not.toBe(uniform);
  });
});

// Guards, not oracle proofs (orchestrator ruling): authorize runs first here, and customers are org-wide, so a capability holder learning a customer id exists is not an oracle.
describe('DEF-546 recordCharge customer lookup', () => {
  const input = (f: Fixture, customerId: string) => ({ storeId: f.storeId, customerId, chargeDate: '2027-02-03', dueDate: null, totalAmount: '100.00', revenueAccountCode: '4150' });
  it('(a)/(b) OUTSIDER: nonexistent customer vs real customer refuse identically, no id leak', async () => {
    const f = await fixture('rc');
    const fakeId = randomUUID();
    const errReal = await rejection(asOrg(f.orgId, (tx) => recordCharge(tx, f.outsider, input(f, f.customerId))));
    const errFake = await rejection(asOrg(f.orgId, (tx) => recordCharge(tx, f.outsider, input(f, fakeId))));
    expectUniform(errReal, errFake, fakeId, f.customerId);
  });
  it('(c) positive control: in-scope admin charges the real customer', async () => {
    const f = await fixture('rc-pc');
    await expect(asOrg(f.orgId, (tx) => recordCharge(tx, f.y, input(f, f.customerId)))).resolves.toBeDefined();
  });
});

describe('DEF-546 recordCollection customer lookup', () => {
  it('(a)/(b) OUTSIDER: nonexistent customer vs real customer refuse identically, no id leak', async () => {
    const f = await fixture('rcol');
    const c = await charge(f);
    const fakeId = randomUUID();
    const base = { storeId: f.storeId, collectionDate: '2027-02-04', amount: '500.00', moneyAccountId: f.drawerId, allocations: [{ chargeId: c.chargeId, amountApplied: '500.00' }] };
    const errReal = await rejection(asOrg(f.orgId, (tx) => recordCollection(tx, f.outsider, { ...base, customerId: f.customerId })));
    const errFake = await rejection(asOrg(f.orgId, (tx) => recordCollection(tx, f.outsider, { ...base, customerId: fakeId })));
    expectUniform(errReal, errFake, fakeId, f.customerId);
  });
  it('(c) positive control: in-scope admin collects from the real customer', async () => {
    const f = await fixture('rcol-pc');
    const c = await charge(f);
    await expect(collection(f, c.chargeId)).resolves.toBeDefined();
  });
});
