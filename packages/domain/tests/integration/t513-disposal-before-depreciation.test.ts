import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-513 (audit CR-3): an asset cannot be disposed of on a date before its latest LIVE depreciation
 * entry. Real PostgreSQL (bible 9 rule 3). Fixture pattern copied from fixed-assets.test.ts.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, fixedAssetsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createAsset, depreciateAsset, disposeAsset, reverseEntry } from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

interface Fixture {
  orgId: string;
  storeId: string;
  adminId: string;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`t513-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')
    `;
  }
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id
  `;
  const storeId = store!.id;
  const [r] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${`${hint} Admin`}) returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${r!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${r!.id}, ${storeId})`;
  return { orgId, storeId, adminId: r!.id };
}

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

function actor(orgId: string, personId: string): Actor {
  return { personId, orgId };
}

/** Org-wide balance (credit - debit) of one account, over non-draft entries. */
async function balance(orgId: string, code: string): Promise<string> {
  const rows = await sql<{ total: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and a.code = ${code} and je.status <> 'draft'
  `;
  return rows[0]?.total ?? '0';
}

async function balances(orgId: string): Promise<string[]> {
  return [await balance(orgId, '1590'), await balance(orgId, '1510'), await balance(orgId, '7400')];
}

async function disposalEntryCount(orgId: string, assetId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries
    where org_id = ${orgId} and source_id = ${assetId} and source_type = 'asset_disposal'
  `;
  return rows[0]?.n ?? 0;
}

/** 120,000 over 24 months, no salvage: 5,000 a month. Acquired 15 Jan 2026. */
async function anAsset(f: Fixture): Promise<string> {
  const { id } = await asPerson(f.orgId, (tx) =>
    createAsset(tx, actor(f.orgId, f.adminId), {
      storeId: f.storeId,
      name: 'Chest freezer',
      category: 'appliances',
      acquiredOn: '2026-01-15',
      cost: '120000.00',
      usefulLifeMonths: 24,
    } as Parameters<typeof createAsset>[2]),
  );
  return id;
}

async function threeMonths(f: Fixture): Promise<string> {
  const assetId = await anAsset(f);
  await asPerson(f.orgId, (tx) =>
    depreciateAsset(tx, actor(f.orgId, f.adminId), { assetId, through: '2026-03' }),
  );
  return assetId;
}

const dispose = (f: Fixture, assetId: string, disposedOn: string) =>
  asPerson(f.orgId, (tx) =>
    disposeAsset(tx, actor(f.orgId, f.adminId), { assetId, disposedOn, reason: 'T-513 test' }),
  );

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-513 - disposal date vs posted depreciation', () => {
  it('(a) refuses disposal on 15 Feb when depreciation is posted through 31 Mar; nothing moves', async () => {
    const f = await setup('a');
    const assetId = await threeMonths(f);
    const before = await balances(f.orgId);

    await expect(dispose(f, assetId, '2026-02-15')).rejects.toThrow(
      /disposeAsset: disposal date 2026-02-15 is before depreciation already posted up to 2026-03-31\. Reverse the later depreciation first, or dispose on or after 2026-03-31\./,
    );

    const asset = await asPerson(f.orgId, (tx) => fixedAssetsRepo.getById(tx, f.orgId, assetId));
    expect(asset!.status).toBe('active');
    expect(await disposalEntryCount(f.orgId, assetId)).toBe(0);
    expect(await balances(f.orgId)).toEqual(before);
  });

  it('(b) allows disposal on the same day as the last depreciation entry (31 Mar)', async () => {
    const f = await setup('b');
    const assetId = await threeMonths(f);
    const r = await dispose(f, assetId, '2026-03-31');
    expect(r.accumulated).toBe('15000.00');
    expect(r.loss).toBe('105000.00');
  });

  it('(c) allows disposal on 15 Apr (positive control)', async () => {
    const f = await setup('c');
    const assetId = await threeMonths(f);
    const r = await dispose(f, assetId, '2026-04-15');
    expect(r.accumulated).toBe('15000.00');
    expect(r.loss).toBe('105000.00');
  });

  it('(d) after reversing March depreciation, disposal on 15 Mar is allowed and uses Jan+Feb only', async () => {
    const f = await setup('d');
    const assetId = await threeMonths(f);
    const [march] = await sql<{ id: string }[]>`
      select id from journal_entries
      where org_id = ${f.orgId} and source_type = 'depreciation' and source_id = ${assetId}
        and entry_date = '2026-03-31' and reversal_of_entry_id is null
    `;
    expect(march).toBeDefined();
    await asPerson(f.orgId, (tx) =>
      reverseEntry(tx, { entryId: march!.id, reason: 'T-513 test: void March', reversedBy: f.adminId }),
    );

    const r = await dispose(f, assetId, '2026-03-15');
    expect(r.accumulated).toBe('10000.00');
    expect(r.loss).toBe('110000.00');
  });

  it('(g) a reversal of a reversal makes the original live again: 15 Mar refused, 31 Mar allowed', async () => {
    const f = await setup('g');
    const assetId = await threeMonths(f);
    const [march] = await sql<{ id: string }[]>`
      select id from journal_entries
      where org_id = ${f.orgId} and source_type = 'depreciation' and source_id = ${assetId}
        and entry_date = '2026-03-31' and reversal_of_entry_id is null
    `;
    expect(march).toBeDefined();
    await asPerson(f.orgId, (tx) =>
      reverseEntry(tx, { entryId: march!.id, reason: 'T-513 test: void March', reversedBy: f.adminId }),
    );
    const [r1] = await sql<{ id: string }[]>`
      select id from journal_entries where org_id = ${f.orgId} and reversal_of_entry_id = ${march!.id}
    `;
    expect(r1).toBeDefined();
    await asPerson(f.orgId, (tx) =>
      reverseEntry(tx, { entryId: r1!.id, reason: 'T-513 test: void the void', reversedBy: f.adminId }),
    );

    await expect(dispose(f, assetId, '2026-03-15')).rejects.toThrow(
      /disposal date 2026-03-15 is before depreciation already posted up to 2026-03-31/,
    );
    expect(await disposalEntryCount(f.orgId, assetId)).toBe(0);

    const r = await dispose(f, assetId, '2026-03-31');
    expect(r.accumulated).toBe('15000.00');
    expect(r.loss).toBe('105000.00');
  });

  it('(e) an asset with no depreciation can still be disposed after acquisition', async () => {
    const f = await setup('e');
    const assetId = await anAsset(f);
    const r = await dispose(f, assetId, '2026-01-20');
    expect(r.accumulated).toBe('0.00');
    expect(r.loss).toBe('120000.00');
  });
});
