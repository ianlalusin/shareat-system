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
/** Where a receivable goes when it is being recovered from pay — party_type `employee`. */
export const EMPLOYEE_ADVANCE_CODE = '1230';
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
 * ⚠️ Counted at OUTSTANDING balance, so a receivable the owner has actually repaid stops consuming
 * their limit — repaying is what makes room again. ⛔ But a RECLASSIFICATION is not a repayment:
 * "recover from pay" moves the balance to `1230` and nothing has come back yet, so that account is
 * counted too. The limit tracks money that reached the owner and has not returned, whichever
 * receivable is currently holding it.
 *
 * `until` is exclusive; omit `since` for the `total` period.
 */
export async function drawnInWindow(
  tx: Tx,
  orgId: string,
  owner: { id: string; personId: string },
  window: { since?: string; until?: string } = {},
): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and je.status <> 'draft'
      and (
        (jl.party_type = ${PARTY_TYPE} and jl.party_id = ${owner.id}
         and a.code in (${DRAWINGS_CODE}, ${DUE_FROM_OWNER_CODE}))
        -- ⭐ ...AND the same money after a recovery reclassified it. Otherwise "recover from pay"
        -- would free the cap the instant it was clicked, long before payroll actually nets it — the
        -- same bypass as marking everything repayable, one step further along.
        --
        -- SCOPED TO THIS OWNER'S OWN RECOVERIES (je.source_id = owner.id), and the scope is the
        -- whole point. 1230 also holds ordinary staff advances — a float shortage, a salary advance
        -- — and counting those would charge an operational debt against an OWNERSHIP cap. A browser
        -- check caught exactly that: a ₱600 cash-request shortage, belonging to the same human in a
        -- completely different role, silently consuming their drawing limit.
        --
        -- When payroll lands, the entry that nets one of these off must carry the same
        -- source_id, or the recovered amount will keep consuming the cap forever.
        or (jl.party_type = 'employee' and jl.party_id = ${owner.personId}
            and a.code = ${EMPLOYEE_ADVANCE_CODE}
            and je.source_id = ${owner.id})
      )
      ${window.since ? sql`and je.entry_date >= ${window.since}` : sql``}
      ${window.until ? sql`and je.entry_date < ${window.until}` : sql``}
  `)) as unknown as Record<string, string>[];
  return Number(row?.total ?? 0).toFixed(2);
}

/** What the owner still owes on `1260` — the ceiling on any settlement. */
export async function receivableOf(tx: Tx, orgId: string, ownerId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${ownerId}
      and a.code = ${DUE_FROM_OWNER_CODE}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return Number(row?.total ?? 0).toFixed(2);
}

export interface AgedReceivable {
  ownerId: string;
  outstanding: string;
  /** The date of the OLDEST unsettled charge — what the age is measured from. */
  oldestOn: string;
  daysOutstanding: number;
}

/**
 * ⭐ **Owner receivables, with their age.** An aged `1260` balance is a FINDING, not a balance.
 *
 * ⚠️ A personal expense the business is owed becomes a constructive dividend if it is never really
 * collected — that is the line the tax treatment turns on — so a balance quietly sitting for months
 * is the thing somebody has to see. It surfaces the way remittance surfaces open variances: on the
 * register, first, without anyone remembering to ask.
 *
 * ⚠️ Age is measured from the OLDEST charge still outstanding, FIFO-style, not from the newest and
 * not from an average — the oldest is the one that has been sitting longest and is the one an
 * examiner would ask about.
 */
export async function agedReceivables(tx: Tx, orgId: string): Promise<AgedReceivable[]> {
  const rows = (await tx.execute(sql`
    select
      jl.party_id as owner_id,
      coalesce(sum(jl.debit - jl.credit), 0)::text as outstanding,
      min(case when jl.debit > 0 then je.entry_date end)::text as oldest_on,
      (current_date - min(case when jl.debit > 0 then je.entry_date end))::int as days_outstanding
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and a.code = ${DUE_FROM_OWNER_CODE}
      and je.status <> 'draft'
    group by jl.party_id
    having coalesce(sum(jl.debit - jl.credit), 0) > 0
    order by min(case when jl.debit > 0 then je.entry_date end) asc
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    ownerId: String(r.owner_id ?? r.ownerId),
    outstanding: Number(r.outstanding ?? 0).toFixed(2),
    oldestOn: String(r.oldest_on ?? r.oldestOn ?? ''),
    daysOutstanding: Number(r.days_outstanding ?? r.daysOutstanding ?? 0),
  }));
}

/**
 * Does this person hold an active role in the org?
 *
 * ⚠️ **The best proxy available for "is on the payroll", and not the same thing.** v2 has no payroll
 * module, so nothing can prove somebody is PAID. This proves they work here, which is enough to rule
 * out the failure that matters: parking a receivable against the wages of someone who has none.
 * ⛔ Replace this with a real payroll lookup when payroll lands.
 */
export async function personHoldsActiveRole(
  tx: Tx,
  orgId: string,
  personId: string,
): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select 1 as ok from person_roles
    where person_id = ${personId} and org_id = ${orgId} and revoked_at is null
    limit 1
  `)) as unknown as Record<string, unknown>[];
  return Boolean(row);
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
