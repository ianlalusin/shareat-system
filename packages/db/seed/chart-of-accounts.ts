/**
 * Chart of accounts — the seeded reference data. docs/tasks/102-chart-of-accounts-seed.md,
 * extended by docs/tasks/102b-chart-of-accounts-completion.md (closing DEF-035).
 *
 * Source of truth: docs/decisions/COA-ALIGNMENT.md §2 (account GROUPS) AND §4 (the
 * expense-category -> account MAPPING, which introduces a finer breakdown §2 only
 * gestures at), amended 2026-08-23 by Ian (revenue collapsed to two accounts — see the
 * REVENUE AMENDMENT note below). Where this file and COA-ALIGNMENT.md disagree in the
 * future, COA-ALIGNMENT.md wins and this file is the bug.
 *
 * T-102 seeded only §2 (75 accounts) — its spec said "take the complete list from §2",
 * but §2's own summary rows for 5xxx/6xxx point at §4 for detail. That left the chart
 * unable to express 17 accounts §4 actually names (5110-5170 COGS breakdown, plus 10
 * OPEX accounts: 6160, 6510, 6620, 6630, 6650, 6850, 6860, 6870, 6880, 6890) — DEF-035,
 * closed by T-102b. They are marked "T-102b" inline below, next to each `leaf(...)` call.
 *
 * This is reference data, not a fixture (bible §4.4 / §16.9):
 *   - every row is `isSystem: true` — deactivate (status: 'archived'), never delete
 *   - applied idempotently by (org_id, code) — see `seedChartOfAccounts()` below
 *   - `normalBalance` is DECLARED per row, never derived from `type` (bible §13 row 39 —
 *     the legacy system inferred it from an `accountId` prefix and got six rows wrong)
 *
 * Structure: seven non-postable header accounts (1000/2000/.../7000), each the DIRECT
 * parent of every account in its number range. The hierarchy is flat — two levels, never
 * three — so `parentCode` is either `null` (this row IS a header) or one of the seven
 * header codes. Every non-header row is postable (T-101's `accounts_postable_no_children`
 * trigger would reject anything else once a child references it).
 *
 * `legacyCode` is set ONLY where a v1 account id is a fixed, stable, 1:1 predecessor —
 * never for a per-entity prefix (`ap__{supplierId}`, `ar__{customerId}`,
 * `staff_advance__{staffId}`, `prepaid__{id}`, `asset__{id}`, `online__{id}`, and the
 * store-keyed pair `asset__due_from_{storeKey}` / `liability__due_to_{storeKey}`) — those
 * are thousands of v1 rows collapsing onto ONE v2 control account each, mapped by prefix
 * at ETL time (T-113/T-114), not by this column. See the task report for two further
 * legacy_code omissions this rule implies that the task spec didn't spell out by name:
 * 1590's `contra_asset__{assetId}` (per-entity despite its ✅ marker in COA-ALIGNMENT) and
 * 7350, which TWO fixed v1 ids collapse onto (`others__remittance_overage` and
 * `others__remittance_variance`) — a 2:1 collision, not a 1:1 predecessor, so neither
 * qualifies under Contract §5's "only a stable 1:1" rule either.
 */
import type postgres from 'postgres';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type NormalBalance = 'debit' | 'credit';
/** Seeded rows only ever start 'active' or 'reserved' — 'archived' is a later lifecycle
 * transition (bible §16.9), never a seed-time value. */
export type SeedAccountStatus = 'active' | 'reserved';

export interface ChartOfAccountsSeedAccount {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  /** null for the seven header rows themselves; otherwise the header code for this row's range. */
  parentCode: string | null;
  isPostable: boolean;
  legacyCode: string | null;
  status: SeedAccountStatus;
  /** T-118 (docs/tasks/118-subledger-party-on-line.md, closing DEF-037) — true on exactly
   * the nine control accounts COA-ALIGNMENT names "CONTROL + subledger". Always false for
   * headers (not postable, so never carry a line) and every other leaf. */
  requiresParty: boolean;
}

const header = (
  code: string,
  name: string,
  type: AccountType,
  normalBalance: NormalBalance,
): ChartOfAccountsSeedAccount => ({
  code,
  name,
  type,
  normalBalance,
  parentCode: null,
  isPostable: false,
  legacyCode: null,
  status: 'active',
  requiresParty: false,
});

const leaf = (
  code: string,
  name: string,
  type: AccountType,
  normalBalance: NormalBalance,
  parentCode: string,
  opts: { legacyCode?: string; status?: SeedAccountStatus; requiresParty?: boolean } = {},
): ChartOfAccountsSeedAccount => ({
  code,
  name,
  type,
  normalBalance,
  parentCode,
  isPostable: true,
  legacyCode: opts.legacyCode ?? null,
  status: opts.status ?? 'active',
  requiresParty: opts.requiresParty ?? false,
});

export const CHART_OF_ACCOUNTS: readonly ChartOfAccountsSeedAccount[] = [
  // ---------------------------------------------------------------------------------
  // Headers — Contract §1. Type/normal_balance follow the range's dominant type; 7000
  // is a genuine judgment call (see task report) because it rolls up BOTH income and
  // expense sub-accounts and neither source document states its type explicitly.
  // ---------------------------------------------------------------------------------
  header('1000', 'Assets', 'asset', 'debit'),
  header('2000', 'Liabilities', 'liability', 'credit'),
  header('3000', 'Equity', 'equity', 'credit'),
  header('4000', 'Revenue', 'income', 'credit'),
  header('5000', 'Cost of sales', 'expense', 'debit'),
  header('6000', 'Operating expenses', 'expense', 'debit'),
  header('7000', 'Other income and expense', 'income', 'credit'), // FLAGGED — see task report

  // ---------------------------------------------------------------------------------
  // Assets 1xxx
  // ---------------------------------------------------------------------------------
  leaf('1110', 'Cash on hand — cashier', 'asset', 'debit', '1000', { legacyCode: 'cash__cashier' }),
  // ⭐ PARTY-REQUIRING SINCE T-144, and v1 is NOT: POSTING-PATTERNS records it there as "a plain
  // asset, not a control account with a subledger".
  //
  // ⚠️ Not because v1 loses the holder — `requesterName`/`requesterUid` are on the request document.
  // Because the LEDGER cannot decompose 1120 without joining to that document: one staff-float
  // account per store, two people able to hold floats at once. ⛔ Which is why v1 stores
  // `remainingAmount` on the request — the figure lives there because the ledger could not produce
  // it. The party moves that knowledge INTO the ledger. party_type='cash_request'.
  /** ⭐ T-153 — the SIDE POCKET. Ian, 2026-08-29: *"extra cash float that is not remitted… it sits
   *  on till forever… separated from the money being remitted."* Its own account, not a corner of
   *  1110, because its balance is an INVARIANT: it should always equal the till's configured
   *  float_target, so a discrepancy is two figures compared rather than history read. Keeping it
   *  out of 1110 also means remittance can never sweep it by accident. */
  leaf('1115', 'Cash on hand — till float', 'asset', 'debit', '1000'),
  leaf('1120', 'Cash on hand — staff custodian', 'asset', 'debit', '1000', { legacyCode: 'cash__staff', requiresParty: true }),
  leaf('1130', 'Cash on hand — office', 'asset', 'debit', '1000', { legacyCode: 'cash__office' }),
  /** ⭐ requiresParty since ADR-010 (migration 0024): ONE control account covers every wallet,
   *  so the line names WHICH one via `party_type='money_account'` — the same shape 2110 uses
   *  for suppliers. v1 minted `online__{id}` GL accounts instead and its chart grew with the
   *  business; every one of them rolled back up into a single line in the audit anyway. */
  leaf('1140', 'E-wallet / online channels', 'asset', 'debit', '1000', { requiresParty: true }),
  leaf('1210', 'Accounts receivable', 'asset', 'debit', '1000', { requiresParty: true }), // control; ar__{customerId} per-entity — T-118 party_type=customer
  leaf('1220', 'Channel receivable', 'asset', 'debit', '1000', { requiresParty: true }), // control; ar__channel_{id} per-entity — T-118 party_type=channel
  leaf('1221', 'Channel clearing — Grab', 'asset', 'debit', '1000', { legacyCode: 'clearing__grab' }),
  leaf('1222', 'Channel clearing — Foodpanda', 'asset', 'debit', '1000', {
    legacyCode: 'clearing__foodpanda',
  }),
  leaf('1230', 'Advances to employees', 'asset', 'debit', '1000', { requiresParty: true }), // control; staff_advance__{staffId} — T-118 party_type=employee
  leaf('1240', 'Advances to suppliers', 'asset', 'debit', '1000', { requiresParty: true }), // control; supplier_advance__{supplierId} — T-118 party_type=supplier
  leaf('1250', 'Due from related store', 'asset', 'debit', '1000', { requiresParty: true }), // asset__due_from_{storeKey}, ar__{branchAsCustomer} — T-118 party_type=store
  // ⭐ T-127. ⛔ A personal expense the business EXPECTS BACK is a receivable, not a drawing — and
  // that distinction is the one the tax treatment turns on: a payment made with no expectation of
  // repayment is a distribution however it is labelled. ⚠️ An AGED balance here is a finding, not a
  // balance: an owner receivable sitting for months is what gets reclassified on examination.
  leaf('1260', 'Due from owners', 'asset', 'debit', '1000', { requiresParty: true }), // 🆕 — T-118 party_type=owner
  leaf('1310', 'Inventory — raw materials', 'asset', 'debit', '1000'), // 🆕
  leaf('1320', 'Inventory — supplies and packaging', 'asset', 'debit', '1000'), // 🆕
  leaf('1330', 'Inventory — prepped / commissary goods', 'asset', 'debit', '1000'), // 🆕
  leaf('1340', 'Inventory in transit (branch orders)', 'asset', 'debit', '1000'), // 🆕
  leaf('1400', 'Prepaid expenses', 'asset', 'debit', '1000'), // control; prepaid__{id} per-entity
  // 1510 only — 1520/1530 deliberately NOT seeded. See task report: COA-ALIGNMENT gives
  // this concept a single name across a code RANGE ("1510-1530 Property and equipment"),
  // unlike every other multi-code row in the same document, which gives one distinct
  // name per code. Inventing two more account names with no basis in either source
  // document is exactly the fabrication this project exists to stop (bible §4.4).
  // 1520/1530 are a genuine reserved NUMBER GAP per bible §16.9, not database rows.
  leaf('1510', 'Property and equipment', 'asset', 'debit', '1000'), // control; asset__{assetId}
  // Contra-asset exception — Contract §3.
  leaf('1590', 'Accumulated depreciation', 'asset', 'credit', '1000'), // contra_asset__{assetId}, per-entity

  // ---------------------------------------------------------------------------------
  // Liabilities 2xxx
  // ---------------------------------------------------------------------------------
  leaf('2110', 'Accounts payable', 'liability', 'credit', '2000', { requiresParty: true }), // control; ap__{supplierId} — T-118 party_type=supplier
  // Goods received, not yet invoiced (ADR-009 amendment, bible row 117). A delivery posts a
  // PROVISIONAL valued inventory layer on receipt and credits this; when the expense document
  // links, the provisional cost is corrected and this clears into 2110 AP.
  //
  // It exists because posting nothing until the manual link happens IS the expensing lag
  // ADR-009 measured (91% -> 76%, worst in the most recent month) — and that is exactly the
  // stock the December count has to value.
  //
  // Requested as 2140; 2140 was already 'Customer store credits payable'. 2120 is both free and
  // the better home: GRNI is an accrued liability, and it sits directly after 2110 in the flow
  // goods received -> GRNI -> AP.
  //
  // NO requiresParty. The supplier is known on the delivery, but until the invoice arrives the
  // amount owed to that specific supplier is not yet established — forcing a party here would
  // assert a subledger balance the business has not yet agreed. It clears INTO 2110, which does
  // carry the party.
  leaf('2120', 'Goods received not invoiced', 'liability', 'credit', '2000', { status: 'reserved' }),
  leaf('2130', 'Reimbursements payable to employees', 'liability', 'credit', '2000', {
    requiresParty: true,
  }), // staff_reimbursable__{staffId} — T-118 party_type=employee
  // ⭐ T-131: party-required. A store credit that does not say WHOSE credit it is cannot be
  // paid back to anyone — v1 had a boolean flag and no balance at all behind it.
  leaf('2140', 'Customer store credits payable', 'liability', 'credit', '2000', {
    legacyCode: 'others__store_credits',
    requiresParty: true,
  }),
  leaf('2145', 'Unredeemed vouchers', 'liability', 'credit', '2000', { status: 'reserved' }),
  // 🆕 2026-08-25 (T-123, bible row 135). ⭐ A FLOAT, and the word matters.
  //
  // Ian ruled out both alternatives, each for the right reason: *"don't push to accounts
  // payable"* — AP is money owed to SUPPLIERS, with a party, an age and a payment process, and
  // this is none of those — and then *"it will bloat the revenue"*, which it would: a month with
  // ₱1M of food and ₱100k of service charge would read ₱1.1M of income, ₱100k of which was never
  // the business's money.
  //
  // ⭐ **So it touches neither.** It fills as service charge is collected and empties as payroll
  // distributes it (RA 11360: 100% to rank-and-file staff, at least twice a month). It never
  // appears in the P&L — **no revenue on the way in, and no expense on the way out**, because
  // money that was never yours cannot be a cost when you hand it over.
  //
  // The distribution is therefore a DEBIT here, not a salary expense. What the business spends on
  // its own staff stays in 6100; what it merely passes through sits here until it is passed.
  //
  // ⚠️ **The float must be CLEARED on a cadence, and the law caps it.** RA 11360 requires
  // distribution **at least twice a month, at intervals not exceeding sixteen days**.
  // ⭐ **Ian chose DAILY or WEEKLY only** — inside the floor rather than at its edge, so the
  // closed list cannot express a breach and nobody has to remember the sixteen days.
  // A float left standing past that interval is not a balance, it is a breach; whatever surfaces
  // it (the OIL feed, T-135) should treat an ageing balance here as a finding, not a total.
  leaf('2160', 'Service charge float — held for staff', 'liability', 'credit', '2000'),
  leaf('2150', 'Due to related store', 'liability', 'credit', '2000', { requiresParty: true }), // liability__due_to_{storeKey}, ap__{commissaryMirror} — T-118 party_type=store
  leaf('2210', 'SSS payable', 'liability', 'credit', '2000'), // 🆕
  leaf('2220', 'PhilHealth payable', 'liability', 'credit', '2000'), // 🆕
  leaf('2230', 'Pag-IBIG payable', 'liability', 'credit', '2000'), // 🆕
  leaf('2240', 'Withholding tax payable', 'liability', 'credit', '2000'), // 🆕
  leaf('2250', 'VAT payable', 'liability', 'credit', '2000', { status: 'reserved' }), // bible §13 row 75
  // ⭐ T-128. The RESIDUAL liability control account — what the business owes that no other module
  // already owns. ⛔ Statutory payables (2210-2240) stay party-FREE and are not used here: payroll
  // accrues into them and statutory_remittance settles them, both without a party, and recording the
  // same debt in both places would count it twice with nothing reconciling them.
  leaf('2500', 'Accrued and other liabilities', 'liability', 'credit', '2000', { requiresParty: true }), // 🆕 — T-118 party_type=liability
  leaf('2300', 'Salaries and wages payable', 'liability', 'credit', '2000', {
    legacyCode: 'liability__salaries_payable',
  }),
  leaf('2400', 'Loans payable', 'liability', 'credit', '2000', { requiresParty: true }), // control; liability__loan_{loanId} — T-118 party_type=supplier (the lender)
  leaf('2900', 'Suspense — void cash', 'liability', 'credit', '2000', {
    legacyCode: 'liability__void_cash_suspense',
  }),

  // ---------------------------------------------------------------------------------
  // Equity 3xxx
  // ---------------------------------------------------------------------------------
  // ⭐ PARTY-REQUIRING SINCE T-127. ⚠️ v1 DOES attribute equity — it puts `employeeId: ownerId` on
  // the journal entry (equity-movement.builder.ts:57), a field named for something an owner is not.
  // Moving it to the LINE is what makes v1's three stored totals (totalCapital / totalDrawings /
  // netEquity) unnecessary rather than merely redundant: every figure becomes a GROUP BY. DEF-072.
  leaf('3100', "Owner's capital", 'equity', 'credit', '3000', {
    legacyCode: 'equity__capital',
    requiresParty: true,
  }),
  // FLAGGED — see task report. Standard practice treats Owner's Drawings as CONTRA-equity
  // (debit-normal). Contract §3 names "two deliberate exceptions" totalling six accounts
  // but its own list only enumerates five (1590 + four contra-revenue), and 3200 is not
  // among the six named. Implemented literally as the blanket equity rule states —
  // credit — pending confirmation this omission wasn't the missing sixth exception.
  // CONTRA-EQUITY. Drawings REDUCE owner's equity, so the normal balance is DEBIT even
  // though the type is 'equity'. This is the sixth account that breaks derive-from-type,
  // alongside 1590 and the four contra-revenue accounts. Corrected 2026-08-23 (T-102 spec
  // named six exceptions but enumerated only five; the implementer flagged it rather than
  // guessing, which is why it is right).
  // ⛔ v1 nets drawings straight into equity__capital — its builder says so: "A separate
  // equity__drawings contra account is NOT used". That destroys both figures: a partner who put in
  // ₱500,000 and drew ₱300,000 becomes indistinguishable from one who contributed ₱200,000 and never
  // withdrew. A balance sheet shows "capital contributed" and "less: drawings" as separate lines.
  leaf('3200', "Owner's drawings", 'equity', 'debit', '3000', { requiresParty: true }), // 🆕 — never used in v1
  leaf('3300', 'Retained earnings', 'equity', 'credit', '3000'), // 🆕
  leaf('3900', 'Opening balance equity', 'equity', 'credit', '3000', {
    legacyCode: 'equity__opening_balance',
  }),

  // ---------------------------------------------------------------------------------
  // Revenue 4xxx — REVENUE AMENDMENT (Ian, 2026-08-23, superseding COA-ALIGNMENT.md and
  // the task spec's original Contract §2/§4 for this range): only TWO food accounts.
  // Take-out folds into à la carte; 4200 is REMOVED (not seeded). 4150 is ACTIVE, not
  // reserved — POS cannot split seated à la carte from counter take-out (no take-out
  // flag anywhere in POS), so a 4200 split would be an account the source data can never
  // populate correctly. A future channel-level split, if wanted, comes from the
  // `channel_id` dimension on journal lines, not a new account.
  // ---------------------------------------------------------------------------------
  leaf('4100', 'Food sales — unlimited (unli)', 'income', 'credit', '4000'), // 🆕
  leaf('4150', 'Food sales — à la carte (dine-in, take-out and delivery)', 'income', 'credit', '4000'), // 🆕, active
  // T-132. Every other 4xxx leaf is RETAIL - unli, a la carte, beverage. A sale to a
  // franchisee or an external buyer had no account of its own, so it went to whatever the
  // caller passed. An INTERNAL branch transfer does NOT belong here: it eliminates against
  // 5170 on consolidation (see the warning there), which is T-133's problem, not this one.
  // NOT 4200, deliberately: the amendment above REMOVED 4200 (the take-out split POS cannot
  // populate), and reusing that number would read as that account coming back. 4300 is clean.
  leaf('4300', 'Wholesale sales', 'income', 'credit', '4000'), // T-132
  leaf('4400', 'Beverage sales', 'income', 'credit', '4000'), // 🆕 — one lump account, amended 2026-08-23
  // 🆕 2026-08-25 (T-123, bible row 134). Ian: "we charge leftover charge, packaging charge and
  // other charges — I want them all in ONE account, separated from service charge."
  // ⭐ These are the BUSINESS's income and it keeps them. Service charge is the opposite: RA 11360
  // sends 100% of it to employees, so that one is a LIABILITY at 2160. Two kinds of "charge" that
  // look alike on a bill and are opposite in the books — which is exactly why they are separated.
  leaf('4500', 'Other charges — leftover, packaging and similar', 'income', 'credit', '4000'),
  // Contra-revenue exceptions — Contract §3.
  leaf('4900', 'Sales discounts', 'income', 'debit', '4000'), // 🆕 — senior/PWD, currently hardcoded to zero
  leaf('4910', 'Loyalty points redeemed', 'income', 'debit', '4000', { legacyCode: 'others__points' }),
  leaf('4920', 'Vouchers redeemed', 'income', 'debit', '4000', {
    legacyCode: 'others__voucher',
    status: 'reserved',
  }),
  leaf('4950', 'Sales returns and voids', 'income', 'debit', '4000'), // 🆕

  // ---------------------------------------------------------------------------------
  // Cost of sales 5xxx — the coarse §2 list, PLUS (T-102b) the granular 5110-5170 COGS
  // sub-accounts from COA-ALIGNMENT §4.1's expense-category -> account mapping table.
  //
  // T-102 seeded only the §2 list and left these 7 out — closing DEF-035. §2's own
  // summary row for this range ("5100 COGS — food · 5200 COGS — beverage") points at §4
  // for the detail; T-102's spec pointed only at §2, so the detail never got seeded even
  // though the source document always named it. See docs/tasks/102b-... task report.
  // ---------------------------------------------------------------------------------
  leaf('5100', 'COGS — food', 'expense', 'debit', '5000'), // 🆕
  leaf('5110', 'COGS — meat', 'expense', 'debit', '5000'), // 🆕 — T-102b, §4.1
  leaf('5120', 'COGS — sides', 'expense', 'debit', '5000'), // 🆕 — T-102b, §4.1
  leaf('5130', 'COGS — condiments and seasoning', 'expense', 'debit', '5000'), // 🆕 — T-102b, §4.1
  leaf('5140', 'COGS — sauces and dips', 'expense', 'debit', '5000'), // 🆕 — T-102b, §4.1
  leaf('5150', 'COGS — packaging', 'expense', 'debit', '5000'), // 🆕 — T-102b, §4.1
  leaf('5160', 'COGS — retail and consumables', 'expense', 'debit', '5000'), // 🆕 — T-102b, §4.1
  // 5170 — INTER-STORE WARNING (COA-ALIGNMENT §4.1, "Things that will bite" #5 in the
  // T-102b task spec). Commissary Purchases is not a third-party cost: at store level it
  // is real spend, but CONSOLIDATED it must ELIMINATE against the commissary's
  // transfer-out, or the same peso is COUNTED TWICE — once when the commissary buys the
  // raw material (into 1330), again when the branch "buys" from the commissary (into
  // this account). That is exactly why it is kept separate from 5110 rather than folded
  // in. Same reciprocal-elimination shape as the 1250/2150 due-from/due-to pair. No DB
  // column exists for a memo/comment on `accounts` (schema is out of scope for this
  // task), so the warning lives here, next to the account it describes, and in this
  // migration's own header comment.
  leaf('5170', 'COGS — commissary transfers', 'expense', 'debit', '5000'), // 🆕 — T-102b, §4.1
  // ⭐ T-133, 2026-08-28. THE OTHER HALF of 5170's elimination, which the comment above has
  // described since T-102b and which never existed until Ian asked how Malvar expenses what
  // Lipa processed. A CONTRA-COGS (expense / credit): the seller's cost leaves its P&L here
  // and lands in the buyer's 5170, so consolidated the two net to zero and the original
  // purchase is counted exactly once. Same contra shape as 4900/4950 on the income side.
  leaf('5175', 'Cost transferred to branches', 'expense', 'credit', '5000'), // 🆕 — T-133
  leaf('5200', 'COGS — beverage', 'expense', 'debit', '5000'), // 🆕
  leaf('5300', 'Wastage and spoilage', 'expense', 'debit', '5000', {
    legacyCode: 'expense__order_wastage',
  }), // moved from OPEX to COGS
  leaf('5400', 'Inventory adjustment', 'expense', 'debit', '5000'), // 🆕

  // ---------------------------------------------------------------------------------
  // Operating expenses 6xxx — the §2 list, PLUS (T-102b) 10 accounts from COA-ALIGNMENT
  // §4.2's OPEX-category -> account mapping table that T-102 left out. Closing DEF-035;
  // see the 5xxx block above and docs/tasks/102b-... task report for the full story.
  // ---------------------------------------------------------------------------------
  leaf('6100', 'Salaries and wages', 'expense', 'debit', '6000', { legacyCode: 'expense__salary' }),
  leaf('6110', 'Employer SSS contributions', 'expense', 'debit', '6000'), // 🆕
  leaf('6120', 'Employer PhilHealth contributions', 'expense', 'debit', '6000'), // 🆕
  leaf('6130', 'Employer Pag-IBIG contributions', 'expense', 'debit', '6000'), // 🆕
  leaf('6140', '13th month pay', 'expense', 'debit', '6000'), // 🆕
  leaf('6150', 'Salary additions and allowances', 'expense', 'debit', '6000', {
    legacyCode: 'expense__salary_additions',
  }),
  leaf('6160', 'Employee benefits and welfare', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2
  leaf('6200', 'Rent', 'expense', 'debit', '6000'), // 🆕
  leaf('6300', 'Utilities', 'expense', 'debit', '6000'), // 🆕
  leaf('6400', 'Platform and channel fees', 'expense', 'debit', '6000', {
    legacyCode: 'expense__platform_fee',
  }),
  leaf('6410', 'Online order expenses', 'expense', 'debit', '6000', {
    legacyCode: 'expense__online_order_expenses',
  }),
  // T-150. Settlement variance - a below-tolerance shortfall between what a channel-day
  // reported and what the platform actually settled. Its OWN account, deliberately: folded
  // into 6400 a channel that systematically under-remits by P40 a day reads as a slightly
  // worse fee rate and is never seen.
  leaf('6420', 'Channel settlement variance', 'expense', 'debit', '6000'), // T-150
  leaf('6500', 'Supplies', 'expense', 'debit', '6000'), // 🆕
  leaf('6510', 'Smallwares', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2; below-threshold half of the CAPEX/OPEX split, §4.5
  leaf('6600', 'Repairs and maintenance', 'expense', 'debit', '6000'), // 🆕
  leaf('6620', 'Pest control and waste management', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2
  leaf('6630', 'Vehicle and transportation', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2
  leaf('6650', 'Marketing and advertising', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2
  leaf('6700', 'Depreciation', 'expense', 'debit', '6000', { legacyCode: 'expense__depreciation' }),
  leaf('6750', 'Amortisation', 'expense', 'debit', '6000', { legacyCode: 'expense__amortization' }),
  leaf('6800', 'Taxes and licences', 'expense', 'debit', '6000', { legacyCode: 'expense__tax' }), // confirmed §3
  leaf('6850', 'Administrative expenses', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2
  leaf('6860', 'Bad debt expense', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2
  leaf('6870', 'Bank charges', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2
  leaf('6880', 'Insurance', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2
  leaf('6890', 'Subscriptions and software', 'expense', 'debit', '6000'), // 🆕 — T-102b, §4.2
  leaf('6900', 'Other operating expenses', 'expense', 'debit', '6000'), // 🆕 catch-all

  // ---------------------------------------------------------------------------------
  // Other income and expense 7xxx
  // ---------------------------------------------------------------------------------
  leaf('7100', 'Platform settlement gain', 'income', 'credit', '7000', {
    legacyCode: 'income__platform_settlement_gain',
  }),
  leaf('7200', 'Interest expense', 'expense', 'debit', '7000', { legacyCode: 'expense__interest' }),
  leaf('7310', 'Staff charge recovery', 'income', 'credit', '7000', {
    legacyCode: 'income__charge_recovery',
  }),
  leaf('7320', 'Wastage recovery', 'income', 'credit', '7000', {
    legacyCode: 'income__wastage_recovery',
  }),
  // FLAGGED — see task report. COA-ALIGNMENT types this "Income/Expense" (it swings
  // either way) rather than picking one — the schema's `type` column cannot hold both.
  // Implemented as expense/debit (the dominant textbook convention for "cash over and
  // short"). TWO fixed v1 ids collapse onto this one account
  // (`others__remittance_overage`, `others__remittance_variance`) — a 2:1 relationship,
  // so neither gets `legacyCode` under Contract §5's "stable 1:1" rule.
  leaf('7350', 'Cash over and short', 'expense', 'debit', '7000'),
  leaf('7400', 'Loss on disposal of assets', 'expense', 'debit', '7000', {
    legacyCode: 'expense__loss_on_disposal',
  }), // confirmed §3
] as const;

/** Every header code — used by `seedChartOfAccounts` to split the two insert phases. */
const HEADER_CODES: readonly string[] = CHART_OF_ACCOUNTS.filter((a) => a.parentCode === null).map(
  (a) => a.code,
);

export interface SeedResult {
  headersInserted: number;
  leavesInserted: number;
}

/**
 * Applies the chart of accounts to ONE organization, idempotently by (org_id, code).
 *
 * Two phases because leaves reference their header's surrogate id, which only exists
 * once the header row is committed:
 *   1. Insert the seven headers (ON CONFLICT (org_id, code) DO NOTHING).
 *   2. Insert every leaf, resolving parent_id via a join back to the org's own headers
 *      (ON CONFLICT (org_id, code) DO NOTHING).
 *
 * `DO NOTHING` (never `DO UPDATE`) is deliberate: re-running this must change zero
 * existing rows, not just avoid duplicate codes (Contract §6, invariant 6). Editing an
 * already-seeded row's name/type is a new, explicit migration, never a silent upsert.
 *
 * This function is the single implementation the migration's raw SQL mirrors and the
 * test suite exercises directly — see docs/tasks/102-chart-of-accounts-seed.md Method.
 * A future "create organization" flow should call this directly for a brand-new org
 * rather than waiting on a migration that can only ever reach orgs that already existed
 * when it ran (see task report — this migration seeds every org THAT EXISTS AT
 * MIGRATION-APPLY TIME; a new org created afterward needs this function called for it).
 */
export async function seedChartOfAccounts(sql: postgres.Sql, orgId: string): Promise<SeedResult> {
  const headers = CHART_OF_ACCOUNTS.filter((a) => a.parentCode === null);
  const leaves = CHART_OF_ACCOUNTS.filter((a) => a.parentCode !== null);

  // postgres.js's `sql(array)` helper only builds a plain `(cols) values (...)` clause
  // for a direct `insert into t ${sql(array)}` — it cannot be used as a joinable table
  // expression inside `from ... as v(...)`, which the leaf phase needs (it joins back to
  // the header rows). `jsonb_to_recordset` does the same "array of rows in, one bind
  // parameter" job and works uniformly as a FROM-clause source for both phases. It must
  // be bound via `sql.json(...)`, not a pre-stringified string cast with `::jsonb` — the
  // latter reaches Postgres double-encoded (a jsonb STRING holding JSON text, which
  // `jsonb_to_recordset` correctly refuses as "not an array") — confirmed against the
  // real local Postgres while writing this.
  const headerPayload = headers.map((h) => ({
    code: h.code,
    name: h.name,
    type: h.type,
    normal_balance: h.normalBalance,
    legacy_code: h.legacyCode,
    status: h.status,
    requires_party: h.requiresParty,
  }));

  const headerRows = await sql<{ id: string }[]>`
    insert into accounts (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, legacy_code, status, requires_party)
    select ${orgId}::uuid, v.code, v.name, v.type, v.normal_balance, null, false, true, v.legacy_code, v.status, v.requires_party
    from jsonb_to_recordset(${sql.json(headerPayload)})
      as v(code text, name text, type text, normal_balance text, legacy_code text, status text, requires_party boolean)
    on conflict (org_id, code) do nothing
    returning accounts.id
  `;

  const leafPayload = leaves.map((l) => ({
    code: l.code,
    name: l.name,
    type: l.type,
    normal_balance: l.normalBalance,
    parent_code: l.parentCode,
    legacy_code: l.legacyCode,
    status: l.status,
    requires_party: l.requiresParty,
  }));

  const leafRows = await sql<{ id: string }[]>`
    insert into accounts (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, legacy_code, status, requires_party)
    select ${orgId}::uuid, v.code, v.name, v.type, v.normal_balance, p.id, true, true, v.legacy_code, v.status, v.requires_party
    from jsonb_to_recordset(${sql.json(leafPayload)})
      as v(code text, name text, type text, normal_balance text, parent_code text, legacy_code text, status text, requires_party boolean)
    join accounts p on p.org_id = ${orgId}::uuid and p.code = v.parent_code
    on conflict (org_id, code) do nothing
    returning accounts.id
  `;

  return { headersInserted: headerRows.length, leavesInserted: leafRows.length };
}

/** Every reserved code in the seed — Contract §4, amended 2026-08-23. Exported so the
 * test suite's expectation and the seed data can never silently drift apart. */
export const RESERVED_CODES: readonly string[] = CHART_OF_ACCOUNTS.filter(
  (a) => a.status === 'reserved',
).map((a) => a.code);

/** Every requires_party = true code in the seed — T-118 Contract §2 (the nine control
 * accounts). Exported so the test suite's expectation and the seed data can never
 * silently drift apart, same precedent as RESERVED_CODES above. */
export const REQUIRES_PARTY_CODES: readonly string[] = CHART_OF_ACCOUNTS.filter(
  (a) => a.requiresParty,
).map((a) => a.code);

/** Sanity check used by the test suite — every header code referenced by a leaf must
 * actually exist as a header in this same array. */
export function isHeaderCode(code: string): boolean {
  return HEADER_CODES.includes(code);
}
