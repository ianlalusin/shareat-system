/**
 * T-113 — the nominal-leg mapping table, as executable data.
 *
 * docs/tasks/113-nominal-leg-mapping-table.md §1–§2 is the design; this module is that
 * table made runnable, per the task's "Scope — implementation" section. It is consumed by
 * `convert.ts` (the expense-category crosswalk) and is meant to be consumed by the future
 * Stage 1 proper (docs/tasks/114, not yet built) for the sourceType classification.
 *
 * ---------------------------------------------------------------------------------------
 * FINDING — the spec's sourceType names are not what v1 actually writes.
 * ---------------------------------------------------------------------------------------
 * T-113 §1/§2 name 25 sourceTypes in kebab-case ("ap-payment", "ar-collection", ...). Read
 * against every builder in `ERP-rebuild/src/lib/financial/journal/builders/*.builder.ts`
 * (read-only, 2026-08-23 — bible §2.1), the REAL `sourceType` field v1 writes uses
 * snake_case and, in several cases, is not the word the spec uses at all:
 *
 *   - `expense` (spec) is actually written as `expense_payment`.
 *   - `liability-charge` (spec) is actually written as `balance_adjustment`.
 *   - `equity-movement` (spec) is actually TWO values: `capital_contribution` / `drawing`.
 *   - `cash-request` (spec) is actually TWO values: `cash_request_release` /
 *     `cash_request_return`.
 *   - `legacy-balance-import` (spec) is actually FIVE values: `ap_legacy_import`,
 *     `ar_legacy_import`, `staff_advance_legacy_import`, `staff_reimbursable_legacy_import`,
 *     `cash_legacy_import`.
 *   - `loan` (spec) is actually TWO values: `loan_disbursement` (balance-sheet-only — no
 *     interest leg ever) and `loan_payment` (nominal only when `interestAmount > 0`).
 *   - `ar-charge` (spec) and `sale` (spec) are literally THE SAME real value: `sale`.
 *     `ar-charge.builder.ts:32` posts `sourceType: 'sale'`. The two are distinguishable
 *     only by sourceId (an arTransaction id vs a salesDay id) and by which single leg
 *     exists (`ar__{customerId}` vs `cash__*`/`online__*`) — never by sourceType alone.
 *
 * Four real sourceTypes exist that T-113 §1/§2 never names at all — found by reading every
 * builder file, not by trusting the spec's list was exhaustive:
 *   `prepaid_writeoff`, `prepaid_refund` (amortization.builder.ts — a prepaid item written
 *   off early, or refunded on cancellation), `prepaid_legacy_import` (a sixth legacy-import
 *   flavour, for prepaid items, living in prepaid-purchase.builder.ts rather than
 *   legacy-balance-import.builder.ts), and `online_remittance` (remittance.builder.ts's
 *   online-to-online sibling of `remittance`).
 *
 * This module keys everything on the REAL value, because that is what will actually appear
 * in a `sourceType` field read from v1. A table keyed on the spec's pretty names would
 * silently classify nothing real. `specNames` links each real value back to the spec name
 * that (loosely) refers to it, for traceability — `[]` where the spec never named it.
 *
 * ---------------------------------------------------------------------------------------
 * FINDING — "nominal" is mostly conditional, not fixed, even for Class A.
 * ---------------------------------------------------------------------------------------
 * T-113 §1's "Class A — nominal" table implies each of those 11 sourceTypes always touches
 * one fixed P&L account. Reading the actual builders shows most of them touch it only
 * SOMETIMES: `asset_disposal` posts no loss leg when the asset was fully depreciated;
 * `payroll_payout` posts income__charge_recovery only when a late charge applies (most
 * payouts post zero P&L lines); `ar_collection`'s platform-fee leg is optional and its
 * account is caller-overridable; `remittance`/`online_remittance` post to 7350 only on
 * overage — a shortage instead posts to `staff_advance__*` (not P&L) and an exact match
 * posts to neither; `salary_advance` is nominal only for the rarer `charge` txType, and
 * even that counter-account is caller-supplied (could be `equity__opening_balance`, not
 * 7320) — the far more common disbursement/repayment txTypes never touch P&L at all;
 * `balance_adjustment` (§1's "liability-charge") takes an entirely caller-supplied counter
 * account, which the builder's own header comment says can be `equity__opening_balance`
 * just as easily as an expense account.
 *
 * None of this breaks T-113's PRIMARY invariant — every one of these sourceTypes is still
 * always self-balanced by construction (the builder throws or returns a balanced set), so
 * Stage 1 never needs to synthesise a leg for any of them, which is the property that
 * actually matters (§1's "Stage 1 must not synthesise one"). It does mean the spec's
 * single-account framing is optimistic. `alwaysNominalAccounts` vs `conditionalNominalAccounts`
 * below records the real, conditional shape rather than flattening it.
 */

// -----------------------------------------------------------------------------------------
// Account code constants — single source of truth for every code this module or convert.ts
// names, so a typo shows up as "no such export", not a silent post to the wrong account.
// packages/db/seed/chart-of-accounts.ts is the seeded source of truth these codes must
// exist in (leg-mapping.test.ts checks that against the real seed data, not a duplicate).
// -----------------------------------------------------------------------------------------
export const ACCOUNTS = {
  CASH_CASHIER: '1110',
  CASH_STAFF: '1120',
  CASH_OFFICE: '1130',
  ONLINE: '1140',
  AP: '2110',
  REIMBURSABLE_TO_EMPLOYEES: '2130',
  PROPERTY_AND_EQUIPMENT: '1510',
  OWNERS_DRAWINGS: '3200',
  FOOD_UNLI: '4100',
  FOOD_A_LA_CARTE: '4150',
  SALES_DISCOUNTS: '4900',
  SALES_RETURNS_AND_VOIDS: '4950',
} as const;

// -----------------------------------------------------------------------------------------
// §4.1 — COGS category -> account. Two-column in COA-ALIGNMENT (purchase vs consumption);
// only the COGS (consumption-side) account is a bold `**NNNN**` table-row code there, so
// only that side is checked against the doc by leg-mapping.test.ts's parser (see that
// file's comment on why 1310/1320/1330 are deliberately NOT part of that check).
//
// NOT wired into convert.ts's actual posting logic — T-117's convertExpense already, and
// correctly, quarantines every COGS expense ("the two-stage inventory posting T-113 §2.1
// describes but this converter does not implement"), and that behaviour is preserved
// (T-113 Scope: "widens the map, does not loosen the rule"). This crosswalk exists so
// invariant 11 ("every COGS category named in §4 resolves to an account that exists in the
// seeded chart") is provable now, ready for whenever the two-stage posting is implemented.
// -----------------------------------------------------------------------------------------
export const COGS_CATEGORY_ACCOUNTS: Readonly<Record<string, string>> = {
  'Meat': '5110',
  'Sides': '5120',
  'Condiments, Ingredients and Seasoning': '5130',
  'Meat Sauce Dips and Flavors': '5140',
  'Beverages': '5200',
  'Product Packaging': '5150',
  'Retail Inventory': '5160',
  'Commissary Purchases': '5170',
  'Cost of Goods Sold — General': '5100',
};

/** §4.1's purchase-side (inventory) accounts. Documentation constants only — not bold
 *  `**NNNN**`-coded in COA-ALIGNMENT's table, so not part of the §4 parser cross-check;
 *  see COGS_CATEGORY_ACCOUNTS's comment. */
export const COGS_INVENTORY_ACCOUNTS = {
  RAW_MATERIALS: '1310',
  SUPPLIES_AND_PACKAGING: '1320',
  PREPPED_COMMISSARY_GOODS: '1330',
} as const;

// -----------------------------------------------------------------------------------------
// §4.2 — OPEX category -> account, the FULL crosswalk (widens T-117's Rent/Utilities-only
// map). Two pairs are deliberate near-duplicates COA-ALIGNMENT §4.5 says to merge onto one
// code (Maintenance / Repairs and Maintenance -> 6600; Subscriptions / Subscriptions
// (OTHER) -> 6890). "Uncategorized Expenses" -> 6900 is an EXPLICIT, NAMED mapping from
// COA-ALIGNMENT, not the forbidden silent fallback — the forbidden case is a category that
// is NOT a key in this map at all (convert.ts quarantines that; see leg-mapping.test.ts
// and convert.test.ts for the distinction exercised as a test). Interest Expense / Loss on
// Disposal / Other Prepaid are included because COA-ALIGNMENT §4.2 lists them as OPEX-group
// v1 categories needing reclassification (to 7200 / 7400 / 1400 respectively) even though
// none of those three destinations is itself a 6xxx operating-expense account.
// -----------------------------------------------------------------------------------------
export const OPEX_CATEGORY_ACCOUNTS: Readonly<Record<string, string>> = {
  'Salary': '6100',
  'Employee Expenses': '6160',
  'Rent': '6200',
  'Utilities': '6300',
  'Platform Fee': '6400',
  'Online Order Expenses': '6410',
  'Supplies and Stocks': '6500',
  'Smallwares': '6510',
  'Repairs and Maintenance': '6600',
  'Maintenance': '6600', // §4.5 merge — same concept, two v1 category strings
  'Pest Control and Waste Management': '6620',
  // COA-ALIGNMENT §4.5 merges two v1 categories into 6620. The second was unnamed in the
  // document and was deliberately NOT guessed; Ian named it 2026-08-23.
  'Pest Control and Sanitation': '6620',
  'Vehicle Expense': '6630',
  'Marketing and Advertising': '6650',
  'Depreciation': '6700',
  'Amortization': '6750',
  'Permits & Licenses': '6800',
  'Administrative Expenses': '6850',
  'Bad Debt': '6860',
  'Bank Fees': '6870',
  'Insurance': '6880',
  'Subscriptions': '6890',
  'Subscriptions (OTHER)': '6890', // §4.5 merge
  'Uncategorized Expenses': '6900', // explicit, named — NOT the forbidden silent fallback
  'Interest Expense': '7200', // §4.2 ⚠️ reclass out of OPEX, below operating profit
  'Loss on Disposal': '7400', // §4.2 ⚠️ reclass out of OPEX, below operating profit
  'Other Prepaid': '1400', // §4.2 ⚠️ balance sheet, not an expense — routing entry
};

/**
 * FINDING — ambiguous mapping, not guessed.
 *
 * COA-ALIGNMENT §4.5 says "Pest Control split two ways | Merge into 6620" but — unlike its
 * Rent row (`Exp1000` and `sys_rent`) and its Smallwares row (`SE_EX85` and
 * `sys_capex_smallwares`) — never names the second literal category string, only the
 * primary one already in §4.2's own table ("Pest Control and Waste Management"). There is
 * nothing in COA-ALIGNMENT to safely guess the second string's exact spelling from, so it
 * is deliberately NOT added as a second key here. If a real `expenses.category` value shows
 * up that is obviously the missing "Pest Control" variant, it will quarantine (never
 * silently fall to 6900) until COA-ALIGNMENT names the exact string.
 */
/**
 * Categories COA-ALIGNMENT leaves genuinely ambiguous. Anything listed here quarantines
 * rather than being guessed (T-113 §3 rule 1) — a catch-all that silently absorbs the
 * unknown is how the legacy books reached their current state.
 *
 * RESOLVED 2026-08-23 — the §4.5 "Pest Control split two ways" entry never named its second
 * v1 category string. It was reported rather than guessed, and Ian named it:
 * **"Pest Control and Sanitation"**. Both categories now map to 6620.
 */
export const AMBIGUOUS_CATEGORY_FINDINGS: readonly string[] = [];

// -----------------------------------------------------------------------------------------
// §1/§2 — the sourceType classification. Keyed on the REAL v1 `sourceType` field value
// (see this file's header finding). `class` is the one property Stage 1 actually depends
// on: 'complete' sourceTypes are already self-balanced by their v1 builder and must never
// be synthesised onto (T-113 §1's "must synthesise ZERO lines" control); 'synthesize'
// sourceTypes are genuinely missing a leg (T-113 §2); 'quarantine' would be a sourceType
// this table cannot place at all — none exist below, which is invariant 10.
// -----------------------------------------------------------------------------------------
export type SourceTypeClass = 'complete' | 'synthesize' | 'quarantine';

export interface SourceTypeMapping {
  /** The real v1 journal `sourceType` field value. */
  readonly sourceType: string;
  /** T-113 §1/§2's pretty name(s) this real value corresponds to. `[]` = not named by the
   *  spec at all (a finding — see this file's header). */
  readonly specNames: readonly string[];
  readonly class: SourceTypeClass;
  /** Nominal (P&L) accounts this sourceType's builder ALWAYS posts to, unconditionally. */
  readonly alwaysNominalAccounts: readonly string[];
  /** Nominal (P&L) accounts posted only for SOME instances (an optional leg, or a
   *  documented common case of a caller-supplied counter-account). `[]` when the
   *  sourceType is purely balance-sheet, or when the conditional account is genuinely
   *  caller-arbitrary with no single documented common case. */
  readonly conditionalNominalAccounts: readonly string[];
  /** `ERP-rebuild/src/lib/financial/journal/builders/...`, read-only, 2026-08-23. */
  readonly evidence: string;
  readonly notes: string;
}

export const SOURCE_TYPE_MAPPINGS: readonly SourceTypeMapping[] = [
  // ---- Class A — balance-sheet-to-balance-sheet, complete, zero P&L ever ----------------
  {
    sourceType: 'ap_payment',
    specNames: ['ap-payment'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'ap-payment.builder.ts:71-130',
    notes: 'Source cash/online OUT + ap__ OUT (allocated) + optional supplier_advance__ IN (overpayment). Never a P&L account.',
  },
  {
    sourceType: 'cash_request_release',
    specNames: ['cash-request'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'cash-request.builder.ts:27-73',
    notes: 'Source OUT + cash__staff IN. Pure balance sheet.',
  },
  {
    sourceType: 'cash_request_return',
    specNames: ['cash-request'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'cash-request.builder.ts:80-127',
    notes: 'cash__staff OUT + return-target IN. Pure balance sheet.',
  },
  {
    sourceType: 'transfer',
    specNames: ['transfer'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'transfer.builder.ts:26-86',
    notes: 'Standard: source OUT + target IN, both balance-sheet. FINDING: with a fee (feeAccountId set) a THIRD leg posts to a caller-chosen, typically expense, account — already present in the original entry, so still zero SYNTHESIS, but "transfer never touches P&L" (as T-113 §1 frames it) is not quite right.',
  },
  {
    sourceType: 'asset_purchase',
    specNames: ['asset-purchase'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'asset-purchase.builder.ts:42-85',
    notes: 'asset__ IN + source OUT (cash) or ap__ IN (on account). Pure balance sheet.',
  },
  {
    sourceType: 'prepaid_purchase',
    specNames: ['prepaid-purchase'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'prepaid-purchase.builder.ts:42-85',
    notes: 'prepaid__ IN + source OUT (cash) or ap__ IN (on account). Pure balance sheet.',
  },
  {
    sourceType: 'capital_contribution',
    specNames: ['equity-movement'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'equity-movement.builder.ts:39-87',
    notes: 'cash/online IN + equity__capital IN. Pure balance sheet.',
  },
  {
    sourceType: 'drawing',
    specNames: ['equity-movement'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'equity-movement.builder.ts:39-95',
    notes: 'cash/online OUT + equity__capital OUT. Pure balance sheet. (v1 reduces equity__capital directly — a separate equity__drawings/3200 account is a v2-only concept, COA-ALIGNMENT §4.4/§4.7#2.)',
  },
  {
    sourceType: 'slicer_payment',
    specNames: ['slicer-payment'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'slicer-payment.builder.ts:93-129',
    notes: 'liability__salaries_payable OUT (park) + cash/online OUT splits. Payroll park pattern, mirrors payroll_payout — no P&L leg.',
  },
  {
    sourceType: 'liability_payment',
    specNames: ['liability-payment'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'liability-payment.builder.ts:41-61',
    notes: 'cash OUT + liability__ OUT. Pure balance sheet.',
  },
  {
    sourceType: 'reimbursement_payout',
    specNames: ['reimbursement-payout'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'reimbursement-payout.builder.ts:45-66',
    notes: 'cash OUT + staff_reimbursable__ OUT. Pure balance sheet.',
  },
  {
    sourceType: 'ap_legacy_import',
    specNames: ['legacy-balance-import'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'legacy-balance-import.builder.ts:39-76',
    notes: 'ap__ IN + equity__opening_balance OUT. Pure balance sheet.',
  },
  {
    sourceType: 'ar_legacy_import',
    specNames: ['legacy-balance-import'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'legacy-balance-import.builder.ts:90-127',
    notes: 'ar__ IN + equity__opening_balance IN. Pure balance sheet.',
  },
  {
    sourceType: 'staff_advance_legacy_import',
    specNames: ['legacy-balance-import'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'legacy-balance-import.builder.ts:145-182',
    notes: 'staff_advance__ IN + equity__opening_balance IN. Pure balance sheet.',
  },
  {
    sourceType: 'staff_reimbursable_legacy_import',
    specNames: ['legacy-balance-import'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'legacy-balance-import.builder.ts:200-237',
    notes: 'staff_reimbursable__ IN + equity__opening_balance OUT. Pure balance sheet.',
  },
  {
    sourceType: 'cash_legacy_import',
    specNames: ['legacy-balance-import'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'legacy-balance-import.builder.ts:255-291',
    notes: 'cash__/online__ IN + equity__opening_balance IN. Pure balance sheet.',
  },
  {
    sourceType: 'asset_legacy_import',
    specNames: ['asset-legacy-import'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'asset-legacy-import.builder.ts:39-85',
    notes: 'asset__ IN + contra_asset__ IN + equity__opening_balance IN. Pure balance sheet.',
  },
  {
    sourceType: 'prepaid_refund',
    specNames: [], // FINDING — not named in T-113 §1/§2 at all
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'amortization.builder.ts:146-183',
    notes: 'FINDING: dest cash/online IN + prepaid__ OUT — a prepaid item refunded on cancellation. Pure balance sheet. Not named anywhere in T-113.',
  },
  {
    sourceType: 'prepaid_legacy_import',
    specNames: [], // FINDING — a sixth legacy-import flavour T-113 never names
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'prepaid-purchase.builder.ts:98-144',
    notes: 'FINDING: prepaid__ IN + equity__opening_balance IN. Conceptually the same family as legacy-balance-import\'s 5 sourceTypes, but lives in a different builder file and its own real sourceType is never named in T-113.',
  },
  {
    sourceType: 'loan_disbursement',
    specNames: ['loan'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'loan.builder.ts:22-71',
    notes: 'FINDING: cash/online IN + liability__loan_ IN. Pure balance sheet — no interest, ever. T-113 §1 lists "loan" as uniformly nominal (-> expense__interest/7200); the disbursement half of it never is.',
  },
  // ---- Class A — nominal (P&L leg present, always or conditionally), complete ----------
  {
    sourceType: 'loan_payment',
    specNames: ['loan'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: ['7200'],
    evidence: 'loan.builder.ts:88-142',
    notes: 'cash OUT (principal+interest) + liability__loan_ OUT (principal) + expense__interest IN (7200) only when interestAmount > 0. A principal-only payment posts zero P&L lines.',
  },
  {
    sourceType: 'payroll_salary_expense',
    specNames: ['payroll-salary-expense'],
    class: 'complete',
    alwaysNominalAccounts: ['6100'],
    conditionalNominalAccounts: ['6150'],
    evidence: 'payroll-salary-expense.builder.ts:47-79',
    notes: 'expense__salary (6100) always; expense__salary_additions (6150) only when totalAdditions > 0; liability__salaries_payable IN clears both.',
  },
  {
    sourceType: 'depreciation',
    specNames: ['depreciation'],
    class: 'complete',
    alwaysNominalAccounts: ['6700'],
    conditionalNominalAccounts: [],
    evidence: 'depreciation.builder.ts:34-70',
    notes: 'expense__depreciation (6700) IN + contra_asset__ IN, always both.',
  },
  {
    sourceType: 'amortization',
    specNames: ['amortization'],
    class: 'complete',
    alwaysNominalAccounts: ['6750'],
    conditionalNominalAccounts: [],
    evidence: 'amortization.builder.ts:39-76',
    notes: 'expense__amortization (6750) IN + prepaid__ OUT, always both.',
  },
  {
    sourceType: 'prepaid_writeoff',
    specNames: [], // FINDING — not named in T-113 §1/§2 at all
    class: 'complete',
    alwaysNominalAccounts: ['6750'],
    conditionalNominalAccounts: [],
    evidence: 'amortization.builder.ts:92-129',
    notes: 'FINDING: shares expense__amortization (6750) with `amortization` — the remaining book value of an early write-off, recognised in full immediately. Not named anywhere in T-113.',
  },
  {
    sourceType: 'ar_collection',
    specNames: ['ar-collection'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: ['6400'],
    evidence: 'ar-collection.builder.ts:34-96',
    notes: 'dest IN (actualReceived) + ar__ OUT (grossApplied) + expense__platform_fee (6400) IN only when platformFee > 0 — and that account is caller-overridable via platformFeeAccountId. T-113 §1 treats 6400 as unconditional; a collection with no platform fee never touches it.',
  },
  {
    sourceType: 'asset_disposal',
    specNames: ['asset-disposal'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: ['7400'],
    evidence: 'asset-disposal.builder.ts:32-85',
    notes: 'asset__ OUT + contra_asset__ OUT (if any) + expense__loss_on_disposal (7400) IN only when bookValue > 0. A fully-depreciated disposal posts zero P&L lines (the builder\'s own comment says so).',
  },
  {
    sourceType: 'balance_adjustment',
    specNames: ['liability-charge'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: ['6800'],
    evidence: 'liability-charge.builder.ts:1-81',
    notes: 'liability__ IN + a fully caller-supplied counter account (direction also caller-supplied). The builder\'s own header names two real callers: an expense account (e.g. expense__tax, 6800 — the common case per COA-ALIGNMENT §3 answer #2, "mostly permits") and equity__opening_balance (not nominal at all). T-113 §1 hard-codes 6800 as if fixed; it is the documented common case, not a guarantee.',
  },
  {
    sourceType: 'wastage_expense',
    specNames: ['wastage-expense'],
    class: 'complete',
    alwaysNominalAccounts: ['5300'],
    conditionalNominalAccounts: [],
    evidence: 'wastage-expense.builder.ts:18-48',
    notes: 'expense__order_wastage (5300, moved from OPEX to COGS per COA-ALIGNMENT §1 rule 5) IN + income__wastage_writeoff_contra IN, always both. The contra account is RETIRED in v2 (COA-ALIGNMENT §2 "Retire" table) — v2 wastage instead debits 5300 / credits inventory directly; this net-zero memo pairing is v1-only.',
  },
  {
    sourceType: 'payroll_payout',
    specNames: ['payroll-payout'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: ['7310'],
    evidence: 'payroll-payout.builder.ts:80-189',
    notes: 'liability__salaries_payable OUT (park settlement, not P&L) + cash OUT + optional staff_advance__ OUT / liability__statutory IN / liability__withholding_tax IN (none P&L) + income__charge_recovery (7310) IN only when lateChargeTotal > 0, + arbitrary caller-supplied customByAccount legs (may or may not be P&L, fully caller-determined). Most payouts post ZERO P&L lines.',
  },
  {
    sourceType: 'salary_advance',
    specNames: ['salary-advance'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: ['7320'],
    evidence: 'salary-advance.builder.ts:43-155',
    notes: 'FINDING: three txTypes share this sourceType. Disbursement and repayment (the common cases) are pure balance sheet (cash <-> staff_advance__, never P&L). Only the rarer "charge" txType touches a counter account, and even then it is caller-supplied — income__wastage_recovery (7320, the documented common case per the builder\'s own JSDoc) or equity__opening_balance (not nominal). T-113 §1 lists this as unconditionally nominal; in practice most instances never touch P&L at all.',
  },
  {
    sourceType: 'remittance',
    specNames: ['remittance'],
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: ['7350'],
    evidence: 'remittance.builder.ts:18-126',
    notes: 'cash__cashier OUT + cash__office IN, always. THEN either staff_advance__ IN (shortage — not P&L) OR others__remittance_overage (7350) IN (overage), never both, and neither if expected == actual. Also conditionally posts liability__void_cash_suspense (2900, not P&L) for retained void cash. T-113 §1 treats 7350 as fixed; most remittances (shortage or exact) never touch it.',
  },
  {
    sourceType: 'online_remittance',
    specNames: [], // FINDING — not named in T-113 §1/§2 at all
    class: 'complete',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: ['7350'],
    evidence: 'remittance.builder.ts:128-209',
    notes: 'FINDING: online-to-online sibling of `remittance`, same shortage/overage shape (staff_advance__ vs 7350). Not named anywhere in T-113.',
  },
  // ---- Class B — synthesise: the nominal leg is genuinely missing -----------------------
  {
    sourceType: 'expense_payment',
    specNames: ['expense'],
    class: 'synthesize',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'expense.builder.ts:19-135',
    notes: 'Real v1 field value is `expense_payment`, not the spec\'s pretty name `expense`. Missing leg per T-113 §2.1 — the funding leg(s) post, the classification leg never does. FINDING: when expense.assetId is set (CAPEX), v1 ALREADY posts an asset__ IN leg here (:114-132) regardless of expenseEntryGroup — so a real v1 CAPEX expense_payment entry may already be complete in the actual journal. convert.ts works from the RAW `expenses/{id}` document, not v1\'s posted journal, so it reconstructs independently rather than trusting that leg exists.',
  },
  {
    sourceType: 'sale',
    specNames: ['sale', 'ar-charge'],
    class: 'synthesize',
    alwaysNominalAccounts: [],
    conditionalNominalAccounts: [],
    evidence: 'sale.builder.ts:8-61; ar-charge.builder.ts:20-44',
    notes: 'COLLISION FINDING: T-113 §2.2 (ar-charge) and §2.3 (sale) name two different rules, but v1 posts BOTH under the literal sourceType "sale". Distinguishable only by sourceId (salesDayId vs arTransactionId) and by which single leg exists (cash__*/online__* vs ar__{customerId}) — Stage 1 cannot dispatch on sourceType alone here. convert.ts implements only the salesDay (§2.3) half; ar-charge (§2.2) has no RawSpecimen kind and is out of scope (see convert.ts UNSUPPORTED_CLASSES / sale.branch_sale).',
  },
];

const BY_SOURCE_TYPE: ReadonlyMap<string, SourceTypeMapping> = new Map(
  SOURCE_TYPE_MAPPINGS.map((m) => [m.sourceType, m]),
);

export function classifySourceType(sourceType: string): SourceTypeMapping | undefined {
  return BY_SOURCE_TYPE.get(sourceType);
}

// -----------------------------------------------------------------------------------------
// T-113 §1/§2's own 25 pretty names, exactly as written there, each resolved to the real
// sourceType value(s) above. This is invariant 10: "every sourceType named in §1 and §2
// resolves to a class; none is unclassified" — built as a reverse index off SOURCE_TYPE_MAPPINGS
// rather than hand-duplicated, so the two can never silently drift apart.
// -----------------------------------------------------------------------------------------

/** T-113 §1's exact 11 balance-sheet-to-balance-sheet spec names — "must synthesise ZERO lines". */
export const BALANCE_SHEET_ONLY_SPEC_NAMES: readonly string[] = [
  'ap-payment', 'cash-request', 'transfer', 'asset-purchase', 'prepaid-purchase',
  'equity-movement', 'slicer-payment', 'liability-payment', 'reimbursement-payout',
  'legacy-balance-import', 'asset-legacy-import',
];

/** T-113 §1's exact 11 Class-A-nominal spec names, and the account code(s) that section's
 *  table names for each. See individual SOURCE_TYPE_MAPPINGS notes for how conditional the
 *  real leg actually is — this is the code(s) that must appear SOMEWHERE in the union of
 *  (always ∪ conditional) accounts across every real sourceType the name resolves to. */
export const NOMINAL_SPEC_NAME_ACCOUNTS: Readonly<Record<string, readonly string[]>> = {
  'payroll-salary-expense': ['6100', '6150'],
  'depreciation': ['6700'],
  'amortization': ['6750'],
  'loan': ['7200'],
  'ar-collection': ['6400'],
  'asset-disposal': ['7400'],
  'liability-charge': ['6800'],
  'wastage-expense': ['5300'],
  'payroll-payout': ['7310'],
  'salary-advance': ['7320'],
  'remittance': ['7350'],
};

/** T-113 §2's exact 3 Class-B (synthesise) spec names. */
export const SYNTHESIZE_SPEC_NAMES: readonly string[] = ['expense', 'ar-charge', 'sale'];

/** Every spec name T-113 §1/§2 names — the union invariant 10 must fully classify. */
export const ALL_SPEC_SOURCE_TYPE_NAMES: readonly string[] = [
  ...BALANCE_SHEET_ONLY_SPEC_NAMES,
  ...Object.keys(NOMINAL_SPEC_NAME_ACCOUNTS),
  ...SYNTHESIZE_SPEC_NAMES,
];

/** Resolves a T-113 spec pretty-name to every real sourceType value it corresponds to. */
export function realSourceTypesForSpecName(specName: string): readonly string[] {
  return SOURCE_TYPE_MAPPINGS.filter((m) => m.specNames.includes(specName)).map((m) => m.sourceType);
}
