/**
 * The only place SQL is written for positions and employments. T-154.
 *
 * ⛔ **No `is_active` read exists here, and none should.** "Is this person on the roster" is
 * answered by `v_active_employments` — see `listRoster`. Bible §4.2 rule 7: derived data is a view,
 * not a hand-maintained column, and discovery 15 §8 records that v1 already knows this and keeps
 * the column anyway.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  CANONICAL_POSITIONS,
  employmentPositions,
  employments,
  positions,
  type EmploymentStatus,
} from '../../schema/employment';

export interface PositionRow {
  id: string;
  orgId: string;
  storeId: string | null;
  name: string;
  isCanonical: boolean;
  isActive: boolean;
}

export interface EmploymentRow {
  id: string;
  orgId: string;
  storeId: string;
  personId: string;
  staffCode: string;
  employmentStatus: EmploymentStatus;
  startedOn: string;
  endedOn: string | null;
}

export interface RosterRow {
  id: string;
  personId: string;
  staffCode: string;
  displayName: string;
  employmentStatus: EmploymentStatus;
  startedOn: string;
}

// -------------------------------------------------------------------------------------
// Positions
// -------------------------------------------------------------------------------------

/**
 * Seed the canonical six for an org. Idempotent — `on conflict do nothing` against the
 * expression index, the same shape `seedChartOfAccounts` uses, so a re-run changes nothing.
 */
export async function seedCanonical(tx: Tx, orgId: string): Promise<void> {
  for (const name of CANONICAL_POSITIONS) {
    await tx.execute(sql`
      insert into positions (org_id, store_id, name, is_canonical)
      values (${orgId}, null, ${name}, true)
      on conflict do nothing`);
  }
}

export async function listPositions(tx: Tx, orgId: string, storeId: string): Promise<PositionRow[]> {
  const rows = await tx
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.orgId, orgId),
        sql`(${positions.storeId} is null or ${positions.storeId} = ${storeId})`,
        eq(positions.isActive, true),
      ),
    )
    .orderBy(asc(positions.isCanonical), asc(positions.name));
  return rows as PositionRow[];
}

export async function findPositionByName(
  tx: Tx,
  orgId: string,
  storeId: string | null,
  name: string,
): Promise<PositionRow | undefined> {
  const [row] = await tx
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.orgId, orgId),
        storeId === null ? isNull(positions.storeId) : eq(positions.storeId, storeId),
        sql`lower(trim(${positions.name})) = lower(trim(${name}))`,
      ),
    )
    .limit(1);
  return row as PositionRow | undefined;
}

export async function insertStorePosition(
  tx: Tx,
  input: { orgId: string; storeId: string; name: string; createdBy: string },
): Promise<PositionRow> {
  const [row] = await tx
    .insert(positions)
    .values({ ...input, name: input.name.trim(), isCanonical: false })
    .returning();
  return row as PositionRow;
}

export async function getPositionsByIds(tx: Tx, orgId: string, ids: string[]): Promise<PositionRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(positions)
    .where(and(eq(positions.orgId, orgId), inArray(positions.id, ids)));
  return rows as PositionRow[];
}

// -------------------------------------------------------------------------------------
// Employments
// -------------------------------------------------------------------------------------

/**
 * ⭐ Allocate the next `SE-NNN` for a store, holding a lock for the rest of the transaction.
 *
 * `for update` on the store's existing rows rather than a sequence: a sequence is global and gappy,
 * and this number is printed on a badge and a payslip. Two concurrent hires therefore serialise
 * here instead of racing to the same code — asserted by a genuinely concurrent test.
 *
 * ⚠️ The lock is on the STORE row, not on `employments` — a store's first hire has no employment
 * rows to lock, and `for update` over an empty set locks nothing at all.
 */
export async function allocateStaffCode(tx: Tx, storeId: string): Promise<string> {
  await tx.execute(sql`select 1 from stores where id = ${storeId} for update`);
  const result = await tx.execute<{ next: number }>(sql`
    select coalesce(max(nullif(regexp_replace(staff_code, '\\D', '', 'g'), '')::int), 0) + 1 as next
    from employments where store_id = ${storeId}`);
  const next = Number((result as unknown as { next: number }[])[0]?.next ?? 1);
  return `SE-${String(next).padStart(3, '0')}`;
}

export async function findOpenEmployment(
  tx: Tx,
  personId: string,
  storeId: string,
): Promise<EmploymentRow | undefined> {
  const [row] = await tx
    .select()
    .from(employments)
    .where(
      and(eq(employments.personId, personId), eq(employments.storeId, storeId), isNull(employments.endedOn)),
    )
    .limit(1);
  return row as EmploymentRow | undefined;
}

export async function getEmployment(tx: Tx, id: string): Promise<EmploymentRow | undefined> {
  const [row] = await tx.select().from(employments).where(eq(employments.id, id)).limit(1);
  return row as EmploymentRow | undefined;
}

export async function insertEmployment(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    personId: string;
    staffCode: string;
    employmentStatus: EmploymentStatus;
    startedOn: string;
    notes?: string | null;
    createdBy: string;
  },
): Promise<EmploymentRow> {
  const [row] = await tx.insert(employments).values(input).returning();
  return row as EmploymentRow;
}

export async function closeEmployment(
  tx: Tx,
  input: { employmentId: string; endedOn: string; employmentStatus: EmploymentStatus },
): Promise<EmploymentRow> {
  const [row] = await tx
    .update(employments)
    .set({
      endedOn: input.endedOn,
      employmentStatus: input.employmentStatus,
      updatedAt: new Date(),
    })
    .where(eq(employments.id, input.employmentId))
    .returning();
  return row as EmploymentRow;
}

// -------------------------------------------------------------------------------------
// Position assignments
// -------------------------------------------------------------------------------------

/**
 * Replace an employment's position set wholesale.
 *
 * ⚠️ Deletes first, then inserts, inside the caller's transaction. The partial unique index on
 * `is_primary` means an incremental update would transiently hold two primaries and fail; a full
 * replace never does.
 */
export async function replaceEmploymentPositions(
  tx: Tx,
  input: { employmentId: string; positionIds: string[]; primaryPositionId: string },
): Promise<void> {
  await tx.delete(employmentPositions).where(eq(employmentPositions.employmentId, input.employmentId));
  for (const positionId of input.positionIds) {
    await tx.insert(employmentPositions).values({
      employmentId: input.employmentId,
      positionId,
      isPrimary: positionId === input.primaryPositionId,
    });
  }
}

/** The roster — reads the VIEW, which is the only answer to "who is active". */
export async function listActiveRoster(tx: Tx, storeId: string): Promise<RosterRow[]> {
  const result = await tx.execute(sql`
    select id, person_id, staff_code, display_name, employment_status, started_on
    from v_active_employments
    where store_id = ${storeId}
    order by display_name`);
  return (result as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    personId: String(r.person_id),
    staffCode: String(r.staff_code),
    displayName: String(r.display_name),
    employmentStatus: r.employment_status as EmploymentStatus,
    startedOn: String(r.started_on),
  }));
}
