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
 * Seed the canonical six for an org. Idempotent — T-335 §4: the `on conflict` names the exact
 * `0080` expression index (`org_id`, `coalesce(store_id, nil-uuid)`, `lower(trim(name))`) rather
 * than relying on Postgres's implicit "any unique violation" default, so a future second unique
 * constraint on `positions` raises loudly instead of being silently swallowed here (which would
 * make `inserted` under-report). Returns the count actually INSERTED — via `returning`, not the
 * number attempted — so a caller can tell "already seeded" (0) from "just seeded" (6).
 */
export async function seedCanonical(tx: Tx, orgId: string): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const name of CANONICAL_POSITIONS) {
    const result = await tx.execute(sql`
      insert into positions (org_id, store_id, name, is_canonical)
      values (${orgId}, null, ${name}, true)
      on conflict (org_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(name)))
      do nothing
      returning id`);
    inserted += (result as unknown as { id: string }[]).length;
  }
  return { inserted };
}

export interface CanonicalNameCollision {
  storeCode: string;
  positionId: string;
  name: string;
}

/**
 * T-335 §5 — store-scoped rows whose name collides with a canonical one (case/space-insensitive),
 * for the backfill's report. Read-only: names collisions, never resolves them (Ian's call, §5/§8).
 */
export async function canonicalNameCollisions(tx: Tx, orgId: string): Promise<CanonicalNameCollision[]> {
  const canonicalLower = sql.join(
    CANONICAL_POSITIONS.map((name) => sql`lower(trim(${name}))`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    select s.code as store_code, p.id as position_id, p.name
    from positions p
    join stores s on s.id = p.store_id
    where p.org_id = ${orgId}
      and p.store_id is not null
      and lower(trim(p.name)) in (${canonicalLower})
    order by s.code, p.name`);
  return (result as unknown as Record<string, unknown>[]).map((r) => ({
    storeCode: String(r.store_code),
    positionId: String(r.position_id),
    name: String(r.name),
  }));
}

/**
 * T-335 §5 — how many org-wide canonical rows an org actually has, for the backfill's
 * `canonical now N/6` report line. Not in §4's original list; added alongside `seedCanonical`
 * because it is the same "only place SQL is written for positions" file (this file's own header).
 * ⚠️ **Nothing caps this at 6.** `positions_canonical_is_org_wide_check` only forces
 * `is_canonical = true` whenever `store_id is null` — it says nothing about the NAME — and the
 * `0080` unique index only prevents a duplicate within one `(org, group, name)` triple. A
 * hand-inserted org-wide row named anything else (`'Assistant Manager'`, a typo'd seventh) is
 * perfectly legal and this function will count it. A result above 6 is not an error this function
 * raises; it is a signal for whoever reads the report to look closer.
 */
export async function countCanonical(tx: Tx, orgId: string): Promise<number> {
  const result = await tx.execute(sql`
    select count(*)::int as n from positions where org_id = ${orgId} and is_canonical = true`);
  return Number((result as unknown as { n: number }[])[0]?.n ?? 0);
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

/** DEF-664 - bring a retired store position back. Store-scoped rows only (a canonical one is never retired). */
export async function reactivateStorePosition(tx: Tx, orgId: string, positionId: string): Promise<PositionRow | undefined> {
  const [row] = await tx
    .update(positions)
    .set({ isActive: true })
    .where(and(eq(positions.orgId, orgId), eq(positions.id, positionId), sql`${positions.storeId} is not null`))
    .returning();
  return row as PositionRow | undefined;
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

/**
 * T-391 S5 (S9). Is this staff code already used at this store? Case-insensitive, the comparison the
 * `unique (store_id, lower(staff_code))` index makes. It takes the same store-row lock as `allocateStaffCode`, so a
 * concurrent hire cannot take the code between this check and the insert. The index stays the backstop.
 */
export async function findEmploymentByStaffCode(tx: Tx, storeId: string, staffCode: string): Promise<EmploymentRow | undefined> {
  await tx.execute(sql`select 1 from stores where id = ${storeId} for update`);
  const [row] = await tx
    .select()
    .from(employments)
    .where(and(eq(employments.storeId, storeId), sql`lower(${employments.staffCode}) = lower(${staffCode})`))
    .limit(1);
  return row as EmploymentRow | undefined;
}

/** T-391 S5. Every staff code an org holds, with its store's code, so the load's planner can see which are taken. */
export async function listStaffCodes(tx: Tx, orgId: string): Promise<Array<{ storeCode: string; staffCode: string }>> {
  const result = await tx.execute(sql`
    select s.code as store_code, e.staff_code
    from employments e join stores s on s.id = e.store_id
    where e.org_id = ${orgId}`);
  return (result as unknown as Array<{ store_code: string; staff_code: string }>).map((r) => ({
    storeCode: String(r.store_code),
    staffCode: String(r.staff_code),
  }));
}

/** T-391 S5. Positions of an org with their store's code (null = canonical, org-wide), for the load's planner. */
export async function listOrgPositions(tx: Tx, orgId: string): Promise<Array<{ id: string; name: string; storeCode: string | null }>> {
  const result = await tx.execute(sql`
    select p.id, p.name, s.code as store_code
    from positions p left join stores s on s.id = p.store_id
    where p.org_id = ${orgId} and p.is_active = true`);
  return (result as unknown as Array<{ id: string; name: string; store_code: string | null }>).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    storeCode: r.store_code === null ? null : String(r.store_code),
  }));
}

/** T-391 S5. The org's people (terminals excluded) by display name, so the load's planner can spot a same-name person. */
export async function listOrgPersons(tx: Tx, orgId: string): Promise<Array<{ id: string; displayName: string }>> {
  const result = await tx.execute(sql`
    select id, display_name from persons where org_id = ${orgId} and kind = 'person'`);
  return (result as unknown as Array<{ id: string; display_name: string }>).map((r) => ({ id: String(r.id), displayName: String(r.display_name) }));
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

/**
 * T-407 (Invariant 21): lock ALL of a person's employment rows in one org, in id order, in ONE statement.
 * Two concurrent endEmployment calls for the same person then serialise here instead of each updating its
 * own row and then taking `for share` on the other's (a 40P01 deadlock).
 */
export async function lockPersonEmployments(tx: Tx, personId: string, orgId: string): Promise<void> {
  await tx.execute(sql`
    select id from employments where person_id = ${personId} and org_id = ${orgId} order by id for update`);
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

// -------------------------------------------------------------------------------------
// Position assignments, READ side. T-202 — `RosterRow`/`listActiveRoster` above carry no
// position information at all, and the staff-onboarding Contract's roster columns ("positions,
// primary marked") and employment-detail pre-fill both need it. Two small additive reads; no
// schema or migration change.
// -------------------------------------------------------------------------------------

export interface EmploymentPositionRow {
  employmentId: string;
  positionId: string;
  positionName: string;
  isPrimary: boolean;
}

/** Every position currently assigned to ONE employment — the detail page's pre-fill for the
 *  `setEmploymentPositions` form. */
export async function listEmploymentPositions(tx: Tx, employmentId: string): Promise<EmploymentPositionRow[]> {
  const rows = await tx
    .select({
      employmentId: employmentPositions.employmentId,
      positionId: employmentPositions.positionId,
      positionName: positions.name,
      isPrimary: employmentPositions.isPrimary,
    })
    .from(employmentPositions)
    .innerJoin(positions, eq(positions.id, employmentPositions.positionId))
    .where(eq(employmentPositions.employmentId, employmentId))
    .orderBy(asc(positions.name));
  return rows as EmploymentPositionRow[];
}

/** Same shape, batched for a whole roster — one query rather than N+1 per row. */
export async function listEmploymentPositionsFor(tx: Tx, employmentIds: string[]): Promise<EmploymentPositionRow[]> {
  if (employmentIds.length === 0) return [];
  const rows = await tx
    .select({
      employmentId: employmentPositions.employmentId,
      positionId: employmentPositions.positionId,
      positionName: positions.name,
      isPrimary: employmentPositions.isPrimary,
    })
    .from(employmentPositions)
    .innerJoin(positions, eq(positions.id, employmentPositions.positionId))
    .where(inArray(employmentPositions.employmentId, employmentIds))
    .orderBy(asc(positions.name));
  return rows as EmploymentPositionRow[];
}

/**
 * ⭐ T-302 — the OTHER branches this person still works at, excluding the one being looked at.
 *
 * **Why a screen needs this at all:** a PIN is now one credential for the whole organisation, so
 * issuing one on an employment page changes that person's PIN at every branch they work at. The
 * page has to be able to say *which* branches before the button is pressed — "this also affects
 * somewhere" is not something a user can act on; "this also affects Davao" is.
 *
 * ⚠️ Open employments only (`ended_on is null`), and names rather than ids, because the only
 * consumer is a sentence read by a human.
 */
export async function listOtherOpenBranches(
  tx: Tx,
  personId: string,
  excludeStoreId: string,
): Promise<{ storeId: string; storeName: string }[]> {
  const result = await tx.execute(sql`
    select e.store_id, s.name as store_name
    from employments e
    join stores s on s.id = e.store_id
    where e.person_id = ${personId}
      and e.store_id <> ${excludeStoreId}
      and e.ended_on is null
    order by s.name`);
  return (result as unknown as Record<string, unknown>[]).map((r) => ({
    storeId: String(r.store_id),
    storeName: String(r.store_name),
  }));
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

/**
 * T-387 S7 - `employments.photo_file_id` for a batch, for the staff ID-card wall.
 * Read-only, under the caller's RLS. An employment the caller can see with no photo maps to null; one it cannot
 * see (another org) is ABSENT from the map, never an error and never a leaked file id.
 */
export async function photoFileIds(tx: Tx, employmentIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (employmentIds.length === 0) return out;
  const rows = await tx
    .select({ id: employments.id, photoFileId: employments.photoFileId })
    .from(employments)
    .where(inArray(employments.id, employmentIds));
  for (const r of rows) out.set(r.id, r.photoFileId ?? null);
  return out;
}
