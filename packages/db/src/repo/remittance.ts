/**
 * The only place SQL is written for remittance. T-143, bible rows 144–147 and **157**.
 *
 * ## ⭐ `endDayReports` is the point of this file
 *
 * > **Ian, 2026-08-27:** *"It must be END DAY REPORT, not sales report. The sales report is PART
 * > of that remittance / end-day report… the composition of all money movement of the day across
 * > transactions, on ERP."*
 *
 * So what a day is owed is **the cashier's net movement for that date**, read from the ledger —
 * not its remittable sales, and not a sum over document types. Row 145 said the same thing about
 * the total; row 157 says it per date. **They are one figure.**
 *
 * ⛔ **No `expected` column exists, and none should.** A query that enumerated document types
 * would be wrong the day a new one appears — silently, and in the safe-looking direction. This one
 * asks the ledger what the cashier actually holds, so a document type nobody has invented yet is
 * already included.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { moneyAccounts } from '../../schema/money-accounts';
import {
  remittanceAllocations,
  remittanceLines,
  remittanceVariances,
  remittances,
  type VarianceStatus,
} from '../../schema/remittance';

export interface EndDayReport {
  businessDate: string;
  /** ⭐ Everything the cashier touched that date, net. Sales, collections and returns in; expenses
   *  paid from the till, cash requests released and advances out. */
  movement: string;
  /** Already settled by earlier batches — remittance is ADDITIVE (row 146). */
  allocated: string;
  /** `movement − allocated`. What FIFO will try to cover. */
  owed: string;
  salesDayId: string | null;
  salesDayStatus: string | null;
  /** ⚠️ Only a VERIFIED day is remittable — an unverified one has no signed count behind it. */
  remittable: boolean;
}

/**
 * Every date with cashier movement for one store, oldest first.
 *
 * ⚠️ **Transfers are excluded, in BOTH directions, and that is a scoping decision worth naming.**
 * A transfer moves money between the business's own accounts — it is custody, not a transaction of
 * the day. Including them would make the remittance itself reduce the very day it settles, and
 * would sweep an office→cashier float back to the office as if it were takings.
 *
 * ⛔ Whether a standing float should be *excluded from remittance permanently* is T-136 §2's
 * imprest question, and its research pass is still owed. This does not pre-empt it: it only keeps
 * transfers out of the day's takings, which is true regardless of how the float is modelled.
 */
export async function endDayReports(
  tx: Tx,
  orgId: string,
  input: { storeId: string; upTo: string },
): Promise<EndDayReport[]> {
  const rows = await tx.execute(sql`
    with cashier_movement as (
      select je.entry_date::text                          as business_date,
             coalesce(sum(jl.debit - jl.credit), 0)::text as movement
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a        on a.id = jl.account_id
      -- The wallet a 1140 line names, when it names one.
      left join money_accounts ma
        on ma.id::text = jl.party_id and jl.party_type = 'money_account'
      -- Otherwise the custodian the cash code itself implies.
      left join (values ('1110','cashier'), ('1120','staff'), ('1130','office'))
        as ca(code, custodian) on ca.code = a.code
      where je.org_id = ${orgId}
        and je.status <> 'draft'
        and jl.store_id = ${input.storeId}
        and a.code ~ '^11[0-9]{2}$'
        and coalesce(ma.custodian, ca.custodian) = 'cashier'
        -- ⚠️ See the note above: custody movement, not a transaction of the day.
        and je.source_type <> 'transfer'
        and je.entry_date <= ${input.upTo}
      group by je.entry_date
    ),
    settled as (
      select ra.business_date::text as business_date,
             coalesce(sum(ra.amount), 0)::text as allocated
      from remittance_allocations ra
      join remittances r on r.id = ra.remittance_id
      where r.org_id = ${orgId} and r.store_id = ${input.storeId} and r.status = 'posted'
      group by ra.business_date
    )
    select m.business_date,
           m.movement,
           coalesce(s.allocated, '0')                          as allocated,
           (m.movement::numeric - coalesce(s.allocated, '0')::numeric)::text as owed,
           sd.id::text                                         as sales_day_id,
           sd.status                                           as sales_day_status,
           (sd.status = 'verified')                            as remittable
    from cashier_movement m
    left join settled s   on s.business_date = m.business_date
    left join sales_days sd
      on sd.org_id = ${orgId} and sd.store_id = ${input.storeId}
     and sd.business_date::text = m.business_date and sd.status <> 'voided'
    where m.movement::numeric <> 0 or coalesce(s.allocated, '0')::numeric <> 0
    order by m.business_date asc
  `);

  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    businessDate: String(r.business_date ?? r.businessDate),
    movement: String(r.movement),
    allocated: String(r.allocated),
    owed: String(r.owed),
    salesDayId: (r.sales_day_id ?? r.salesDayId ?? null) as string | null,
    salesDayStatus: (r.sales_day_status ?? r.salesDayStatus ?? null) as string | null,
    remittable: Boolean(r.remittable),
  }));
}

// -------------------------------------------------------------------------------------
// Writes
// -------------------------------------------------------------------------------------

export interface InsertRemittanceInput {
  orgId: string;
  storeId: string;
  remittedOn: string;
  reference: string | null;
  notes: string | null;
  acceptedBy: string | null;
  createdBy: string;
}

export async function insertRemittance(
  tx: Tx,
  input: InsertRemittanceInput,
): Promise<{ id: string }> {
  const [row] = await tx.insert(remittances).values(input).returning({ id: remittances.id });
  return row!;
}

export async function insertLine(
  tx: Tx,
  input: {
    remittanceId: string;
    fromMoneyAccountId: string;
    toMoneyAccountId: string;
    amount: string;
    moneyTransferId: string;
  },
): Promise<void> {
  await tx.insert(remittanceLines).values(input);
}

export async function insertAllocation(
  tx: Tx,
  input: {
    remittanceId: string;
    businessDate: string;
    salesDayId: string | null;
    amount: string;
  },
): Promise<void> {
  await tx.insert(remittanceAllocations).values(input);
}

export async function insertVariance(
  tx: Tx,
  input: {
    orgId: string;
    remittanceId: string;
    businessDate: string;
    salesDayId: string | null;
    amount: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(remittanceVariances)
    .values(input)
    .returning({ id: remittanceVariances.id });
  return row!;
}

export async function getById(tx: Tx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(remittances)
    .where(and(eq(remittances.id, id), eq(remittances.orgId, orgId)))
    .limit(1);
  return row;
}

export async function linesFor(tx: Tx, remittanceId: string) {
  return tx
    .select()
    .from(remittanceLines)
    .where(eq(remittanceLines.remittanceId, remittanceId))
    .orderBy(asc(remittanceLines.id));
}

export async function allocationsFor(tx: Tx, remittanceId: string) {
  return tx
    .select()
    .from(remittanceAllocations)
    .where(eq(remittanceAllocations.remittanceId, remittanceId))
    .orderBy(asc(remittanceAllocations.businessDate));
}

export async function listRemittances(tx: Tx, orgId: string, storeId?: string) {
  const conditions = [eq(remittances.orgId, orgId)];
  if (storeId) conditions.push(eq(remittances.storeId, storeId));
  return tx
    .select()
    .from(remittances)
    .where(and(...conditions))
    .orderBy(desc(remittances.remittedOn))
    .limit(100);
}

export async function markReversed(
  tx: Tx,
  orgId: string,
  id: string,
  input: { reversedOn: string; reverseReason: string },
): Promise<void> {
  const updated = await tx
    .update(remittances)
    .set({ status: 'reversed', ...input })
    .where(
      and(eq(remittances.id, id), eq(remittances.orgId, orgId), eq(remittances.status, 'posted')),
    )
    .returning({ id: remittances.id });
  if (updated.length === 0) {
    throw new Error(`markReversed: remittance ${id} does not exist in org ${orgId}, or is already reversed`);
  }
}

/** ⭐ Open variances — the list that must not hide (Ian, row 147). */
export async function listVariances(tx: Tx, orgId: string, status?: VarianceStatus) {
  const conditions = [eq(remittanceVariances.orgId, orgId)];
  if (status) conditions.push(eq(remittanceVariances.status, status));
  return tx
    .select()
    .from(remittanceVariances)
    .where(and(...conditions))
    .orderBy(desc(remittanceVariances.businessDate));
}

/**
 * A variance with the store it belongs to.
 *
 * ⚠️ The store comes from the REMITTANCE, not from the variance — `accept_remittance` is
 * store-scoped, and a variance with no store to check would either be ungated or would need a
 * store column that could disagree with its parent.
 */
export async function getVarianceWithStore(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ id: string; storeId: string; status: VarianceStatus } | undefined> {
  const [row] = await tx
    .select({
      id: remittanceVariances.id,
      storeId: remittances.storeId,
      status: remittanceVariances.status,
    })
    .from(remittanceVariances)
    .innerJoin(remittances, eq(remittances.id, remittanceVariances.remittanceId))
    .where(and(eq(remittanceVariances.id, id), eq(remittanceVariances.orgId, orgId)))
    .limit(1);
  return row;
}

export async function resolveVariance(
  tx: Tx,
  orgId: string,
  id: string,
  input: {
    status: 'charged' | 'written_off';
    chargedToPersonId: string | null;
    reason: string | null;
    resolvedBy: string;
    resolvedOn: string;
  },
): Promise<void> {
  const updated = await tx
    .update(remittanceVariances)
    .set(input)
    .where(
      and(
        eq(remittanceVariances.id, id),
        eq(remittanceVariances.orgId, orgId),
        eq(remittanceVariances.status, 'open'),
      ),
    )
    .returning({ id: remittanceVariances.id });
  if (updated.length === 0) {
    throw new Error(`resolveVariance: variance ${id} does not exist in org ${orgId}, or is not open`);
  }
}
