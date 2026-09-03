/**
 * The only place SQL is written for accounts receivable. T-131.
 *
 * ⭐ Mirrors `repo/ap.ts` deliberately — `positionOf`, `openItems`, `aging` and the allocation
 * lock are the same functions pointed the other way. Where AP sums `2110` credits, AR sums `1210`
 * debits; where AP's surplus lands in `1240`, AR's lands in `2140`.
 *
 * ⛔ Nothing is stored. v1's `arTransactions.outstandingAmount` disagrees with its own inputs on
 * **106 of 794 live rows (13.3%)** — that is what a maintained figure looks like after a year, and
 * it is why every number below is a query.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  arCharges,
  arCollections,
  arCollectionAllocations,
  arWriteOffs,
  type ArDocStatus,
} from '../../schema/ar';

export const AR_CONTROL_CODE = '1210';
export const STORE_CREDIT_CODE = '2140';
export const BAD_DEBT_CODE = '6860';
export const PLATFORM_FEE_CODE = '6400';
export const PARTY_TYPE = 'customer';
/** Decimal noise only, never a business allowance. Same value and reasoning as AP's. */
const EPSILON = 0.005;

// -------------------------------------------------------------------------------------
// charges
// -------------------------------------------------------------------------------------

export interface ArChargeRow {
  id: string;
  orgId: string;
  storeId: string;
  customerId: string;
  chargeDate: string;
  dueDate: string | null;
  referenceNo: string | null;
  notes: string | null;
  totalAmount: string;
  revenueAccountCode: string;
  status: ArDocStatus;
  journalEntryId: string | null;
  createdBy: string;
  postedAt: Date | null;
  voidedBy: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
}

export async function insertCharge(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    customerId: string;
    chargeDate: string;
    dueDate: string | null;
    referenceNo: string | null;
    notes: string | null;
    totalAmount: string;
    revenueAccountCode: string;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(arCharges).values(input).returning({ id: arCharges.id });
  return row!;
}

export async function getChargeById(tx: Tx, orgId: string, id: string): Promise<ArChargeRow | undefined> {
  const [row] = await tx
    .select()
    .from(arCharges)
    .where(and(eq(arCharges.id, id), eq(arCharges.orgId, orgId)))
    .limit(1);
  return row as ArChargeRow | undefined;
}

export async function markChargePosted(
  tx: Tx,
  orgId: string,
  id: string,
  input: { journalEntryId: string },
): Promise<void> {
  const updated = await tx
    .update(arCharges)
    .set({ status: 'posted', journalEntryId: input.journalEntryId, postedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(arCharges.id, id), eq(arCharges.orgId, orgId), eq(arCharges.status, 'draft')))
    .returning({ id: arCharges.id });
  if (updated.length === 0) throw new Error(`markChargePosted: charge ${id} is not a draft in org ${orgId}`);
}

export async function markChargeVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; voidReason: string },
): Promise<void> {
  const updated = await tx
    .update(arCharges)
    .set({ status: 'voided', voidedBy: input.voidedBy, voidedAt: sql`now()`, voidReason: input.voidReason, updatedAt: sql`now()` })
    .where(and(eq(arCharges.id, id), eq(arCharges.orgId, orgId), sql`${arCharges.status} <> 'voided'`))
    .returning({ id: arCharges.id });
  if (updated.length === 0) throw new Error(`markChargeVoided: charge ${id} does not exist or is already voided`);
}

// -------------------------------------------------------------------------------------
// ⭐ Derived — every AR figure, from the ledger and the allocation rows
// -------------------------------------------------------------------------------------

export interface ArPosition {
  controlBalance: string;
}

/** What a customer owes, summed from `1210` by party. Mirrors `apRepo.positionOf` exactly. */
export async function positionOf(
  tx: Tx,
  orgId: string,
  customerId: string,
  storeId?: string,
): Promise<ArPosition> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${customerId}
      and a.code = ${AR_CONTROL_CODE}
      and je.status <> 'draft'
      ${storeId ? sql`and jl.store_id = ${storeId}` : sql``}
  `)) as unknown as Record<string, string>[];
  return { controlBalance: Number(row?.balance ?? 0).toFixed(2) };
}

/**
 * ⭐ T-179. A customer's spendable store credit — `2140`, party-filtered, never a stored balance
 * (DEF-075). Mirrors T-170's `advancesPositionOf` (`repo/ap.ts`) pointed the other way: `2140` is
 * a LIABILITY, so its balance is `credit - debit`, opposite `positionOf`'s asset-side `1210`.
 */
export async function creditBalanceOf(tx: Tx, orgId: string, customerId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${customerId}
      and a.code = ${STORE_CREDIT_CODE}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return Number(row?.balance ?? 0).toFixed(2);
}

export interface ArOpenItem {
  chargeId: string;
  customerId: string;
  storeId: string;
  chargeDate: string;
  dueDate: string | null;
  referenceNo: string | null;
  totalAmount: string;
  allocatedAmount: string;
  writtenOffAmount: string;
  outstanding: string;
}

/**
 * Every charge still owed, oldest first.
 *
 * ⚠️ **Store-scoped and required**, exactly as AP's is (Ian, 2026-08-28). A collection posts every
 * leg at its own store, so settling another store's charge would clear a receivable that store
 * never recorded.
 */
export async function openItems(
  tx: Tx,
  orgId: string,
  customerId: string,
  storeId: string,
): Promise<ArOpenItem[]> {
  const rows = (await tx.execute(sql`
    with allocated as (
      select a.ar_charge_id, sum(a.amount_applied) as amt
      from ar_collection_allocations a
      join ar_collections c on c.id = a.ar_collection_id
      where c.status = 'posted'
      group by a.ar_charge_id
    ),
    written as (
      select ar_charge_id, sum(amount) as amt from ar_write_offs group by ar_charge_id
    )
    select ch.id as charge_id, ch.customer_id, ch.store_id, ch.charge_date::text as charge_date,
           ch.due_date::text as due_date, ch.reference_no, ch.total_amount::text as total_amount,
           coalesce(al.amt, 0)::text as allocated_amount,
           coalesce(w.amt, 0)::text as written_off_amount,
           (ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0))::text as outstanding
    from ar_charges ch
    left join allocated al on al.ar_charge_id = ch.id
    left join written w on w.ar_charge_id = ch.id
    where ch.org_id = ${orgId} and ch.customer_id = ${customerId} and ch.store_id = ${storeId}
      and ch.status = 'posted'
      and (ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0)) > ${EPSILON}
    order by ch.charge_date asc
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    chargeId: String(r.charge_id ?? r.chargeId),
    customerId: String(r.customer_id ?? r.customerId),
    storeId: String(r.store_id ?? r.storeId),
    chargeDate: String(r.charge_date ?? r.chargeDate),
    dueDate: r.due_date ? String(r.due_date) : null,
    referenceNo: r.reference_no ? String(r.reference_no) : null,
    totalAmount: Number(r.total_amount).toFixed(2),
    allocatedAmount: Number(r.allocated_amount).toFixed(2),
    writtenOffAmount: Number(r.written_off_amount).toFixed(2),
    outstanding: Number(r.outstanding).toFixed(2),
  }));
}

/**
 * ⭐ T-179 invariant 9. What is still owed on ONE specific charge — not the customer's whole
 * position, which `positionOf` already gives and which a return must not reduce by more than
 * this one order actually still owes.
 */
export async function outstandingForCharge(tx: Tx, orgId: string, chargeId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    with allocated as (
      select a.ar_charge_id, sum(a.amount_applied) as amt
      from ar_collection_allocations a
      join ar_collections c on c.id = a.ar_collection_id
      where c.status = 'posted'
      group by a.ar_charge_id
    ),
    written as (
      select ar_charge_id, sum(amount) as amt from ar_write_offs group by ar_charge_id
    )
    select (ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0))::text as outstanding
    from ar_charges ch
    left join allocated al on al.ar_charge_id = ch.id
    left join written w on w.ar_charge_id = ch.id
    where ch.org_id = ${orgId} and ch.id = ${chargeId} and ch.status = 'posted'
  `)) as unknown as Record<string, string>[];
  return row ? Number(row.outstanding).toFixed(2) : '0.00';
}

export interface ArAgingBucket {
  customerId: string;
  storeId: string;
  current: string;
  d1to30: string;
  d31to60: string;
  d61to90: string;
  d90plus: string;
}

/** Buckets by DUE DATE, falling back to the charge's own date — bible row 162. */
export async function aging(
  tx: Tx,
  orgId: string,
  asOfDate: string,
  storeId?: string,
): Promise<ArAgingBucket[]> {
  const rows = (await tx.execute(sql`
    with allocated as (
      select a.ar_charge_id, sum(a.amount_applied) as amt
      from ar_collection_allocations a
      join ar_collections c on c.id = a.ar_collection_id
      where c.status = 'posted'
      group by a.ar_charge_id
    ),
    written as (
      select ar_charge_id, sum(amount) as amt from ar_write_offs group by ar_charge_id
    ),
    open as (
      select ch.customer_id, ch.store_id,
             coalesce(ch.due_date, ch.charge_date) as aging_date,
             (ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0)) as outstanding
      from ar_charges ch
      left join allocated al on al.ar_charge_id = ch.id
      left join written w on w.ar_charge_id = ch.id
      where ch.org_id = ${orgId} and ch.status = 'posted'
        and (ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0)) > ${EPSILON}
        ${storeId ? sql`and ch.store_id = ${storeId}` : sql``}
    )
    select customer_id, store_id,
      coalesce(sum(outstanding) filter (where aging_date >= ${asOfDate}), 0)::text as current,
      coalesce(sum(outstanding) filter (where aging_date < ${asOfDate} and aging_date >= (${asOfDate}::date - 30)), 0)::text as d1to30,
      coalesce(sum(outstanding) filter (where aging_date < (${asOfDate}::date - 30) and aging_date >= (${asOfDate}::date - 60)), 0)::text as d31to60,
      coalesce(sum(outstanding) filter (where aging_date < (${asOfDate}::date - 60) and aging_date >= (${asOfDate}::date - 90)), 0)::text as d61to90,
      coalesce(sum(outstanding) filter (where aging_date < (${asOfDate}::date - 90)), 0)::text as d90plus
    from open group by customer_id, store_id order by customer_id, store_id
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    customerId: String(r.customer_id ?? r.customerId),
    storeId: String(r.store_id ?? r.storeId),
    current: Number(r.current).toFixed(2),
    d1to30: Number(r.d1to30).toFixed(2),
    d31to60: Number(r.d31to60).toFixed(2),
    d61to90: Number(r.d61to90).toFixed(2),
    d90plus: Number(r.d90plus).toFixed(2),
  }));
}

/**
 * ⛔ Lock the charges a collection is about to settle, BEFORE reading their balances.
 *
 * ⚠️ AP's equivalent test **passed before its lock existed**, purely because the winning
 * transaction happened to commit before the loser read. This one is written knowing that: without
 * the lock two collections both see a charge as open and both settle it.
 */
export async function lockChargesForAllocation(tx: Tx, orgId: string, chargeIds: string[]): Promise<void> {
  if (chargeIds.length === 0) return;
  const ids = sql.join(chargeIds.map((id) => sql`${id}`), sql`, `);
  await tx.execute(sql`
    select id from ar_charges where org_id = ${orgId} and id in (${ids}) order by id for update
  `);
}

// -------------------------------------------------------------------------------------
// collections, allocations, write-offs
// -------------------------------------------------------------------------------------

export interface ArCollectionRow {
  id: string;
  orgId: string;
  storeId: string;
  customerId: string;
  collectionDate: string;
  amount: string;
  platformFee: string;
  moneyAccountId: string;
  referenceNo: string | null;
  notes: string | null;
  receiptFileId: string | null;
  status: ArDocStatus;
  journalEntryId: string | null;
  createdBy: string;
}

export async function insertCollection(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    customerId: string;
    collectionDate: string;
    amount: string;
    platformFee: string;
    moneyAccountId: string;
    referenceNo: string | null;
    notes: string | null;
    receiptFileId: string | null;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(arCollections).values(input).returning({ id: arCollections.id });
  return row!;
}

export async function getCollectionById(tx: Tx, orgId: string, id: string): Promise<ArCollectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(arCollections)
    .where(and(eq(arCollections.id, id), eq(arCollections.orgId, orgId)))
    .limit(1);
  return row as ArCollectionRow | undefined;
}

export async function markCollectionPosted(
  tx: Tx,
  orgId: string,
  id: string,
  input: { journalEntryId: string },
): Promise<void> {
  await tx
    .update(arCollections)
    .set({ status: 'posted', journalEntryId: input.journalEntryId, postedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(arCollections.id, id), eq(arCollections.orgId, orgId)));
}

export async function markCollectionVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedBy: string; voidReason: string },
): Promise<void> {
  const updated = await tx
    .update(arCollections)
    .set({ status: 'voided', voidedBy: input.voidedBy, voidedAt: sql`now()`, voidReason: input.voidReason, updatedAt: sql`now()` })
    .where(and(eq(arCollections.id, id), eq(arCollections.orgId, orgId), sql`${arCollections.status} <> 'voided'`))
    .returning({ id: arCollections.id });
  if (updated.length === 0) throw new Error(`markCollectionVoided: collection ${id} does not exist or is already voided`);
}

export async function insertAllocations(
  tx: Tx,
  collectionId: string,
  allocations: { chargeId: string; amountApplied: string }[],
): Promise<void> {
  if (allocations.length === 0) return;
  await tx.insert(arCollectionAllocations).values(
    allocations.map((a) => ({
      arCollectionId: collectionId,
      arChargeId: a.chargeId,
      amountApplied: a.amountApplied,
    })),
  );
}

export async function insertWriteOff(
  tx: Tx,
  input: {
    orgId: string;
    arChargeId: string;
    amount: string;
    reason: string;
    journalEntryId: string;
    writtenOffBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(arWriteOffs).values(input).returning({ id: arWriteOffs.id });
  return row!;
}
