/**
 * The only place SQL is written for the SC/PWD statutory register. T-137.
 *
 * ⛔ **Nothing here touches the ledger, and nothing here ever should.** Bible row 75: a statutory
 * basis is a separate reporting layer over the same ledger, never a retrofit of the accounts. The
 * daily `sales_days.senior_discount` / `pwd_discount` totals remain the only route to 4900.
 *
 * ⚠️ **No rule is re-implemented here.** One live row per invoice, positive amounts, a discount
 * within its gross, an all-or-nothing void and a non-blank identity are all CHECK constraints and
 * a partial unique index in migration 0065. This module writes rows and lets Postgres refuse the
 * bad ones — a second copy of a rule in TypeScript is a second source of truth, and the two drift
 * (RULES.md, "the three that catch people out" #3).
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { statutoryDiscountRecords } from '../../schema/statutory-discounts';

export type StatutoryDiscountKind = 'senior' | 'pwd';
export type StatutoryDiscountSource = 'manual' | 'pos';

export interface CreateStatutoryDiscountRow {
  orgId: string;
  storeId: string;
  businessDate: string;
  invoiceNumber: string;
  kind: StatutoryDiscountKind;
  idNumber: string;
  holderName: string;
  grossAmount: string;
  discountAmount: string;
  signatory?: string | null;
  source?: StatutoryDiscountSource;
  notes?: string | null;
  recordedBy: string;
}

export interface StatutoryDiscountRow {
  id: string;
  storeId: string;
  businessDate: string;
  invoiceNumber: string;
  kind: StatutoryDiscountKind;
  idNumber: string;
  holderName: string;
  grossAmount: string;
  discountAmount: string;
  /** ⭐ Derived, never stored. A third number can disagree with the two that define it. */
  netAmount: string;
  signatory: string | null;
  source: StatutoryDiscountSource;
  notes: string | null;
  recordedBy: string;
  voidedAt: Date | null;
  voidReason: string | null;
}

export interface RangeQuery {
  /** One store, when the caller picked one. */
  storeId?: string;
  /** ⭐ The stores the caller is actually scoped to, when they picked "all". **Never optional in
   *  effect** — the domain resolves it from `person_store_scope` rather than letting an absent
   *  filter mean "everything". RLS already bounds the org; this bounds the STORE, which org
   *  isolation alone does not do. */
  storeIds?: readonly string[];
  from: string;
  to: string;
  /** The register's own audit view. Default false: a voided row is not part of the record. */
  includeVoided?: boolean;
}

export async function create(tx: Tx, row: CreateStatutoryDiscountRow): Promise<{ id: string }> {
  const [inserted] = await tx
    .insert(statutoryDiscountRecords)
    .values({
      orgId: row.orgId,
      storeId: row.storeId,
      businessDate: row.businessDate,
      invoiceNumber: row.invoiceNumber,
      kind: row.kind,
      idNumber: row.idNumber,
      holderName: row.holderName,
      grossAmount: row.grossAmount,
      discountAmount: row.discountAmount,
      signatory: row.signatory ?? null,
      source: row.source ?? 'manual',
      notes: row.notes ?? null,
      recordedBy: row.recordedBy,
    })
    .returning({ id: statutoryDiscountRecords.id });
  return { id: inserted!.id };
}

export async function findById(tx: Tx, orgId: string, id: string): Promise<StatutoryDiscountRow | null> {
  const rows = await listWhere(tx, and(eq(statutoryDiscountRecords.orgId, orgId), eq(statutoryDiscountRecords.id, id))!);
  return rows[0] ?? null;
}

/**
 * ⭐ **One filter, built once, used by both the list and the summary.** They are two readings of
 * the same question, and a register whose footer is scoped differently from its rows is worse than
 * one with no footer — `statutory-discounts.test.ts` invariant 11 asserts the two agree.
 */
function rangeClauses(orgId: string, q: RangeQuery) {
  const clauses = [
    eq(statutoryDiscountRecords.orgId, orgId),
    gte(statutoryDiscountRecords.businessDate, q.from),
    lte(statutoryDiscountRecords.businessDate, q.to),
  ];
  if (q.storeId) clauses.push(eq(statutoryDiscountRecords.storeId, q.storeId));
  // ⚠️ An EMPTY scope list must match nothing, and `inArray` with `[]` does exactly that. It is
  // the correct reading: a person scoped to no store may read no store, which is not the same as
  // applying no filter at all.
  else if (q.storeIds) clauses.push(inArray(statutoryDiscountRecords.storeId, [...q.storeIds]));
  if (!q.includeVoided) clauses.push(isNull(statutoryDiscountRecords.voidedAt));
  return and(...clauses)!;
}

export async function listForRange(tx: Tx, orgId: string, q: RangeQuery): Promise<StatutoryDiscountRow[]> {
  return listWhere(tx, rangeClauses(orgId, q));
}

async function listWhere(tx: Tx, where: ReturnType<typeof and>): Promise<StatutoryDiscountRow[]> {
  const rows = await tx
    .select({
      id: statutoryDiscountRecords.id,
      storeId: statutoryDiscountRecords.storeId,
      businessDate: statutoryDiscountRecords.businessDate,
      invoiceNumber: statutoryDiscountRecords.invoiceNumber,
      kind: statutoryDiscountRecords.kind,
      idNumber: statutoryDiscountRecords.idNumber,
      holderName: statutoryDiscountRecords.holderName,
      grossAmount: statutoryDiscountRecords.grossAmount,
      discountAmount: statutoryDiscountRecords.discountAmount,
      // Computed by Postgres so the arithmetic happens in `numeric`, never in a JS float
      // (bible §6 — no money in floats).
      netAmount: sql<string>`(${statutoryDiscountRecords.grossAmount} - ${statutoryDiscountRecords.discountAmount})::text`,
      signatory: statutoryDiscountRecords.signatory,
      source: statutoryDiscountRecords.source,
      notes: statutoryDiscountRecords.notes,
      recordedBy: statutoryDiscountRecords.recordedBy,
      voidedAt: statutoryDiscountRecords.voidedAt,
      voidReason: statutoryDiscountRecords.voidReason,
    })
    .from(statutoryDiscountRecords)
    .where(where)
    // The register reads chronologically, and the invoice number breaks ties within a day so the
    // order is stable rather than merely sorted.
    .orderBy(asc(statutoryDiscountRecords.businessDate), asc(statutoryDiscountRecords.invoiceNumber));
  return rows as StatutoryDiscountRow[];
}

export interface StatutoryDiscountSummary {
  count: number;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  seniorCount: number;
  pwdCount: number;
}

/**
 * The report footer. ⚠️ **Summed in Postgres, in `numeric`** — totalling money in JavaScript is
 * how a register that reconciles on screen stops reconciling on paper.
 */
export async function summaryForRange(tx: Tx, orgId: string, q: RangeQuery): Promise<StatutoryDiscountSummary> {
  const [row] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      grossAmount: sql<string>`coalesce(sum(${statutoryDiscountRecords.grossAmount}), 0)::text`,
      discountAmount: sql<string>`coalesce(sum(${statutoryDiscountRecords.discountAmount}), 0)::text`,
      netAmount: sql<string>`coalesce(sum(${statutoryDiscountRecords.grossAmount} - ${statutoryDiscountRecords.discountAmount}), 0)::text`,
      seniorCount: sql<number>`count(*) filter (where ${statutoryDiscountRecords.kind} = 'senior')::int`,
      pwdCount: sql<number>`count(*) filter (where ${statutoryDiscountRecords.kind} = 'pwd')::int`,
    })
    .from(statutoryDiscountRecords)
    .where(rangeClauses(orgId, q));

  return {
    count: Number(row?.count ?? 0),
    grossAmount: String(row?.grossAmount ?? '0'),
    discountAmount: String(row?.discountAmount ?? '0'),
    netAmount: String(row?.netAmount ?? '0'),
    seniorCount: Number(row?.seniorCount ?? 0),
    pwdCount: Number(row?.pwdCount ?? 0),
  };
}

/**
 * ⛔ **Void, never DELETE.** The burden of proof in a BIR audit is on the seller, so a withdrawn
 * record must remain visible as withdrawn. `WHERE voided_at IS NULL` makes a second void a no-op
 * rather than a silent overwrite of who withdrew it and why.
 */
export async function voidRecord(
  tx: Tx,
  orgId: string,
  id: string,
  by: { voidedBy: string; reason: string },
): Promise<{ voided: boolean }> {
  const updated = await tx
    .update(statutoryDiscountRecords)
    .set({
      voidedAt: new Date(),
      voidedBy: by.voidedBy,
      voidReason: by.reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(statutoryDiscountRecords.orgId, orgId),
        eq(statutoryDiscountRecords.id, id),
        isNull(statutoryDiscountRecords.voidedAt),
      ),
    )
    .returning({ id: statutoryDiscountRecords.id });
  return { voided: updated.length > 0 };
}
