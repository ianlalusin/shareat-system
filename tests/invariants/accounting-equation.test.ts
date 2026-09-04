import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * T-111 — closes DEF-080 (the property-based suite was never written) and DEF-081 (the
 * directory it would live in matched no vitest include glob — see vitest.config.mts's own
 * comment for the routing fix).
 *
 * Phase 1's fixed fixtures (tests/integration/posting-patterns.test.ts) prove the cases someone
 * thought to write. Bible §16.0's entire diagnosis of v1 is that its "trivially balanced"
 * single-leg hole survived for years BECAUSE NOTHING CHECKED THE GENERAL CASE — so this suite
 * generates random valid transaction sets across accounts nobody wrote a fixture for, posts them
 * through the REAL `postEntry` against real Postgres, and asserts invariants 9 and 10 hold after
 * EVERY posted entry, not once at the end ("continuously" / "at any moment", bible §16.1).
 *
 * Invariant 9 is checked in its general form — Assets + Expenses = Liabilities + Equity + Income
 * — which is what Assets = Liabilities + Equity becomes once income/expense accounts (which feed
 * equity only at year-close) are in play mid-year. This is exactly what invariant 1 (every entry
 * balances) implies must hold for ANY balanced posting touching ANY accounts, by TYPE, using each
 * type's own fixed, conventional sign (asset/expense: debit − credit; liability/equity/income:
 * credit − debit) over each account's RAW debit/credit totals — deliberately never each account's
 * own `normalBalance`-signed `balance`, because three seeded accounts are contra accounts by
 * design (1590 accumulated depreciation is type=asset/normalBalance=credit; 4900/4950 sales
 * discounts and returns are type=income/normalBalance=debit) and mixing "grouped by type" with
 * "signed by each row's own normal_balance" breaks the equation for exactly those three accounts
 * — found live while writing this suite: its first version did that, and a two-line entry
 * touching 4900 failed an equation that was never actually wrong. Fixed by computing every type
 * bucket's contribution with ONE fixed formula, matching how `v_income_statement`'s own `type`
 * -based (not `normal_balance`-based) sign convention already treats income accounts.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import postgres from 'postgres';
import { add, allocate, equals, fromCentavos, subtract, type Money } from '@shareat/core/money';
import { closeDb, getDb } from '@shareat/db';
import { getTrialBalance, postEntry, type TrialBalanceLine } from '@shareat/domain';
import {
  CHART_OF_ACCOUNTS,
  REQUIRES_PARTY_CODES,
  RESERVED_CODES,
  seedChartOfAccounts,
} from '../../packages/db/seed/chart-of-accounts';

// A dedicated client for setup SQL — matching every other integration suite's own pattern
// (e.g. tests/integration/posting-patterns.test.ts) rather than the shared `getSql()` cache,
// which `sql.json()`'s parameter wrapper does not round-trip through cleanly.
const sql = postgres(url, { max: 5 });
const db = getDb();

/**
 * Every postable, non-reserved, party-free leaf account — ~76 of the seed's 96, spanning all
 * five types. Reserved codes are excluded because T-103's eligibility trigger refuses them as a
 * posting target by design; party-required (control) codes are excluded because supplying a
 * valid party is T-118's own contract, exercised elsewhere — neither exclusion narrows what this
 * suite is checking (the equation holds regardless of which postable accounts are touched).
 */
const RESERVED = new Set(RESERVED_CODES);
const REQUIRES_PARTY = new Set(REQUIRES_PARTY_CODES);
const ELIGIBLE_CODES: readonly string[] = CHART_OF_ACCOUNTS.filter(
  (a) => a.isPostable && !RESERVED.has(a.code) && !REQUIRES_PARTY.has(a.code),
).map((a) => a.code);

beforeAll(() => {
  expect(ELIGIBLE_CODES.length, 'the eligible pool must be large enough for meaningful random selection').toBeGreaterThan(
    20,
  );
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/**
 * A fresh, isolated org per fast-check run — never one shared org reused across runs.
 *
 * fast-check's shrinking re-invokes the property function directly with smaller inputs; it does
 * not (and cannot) undo the real Postgres side effects a previous, larger attempt already made.
 * A shared org across runs makes a shrunk "counterexample" describe only the LAST entry tried,
 * while the actual imbalance it reports came from whatever earlier entries in the same org's
 * history preceded it — a misleading report pointing at the wrong entry. One fresh org per run
 * makes every run, including every shrink attempt, independently reproducible from empty books.
 */
async function freshOrg(): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values ('T-111 property invariants', ${'t111-property-' + randomUUID()})
    returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2020-01-01', '2030-12-31', 'open')
  `;
  return orgId;
}

/**
 * Sum of one account-type bucket's RAW debit/credit totals, signed by that TYPE's own fixed
 * convention — never by any individual row's `normalBalance` (see file header: three seeded
 * accounts are contra accounts whose `normalBalance` deliberately disagrees with their type).
 */
function typeNet(lines: readonly TrialBalanceLine[], type: string, convention: 'debit-credit' | 'credit-debit'): Money {
  const matching = lines.filter((l) => l.accountType === type);
  const debitSum = add(...matching.map((l) => l.debit));
  const creditSum = add(...matching.map((l) => l.credit));
  return convention === 'debit-credit' ? subtract(debitSum, creditSum) : subtract(creditSum, debitSum);
}

const entryArb = fc.record({
  // ₱5.00–₱50,000.00, in centavos. The floor keeps every line's share (below) at least 1
  // centavo even at the maximum line count, so no line is ever generated with a zero amount —
  // journal_lines' own CHECK requires exactly one of debit/credit to be POPULATED, and a
  // zero-and-zero line would violate it before this suite ever got to assert anything.
  totalCentavos: fc.integer({ min: 500, max: 5_000_000 }),
  // 2–5 DISTINCT accounts drawn from the eligible pool. Split below into a debit group and a
  // credit group of at least one account each.
  accountCodes: fc.uniqueArray(fc.constantFrom(...ELIGIBLE_CODES), { minLength: 2, maxLength: 5 }),
  splitPoint: fc.integer({ min: 1, max: 4 }),
});

/** A "random valid transaction set" (docs/plans/phase-1-accounting-spine.md §F.3) — 1 to 4
 *  entries, posted in sequence into one fresh org. */
const transactionSetArb = fc.array(entryArb, { minLength: 1, maxLength: 4 });

describe('invariants 9 & 10 — the accounting equation and the trial balance, over random valid entries', () => {
  it(
    'hold after every entry in a randomly generated, real-Postgres-posted transaction set, not merely at the end',
    async () => {
      await fc.assert(
        fc.asyncProperty(transactionSetArb, async (entries) => {
          const orgId = await freshOrg();

          for (const { totalCentavos, accountCodes, splitPoint } of entries) {
            const debitCount = Math.max(1, Math.min(splitPoint, accountCodes.length - 1));
            const debitCodes = accountCodes.slice(0, debitCount);
            const creditCodes = accountCodes.slice(debitCount);

            const total = fromCentavos(BigInt(totalCentavos));
            const debitShares = allocate(total, debitCodes.length);
            const creditShares = allocate(total, creditCodes.length);

            const result = await postEntry(null, {
              orgId,
              entryDate: '2026-06-15',
              sourceType: 'test:invariant-property',
              sourceId: randomUUID(),
              idempotencyKey: randomUUID(),
              memo: 'T-111 property test',
              lines: [
                ...debitCodes.map((accountCode, i) => ({ accountCode, debit: debitShares[i] })),
                ...creditCodes.map((accountCode, i) => ({ accountCode, credit: creditShares[i] })),
              ],
            });
            expect(result.created, 'the real postEntry must accept every entry this generator builds').toBe(true);

            const tb = await getTrialBalance(db, {
              orgId,
              fromDate: '2020-01-01',
              toDate: '2030-12-31',
              includeYearClose: true,
            });

            // Invariant 10 — the trial balance ties, at this moment, over the corpus so far.
            expect(tb.ties, 'invariant 10: SUM(debit) must equal SUM(credit) after every posted entry').toBe(true);

            // Invariant 9 (extended) — Assets + Expenses = Liabilities + Equity + Income, at this
            // moment, over the corpus so far. See file header for the derivation and why this is
            // computed from RAW debit/credit totals per type, never per-row `balance`.
            const leftSide = add(
              typeNet(tb.lines, 'asset', 'debit-credit'),
              typeNet(tb.lines, 'expense', 'debit-credit'),
            );
            const rightSide = add(
              typeNet(tb.lines, 'liability', 'credit-debit'),
              typeNet(tb.lines, 'equity', 'credit-debit'),
              typeNet(tb.lines, 'income', 'credit-debit'),
            );
            expect(
              equals(leftSide, rightSide),
              `invariant 9: Assets+Expenses (${leftSide}) must equal Liabilities+Equity+Income (${rightSide})`,
            ).toBe(true);
          }
        }),
        { numRuns: 15 },
      );
    },
    120_000,
  );
});
