/**
 * The only place SQL is written for liabilities. T-128.
 *
 * ⭐ `positionOf` is the point of this file. v1 stores `outstandingBalance`, `totalCharged` and
 * `totalPaid` on the account plus a `LiabilityLedgerEntry` with its own running balance (DEF-074).
 * Here all three are summed from `2500` by party, and `outstanding = charged − paid` is arithmetic
 * on that one balance.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { liabilities, type LiabilityCategory } from '../../schema/liabilities';
import { recordGone } from './record-gone';

export const LIABILITY_CONTROL_CODE = '2500';
export const CHARGE_SOURCE = 'liability_charge';
export const PAYMENT_SOURCE = 'liability_payment';
export const PARTY_TYPE = 'liability';

/**
 * ⛔ Accounts a liability may NOT be charged to, and why each is already owned elsewhere. Recording
 * one of these here would put the same debt in two accounts with nothing reconciling them.
 */
export const RESERVED_LIABILITY_CODES: Readonly<Record<string, string>> = {
  '2110': 'a supplier invoice — record it as an expense on credit (T-130)',
  '2130': 'a staff reimbursement — it comes from an expense payment',
  '2150': 'money owed to another store — that is an inter-store transfer',
  '2210': 'SSS — payroll accrues it and a statutory remittance settles it',
  '2220': 'PhilHealth — payroll accrues it and a statutory remittance settles it',
  '2230': 'Pag-IBIG — payroll accrues it and a statutory remittance settles it',
  '2240': 'withholding tax — payroll accrues it and a statutory remittance settles it',
  '2250': 'VAT — settled through the VAT return, not here',
  // DEF-162: corrected 2026-09-04 — payroll recognises and disburses pay in one entry (gross
  // expense straight to cash/advance-recovery, `payroll/index.ts`), with no separate accrual
  // leg. The old wording claimed an accrual step that does not exist. The charge is still
  // refused here regardless — 2300 is not a place to double-book pay through a second door.
  '2300': 'wages — payroll recognises and disburses pay in one entry, with nothing posted to 2300',
  '2400': 'borrowed money — that is a loan (T-126)',
};

export interface LiabilityRow {
  id: string;
  orgId: string;
  storeId: string;
  name: string;
  category: LiabilityCategory;
  description: string | null;
  dueOn: string | null;
  retiredAt: Date | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function insertLiability(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    name: string;
    category: LiabilityCategory;
    description: string | null;
    dueOn: string | null;
    notes: string | null;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(liabilities).values(input).returning({ id: liabilities.id });
  return row!;
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<LiabilityRow | undefined> {
  const [row] = await tx
    .select()
    .from(liabilities)
    .where(and(eq(liabilities.id, id), eq(liabilities.orgId, orgId)))
    .limit(1);
  return row as LiabilityRow | undefined;
}

export async function listLiabilities(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string; includeRetired?: boolean } = {},
): Promise<LiabilityRow[]> {
  const conditions = [eq(liabilities.orgId, orgId)];
  if (filter.storeId) conditions.push(eq(liabilities.storeId, filter.storeId));
  if (!filter.includeRetired) conditions.push(isNull(liabilities.retiredAt));
  const rows = await tx
    .select()
    .from(liabilities)
    .where(and(...conditions))
    // ⚠️ Undated LAST. A NULL due date is not "due first", it is "no date at all", and Postgres
    // sorts NULLs first on ASC by default — which would put every undated obligation above the
    // overdue ones, at the top of the screen that exists to show what is late.
    .orderBy(sql`${liabilities.dueOn} asc nulls last`, asc(liabilities.createdAt));
  return rows as LiabilityRow[];
}

export async function updateLiability(
  tx: Tx,
  orgId: string,
  id: string,
  values: Partial<{
    name: string;
    category: LiabilityCategory;
    description: string | null;
    dueOn: string | null;
    retiredAt: Date | null;
    notes: string | null;
  }>,
): Promise<void> {
  const updated = await tx
    .update(liabilities)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(liabilities.id, id), eq(liabilities.orgId, orgId)))
    .returning({ id: liabilities.id });
  if (updated.length === 0) {
    throw recordGone(`updateLiability: liability ${id} does not exist in org ${orgId}`, 'liability');
  }
}

// -------------------------------------------------------------------------------------
// ⭐ Derived — every figure, from the ledger
// -------------------------------------------------------------------------------------

export interface LiabilityPosition {
  charged: string;
  paid: string;
  /** ⭐ `charged − paid`. Zero means settled — no column says so. */
  outstanding: string;
}

const ZERO: LiabilityPosition = { charged: '0.00', paid: '0.00', outstanding: '0.00' };

/**
 * ⚠️ Reversed entries are INCLUDED: an entry and its reversal net to zero, so counting both is
 * correct and counting only one is not — the mistake T-126 made and its own tests caught.
 */
const POSITION_SELECT = sql`
  coalesce(sum(case when je.source_type = ${CHARGE_SOURCE}  then jl.credit - jl.debit else 0 end), 0)::text as charged,
  coalesce(sum(case when je.source_type = ${PAYMENT_SOURCE} then jl.debit  - jl.credit else 0 end), 0)::text as paid,
  coalesce(sum(jl.credit - jl.debit), 0)::text as outstanding
`;

function toPosition(r: Record<string, string> | undefined): LiabilityPosition {
  if (!r) return ZERO;
  return {
    charged: Number(r.charged ?? 0).toFixed(2),
    paid: Number(r.paid ?? 0).toFixed(2),
    outstanding: Number(r.outstanding ?? 0).toFixed(2),
  };
}

export async function positionOf(
  tx: Tx,
  orgId: string,
  liabilityId: string,
): Promise<LiabilityPosition> {
  const [row] = (await tx.execute(sql`
    select ${POSITION_SELECT}
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${liabilityId}
      and a.code = ${LIABILITY_CONTROL_CODE}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return toPosition(row);
}

/** Every obligation's position in one query — the register's N+1 guard. */
export async function positionsByLiability(
  tx: Tx,
  orgId: string,
): Promise<Map<string, LiabilityPosition>> {
  const rows = (await tx.execute(sql`
    select jl.party_id as liability_id, ${POSITION_SELECT}
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and a.code = ${LIABILITY_CONTROL_CODE}
      and je.status <> 'draft'
    group by jl.party_id
  `)) as unknown as Record<string, string>[];
  const map = new Map<string, LiabilityPosition>();
  for (const r of rows) map.set(String(r.liability_id ?? r.liabilityId), toPosition(r));
  return map;
}

/** Is this account code postable at all, and is it a liability? Used to validate a charge target. */
export async function accountKind(
  tx: Tx,
  orgId: string,
  code: string,
): Promise<{ type: string; isPostable: boolean } | undefined> {
  const [row] = (await tx.execute(sql`
    select type, is_postable from accounts where org_id = ${orgId} and code = ${code} limit 1
  `)) as unknown as Record<string, unknown>[];
  if (!row) return undefined;
  return { type: String(row.type), isPostable: Boolean(row.is_postable ?? row.isPostable) };
}

export interface LiabilityMovement {
  entryId: string;
  entryDate: string;
  sourceType: string;
  memo: string | null;
  charged: string;
  paid: string;
}

/**
 * Every movement on this obligation.
 *
 * ⚠️ **Reversals INCLUDED.** They and their originals both stay on the ledger, and a trail that
 * hid one would not add up to the balance printed beside it.
 */
export async function movementsFor(
  tx: Tx,
  orgId: string,
  liabilityId: string,
): Promise<LiabilityMovement[]> {
  const rows = (await tx.execute(sql`
    select je.id as entry_id, je.entry_date::text as entry_date, je.source_type, je.memo,
           coalesce(jl.credit, 0)::text as charged,
           coalesce(jl.debit, 0)::text as paid
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${liabilityId}
      and a.code = ${LIABILITY_CONTROL_CODE}
      and je.status <> 'draft'
    order by je.entry_date asc, je.created_at asc
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    entryId: String(r.entry_id ?? r.entryId),
    entryDate: String(r.entry_date ?? r.entryDate),
    sourceType: String(r.source_type ?? r.sourceType),
    memo: (r.memo as string | null) ?? null,
    charged: Number(r.charged ?? 0).toFixed(2),
    paid: Number(r.paid ?? 0).toFixed(2),
  }));
}

/**
 * Accounts a charge may land on — the positive form of the service's refusal list.
 *
 * ⚠️ Expense and asset only. A charge records what the obligation was FOR, and offering a
 * liability account in the picker would invite the posting the service then refuses.
 */
export async function chargeableAccounts(
  tx: Tx,
  orgId: string,
): Promise<{ code: string; name: string; type: string }[]> {
  const rows = (await tx.execute(sql`
    select code, name, type from accounts
    where org_id = ${orgId} and is_postable and status = 'active'
      and type in ('expense', 'asset')
    order by code
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ code: String(r.code), name: String(r.name), type: String(r.type) }));
}

