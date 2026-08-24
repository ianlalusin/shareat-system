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
import { add, equals, isZero, money, moneyFromLegacyFloat, subtract, type Money } from '@shareat/core/money';
import type { CaseClass } from './taxonomy';
import { ACCOUNTS, OPEX_CATEGORY_ACCOUNTS } from './leg-mapping';

// Account codes and the full OPEX category crosswalk now live in leg-mapping.ts (T-113's
// "Scope — implementation" §2: "widens the map, does not loosen the rule"). Re-exported so
// existing `import { ACCOUNTS } from '../src/convert'` call sites (convert.test.ts) keep
// working unchanged.
export { ACCOUNTS };

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
  /** The specimen's `storeCode` (bible §4.2 rule 2 — every store-scoped table carries
   *  store_id). NOT yet a resolved Postgres id — the replay test resolves storeCode ->
   *  a real stores.id at insert time, the same way it resolves accountCode -> accounts.id. */
  storeCode: string | null;
  debit: Money;
  credit: Money;
  lineMemo: string | null;
  channelId: string | null;
  /** T-118: the subledger counterparty. A line targeting a `requires_party` control
   *  account (2110 AP, 2130 reimbursements, …) MUST carry both; the database rejects it
   *  otherwise, and rejects a party on an account that does not take one. Both or neither. */
  partyType: 'supplier' | 'customer' | 'employee' | 'store' | 'channel' | null;
  partyId: string | null;
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

// -----------------------------------------------------------------------------------------
// DEF-042 — the closed reasonCode union. docs/tasks/114b-audit-report.md Contract §1.
//
// This is the ONE place the union lives — T-114b's audit (packages/etl/src/audit/*.ts)
// imports it from here rather than re-declaring it, so "closed" actually means one
// definition, not two that can drift. Every name is assigned EXPLICITLY at each call
// site below, matched to what is actually wrong at that branch — never derived by
// pattern-matching `reason`'s free text (bible §11 rule 5 / the T-112 implementer's own
// refusal, DEF-042). Two names are deliberately broader than their literal spelling
// suggests, both documented at their call sites:
//   - `missing_supplier_party` also covers a REIMBURSABLE payment missing its staffId.
//     The closed union has no separate "missing_employee_party" code; this is the only
//     "a control account needs a party the source document doesn't carry" code available,
//     so it is used for both control accounts T-113/T-117 actually reach (2110, 2130).
//   - `unsupported_case_class` also covers convertExpense's COGS/OTHERS branch (no
//     posting pattern defined for that expenseEntryGroup yet) and CAPEX's missing-assetId
//     branch's sibling `missing_source_document` is used there instead — see that call
//     site's own comment for why.
// -----------------------------------------------------------------------------------------
export const REASON_CODES = [
  'unmapped_expense_category',
  'unbalanced_source_group',
  'missing_supplier_party',
  'unsupported_case_class',
  'unimplemented_payment_method',
  'non_positive_amount',
  'missing_source_document',
  'precision_loss',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface ConversionResult {
  specimenId: string;
  caseClass: CaseClass;
  status: ConversionStatus;
  reason: string | null;
  /**
   * Present ONLY when `status === 'quarantined'` — deliberately OPTIONAL (never `null`)
   * rather than always-present, so a 'converted' or 'skipped' result carries no
   * `reasonCode` key at all. This is not cosmetic: packages/etl/tests/integration/
   * replay.test.ts diffs the live `convertSpecimen` output against committed
   * `corpus/**\/*.expected.json` fixtures with `toEqual` (Scope forbids editing the
   * corpus), and `toEqual` treats an `undefined`-valued property as absent — matching
   * every existing fixture, none of which has this key. A `reasonCode: null` default
   * would instead be a REAL mismatch against every one of those fixtures. Confirmed
   * against vitest's actual toEqual behaviour before choosing this shape (task report).
   */
  reasonCode?: ReasonCode;
  entries: ConvertedEntry[];
}

const ZERO = money('0');

/**
 * DEF-046. Every amount arriving from a v1 document is a **JS float** (bible §12), and
 * `money()` THROWS on one that is not exact to two decimals. Real v1 data contains such
 * values — the first full capture hit `648.6479999999999` — so `money(doc.someAmount)`
 * crashes the whole conversion on live data while passing every hand-written corpus
 * specimen, because those were authored with clean 2dp figures.
 *
 * `moneyFromLegacyFloat` is the ETL-only helper built for exactly this: it rounds half away
 * from zero, **matching v1's own `roundMoney()`** so a migrated figure reproduces v1's, and
 * it reports rather than throws. Precision loss is surfaced downstream — the group audit
 * classifies a residual imbalance carrying `precision_loss` rather than swallowing it.
 *
 * Never call `money()` on a value that came out of a v1 payload. Use this.
 */
function legacyMoney(value: number): Money {
  return moneyFromLegacyFloat(value).value;
}

function line(
  accountCode: string,
  storeCode: string | null,
  side: 'debit' | 'credit',
  amount: Money,
  opts: {
    lineMemo?: string | null;
    channelId?: string | null;
    partyType?: ConvertedLine['partyType'];
    partyId?: string | null;
  } = {},
): ConvertedLine {
  return {
    accountCode,
    storeCode,
    debit: side === 'debit' ? amount : ZERO,
    credit: side === 'credit' ? amount : ZERO,
    lineMemo: opts.lineMemo ?? null,
    channelId: opts.channelId ?? null,
    // T-118: both or neither — the database CHECK enforces it, so never emit one alone.
    partyType: opts.partyType ?? null,
    partyId: opts.partyId ?? null,
  };
}

function skipped(specimenId: string, caseClass: CaseClass, reason: string): ConversionResult {
  return { specimenId, caseClass, status: 'skipped', reason, entries: [] };
}

function quarantined(
  specimenId: string,
  caseClass: CaseClass,
  reasonCode: ReasonCode,
  reason: string,
): ConversionResult {
  return { specimenId, caseClass, status: 'quarantined', reason, reasonCode, entries: [] };
}

function converted(specimenId: string, caseClass: CaseClass, entries: ConvertedEntry[]): ConversionResult {
  return { specimenId, caseClass, status: 'converted', reason: null, entries };
}

// -----------------------------------------------------------------------------------------
// sale — T-113 §2.3. Day-level: one journal entry, one line per non-zero component.
//
// SPEC DEFECT, reported not silently worked around: T-113 §4 Test 7 (written before Ian's
// §6 review, in the same document) says "A sale day with dineInSales > 0 quarantines under
// the §6.1 rule until Ian decides." §6.1 in that same file is RESOLVED — "dine-in unli IS
// derivable... ERP's dineInSales already IS the unli figure... 4100 needs no reconstruction
// at all." Test 7 as literally written would make every dine-in-unli sales day permanently
// unconvertible, directly contradicting §6.1's resolution and this file's own passing test
// ("plain dine-in unlimited" — Dr cash, Cr 4100). Test 7 is stale, superseded by §6.1, and
// is deliberately NOT implemented; see convert.test.ts's regression test asserting the
// opposite (dineInSales > 0 converts cleanly) for where this is locked in.
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

  const cash = legacyMoney(doc.cashPayments);
  const onlineEntries = Object.entries(doc.onlineBreakdown ?? {});
  const onlineTotal = onlineEntries.reduce((sum, [, amt]) => add(sum, legacyMoney(amt)), ZERO);
  const discounts = legacyMoney(doc.totalDiscounts);
  const comps = legacyMoney(doc.comps);
  const dineIn = legacyMoney(doc.dineInSales);
  const aLaCarte = legacyMoney(doc.takeOutSales);
  const gross = legacyMoney(doc.totalSales);

  // T-113 §2.3's balance identity, with no AR delta (branch-sale / on-account revenue is
  // Contract §1's separate `sale.branch_sale` class — out of scope for this converter;
  // see UNSUPPORTED_CLASSES). tender + discounts + comps must equal gross revenue.
  const tenderSide = add(cash, onlineTotal, discounts, comps);
  if (!equals(tenderSide, gross)) {
    const residual = subtract(gross, tenderSide);
    return quarantined(
      specimenId,
      caseClass,
      'unbalanced_source_group',
      `sales day ${doc.id} does not balance: totalSales (${gross}) != cash+online+discounts+comps ` +
        `(${tenderSide}), residual ${residual} — a finding about v1 data (T-113 §3), not a converter bug`,
    );
  }

  const declaredRevenue = add(dineIn, aLaCarte);
  if (!equals(declaredRevenue, gross)) {
    return quarantined(
      specimenId,
      caseClass,
      'unbalanced_source_group',
      `sales day ${doc.id}: dineInSales + takeOutSales (${declaredRevenue}) != totalSales (${gross})`,
    );
  }

  const storeCode = doc.storeId;
  const lines: ConvertedLine[] = [];
  if (!isZero(cash)) lines.push(line(ACCOUNTS.CASH_CASHIER, storeCode, 'debit', cash, { lineMemo: 'cash tender' }));
  for (const [acct, amt] of onlineEntries) {
    const m = legacyMoney(amt);
    if (!isZero(m)) lines.push(line(ACCOUNTS.ONLINE, storeCode, 'debit', m, { lineMemo: `online: ${acct}` }));
  }
  if (!isZero(discounts)) lines.push(line(ACCOUNTS.SALES_DISCOUNTS, storeCode, 'debit', discounts, { lineMemo: 'senior/PWD/other discount' }));
  if (!isZero(comps)) lines.push(line(ACCOUNTS.SALES_RETURNS_AND_VOIDS, storeCode, 'debit', comps, { lineMemo: 'comps' }));
  if (!isZero(dineIn)) lines.push(line(ACCOUNTS.FOOD_UNLI, storeCode, 'credit', dineIn, { lineMemo: 'dine-in unlimited' }));
  if (!isZero(aLaCarte)) lines.push(line(ACCOUNTS.FOOD_A_LA_CARTE, storeCode, 'credit', aLaCarte, { lineMemo: 'à la carte (incl. take-out)' }));

  if (lines.length < 2) {
    return quarantined(
      specimenId,
      caseClass,
      'unbalanced_source_group',
      `sales day ${doc.id} produced fewer than two non-zero lines — cannot form a balanced entry`,
    );
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

function fundingLine(
  specimenId: string,
  caseClass: CaseClass,
  storeCode: string | null,
  payment: ExpensePaymentSplit,
  idx: number,
  doc: ExpenseDoc,
): ConvertedLine | { reasonCode: ReasonCode; error: string } {
  const amount = legacyMoney(payment.amount);
  switch (payment.method) {
    case 'cash': {
      const account = payment.cashRequestId
        ? ACCOUNTS.CASH_STAFF
        : payment.accountId === 'office'
          ? ACCOUNTS.CASH_OFFICE
          : ACCOUNTS.CASH_CASHIER;
      return line(account, storeCode, 'credit', amount, { lineMemo: `cash payment #${idx}` });
    }
    case 'credit': {
      // T-118: 2110 is a CONTROL account — the database refuses a line without a party.
      // v1 carries the supplier on the expense document, not on the journal leg, so it is
      // read from the source doc. No supplier means the subledger cannot be reconstructed,
      // and a quarantine is the honest outcome (T-113 §3 rule 1 — never guess).
      const supplierId = doc.supplierId ?? null;
      if (!supplierId) {
        return {
          reasonCode: 'missing_supplier_party',
          error: `expense ${doc.id}: an AP (credit) payment has no supplierId — 2110 is a control account and its subledger cannot be reconstructed without one`,
        };
      }
      return line(ACCOUNTS.AP, storeCode, 'credit', amount, {
        lineMemo: `AP payment #${idx}`, partyType: 'supplier', partyId: supplierId,
      });
    }
    case 'reimbursable': {
      // 2130 is likewise a control account, keyed by the employee owed. DEF-042: the
      // closed reasonCode union has no separate "missing_employee_party" — reused from
      // the AP branch above (see this file's REASON_CODES comment for why that is a
      // documented choice, not a guess).
      const staffId = payment.staffId ?? null;
      if (!staffId) {
        return {
          reasonCode: 'missing_supplier_party',
          error: `expense ${doc.id}: a reimbursable payment has no staffId — 2130 is a control account and its subledger cannot be reconstructed without one`,
        };
      }
      return line(ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES, storeCode, 'credit', amount, {
        lineMemo: `reimbursable payment #${idx}`, partyType: 'employee', partyId: staffId,
      });
    }
    case 'online':
      return line(ACCOUNTS.ONLINE, storeCode, 'credit', amount, { lineMemo: `online payment #${idx}` });
    case 'other':
    case 'ar_collection':
      // T-113 §1's Class A list marks `ar-collection` complete (maps to 6400 platform
      // fee) but that is the AR-COLLECTION source type as a whole, not this payment
      // METHOD on an ordinary expense doc — and no v2 account is defined anywhere for a
      // bare "other" expense payment method (`others__{otherType}` in v1 has no COA row).
      // Never guess (T-113 §3 rule 1) — quarantine by name instead.
      return {
        reasonCode: 'unimplemented_payment_method',
        error: `expense payment method "${payment.method}" has no v2 account mapping defined yet (T-113 does not resolve it)`,
      };
  }
}

export function convertExpense(specimenId: string, caseClass: CaseClass, doc: ExpenseDoc): ConversionResult {
  const payments = doc.payments ?? [];
  if (payments.length === 0) {
    return quarantined(specimenId, caseClass, 'unbalanced_source_group', `expense ${doc.id} has zero payment splits`);
  }

  const paidTotal = payments.reduce((sum, p) => add(sum, legacyMoney(p.amount)), ZERO);
  const totalAmount = legacyMoney(doc.totalAmount);
  if (!equals(paidTotal, totalAmount)) {
    return quarantined(
      specimenId,
      caseClass,
      'unbalanced_source_group',
      `expense ${doc.id}: sum(payments) (${paidTotal}) != totalAmount (${totalAmount}) — inconsistent source document`,
    );
  }

  const storeCode = doc.storeId;
  const lines: ConvertedLine[] = [];
  for (const [idx, payment] of payments.entries()) {
    if (isZero(legacyMoney(payment.amount))) continue;
    const result = fundingLine(specimenId, caseClass, storeCode, payment, idx + 1, doc);
    if ('error' in result) {
      return quarantined(specimenId, caseClass, result.reasonCode, `expense ${doc.id}: ${result.error}`);
    }
    lines.push(result);
  }

  const group = doc.expenseEntryGroup ?? null;

  if (group === 'CAPEX') {
    // T-113 §2.1: CAPEX is "not an expense" — the funding legs pair with an asset DR,
    // never a P&L account. Synthesising a P&L leg here would be wrong (T-113 §2.1 table).
    if (!doc.assetId) {
      // The asset RECORD this leg needs to reference (to name what was capitalised) does
      // not exist on the source document — closest fit in the closed union is
      // `missing_source_document`, not `unbalanced_source_group`: the numbers here are
      // internally consistent (payments == totalAmount), what's missing is the linked
      // reference, not a balance.
      return quarantined(
        specimenId,
        caseClass,
        'missing_source_document',
        `expense ${doc.id} is CAPEX but has no assetId to post the asset leg against`,
      );
    }
    lines.push(line(ACCOUNTS.PROPERTY_AND_EQUIPMENT, storeCode, 'debit', totalAmount, { lineMemo: `capitalised: ${doc.assetId}` }));
  } else if (group === 'PERSONAL') {
    // T-113 §2.1 / bible §13 row 42: owner drawings, equity — not an expense.
    lines.push(line(ACCOUNTS.OWNERS_DRAWINGS, storeCode, 'debit', totalAmount, { lineMemo: "owner's drawing" }));
  } else if (group === 'OPEX') {
    const category = doc.category ?? null;
    const account = category ? OPEX_CATEGORY_ACCOUNTS[category] : undefined;
    if (!account) {
      return quarantined(
        specimenId,
        caseClass,
        'unmapped_expense_category',
        `expense ${doc.id}: OPEX category "${category ?? '(none)'}" is not in leg-mapping.ts's ` +
          'OPEX_CATEGORY_ACCOUNTS (the full COA-ALIGNMENT §4.2 crosswalk) — never falls back to 6900 (T-113 §3 rule 1)',
      );
    }
    lines.push(line(account, storeCode, 'debit', totalAmount, { lineMemo: `${category}` }));
  } else {
    // COGS category -> account IS mapped (leg-mapping.ts's COGS_CATEGORY_ACCOUNTS, from
    // COA-ALIGNMENT §4.1), but posting it needs the two-stage inventory pattern (purchase
    // -> inventory asset, consumption -> COGS) which this converter does not implement —
    // preserved from T-117, per T-113 Scope's "widens the map, does not loosen the rule."
    // OTHERS/null is genuinely undecidable without more source detail. Both quarantine
    // rather than guess at which of the two stages a bare expense document represents.
    return quarantined(
      specimenId,
      caseClass,
      'unsupported_case_class',
      `expense ${doc.id}: expenseEntryGroup "${group ?? '(none)'}" has no converter rule (COGS category ` +
        'is mapped in leg-mapping.ts but the two-stage inventory posting T-113 §2.1 describes is not ' +
        'implemented here; anything else is undecidable from the fields captured here)',
    );
  }

  if (lines.length < 2) {
    return quarantined(
      specimenId,
      caseClass,
      'unbalanced_source_group',
      `expense ${doc.id} produced fewer than two non-zero lines — cannot form a balanced entry`,
    );
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
      'unsupported_case_class',
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
