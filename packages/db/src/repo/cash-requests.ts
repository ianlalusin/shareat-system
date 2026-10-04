/**
 * The only place SQL is written for cash requests. T-144, bible row 159.
 *
 * ## ⭐ `floatPositionOf` is the point of this file
 *
 * v1 stores `remainingAmount` and `varianceAmount`; both are subtractions of things the ledger
 * already knows. Here the float is read off `1120`, attributed by the party — so *"who still owes
 * a liquidation?"* has exactly one answer.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { cashRequests, type CashRequestStatus } from '../../schema/cash-requests';
import { recordGone } from './record-gone';
import type { Money } from '@shareat/core/money';
import type { SafeInsert, SafeUpdate } from './numeric-input';

export const STAFF_FLOAT_CODE = '1120';
export const RELEASE_SOURCE = 'cash_request_release';
export const RETURN_SOURCE = 'cash_request_return';
export const SHORTAGE_SOURCE = 'cash_request_shortage';
export const PARTY_TYPE = 'cash_request';

export interface CashRequestRow {
  id: string;
  orgId: string;
  storeId: string;
  requestedFor: string;
  purpose: string;
  requestedAmount: string;
  requestedOn: string;
  status: CashRequestStatus;
  approvedAmount: string | null;
  approvedBy: string | null;
  decidedOn: string | null;
  rejectReason: string | null;
  releasedFromMoneyAccountId: string | null;
  releasedOn: string | null;
  releasedBy: string | null;
  notes: string | null;
  createdAt: Date;
}

/** T-371 C2 — `requestedAmount` is NOT NULL, no default: a `Money` brand minted by `money()`/`decimal()`. */
export type InsertRequestInput = Pick<
  SafeInsert<typeof cashRequests>,
  'orgId' | 'storeId' | 'requestedFor' | 'purpose' | 'requestedOn' | 'createdBy'
> & {
  requestedAmount: Money;
  notes: string | null;
};

export async function insertRequest(
  tx: Tx,
  input: InsertRequestInput,
): Promise<{ id: string }> {
  const [row] = await tx.insert(cashRequests).values(input).returning({ id: cashRequests.id });
  return row!;
}

export async function getById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CashRequestRow | undefined> {
  const [row] = await tx
    .select()
    .from(cashRequests)
    .where(and(eq(cashRequests.id, id), eq(cashRequests.orgId, orgId)))
    .limit(1);
  return row as CashRequestRow | undefined;
}

export async function listRequests(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string; status?: CashRequestStatus } = {},
): Promise<CashRequestRow[]> {
  const conditions = [eq(cashRequests.orgId, orgId)];
  if (filter.storeId) conditions.push(eq(cashRequests.storeId, filter.storeId));
  if (filter.status) conditions.push(eq(cashRequests.status, filter.status));
  const rows = await tx
    .select()
    .from(cashRequests)
    .where(and(...conditions))
    .orderBy(desc(cashRequests.requestedOn))
    .limit(200);
  return rows as CashRequestRow[];
}

/** T-371 C2 — `approvedAmount` is nullable (14,2): a `Money` brand or null. */
export type UpdateRequestValues = Pick<
  SafeUpdate<typeof cashRequests>,
  'approvedBy' | 'decidedOn' | 'rejectReason' | 'releasedFromMoneyAccountId' | 'releasedOn' | 'releasedBy'
> & {
  status?: CashRequestStatus;
  approvedAmount?: Money | null;
};

export async function update(
  tx: Tx,
  orgId: string,
  id: string,
  values: UpdateRequestValues,
): Promise<void> {
  const updated = await tx
    .update(cashRequests)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(cashRequests.id, id), eq(cashRequests.orgId, orgId)))
    .returning({ id: cashRequests.id });
  if (updated.length === 0) {
    throw recordGone(`update: cash request ${id} does not exist in org ${orgId}`, 'cash request');
  }
}

// -------------------------------------------------------------------------------------
// ⭐ Derived — the float, read off 1120
// -------------------------------------------------------------------------------------

export interface FloatPosition {
  released: string;
  /** Spent through expenses — T-122 already posts these against `1120`. */
  spent: string;
  returned: string;
  short: string;
  /** ⭐ What the holder still has. **Zero closes the request** — derived, never stamped. */
  outstanding: string;
}

/**
 * The float's position, from the ledger.
 *
 * ⭐ **`outstanding` is simply the balance of `1120` for this party** — every debit is money going
 * out to the holder, every credit is money accounted for. That it equals
 * `released − spent − returned − short` is arithmetic, not a second definition, which is exactly
 * why it cannot disagree with itself.
 *
 * ⚠️ Reversed entries are INCLUDED: they and their reversals net to zero. Excluding the original
 * while keeping its mirror is the mistake T-126 made and its tests caught.
 */
export async function floatPositionOf(
  tx: Tx,
  orgId: string,
  requestId: string,
): Promise<FloatPosition> {
  const [row] = (await tx.execute(sql`
    select
      coalesce(sum(case when je.source_type = ${RELEASE_SOURCE}  then jl.debit  - jl.credit else 0 end), 0)::text as released,
      coalesce(sum(case when je.source_type = ${RETURN_SOURCE}   then jl.credit - jl.debit  else 0 end), 0)::text as returned,
      coalesce(sum(case when je.source_type = ${SHORTAGE_SOURCE} then jl.credit - jl.debit  else 0 end), 0)::text as short,
      coalesce(sum(case when je.source_type not in (${RELEASE_SOURCE}, ${RETURN_SOURCE}, ${SHORTAGE_SOURCE})
                        then jl.credit - jl.debit else 0 end), 0)::text as spent,
      coalesce(sum(jl.debit - jl.credit), 0)::text as outstanding
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${requestId}
      and a.code = ${STAFF_FLOAT_CODE}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];

  const n = (k: string, alt: string) => Number(row?.[k] ?? row?.[alt] ?? 0);
  return {
    released: n('released', 'released').toFixed(2),
    spent: n('spent', 'spent').toFixed(2),
    returned: n('returned', 'returned').toFixed(2),
    short: n('short', 'short').toFixed(2),
    outstanding: n('outstanding', 'outstanding').toFixed(2),
  };
}

/** Every request's float in one query — the register's N+1 guard. */
export async function floatsByRequest(
  tx: Tx,
  orgId: string,
): Promise<Map<string, FloatPosition>> {
  const rows = await tx.execute(sql`
    select jl.party_id as request_id,
      coalesce(sum(case when je.source_type = ${RELEASE_SOURCE}  then jl.debit  - jl.credit else 0 end), 0)::text as released,
      coalesce(sum(case when je.source_type = ${RETURN_SOURCE}   then jl.credit - jl.debit  else 0 end), 0)::text as returned,
      coalesce(sum(case when je.source_type = ${SHORTAGE_SOURCE} then jl.credit - jl.debit  else 0 end), 0)::text as short,
      coalesce(sum(case when je.source_type not in (${RELEASE_SOURCE}, ${RETURN_SOURCE}, ${SHORTAGE_SOURCE})
                        then jl.credit - jl.debit else 0 end), 0)::text as spent,
      coalesce(sum(jl.debit - jl.credit), 0)::text as outstanding
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and a.code = ${STAFF_FLOAT_CODE}
      and je.status <> 'draft'
    group by jl.party_id
  `);

  const map = new Map<string, FloatPosition>();
  for (const r of rows as unknown as Record<string, string>[]) {
    map.set(String(r.request_id ?? r.requestId), {
      released: Number(r.released ?? 0).toFixed(2),
      spent: Number(r.spent ?? 0).toFixed(2),
      returned: Number(r.returned ?? 0).toFixed(2),
      short: Number(r.short ?? 0).toFixed(2),
      outstanding: Number(r.outstanding ?? 0).toFixed(2),
    });
  }
  return map;
}

/** ⭐ Floats still in someone's hands — the list that must not hide. */
export async function openFloats(tx: Tx, orgId: string): Promise<CashRequestRow[]> {
  const rows = await tx
    .select()
    .from(cashRequests)
    .where(
      and(
        eq(cashRequests.orgId, orgId),
        eq(cashRequests.status, 'released'),
        ne(cashRequests.status, 'liquidated'),
      ),
    )
    .orderBy(desc(cashRequests.releasedOn));
  return rows as CashRequestRow[];
}
