import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Proves the 10 invariants of docs/tasks/102-chart-of-accounts-seed.md, PLUS (from the
 * "T-102b invariant N" describe blocks onward) the 7 invariants of
 * docs/tasks/102b-chart-of-accounts-completion.md, against a real PostgreSQL
 * (PROJECT_BIBLE.md §9 rule 3) — never a mock.
 *
 * This file lives under packages/db/tests (task Scope), which vitest's "unit" project
 * picks up — there is no shared setupFiles guard here, so this file guards its own
 * connection the same way tests/integration/setup.ts does: it refuses to run against
 * anything whose name doesn't contain "_test".
 *
 * Written FIRST, before packages/db/seed/chart-of-accounts.ts exists, so the initial run
 * fails on "Cannot find module '../../seed/chart-of-accounts'" — the right reason: there is
 * nothing to seed yet. See the task report for the actual first-run output.
 *
 * T-102b addendum: the "T-102b invariant 7" block below was run against the chart BEFORE
 * the 17 missing accounts were added, and it failed — that failure output is in the T-102b
 * task report. It is the proof the check would have caught DEF-035 in the first place.
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

// This file is packages/db/tests/integration/chart-of-accounts.test.ts — four levels
// below the repo root.
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const COA_ALIGNMENT_PATH = join(REPO_ROOT, 'docs', 'decisions', 'COA-ALIGNMENT.md');
const SEED_FILE_PATH = join(REPO_ROOT, 'packages', 'db', 'seed', 'chart-of-accounts.ts');

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
  it('the seed data has exactly 92 accounts — 7 headers + 85 leaves', () => {
    // Originally 75 (7 headers + 68 leaves) under T-102. See task report for the
    // reasoning behind 75 rather than a literal reading of the §2 summary tables (77):
    // 1520/1530 (Property and equipment sub-range) are deliberately not seeded as rows —
    // a documented, reported deviation, not a silent one.
    //
    // AMENDED by T-102b (closing DEF-035): +17 accounts COA-ALIGNMENT §4 names and §2
    // never did (5110-5170 COGS breakdown + 10 OPEX accounts) — 75 + 17 = 92. This is
    // the same count invariant 6 in the "T-102b invariant N" section below re-asserts
    // under its own name per that task's spec; kept here too so this pre-existing test
    // is forward-corrected rather than left silently wrong (bible §2 rule 8 precedent:
    // an applied migration is never edited, but a test asserting a now-superseded fact
    // is updated forward, the same way migration 0002 corrected 3200 forward).
    expect(CHART_OF_ACCOUNTS.length).toBe(92);
    const headers = CHART_OF_ACCOUNTS.filter((a) => a.parentCode === null);
    expect(headers.length).toBe(7);
    expect(CHART_OF_ACCOUNTS.length - headers.length).toBe(85);
  });

  it('every account actually lands in the database for a freshly seeded org', async () => {
    const orgId = await insertOrg('inv10');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    expect(rows.length).toBe(92); // amended by T-102b — see comment above
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

// =====================================================================================
// T-102b — docs/tasks/102b-chart-of-accounts-completion.md, closing DEF-035.
//
// T-102 seeded 75 accounts from COA-ALIGNMENT.md §2 (account GROUPS). §4 gives the
// expense-category -> account MAPPING and introduces a finer breakdown — 17 accounts §2
// never names (5110-5170 COGS detail, plus 10 OPEX accounts). §2's own summary rows for
// the 5xxx/6xxx ranges say "see §4" for exactly this detail, so T-102's chart could not
// express the categories T-113 needs to post expense entries against.
//
// The 7 invariants below are numbered per that task spec, independently of the
// "invariant N" numbering above (which is T-102's own 10, unrelated).
// =====================================================================================

/** The 17 accounts this task adds — Contract table, docs/tasks/102b-...md. */
const NEW_SEVENTEEN: ReadonlyArray<{ code: string; name: string; parentCode: string }> = [
  // Cost of sales 5xxx — COA-ALIGNMENT §4.1
  { code: '5110', name: 'COGS — meat', parentCode: '5000' },
  { code: '5120', name: 'COGS — sides', parentCode: '5000' },
  { code: '5130', name: 'COGS — condiments and seasoning', parentCode: '5000' },
  { code: '5140', name: 'COGS — sauces and dips', parentCode: '5000' },
  { code: '5150', name: 'COGS — packaging', parentCode: '5000' },
  { code: '5160', name: 'COGS — retail and consumables', parentCode: '5000' },
  { code: '5170', name: 'COGS — commissary transfers', parentCode: '5000' },
  // Operating expenses 6xxx — COA-ALIGNMENT §4.2
  { code: '6160', name: 'Employee benefits and welfare', parentCode: '6000' },
  { code: '6510', name: 'Smallwares', parentCode: '6000' },
  { code: '6620', name: 'Pest control and waste management', parentCode: '6000' },
  { code: '6630', name: 'Vehicle and transportation', parentCode: '6000' },
  { code: '6650', name: 'Marketing and advertising', parentCode: '6000' },
  { code: '6850', name: 'Administrative expenses', parentCode: '6000' },
  { code: '6860', name: 'Bad debt expense', parentCode: '6000' },
  { code: '6870', name: 'Bank charges', parentCode: '6000' },
  { code: '6880', name: 'Insurance', parentCode: '6000' },
  { code: '6890', name: 'Subscriptions and software', parentCode: '6000' },
];
const NEW_SEVENTEEN_CODES: readonly string[] = NEW_SEVENTEEN.map((a) => a.code);

describe('T-102b sanity — the 17-account fixture above matches the task Contract exactly', () => {
  it('is exactly 17 accounts, all present in the seed data', () => {
    expect(NEW_SEVENTEEN_CODES.length).toBe(17);
    for (const { code, name } of NEW_SEVENTEEN) {
      const a = CHART_OF_ACCOUNTS.find((x) => x.code === code);
      expect(a, `account ${code} (${name}) missing from CHART_OF_ACCOUNTS`).toBeDefined();
      expect(a!.name, `account ${code} name mismatch`).toBe(name);
    }
  });
});

describe('T-102b invariant 1 — all 17 exist with type=expense, normal_balance=debit', () => {
  it.each(NEW_SEVENTEEN_CODES)('%s is expense/debit in the seed data', (code) => {
    const a = CHART_OF_ACCOUNTS.find((x) => x.code === code);
    expect(a, `${code} missing`).toBeDefined();
    expect(a!.type).toBe('expense');
    expect(a!.normalBalance).toBe('debit');
  });

  it.each(NEW_SEVENTEEN_CODES)('%s is expense/debit in the database after seeding', async (code) => {
    const orgId = await insertOrg(`102b-inv1-${code}`);
    await seedChartOfAccounts(sql, orgId);
    const [row] = await sql<AccountRow[]>`
      select * from accounts where org_id = ${orgId} and code = ${code}
    `;
    expect(row, `${code} missing from database`).toBeDefined();
    expect(row!.type).toBe('expense');
    expect(row!.normal_balance).toBe('debit');
  });
});

describe('T-102b invariant 2 — each of the 17 is parented to the correct header (5xxx -> 5000, 6xxx -> 6000)', () => {
  it('the seed data assigns the correct parentCode', () => {
    for (const { code, parentCode } of NEW_SEVENTEEN) {
      const a = CHART_OF_ACCOUNTS.find((x) => x.code === code);
      expect(a, `${code} missing`).toBeDefined();
      expect(a!.parentCode, `${code} parentCode`).toBe(parentCode);
      expect(a!.parentCode, `${code} parentCode digit must match its own leading digit`).toBe(
        code[0] + '000',
      );
    }
  });

  it('the database resolves parent_id to the correct, non-postable header', async () => {
    const orgId = await insertOrg('102b-inv2');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const { code, parentCode } of NEW_SEVENTEEN) {
      const row = rows.find((r) => r.code === code);
      expect(row, `${code} missing from database`).toBeDefined();
      expect(row!.parent_id, `${code} has no parent_id`).not.toBeNull();
      const parent = byId.get(row!.parent_id!);
      expect(parent, `${code}'s parent row not found`).toBeDefined();
      expect(parent!.code, `${code}'s parent code`).toBe(parentCode);
      expect(parent!.is_postable, `${parentCode} must be non-postable to parent ${code}`).toBe(
        false,
      );
    }
  });

  it("the seed's own trigger-safety holds: seeding never trips accounts_postable_no_children", async () => {
    // If any of the 17 were wired to a POSTABLE parent (e.g. 5100 instead of 5000),
    // T-101's trigger would reject making that postable account a parent, and
    // seedChartOfAccounts would already have thrown in the tests above. Named per the
    // task's Method so this invariant has its own explicit assertion.
    const orgId = await insertOrg('102b-inv2b');
    await expect(seedChartOfAccounts(sql, orgId)).resolves.toBeDefined();
  });
});

describe('T-102b invariant 3 — none of the 17 has a legacy_code', () => {
  it('in the seed data', () => {
    for (const code of NEW_SEVENTEEN_CODES) {
      const a = CHART_OF_ACCOUNTS.find((x) => x.code === code);
      expect(a, `${code} missing`).toBeDefined();
      expect(a!.legacyCode, `${code} must have no legacyCode`).toBeNull();
    }
  });

  it('in the database after seeding', async () => {
    const orgId = await insertOrg('102b-inv3');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    for (const code of NEW_SEVENTEEN_CODES) {
      const row = rows.find((r) => r.code === code);
      expect(row, `${code} missing`).toBeDefined();
      expect(row!.legacy_code, `${code} must have no legacy_code`).toBeNull();
    }
  });
});

describe('T-102b invariant 4 — all 17 are status=active and is_system=true', () => {
  it('in the database after seeding', async () => {
    const orgId = await insertOrg('102b-inv4');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    for (const code of NEW_SEVENTEEN_CODES) {
      const row = rows.find((r) => r.code === code);
      expect(row, `${code} missing`).toBeDefined();
      expect(row!.status, `${code} status`).toBe('active');
      expect(row!.is_system, `${code} is_system`).toBe(true);
    }
  });
});

describe('T-102b invariant 5 — re-running the seed inserts nothing and changes nothing', () => {
  it('the second call inserts zero rows, and the row count for a fresh org is unchanged', async () => {
    const orgId = await insertOrg('102b-inv5');
    const first = await seedChartOfAccounts(sql, orgId);
    expect(first.headersInserted + first.leavesInserted).toBe(CHART_OF_ACCOUNTS.length);

    const second = await seedChartOfAccounts(sql, orgId);
    expect(second.headersInserted).toBe(0);
    expect(second.leavesInserted).toBe(0);

    const rows = await fetchAccounts(orgId);
    expect(rows.length).toBe(CHART_OF_ACCOUNTS.length);
  });

  it('no row — including any of the 17 — is modified by the second call', async () => {
    const orgId = await insertOrg('102b-inv5b');
    await seedChartOfAccounts(sql, orgId);
    const before = await fetchAccounts(orgId);

    await seedChartOfAccounts(sql, orgId);
    const after = await fetchAccounts(orgId);

    expect(after).toEqual(before); // includes id, created_at, everything — truly untouched

    for (const code of NEW_SEVENTEEN_CODES) {
      const b = before.find((r) => r.code === code)!;
      const a = after.find((r) => r.code === code)!;
      expect(a).toEqual(b);
    }
  });
});

describe('T-102b invariant 6 — total account count is 92 (T-102\'s 75 + these 17)', () => {
  it('the seed data has exactly 92 accounts', () => {
    expect(CHART_OF_ACCOUNTS.length).toBe(92);
    const headers = CHART_OF_ACCOUNTS.filter((a) => a.parentCode === null);
    expect(headers.length).toBe(7);
    expect(CHART_OF_ACCOUNTS.length - headers.length).toBe(85);
  });

  it('every account lands in the database for a freshly seeded org', async () => {
    const orgId = await insertOrg('102b-inv6');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    expect(rows.length).toBe(92);
  });
});

/**
 * Extracts every account code named anywhere in COA-ALIGNMENT.md §4, parsed from the
 * live document — NOT a hand-maintained list. A hand-maintained list is exactly the bug
 * that produced DEF-035 in the first place (T-102's spec pointed at §2 only; nobody
 * re-checked §4 against what got seeded).
 *
 * Restricted to two things, deliberately:
 *   1. Only markdown TABLE ROWS (lines starting with "|"). §4's mapping tables
 *      (§4.1, §4.2, §4.5, §4.7) are where a v1 category is actually mapped onto a v2
 *      account; that is the relationship this invariant exists to verify.
 *   2. Only a code STRICTLY bold-delimited as `**NNNN**` — four digits with the bold
 *      markers immediately on both sides, nothing else inside the span.
 *
 * Why (2) matters: §4.3's CAPEX paragraph contains "**1510–1530** Property and
 * equipment" — a single bold span describing a RANGE, not a table row, not two distinct
 * account codes. COA-ALIGNMENT §2 explicitly forbids inventing 1520/1530 ("Ian,
 * 2026-08-23: '1520 and 1530 don't need names, keep the gap.' Do NOT invent account
 * names to fill it... Seeding fabricated names here would be worse than an empty
 * range") — T-102 already made this call and 1520/1530 are deliberately absent from
 * CHART_OF_ACCOUNTS. A naive "every 4-digit substring in §4" parser would extract 1530
 * from that range phrase and wrongly demand an account COA-ALIGNMENT itself, elsewhere,
 * says must not exist. Restriction (1) alone (table rows) already excludes that phrase,
 * since it sits in prose under a heading, not a table cell; restriction (2) is a second,
 * independent guard against the same class of false positive, and also matches the
 * `**CODE** Name` format every real mapping table row in §4 actually uses.
 */
function parseSection4RequiredCodes(markdown: string): Set<string> {
  const lines = markdown.split(/\r?\n/);
  let inSection4 = false;
  const codes = new Set<string>();

  for (const line of lines) {
    if (/^## 4\. Expense categories/.test(line)) {
      inSection4 = true;
      continue;
    }
    if (inSection4 && /^## 5\./.test(line)) {
      break; // §4 ends where §5 begins
    }
    if (!inSection4) continue;
    if (!line.trim().startsWith('|')) continue; // only table rows

    for (const m of line.matchAll(/\*\*(\d{4})\*\*/g)) {
      if (m[1]) codes.add(m[1]);
    }
  }

  return codes;
}

describe('T-102b invariant 7 — every account code named anywhere in COA-ALIGNMENT §4 exists in the chart', () => {
  const markdown = readFileSync(COA_ALIGNMENT_PATH, 'utf8');
  const requiredCodes = parseSection4RequiredCodes(markdown);

  it('parser sanity — found COA-ALIGNMENT.md, parsed §4, and the parsed set includes every one of the 17 (otherwise this whole invariant is vacuous)', () => {
    expect(markdown.length).toBeGreaterThan(1000);
    expect(requiredCodes.size).toBeGreaterThanOrEqual(30);
    for (const code of NEW_SEVENTEEN_CODES) {
      expect(
        requiredCodes.has(code),
        `parser did not find ${code} in COA-ALIGNMENT §4 — parser is broken, not the chart`,
      ).toBe(true);
    }
  });

  it('parser sanity — does NOT require 1520 or 1530 (the intentional, documented number gap; COA-ALIGNMENT §2)', () => {
    expect(requiredCodes.has('1520')).toBe(false);
    expect(requiredCodes.has('1530')).toBe(false);
  });

  it('every parsed §4 account code exists in the freshly seeded chart', async () => {
    const orgId = await insertOrg('102b-inv7');
    await seedChartOfAccounts(sql, orgId);
    const rows = await fetchAccounts(orgId);
    const existingCodes = new Set(rows.map((r) => r.code));

    const missing = [...requiredCodes].filter((c) => !existingCodes.has(c)).sort();
    expect(
      missing,
      `COA-ALIGNMENT §4 names these account codes, but they do not exist in the seeded ` +
        `chart: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

describe('5170 carries the COA-ALIGNMENT §4.1 inter-store elimination warning ("Things that will bite" #5)', () => {
  it('the seed source documents, next to the 5170 definition, that commissary transfers are inter-store and must eliminate on consolidation or double-count', () => {
    const seedSource = readFileSync(SEED_FILE_PATH, 'utf8');
    const idx = seedSource.indexOf("'5170'");
    expect(idx, "leaf('5170', ...) not found in packages/db/seed/chart-of-accounts.ts").toBeGreaterThan(-1);

    // Look at the comment immediately preceding the leaf('5170', ...) call — a few
    // hundred characters back covers a multi-line // comment block without accidentally
    // picking up an unrelated account's commentary.
    const nearby = seedSource.slice(Math.max(0, idx - 900), idx + 50).toLowerCase();
    expect(nearby, '5170 comment must mention it is inter-store').toMatch(/inter-store/);
    expect(nearby, '5170 comment must mention elimination on consolidation').toMatch(/eliminat/);
    expect(nearby, '5170 comment must mention the double-counting risk').toMatch(
      /(double.count|counted twice|twice)/,
    );
  });
});
