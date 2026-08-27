/**
 * The only place SQL is written for owners. T-127.
 *
 * ## ⭐ `positionOf` is the point of this file
 *
 * v1 stores `totalCapital`, `totalDrawings` and `netEquity` on the owner document, the last of them
 * commented `// totalCapital - totalDrawings` — a stored copy of a subtraction (DEF-072). Here all
 * three are summed from the ledger by party, so `net = contributed − drawn` is arithmetic on one
 * set of numbers rather than a second definition of them.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { owners, type OwnerStatus, type PersonalExpenseTreatment } from '../../schema/owners';
import { owner_drawing_closes } from '../../schema/owner-drawing-closes';

export const CAPITAL_CODE = '3100';
export const DRAWINGS_CODE = '3200';
export const DUE_FROM_OWNER_CODE = '1260';
export const PARTY_TYPE = 'owner';

export interface OwnerRow {
  id: string;
  orgId: string;
  storeId: string;
  personId: string;
  role: string | null;
  ownershipPercentage: string | null;
  drawingLimit: string | null;
  drawingLimitPeriod: 'monthly' | 'total' | null;
  personalExpenseTreatment: PersonalExpenseTreatment;
  status: OwnerStatus;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
}

export async function insertOwner(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    personId: string;
    role: string | null;
    ownershipPercentage: string | null;
    drawingLimit: string | null;
    drawingLimitPeriod: 'monthly' | 'total' | null;
    personalExpenseTreatment: PersonalExpenseTreatment;
    notes: string | null;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(owners).values(input).returning({ id: owners.id });
  return row!;
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<OwnerRow | undefined> {
  const [row] = await tx
    .select()
    .from(owners)
    .where(and(eq(owners.id, id), eq(owners.orgId, orgId)))
    .limit(1);
  return row as OwnerRow | undefined;
}

export async function listOwners(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string } = {},
): Promise<OwnerRow[]> {
  const conditions = [eq(owners.orgId, orgId)];
  if (filter.storeId) conditions.push(eq(owners.storeId, filter.storeId));
  const rows = await tx
    .select()
    .from(owners)
    .where(and(...conditions))
    .orderBy(asc(owners.createdAt));
  return rows as OwnerRow[];
}

export async function updateOwner(
  tx: Tx,
  orgId: string,
  id: string,
  values: Partial<{
    role: string | null;
    ownershipPercentage: string | null;
    drawingLimit: string | null;
    drawingLimitPeriod: 'monthly' | 'total' | null;
    personalExpenseTreatment: PersonalExpenseTreatment;
    status: OwnerStatus;
    notes: string | null;
  }>,
): Promise<void> {
  const updated = await tx
    .update(owners)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(owners.id, id), eq(owners.orgId, orgId)))
    .returning({ id: owners.id });
  if (updated.length === 0) throw new Error(`updateOwner: owner ${id} does not exist in org ${orgId}`);
}

// -------------------------------------------------------------------------------------
// ⭐ Derived — every figure, from the ledger
// -------------------------------------------------------------------------------------

export interface OwnerPosition {
  contributed: string;
  drawn: string;
  /** ⭐ `contributed − drawn`. Arithmetic on the two above, never a stored third number. */
  net: string;
  /** ⚠️ Personal expenses the business still expects back — 1260, NOT part of `net`. */
  receivable: string;
}

const ZERO: OwnerPosition = {
  contributed: '0.00',
  drawn: '0.00',
  net: '0.00',
  receivable: '0.00',
};

/**
 * ⚠️ Reversed entries are INCLUDED: an entry and its reversal net to zero, so counting both is
 * correct and counting only one is not. Excluding the original while keeping its mirror is the
 * mistake T-126 made and its own tests caught.
 */
const POSITION_SELECT = sql`
  coalesce(sum(case when a.code = ${CAPITAL_CODE}  then jl.credit - jl.debit else 0 end), 0)::text as contributed,
  coalesce(sum(case when a.code = ${DRAWINGS_CODE} then jl.debit  - jl.credit else 0 end), 0)::text as drawn,
  coalesce(sum(case when a.code = ${DUE_FROM_OWNER_CODE} then jl.debit - jl.credit else 0 end), 0)::text as receivable
`;

function toPosition(r: Record<string, string> | undefined): OwnerPosition {
  if (!r) return ZERO;
  const contributed = Number(r.contributed ?? 0);
  const drawn = Number(r.drawn ?? 0);
  return {
    contributed: contributed.toFixed(2),
    drawn: drawn.toFixed(2),
    net: (contributed - drawn).toFixed(2),
    receivable: Number(r.receivable ?? 0).toFixed(2),
  };
}

export async function positionOf(tx: Tx, orgId: string, ownerId: string): Promise<OwnerPosition> {
  const [row] = (await tx.execute(sql`
    select ${POSITION_SELECT}
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${ownerId}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return toPosition(row);
}

/** Every owner's position in one query — the register's N+1 guard. */
export async function positionsByOwner(
  tx: Tx,
  orgId: string,
): Promise<Map<string, OwnerPosition>> {
  const rows = (await tx.execute(sql`
    select jl.party_id as owner_id, ${POSITION_SELECT}
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and je.status <> 'draft'
    group by jl.party_id
  `)) as unknown as Record<string, string>[];
  const map = new Map<string, OwnerPosition>();
  for (const r of rows) map.set(String(r.owner_id ?? r.ownerId), toPosition(r));
  return map;
}

/**
 * ⭐ **What counts against a drawing limit**, and it is deliberately MORE than `3200`.
 *
 * ⛔ A limit that only sees drawings is bypassed by marking every personal expense "repayable":
 * the money leaves, `1260` grows, and the cap never moves. That is the same hole as a revolving
 * fund whose top-up is not gated by receipts — the control has to see every way cash reaches the
 * owner, not just the one with the honest name.
 *
 * ⚠️ `1260` is counted at its OUTSTANDING balance, so a receivable the owner has actually repaid
 * stops consuming their limit. Repaying is what makes room again, which is the behaviour you want.
 *
 * `until` is exclusive; omit `since` for the `total` period.
 */
export async function drawnInWindow(
  tx: Tx,
  orgId: string,
  ownerId: string,
  window: { since?: string; until?: string } = {},
): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(
      case when a.code in (${DRAWINGS_CODE}, ${DUE_FROM_OWNER_CODE})
           then jl.debit - jl.credit else 0 end
    ), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${ownerId}
      and je.status <> 'draft'
      ${window.since ? sql`and je.entry_date >= ${window.since}` : sql``}
      ${window.until ? sql`and je.entry_date < ${window.until}` : sql``}
  `)) as unknown as Record<string, string>[];
  return Number(row?.total ?? 0).toFixed(2);
}

// -------------------------------------------------------------------------------------
// The monthly close
// -------------------------------------------------------------------------------------

export interface DrawingCloseRow {
  id: string;
  orgId: string;
  storeId: string;
  ownerId: string;
  periodMonth: string;
  acknowledgedAmount: string;
  adjustmentAmount: string | null;
  adjustmentReason: string | null;
  adjustmentEntryId: string | null;
  closedOn: string;
  closedBy: string;
  notes: string | null;
}

export async function insertClose(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    ownerId: string;
    periodMonth: string;
    acknowledgedAmount: string;
    adjustmentAmount: string | null;
    adjustmentReason: string | null;
    adjustmentEntryId: string | null;
    closedOn: string;
    closedBy: string;
    notes: string | null;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(owner_drawing_closes)
    .values(input)
    .returning({ id: owner_drawing_closes.id });
  return row!;
}

/** ⭐ The lock. A drawing dated into a closed month is refused — see `closeFor`'s callers. */
export async function closeFor(
  tx: Tx,
  orgId: string,
  ownerId: string,
  periodMonth: string,
): Promise<DrawingCloseRow | undefined> {
  const [row] = await tx
    .select()
    .from(owner_drawing_closes)
    .where(
      and(
        eq(owner_drawing_closes.orgId, orgId),
        eq(owner_drawing_closes.ownerId, ownerId),
        eq(owner_drawing_closes.periodMonth, periodMonth),
      ),
    )
    .limit(1);
  return row as DrawingCloseRow | undefined;
}

export async function listCloses(
  tx: Tx,
  orgId: string,
  filter: { ownerId?: string } = {},
): Promise<DrawingCloseRow[]> {
  const conditions = [eq(owner_drawing_closes.orgId, orgId)];
  if (filter.ownerId) conditions.push(eq(owner_drawing_closes.ownerId, filter.ownerId));
  const rows = await tx
    .select()
    .from(owner_drawing_closes)
    .where(and(...conditions))
    .orderBy(desc(owner_drawing_closes.periodMonth));
  return rows as DrawingCloseRow[];
}
