/**
 * T-108 — the worked examples. docs/tasks/108-worked-examples.md.
 *
 * THIS FILE IS THE SOURCE OF TRUTH. `docs/POSTING-PATTERNS.md` is written FROM these
 * fixtures and a test (tests/unit/posting-patterns-doc.test.ts) asserts the two cannot
 * disagree — every fixture id appears in the doc, and every pattern in the doc has a
 * fixture (Contract §1). Do not hand-edit an account, an amount, or a party in the doc
 * without changing it here first.
 *
 * Each fixture states the EXACT lines a business event posts — account, side, amount,
 * party, in order — proved by posting it through the real `postEntry` against real
 * Postgres and reading the result back from `journal_lines`
 * (tests/integration/posting-patterns.test.ts). "Balances" is not the bar; the wrong two
 * accounts balance perfectly too.
 *
 * Ordered per the spec: expense_payment, sale, salary_advance, transfer, depreciation
 * first (79% of v1's 12,824-leg corpus), then the rest of the Required table, then the
 * "Include; cheap" group, then three v2-only additions with no v1 sourceType (reversal is
 * proved generically over every fixture below rather than named per-fixture — see the
 * integration test's invariant 4).
 *
 * Money is always a decimal string. No arithmetic happens in this file — every amount is
 * typed by hand as a literal, exactly as it will be read back from `numeric(14,2)`
 * (invariant 12 asserts this structurally: no fixture source line matches a float
 * literal).
 */

export type PartyType =
  | 'supplier'
  | 'customer'
  | 'employee'
  | 'store'
  | 'channel'
  | 'money_account'
  | 'loan'
  | 'cash_request'
  | 'owner';

export interface PartyRef {
  type: PartyType;
  /** Free text — party_id carries no FK yet (DEF-040; suppliers/customers/channels are
   * Phase 2 tables). For party_type='store' this is the OTHER store's `code`, chosen by
   * the test fixture, not a database-generated id — see commissary_dispatch.transfer. */
  id: string;
}

export interface FixtureLine {
  /** e.g. '6200' — never a uuid (postEntry's own Contract §1). */
  accountCode: string;
  /** Exactly one of debit/credit is set; the other reads back '0.00'. Never both, never
   * neither — the same CHECK journal_lines_exactly_one_side_check enforces at the row. */
  debit?: string;
  credit?: string;
  /** Explicit on every line, `null` included — Contract §2's own rule. */
  party: PartyRef | null;
  /** The channel dimension (bible §16.4) — nullable, revenue/channel-fee lines only. */
  channelId?: string | null;
  /** Resolves to a real store id at test time — only commissary_dispatch.transfer needs
   * two distinct stores; every other fixture leaves this unset (store_id stays null). */
  storeRef?: 'commissary' | 'branch1';
  lineMemo?: string;
}

export interface WorkedExample {
  /** dotted-namespace id, e.g. 'expense.cash.simple'. Must be unique. Parsed out of
   * docs/POSTING-PATTERNS.md by the doc-parity test — see that file's own comment for the
   * exact grammar. */
  id: string;
  /** The real v1 sourceType this corresponds to (leg-mapping.ts's own naming, snake_case,
   * not T-113's kebab-case spec names — see that file's FINDING comment), or a v2-only tag
   * for the three additions with no v1 equivalent: 'reversal' (proved generically, not its
   * own fixture), 'year_close', 'opening_balance'. */
  sourceType: string;
  title: string;
  narrative: string;
  /** v1 leg count from the task spec's frequency table, where it has one — omitted for the
   * three v2-only additions and for the two owner-equity/liability-payment fixtures ADR-005
   * flags as required-for-January despite having no large v1 leg count of their own. */
  frequency?: number;
  /** What the module posting this would actually be given — illustrative, not executed. */
  input: Record<string, unknown>;
  /** The exact lines, in order. This is the fixture. */
  expect: FixtureLine[];
  /** Prior entries this fixture needs to exist first to be economically meaningful —
   * posted before `expect`, not themselves asserted as this fixture's own lines. Only
   * year_close.annual (needs real P&L activity to close) uses this — opening_balance.reconcile
   * deliberately does NOT: it depends on opening_balance.load's own entry, and is ordered
   * directly after it in this array, so the integration test's single shared corpus already
   * has load's posting by the time reconcile runs (re-declaring it as `setup` here would
   * double-post it — caught by invariant 10 during development, see that fixture's trap). */
  setup?: FixtureLine[][];
  /** YYYY-MM-DD. Same date used for every entry in `setup` too, unless a setup entry needs
   * its own date — see year_close.annual, which overrides per-setup-entry. */
  entryDate: string;
  /** Per-setup-entry date override, parallel to `setup` — only year_close.annual uses
   * this (its setup entries predate its own close date by definition). */
  setupEntryDates?: string[];
  /** Per-setup-entry sourceType override, parallel to `setup` — year_close.annual's setup
   * entries are ORDINARY sale/expense postings that happen to occur during the year being
   * closed, not year-close entries themselves. Without this, the test harness would tag them
   * with this fixture's own `sourceType` ('year_close'), and a default date-range P&L query
   * (which excludes source_type='year_close') would wrongly hide the very revenue/expense
   * activity invariant 11 needs to prove is NOT hidden — caught during development. */
  setupSourceTypes?: string[];
  /** The trap, the field that lies, the account that looks right and is not — written for
   * a human reading docs/POSTING-PATTERNS.md at 11pm. Optional; most fixtures don't need
   * one, but every fixture named in Contract §4 does. */
  trap?: string;
}

const D = (accountCode: string, amount: string, party: PartyRef | null = null, extra: Partial<FixtureLine> = {}): FixtureLine => ({
  accountCode,
  debit: amount,
  party,
  ...extra,
});
const C = (accountCode: string, amount: string, party: PartyRef | null = null, extra: Partial<FixtureLine> = {}): FixtureLine => ({
  accountCode,
  credit: amount,
  party,
  ...extra,
});

export const WORKED_EXAMPLES: readonly WorkedExample[] = [
  // =========================================================================================
  // expense_payment — 4,396 legs, the single most common event. Bible §16.0's diagnosis in
  // one word: v1 posts the funding leg(s) only (cash/AP/online OUT) and never the
  // classification leg (the expense account itself) — "there is no revenue or expense leg
  // at all." Every fixture below adds the missing classification leg back in.
  // =========================================================================================
  {
    id: 'expense.cash.simple',
    sourceType: 'expense_payment',
    title: 'Cash expense, single payment',
    narrative: 'A ₱1,200 delivery of pork paid in cash from the cashier drawer. A COGS category ' +
      '(meat) is expensed directly on receipt — this is the correct Phase 1 treatment: the ' +
      'two-stage purchase→inventory→consumption posting (COA-ALIGNMENT §4.1) needs real ' +
      'inventory tracking, which is Phase 3. Until then, a COGS purchase is a same-shape cash ' +
      'expense as any other, just posted to a 5xxx account instead of a 6xxx one.',
    frequency: 4396,
    input: { totalAmount: '1200.00', particulars: 'Pork delivery', expenseEntryGroup: 'COGS', payments: [{ method: 'cash', amount: '1200.00' }] },
    expect: [
      D('5100', '1200.00', null, { lineMemo: 'Pork delivery' }),
      C('1110', '1200.00', null, { lineMemo: 'cash payment #1' }),
    ],
    entryDate: '2026-01-15',
    trap: 'This posts to 5100 (COGS — food) even though inventory does not exist yet in this ' +
      'phase. Do not "wait for Phase 3" before posting expenses — the classification leg is ' +
      'required NOW (invariant 2); the two-stage inventory refinement is a LATER, additive ' +
      'change to where the debit lands, not a reason to omit it today.',
  },
  {
    id: 'expense.split.cash-online',
    sourceType: 'expense_payment',
    title: 'Split-payment expense — one entry, several credit lines',
    narrative: 'A ₱3,500 supplies order paid partly from the cashier drawer (₱2,000) and partly ' +
      'from an online wallet (₱1,500). The most common shape in the whole v1 dataset: ONE ' +
      'expense, SEVERAL payment methods, ONE journal entry with several credit lines.',
    frequency: 4396,
    input: {
      totalAmount: '3500.00', particulars: 'Kitchen supplies', expenseEntryGroup: 'OPEX',
      payments: [{ method: 'cash', amount: '2000.00' }, { method: 'online', amount: '1500.00', accountId: 'gcash-main' }],
    },
    expect: [
      D('6500', '3500.00', null, { lineMemo: 'Kitchen supplies' }),
      C('1110', '2000.00', null, { lineMemo: 'cash payment #1' }),
      C('1140', '1500.00', { type: 'money_account', id: 'money_account:gcash-cashier' }, { lineMemo: 'online payment #2' }),
    ],
    entryDate: '2026-01-15',
  },
  {
    id: 'expense.credit.ap',
    sourceType: 'expense_payment',
    title: 'Credit expense — books to AP, not cash',
    narrative: 'A ₱8,000 supplies order on 30-day terms from a named supplier. No cash moves; ' +
      'the obligation grows the AP control account instead.',
    frequency: 4396,
    input: { totalAmount: '8000.00', particulars: 'Packaging order', expenseEntryGroup: 'OPEX', supplierId: 'SUP-0450', payments: [{ method: 'credit', amount: '8000.00' }] },
    expect: [
      D('6500', '8000.00', null, { lineMemo: 'Packaging order' }),
      C('2110', '8000.00', { type: 'supplier', id: 'supplier:SUP-0450' }, { lineMemo: 'AP payment #1' }),
    ],
    entryDate: '2026-01-15',
    trap: '2110 is a control account (T-118, DEF-037). Every credit-method payment MUST carry ' +
      'the supplier as a party or the database rejects the line outright — DEF-049 found that ' +
      '`postEntry` could not do this at all until this task fixed it. A credit expense with no ' +
      'supplierId is not postable; it quarantines (see packages/etl/src/convert.ts\'s ' +
      "`missing_supplier_party` reason) rather than posting an unattributable control line.",
  },
  {
    id: 'expense.reimbursable',
    sourceType: 'expense_payment',
    title: 'Reimbursable expense — staff paid out of pocket, company owes them',
    narrative: "A staff member fronted ₱650 for an emergency repair. The company now owes THEM " +
      '— a liability, not an asset, confirming bible §COA-ALIGNMENT §3 answer #1: "we owe to ' +
      'staff — staff own money they spend for business needs."',
    frequency: 4396,
    input: { totalAmount: '650.00', particulars: 'Emergency AC repair', expenseEntryGroup: 'OPEX', payments: [{ method: 'reimbursable', amount: '650.00', staffId: 'STAFF-0128' }] },
    expect: [
      D('6600', '650.00', null, { lineMemo: 'Emergency AC repair' }),
      C('2130', '650.00', { type: 'employee', id: 'employee:STAFF-0128' }, { lineMemo: 'reimbursable payment #1' }),
    ],
    entryDate: '2026-01-15',
    trap: 'Reimbursement is expense-FIRST, cash-LATER — the opposite of a salary advance ' +
      '(cash-first, an asset). Booking this as an asset is the live v1 misclassification ' +
      "COA-ALIGNMENT's §3 answer #1 corrects: today it defaults to the debit side because " +
      "`inferAccountNature` has no rule for `staff_reimbursable__`, understating liabilities.",
  },

  // =========================================================================================
  // reimbursement — the settlement half of expense.reimbursable, completing create -> pay.
  // Not its own v1 sourceType (v1's builder is `reimbursement_payout`) but named explicitly
  // in bible §16.10's minimum-pattern list.
  // =========================================================================================
  {
    id: 'reimbursement.payout',
    sourceType: 'reimbursement_payout',
    title: 'Reimbursement payout — settling the liability created above',
    narrative: 'The ₱650 owed to the staff member from expense.reimbursable is paid out in cash. ' +
      'Pure balance sheet — the expense was already recognised when the liability was created.',
    input: { staffId: 'STAFF-0128', amount: '650.00', method: 'cash' },
    expect: [
      D('2130', '650.00', { type: 'employee', id: 'employee:STAFF-0128' }, { lineMemo: 'reimbursement payout' }),
      C('1110', '650.00', null, { lineMemo: 'cash payout' }),
    ],
    entryDate: '2026-01-20',
  },

  // =========================================================================================
  // sale — 2,945 legs. v1's OWN builder (sale.builder.ts) posts ONLY the cash/online legs —
  // zero revenue, zero discount, zero comp lines, ever (confirmed by reading it directly,
  // read-only). This is bible §16.0's diagnosis at its starkest: a ₱2,945-leg sourceType with
  // NO nominal leg at all. The pattern below is what convertSalesDay (packages/etl/src/
  // convert.ts, already implemented and tested against real Postgres by T-113/T-117) already
  // synthesises — this fixture set formalises that already-decided pattern, not a new one.
  // =========================================================================================
  {
    id: 'sale.unli.simple',
    sourceType: 'sale',
    title: 'Dine-in unlimited (unli), cash only',
    narrative: 'A ₱5,600 day of pure unli sales, paid entirely in cash. `dineInSales` maps ' +
      'straight to 4100 — GLOSSARY.md: dineInSales means UNLIMITED-PACKAGE sales only, not ' +
      '"all dine-in", and it needs no reconstruction because POS already computes it that way.',
    frequency: 2945,
    input: { id: '2026-01-15', totalSales: 5600.0, dineInSales: 5600.0, takeOutSales: 0, cashPayments: 5600.0, seniorDiscount: 0, pwdDiscount: 0, otherDiscount: 0, totalDiscounts: 0, comps: 0 },
    expect: [
      D('1110', '5600.00', null, { lineMemo: 'cash tender' }),
      C('4100', '5600.00', null, { lineMemo: 'dine-in unlimited' }),
    ],
    entryDate: '2026-01-15',
  },
  {
    id: 'sale.alacarte.simple',
    sourceType: 'sale',
    title: 'À la carte — includes dine-in à la carte, take-out AND delivery',
    narrative: 'A ₱780 day of à la carte sales, cash only. `takeOutSales` is the field name, but ' +
      "GLOSSARY.md warns it is a RESIDUAL — `Math.max(0, totalGross - dineInSales)` — that " +
      'absorbs dine-in à la carte, take-out, and delivery alike, because POS has no take-out ' +
      'flag at all (COA-ALIGNMENT §2: 4200 was withdrawn for exactly this reason). It all posts ' +
      'to 4150.',
    frequency: 2945,
    input: { id: '2026-01-16', totalSales: 780.0, dineInSales: 0, takeOutSales: 780.0, cashPayments: 780.0, seniorDiscount: 0, pwdDiscount: 0, otherDiscount: 0, totalDiscounts: 0, comps: 0 },
    expect: [
      D('1110', '780.00', null, { lineMemo: 'cash tender' }),
      C('4150', '780.00', null, { lineMemo: 'à la carte (incl. take-out)' }),
    ],
    entryDate: '2026-01-16',
    trap: '`takeOutSales` is NOT a measurement of take-out orders — never chart it as one. A ' +
      'non-zero value is everything that is not unli: dine-in à la carte, take-out, delivery, ' +
      'all mixed together. Treat it as a reconciliation signal, never a revenue breakdown.',
  },
  {
    id: 'sale.discount.senior-pwd',
    sourceType: 'sale',
    title: 'Senior / PWD discount — contra-revenue, never an expense',
    narrative: 'A ₱1,000 unli sale with a ₱200 senior-citizen discount; ₱800 cash actually ' +
      'tendered. In v1 this discount is HARDCODED TO ZERO on the live sales-entry path (bible ' +
      '§16.7 defect #3) — the worked example is what it SHOULD be, and the gap is the finding.',
    frequency: 2945,
    input: { id: '2026-01-17', totalSales: 1000.0, dineInSales: 1000.0, takeOutSales: 0, cashPayments: 800.0, seniorDiscount: 200.0, pwdDiscount: 0, otherDiscount: 0, totalDiscounts: 200.0, comps: 0 },
    expect: [
      D('1110', '800.00', null, { lineMemo: 'cash tender' }),
      D('4900', '200.00', null, { lineMemo: 'senior/PWD/other discount' }),
      C('4100', '1000.00', null, { lineMemo: 'dine-in unlimited' }),
    ],
    entryDate: '2026-01-17',
    trap: 'No VAT is computed anywhere — Shareat System is a management ledger, not a statutory ' +
      'filing basis (bible decision #75). This discount reduces revenue for internal reporting; ' +
      'it is not a BIR VAT-exemption computation and must never be presented as one.',
  },
  {
    id: 'sale.comps',
    sourceType: 'sale',
    title: 'Comps — contra-revenue, never marketing expense',
    narrative: 'A ₱500 unli sale where ₱100 of it was comped (given away complimentary); ₱400 ' +
      'cash tendered. Ian confirmed directly: comps are revenue foregone, never a cost incurred.',
    frequency: 2945,
    input: { id: '2026-01-18', totalSales: 500.0, dineInSales: 500.0, takeOutSales: 0, cashPayments: 400.0, seniorDiscount: 0, pwdDiscount: 0, otherDiscount: 0, totalDiscounts: 0, comps: 100.0 },
    expect: [
      D('1110', '400.00', null, { lineMemo: 'cash tender' }),
      D('4950', '100.00', null, { lineMemo: 'comps' }),
      C('4100', '500.00', null, { lineMemo: 'dine-in unlimited' }),
    ],
    entryDate: '2026-01-18',
    trap: 'Comps post to 4950 (Sales returns and voids), NOT 4900 (Sales discounts) — confirmed ' +
      'by bible decision-log row 74 ("comps are contra-revenue (4950), not marketing expense"), ' +
      'docs/GLOSSARY.md\'s own comps entry, and packages/etl/src/convert.ts\'s already-tested ' +
      "`ACCOUNTS.SALES_RETURNS_AND_VOIDS` mapping. T-108's own task spec text says \"DR 4900\" " +
      'for comps in its §4 table — that line is WRONG, contradicted by three independent, ' +
      'already-decided sources, and is reported as a spec defect in the task report rather than ' +
      'followed. 4900 is reserved for senior/PWD/other DISCOUNTS; comps are a distinct account.',
  },
  {
    id: 'sale.mixed',
    sourceType: 'sale',
    title: 'The full pattern — cash, online, unli, à la carte, discount and comps together',
    narrative: 'A ₱5,450 day: ₱3,000 cash, ₱2,000 online, ₱300 discount, ₱150 comps, ₱4,450 of ' +
      'it unli and ₱1,000 à la carte. The complete shape every module should copy — six lines, ' +
      'debits (tender + contra-revenue) first, credits (revenue) last.',
    frequency: 2945,
    input: {
      id: '2026-01-19', totalSales: 5450.0, dineInSales: 4450.0, takeOutSales: 1000.0,
      cashPayments: 3000.0, onlineBreakdown: { 'gcash-main': 2000.0 },
      seniorDiscount: 300.0, pwdDiscount: 0, otherDiscount: 0, totalDiscounts: 300.0, comps: 150.0,
    },
    expect: [
      D('1110', '3000.00', null, { lineMemo: 'cash tender' }),
      D('1140', '2000.00', { type: 'money_account', id: 'money_account:gcash-main' }, { lineMemo: 'online: gcash-main' }),
      D('4900', '300.00', null, { lineMemo: 'senior/PWD/other discount' }),
      D('4950', '150.00', null, { lineMemo: 'comps' }),
      C('4100', '4450.00', null, { lineMemo: 'dine-in unlimited' }),
      C('4150', '1000.00', null, { lineMemo: 'à la carte (incl. take-out)' }),
    ],
    entryDate: '2026-01-19',
    trap: 'The balance identity is TWO separate checks, not one: (1) cash + online + discounts ' +
      '+ comps = totalSales (the tender side), AND (2) dineInSales + takeOutSales = totalSales ' +
      '(the revenue side). A sales day that fails either quarantines rather than posting a ' +
      'guessed entry (T-113 §3 rule 1 — never guess a mapping).',
  },

  // =========================================================================================
  // salary_advance — 1,488 legs. leg-mapping.ts FINDING: disbursement and repayment (the
  // common cases) are PURE balance sheet, never P&L — only the rarer "charge" txType touches
  // a counter account. 1230 is a requires_party control account (party=employee).
  // =========================================================================================
  {
    id: 'salary_advance.disbursement',
    sourceType: 'salary_advance',
    title: 'Salary advance — cash out, an asset grows',
    narrative: 'A staff member draws a ₱3,000 salary advance in cash. An advance is CASH-first — ' +
      'an asset — the mirror image of a reimbursement (expense-first, a liability).',
    frequency: 1488,
    input: { staffId: 'STAFF-0201', amount: '3000.00', txType: 'disbursement' },
    expect: [
      D('1230', '3000.00', { type: 'employee', id: 'employee:STAFF-0201' }, { lineMemo: 'salary advance disbursed' }),
      C('1110', '3000.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-01-20',
  },
  {
    id: 'salary_advance.repayment',
    sourceType: 'salary_advance',
    title: 'Salary advance repayment — a payroll deduction settles it',
    narrative: 'A ₱500 payroll deduction repays part of the same advance. Cash never actually ' +
      'moves for a payroll-deducted repayment in practice, but the GL effect is identical to a ' +
      'cash repayment — the advance shrinks.',
    frequency: 1488,
    input: { staffId: 'STAFF-0201', amount: '500.00', txType: 'repayment' },
    expect: [
      D('1110', '500.00', null, { lineMemo: 'advance repaid' }),
      C('1230', '500.00', { type: 'employee', id: 'employee:STAFF-0201' }, { lineMemo: 'salary advance reduced' }),
    ],
    entryDate: '2026-02-05',
    trap: 'Most salary_advance legs (disbursement, repayment) NEVER touch P&L — only the rare ' +
      '"charge" txType does, and even then the counter-account is caller-supplied. Do not ' +
      "assume this sourceType is nominal by default; T-113's Class-A list said so and was wrong.",
  },

  // =========================================================================================
  // transfer — 926 legs. "Source OUT + target IN, both balance-sheet" — but leg-mapping's own
  // FINDING: with a fee, a THIRD leg posts to an expense account. Not party-requiring; these
  // are ordinary asset-to-asset cash movements, not inter-store (that is commissary_dispatch).
  // =========================================================================================
  {
    id: 'transfer.cash.simple',
    sourceType: 'transfer',
    title: 'Cash transfer — cashier drawer to the office',
    narrative: 'A routine ₱15,000 move from the cashier drawer to the office safe. Pure ' +
      'balance-sheet, source OUT, target IN.',
    frequency: 926,
    input: { fromAccountId: 'cash__cashier', toAccountId: 'cash__office', amount: '15000.00' },
    expect: [
      D('1130', '15000.00', null, { lineMemo: 'received from cashier' }),
      C('1110', '15000.00', null, { lineMemo: 'transferred to office' }),
    ],
    entryDate: '2026-01-21',
  },
  {
    id: 'transfer.cash.with-fee',
    sourceType: 'transfer',
    title: 'Transfer with a bank fee — NOT always pure balance sheet',
    narrative: 'A ₱10,000 online-to-office transfer costs a ₱50 bank fee, so only ₱9,950 lands. ' +
      'leg-mapping.ts flags this directly: a fee-bearing transfer posts a THIRD leg to a ' +
      'caller-chosen (typically expense) account — "transfer never touches P&L" is not quite ' +
      'right.',
    frequency: 926,
    input: { fromAccountId: 'online__gcash-main', toAccountId: 'cash__office', amount: '10000.00', feeAccountId: 'expense__bank_fees', feeAmount: '50.00' },
    expect: [
      D('1130', '9950.00', null, { lineMemo: 'received net of fee' }),
      D('6870', '50.00', null, { lineMemo: 'bank charges' }),
      C('1140', '10000.00', { type: 'money_account', id: 'money_account:gcash-main' }, { lineMemo: 'transferred from online' }),
    ],
    entryDate: '2026-01-22',
    trap: 'Do not assume every transfer is P&L-free. When `feeAccountId` is set, a real expense ' +
      'leg exists and must be included — omitting it would silently understate the fee expense ' +
      'while still balancing (the entry balances either way; only the ACCOUNT is wrong).',
  },

  // =========================================================================================
  // depreciation — 362 legs. Always both legs, no conditionality (leg-mapping.ts: "always
  // both"). One of ADR-005's five capabilities that "cannot wait past January."
  // =========================================================================================
  {
    id: 'depreciation.monthly',
    sourceType: 'depreciation',
    title: 'Monthly depreciation — a real expense, always posted in the period earned',
    narrative: 'A ₱4,200 monthly depreciation charge on kitchen equipment. Bible DEF-044: v1\'s ' +
      'depreciation scheduler stopped running for two straight months, confirmed by Ian — this ' +
      'fixture pins what SHOULD run every month without fail.',
    frequency: 362,
    input: { assetId: 'ASSET-0091', monthlyDepreciation: '4200.00' },
    expect: [
      D('6700', '4200.00', null, { lineMemo: 'monthly depreciation' }),
      C('1590', '4200.00', null, { lineMemo: 'accumulated depreciation' }),
    ],
    entryDate: '2026-01-31',
  },

  // =========================================================================================
  // loan_payment (221) / loan_disbursement (4, "Include; cheap"). leg-mapping FINDING:
  // disbursement is ALWAYS pure balance sheet (no interest leg, ever); payment is nominal
  // ONLY when interestAmount > 0. 2400 requires party (the lender).
  // =========================================================================================
  {
    id: 'loan_payment.principal-only',
    sourceType: 'loan_payment',
    title: 'Loan payment, principal only — zero P&L lines',
    narrative: 'A ₱5,000 principal-only repayment on a term loan. No interest this instalment, ' +
      'so no P&L leg at all — pure balance sheet, exactly like leg-mapping.ts records.',
    frequency: 221,
    input: { loanId: 'LOAN-0007', lenderId: 'metrobank-term-loan', principalAmount: '5000.00', interestAmount: '0.00' },
    expect: [
      D('2400', '5000.00', { type: 'supplier', id: 'supplier:metrobank-term-loan' }, { lineMemo: 'principal repayment' }),
      C('1110', '5000.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-02-01',
    trap: '2400\'s documented party_type is "supplier" even though the counterparty is a ' +
      'LENDER, not a supplier of goods (T-118 Contract §2: "Loans payable → supplier (the ' +
      'lender)"). This is a deliberate, if unusual, reuse of the closed party_type enum rather ' +
      'than adding a sixth type for one account — do not invent a "lender" party_type.',
  },
  {
    id: 'loan_payment.with-interest',
    sourceType: 'loan_payment',
    title: 'Loan payment with interest — the conditional P&L leg appears',
    narrative: 'A ₱4,800 instalment: ₱4,500 principal, ₱300 interest. The interest leg only ' +
      'exists this time because interestAmount > 0 — T-113\'s "Class A — nominal" table implied ' +
      'this sourceType is always nominal; leg-mapping.ts found that is only conditionally true.',
    frequency: 221,
    input: { loanId: 'LOAN-0007', lenderId: 'metrobank-term-loan', principalAmount: '4500.00', interestAmount: '300.00' },
    expect: [
      D('2400', '4500.00', { type: 'supplier', id: 'supplier:metrobank-term-loan' }, { lineMemo: 'principal repayment' }),
      D('7200', '300.00', null, { lineMemo: 'interest expense' }),
      C('1110', '4800.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-03-01',
  },
  {
    id: 'loan_disbursement.simple',
    sourceType: 'loan_disbursement',
    title: 'Loan disbursement — cash in, a liability grows, never P&L',
    narrative: 'A ₱50,000 term loan is drawn down. Always balance-sheet-only — no interest leg ' +
      'ever exists on a disbursement (leg-mapping.ts FINDING: this is unconditional, unlike the ' +
      'repayment side).',
    frequency: 4,
    input: { loanId: 'LOAN-0008', lenderId: 'metrobank-term-loan', amount: '50000.00' },
    expect: [
      D('1110', '50000.00', null, { lineMemo: 'loan proceeds' }),
      C('2400', '50000.00', { type: 'supplier', id: 'supplier:metrobank-term-loan' }, { lineMemo: 'loan drawn' }),
    ],
    entryDate: '2026-01-10',
  },

  // =========================================================================================
  // ar_collection — 176 legs. THE marquee example (Contract §4): v1 recognised the platform
  // fee TWICE and it cost ₱198,148.29 across two stores, 37 duplicate expense documents
  // voided (discovery 06 §3.2). Three legs, always distinct: gross receivable cleared, cash
  // actually received, fee expensed — never any other combination.
  // =========================================================================================
  {
    id: 'ar_collection.with-platform-fee',
    sourceType: 'ar_collection',
    title: 'AR collection with a platform fee — the double-count this prevents',
    narrative: 'A ₱5,000 receivable from a Grab settlement collects with a ₱250 platform fee ' +
      'deducted at source; only ₱4,750 actually lands in the bank. Three legs, once, correctly: ' +
      'this is the exact shape that stops the fee being expensed a second time elsewhere.',
    frequency: 176,
    input: { customerId: 'CUST-CH-GRAB', grossApplied: '5000.00', actualReceived: '4750.00', platformFee: '250.00' },
    expect: [
      D('1110', '4750.00', null, { lineMemo: 'cash actually received', channelId: 'grab' }, ),
      D('6400', '250.00', null, { lineMemo: 'platform fee', channelId: 'grab' }),
      C('1210', '5000.00', { type: 'customer', id: 'customer:CUST-CH-GRAB' }, { lineMemo: 'gross receivable cleared', channelId: 'grab' }),
    ],
    entryDate: '2026-02-10',
    trap: 'This platform fee is booked HERE, ONCE, as part of the collection. It must NEVER ' +
      'also be booked as a separate expense document for the same settlement — that double ' +
      'posting is the confirmed v1 defect (discovery 06 §3.2) that cost ₱198,148.29 across two ' +
      'stores. A module that both posts this collection AND lets someone manually expense ' +
      '"platform fee" for the same settlement has reintroduced the bug.',
  },
  {
    id: 'ar_collection.no-fee',
    sourceType: 'ar_collection',
    title: 'AR collection, no fee — the conditional leg genuinely absent',
    narrative: 'A ₱2,000 receivable collects in full, no platform fee applies. Two legs only — ' +
      "6400 does not appear at all; T-113 treated this account as unconditional, and it is not.",
    frequency: 176,
    input: { customerId: 'CUST-ACME', grossApplied: '2000.00', actualReceived: '2000.00', platformFee: '0.00' },
    expect: [
      D('1110', '2000.00', null, { lineMemo: 'cash actually received' }),
      C('1210', '2000.00', { type: 'customer', id: 'customer:CUST-ACME' }, { lineMemo: 'gross receivable cleared' }),
    ],
    entryDate: '2026-02-11',
  },

  // =========================================================================================
  // ap_payment — 93 legs. "Source cash/online OUT + ap__ OUT (allocated) + optional
  // supplier_advance__ IN (overpayment)." bible §16.10's own rule: overpayment goes to a
  // NAMED home account, never to nowhere.
  // =========================================================================================
  {
    id: 'ap_payment.simple',
    sourceType: 'ap_payment',
    title: 'AP payment — clears exactly what is owed',
    narrative: 'A ₱12,000 payment to a supplier, applied exactly against the outstanding AP ' +
      'balance. No overpayment, no residual.',
    frequency: 93,
    input: { supplierId: 'SUP-0450', amountApplied: '12000.00', amountPaid: '12000.00' },
    expect: [
      D('2110', '12000.00', { type: 'supplier', id: 'supplier:SUP-0450' }, { lineMemo: 'AP cleared' }),
      C('1110', '12000.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-02-15',
  },
  {
    id: 'ap_payment.overpayment',
    sourceType: 'ap_payment',
    title: 'AP payment with an overpayment — never floats to nowhere',
    narrative: 'An ₱8,000 AP balance is paid with ₱8,500, ₱500 more than owed. The extra becomes ' +
      'a NAMED supplier advance asset, not an unallocated credit sitting unexplained.',
    frequency: 93,
    input: { supplierId: 'SUP-0450', amountApplied: '8000.00', amountPaid: '8500.00' },
    expect: [
      D('2110', '8000.00', { type: 'supplier', id: 'supplier:SUP-0450' }, { lineMemo: 'AP cleared' }),
      D('1240', '500.00', { type: 'supplier', id: 'supplier:SUP-0450' }, { lineMemo: 'overpayment held as advance' }),
      C('1110', '8500.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-02-16',
    trap: 'Payments must name the open items they settle. Overpayment goes to 1240 (Advances to ' +
      'suppliers) — a real, party-carrying asset — NEVER to an unallocated cash-in-limbo state. ' +
      'The same supplier both owes and is owed simultaneously here, and that is correct, not a ' +
      'contradiction: 2110 and 1240 are different accounts for a reason.',
  },

  // =========================================================================================
  // cash_request_release (82) / cash_request_return (52) — the pair, together. leg-mapping:
  // "Source OUT + cash__staff IN" / "cash__staff OUT + return-target IN".
  //
  // ⭐ 1120 IS party-requiring in v2 and is NOT in v1 (T-144, bible row 159). One store has ONE
  // staff-float account and TWO PEOPLE CAN HOLD FLOATS AT ONCE — without a party that is a single
  // indistinguishable balance, and "who still owes a liquidation?" would need a second register,
  // which is how v1's loans ended up with three. The legs are otherwise v1's exactly.
  // =========================================================================================
  {
    id: 'cash_request.release',
    sourceType: 'cash_request_release',
    title: 'Cash request release — a float handed to a staff custodian',
    narrative: 'A ₱2,000 cash float is released from the cashier drawer to a staff member for a ' +
      'market run. Pure balance sheet; the operational REQUEST itself (bible §16.10) has no GL ' +
      'effect at all — only the release does.',
    frequency: 82,
    input: { staffId: 'STAFF-0201', amount: '2000.00' },
    expect: [
      D('1120', '2000.00', { type: 'cash_request', id: 'cash_request:CR-0201' }, { lineMemo: 'cash float released' }),
      C('1110', '2000.00', null, { lineMemo: 'cashier drawer out' }),
    ],
    entryDate: '2026-01-25',
  },
  {
    id: 'cash_request.return',
    sourceType: 'cash_request_return',
    title: 'Cash request return — the unused float comes back',
    narrative: 'Of the ₱2,000 float, ₱350 is unspent and returned to the cashier drawer.',
    frequency: 52,
    input: { staffId: 'STAFF-0201', amount: '350.00' },
    expect: [
      D('1110', '350.00', null, { lineMemo: 'unused float returned' }),
      C('1120', '350.00', { type: 'cash_request', id: 'cash_request:CR-0201' }, { lineMemo: 'cash float reduced' }),
    ],
    entryDate: '2026-01-25',
  },

  // =========================================================================================
  // commissary_dispatch — 70 legs. The inter-store elimination case. No v1 leg-mapping entry
  // exists (v1's `commissary_receive` sourceType is DEAD at the financial layer and
  // name-collides with an inventory-ledger type of the same string — COA-ALIGNMENT §2
  // "Retire" table) — this is a genuine v2 design, built from the reciprocal-account pattern
  // COA-ALIGNMENT §2 already specifies for due-from/due-to. Bible §12 row 27's fix ("one real
  // ACID transaction; both stores are rows in one database") makes this ONE journal entry
  // spanning two stores, not v1's "fake distributed transaction" (two best-effort writes).
  // Phase 3 owns VALUATION (weighted average, real stock movement); this fixture owns the
  // SHAPE only, per the task spec's own framing.
  // =========================================================================================
  {
    id: 'commissary_dispatch.transfer',
    sourceType: 'commissary_dispatch',
    title: 'Commissary dispatch and branch receipt — one entry, two stores, must eliminate',
    narrative: 'A 100 kg meat slab bought at ₱300/kg and processed at ₱10/kg ships from the ' +
      'Malvar commissary to the Lipa branch at its ₱310/kg transfer price. ONE real transaction ' +
      "(not two best-effort writes): the commissary's COST leaves its P&L and it books a " +
      "receivable from the branch; the branch expenses what it received and books a payable.",
    frequency: 70,
    input: { commissaryStoreCode: 'STORE-COMMISSARY', branchStoreCode: 'STORE-BRANCH1', amount: '31000.00' },
    expect: [
      C('5175', '31000.00', null, { storeRef: 'commissary', lineMemo: 'cost transferred out' }),
      D('1250', '31000.00', { type: 'store', id: 'STORE-BRANCH1' }, { storeRef: 'commissary', lineMemo: 'due from branch' }),
      D('5170', '31000.00', null, { storeRef: 'branch1', lineMemo: 'commissary transfer received' }),
      C('2150', '31000.00', { type: 'store', id: 'STORE-COMMISSARY' }, { storeRef: 'branch1', lineMemo: 'due to commissary' }),
    ],
    entryDate: '2026-02-20',
    trap: 'COST moves, NOT inventory — this system is PERIODIC (every expense category maps to a ' +
      '5xxx COGS account; nothing anywhere debits 1310/1330/1340), so moving inventory drove the ' +
      "seller's 1330 negative and stranded the cost in the seller's P&L. 5175 is the transfer-out " +
      "half that 5170's own chart comment has demanded since T-102b. This must ELIMINATE at " +
      'entity level twice over: 1250 equals 2150, and 5170 equals 5175, across all stores — ' +
      "bible invariant 6's reciprocal check. Party_id for a party_type='store' line is the OTHER " +
      "store's `code`, not a database id — there is no party FK yet (DEF-040).",
  },

  // =========================================================================================
  // T-174 — what happens to the goods that never arrived. The two dispositions that POST.
  // =========================================================================================
  {
    id: 'commissary.discrepancy-loss',
    sourceType: 'trade_discrepancy',
    title: 'Transit shortfall written off as a loss — 1340 emptied, at cost',
    narrative:
      'The Lipa branch signed for 90 of the 100 kg Malvar dispatched. T-173 posted what arrived ' +
      'and left \u20b13,000 \u2014 ten kilos AT COST \u2014 sitting in 1340, because goods that visibly left ' +
      'one building and did not reach another are a real asset until somebody says otherwise. ' +
      'The commissary manager says they spoiled on the road.',
    input: { discrepancyId: 'DISC-0001', disposition: 'loss', quantity: '10.000', value: '3000.00' },
    expect: [
      D('5300', '3000.00', null, { storeRef: 'commissary', lineMemo: 'lost in transit to branch' }),
      C('1340', '3000.00', null, { storeRef: 'commissary', lineMemo: 'transit cleared' }),
    ],
    entryDate: '2026-02-22',
    trap: 'AT COST (\u20b1300/kg), never at the \u20b1310 transfer rate \u2014 cost is what 1340 is holding, and ' +
      'relieving it at the transfer value would empty the account by \u20b1100 more than the dispatch ' +
      'put into it. That is DEF-098 in a second place. And 5300, not 5400: a count variance is a ' +
      'CORRECTION to the books, while goods that left one building and did not reach another are ' +
      'a LOSS \u2014 different facts, different accounts (T-164 \u00a72).',
  },
  {
    id: 'commissary.discrepancy-charge',
    sourceType: 'trade_discrepancy',
    title: 'Transit shortfall charged to the driver — an ASSET, not an expense',
    narrative:
      'The same \u20b13,000 gap, decided differently: the commissary manager recovers it from the ' +
      'driver who signed for the crates. It becomes a receivable from that person, to be drawn ' +
      'down by a payroll deduction \u2014 not a cost of doing business.',
    input: { discrepancyId: 'DISC-0002', disposition: 'charge', chargePerson: 'PERSON-DRIVER', value: '3000.00' },
    expect: [
      D('1230', '3000.00', { type: 'employee', id: 'PERSON-DRIVER' }, { storeRef: 'commissary', lineMemo: 'charged to driver' }),
      C('1340', '3000.00', null, { storeRef: 'commissary', lineMemo: 'transit cleared' }),
    ],
    entryDate: '2026-02-22',
    trap: '1230 is an ASSET and requires a party \u2014 the PERSON, party_type employee. \u26d4 Nothing in ' +
      'the codebase ever CREDITS 1230 (DEF-099): the payroll deduction that draws it down is ' +
      'Phase 5 and does not exist, so this receivable currently only grows \u2014 the same shape as ' +
      "DEF-082's service-charge float. The charge is still offered rather than blocked, because " +
      'refusing it would force a recoverable shortfall to be written off as a loss instead.',
  },

  // =========================================================================================
  // channel_settlement — T-150. The document that finally clears 1220, which nothing ever did.
  // =========================================================================================
  {
    id: 'channel_settlement.plain',
    sourceType: 'channel_settlement',
    title: 'Channel settlement — fees to real accounts, receivable to exactly zero',
    narrative:
      'A \u20b1100,000 Foodpanda day settles: \u20b120,000 commission, \u20b1500 withheld at source, ' +
      '\u20b179,500 banked. Every fee lands in the account that names it, and the receivable clears ' +
      'to EXACTLY zero rather than near zero.',
    input: {
      channel: 'Foodpanda',
      businessDate: '2026-01-10',
      grossAmount: '100000.00',
      commission: '20000.00',
      withholdingTax: '500.00',
      netDeposited: '79500.00',
    },
    expect: [
      D('1140', '79500.00', { type: 'money_account', id: 'MA-PAYOUT' }, { lineMemo: 'Foodpanda settlement' }),
      D('6400', '20000.00', null, { lineMemo: 'Commission' }),
      D('6800', '500.00', null, { lineMemo: 'Withholding tax' }),
      C('1220', '100000.00', { type: 'channel', id: 'CH-FOODPANDA' }, { lineMemo: 'Foodpanda settlement' }),
    ],
    entryDate: '2026-01-15',
    trap:
      'The withheld tax is an EXPENSE, not an asset. RR 2-98 \u00a72.58.3(B) allows a creditable ' +
      'withholding tax to be claimed only when the income payment has been declared as part of ' +
      'gross income with the 2307 attached, and bible \u00a713 row 75 records that reported sales are ' +
      'not all sales and this ledger is never a filing basis. The credit cannot be realised, so ' +
      'there is no future benefit and therefore no asset. Do NOT seed a 1270 creditable- ' +
      'withholding asset: an account that exists invites someone to use it.',
  },
  {
    id: 'channel_settlement.promo_credit',
    sourceType: 'channel_settlement',
    title: 'Channel settlement — a NEGATIVE deduction, which is a real credit',
    narrative:
      'A \u20b150,000 day where the platform charged \u20b18,000 commission and handed back \u20b11,000 of ' +
      'promo funding. The credit leg is the point.',
    input: {
      channel: 'Foodpanda',
      businessDate: '2026-01-10',
      grossAmount: '50000.00',
      commission: '8000.00',
      platformFee: '-1000.00',
      netDeposited: '43000.00',
    },
    expect: [
      D('1140', '43000.00', { type: 'money_account', id: 'MA-PAYOUT' }, { lineMemo: 'Foodpanda settlement' }),
      D('6400', '8000.00', null, { lineMemo: 'Commission' }),
      C('6400', '1000.00', null, { lineMemo: 'Platform fee (credit)' }),
      C('1220', '50000.00', { type: 'channel', id: 'CH-FOODPANDA' }, { lineMemo: 'Foodpanda settlement' }),
    ],
    entryDate: '2026-01-15',
    trap:
      'A deduction is SIGNED and nothing may clamp it to zero. A promo-heavy day genuinely returns ' +
      'money, and v1 shipped a bug by assuming a deduction is always positive.',
  },

  // =========================================================================================
  // amortization — 38 legs. Always both legs (leg-mapping.ts: "always both", same shape as
  // depreciation). One of ADR-005's five January-required capabilities.
  // =========================================================================================
  {
    id: 'amortization.monthly',
    sourceType: 'amortization',
    title: 'Monthly amortisation of a prepaid item',
    narrative: 'A ₱1,100 monthly slice of a prepaid insurance policy is recognised as expense.',
    frequency: 38,
    input: { prepaidItemId: 'PREPAID-0012', monthlyAmortization: '1100.00' },
    expect: [
      D('6750', '1100.00', null, { lineMemo: 'monthly amortisation' }),
      C('1400', '1100.00', null, { lineMemo: 'prepaid balance reduced' }),
    ],
    entryDate: '2026-01-31',
  },

  // =========================================================================================
  // wastage_expense — 16 legs. v2 wastage debits 5300 and credits inventory DIRECTLY —
  // COA-ALIGNMENT §2's "Retire" table explicitly retires v1's net-zero memo-pair
  // (income__wastage_writeoff_contra): "a real economic entry, no memo needed."
  // =========================================================================================
  {
    id: 'wastage_expense.spoilage',
    sourceType: 'wastage_expense',
    title: 'Wastage — a real cost of sales, straight against inventory',
    narrative: '₱640 of spoiled pork belly is written off. Moved from OPEX to COST OF SALES per ' +
      "COA-ALIGNMENT §1 rule 5 — the standard treatment, and it will make reported gross margin " +
      'more correct, not more flattering.',
    frequency: 16,
    input: { itemId: 'MEAT-PORK-BELLY', quantity: 4, unitCost: '160.00', reason: 'spoilage' },
    expect: [
      D('5300', '640.00', null, { lineMemo: 'spoilage write-off' }),
      C('1310', '640.00', null, { lineMemo: 'inventory reduced' }),
    ],
    entryDate: '2026-01-26',
    trap: 'Do NOT port v1\'s net-zero contra-memo pair forward (`income__wastage_writeoff_contra` ' +
      'is explicitly RETIRED). This is a real, single economic entry: an expense against an ' +
      'asset, not an expense against an income-side memo that cancels itself out.',
  },

  // =========================================================================================
  // remittance — 10 legs. leg-mapping.ts: cash__cashier OUT + cash__office IN, ALWAYS. THEN
  // either staff_advance__ IN (shortage, not P&L) OR others__remittance_overage (7350, IS
  // P&L) — NEVER both, and neither when expected == actual. Bible §16.6: "channel-settlement
  // fees net as a SIGNED total... never clamp this at zero" — the same swing-either-way
  // discipline applies to 7350.
  // =========================================================================================
  {
    id: 'remittance.exact',
    sourceType: 'remittance',
    title: 'Remittance, exact — the conditional leg is genuinely absent',
    narrative: 'The cashier remits ₱12,000, and the expected and counted amounts match exactly. ' +
      'Two legs only — no shortage, no overage, 7350 does not appear at all.',
    frequency: 10,
    input: { expectedAmount: '12000.00', actualAmount: '12000.00' },
    expect: [
      D('1130', '12000.00', null, { lineMemo: 'received at office' }),
      C('1110', '12000.00', null, { lineMemo: 'cashier drawer cleared' }),
    ],
    entryDate: '2026-01-27',
  },
  {
    id: 'remittance.overage',
    sourceType: 'remittance',
    title: 'Remittance, overage — 7350 swings positive',
    narrative: 'Expected ₱10,000, but ₱10,080 is actually counted — ₱80 more than the books say ' +
      'should be there.',
    frequency: 10,
    input: { expectedAmount: '10000.00', actualAmount: '10080.00' },
    expect: [
      D('1130', '10080.00', null, { lineMemo: 'received at office (actual)' }),
      C('1110', '10000.00', null, { lineMemo: 'cashier drawer cleared (expected)' }),
      C('7350', '80.00', null, { lineMemo: 'cash overage' }),
    ],
    entryDate: '2026-01-28',
  },
  {
    id: 'remittance.shortage',
    sourceType: 'remittance',
    title: 'Remittance, shortage — charged to the responsible cashier, not P&L',
    narrative: 'Expected ₱10,000, but only ₱9,850 is counted — a ₱150 shortage, charged to the ' +
      'cashier as a salary-advance-style receivable rather than an expense.',
    frequency: 10,
    input: { expectedAmount: '10000.00', actualAmount: '9850.00', chargedStaffId: 'STAFF-0301' },
    expect: [
      D('1130', '9850.00', null, { lineMemo: 'received at office (actual)' }),
      D('1230', '150.00', { type: 'employee', id: 'employee:STAFF-0301' }, { lineMemo: 'shortage charged to cashier' }),
      C('1110', '10000.00', null, { lineMemo: 'cashier drawer cleared (expected)' }),
    ],
    entryDate: '2026-01-29',
    trap: '7350 (Cash over and short) is ONE account that swings EITHER way — never a separate ' +
      'account per direction (COA-ALIGNMENT §2). A shortage does not touch 7350 AT ALL; it goes ' +
      "to 1230, not P&L. Clamping a shortage's charge at zero, or expensing it instead of " +
      'charging the responsible staff member, are both wrong.',
  },

  // =========================================================================================
  // balance_adjustment — 10 legs. Required, AND explicitly marked as the pattern to DESIGN
  // OUT (Contract §4). v1's real sourceType for what T-113 called "liability-charge".
  // =========================================================================================
  {
    id: 'balance_adjustment.plug',
    sourceType: 'balance_adjustment',
    title: 'Balance adjustment — the anti-pattern, included so nobody ports it forward',
    narrative: 'An SSS payable balance is found ₱850 too low after a manual reconciliation. ' +
      "Instead of finding and reversing the entry that got it wrong, someone plugs the " +
      'difference directly.',
    frequency: 10,
    input: { liabilityAccountId: 'liability__sss_payable', counterAccountId: 'expense__sss_employer', amount: '850.00', reason: 'reconciliation catch-up, June' },
    expect: [
      D('6110', '850.00', null, { lineMemo: 'reconciliation catch-up, June' }),
      C('2210', '850.00', null, { lineMemo: 'SSS payable adjusted' }),
    ],
    entryDate: '2026-06-30',
    trap: 'THIS IS THE PATTERN TO DESIGN OUT. v2 should make it unnecessary: a correction is a ' +
      'REVERSAL WITH A REASON (T-106), not an adjusting line that references nothing. This ' +
      'fixture exists to be pointed at, not copied — if a Phase 2 module reaches for this shape ' +
      'to "fix" a wrong balance, the right move is `reverseEntry` on the entry that was actually ' +
      'wrong, not a plug like this one.',
  },

  // =========================================================================================
  // prepaid_purchase (4) / asset_purchase (2) — "Include; they are cheap and they pin a
  // pattern." Both: control asset IN + source OUT (cash) or ap__ IN (on account).
  // =========================================================================================
  {
    id: 'prepaid_purchase.cash',
    sourceType: 'prepaid_purchase',
    title: 'Prepaid purchase — an asset, not an immediate expense',
    narrative: 'A ₱24,000 annual insurance premium is paid up front. It is an ASSET until ' +
      'amortised (see amortization.monthly above), not an expense on the day it is paid.',
    frequency: 4,
    input: { prepaidItemId: 'PREPAID-0012', description: 'Annual insurance premium', amount: '24000.00' },
    expect: [
      D('1400', '24000.00', null, { lineMemo: 'Annual insurance premium' }),
      C('1110', '24000.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-01-05',
  },
  {
    id: 'asset_purchase.cash',
    sourceType: 'asset_purchase',
    title: 'Fixed asset purchase, cash',
    narrative: 'A ₱45,000 commercial grill is bought outright.',
    frequency: 2,
    input: { assetId: 'ASSET-0092', description: 'Commercial grill', amount: '45000.00', payments: [{ method: 'cash', amount: '45000.00' }] },
    expect: [
      D('1510', '45000.00', null, { lineMemo: 'Commercial grill' }),
      C('1110', '45000.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-01-06',
  },
  {
    id: 'asset_purchase.credit',
    sourceType: 'asset_purchase',
    title: 'Fixed asset purchase, on account',
    narrative: 'A ₱60,000 walk-in chiller is bought on 30-day supplier terms.',
    frequency: 2,
    input: { assetId: 'ASSET-0093', description: 'Walk-in chiller', amount: '60000.00', supplierId: 'SUP-0512', payments: [{ method: 'credit', amount: '60000.00' }] },
    expect: [
      D('1510', '60000.00', null, { lineMemo: 'Walk-in chiller' }),
      C('2110', '60000.00', { type: 'supplier', id: 'supplier:SUP-0512' }, { lineMemo: 'AP payment #1' }),
    ],
    entryDate: '2026-01-07',
  },

  // =========================================================================================
  // slicer_payment — 4 legs. "liability__salaries_payable OUT (park) + cash/online OUT
  // splits. Payroll park pattern, mirrors payroll_payout — no P&L leg." Preserves the
  // park-then-lump-sum payroll model bible §16.8 explicitly says to keep the INTENT of.
  // =========================================================================================
  {
    id: 'slicer_payment.park',
    sourceType: 'slicer_payment',
    title: 'Slicer/payroll-adjacent payout — settling an already-parked liability',
    narrative: 'A ₱18,500 payout clears an already-parked salaries-payable balance. No P&L leg — ' +
      'the expense was recognised when the liability was parked, not now.',
    frequency: 4,
    input: { payRunId: 'PAYRUN-2026-01B', amount: '18500.00', method: 'cash' },
    expect: [
      D('2300', '18500.00', null, { lineMemo: 'salaries payable settled' }),
      C('1110', '18500.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-02-05',
  },

  // =========================================================================================
  // liability_payment — leg-mapping.ts: "cash OUT + liability__ OUT. Pure balance sheet."
  // Not in the v1 frequency table by leg count, but ADR-005's scope-gap section names
  // "generic liability accounts" as one of five capabilities that cannot wait past January.
  // Doubles as bible §16.5's worked "remit to agency" example.
  // =========================================================================================
  {
    id: 'liability_payment.statutory-remittance',
    sourceType: 'liability_payment',
    title: 'Statutory remittance — settling what was withheld, not creating new expense',
    narrative: '₱5,000 of withheld SSS contributions is actually remitted to the agency. Bible ' +
      '§16.5: "if you never remit, the liability sits there and grows — that is the feature, ' +
      'not a gap." This is the remit step, distinct from withholding it and from the employer ' +
      'share (both already booked earlier, at payroll time).',
    input: { agency: 'SSS', period: '2026-01', amount: '5000.00' },
    expect: [
      D('2210', '5000.00', null, { lineMemo: 'SSS remitted' }),
      C('1110', '5000.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-02-14',
    trap: 'This is NOT a new expense — the expense (employer share) and the withholding ' +
      "(employee share) were already recognised when payroll posted. Posting this AGAIN as an " +
      'expense would double the true statutory cost, the same shape of bug as the AR ' +
      'platform-fee double-count above.',
  },

  // =========================================================================================
  // Owner equity movements — capital_contribution / drawing. Not in T-108's own v1-leg-count
  // frequency table (too rare to register meaningfully), but ADR-005's scope-gap section names
  // "owner equity movements" explicitly as one of five capabilities v1 already posts that
  // cannot wait past January, and bible §16.10's minimum pattern list names "owner drawings"
  // by name. COA-ALIGNMENT §4.7 #2: drawings were NEVER USED in v1 — this is an ADD, not a
  // CORRECT, designed right from the start rather than migrating a broken pattern.
  // =========================================================================================
  {
    id: 'equity.capital_contribution',
    sourceType: 'capital_contribution',
    title: "Owner's capital contribution — cash in, equity grows",
    narrative: 'The owner injects ₱100,000 of fresh capital into the business.',
    input: { amount: '100000.00', method: 'cash' },
    expect: [
      D('1110', '100000.00', null, { lineMemo: "owner's capital contribution" }),
      C('3100', '100000.00', { type: 'owner', id: 'owner:OWNER-01' }, { lineMemo: "owner's capital increased" }),
    ],
    entryDate: '2026-01-08',
  },
  {
    id: 'equity.drawing',
    sourceType: 'drawing',
    title: "Owner's drawing — reduces equity, on the books at last",
    narrative: 'The owner withdraws ₱25,000 for personal use. 3200 is DEBIT-normal (contra-equity) ' +
      '— one of the six accounts across the whole chart that breaks derive-from-type, alongside ' +
      '1590 and the four contra-revenue accounts (COA-ALIGNMENT §2 / chart-of-accounts.test.ts ' +
      "invariant 3b). COA-ALIGNMENT §4.4/§4.7 #2: v1 reduced equity__capital directly and never " +
      'actually used this category — v2 designs it right rather than migrating a broken pattern.',
    input: { amount: '25000.00', method: 'cash' },
    expect: [
      D('3200', '25000.00', { type: 'owner', id: 'owner:OWNER-01' }, { lineMemo: "owner's drawing" }),
      C('1110', '25000.00', null, { lineMemo: 'cash out' }),
    ],
    entryDate: '2026-01-09',
    trap: "3200 is type='equity' but normal_balance='debit'. A drawing DEBITS 3200 to increase " +
      'it (reduce equity), same mechanic as accumulated depreciation debiting-to-increase on ' +
      'the asset side. Do not assume every equity account credits to increase.',
  },

  // =========================================================================================
  // year_close — v2-only, ADR-006. Every income and expense balance for the year zeroes into
  // 3300 Retained earnings, posted through the SAME postEntry every other entry uses, dated
  // the first day of the following year, carrying source_type='year_close' so a date-range
  // P&L can exclude it while a balance-sheet-as-of includes it (Contract, invariant 11).
  // `setup` posts a small amount of real 2027 P&L activity FIRST so the close entry is
  // provably closing something real, not an arbitrary balanced pair.
  // =========================================================================================
  {
    id: 'year_close.annual',
    sourceType: 'year_close',
    title: 'Year close — one entry, into 3300, dated the following January 1st',
    narrative: 'A small year of activity: ₱20,000 of unli revenue, ₱8,000 of OPEX. Net income ' +
      '₱12,000 for the year zeroes into Retained Earnings on 2028-01-01 — ADR-006\'s own dating ' +
      "convention, matching the opening balance's own 2027-01-01 precedent for \"one clean " +
      'artifact."',
    input: { fiscalYear: 2027, sourceDocument: 'archived 2027 year-end trial balance' },
    setup: [
      [D('1110', '20000.00', null, { lineMemo: 'year revenue' }), C('4100', '20000.00', null, { lineMemo: 'unli sales' })],
      [D('6900', '8000.00', null, { lineMemo: 'year opex' }), C('1110', '8000.00', null, { lineMemo: 'cash out' })],
    ],
    setupEntryDates: ['2027-06-15', '2027-06-20'],
    setupSourceTypes: ['sale', 'expense_payment'],
    expect: [
      D('4100', '20000.00', null, { lineMemo: 'zero 4100 for the year' }),
      C('6900', '8000.00', null, { lineMemo: 'zero 6900 for the year' }),
      C('3300', '12000.00', null, { lineMemo: 'net income carried to retained earnings' }),
    ],
    entryDate: '2028-01-01',
    trap: 'The year-close entry is an ORDINARY posted entry — balanced, traceable to a source ' +
      "document (the archived year-end trial balance), immutable, correctable only by " +
      "reverseEntry. It needs no bespoke closing-voucher entity (ADR-006: \"we already built " +
      'that, generally, for every entry"). A date-range P&L over 2027 must EXCLUDE this entry ' +
      '(it is dated 2028); a balance-sheet-as-of on or after 2028-01-01 must INCLUDE it — both ' +
      'directions are proved in the integration test, and both depend on filtering by ' +
      "`source_type = 'year_close'`, never by a date heuristic.",
  },

  // =========================================================================================
  // opening_balance — v2-only, ADR-005 (amended 2026-08-24) + bible row 106. ONE entry dated
  // 2027-01-01, per-party lump sums for AR/AP, balancing to 3900. 3900 must net to EXACTLY
  // ZERO once loaded and reconciled — a residual halts, never gets plugged. This pair (LOAD
  // then RECONCILE) is the accounting judgement this task required: ADR-005 says 3900 must
  // net to zero but does not spell out the two-step mechanism that makes that provable rather
  // than definitionally true — see the task report.
  // =========================================================================================
  {
    id: 'opening_balance.load',
    sourceType: 'opening_balance',
    title: 'Opening balance — the 2027-01-01 load, balance-sheet only, per-party lump sums',
    narrative: 'The closed, adjusted trial balance from the old ERP as at 2026-12-31, loaded as ' +
      'one entry dated 2027-01-01. AR and AP are ONE LUMP SUM PER PARTY (Ian: "we will lump-sum ' +
      'their balances per vendor... date all AR and AP January 1 and start from there") — no ' +
      'per-invoice detail is migrated; that lives in the spreadsheet, deliberately. Every other ' +
      'balance-sheet account books against 3900, the temporary clearing account this whole ' +
      'load nets through.',
    input: { asOf: '2026-12-31', source: 'closed, adjusted trial balance, old ERP year-end close' },
    expect: [
      D('1110', '80000.00', null, { lineMemo: 'cash on hand, cashier' }),
      D('1210', '15000.00', { type: 'customer', id: 'customer:ACME-CATERING' }, { lineMemo: 'AR opening balance' }),
      D('1510', '300000.00', null, { lineMemo: 'property and equipment' }),
      C('1590', '40000.00', null, { lineMemo: 'accumulated depreciation' }),
      C('2110', '22000.00', { type: 'supplier', id: 'supplier:SUNRISE-MEATS' }, { lineMemo: 'AP opening balance' }),
      C('3900', '333000.00', null, { lineMemo: 'opening balance equity (plug)' }),
    ],
    entryDate: '2027-01-01',
    trap: 'v2 assumes a ZERO starting point everywhere else (bible row 106) — this is the ONE ' +
      'exception, and only for balance-sheet positions, never for history. Nothing here is a ' +
      'replay of 2026 transactions; it is a snapshot of where things stood on 31 December. AR ' +
      "and AP open as ONE balance per party — the opening lump is always dated first, so it is " +
      'always oldest and payments draw it down before any 2027 invoice.',
  },
  {
    id: 'opening_balance.reconcile',
    sourceType: 'opening_balance',
    title: 'Opening balance — reconciling 3900 to exactly zero',
    narrative: 'The load above leaves a ₱333,000 balance sitting in 3900 (Opening balance ' +
      "equity) — a temporary clearing figure, not a final one. Reconciliation reclassifies it " +
      "into the owner's real capital account. ADR-005: \"3900 must net to exactly zero once " +
      'loaded and reconciled — a residual balance means the migration did not balance." This ' +
      'second entry is what makes that provable rather than merely asserted: LOAD creates the ' +
      'balance, RECONCILE clears it, and only after BOTH does 3900 net to zero.',
    input: { plugAmount: '333000.00', reason: "reclassify opening balance equity into owner's capital" },
    // No `setup` here, deliberately: this fixture depends on opening_balance.load's own
    // entry already existing (it reconciles THAT entry's 3900 balance), and it is ordered
    // directly after it in this array — the integration test posts every fixture against
    // one shared corpus, in array order, so load's Cr 333,000.00 to 3900 is already on the
    // ledger by the time this fixture runs. Re-positing it here as a `setup` entry would
    // double it — invariant 10's own db proof caught that mistake during development.
    expect: [
      D('3900', '333000.00', null, { lineMemo: 'clear opening balance equity' }),
      // ⭐ T-127 made 3100 party-requiring, and this fixture is where that bites hardest — in a
      // GOOD way. "Reclassify the opening balance into the owner's capital" begs the question the
      // narrative never asked: WHOSE? With three partners, an unattributed 3100 is precisely the
      // blended number the party exists to prevent, and the cutover is the worst moment to blend it.
      C('3100', '333000.00', { type: 'owner', id: 'owner:OWNER-01' }, { lineMemo: "reclassified to owner's capital" }),
    ],
    entryDate: '2027-01-01',
    trap: 'A LINGERING or FORCE-ZEROED residual on 3900 is never a formality to clear — it is a ' +
      'sign of an incomplete load, and it HALTS for investigation (ADR-005 amendment §"the ' +
      'discipline this makes MORE important, not less"). The temptation to plug a residual is ' +
      'higher here than in an automated load, precisely because these figures are typed by hand ' +
      'from a spreadsheet.',
  },
];

/** Every fixture id — used by the doc-parity test and to guard against an accidental
 * duplicate id here (which would make two fixtures silently collide in the corpus). */
export const WORKED_EXAMPLE_IDS: readonly string[] = WORKED_EXAMPLES.map((f) => f.id);
