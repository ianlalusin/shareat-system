/**
 * T-398 S7e (TESTER) - O6: PG's POS store id is already linked by ANOTHER company -> refused "already linked", and the refusal never names
 * the other company (name, code or id), nor its store. docs/tasks/398-s7/S7-REFRESH.md s6 (POS link), s11 (O6).
 * Real Postgres via TEST_DATABASE_URL. Fixture shape copied from t375-s1-store-link.test.ts (one org, one store, one remitted channel, one admin).
 *
 * STATUS TODAY: GREEN-AS-GUARD. `linkStoreToPos` already refuses a second company (RLS hides the first link, so the unique index speaks:
 * store-link.ts catch -> 'That POS store is already linked to another store.'). t375-s1 L2 'GLOBAL uniqueness' pins the same. This leg restates it for
 * the franchise pair with the names S7 uses, plus the cases S7 adds: the second link attempted by the franchisee's own admin, and the failed attempt
 * leaving no row.
 *
 * ⚠️ WORDING: the refresh and the task brief say the message "says 'already linked elsewhere'". The code says "already linked to another store". This
 * test pins /already linked/i (both fit) and NOT the word "elsewhere"; if Ian wants that exact word, the builder changes store-link.ts:143 and this
 * regex together.
 *
 * MUTANTS: refusal text interpolating the other org (name / code / id) or its store; the refusal swallowed so the second company links the same POS
 * store (double-booked sales); a failed attempt leaving a half-written row.
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

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { linkStoreToPos } from '../../src/pos/store-link';

const sql = postgres(url, { max: 6 });
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

async function company(orgName: string, storeName: string) {
  const code = uid('S7EPOS').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${orgName}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${storeName}) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s!.id})`;
  const [c] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${orgId}, ${s!.id}, 'Walk-in', true, null) returning id`;
  const actor: Actor = { personId: p!.id, orgId };
  return { orgId, code, orgName, storeId: s!.id, storeName, channelId: c!.id, actor };
}
type Co = Awaited<ReturnType<typeof company>>;

const link = (c: Co, posStoreId: string) =>
  asOrg(c.orgId, (tx) =>
    linkStoreToPos(tx, c.actor, { storeId: c.storeId, posStoreId, posStoreName: 'Mock POS store', salesChannelId: c.channelId, posTaxType: 'vat_inclusive' }),
  );
const sentenceOf = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
const linkRows = (storeId: string) => sql<{ pos_store_id: string }[]>`select pos_store_id from pos_v1_store_links where store_id = ${storeId}`;

describe('O6 - a POS store id already linked by another company is refused, without naming that company', () => {
  it('second company refused "already linked"; no other-company name, code, id or store name in the words; no row written; the first link stands', async () => {
    const t = uid('x');
    const first = await company(`Mock Commissary Holdings ${t}`, `Secret Commissary Kitchen ${t}`);
    const second = await company(`Mock Padre Garcia Foods ${t}`, `Mock SharEat Padre Garcia ${t}`);
    const pos = uid('MOCK-POS-STORE');
    await link(first, pos);

    const err = await link(second, pos).then(() => null, (e) => e);
    expect(err, 'the second company must be refused').toBeInstanceOf(Error);
    const text = sentenceOf(err);
    expect(text).toMatch(/already linked/i);
    for (const secret of [first.orgName, first.code, first.orgId, first.storeName, first.storeId, `${t}`]) {
      expect(text, `the refusal leaked "${secret}"`).not.toContain(secret);
    }
    expect(await linkRows(second.storeId), 'a refused attempt must leave nothing behind').toHaveLength(0);
    expect(await linkRows(first.storeId)).toEqual([{ pos_store_id: pos }]);
  });

  it('the refusal is the same sentence whichever company holds the id (no oracle on which company it is)', async () => {
    const t = uid('y');
    const a = await company(`Mock Org A ${t}`, `Alpha ${t}`);
    const b = await company(`Mock Org B ${t}`, `Bravo ${t}`);
    const c = await company(`Mock Org C ${t}`, `Charlie ${t}`);
    const posA = uid('MOCK-POS-A');
    const posB = uid('MOCK-POS-B');
    await link(a, posA);
    await link(b, posB);
    const sa = sentenceOf(await link(c, posA).then(() => null, (e) => e));
    const sb = sentenceOf(await link(c, posB).then(() => null, (e) => e));
    expect(sa).toBe(sb);
  });

  it('control: the same company relinking its own store to the same POS id is not refused; a fresh POS id links the second company', async () => {
    const t = uid('z');
    const a = await company(`Mock Org A ${t}`, `Alpha ${t}`);
    const b = await company(`Mock Org B ${t}`, `Bravo ${t}`);
    const pos = uid('MOCK-POS-STORE');
    await link(a, pos);
    await expect(link(a, pos)).resolves.toBeDefined();
    await expect(link(b, uid('MOCK-POS-OTHER'))).resolves.toBeDefined();
    expect(await linkRows(a.storeId)).toHaveLength(1);
    expect(await linkRows(b.storeId)).toHaveLength(1);
  });
});
