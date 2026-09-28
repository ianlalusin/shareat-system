/**
 * T-350 S4 / DEF-486 (G6) — `docs/tasks/350-def-477-change-channel-payout-account.md` §S4.
 *
 * `createOwner`'s `ownershipPercentage` check (`packages/domain/src/owners/index.ts:99`) is
 * `/^\d{1,3}(\.\d{1,3})?$/` — a DIGIT-COUNT cap, not a value cap. `"0050"` is four digits before the
 * decimal point, so the regex refuses it even though the number it spells, 50, is well inside
 * (0, 100]. The last DEF-481-shaped digit-run cap: the same class of bug as the earlier finiteness
 * ones, just in a different field.
 *
 * ⛔ TESTER, not BUILDER. No source edit here.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createOwner } from '@shareat/domain';

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

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t350s4own-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  const [owner1] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Owner One') returning id`;
  return { orgId, storeId, admin: actor(orgId, admin!.id), ownerPersonId: owner1!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function ownerCount(orgId: string, storeId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from owners where org_id = ${orgId} and store_id = ${storeId}`;
  return Number(row!.n);
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('G6 (DEF-486) — "0050" is a leading-zero 50, not a 4-digit overrun, and must be accepted', () => {
  it(
    'wanted: createOwner accepts "0050" and stores 50 — was red today: /^\\d{1,3}(\\.\\d{1,3})?$/ ' +
      'refuses any 4-digit run before the decimal point, so "0050" is refused though 50 is in range',
    async () => {
      const f = await fixture('g6-leading-zero');
      const { id } = await asOrg(f.orgId, (tx) =>
        createOwner(tx, f.admin, {
          storeId: f.storeId,
          personId: f.ownerPersonId,
          ownershipPercentage: '0050',
        }),
      );
      const [row] = await sql<{ ownership_percentage: string | null }[]>`
        select ownership_percentage from owners where id = ${id}`;
      expect(row, 'expected the owner row to exist').toBeTruthy();
      expect(
        Number(row!.ownership_percentage),
        `wanted the stored value to equal 50 — got ${row!.ownership_percentage}`,
      ).toBe(50);
    },
  );
});

describe('G6 — "101" is refused, with a sentence stating the ceiling (⚠️ may already be green: report, do not force)', () => {
  it('refused, no owner row written', async () => {
    const f = await fixture('g6-101');
    let caught: (Error & { userMessage?: string }) | undefined;
    try {
      await asOrg(f.orgId, (tx) =>
        createOwner(tx, f.admin, { storeId: f.storeId, personId: f.ownerPersonId, ownershipPercentage: '101' }),
      );
    } catch (err) {
      caught = err as Error & { userMessage?: string };
    }
    expect(caught, 'expected a refusal').toBeInstanceOf(Error);
    expect(caught?.userMessage, 'wanted the ceiling named in the sentence').toMatch(/up to 100/);
    expect(await ownerCount(f.orgId, f.storeId), 'nothing should be written on refusal').toBe(0);
  });
});

describe('G6 — "100.5" is refused, with a sentence stating the ceiling (⚠️ may already be green: report, do not force)', () => {
  it('refused, no owner row written', async () => {
    const f = await fixture('g6-100.5');
    let caught: (Error & { userMessage?: string }) | undefined;
    try {
      await asOrg(f.orgId, (tx) =>
        createOwner(tx, f.admin, { storeId: f.storeId, personId: f.ownerPersonId, ownershipPercentage: '100.5' }),
      );
    } catch (err) {
      caught = err as Error & { userMessage?: string };
    }
    expect(caught, 'expected a refusal').toBeInstanceOf(Error);
    expect(caught?.userMessage, 'wanted the ceiling named in the sentence').toMatch(/up to 100/);
    expect(await ownerCount(f.orgId, f.storeId), 'nothing should be written on refusal').toBe(0);
  });
});
