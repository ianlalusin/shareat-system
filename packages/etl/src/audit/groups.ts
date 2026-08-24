/**
 * audit/groups.ts — Stage 1 of the T-114b audit. docs/tasks/114b-audit-report.md Contract
 * §4, "the group audit — where v1's books do not balance." This is the finding the whole
 * task exists to surface.
 *
 * v1's journal doc id IS `sourceType:sourceId:legKey` (Contract §4) — but rather than
 * parse that composite string, every leg's payload already carries `sourceType`/
 * `sourceId` as their own fields (verified against the real capture, 2026-08-24), so
 * grouping is a plain reduce over already-parsed legs, no second read and no string
 * parsing needed.
 *
 * For each `(storeCode, sourceType, sourceId)` group, every leg is translated through
 * T-107's `adaptLegacyLegs` (never re-implemented — same call balances.ts makes, via the
 * same `resolveV1Account` crosswalk) and classified into exactly one of Contract §4's four
 * classes:
 *
 *   ✅ balances_as_is        — the balance-sheet legs already net to zero.
 *   ✅ balances_synthesized  — v1 omitted the P&L leg by design (the expected case). The
 *                              missing leg is derived by calling T-113's OWN converter
 *                              (`convertExpense`/`convertSalesDay` from ../convert.ts,
 *                              UNCHANGED except for DEF-042's reasonCode) against the
 *                              matching landed `expenses`/`salesDays` source document —
 *                              never a second implementation of that mapping.
 *   ⚠️ ambiguous              — cannot be classified with confidence. Quarantined with a
 *                              `reasonCode` from convert.ts's closed union (imported, not
 *                              redeclared).
 *   ❌ cannot_balance         — a genuine, CONFIRMED v1 defect: every leg translated fine,
 *                              synthesis (where it applies) succeeded on its own terms, and
 *                              the total still does not net to zero.
 *
 * The line between ⚠️ and ❌ is deliberate, not a coin flip (see `classifyOneGroup`'s own
 * comments at each branch): ❌ is reserved for the cases where this module has the FULL
 * picture and that full picture disagrees with itself. Anything short of a full picture —
 * an unmapped account, a missing source document, a source document convert.ts itself
 * cannot classify, a sourceType with no documented expectation either way — is ⚠️, because
 * calling it a "genuine defect" would be a claim this module cannot actually back up.
 */
import { add, equals, money, negate, subtract, ZERO, type Money } from '@shareat/core/money';
import {
  adaptLegacyLegs,
  type LegacyLeg,
  type ResolvedAccount,
} from '../../../domain/src/ledger/legacy-adapter';
import { classifySourceType } from '../leg-mapping';
import {
  ACCOUNTS,
  convertExpense,
  convertSalesDay,
  type ExpenseDoc,
  type ExpenseEntryGroup,
  type ExpensePaymentSplit,
  type ReasonCode,
  type SalesDayDoc,
  type SalesDayStatus,
} from '../convert';

/**
 * Codes convertExpense/convertSalesDay use for FUNDING lines — the side that mirrors what
 * v1's raw journal already posts as balance-sheet legs (cash/online movement, AP/
 * reimbursable payable). Excluded when merging a synthesised entry onto a group's raw
 * legs, or the funding amount would be double-counted (once from the real leg, once from
 * convert.ts re-deriving the same funding line from the source document). Everything
 * convert.ts's synthesis produces OUTSIDE this set — the P&L classification leg for an
 * expense, the CAPEX asset leg, the PERSONAL drawings leg, or a sale's discount/comps/
 * revenue lines — is exactly the leg v1 omitted, and IS added (Contract §4's "balances
 * once the nominal leg is synthesised").
 */
const FUNDING_CODES: ReadonlySet<string> = new Set([
  ACCOUNTS.CASH_CASHIER,
  ACCOUNTS.CASH_STAFF,
  ACCOUNTS.CASH_OFFICE,
  ACCOUNTS.ONLINE,
  ACCOUNTS.AP,
  ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES,
]);
import {
  DEFAULT_STORE_IDS,
  EXCLUDED_STORES,
  filterJournalDocs,
  parseJournalLeg,
  resolveV1Account,
  type BalanceFinding,
  type LandedDocLike,
  type V1JournalLeg,
} from './balances';

export type GroupClass = 'balances_as_is' | 'balances_synthesized' | 'ambiguous' | 'cannot_balance';

export interface GroupResult {
  readonly storeCode: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly businessDate: string | null;
  readonly legCount: number;
  readonly classification: GroupClass;
  readonly reasonCode?: ReasonCode;
  readonly reasonDetail?: string;
  /** abs(debit - credit) of the figure this group was actually classified on (after a
   *  synthesis attempt, when one applied). Exactly ZERO for the two ✅ classes — that is
   *  what "balances" means here — and the number Contract §4 wants summed per class and
   *  per sourceType for the ❌ set's peso magnitude. */
  readonly imbalance: Money;
}

export interface ClassifyGroupsResult {
  readonly asOf: string;
  readonly includedStoreCodes: readonly string[];
  readonly excludedStores: readonly { code: string; name: string }[];
  readonly groups: readonly GroupResult[];
  readonly findings: readonly BalanceFinding[];
}

function absDiff(a: Money, b: Money): Money {
  const diff = subtract(a, b);
  return diff.startsWith('-') ? negate(diff) : diff;
}

// -----------------------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------------------

interface GroupBucket {
  storeCode: string;
  sourceType: string;
  sourceId: string;
  businessDate: string | null;
  legs: V1JournalLeg[];
}

export function classifyGroups(
  docs: readonly LandedDocLike[],
  params: { asOf: string; storeIds?: readonly string[] },
): ClassifyGroupsResult {
  const storeIds = params.storeIds ?? DEFAULT_STORE_IDS;
  const storeIdSet = new Set(storeIds);
  const excludedStores = Object.entries(EXCLUDED_STORES).map(([code, name]) => ({ code, name }));
  const findings: BalanceFinding[] = [];

  // Same in-scope filter as balances.ts, leg by leg — so the group audit and the balance
  // reconstruction always agree on which legs are "in" for a given asOf/storeIds.
  const buckets = new Map<string, GroupBucket>();
  for (const doc of filterJournalDocs(docs)) {
    const parsed = parseJournalLeg(doc);
    if (!parsed) {
      findings.push({
        type: 'malformed_leg',
        storeCode: doc.storeCode ?? '(unknown)',
        docPath: doc.docPath,
        accountId: null,
        message: 'journal document missing one of accountId/direction/amount/sourceType/sourceId',
      });
      continue;
    }
    if (!storeIdSet.has(parsed.storeCode)) continue;

    if (parsed.businessDate == null) {
      findings.push({
        type: 'missing_business_date',
        storeCode: parsed.storeCode,
        docPath: doc.docPath,
        accountId: parsed.accountId,
        message: `leg has no businessDate — excluded from the ${params.asOf} group audit`,
      });
      continue;
    }
    if (parsed.businessDate > params.asOf) continue;

    const key = `${parsed.storeCode} ${parsed.sourceType} ${parsed.sourceId}`;
    const bucket = buckets.get(key) ?? {
      storeCode: parsed.storeCode,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      businessDate: parsed.businessDate,
      legs: [],
    };
    bucket.legs.push(parsed);
    buckets.set(key, bucket);
  }

  // Lookup maps for the source documents synthesis needs — one pass over the full doc set.
  const expenseDocs = new Map<string, LandedDocLike>();
  const salesDayDocs = new Map<string, LandedDocLike>();
  for (const d of docs) {
    if (/\/expenses$/.test(d.collectionPath)) expenseDocs.set(d.docPath, d);
    else if (/\/salesDays$/.test(d.collectionPath)) salesDayDocs.set(d.docPath, d);
  }

  const groups: GroupResult[] = [...buckets.values()].map((bucket) =>
    classifyOneGroup(bucket, expenseDocs, salesDayDocs, findings),
  );

  return { asOf: params.asOf, includedStoreCodes: [...storeIds], excludedStores, groups, findings };
}

// -----------------------------------------------------------------------------------------
// Per-group classification
// -----------------------------------------------------------------------------------------

function classifyOneGroup(
  bucket: GroupBucket,
  expenseDocs: ReadonlyMap<string, LandedDocLike>,
  salesDayDocs: ReadonlyMap<string, LandedDocLike>,
  findings: BalanceFinding[],
): GroupResult {
  const base = {
    storeCode: bucket.storeCode,
    sourceType: bucket.sourceType,
    sourceId: bucket.sourceId,
    businessDate: bucket.businessDate,
    legCount: bucket.legs.length,
  };

  // Pre-validate every leg BEFORE calling adaptLegacyLegs for the group — deliberately not
  // string-matching adaptLegacyLegs's own `reason` prose to pick a code (that is exactly
  // the guess DEF-042 forbids); these are plain, structural checks this module owns.
  let hasUnresolved = false;
  let hasNonPositive = false;
  const resolvedByAccountId = new Map<string, ResolvedAccount>();
  for (const leg of bucket.legs) {
    const resolved = resolveV1Account(leg.accountId);
    if (!resolved) {
      hasUnresolved = true;
      continue;
    }
    resolvedByAccountId.set(leg.accountId, resolved);
    const n = typeof leg.amount === 'number' ? leg.amount : Number(leg.amount);
    if (!Number.isFinite(n) || n <= 0) hasNonPositive = true;
  }

  if (hasUnresolved) {
    return {
      ...base,
      classification: 'ambiguous',
      reasonCode: 'unsupported_case_class',
      reasonDetail: `one or more legs in ${bucket.sourceType}:${bucket.sourceId} reference a v1 accountId with no v2 mapping`,
      imbalance: ZERO,
    };
  }
  if (hasNonPositive) {
    return {
      ...base,
      classification: 'ambiguous',
      reasonCode: 'non_positive_amount',
      reasonDetail: `one or more legs in ${bucket.sourceType}:${bucket.sourceId} have a non-positive or non-finite amount`,
      imbalance: ZERO,
    };
  }

  const legacyLegs: LegacyLeg[] = bucket.legs.map((l) => ({
    accountId: l.accountId,
    direction: l.direction,
    amount: l.amount,
    legKey: l.legKey ?? undefined,
  }));
  const adapted = adaptLegacyLegs(legacyLegs, (id) => resolvedByAccountId.get(id) ?? null);

  if (!adapted.ok) {
    // Unreachable for real data given the pre-checks above (every possible ok:false cause
    // — unresolvable account, non-positive amount, empty array — is already ruled out).
    // Kept as a named, non-silent fallback rather than assumed impossible.
    return {
      ...base,
      classification: 'ambiguous',
      reasonCode: 'unsupported_case_class',
      reasonDetail: `adaptLegacyLegs rejected ${bucket.sourceType}:${bucket.sourceId} unexpectedly: ${adapted.reason}`,
      imbalance: ZERO,
    };
  }

  const groupDocKey = `journal-group:${bucket.storeCode}:${bucket.sourceType}:${bucket.sourceId}`;
  for (const f of adapted.findings) {
    findings.push({ type: f.type, storeCode: bucket.storeCode, docPath: groupDocKey, accountId: f.accountId, message: f.message });
  }
  const hasPrecisionLoss = adapted.findings.some((f) => f.type === 'precision_loss');

  let debitTotal = adapted.lines.reduce((s, l) => add(s, money(l.debit)), ZERO);
  let creditTotal = adapted.lines.reduce((s, l) => add(s, money(l.credit)), ZERO);

  // ✅ balances_as_is
  if (equals(debitTotal, creditTotal)) {
    return { ...base, classification: 'balances_as_is', imbalance: ZERO };
  }

  // Synthesis — Contract §4's expected case, for the two sourceTypes T-113 actually
  // implements a rule for.
  if (bucket.sourceType === 'expense_payment' || bucket.sourceType === 'sale') {
    const collection = bucket.sourceType === 'expense_payment' ? 'expenses' : 'salesDays';
    const docPath = `stores/${bucket.storeCode}/${collection}/${bucket.sourceId}`;
    const sourceDoc = bucket.sourceType === 'expense_payment' ? expenseDocs.get(docPath) : salesDayDocs.get(docPath);

    if (!sourceDoc) {
      return {
        ...base,
        classification: 'ambiguous',
        reasonCode: 'missing_source_document',
        reasonDetail: `no landed ${collection} document at ${docPath} to synthesise the nominal leg from`,
        imbalance: absDiff(debitTotal, creditTotal),
      };
    }

    const conversion =
      bucket.sourceType === 'expense_payment' ? tryConvertExpense(sourceDoc) : tryConvertSalesDay(sourceDoc);

    if (!conversion) {
      return {
        ...base,
        classification: 'ambiguous',
        reasonCode: 'missing_source_document',
        reasonDetail: `landed ${collection} document at ${docPath} is missing fields this parser requires`,
        imbalance: absDiff(debitTotal, creditTotal),
      };
    }

    if (conversion.status === 'quarantined') {
      // Reuse convert.ts's OWN reasonCode/reason — the closed union is shared, never
      // reinvented per module.
      return {
        ...base,
        classification: 'ambiguous',
        reasonCode: conversion.reasonCode ?? 'unsupported_case_class',
        reasonDetail: conversion.reason ?? `${collection} document at ${docPath} quarantined with no detail`,
        imbalance: absDiff(debitTotal, creditTotal),
      };
    }

    if (conversion.status === 'converted') {
      // Only the lines convert.ts derives OUTSIDE FUNDING_CODES are actually missing from
      // v1's raw journal — the funding lines it also reconstructs from the source document
      // are the SAME money movement the group's raw legs already carry; adding both would
      // double the funding side. See FUNDING_CODES's own comment above.
      for (const entry of conversion.entries) {
        for (const line of entry.lines) {
          if (FUNDING_CODES.has(line.accountCode)) continue;
          debitTotal = add(debitTotal, line.debit);
          creditTotal = add(creditTotal, line.credit);
        }
      }
      if (equals(debitTotal, creditTotal)) {
        return { ...base, classification: 'balances_synthesized', imbalance: ZERO };
      }
      const imbalance = absDiff(debitTotal, creditTotal);
      if (hasPrecisionLoss) {
        // A rounding artifact on the way in is a plausible full explanation for a
        // hairline mismatch — genuinely ambiguous, not confidently a defect.
        return {
          ...base,
          classification: 'ambiguous',
          reasonCode: 'precision_loss',
          reasonDetail: `raw legs + the synthesised entry from ${docPath} still differ by ${imbalance}, and at least one leg's legacy amount did not round-trip exactly to centavos`,
          imbalance,
        };
      }
      return {
        ...base,
        classification: 'cannot_balance',
        reasonDetail: `raw legs + the synthesised entry from ${docPath} still differ by ${imbalance} — a confirmed imbalance, not a mapping gap`,
        imbalance,
      };
    }

    // conversion.status === 'skipped' — e.g. a voided sales day. The source document says
    // nothing should have posted; the real journal nonetheless holds non-netting legs.
    const imbalance = absDiff(debitTotal, creditTotal);
    return {
      ...base,
      classification: 'cannot_balance',
      reasonDetail: `source document at ${docPath} is skipped (${conversion.reason ?? 'no detail'}), but its journal legs do not net to zero (${imbalance})`,
      imbalance,
    };
  }

  // No synthesis rule applies for this sourceType. Fall back to what T-113's own
  // crosswalk (leg-mapping.ts) documents about it.
  const mapping = classifySourceType(bucket.sourceType);
  const imbalance = absDiff(debitTotal, creditTotal);

  if (mapping?.class === 'complete') {
    // T-113 asserts this sourceType's v1 builder ALWAYS posts a self-balanced set
    // (leg-mapping.ts's own "must synthesise ZERO lines" framing). Our translation says
    // it does not — a genuine, confirmed contradiction.
    return {
      ...base,
      classification: 'cannot_balance',
      reasonDetail: `leg-mapping.ts classifies '${bucket.sourceType}' as balance-sheet-complete (always self-balanced by construction), but the translated legs differ by ${imbalance}`,
      imbalance,
    };
  }

  if (hasPrecisionLoss) {
    return {
      ...base,
      classification: 'ambiguous',
      reasonCode: 'precision_loss',
      reasonDetail: `${bucket.sourceType}:${bucket.sourceId} differs by ${imbalance}, and at least one leg's legacy amount did not round-trip exactly to centavos`,
      imbalance,
    };
  }

  // No leg-mapping.ts entry at all (e.g. real-data `commissary_dispatch` — found during
  // this task, see the task report) — no documented expectation either way. Genuinely
  // unclear, not a confirmed defect.
  return {
    ...base,
    classification: 'ambiguous',
    reasonCode: 'unsupported_case_class',
    reasonDetail: `sourceType '${bucket.sourceType}' has no entry in leg-mapping.ts's SOURCE_TYPE_MAPPINGS — no documented expectation either way, so this is reported rather than assumed wrong`,
    imbalance,
  };
}

// -----------------------------------------------------------------------------------------
// Source-document parsing, feeding convert.ts's UNCHANGED convertExpense/convertSalesDay.
// Defensive only — returns null (never throws) when a real document is missing a field
// these parsers cannot proceed without.
// -----------------------------------------------------------------------------------------

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function tryConvertExpense(doc: LandedDocLike) {
  const p = doc.payload;
  const totalAmount = num(p.totalAmount);
  const paymentsRaw = Array.isArray(p.payments) ? p.payments : null;
  if (totalAmount == null || paymentsRaw == null) return null;

  const payments: ExpensePaymentSplit[] = paymentsRaw.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      method: (typeof r.method === 'string' ? r.method : 'other') as ExpensePaymentSplit['method'],
      amount: (num(r.amount) ?? 0) as number,
      accountId: str(r.accountId),
      cashRequestId: str(r.cashRequestId),
      otherType: str(r.otherType),
      staffId: str(r.staffId),
      staffName: str(r.staffName),
    };
  });

  const expenseDoc: ExpenseDoc = {
    id: str(p.id) ?? doc.docPath.split('/').pop() ?? 'unknown',
    dayKey: str(p.dayKey) ?? '',
    storeId: doc.storeCode ?? '',
    totalAmount,
    payments,
    supplierId: str(p.supplierId),
    supplierName: str(p.supplierName) ?? undefined,
    staffName: str(p.staffName) ?? undefined,
    createdByUid: str(p.createdByUid) ?? undefined,
    updatedByUid: str(p.updatedByUid) ?? undefined,
    localActorId: str(p.localActorId),
    localActorName: str(p.localActorName),
    expenseEntryGroup: (str(p.expenseEntryGroup) as ExpenseEntryGroup | null) ?? null,
    category: str(p.category),
    subCategory: str(p.subCategory),
    particulars: str(p.particulars),
    assetId: str(p.assetId),
  };

  return convertExpense(`audit:${doc.docPath}`, 'expense.cash', expenseDoc);
}

function tryConvertSalesDay(doc: LandedDocLike) {
  const p = doc.payload;
  const totalSales = num(p.totalSales);
  const dineInSales = num(p.dineInSales);
  const takeOutSales = num(p.takeOutSales);
  const cashPayments = num(p.cashPayments);
  const totalDiscounts = num(p.totalDiscounts);
  const comps = num(p.comps);
  const status = str(p.status);
  if (
    totalSales == null ||
    dineInSales == null ||
    takeOutSales == null ||
    cashPayments == null ||
    totalDiscounts == null ||
    comps == null ||
    status == null
  ) {
    return null;
  }

  const salesDayDoc: SalesDayDoc = {
    id: str(p.id) ?? doc.docPath.split('/').pop() ?? 'unknown',
    storeId: doc.storeCode ?? '',
    status: status as SalesDayStatus,
    totalSales,
    dineInSales,
    takeOutSales,
    cashPayments,
    onlineBreakdown: (p.onlineBreakdown as Record<string, number> | null | undefined) ?? null,
    seniorDiscount: num(p.seniorDiscount) ?? 0,
    pwdDiscount: num(p.pwdDiscount) ?? 0,
    otherDiscount: num(p.otherDiscount) ?? 0,
    totalDiscounts,
    comps,
    submittedByUid: str(p.submittedByUid),
    submittedByName: str(p.submittedByName),
    verifiedByUid: str(p.verifiedByUid),
    voidedByUid: str(p.voidedByUid),
    voidReason: str(p.voidReason),
    remittedByUid: str(p.remittedByUid),
  };

  return convertSalesDay(`audit:${doc.docPath}`, 'sale.dine_in_unli.plain', salesDayDoc);
}
