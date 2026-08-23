/**
 * Raw specimen -> relational rows — docs/tasks/117-replay-harness-stage-a.md Contract §3–4.
 *
 * The mapping rules implemented here are NOT invented for this task. They are
 * docs/tasks/113-nominal-leg-mapping-table.md's already-answered §2.1 (`expense`) and
 * §2.3 (`sale`), which is the only conversion contract that exists anywhere in this repo
 * as of T-117. See this file's bottom comment and the task report for a real spec gap
 * this surfaced: T-113's `sale` rule operates on a whole SALES-DAY aggregate document
 * (`salesDays/{date}`), but T-117's taxonomy (Contract §1) names several classes that are
 * only meaningful at individual-RECEIPT granularity — comps, void, re-ring, refill,
 * split-payment, cancelled ticket. No receipt-level posting pattern exists yet anywhere
 * in the repo (`POSTING-PATTERNS.md`, bible decision #40, is still an open Phase-1
 * deliverable). Rather than invent one — which bible §11 rule 5 and T-113 §3 rule 1 both
 * forbid ("never guess a mapping") — this module converts exactly the classes T-113
 * actually specifies: day-level `sale` and document-level `expense`. Every taxonomy class
 * this module cannot yet convert responsibly is listed in `UNSUPPORTED_CLASSES` below and
 * `convertSpecimen` quarantines it by name rather than silently producing a wrong entry.
 *
 * "Never guess a mapping" governs every branch below: an unmapped expense category, an
 * unbalanced sales day, an unsupported case class, or an unimplemented payment method all
 * quarantine with a named reason. None of them throw past the caller — `convertSpecimen`
 * always returns a `ConversionResult`, per Contract §4's "never a bare failure".
 */
import { add, equals, isZero, money, subtract, type Money } from '@shareat/core/money';
import type { CaseClass } from './taxonomy';

// -----------------------------------------------------------------------------------------
// Account codes — packages/db/seed/chart-of-accounts.ts is the source of truth. Repeated
// here as named constants (never bare strings) so a typo shows up as "no such export",
// not as a silent post to the wrong account.
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

/** T-113 §4.2 — only the OPEX categories this task's specimens actually exercise are
 *  mapped. Anything else quarantines (never falls back to 6900 — T-113 §3 rule 1). */
const OPEX_CATEGORY_ACCOUNTS: Readonly<Record<string, string>> = {
  Rent: '6200',
  Utilities: '6300',
};

// -----------------------------------------------------------------------------------------
// Raw document shapes — the fields T-113's builders actually read (verified against
// ERP-rebuild/src/lib/financial/journal/builders/{sale,expense}.builder.ts and
// ERP-rebuild/src/types/index.ts `SalesDayPlain` / `ExpenseV2Plain`, read-only, 2026-08-23).
// -----------------------------------------------------------------------------------------

export type SalesDayStatus = 'open' | 'submitted' | 'verified' | 'partially_remitted' | 'remitted' | 'voided';

export interface SalesDayDoc {
  id: string; // YYYY-MM-DD
  storeId: string;
  status: SalesDayStatus;
  totalSales: number;
  dineInSales: number;
  takeOutSales: number;
  cashPayments: number;
  onlineBreakdown?: Record<string, number> | null;
  seniorDiscount: number;
  pwdDiscount: number;
  otherDiscount: number;
  totalDiscounts: number;
  comps: number;
  submittedByUid?: string | null;
  submittedByName?: string | null;
  verifiedByUid?: string | null;
  voidedByUid?: string | null;
  voidReason?: string | null;
  remittedByUid?: string | null;
}

export type ExpensePaymentMethod = 'cash' | 'online' | 'credit' | 'other' | 'reimbursable' | 'ar_collection';

export interface ExpensePaymentSplit {
  method: ExpensePaymentMethod;
  amount: number;
  accountId?: string | null;
  cashRequestId?: string | null;
  otherType?: string | null;
  staffId?: string | null;
  staffName?: string | null;
}

export type ExpenseEntryGroup = 'COGS' | 'OPEX' | 'CAPEX' | 'PERSONAL' | 'OTHERS';

export interface ExpenseDoc {
  id: string;
  dayKey: string; // YYYY-MM-DD
  storeId: string;
  totalAmount: number;
  payments: ExpensePaymentSplit[];
  supplierId?: string | null;
  supplierName?: string | null;
  staffName?: string;
  createdByUid?: string;
  updatedByUid?: string;
  localActorId?: string | null;
  localActorName?: string | null;
  expenseEntryGroup?: ExpenseEntryGroup | null;
  category?: string | null;
  subCategory?: string | null;
  particulars?: string | null;
  assetId?: string | null;
}

export type SpecimenKind = 'salesDay' | 'expense';

export interface RawSpecimen {
  specimenId: string;
  caseClass: CaseClass;
  kind: SpecimenKind;
  storeCode: string;
  doc: SalesDayDoc | ExpenseDoc;
}

// -----------------------------------------------------------------------------------------
// Output shapes — plain, JSON-serialisable, and exactly what the replay test diffs
// against `.expected.json` (Contract §3/§4, invariant 7) before resolving accountCode ->
// a real accounts.id and inserting.
// -----------------------------------------------------------------------------------------

export interface ConvertedLine {
  accountCode: string;
  debit: Money;
  credit: Money;
  lineMemo: string | null;
  channelId: string | null;
}

export interface ConvertedEntry {
  entryDate: string;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  memo: string | null;
  lines: ConvertedLine[];
}

export type ConversionStatus = 'converted' | 'skipped' | 'quarantined';

export interface ConversionResult {
  specimenId: string;
  caseClass: CaseClass;
  status: ConversionStatus;
  reason: string | null;
  entries: ConvertedEntry[];
}

const ZERO = money('0');

function line(accountCode: string, side: 'debit' | 'credit', amount: Money, opts: { lineMemo?: string | null; channelId?: string | null } = {}): ConvertedLine {
  return {
    accountCode,
    debit: side === 'debit' ? amount : ZERO,
    credit: side === 'credit' ? amount : ZERO,
    lineMemo: opts.lineMemo ?? null,
    channelId: opts.channelId ?? null,
  };
}

function skipped(specimenId: string, caseClass: CaseClass, reason: string): ConversionResult {
  return { specimenId, caseClass, status: 'skipped', reason, entries: [] };
}

function quarantined(specimenId: string, caseClass: CaseClass, reason: string): ConversionResult {
  return { specimenId, caseClass, status: 'quarantined', reason, entries: [] };
}

function converted(specimenId: string, caseClass: CaseClass, entries: ConvertedEntry[]): ConversionResult {
  return { specimenId, caseClass, status: 'converted', reason: null, entries };
}

// -----------------------------------------------------------------------------------------
// sale — T-113 §2.3. Day-level: one journal entry, one line per non-zero component.
// -----------------------------------------------------------------------------------------

export function convertSalesDay(specimenId: string, caseClass: CaseClass, doc: SalesDayDoc): ConversionResult {
  // Glossary: "void cancels the *sale*" — distinct from a "reversal", which unwinds a
  // POSTED entry (docs/GLOSSARY.md). A voided sales day never had revenue that actually
  // happened, so it is not entered at all — the accounting-correct analogue of a draft
  // entry that gets deleted before posting (journal.ts invariant 16), not a reversing
  // entry with swapped debits/credits. See the task report for why this reading was
  // chosen over "post then reverse".
  if (doc.status === 'voided') {
    return skipped(specimenId, caseClass, `sales day ${doc.id} is voided — cancelled sale, nothing to post`);
  }

  const cash = money(doc.cashPayments);
  const onlineEntries = Object.entries(doc.onlineBreakdown ?? {});
  const onlineTotal = onlineEntries.reduce((sum, [, amt]) => add(sum, money(amt)), ZERO);
  const discounts = money(doc.totalDiscounts);
  const comps = money(doc.comps);
  const dineIn = money(doc.dineInSales);
  const aLaCarte = money(doc.takeOutSales);
  const gross = money(doc.totalSales);

  // T-113 §2.3's balance identity, with no AR delta (branch-sale / on-account revenue is
  // Contract §1's separate `sale.branch_sale` class — out of scope for this converter;
  // see UNSUPPORTED_CLASSES). tender + discounts + comps must equal gross revenue.
  const tenderSide = add(cash, onlineTotal, discounts, comps);
  if (!equals(tenderSide, gross)) {
    const residual = subtract(gross, tenderSide);
    return quarantined(
      specimenId,
      caseClass,
      `sales day ${doc.id} does not balance: totalSales (${gross}) != cash+online+discounts+comps ` +
        `(${tenderSide}), residual ${residual} — a finding about v1 data (T-113 §3), not a converter bug`,
    );
  }

  const declaredRevenue = add(dineIn, aLaCarte);
  if (!equals(declaredRevenue, gross)) {
    return quarantined(
      specimenId,
      caseClass,
      `sales day ${doc.id}: dineInSales + takeOutSales (${declaredRevenue}) != totalSales (${gross})`,
    );
  }

  const lines: ConvertedLine[] = [];
  if (!isZero(cash)) lines.push(line(ACCOUNTS.CASH_CASHIER, 'debit', cash, { lineMemo: 'cash tender' }));
  for (const [acct, amt] of onlineEntries) {
    const m = money(amt);
    if (!isZero(m)) lines.push(line(ACCOUNTS.ONLINE, 'debit', m, { lineMemo: `online: ${acct}` }));
  }
  if (!isZero(discounts)) lines.push(line(ACCOUNTS.SALES_DISCOUNTS, 'debit', discounts, { lineMemo: 'senior/PWD/other discount' }));
  if (!isZero(comps)) lines.push(line(ACCOUNTS.SALES_RETURNS_AND_VOIDS, 'debit', comps, { lineMemo: 'comps' }));
  if (!isZero(dineIn)) lines.push(line(ACCOUNTS.FOOD_UNLI, 'credit', dineIn, { lineMemo: 'dine-in unlimited' }));
  if (!isZero(aLaCarte)) lines.push(line(ACCOUNTS.FOOD_A_LA_CARTE, 'credit', aLaCarte, { lineMemo: 'à la carte (incl. take-out)' }));

  if (lines.length < 2) {
    return quarantined(specimenId, caseClass, `sales day ${doc.id} produced fewer than two non-zero lines — cannot form a balanced entry`);
  }

  const entry: ConvertedEntry = {
    entryDate: doc.id,
    sourceType: 'sale',
    sourceId: doc.id,
    idempotencyKey: `etl:${specimenId}`,
    memo: `Sales day ${doc.id}, store ${doc.storeId}`,
    lines,
  };

  return converted(specimenId, caseClass, [entry]);
}

// -----------------------------------------------------------------------------------------
// expense — T-113 §2.1. Document-level: funding leg(s) (credit, money/obligation OUT) plus
// exactly one classification leg, which depends on expenseEntryGroup.
// -----------------------------------------------------------------------------------------

function fundingLine(specimenId: string, caseClass: CaseClass, payment: ExpensePaymentSplit, idx: number): ConvertedLine | { error: string } {
  const amount = money(payment.amount);
  switch (payment.method) {
    case 'cash': {
      const account = payment.cashRequestId
        ? ACCOUNTS.CASH_STAFF
        : payment.accountId === 'office'
          ? ACCOUNTS.CASH_OFFICE
          : ACCOUNTS.CASH_CASHIER;
      return line(account, 'credit', amount, { lineMemo: `cash payment #${idx}` });
    }
    case 'credit':
      return line(ACCOUNTS.AP, 'credit', amount, { lineMemo: `AP payment #${idx}` });
    case 'reimbursable':
      return line(ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES, 'credit', amount, { lineMemo: `reimbursable payment #${idx}` });
    case 'online':
      return line(ACCOUNTS.ONLINE, 'credit', amount, { lineMemo: `online payment #${idx}` });
    case 'other':
    case 'ar_collection':
      // T-113 §1's Class A list marks `ar-collection` complete (maps to 6400 platform
      // fee) but that is the AR-COLLECTION source type as a whole, not this payment
      // METHOD on an ordinary expense doc — and no v2 account is defined anywhere for a
      // bare "other" expense payment method (`others__{otherType}` in v1 has no COA row).
      // Never guess (T-113 §3 rule 1) — quarantine by name instead.
      return { error: `expense payment method "${payment.method}" has no v2 account mapping defined yet (T-113 does not resolve it)` };
  }
}

export function convertExpense(specimenId: string, caseClass: CaseClass, doc: ExpenseDoc): ConversionResult {
  const payments = doc.payments ?? [];
  if (payments.length === 0) {
    return quarantined(specimenId, caseClass, `expense ${doc.id} has zero payment splits`);
  }

  const paidTotal = payments.reduce((sum, p) => add(sum, money(p.amount)), ZERO);
  const totalAmount = money(doc.totalAmount);
  if (!equals(paidTotal, totalAmount)) {
    return quarantined(
      specimenId,
      caseClass,
      `expense ${doc.id}: sum(payments) (${paidTotal}) != totalAmount (${totalAmount}) — inconsistent source document`,
    );
  }

  const lines: ConvertedLine[] = [];
  for (const [idx, payment] of payments.entries()) {
    if (isZero(money(payment.amount))) continue;
    const result = fundingLine(specimenId, caseClass, payment, idx + 1);
    if ('error' in result) {
      return quarantined(specimenId, caseClass, `expense ${doc.id}: ${result.error}`);
    }
    lines.push(result);
  }

  const group = doc.expenseEntryGroup ?? null;

  if (group === 'CAPEX') {
    // T-113 §2.1: CAPEX is "not an expense" — the funding legs pair with an asset DR,
    // never a P&L account. Synthesising a P&L leg here would be wrong (T-113 §2.1 table).
    if (!doc.assetId) {
      return quarantined(specimenId, caseClass, `expense ${doc.id} is CAPEX but has no assetId to post the asset leg against`);
    }
    lines.push(line(ACCOUNTS.PROPERTY_AND_EQUIPMENT, 'debit', totalAmount, { lineMemo: `capitalised: ${doc.assetId}` }));
  } else if (group === 'PERSONAL') {
    // T-113 §2.1 / bible §13 row 42: owner drawings, equity — not an expense.
    lines.push(line(ACCOUNTS.OWNERS_DRAWINGS, 'debit', totalAmount, { lineMemo: "owner's drawing" }));
  } else if (group === 'OPEX') {
    const category = doc.category ?? null;
    const account = category ? OPEX_CATEGORY_ACCOUNTS[category] : undefined;
    if (!account) {
      return quarantined(
        specimenId,
        caseClass,
        `expense ${doc.id}: OPEX category "${category ?? '(none)'}" has no v2 account mapping — never falls back to 6900 (T-113 §3 rule 1)`,
      );
    }
    lines.push(line(account, 'debit', totalAmount, { lineMemo: `${category}` }));
  } else {
    // COGS needs the two-stage inventory posting (T-113 §2.1's table — purchase vs
    // consumption are different events with different accounts) which this converter does
    // not implement; OTHERS/null is genuinely undecidable without more source detail.
    // Both quarantine rather than guess.
    return quarantined(
      specimenId,
      caseClass,
      `expense ${doc.id}: expenseEntryGroup "${group ?? '(none)'}" has no converter rule (COGS needs the ` +
        'two-stage inventory posting T-113 §2.1 describes but this converter does not implement; ' +
        'anything else is undecidable from the fields captured here)',
    );
  }

  if (lines.length < 2) {
    return quarantined(specimenId, caseClass, `expense ${doc.id} produced fewer than two non-zero lines — cannot form a balanced entry`);
  }

  const entry: ConvertedEntry = {
    entryDate: doc.dayKey,
    sourceType: 'expense',
    sourceId: doc.id,
    idempotencyKey: `etl:${specimenId}`,
    memo: doc.particulars ?? `Expense ${doc.id}, store ${doc.storeId}`,
    lines,
  };

  return converted(specimenId, caseClass, [entry]);
}

// -----------------------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------------------

/**
 * Case classes named in Contract §1 that this converter does not yet handle, because no
 * receipt-level (or otherwise more granular) posting pattern is specified anywhere in the
 * repo for them — see this file's header comment and the task report. Listed explicitly
 * so `convertSpecimen` can quarantine by NAME instead of falling into a generic "unknown
 * kind" branch, and so this list is the one place that needs updating once
 * `POSTING-PATTERNS.md` (bible decision #40) lands.
 */
export const UNSUPPORTED_CLASSES: ReadonlySet<CaseClass> = new Set([
  'sale.partial_refund',
  'sale.re_rung',
  'sale.split_payment',
  'sale.online_order',
  'sale.branch_sale',
  'ticket.cancelled',
  'refill.addon',
  'channel.settlement',
  // Anomaly classes are deliberately uncapped in the taxonomy (they must always be
  // captured — invariant 2), but converting a NEGATIVE amount correctly needs real
  // thought about what negative means in a given v1 field (a refund flowing backward? a
  // sign error?) and this converter does not implement that yet. Rather than guess,
  // Part 1 leaves all four anomaly classes unsupported here — a deliberate scope
  // decision for Stage A, not a discovered impossibility. See the task report.
  'anomaly.zero_amount',
  'anomaly.negative',
  'anomaly.same_day_void',
  'anomaly.cross_period',
  // NOTE: 'expense.online' and 'expense.personal' are NOT in this set — both are fully
  // implemented above (online -> 1140 funding leg; PERSONAL -> 3200 owner's drawings),
  // directly from T-113 §2.1's already-answered rules. Neither is guessed.
]);

export function convertSpecimen(raw: RawSpecimen): ConversionResult {
  if (UNSUPPORTED_CLASSES.has(raw.caseClass)) {
    return quarantined(
      raw.specimenId,
      raw.caseClass,
      `case class "${raw.caseClass}" has no defined conversion rule yet — see UNSUPPORTED_CLASSES in convert.ts`,
    );
  }

  switch (raw.kind) {
    case 'salesDay':
      return convertSalesDay(raw.specimenId, raw.caseClass, raw.doc as SalesDayDoc);
    case 'expense':
      return convertExpense(raw.specimenId, raw.caseClass, raw.doc as ExpenseDoc);
  }
}
