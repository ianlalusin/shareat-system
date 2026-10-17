/**
 * The only place SQL is written for leave and absence tracking. T-436, migration 0205.
 * `docs/tasks/436-leave-tracking.md`.
 *
 * ⭐ Every read is keyed on the PERSON, never the employment: service, caps, the SIL balance and "one leave day per
 * date" are the person's. The employment on a row says only WHICH job (store, pay rate) a request was filed under.
 *
 * ⛔ `leave_requests.note` is personal data (bible row 353). It is read in exactly ONE place, `getRequestNote`; every
 * list, grid and count below selects the kind only, and nothing here returns a stored file's id (`hasProof` is a boolean).
 *
 * ⛔ Numeric columns (`leave_commutations.days / daily_rate / amount`) are written through the Drizzle builder with
 * branded `Decimal` values only (T-371 numeric-write guard); no raw SQL writes a numeric column in this file.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import type { Decimal, Money } from '@shareat/core/money';
import {
  leaveCaps,
  leaveCommutations,
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
  type LeaveDayKind,
  type LeaveDayStatus,
  type LeaveOrigin,
  type LeaveRequestStatus,
} from '../../schema/leave';

// ---------------------------------------------------------------------------------------------
// Small helpers

const rowsOf = <T>(r: unknown): T[] => r as T[];

/** A parenthesised, comma-joined list of bound uuid/text params; an empty list is `(null)` so `in (...)` is simply false. */
function list(values: readonly string[]) {
  if (values.length === 0) return sql`(null)`;
  return sql`(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
}

// ---------------------------------------------------------------------------------------------
// Kinds

export interface LeaveTypeRow {
  id: string;
  orgId: string | null;
  code: string;
  label: string;
  paid: boolean;
  drawsSil: boolean;
  statutory: boolean;
  needsProof: boolean;
  requestable: boolean;
  active: boolean;
  legalYearlyDays: number | null;
  legalPerBirthDays: number | null;
  legalMaxBirths: number | null;
  sortOrder: number;
}

const TYPE_COLS = sql`id::text as "id", org_id::text as "orgId", code, label, paid, draws_sil as "drawsSil", statutory,
  needs_proof as "needsProof", requestable, active, legal_yearly_days as "legalYearlyDays",
  legal_per_birth_days as "legalPerBirthDays", legal_max_births as "legalMaxBirths", sort_order as "sortOrder"`;

/** The org's own row for a code if it has one, else the platform seed. */
export async function resolveType(tx: Tx, orgId: string, code: string): Promise<LeaveTypeRow | undefined> {
  const rows = rowsOf<LeaveTypeRow>(
    await tx.execute(sql`
      select ${TYPE_COLS} from leave_types
      where code = ${code} and (org_id = ${orgId} or org_id is null)
      order by (org_id is null) asc limit 1`),
  );
  return rows[0];
}

export async function listTypes(tx: Tx, orgId: string): Promise<LeaveTypeRow[]> {
  return rowsOf<LeaveTypeRow>(
    await tx.execute(sql`
      select ${TYPE_COLS} from leave_types
      where org_id = ${orgId} or org_id is null
      order by sort_order, code`),
  );
}

export async function insertOrgType(
  tx: Tx,
  input: { orgId: string; code: string; label: string; paid: boolean; needsProof: boolean },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(leaveTypes)
    .values({
      orgId: input.orgId,
      code: input.code,
      label: input.label,
      paid: input.paid,
      needsProof: input.needsProof,
      sortOrder: 200,
    })
    .returning({ id: leaveTypes.id });
  return row!;
}

/** Only an ORG-owned kind can be retired or restored (the platform seed is not the org's to switch off). */
export async function setOrgTypeActive(tx: Tx, orgId: string, id: string, active: boolean): Promise<boolean> {
  const rows = await tx
    .update(leaveTypes)
    .set({ active })
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.orgId, orgId)))
    .returning({ id: leaveTypes.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Caps

export interface CapRow {
  id: string;
  storeId: string | null;
  positionId: string | null;
  monthlyCap: number | null;
  yearlyCap: number | null;
}

export async function positionIdsOfEmployment(tx: Tx, employmentId: string): Promise<string[]> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`select position_id::text as "id" from employment_positions where employment_id = ${employmentId}`),
  );
  return rows.map((r) => r.id);
}

/** Every cap row that COULD apply to a job at this store holding these positions; the domain picks the most specific. */
export async function candidateCaps(
  tx: Tx,
  input: { orgId: string; leaveType: string; storeId: string; positionIds: readonly string[] },
): Promise<CapRow[]> {
  return rowsOf<CapRow>(
    await tx.execute(sql`
      select id::text as "id", store_id::text as "storeId", position_id::text as "positionId",
             monthly_cap as "monthlyCap", yearly_cap as "yearlyCap"
      from leave_caps
      where org_id = ${input.orgId} and leave_type = ${input.leaveType}
        and (store_id is null or store_id = ${input.storeId})
        and (position_id is null or position_id in ${list(input.positionIds)})`),
  );
}

export interface CapListRow extends CapRow {
  leaveType: string;
}

export async function listCaps(tx: Tx, orgId: string): Promise<CapListRow[]> {
  return rowsOf<CapListRow>(
    await tx.execute(sql`
      select id::text as "id", leave_type as "leaveType", store_id::text as "storeId", position_id::text as "positionId",
             monthly_cap as "monthlyCap", yearly_cap as "yearlyCap"
      from leave_caps where org_id = ${orgId} order by leave_type, store_id nulls first, position_id nulls first`),
  );
}

/** Insert or replace the one cap row for (kind, store?, position?). Returns what it replaced, for the audit row. */
export async function upsertCap(
  tx: Tx,
  input: {
    orgId: string;
    leaveType: string;
    storeId: string | null;
    positionId: string | null;
    monthlyCap: number | null;
    yearlyCap: number | null;
    actorPersonId: string;
  },
): Promise<{ id: string; before: { monthlyCap: number | null; yearlyCap: number | null } | null }> {
  const existing = rowsOf<{ id: string; monthlyCap: number | null; yearlyCap: number | null }>(
    await tx.execute(sql`
      select id::text as "id", monthly_cap as "monthlyCap", yearly_cap as "yearlyCap" from leave_caps
      where org_id = ${input.orgId} and leave_type = ${input.leaveType}
        and store_id is not distinct from ${input.storeId}::uuid and position_id is not distinct from ${input.positionId}::uuid
      for update`),
  )[0];
  if (existing) {
    await tx
      .update(leaveCaps)
      .set({ monthlyCap: input.monthlyCap, yearlyCap: input.yearlyCap, updatedBy: input.actorPersonId, updatedAt: new Date() })
      .where(eq(leaveCaps.id, existing.id));
    return { id: existing.id, before: { monthlyCap: existing.monthlyCap, yearlyCap: existing.yearlyCap } };
  }
  const [row] = await tx
    .insert(leaveCaps)
    .values({
      orgId: input.orgId,
      leaveType: input.leaveType,
      storeId: input.storeId,
      positionId: input.positionId,
      monthlyCap: input.monthlyCap,
      yearlyCap: input.yearlyCap,
      createdBy: input.actorPersonId,
    })
    .returning({ id: leaveCaps.id });
  return { id: row!.id, before: null };
}

// ---------------------------------------------------------------------------------------------
// Requests and days

export interface RequestRow {
  id: string;
  orgId: string;
  personId: string;
  employmentId: string;
  storeId: string;
  leaveType: string;
  status: LeaveRequestStatus;
  origin: LeaveOrigin;
  paid: boolean | null;
  birthDate: string | null;
  requestedBy: string;
  decidedBy: string | null;
}

const REQUEST_COLS = sql`id::text as "id", org_id::text as "orgId", person_id::text as "personId", employment_id::text as "employmentId",
  store_id::text as "storeId", leave_type as "leaveType", status, origin, paid, birth_date::text as "birthDate",
  requested_by::text as "requestedBy", decided_by::text as "decidedBy"`;

/** The request WITHOUT its note. */
export async function getRequest(tx: Tx, orgId: string, id: string): Promise<RequestRow | undefined> {
  return rowsOf<RequestRow>(
    await tx.execute(sql`select ${REQUEST_COLS} from leave_requests where id = ${id} and org_id = ${orgId}`),
  )[0];
}

/** ⛔ The ONE read of the personal note. Callers decide, before calling, that the viewer may see it. */
export async function getRequestNote(tx: Tx, orgId: string, id: string): Promise<string | null> {
  const r = rowsOf<{ note: string | null }>(
    await tx.execute(sql`select note from leave_requests where id = ${id} and org_id = ${orgId}`),
  )[0];
  return r?.note ?? null;
}

export async function insertRequest(
  tx: Tx,
  input: {
    orgId: string;
    personId: string;
    employmentId: string;
    storeId: string;
    leaveType: string;
    status: 'pending' | 'approved';
    origin: LeaveOrigin;
    paid: boolean | null;
    birthDate: string | null;
    note: string | null;
    requestedBy: string;
    decidedBy: string | null;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(leaveRequests)
    .values({
      orgId: input.orgId,
      personId: input.personId,
      employmentId: input.employmentId,
      storeId: input.storeId,
      leaveType: input.leaveType,
      status: input.status,
      origin: input.origin,
      paid: input.paid,
      birthDate: input.birthDate,
      note: input.note,
      requestedBy: input.requestedBy,
      decidedBy: input.decidedBy,
      decidedAt: input.decidedBy ? new Date() : null,
    })
    .returning({ id: leaveRequests.id });
  return row!;
}

export interface DayInsert {
  orgId: string;
  requestId: string;
  personId: string;
  employmentId: string;
  storeId: string;
  leaveType: string;
  leaveDate: string;
  kind: LeaveDayKind;
  status: LeaveDayStatus;
  paid: boolean;
}

export async function insertDays(tx: Tx, rows: DayInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(leaveRequestDays).values(rows);
}

export interface DayRow {
  id: string;
  requestId: string;
  leaveDate: string;
  kind: LeaveDayKind;
  status: LeaveDayStatus;
  paid: boolean;
  frozen: boolean;
}

export async function listDays(tx: Tx, requestId: string): Promise<DayRow[]> {
  return rowsOf<DayRow>(
    await tx.execute(sql`
      select id::text as "id", request_id::text as "requestId", leave_date::text as "leaveDate", kind, status, paid,
             (frozen_by_pay_run_id is not null) as "frozen"
      from leave_request_days where request_id = ${requestId} order by leave_date`),
  );
}

/**
 * ⛔ `UPDATE ... WHERE id = $1 AND status = <from>` with the row count checked by the caller: the only race-safe way to move a
 * request on (two approvals, or an approval against a cancellation, cannot both win).
 */
export async function transitionRequest(
  tx: Tx,
  orgId: string,
  id: string,
  from: LeaveRequestStatus,
  to: 'approved' | 'rejected' | 'cancelled' | 'voided',
  by: { personId: string; reason?: string | null; paid?: boolean | null },
): Promise<boolean> {
  const patch =
    to === 'approved'
      ? { status: to, decidedBy: by.personId, decidedAt: new Date(), paid: by.paid ?? false }
      : to === 'rejected'
        ? { status: to, decidedBy: by.personId, decidedAt: new Date(), decisionReason: by.reason ?? null }
        : to === 'cancelled'
          ? { status: to, cancelledAt: new Date() }
          : { status: to, voidedBy: by.personId, voidedAt: new Date(), voidReason: by.reason ?? null };
  const rows = await tx
    .update(leaveRequests)
    .set(patch)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, from)))
    .returning({ id: leaveRequests.id });
  return rows.length > 0;
}

export async function setDaysStatus(
  tx: Tx,
  requestId: string,
  from: readonly LeaveDayStatus[],
  to: LeaveDayStatus,
  paid?: boolean,
): Promise<number> {
  const rows = await tx
    .update(leaveRequestDays)
    // A rest day is never paid, whatever the request's pay mode: only a real leave day carries `paid`.
    .set({
      status: to,
      updatedAt: new Date(),
      ...(paid === undefined ? {} : { paid: sql`case when ${leaveRequestDays.kind} = 'leave' then ${paid} else false end` }),
    })
    .where(and(eq(leaveRequestDays.requestId, requestId), inArray(leaveRequestDays.status, [...from])))
    .returning({ id: leaveRequestDays.id });
  return rows.length;
}

/** Dates (of these) on which the PERSON already has a live (pending or approved) leave day. */
export async function liveDatesTaken(tx: Tx, personId: string, dates: readonly string[]): Promise<string[]> {
  if (dates.length === 0) return [];
  const rows = rowsOf<{ d: string }>(
    await tx.execute(sql`
      select distinct leave_date::text as "d" from leave_request_days
      where person_id = ${personId} and status in ('pending','approved') and leave_date::text in ${list(dates)}
      order by 1`),
  );
  return rows.map((r) => r.d);
}

/** "Worked" = any attendance day for the person on that date that is not voided, `needs_review` included (spec D8). */
export async function workedDates(tx: Tx, personId: string, dates: readonly string[]): Promise<string[]> {
  if (dates.length === 0) return [];
  const rows = rowsOf<{ d: string }>(
    await tx.execute(sql`
      select distinct shift_day::text as "d" from attendance_days
      where person_id = ${personId} and status <> 'voided' and shift_day::text in ${list(dates)}
      order by 1`),
  );
  return rows.map((r) => r.d);
}

/** Dates (of these) that fall inside the period of a POSTED (not voided) pay run of this store: a paid day there would never be paid. */
export async function datesInPostedRunPeriod(tx: Tx, orgId: string, storeId: string, dates: readonly string[]): Promise<string[]> {
  if (dates.length === 0) return [];
  const rows = rowsOf<{ d: string }>(
    await tx.execute(sql`
      select distinct x::text as "d" from unnest(array[${sql.join(dates.map((v) => sql`${v}`), sql`, `)}]::date[]) as x
      where exists (select 1 from pay_runs r
                    where r.org_id = ${orgId} and r.store_id = ${storeId} and r.status = 'posted'
                      and x between r.period_start and r.period_end)
      order by 1`),
  );
  return rows.map((r) => r.d);
}

// ---------------------------------------------------------------------------------------------
// Counts (all PERSON-keyed, all under the caller's person lock)

/** Approved, real leave days (not rest days) of one kind in [from, to]. Voided / rejected / cancelled / superseded never count. */
export async function countApprovedDays(
  tx: Tx,
  input: { personId: string; leaveType: string; from: string; to: string },
): Promise<number> {
  const r = rowsOf<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as "n" from leave_request_days
      where person_id = ${input.personId} and leave_type = ${input.leaveType} and status = 'approved' and kind = 'leave'
        and leave_date between ${input.from}::date and ${input.to}::date`),
  )[0];
  return r?.n ?? 0;
}

/** Approved PAID days of kinds that draw Service Incentive Leave, in one calendar year. */
export async function countSilUsed(tx: Tx, input: { personId: string; orgId: string; year: number }): Promise<number> {
  const r = rowsOf<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as "n" from leave_request_days d
      where d.person_id = ${input.personId} and d.status = 'approved' and d.kind = 'leave' and d.paid
        and d.leave_date between make_date(${input.year}, 1, 1) and make_date(${input.year}, 12, 31)
        and exists (select 1 from leave_types t where t.code = d.leave_type and t.draws_sil and (t.org_id is null or t.org_id = ${input.orgId}))`),
  )[0];
  return r?.n ?? 0;
}

/** Approved real days of one kind for ONE birth (maternity 105, paternity 7). */
export async function countBirthDays(
  tx: Tx,
  input: { personId: string; leaveType: string; birthDate: string },
): Promise<number> {
  const r = rowsOf<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as "n" from leave_request_days d join leave_requests q on q.id = d.request_id
      where d.person_id = ${input.personId} and d.leave_type = ${input.leaveType} and d.status = 'approved' and d.kind = 'leave'
        and q.birth_date = ${input.birthDate}::date`),
  )[0];
  return r?.n ?? 0;
}

/** Distinct births (other than `exceptBirthDate`) that already have approved days of this kind (paternity: first 4 deliveries). */
export async function countOtherBirths(
  tx: Tx,
  input: { personId: string; leaveType: string; exceptBirthDate: string },
): Promise<number> {
  const r = rowsOf<{ n: number }>(
    await tx.execute(sql`
      select count(distinct q.birth_date)::int as "n" from leave_request_days d join leave_requests q on q.id = d.request_id
      where d.person_id = ${input.personId} and d.leave_type = ${input.leaveType} and d.status = 'approved' and d.kind = 'leave'
        and q.birth_date is not null and q.birth_date <> ${input.exceptBirthDate}::date`),
  )[0];
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Service chain

export interface EmploymentSpan {
  id: string;
  storeId: string;
  startedOn: string;
  endedOn: string | null;
}

export async function listEmploymentSpans(tx: Tx, orgId: string, personId: string): Promise<EmploymentSpan[]> {
  return rowsOf<EmploymentSpan>(
    await tx.execute(sql`
      select id::text as "id", store_id::text as "storeId", started_on::text as "startedOn", ended_on::text as "endedOn"
      from employments where org_id = ${orgId} and person_id = ${personId} order by started_on, id`),
  );
}

/** Persons holding an open employment at this store on `date`: the candidates for the year-end payout. */
export async function personsOpenAtStoreOn(
  tx: Tx,
  orgId: string,
  storeId: string,
  date: string,
): Promise<{ personId: string; personName: string }[]> {
  return rowsOf<{ personId: string; personName: string }>(
    await tx.execute(sql`
      select distinct e.person_id::text as "personId", p.display_name as "personName"
      from employments e join persons p on p.id = e.person_id
      where e.org_id = ${orgId} and e.store_id = ${storeId}
        and e.started_on <= ${date}::date and (e.ended_on is null or e.ended_on >= ${date}::date)`),
  );
}

// ---------------------------------------------------------------------------------------------
// Payroll

export interface PayableLeaveDay {
  id: string;
  requestId: string;
  personId: string;
  employmentId: string;
  leaveDate: string;
}

/** Approved, paid, real leave days filed at this store in the period, not yet frozen and not on a worked date. */
export async function payableLeaveDays(
  tx: Tx,
  orgId: string,
  input: { storeId: string; from: string; to: string },
): Promise<PayableLeaveDay[]> {
  return rowsOf<PayableLeaveDay>(
    await tx.execute(sql`
      select d.id::text as "id", d.request_id::text as "requestId", d.person_id::text as "personId",
             d.employment_id::text as "employmentId", d.leave_date::text as "leaveDate"
      from leave_request_days d
      where d.org_id = ${orgId} and d.store_id = ${input.storeId}
        and d.status = 'approved' and d.kind = 'leave' and d.paid and d.frozen_at is null
        and d.leave_date between ${input.from}::date and ${input.to}::date
        and not exists (select 1 from attendance_days a
                        where a.person_id = d.person_id and a.shift_day = d.leave_date and a.status <> 'voided')
      order by d.employment_id, d.leave_date`),
  );
}

export async function freezeLeaveDays(tx: Tx, ids: readonly string[], runId: string): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(leaveRequestDays)
    .set({ frozenAt: new Date(), frozenByPayRunId: runId, updatedAt: new Date() })
    .where(inArray(leaveRequestDays.id, [...ids]));
}

/** ⚠️ Voiding a run is the only thing that lifts a leave day's freeze, as for attendance days. */
export async function unfreezeLeaveDaysOfRun(tx: Tx, runId: string): Promise<number> {
  const rows = await tx
    .update(leaveRequestDays)
    .set({ frozenAt: null, frozenByPayRunId: null, updatedAt: new Date() })
    .where(eq(leaveRequestDays.frozenByPayRunId, runId))
    .returning({ id: leaveRequestDays.id });
  return rows.length;
}

export interface CommutationRow {
  id: string;
  personId: string;
  year: number;
  employmentId: string;
  days: string;
  dailyRate: string;
  amount: string;
  frozenByPayRunId: string | null;
  separationId: string | null;
}

export async function getCommutation(tx: Tx, orgId: string, personId: string, year: number): Promise<CommutationRow | undefined> {
  return rowsOf<CommutationRow>(
    await tx.execute(sql`
      select id::text as "id", person_id::text as "personId", year, employment_id::text as "employmentId",
             days::text as "days", daily_rate::text as "dailyRate", amount::text as "amount",
             frozen_by_pay_run_id::text as "frozenByPayRunId", separation_id::text as "separationId"
      from leave_commutations where org_id = ${orgId} and person_id = ${personId} and year = ${year}`),
  )[0];
}

export interface CommutationInput {
  orgId: string;
  personId: string;
  year: number;
  employmentId: string;
  days: Decimal<'6,2'>;
  dailyRate: Money;
  amount: Money;
  createdBy: string;
}

/**
 * Takes the person's year-end payout for ONE payer. Inserts the row, or re-takes one that was released (a voided run or
 * separation). Returns the row id, or `null` when somebody else already holds it: frozen to a run, or spoken for by a
 * separation. The WHERE on the conflict update is what makes a second payer find it taken.
 */
export async function claimCommutation(
  tx: Tx,
  input: CommutationInput & { payer: { runId: string } | { separationId: string } },
): Promise<{ id: string } | null> {
  const payerCols =
    'runId' in input.payer
      ? { frozenAt: new Date(), frozenByPayRunId: input.payer.runId, separationId: null }
      : { frozenAt: null, frozenByPayRunId: null, separationId: input.payer.separationId };
  const rows = await tx
    .insert(leaveCommutations)
    .values({
      orgId: input.orgId,
      personId: input.personId,
      year: input.year,
      employmentId: input.employmentId,
      days: input.days,
      dailyRate: input.dailyRate,
      amount: input.amount,
      createdBy: input.createdBy,
      ...payerCols,
    })
    .onConflictDoUpdate({
      target: [leaveCommutations.personId, leaveCommutations.year],
      set: {
        employmentId: input.employmentId,
        days: input.days,
        dailyRate: input.dailyRate,
        amount: input.amount,
        updatedAt: new Date(),
        ...payerCols,
      },
      setWhere: and(isNull(leaveCommutations.frozenByPayRunId), isNull(leaveCommutations.separationId)),
    })
    .returning({ id: leaveCommutations.id });
  return rows[0] ?? null;
}

export async function releaseCommutationsOfRun(tx: Tx, runId: string): Promise<{ id: string; personId: string }[]> {
  return tx
    .update(leaveCommutations)
    .set({ frozenAt: null, frozenByPayRunId: null, updatedAt: new Date() })
    .where(eq(leaveCommutations.frozenByPayRunId, runId))
    .returning({ id: leaveCommutations.id, personId: leaveCommutations.personId });
}

export async function releaseCommutationOfSeparation(tx: Tx, separationId: string): Promise<{ id: string; personId: string }[]> {
  return tx
    .update(leaveCommutations)
    .set({ separationId: null, updatedAt: new Date() })
    .where(eq(leaveCommutations.separationId, separationId))
    .returning({ id: leaveCommutations.id, personId: leaveCommutations.personId });
}

/** Whether the year's payout has already been taken by a run or a separation: late SIL days are then SIL_YEAR_CLOSED. */
export async function yearIsClosed(tx: Tx, orgId: string, personId: string, year: number): Promise<boolean> {
  const r = await getCommutation(tx, orgId, personId, year);
  return !!r && (r.frozenByPayRunId !== null || r.separationId !== null);
}

// ---------------------------------------------------------------------------------------------
// Attendance interplay (paid first / punches first)

export interface LiveLeaveOn {
  id: string;
  requestId: string;
  storeId: string;
  status: LeaveDayStatus;
  kind: LeaveDayKind;
  paid: boolean;
  frozen: boolean;
  leaveType: string;
}

export async function liveLeaveDaysOn(tx: Tx, personId: string, date: string): Promise<LiveLeaveOn[]> {
  return rowsOf<LiveLeaveOn>(
    await tx.execute(sql`
      select id::text as "id", request_id::text as "requestId", store_id::text as "storeId", status, kind, paid,
             (frozen_by_pay_run_id is not null) as "frozen", leave_type as "leaveType"
      from leave_request_days
      where person_id = ${personId} and leave_date = ${date}::date and status = 'approved' and kind = 'leave'`),
  );
}

export async function supersedeDay(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .update(leaveRequestDays)
    .set({ status: 'superseded_by_work', updatedAt: new Date() })
    .where(and(eq(leaveRequestDays.id, id), eq(leaveRequestDays.status, 'approved'), isNull(leaveRequestDays.frozenByPayRunId)))
    .returning({ id: leaveRequestDays.id });
  return rows.length > 0;
}

/**
 * The leave was PAID first and the punches arrived after: hold the attendance day from payroll so it is not paid twice.
 * Never touches a voided or a frozen day. Idempotent.
 */
export async function holdAttendanceDay(tx: Tx, personId: string, shiftDay: string): Promise<string | null> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      update attendance_days
         set status = 'needs_review',
             anomalies = case when 'leave_clash' = any(anomalies) then anomalies else array_append(anomalies, 'leave_clash') end
       where person_id = ${personId} and shift_day = ${shiftDay}::date
         and status not in ('voided', 'needs_review') and frozen_at is null
      returning id::text as "id"`),
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Read models (never the note, never a stored file's id)

export interface LeaveDayReadRow {
  requestId: string;
  personId: string;
  personName: string;
  employmentId: string;
  date: string;
  leaveType: string;
  kind: LeaveDayKind;
  paid: boolean;
  status: LeaveDayStatus;
  /** Punches exist on this date for this person (a clash with an approved leave day). */
  clash: boolean;
  hasProof: boolean;
  origin: LeaveOrigin;
}

export async function listDayRows(
  tx: Tx,
  orgId: string,
  input: { storeId: string; from: string; to: string; statuses: readonly LeaveDayStatus[] },
): Promise<LeaveDayReadRow[]> {
  return rowsOf<LeaveDayReadRow>(
    await tx.execute(sql`
      select d.request_id::text as "requestId", d.person_id::text as "personId", p.display_name as "personName",
             d.employment_id::text as "employmentId", d.leave_date::text as "date", d.leave_type as "leaveType",
             d.kind, d.paid, d.status,
             exists (select 1 from attendance_days a where a.person_id = d.person_id and a.shift_day = d.leave_date and a.status <> 'voided') as "clash",
             exists (select 1 from stored_files f where f.org_id = d.org_id and f.purpose = 'leave_document' and f.linked_to = d.request_id::text) as "hasProof",
             q.origin
      from leave_request_days d
      join leave_requests q on q.id = d.request_id
      join persons p on p.id = d.person_id
      where d.org_id = ${orgId} and d.store_id = ${input.storeId}
        and d.leave_date between ${input.from}::date and ${input.to}::date
        and d.status in ${list(input.statuses)}
      order by d.leave_date, p.display_name, d.request_id`),
  );
}

export async function hasProof(tx: Tx, orgId: string, requestId: string): Promise<boolean> {
  const r = rowsOf<{ b: boolean }>(
    await tx.execute(sql`
      select exists (select 1 from stored_files f where f.org_id = ${orgId} and f.purpose = 'leave_document' and f.linked_to = ${requestId}) as "b"`),
  )[0];
  return r?.b ?? false;
}

export async function proofFileOf(tx: Tx, orgId: string, requestId: string): Promise<string | null> {
  const r = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select id::text as "id" from stored_files
      where org_id = ${orgId} and purpose = 'leave_document' and linked_to = ${requestId}
      order by uploaded_at desc limit 1`),
  )[0];
  return r?.id ?? null;
}

/** The request a `leave_document` file is linked to (the file's `linked_to`). */
export async function requestOfFile(tx: Tx, orgId: string, fileId: string): Promise<string | null> {
  const r = rowsOf<{ linkedTo: string | null }>(
    await tx.execute(sql`select linked_to as "linkedTo" from stored_files where id = ${fileId} and org_id = ${orgId} and purpose = 'leave_document'`),
  )[0];
  return r?.linkedTo ?? null;
}

// ---------------------------------------------------------------------------------------------
// The person's own view (the leave page for a staff member)

export interface OwnRequestRow {
  requestId: string;
  status: LeaveRequestStatus;
  leaveType: string;
  paid: boolean | null;
  firstDate: string;
  lastDate: string;
  dayCount: number;
  hasProof: boolean;
  storeId: string;
}

/** A person's own requests, newest first. No note and no file id: the detail view (`loadLeaveRequest`) is where a note is read. */
export async function listRequestsOfPerson(tx: Tx, orgId: string, personId: string): Promise<OwnRequestRow[]> {
  return rowsOf<OwnRequestRow>(
    await tx.execute(sql`
      select q.id::text as "requestId", q.status, q.leave_type as "leaveType", q.paid, q.store_id::text as "storeId",
             min(d.leave_date)::text as "firstDate", max(d.leave_date)::text as "lastDate", count(d.id)::int as "dayCount",
             exists (select 1 from stored_files f where f.org_id = q.org_id and f.purpose = 'leave_document' and f.linked_to = q.id::text) as "hasProof"
      from leave_requests q join leave_request_days d on d.request_id = q.id
      where q.org_id = ${orgId} and q.person_id = ${personId}
      group by q.id
      order by min(d.leave_date) desc, q.id desc
      limit 100`),
  );
}

export interface OpenEmploymentRow {
  employmentId: string;
  storeId: string;
  storeName: string;
  startedOn: string;
}

export async function openEmploymentsOfPerson(tx: Tx, orgId: string, personId: string): Promise<OpenEmploymentRow[]> {
  return rowsOf<OpenEmploymentRow>(
    await tx.execute(sql`
      select e.id::text as "employmentId", e.store_id::text as "storeId", s.name as "storeName", e.started_on::text as "startedOn"
      from employments e join stores s on s.id = e.store_id
      where e.org_id = ${orgId} and e.person_id = ${personId} and e.ended_on is null
      order by e.started_on, e.id`),
  );
}
