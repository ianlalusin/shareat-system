import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Proves invariants 18-19 of docs/tasks/107-legacy-leg-adapter.md against a real
 * PostgreSQL (PROJECT_BIBLE.md §9 rule 3) — never a mock. Invariants 1-17 (pure
 * translation, classification, the disagreement check, money) live in
 * packages/domain/tests/legacy-adapter.test.ts and take no database at all.
 *
 * This file proves the one thing a unit test cannot: that `adaptLegacyLegs`'s output is
 * not just shaped correctly but actually POSTS through the real `postEntry` — and,
 * critically (invariant 19), that a single-leg legacy group is adapted fine (ok:true,
 * one line) and then rejected at COMMIT by the database's own minimum-two-lines
 * constraint, because `adaptLegacyLegs` deliberately does not pre-empt that judgement
 * (Contract §5 — "it does not decide whether the entry balances"). This is v1's defining
 * defect (§1.1 — single-leg entries were "trivially balanced" by definition) meeting
 * v2's constraint, demonstrated rather than merely asserted.
 *
 * Lives under packages/domain/tests/integration/ (Scope + landmine #6, same reasoning as
 * post-entry.test.ts's header comment): CI runs the "unit" vitest project BEFORE
 * migrations, so a DB-touching test outside a tests/integration/ directory fails on a
 * fresh database.
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

// Cross-package relative import, same pattern as packages/domain/tests/integration/post-entry.test.ts:
// @shareat/db has no "./seed" export — the seed helper is a separate concern from "the repo".
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb } from '@shareat/db';
import { postEntry } from '@shareat/domain';
import { adaptLegacyLegs, type LegacyLeg, type ResolvedAccount } from '../../src/ledger/legacy-adapter';

const sql = postgres(url, { max: 5 });

// ---------------------------------------------------------------------------------------
// Helpers — org/period fixtures, mirroring post-entry.test.ts exactly so this file needs
// no new fixture pattern.
// ---------------------------------------------------------------------------------------

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`legacy-adapter-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
}

async function insertPeriod(
  orgId: string,
  startsOn: string,
  endsOn: string,
  status: 'open' | 'closed' | 'locked' = 'open',
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${startsOn}, ${endsOn}, ${status})
    returning id
  `;
  return row!.id;
}

/** One org, seeded chart of accounts, and one open period covering January 2026. */
async function baseFixture(hint: string): Promise<{ orgId: string; periodId: string }> {
  const orgId = await insertOrg(hint);
  await seedChartOfAccounts(sql, orgId);
  const periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'open');
  return { orgId, periodId };
}

/**
 * Builds a synchronous resolver, real T-102 seeded rows behind it, for a small map of
 * `legacyAccountId -> v2 code`. `adaptLegacyLegs`'s resolver is synchronous by contract
 * (Contract §1), so the accounts it needs are fetched up front, once, and handed back
 * from an in-memory Map — this is exactly the shape T-113's real ETL resolver will have
 * (a pre-loaded mapping table, not a query per leg).
 */
async function buildResolver(
  orgId: string,
  legacyToCode: Record<string, string>,
): Promise<(accountId: string) => ResolvedAccount | null> {
  const codes = Object.values(legacyToCode);
  const rows = await sql<{ code: string; normal_balance: 'debit' | 'credit'; is_postable: boolean; status: 'active' | 'reserved' | 'archived' }[]>`
    select code, normal_balance, is_postable, status from accounts where org_id = ${orgId} and code = any(${codes})
  `;
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const resolved = new Map<string, ResolvedAccount>();
  for (const [legacyId, code] of Object.entries(legacyToCode)) {
    const row = byCode.get(code);
    if (!row) continue; // left unresolvable on purpose if a test wants that
    resolved.set(legacyId, {
      code: row.code,
      normalBalance: row.normal_balance,
      isPostable: row.is_postable,
      status: row.status,
    });
  }
  return (accountId: string) => resolved.get(accountId) ?? null;
}

async function countEntries(sourceType: string, sourceId: string): Promise<number> {
  const rows = await sql`select id from journal_entries where source_type = ${sourceType} and source_id = ${sourceId}`;
  return rows.length;
}

async function resetTables() {
  await sql`
    truncate table
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
}

beforeEach(async () => {
  await resetTables();
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================
// Invariant 18 — a balanced two-leg legacy group adapts and posts successfully.
// =========================================================================================

describe('invariant 18 — a balanced two-leg legacy group adapts and posts via postEntry', () => {
  it('an expense recognition (cash decreasing, expense increasing) posts as status=posted', async () => {
    const { orgId } = await baseFixture('inv18');
    const resolve = await buildResolver(orgId, {
      cash__cashier: '1110',
      expense__misc: '6900',
    });

    const legs: LegacyLeg[] = [
      // Cash decreasing — v1 'out' on a debit-normal account -> v2 credit.
      { accountId: 'cash__cashier', direction: 'out', amount: 100, legKey: 'cash' },
      // Expense increasing — v1 'in' on a debit-normal account -> v2 debit.
      { accountId: 'expense__misc', direction: 'in', amount: 100, legKey: 'expense' },
    ];

    const adapted = adaptLegacyLegs(legs, resolve);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new Error('expected ok:true');
    expect(adapted.lines).toHaveLength(2);

    const sourceId = uid('inv18');
    const result = await postEntry(null, {
      orgId,
      entryDate: '2026-01-15',
      sourceType: 'legacy-migration',
      sourceId,
      idempotencyKey: uid('inv18-key'),
      lines: adapted.lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit })),
    });

    expect(result.created).toBe(true);
    const [row] = await sql<{ status: string }[]>`select status from journal_entries where id = ${result.entryId}`;
    expect(row!.status).toBe('posted');
    const lineRows = await sql`select debit, credit from journal_lines where entry_id = ${result.entryId}`;
    expect(lineRows).toHaveLength(2);
  });
});

// =========================================================================================
// Invariant 19 — a single-leg legacy group adapts fine and is THEN rejected at COMMIT.
// =========================================================================================

describe('invariant 19 — a single-leg legacy group adapts to one line, then is rejected at COMMIT', () => {
  it('adaptLegacyLegs returns ok:true with exactly one line; postEntry then rejects it, leaving no orphan entry', async () => {
    const { orgId } = await baseFixture('inv19');
    const resolve = await buildResolver(orgId, { cash__cashier: '1110' });

    const legs: LegacyLeg[] = [{ accountId: 'cash__cashier', direction: 'in', amount: 50, legKey: 'solo' }];

    // The adapter itself does NOT know or care that this can never balance — Contract §5.
    const adapted = adaptLegacyLegs(legs, resolve);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new Error('expected ok:true — the adapter must not pre-empt the balance judgement');
    expect(adapted.lines).toHaveLength(1);
    expect(adapted.lines[0]!.debit).toBe('50.00');

    const sourceId = uid('inv19');
    await expect(
      postEntry(null, {
        orgId,
        entryDate: '2026-01-15',
        sourceType: 'legacy-migration',
        sourceId,
        idempotencyKey: uid('inv19-key'),
        lines: adapted.lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit })),
      }),
    ).rejects.toThrow();

    // The database's own constraint did the rejecting at COMMIT, not the adapter — and
    // the failed transaction left nothing behind (same DEF-031-adjacent discipline as
    // post-entry.test.ts's invariant 4).
    expect(await countEntries('legacy-migration', sourceId)).toBe(0);
  });
});
