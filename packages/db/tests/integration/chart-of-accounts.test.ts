import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Proves the 10 invariants of docs/tasks/102-chart-of-accounts-seed.md against a real
 * PostgreSQL (PROJECT_BIBLE.md §9 rule 3) — never a mock.
 *
 * This file lives under packages/db/tests (task Scope), which vitest's "unit" project
 * picks up — there is no shared setupFiles guard here, so this file guards its own
 * connection the same way tests/integration/setup.ts does: it refuses to run against
 * anything whose name doesn't contain "_test".
 *
 * Written FIRST, before packages/db/seed/chart-of-accounts.ts exists, so the initial run
 * fails on "Cannot find module '../../seed/chart-of-accounts'" — the right reason: there is
 * nothing to seed yet. See the task report for the actual first-run output.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import {
  CHART_OF_ACCOUNTS,
  RESERVED_CODES,
  seedChartOfAccounts,
} from '../../seed/chart-of-accounts';

const sql = postgres(url, { max: 2 });

let orgSeq = 0;
async function insertOrg(hint: string): Promise<string> {
  const code = `coa-${hint}-${++orgSeq}`;
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
}

type AccountRow = {
  id: string;
  code: string;
  name: string;
  type: string;
  normal_balance: string;
  parent_id: string | null;
  is_postable: boolean;
  is_system: boolean;
  legacy_code: string | null;
  status: string;
};

async function fetchAccounts(orgId: string): Promise<AccountRow[]> {
  return sql<AccountRow[]>`select * from accounts where org_id = ${orgId} order by code`;
}

beforeAll(async () => {
  // Sanity: exactly one row per code in the seed data itself — a duplicate here would
  // make every invariant below meaningless.
  const codes = CHART_OF_ACCOUNTS.map((a) => a.code);
  expect(new Set(codes).size).toBe(codes.length);

  // This file lives in the "unit" vitest project, which (unlike "integration") has no
  // shared beforeEach truncation — and TEST_DATABASE_URL is a real, persistent database
  // between runs, not reset per invocation. Start from a clean slate so re-running this
  // file (or running it after tests/integration) never collides on organizations.code.
  await sql`truncate table accounts, organizations restart identity cascade`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('invariant 1 — every seeded account has an explicit normal_balance', () => {
  it('is never null or empty in the seed data', () => {
    for (const a of CHART_OF_ACCOUNTS) {
      expect(a.normalBalance === 'debit' || a.normalBalance === 'credit').toBe(true);
    }
  });

  it('is never null in the database after seeding', async () => {
    const orgId = await insertOrg('inv1');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.normal_balance === 'debit' || r.normal_balance === 'credit').toBe(true);
    }
  });
});

describe('invariant 2 — 1590 accumulated depreciation is the contra-asset exception', () => {
  it('is type=asset with normal_balance=credit', async () => {
    const orgId = await insertOrg('inv2');
    await seedChartOfAccounts(sql, orgId);
    const [row] = await sql<AccountRow[]>`
      select * from accounts where org_id = ${orgId} and code = '1590'
    `;
    expect(row).toBeDefined();
    expect(row!.type).toBe('asset');
    expect(row!.normal_balance).toBe('credit');
  });
});

describe('invariant 3 — the four contra-revenue accounts are type=income, normal_balance=debit', () => {
  it.each(['4900', '4910', '4920', '4950'])('code %s is income/debit', async (code) => {
    const orgId = await insertOrg(`inv3-${code}`);
    await seedChartOfAccounts(sql, orgId);
    const [row] = await sql<AccountRow[]>`
      select * from accounts where org_id = ${orgId} and code = ${code}
    `;
    expect(row).toBeDefined();
    expect(row!.type).toBe('income');
    expect(row!.normal_balance).toBe('debit');
  });
});

describe("invariant 4 — every non-header account's parent is the header for its range, and every header is non-postable", () => {
  it('resolves every leaf parent_id to the correct 1000s-range header, and headers have no parent', async () => {
    const orgId = await insertOrg('inv4');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const headers = rows.filter((r) => /^[1-7]000$/.test(r.code));
    expect(headers.length).toBe(7);
    for (const h of headers) {
      expect(h.parent_id).toBeNull();
      expect(h.is_postable).toBe(false);
    }

    const leaves = rows.filter((r) => !/^[1-7]000$/.test(r.code));
    expect(leaves.length).toBeGreaterThan(0);
    for (const l of leaves) {
      expect(l.parent_id).not.toBeNull();
      const parent = byId.get(l.parent_id!);
      expect(parent).toBeDefined();
      expect(parent!.is_postable).toBe(false);
      // parent's leading digit must match this account's leading digit
      expect(parent!.code[0]).toBe(l.code[0]);
    }
  });
});

describe('invariant 5 — no is_postable=true account is any other account’s parent', () => {
  it('every parent_id referenced by a leaf points at a non-postable account', async () => {
    const orgId = await insertOrg('inv5');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    const parentIds = new Set(rows.map((r) => r.parent_id).filter((x): x is string => x !== null));
    for (const pid of parentIds) {
      const parent = rows.find((r) => r.id === pid);
      expect(parent).toBeDefined();
      expect(parent!.is_postable).toBe(false);
    }
  });

  it('the seed itself never trips the accounts_postable_no_children trigger', async () => {
    // If it did, seedChartOfAccounts would have thrown already in earlier tests. This
    // test exists so the invariant has its own named assertion per the task's method.
    const orgId = await insertOrg('inv5b');
    await expect(seedChartOfAccounts(sql, orgId)).resolves.toBeDefined();
  });
});

describe('invariant 6 — re-running the seed inserts nothing and changes nothing', () => {
  it('the second call inserts zero rows', async () => {
    const orgId = await insertOrg('inv6');
    const first = await seedChartOfAccounts(sql, orgId);
    expect(first.headersInserted + first.leavesInserted).toBe(CHART_OF_ACCOUNTS.length);

    const second = await seedChartOfAccounts(sql, orgId);
    expect(second.headersInserted).toBe(0);
    expect(second.leavesInserted).toBe(0);
  });

  it('no row is modified by the second call', async () => {
    const orgId = await insertOrg('inv6b');
    await seedChartOfAccounts(sql, orgId);
    const before = await fetchAccounts(orgId);

    await seedChartOfAccounts(sql, orgId);
    const after = await fetchAccounts(orgId);

    expect(after).toEqual(before); // includes id, created_at, everything — truly untouched
  });
});

describe('invariant 7 — legacy_code is unique and never contains a per-entity template', () => {
  it('no legacy_code in the seed data contains { or }', () => {
    for (const a of CHART_OF_ACCOUNTS) {
      if (a.legacyCode) {
        expect(a.legacyCode).not.toMatch(/[{}]/);
      }
    }
  });

  it('legacy_code values are unique within the seed data', () => {
    const codes = CHART_OF_ACCOUNTS.map((a) => a.legacyCode).filter((x): x is string => x !== null);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('the database rejects a second org... no — rejects a duplicate legacy_code within one org', async () => {
    const orgId = await insertOrg('inv7');
    await seedChartOfAccounts(sql, orgId);
    await expect(
      sql`
        insert into accounts (org_id, code, name, type, normal_balance, legacy_code)
        values (${orgId}, '9999', 'Duplicate legacy code', 'asset', 'debit', 'cash__cashier')
      `,
    ).rejects.toThrow();
  });
});

describe('invariant 8 — reserved accounts are exactly {2145, 2250, 4920}; every other account is active', () => {
  it('RESERVED_CODES matches the amended Contract §4 list exactly', () => {
    expect(new Set(RESERVED_CODES)).toEqual(new Set(['2145', '2250', '4920']));
  });

  it('the database reflects reserved vs active correctly after seeding', async () => {
    const orgId = await insertOrg('inv8');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);

    const reserved = rows.filter((r) => r.status === 'reserved').map((r) => r.code);
    expect(new Set(reserved)).toEqual(new Set(['2145', '2250', '4920']));

    const others = rows.filter((r) => !reserved.includes(r.code));
    for (const r of others) {
      expect(r.status).toBe('active');
    }
  });
});

describe('invariant 9 — codes are unique per org, and the same code seeds independently into a second org', () => {
  it('rejects a raw duplicate code within one org', async () => {
    const orgId = await insertOrg('inv9dup');
    await seedChartOfAccounts(sql, orgId);
    await expect(
      sql`
        insert into accounts (org_id, code, name, type, normal_balance)
        values (${orgId}, '1110', 'Duplicate', 'asset', 'debit')
      `,
    ).rejects.toThrow();
  });

  it('seeds the full chart into two different orgs independently', async () => {
    const orgA = await insertOrg('inv9a');
    const orgB = await insertOrg('inv9b');

    const resultA = await seedChartOfAccounts(sql, orgA);
    const resultB = await seedChartOfAccounts(sql, orgB);

    expect(resultA.headersInserted + resultA.leavesInserted).toBe(CHART_OF_ACCOUNTS.length);
    expect(resultB.headersInserted + resultB.leavesInserted).toBe(CHART_OF_ACCOUNTS.length);

    const rowsA = await fetchAccounts(orgA);
    const rowsB = await fetchAccounts(orgB);
    expect(rowsA.length).toBe(CHART_OF_ACCOUNTS.length);
    expect(rowsB.length).toBe(CHART_OF_ACCOUNTS.length);
    // Every account id is distinct across orgs even though codes repeat
    const idsA = new Set(rowsA.map((r) => r.id));
    const idsB = new Set(rowsB.map((r) => r.id));
    for (const id of idsB) expect(idsA.has(id)).toBe(false);
  });
});

describe('invariant 10 — account count matches the (amended) COA-ALIGNMENT list exactly', () => {
  it('the seed data has exactly 75 accounts — 7 headers + 68 leaves', () => {
    // See task report for the reasoning behind 75 rather than a literal reading of the
    // summary tables (77): 1520/1530 (Property and equipment sub-range) are deliberately
    // not seeded as rows — a documented, reported deviation, not a silent one.
    expect(CHART_OF_ACCOUNTS.length).toBe(75);
    const headers = CHART_OF_ACCOUNTS.filter((a) => a.parentCode === null);
    expect(headers.length).toBe(7);
    expect(CHART_OF_ACCOUNTS.length - headers.length).toBe(68);
  });

  it('every account actually lands in the database for a freshly seeded org', async () => {
    const orgId = await insertOrg('inv10');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    expect(rows.length).toBe(75);
  });

  it('4200 is not seeded — REVENUE AMENDMENT, take-out folded into 4150', async () => {
    const orgId = await insertOrg('inv10b');
    await seedChartOfAccounts(sql, orgId);
    const [row] = await sql<AccountRow[]>`select * from accounts where org_id = ${orgId} and code = '4200'`;
    expect(row).toBeUndefined();
  });

  it('4150 is active, not reserved — REVENUE AMENDMENT', async () => {
    const orgId = await insertOrg('inv10c');
    await seedChartOfAccounts(sql, orgId);
    const [row] = await sql<AccountRow[]>`select * from accounts where org_id = ${orgId} and code = '4150'`;
    expect(row).toBeDefined();
    expect(row!.status).toBe('active');
  });
});

describe('every seeded row is is_system = true (bible §4.4 rule 2)', () => {
  it('holds for the whole seeded set', async () => {
    const orgId = await insertOrg('is-system');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    for (const r of rows) {
      expect(r.is_system).toBe(true);
    }
  });
});

describe("invariant 3b — owner's drawings is contra-equity", () => {
  // The sixth account that breaks derive-normal_balance-from-type. Drawings REDUCE
  // equity, so type='equity' but normal_balance='debit'. The T-102 spec claimed six
  // exceptions and listed five; this is the missing one. Corrected by migration 0002.
  it("3200 is type=equity with normal_balance=debit", () => {
    const drawings = CHART_OF_ACCOUNTS.find((a) => a.code === '3200');
    expect(drawings).toBeDefined();
    expect(drawings!.type).toBe('equity');
    expect(drawings!.normalBalance).toBe('debit');
  });

  it('all six derive-breaking accounts are explicit', () => {
    const breakers = ['1590', '3200', '4900', '4910', '4920', '4950'];
    for (const code of breakers) {
      const a = CHART_OF_ACCOUNTS.find((x) => x.code === code);
      expect(a, `account ${code} missing`).toBeDefined();
      const derived = a!.type === 'asset' || a!.type === 'expense' ? 'debit' : 'credit';
      expect(a!.normalBalance, `${code} must NOT match derive-from-type`).not.toBe(derived);
    }
  });
});
