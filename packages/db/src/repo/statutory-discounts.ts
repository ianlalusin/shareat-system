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
import type { Money } from '@shareat/core/money';

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
  grossAmount: Money;
  discountAmount: Money;
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

export interface PriorIdUse {
  invoiceNumber: string;
  businessDate: string;
  /** When the sale was made: the receipt's own device time when a till receipt backs the row, else when the row was written. */
  at: Date;
  /** The till receipt behind the row, when there is one (a hand-entered register row, or a diner whose discount rounded to nothing, has none). */
  receiptId: string | null;
}

/**
 * T-575: the LIVE register rows of ONE store where this card number (trimmed, any case) was used on a business date in [from, to], newest first, never the holder's name.
 * `excludeInvoiceNumber` keeps the sale being written out of its own answer. The match is `lower(btrim(id_number))`, the same key as the one-live-row-per-card index.
 */
export async function listPriorIdUses(
  tx: Tx,
  orgId: string,
  q: { storeId: string; idNumber: string; from: string; to: string; excludeInvoiceNumber?: string },
): Promise<PriorIdUse[]> {
  const r = statutoryDiscountRecords;
  const receiptOf = sql`(select rc.id, rc.issued_at_device from pos_sales_receipt_line_discounts d join pos_sales_receipt_lines l on l.id = d.receipt_line_id join pos_sales_receipts rc on rc.id = l.receipt_id where d.statutory_record_id = ${r.id} order by rc.issued_at_device limit 1)`;
  const clauses = [
    eq(r.orgId, orgId),
    eq(r.storeId, q.storeId),
    isNull(r.voidedAt),
    gte(r.businessDate, q.from),
    lte(r.businessDate, q.to),
    sql`lower(btrim(${r.idNumber})) = lower(btrim(${q.idNumber}))`,
  ];
  if (q.excludeInvoiceNumber !== undefined) clauses.push(sql`${r.invoiceNumber} <> ${q.excludeInvoiceNumber}`);
  const rows = await tx
    .select({
      invoiceNumber: r.invoiceNumber,
      businessDate: r.businessDate,
      createdAt: r.createdAt,
      receiptId: sql<string | null>`(select x.id from ${receiptOf} x)`,
      receiptAt: sql<Date | string | null>`(select x.issued_at_device from ${receiptOf} x)`,
    })
    .from(r)
    .where(and(...clauses));
  return rows
    .map((x) => ({ invoiceNumber: x.invoiceNumber, businessDate: x.businessDate, at: x.receiptAt ? new Date(x.receiptAt) : x.createdAt, receiptId: x.receiptId }))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
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
