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
import { recordGone } from './record-gone';
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
  if (updated.length === 0) throw recordGone(`markChargePosted: charge ${id} is not a draft in org ${orgId}`, 'charge', 'a draft');
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
  if (updated.length === 0) throw recordGone(`markChargeVoided: charge ${id} does not exist or is already voided`, 'charge');
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
 * ⭐ T-209b — the whole register's control balance, org-wide or for one store. Mirrors
 * `apRepo.orgAgingTotal` pointed the other way (`1210` is an asset, `debit - credit`).
 */
export async function orgAgingTotal(tx: Tx, orgId: string, storeId?: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and a.code = ${AR_CONTROL_CODE}
      and je.status <> 'draft'
      ${storeId ? sql`and jl.store_id = ${storeId}` : sql``}
  `)) as unknown as Record<string, string>[];
  return Number(row?.balance ?? 0).toFixed(2);
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
  if (updated.length === 0) throw recordGone(`markCollectionVoided: collection ${id} does not exist or is already voided`, 'collection');
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

// -------------------------------------------------------------------------------------
// registers — T-226
// -------------------------------------------------------------------------------------

export interface ArChargeListRow {
  chargeId: string;
  storeId: string;
  chargeDate: string;
  dueDate: string | null;
  referenceNo: string | null;
  notes: string | null;
  totalAmount: string;
  allocatedAmount: string;
  writtenOffAmount: string;
  outstanding: string;
  status: ArDocStatus;
  journalEntryId: string | null;
  createdBy: string;
}

/**
 * Every charge a customer has, settled or not — the register `openItems` deliberately is not.
 *
 * ⭐ `allocated` / `writtenOff` / `outstanding` come out of the SAME CTEs `openItems` uses, in one
 * statement. ⛔ Computing outstanding in TypeScript from two other queries would be a second
 * derivation of one figure, and two derivations of one figure are exactly how v1's stored
 * `outstandingBalance` came to disagree with its own inputs on 106 of 794 live rows.
 *
 * ⚠️ A voided charge reports `outstanding = 0.00`, never its arithmetic remainder. Its entry was
 * reversed, so nothing is owed on it — reporting the remainder would show a debt that does not
 * exist and would not tie to `1210`.
 */
export async function listChargesForCustomer(
  tx: Tx,
  orgId: string,
  customerId: string,
  opts: { storeId?: string; limit?: number } = {},
): Promise<ArChargeListRow[]> {
  const storeFilter = opts.storeId ? sql`and ch.store_id = ${opts.storeId}` : sql``;
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
    select ch.id as charge_id, ch.store_id, ch.charge_date::text as charge_date,
           ch.due_date::text as due_date, ch.reference_no, ch.notes,
           ch.total_amount::text as total_amount,
           coalesce(al.amt, 0)::text as allocated_amount,
           coalesce(w.amt, 0)::text as written_off_amount,
           (case when ch.status = 'posted'
                 then ch.total_amount - coalesce(al.amt, 0) - coalesce(w.amt, 0)
                 else 0 end)::text as outstanding,
           ch.status, ch.journal_entry_id, ch.created_by
    from ar_charges ch
    left join allocated al on al.ar_charge_id = ch.id
    left join written w on w.ar_charge_id = ch.id
    where ch.org_id = ${orgId} and ch.customer_id = ${customerId} ${storeFilter}
    order by ch.charge_date desc, ch.created_at desc
    limit ${opts.limit ?? 200}
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    chargeId: String(r.charge_id),
    storeId: String(r.store_id),
    chargeDate: String(r.charge_date),
    dueDate: r.due_date ? String(r.due_date) : null,
    referenceNo: r.reference_no ? String(r.reference_no) : null,
    notes: r.notes ? String(r.notes) : null,
    totalAmount: Number(r.total_amount).toFixed(2),
    allocatedAmount: Number(r.allocated_amount).toFixed(2),
    writtenOffAmount: Number(r.written_off_amount).toFixed(2),
    outstanding: Number(r.outstanding).toFixed(2),
    status: String(r.status) as ArDocStatus,
    journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
    createdBy: String(r.created_by),
  }));
}

export interface ArCollectionAllocationView {
  chargeId: string;
  referenceNo: string | null;
  chargeDate: string;
  amountApplied: string;
}

export interface ArCollectionListRow {
  collectionId: string;
  storeId: string;
  collectionDate: string;
  amount: string;
  platformFee: string;
  moneyAccountId: string;
  moneyAccountName: string | null;
  referenceNo: string | null;
  notes: string | null;
  receiptFileId: string | null;
  status: ArDocStatus;
  journalEntryId: string | null;
  allocations: ArCollectionAllocationView[];
}

/**
 * What has come back in — and the half a list of amounts cannot answer: WHICH debts each payment
 * settled.
 *
 * ⭐ The allocations are aggregated in the same statement rather than fetched per row. A follow-up
 * query per collection is an N+1 on a page whose entire purpose is showing many rows.
 */
export async function listCollectionsForCustomer(
  tx: Tx,
  orgId: string,
  customerId: string,
  opts: { storeId?: string; limit?: number } = {},
): Promise<ArCollectionListRow[]> {
  const storeFilter = opts.storeId ? sql`and co.store_id = ${opts.storeId}` : sql``;
  const rows = (await tx.execute(sql`
    select co.id as collection_id, co.store_id, co.collection_date::text as collection_date,
           co.amount::text as amount, co.platform_fee::text as platform_fee,
           co.money_account_id, ma.name as money_account_name,
           co.reference_no, co.notes, co.receipt_file_id, co.status, co.journal_entry_id,
           coalesce(
             (select json_agg(json_build_object(
                        'chargeId', a.ar_charge_id,
                        'referenceNo', ch.reference_no,
                        'chargeDate', ch.charge_date::text,
                        'amountApplied', a.amount_applied::text)
                      order by ch.charge_date asc)
              from ar_collection_allocations a
              join ar_charges ch on ch.id = a.ar_charge_id
              where a.ar_collection_id = co.id),
             '[]'::json) as allocations
    from ar_collections co
    left join money_accounts ma on ma.id = co.money_account_id
    where co.org_id = ${orgId} and co.customer_id = ${customerId} ${storeFilter}
    order by co.collection_date desc, co.created_at desc
    limit ${opts.limit ?? 200}
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    collectionId: String(r.collection_id),
    storeId: String(r.store_id),
    collectionDate: String(r.collection_date),
    amount: Number(r.amount).toFixed(2),
    platformFee: Number(r.platform_fee).toFixed(2),
    moneyAccountId: String(r.money_account_id),
    moneyAccountName: r.money_account_name ? String(r.money_account_name) : null,
    referenceNo: r.reference_no ? String(r.reference_no) : null,
    notes: r.notes ? String(r.notes) : null,
    receiptFileId: r.receipt_file_id ? String(r.receipt_file_id) : null,
    status: String(r.status) as ArDocStatus,
    journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
    allocations: ((r.allocations ?? []) as ArCollectionAllocationView[]).map((a) => ({
      chargeId: String(a.chargeId),
      referenceNo: a.referenceNo ? String(a.referenceNo) : null,
      chargeDate: String(a.chargeDate),
      amountApplied: Number(a.amountApplied).toFixed(2),
    })),
  }));
}

export interface ArWriteOffView {
  id: string;
  chargeId: string;
  amount: string;
  reason: string;
  journalEntryId: string;
  writtenOffBy: string;
  writtenOffAt: Date;
}

/**
 * ⚠️ Keyed by CHARGE, and a list rather than a total. Partial write-offs are supported, so
 * "written off" is a history: one number would hide that a debt was declared dead twice, by two
 * people, on two dates — which is precisely what anyone auditing a write-off wants to see.
 */
export async function listWriteOffsForCharge(tx: Tx, orgId: string, chargeId: string): Promise<ArWriteOffView[]> {
  const rows = await tx
    .select()
    .from(arWriteOffs)
    .where(and(eq(arWriteOffs.orgId, orgId), eq(arWriteOffs.arChargeId, chargeId)))
    .orderBy(arWriteOffs.writtenOffAt);
  return rows.map((r) => ({
    id: r.id,
    chargeId: r.arChargeId,
    amount: Number(r.amount).toFixed(2),
    reason: r.reason,
    journalEntryId: r.journalEntryId,
    writtenOffBy: r.writtenOffBy,
    writtenOffAt: r.writtenOffAt,
  }));
}
