/**
 * Expense categories — the seeded reference data. docs/tasks/122-expenses.md §4.
 *
 * Source of truth: `packages/etl/src/leg-mapping.ts`'s `OPEX_CATEGORY_ACCOUNTS` and
 * `COGS_CATEGORY_ACCOUNTS` — the "already-decided crosswalk" the spec says to seed from,
 * "not from v1's 132 free-text entries with their duplicates and inconsistent casing."
 * The values below are a COPY of those two maps, not an import: `@shareat/db` cannot
 * depend on `@shareat/etl` (etl depends on db AND on domain — the reverse would cycle,
 * ADR-004's reasoning one level over). `tests/unit/expense-categories-seed.test.ts`
 * cross-checks this file against the real leg-mapping.ts so the two can never silently
 * drift apart — the same drift-guard technique used for
 * packages/domain/src/expenses/routing.ts.
 *
 * PERSONAL and CAPEX are seeded here too, as single rows, each with its account_code
 * already resolved (3200 owner's drawings; 1510 property and equipment — bible rows 118 §13
 * / T-122 invariants 8-9). This is deliberate: the posting logic
 * (packages/domain/src/expenses/routing.ts) never special-cases a group by name — it only
 * ever debits whatever account_code the chosen category resolves to. Keeping that single
 * rule simple is worth two categories that look unlike the rest of the list.
 *
 * COGS categories map directly to a 5xxx account here — NOT the two-stage
 * purchase -> inventory -> consumption pattern COA-ALIGNMENT §4.1 eventually wants
 * (that needs real inventory tracking, Phase 3). T-122 §"COGS without a delivery" names
 * this explicitly as the accepted Phase 1 simplification, and POSTING-PATTERNS.md's
 * `expense.cash.simple` worked example is exactly this: a COGS category expensed
 * directly on receipt, posted to 5100 like any other cash expense. This is WIDER than
 * `packages/etl/src/convert.ts`'s own COGS handling (which quarantines every COGS
 * expense, `unsupported_case_class` — that converter's job is replaying v1's ALREADY-
 * POSTED documents faithfully, not deciding how a NEW v2 expense should post) — the two
 * are different questions and are allowed to answer differently; see the task report.
 *
 * Like `chart-of-accounts.ts`, this is reference data, not a fixture: every row is
 * applied idempotently by (org_id, category) — see `seedExpenseCategories()` below.
 */
import type postgres from 'postgres';

export type ExpenseCategoryGroup = 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';

export interface ExpenseCategorySeed {
  readonly group: ExpenseCategoryGroup;
  readonly category: string;
  readonly accountCode: string;
}

// ---------------------------------------------------------------------------------------
// Mirrored EXACTLY from packages/etl/src/leg-mapping.ts's COGS_CATEGORY_ACCOUNTS. Do not
// re-derive; see this file's top comment.
// ---------------------------------------------------------------------------------------
const COGS: readonly ExpenseCategorySeed[] = [
  { group: 'COGS', category: 'Meat', accountCode: '5110' },
  { group: 'COGS', category: 'Sides', accountCode: '5120' },
  { group: 'COGS', category: 'Condiments, Ingredients and Seasoning', accountCode: '5130' },
  { group: 'COGS', category: 'Meat Sauce Dips and Flavors', accountCode: '5140' },
  { group: 'COGS', category: 'Beverages', accountCode: '5200' },
  { group: 'COGS', category: 'Product Packaging', accountCode: '5150' },
  { group: 'COGS', category: 'Retail Inventory', accountCode: '5160' },
  { group: 'COGS', category: 'Commissary Purchases', accountCode: '5170' },
  { group: 'COGS', category: 'Cost of Goods Sold — General', accountCode: '5100' },
];

// ---------------------------------------------------------------------------------------
// Mirrored EXACTLY from packages/etl/src/leg-mapping.ts's OPEX_CATEGORY_ACCOUNTS,
// including its two documented §4.5 merges (Maintenance -> 6600, Subscriptions (OTHER)
// -> 6890) and its three deliberate reclassifications below operating profit / to the
// balance sheet (Interest Expense -> 7200, Loss on Disposal -> 7400, Other Prepaid ->
// 1400) — kept as-is here, not filtered out, because leg-mapping.ts's own comment says
// COA-ALIGNMENT §4.2 lists all three as OPEX-group v1 categories that need exactly this
// reclassification; a category picker that omitted them would leave those documents
// unmappable. "Uncategorized Expenses" -> 6900 is likewise kept: it is an EXPLICIT,
// NAMED mapping (not the forbidden silent fallback — see leg-mapping.ts's own comment).
// ---------------------------------------------------------------------------------------
const OPEX: readonly ExpenseCategorySeed[] = [
  { group: 'OPEX', category: 'Salary', accountCode: '6100' },
  { group: 'OPEX', category: 'Employee Expenses', accountCode: '6160' },
  { group: 'OPEX', category: 'Rent', accountCode: '6200' },
  { group: 'OPEX', category: 'Utilities', accountCode: '6300' },
  { group: 'OPEX', category: 'Platform Fee', accountCode: '6400' },
  { group: 'OPEX', category: 'Online Order Expenses', accountCode: '6410' },
  { group: 'OPEX', category: 'Supplies and Stocks', accountCode: '6500' },
  { group: 'OPEX', category: 'Smallwares', accountCode: '6510' },
  { group: 'OPEX', category: 'Repairs and Maintenance', accountCode: '6600' },
  { group: 'OPEX', category: 'Maintenance', accountCode: '6600' },
  { group: 'OPEX', category: 'Pest Control and Waste Management', accountCode: '6620' },
  { group: 'OPEX', category: 'Pest Control and Sanitation', accountCode: '6620' },
  { group: 'OPEX', category: 'Vehicle Expense', accountCode: '6630' },
  { group: 'OPEX', category: 'Marketing and Advertising', accountCode: '6650' },
  { group: 'OPEX', category: 'Depreciation', accountCode: '6700' },
  { group: 'OPEX', category: 'Amortization', accountCode: '6750' },
  { group: 'OPEX', category: 'Permits & Licenses', accountCode: '6800' },
  { group: 'OPEX', category: 'Administrative Expenses', accountCode: '6850' },
  { group: 'OPEX', category: 'Bad Debt', accountCode: '6860' },
  { group: 'OPEX', category: 'Bank Fees', accountCode: '6870' },
  { group: 'OPEX', category: 'Insurance', accountCode: '6880' },
  { group: 'OPEX', category: 'Subscriptions', accountCode: '6890' },
  { group: 'OPEX', category: 'Subscriptions (OTHER)', accountCode: '6890' },
  { group: 'OPEX', category: 'Uncategorized Expenses', accountCode: '6900' },
  { group: 'OPEX', category: 'Interest Expense', accountCode: '7200' },
  { group: 'OPEX', category: 'Loss on Disposal', accountCode: '7400' },
  { group: 'OPEX', category: 'Other Prepaid', accountCode: '1400' },
];

// ---------------------------------------------------------------------------------------
// PERSONAL and CAPEX — single categories, T-122 invariants 8 and 9.
// ---------------------------------------------------------------------------------------
const PERSONAL_AND_CAPEX: readonly ExpenseCategorySeed[] = [
  { group: 'PERSONAL', category: "Owner's Personal Expense", accountCode: '3200' },
  { group: 'CAPEX', category: 'Capital Expenditure', accountCode: '1510' },
];

export const EXPENSE_CATEGORY_SEED: readonly ExpenseCategorySeed[] = [...COGS, ...OPEX, ...PERSONAL_AND_CAPEX];

export interface SeedExpenseCategoriesResult {
  categoriesInserted: number;
}

/**
 * Applies `EXPENSE_CATEGORY_SEED` to one org, idempotently by (org_id, category) — a
 * second call changes zero existing rows, same discipline as `seedChartOfAccounts`
 * (Contract-equivalent invariant 6 there). `DO NOTHING`, never `DO UPDATE`: editing an
 * already-seeded category's account is a new, explicit decision, never a silent upsert.
 */
export async function seedExpenseCategories(
  sql: postgres.Sql,
  orgId: string,
): Promise<SeedExpenseCategoriesResult> {
  const payload = EXPENSE_CATEGORY_SEED.map((c) => ({
    group: c.group,
    category: c.category,
    account_code: c.accountCode,
  }));

  // `group` is a reserved word — both the recordset column NAME and every reference to
  // it must be quoted, or Postgres's parser rejects it at `v.group` (bare `group` is not
  // a valid column reference there). Found here because this function had never actually
  // been called against real Postgres before: packages/db/tests/expense-categories-seed.test.ts
  // is a unit test that only checks the plain EXPENSE_CATEGORY_SEED array, never this SQL.
  const rows = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    select ${orgId}::uuid, v."group", v.category, v.account_code
    from jsonb_to_recordset(${sql.json(payload)})
      as v("group" text, category text, account_code text)
    on conflict (org_id, category) do nothing
    returning expense_categories.id
  `;

  return { categoriesInserted: rows.length };
}
