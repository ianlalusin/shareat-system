/**
 * T-436 - leave and absence tracking: request, record, approve, reject, cancel, void, caps, the SIL balance and the read models.
 * `docs/tasks/436-leave-tracking.md`.
 *
 * ## The rules this file keeps, each of which has a test that names the mutant it kills
 *
 * - **The scope is the PERSON** (D3): one balance, one service date, one "leave day per date" however many jobs they hold.
 * - **Every transition is race-safe** (D6): authorize, then take the person's leave lock, then RE-READ the status and move it with
 *   `UPDATE ... WHERE status = <from>`; zero rows is `LEAVE_NOT_PENDING`. Cap and SIL counts are read under the same lock.
 * - **Nobody approves their own leave** (D5): keyed on the PERSON, never the role (`manage_attendance` is position-grantable),
 *   with one exception - a super_admin, audited `leave.self_approved`.
 * - **Whole days only** (Ian): a `portion` is refused.
 * - **The note is personal data** (D13, bible row 353): only the loader returns it, and only to people allowed to open the request.
 */
import { accessRepo, leaveRepo, advisoryLocksRepo, type Tx } from '@shareat/db';
import { authorize, heldCapabilities, type Actor } from '@shareat/auth';
import { toBusinessDate } from '@shareat/core/datetime';
import { escapeCsvCell } from '@shareat/core/csv';
import { gone } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { SETTINGS_LEAVE_CAP_RULES, SETTINGS_LEAVE_KIND_RULES } from '../field-rules/settings';
import { ATTENDANCE_LEAVE_RECORD_RULES, ATTENDANCE_LEAVE_REQUEST_RULES, ATTENDANCE_LEAVE_VOID_RULES } from '../field-rules/attendance';
import { audit } from './audit';
import { checkAndPrice, computeSilBalance, loadEmployment, withinEmployment, type DayIn } from './checks';
import { cmpIso, isoAfter } from './dates';
import { leaveRefusal } from './refusal';

// ---------------------------------------------------------------------------------------------
// Input handling

export interface LeaveDayInput {
  date: string;
  kind?: 'leave' | 'rest_day';
}

export interface LeaveRequestInput {
  employmentId: string;
  leaveType: string;
  days: LeaveDayInput[];
  note?: string | null;
  birthDate?: string | null;
  /** Record only: the pay mode the manager chooses. Ignored where the kind cannot be paid. */
  paid?: boolean;
  /** The screen's raw date fields (T-440 S9): when given, judged by the screen's own rules once the gate has passed. */
  screen?: { from: string | null; to: string | null; birthDate: string | null };
}

const MAX_DAYS = 366;
const MAX_NOTE = 2000;

function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  if (y < 1900 || y > 2999) return false;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Whole days only; real dates; no duplicates; sorted. */
function normaliseDays(input: { days?: unknown; portion?: unknown }): DayIn[] {
  if (input.portion !== undefined && input.portion !== null && input.portion !== 1) {
    throw leaveRefusal('LEAVE_WHOLE_DAYS', 'Leave is recorded in whole days only: a half day cannot be entered.');
  }
  const raw = Array.isArray(input.days) ? (input.days as Array<Record<string, unknown>>) : [];
  if (raw.length === 0) throw leaveRefusal('LEAVE_NO_DAYS', 'Pick at least one date.');
  if (raw.length > MAX_DAYS) throw leaveRefusal('LEAVE_NO_DAYS', `A request covers at most ${MAX_DAYS} days.`);
  const seen = new Set<string>();
  const out: DayIn[] = [];
  for (const d of raw) {
    if (d.portion !== undefined && d.portion !== null && d.portion !== 1) {
      throw leaveRefusal('LEAVE_WHOLE_DAYS', 'Leave is recorded in whole days only: a half day cannot be entered.');
    }
    if (!isRealDate(d.date)) throw leaveRefusal('LEAVE_BAD_DATE', 'One of the dates is not a real date (use YYYY-MM-DD).');
    if (seen.has(d.date)) throw leaveRefusal('LEAVE_BAD_DATE', `${d.date} is listed twice.`);
    seen.add(d.date);
    const kind = d.kind === 'rest_day' ? 'rest_day' : 'leave';
    out.push({ date: d.date, kind });
  }
  return out.sort((a, b) => cmpIso(a.date, b.date));
}

function cleanNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  const t = note.trim();
  if (!t) return null;
  return t.length > MAX_NOTE ? t.slice(0, MAX_NOTE) : t;
}

const run = <T>(tx: Tx, fn: (trx: Tx) => Promise<T>): Promise<T> => fn(tx);

async function isSuperAdmin(tx: Tx, actor: Actor): Promise<boolean> {
  const role = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
  return role?.role === 'super_admin';
}

const payload = (r: { personId: string; employmentId: string; leaveType: string }, dates: readonly string[], extra: Record<string, unknown> = {}) => ({
  personId: r.personId,
  employmentId: r.employmentId,
  leaveType: r.leaveType,
  dates: [...dates],
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// Create: a request (pending) or a manager's record (approved at once)

/** The WHO gate of a request or a record: a manager's capability at the job's store, unless a person files their own request. */
async function authorizeRequester(tx: Tx, actor: Actor, storeId: string, origin: 'request' | 'record', isSelf: boolean): Promise<void> {
  if (origin === 'record' || !isSelf) await authorize(tx, actor, 'manage_attendance', { storeId });
}

async function create(
  tx: Tx,
  actor: Actor,
  input: LeaveRequestInput,
  origin: 'request' | 'record',
): Promise<{ requestId: string }> {
  const employment = await loadEmployment(tx, input.employmentId);
  if (!employment || employment.orgId !== actor.orgId) throw gone('leave: that employment does not exist', 'job');
  const isSelf = employment.personId === actor.personId;
  let selfApprovedSuperAdmin = false;

  // WHO (D5). A request: the person themself (an identity check, no capability) or a manage_attendance holder on their behalf.
  // A record is always a manager's act.
  await authorizeRequester(tx, actor, employment.storeId, origin, isSelf);
  // T-440 S9 (ii): the screen's own rules, only once the gate has passed (a person filing their own request has no capability gate).
  if (input.screen) {
    if (origin === 'record') assertFieldRules(ATTENDANCE_LEAVE_RECORD_RULES, input.screen);
    else assertFieldRules(ATTENDANCE_LEAVE_REQUEST_RULES, input.screen);
  }
  if (origin === 'record' && isSelf) {
    if (!(await isSuperAdmin(tx, actor))) {
      throw leaveRefusal('LEAVE_OWN_APPROVAL', 'You cannot record your own leave: another manager has to enter it.');
    }
    selfApprovedSuperAdmin = true;
  }

  const type = await leaveRepo.resolveType(tx, actor.orgId, input.leaveType);
  if (!type || !type.active) throw leaveRefusal('LEAVE_TYPE_UNKNOWN', `"${String(input.leaveType)}" is not a kind of leave this business uses.`);
  if (origin === 'request' && !type.requestable) {
    throw leaveRefusal('LEAVE_NOT_REQUESTABLE', `${type.label} cannot be requested: a manager records it after the fact.`);
  }

  const days = normaliseDays(input as { days?: unknown; portion?: unknown });
  for (const d of days) {
    if (!withinEmployment(employment, d.date)) {
      throw leaveRefusal('LEAVE_OUTSIDE_EMPLOYMENT', `${d.date} is outside this job (${employment.startedOn} to ${employment.endedOn ?? 'now'}).`);
    }
  }
  if (origin === 'request' && employment.endedOn !== null) {
    throw leaveRefusal('LEAVE_OUTSIDE_EMPLOYMENT', 'This job has ended, so leave can no longer be requested for it.');
  }
  // v1's guard survives for the after-the-fact record only: a future date is a REQUEST, not a record.
  if (origin === 'record') {
    const today = toBusinessDate();
    const future = days.find((d) => isoAfter(d.date, today));
    if (future) throw leaveRefusal('LEAVE_FUTURE_RECORD', `${future.date} is in the future: file it as a request, not a record.`);
  }

  let birthDate: string | null = null;
  if (type.legalPerBirthDays !== null) {
    if (!isRealDate(input.birthDate)) {
      throw leaveRefusal('LEAVE_BIRTH_REQUIRED', `${type.label} is counted per birth: enter the date of the birth.`);
    }
    birthDate = input.birthDate;
  }

  await advisoryLocksRepo.lockPersonLeave(tx, employment.personId);

  const taken = await leaveRepo.liveDatesTaken(tx, employment.personId, days.map((d) => d.date));
  if (taken.length > 0) {
    throw leaveRefusal('LEAVE_DATE_TAKEN', `This person already has leave on ${taken.join(', ')} (one leave day per person per date).`);
  }

  const note = cleanNote(input.note);
  const dates = days.map((d) => d.date);

  if (origin === 'request') {
    const { id } = await leaveRepo.insertRequest(tx, {
      orgId: actor.orgId,
      personId: employment.personId,
      employmentId: employment.id,
      storeId: employment.storeId,
      leaveType: type.code,
      status: 'pending',
      origin,
      paid: null,
      birthDate,
      note,
      requestedBy: actor.personId,
      decidedBy: null,
    });
    await leaveRepo.insertDays(
      tx,
      days.map((d) => ({
        orgId: actor.orgId,
        requestId: id,
        personId: employment.personId,
        employmentId: employment.id,
        storeId: employment.storeId,
        leaveType: type.code,
        leaveDate: d.date,
        kind: d.kind,
        status: 'pending' as const,
        paid: false,
      })),
    );
    await audit(tx, actor, 'leave.requested', {
      storeId: employment.storeId,
      entityId: id,
      after: payload({ personId: employment.personId, employmentId: employment.id, leaveType: type.code }, dates, {
        status: 'pending',
        restDays: days.filter((d) => d.kind === 'rest_day').map((d) => d.date),
      }),
    });
    return { requestId: id };
  }

  // A record: judged by every rule now, approved at once.
  const price = await checkAndPrice(
    tx,
    { orgId: actor.orgId, personId: employment.personId, employment, type, birthDate },
    days,
    input.paid,
  );
  const { id } = await leaveRepo.insertRequest(tx, {
    orgId: actor.orgId,
    personId: employment.personId,
    employmentId: employment.id,
    storeId: employment.storeId,
    leaveType: type.code,
    status: 'approved',
    origin,
    paid: price.paid,
    birthDate,
    note,
    requestedBy: actor.personId,
    decidedBy: actor.personId,
  });
  await leaveRepo.insertDays(
    tx,
    days.map((d) => ({
      orgId: actor.orgId,
      requestId: id,
      personId: employment.personId,
      employmentId: employment.id,
      storeId: employment.storeId,
      leaveType: type.code,
      leaveDate: d.date,
      kind: d.kind,
      status: 'approved' as const,
      paid: d.kind === 'leave' && price.paid,
    })),
  );
  await audit(tx, actor, 'leave.recorded', {
    storeId: employment.storeId,
    entityId: id,
    after: payload({ personId: employment.personId, employmentId: employment.id, leaveType: type.code }, dates, {
      status: 'approved',
      paid: price.paid,
    }),
  });
  if (price.overridden) {
    await audit(tx, actor, 'leave.paid_override', {
      storeId: employment.storeId,
      entityId: id,
      after: payload({ personId: employment.personId, employmentId: employment.id, leaveType: type.code }, dates, {
        paid: price.paid,
        kindDefault: type.paid,
      }),
    });
  }
  if (selfApprovedSuperAdmin) {
    await audit(tx, actor, 'leave.self_approved', {
      storeId: employment.storeId,
      entityId: id,
      after: payload({ personId: employment.personId, employmentId: employment.id, leaveType: type.code }, dates, { status: 'approved' }),
    });
  }
  return { requestId: id };
}

/** Files a request: pending until a manager decides. The person themself, or a manage_attendance holder for them. */
export function requestLeave(tx: Tx, actor: Actor, input: LeaveRequestInput): Promise<{ requestId: string }> {
  return run(tx, (trx) => create(trx, actor, input, 'request'));
}

/** A manager records a past absence: created already approved, judged by every rule (v1's flow, with caps under a lock). */
export function recordLeave(tx: Tx, actor: Actor, input: LeaveRequestInput): Promise<{ requestId: string }> {
  return run(tx, (trx) => create(trx, actor, input, 'record'));
}

// ---------------------------------------------------------------------------------------------
// Decide

/** Reads the request fresh, AFTER the person lock is held (a read taken before it could be stale by the time the lock is won). */
async function lockedRequest(tx: Tx, actor: Actor, requestId: string) {
  const first = await leaveRepo.getRequest(tx, actor.orgId, requestId);
  if (!first) {
    // A missing id must not tell a caller who may not decide leave which ids exist: they get the same refusal a real request
    // would give them. Only someone who holds the capability somewhere learns "does not exist".
    if (!(await heldCapabilities(tx, actor)).has('manage_attendance')) await authorize(tx, actor, 'manage_attendance');
    throw gone('leave: that request does not exist', 'leave request');
  }
  return first;
}

export function approveLeave(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; paid?: boolean },
): Promise<{ requestId: string; paid: boolean }> {
  return run(tx, async (trx) => {
    const found = await lockedRequest(trx, actor, input.requestId);
    await authorize(trx, actor, 'manage_attendance', { storeId: found.storeId });

    // ⛔ D5: the guard is keyed on the PERSON (actor = requester's person), never the role.
    const self = found.personId === actor.personId;
    const superAdmin = self ? await isSuperAdmin(trx, actor) : false;
    if (self && !superAdmin) {
      throw leaveRefusal('LEAVE_OWN_APPROVAL', 'You cannot approve your own leave: another manager has to decide it.');
    }

    await advisoryLocksRepo.lockPersonLeave(trx, found.personId);
    const request = await leaveRepo.getRequest(trx, actor.orgId, input.requestId);
    if (!request || request.status !== 'pending') {
      throw leaveRefusal('LEAVE_NOT_PENDING', 'This request is no longer pending: someone has already decided or cancelled it.');
    }

    const employment = await loadEmployment(trx, request.employmentId);
    const type = await leaveRepo.resolveType(trx, actor.orgId, request.leaveType);
    if (!employment || !type) throw gone('leave: the job or kind of this request is gone', 'leave request');

    const pending = (await leaveRepo.listDays(trx, request.id)).filter((d) => d.status === 'pending');
    const days: DayIn[] = pending.map((d) => ({ date: d.leaveDate, kind: d.kind }));
    const dates = days.map((d) => d.date);

    const price = await checkAndPrice(
      trx,
      { orgId: actor.orgId, personId: request.personId, employment, type, birthDate: request.birthDate },
      days,
      input.paid,
    );

    const moved = await leaveRepo.transitionRequest(trx, actor.orgId, request.id, 'pending', 'approved', {
      personId: actor.personId,
      paid: price.paid,
    });
    if (!moved) throw leaveRefusal('LEAVE_NOT_PENDING', 'This request is no longer pending: someone has already decided or cancelled it.');
    await leaveRepo.setDaysStatus(trx, request.id, ['pending'], 'approved', price.paid);

    const who = { personId: request.personId, employmentId: request.employmentId, leaveType: request.leaveType };
    await audit(trx, actor, 'leave.approved', {
      storeId: request.storeId,
      entityId: request.id,
      before: { status: 'pending' },
      after: payload(who, dates, { status: 'approved', paid: price.paid }),
    });
    if (price.overridden) {
      await audit(trx, actor, 'leave.paid_override', {
        storeId: request.storeId,
        entityId: request.id,
        after: payload(who, dates, { paid: price.paid, kindDefault: type.paid }),
      });
    }
    if (superAdmin) {
      await audit(trx, actor, 'leave.self_approved', {
        storeId: request.storeId,
        entityId: request.id,
        after: payload(who, dates, { status: 'approved' }),
      });
    }
    return { requestId: request.id, paid: price.paid };
  });
}

export function rejectLeave(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; reason?: string | null },
): Promise<{ requestId: string }> {
  return run(tx, async (trx) => {
    const found = await lockedRequest(trx, actor, input.requestId);
    await authorize(trx, actor, 'manage_attendance', { storeId: found.storeId });
    await advisoryLocksRepo.lockPersonLeave(trx, found.personId);
    const request = await leaveRepo.getRequest(trx, actor.orgId, input.requestId);
    if (!request || request.status !== 'pending') {
      throw leaveRefusal('LEAVE_NOT_PENDING', 'This request is no longer pending: someone has already decided or cancelled it.');
    }
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : null;
    const moved = await leaveRepo.transitionRequest(trx, actor.orgId, request.id, 'pending', 'rejected', { personId: actor.personId, reason });
    if (!moved) throw leaveRefusal('LEAVE_NOT_PENDING', 'This request is no longer pending: someone has already decided or cancelled it.');
    const days = await leaveRepo.listDays(trx, request.id);
    await leaveRepo.setDaysStatus(trx, request.id, ['pending'], 'rejected');
    await audit(trx, actor, 'leave.rejected', {
      storeId: request.storeId,
      entityId: request.id,
      before: { status: 'pending' },
      after: payload(request, days.map((d) => d.leaveDate), { status: 'rejected', reason }),
    });
    return { requestId: request.id };
  });
}

/** Cancel a pending request: by the person it is for, the one who filed it, or a manager. */
export function cancelLeave(tx: Tx, actor: Actor, input: { requestId: string }): Promise<{ requestId: string }> {
  return run(tx, async (trx) => {
    const found = await lockedRequest(trx, actor, input.requestId);
    const mine = found.personId === actor.personId || found.requestedBy === actor.personId;
    if (!mine) await authorize(trx, actor, 'manage_attendance', { storeId: found.storeId });
    await advisoryLocksRepo.lockPersonLeave(trx, found.personId);
    const request = await leaveRepo.getRequest(trx, actor.orgId, input.requestId);
    if (!request || request.status !== 'pending') {
      throw leaveRefusal('LEAVE_NOT_PENDING', 'This request is no longer pending: someone has already decided or cancelled it.');
    }
    const moved = await leaveRepo.transitionRequest(trx, actor.orgId, request.id, 'pending', 'cancelled', { personId: actor.personId });
    if (!moved) throw leaveRefusal('LEAVE_NOT_PENDING', 'This request is no longer pending: someone has already decided or cancelled it.');
    const days = await leaveRepo.listDays(trx, request.id);
    await leaveRepo.setDaysStatus(trx, request.id, ['pending'], 'cancelled');
    await audit(trx, actor, 'leave.cancelled', {
      storeId: request.storeId,
      entityId: request.id,
      before: { status: 'pending' },
      after: payload(request, days.map((d) => d.leaveDate), { status: 'cancelled' }),
    });
    return { requestId: request.id };
  });
}

/**
 * Voids an approved request, with a reason. ⛔ Refused (`LEAVE_DAY_PAID`) while any of its days is frozen to a pay run: a day a
 * run has paid cannot quietly stop being leave. Void the run first.
 */
export function voidLeave(
  tx: Tx,
  actor: Actor,
  input: { requestId: string; reason?: string | null },
): Promise<{ requestId: string }> {
  return run(tx, async (trx) => {
    const found = await lockedRequest(trx, actor, input.requestId);
    await authorize(trx, actor, 'manage_attendance', { storeId: found.storeId });
    // T-440 S9 (ii): the screen's own rule, only once the gate has passed.
    assertFieldRules(ATTENDANCE_LEAVE_VOID_RULES, { reason: input.reason });
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) throw leaveRefusal('LEAVE_REASON_REQUIRED', 'Voiding leave needs a reason.');

    await advisoryLocksRepo.lockPersonLeave(trx, found.personId);
    const request = await leaveRepo.getRequest(trx, actor.orgId, input.requestId);
    if (!request || request.status !== 'approved') {
      throw leaveRefusal('LEAVE_NOT_APPROVED', 'Only an approved request can be voided (a pending one is rejected or cancelled).');
    }
    const days = await leaveRepo.listDays(trx, request.id);
    if (days.some((d) => d.frozen)) {
      throw leaveRefusal(
        'LEAVE_DAY_PAID',
        'A pay run has already paid one of these leave days. Void that pay run first, then void the leave.',
      );
    }
    const moved = await leaveRepo.transitionRequest(trx, actor.orgId, request.id, 'approved', 'voided', { personId: actor.personId, reason });
    if (!moved) throw leaveRefusal('LEAVE_NOT_APPROVED', 'Only an approved request can be voided (a pending one is rejected or cancelled).');
    await leaveRepo.setDaysStatus(trx, request.id, ['approved'], 'voided');
    await audit(trx, actor, 'leave.voided', {
      storeId: request.storeId,
      entityId: request.id,
      before: { status: 'approved' },
      after: payload(request, days.map((d) => d.leaveDate), { status: 'voided', reason }),
    });
    return { requestId: request.id };
  });
}

// ---------------------------------------------------------------------------------------------
// Caps and kinds

export interface LeaveCapInput {
  leaveType: string;
  storeId?: string | null;
  positionId?: string | null;
  monthlyCap: number | null;
  yearlyCap: number | null;
}

const validCap = (n: unknown): n is number | null => n === null || n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 366);

/**
 * Sets the monthly / yearly limit for a kind, org-wide or for a store and / or position. NULL = no limit.
 * ⛔ A statutory kind's legal yearly limit cannot be lowered. A per-birth kind (maternity, paternity) is ACCEPTED but ignored:
 * it is judged per birth, never against a cap, so nothing is stored.
 */
export function setLeaveCap(
  tx: Tx,
  actor: Actor,
  input: LeaveCapInput,
): Promise<{ id: string | null; ignored: boolean }> {
  return run(tx, async (trx) => {
    const storeId = input.storeId ?? null;
    const positionId = input.positionId ?? null;
    // A store's own caps are a manage_attendance act there; an org-wide default is a people-admin act (admin and above).
    await authorize(trx, actor, storeId ? 'manage_attendance' : 'manage_users', storeId ? { storeId } : {});
    // T-440 S9 (ii): the screen's own rules, only once the gate has passed.
    assertFieldRules(SETTINGS_LEAVE_CAP_RULES, {
      monthlyCap: input.monthlyCap == null ? null : String(input.monthlyCap),
      yearlyCap: input.yearlyCap == null ? null : String(input.yearlyCap),
    });

    const type = await leaveRepo.resolveType(trx, actor.orgId, input.leaveType);
    if (!type) throw leaveRefusal('LEAVE_TYPE_UNKNOWN', `"${String(input.leaveType)}" is not a kind of leave this business uses.`);
    if (!validCap(input.monthlyCap) || !validCap(input.yearlyCap)) {
      throw leaveRefusal('LEAVE_CAP_INVALID', 'A cap is a whole number of days (0 or more), or empty for no limit.');
    }
    const monthlyCap = input.monthlyCap ?? null;
    const yearlyCap = input.yearlyCap ?? null;

    if (type.legalPerBirthDays !== null) return { id: null, ignored: true };

    if (type.legalYearlyDays !== null) {
      const floor = type.legalYearlyDays;
      if ((yearlyCap !== null && yearlyCap < floor) || (monthlyCap !== null && monthlyCap < floor)) {
        throw leaveRefusal(
          'LEAVE_CAP_BELOW_LEGAL',
          `${type.code}: the law gives ${floor} days a year, so a cap cannot be lower than ${floor}. You can raise it.`,
        );
      }
    }

    const saved = await leaveRepo.upsertCap(trx, {
      orgId: actor.orgId,
      leaveType: type.code,
      storeId,
      positionId,
      monthlyCap,
      yearlyCap,
      actorPersonId: actor.personId,
    });
    await audit(trx, actor, 'leave_cap.changed', {
      storeId,
      entityId: saved.id,
      before: saved.before,
      after: { leaveType: type.code, storeId, positionId, monthlyCap, yearlyCap },
    });
    return { id: saved.id, ignored: false };
  });
}

/** Adds a kind of leave this org uses beyond the eleven platform kinds. The code is permanent; the kind is retired, never deleted. */
export function addLeaveType(
  tx: Tx,
  actor: Actor,
  input: { code: string; label: string; paid: boolean; needsProof?: boolean },
): Promise<{ id: string }> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, 'manage_users');
    // T-440 S9 (ii): the screen's own rules, only once the gate has passed.
    assertFieldRules(SETTINGS_LEAVE_KIND_RULES, { code: input.code, label: input.label });
    const code = String(input.code ?? '').trim().toLowerCase();
    const label = String(input.label ?? '').trim();
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(code) || !label) {
      throw leaveRefusal('LEAVE_TYPE_UNKNOWN', 'A leave kind needs a short code (letters, digits and underscores) and a name.');
    }
    if (await leaveRepo.resolveType(trx, actor.orgId, code)) {
      throw leaveRefusal('LEAVE_TYPE_EXISTS', `There is already a kind of leave with the code "${code}".`);
    }
    const { id } = await leaveRepo.insertOrgType(trx, {
      orgId: actor.orgId,
      code,
      label: label.slice(0, 80),
      paid: input.paid === true,
      needsProof: input.needsProof === true,
    });
    await audit(trx, actor, 'leave_type.changed', {
      storeId: null,
      entityId: id,
      after: { code, paid: input.paid === true, active: true },
    });
    return { id };
  });
}

/** Retires or restores a kind this org added. The platform kinds are not the org's to switch off. */
export function setLeaveTypeActive(
  tx: Tx,
  actor: Actor,
  input: { id: string; active: boolean },
): Promise<{ id: string }> {
  return run(tx, async (trx) => {
    await authorize(trx, actor, 'manage_users');
    const types = await leaveRepo.listTypes(trx, actor.orgId);
    const type = types.find((t) => t.id === input.id && t.orgId === actor.orgId);
    if (!type) throw leaveRefusal('LEAVE_TYPE_UNKNOWN', 'That kind of leave is not one this business added, so it cannot be switched off.');
    await leaveRepo.setOrgTypeActive(trx, actor.orgId, type.id, input.active === true);
    await audit(trx, actor, 'leave_type.changed', {
      storeId: null,
      entityId: type.id,
      before: { code: type.code, active: type.active },
      after: { code: type.code, active: input.active === true },
    });
    return { id: type.id };
  });
}

export function listLeaveTypes(tx: Tx, actor: Actor): Promise<leaveRepo.LeaveTypeRow[]> {
  return run(tx, (trx) => leaveRepo.listTypes(trx, actor.orgId));
}

/**
 * The caps on file. For a store: the org-wide defaults plus that store's own rows (a manage_attendance holder there). With no store:
 * every row in the org (people admin).
 */
export function listLeaveCaps(tx: Tx, actor: Actor, input: { storeId?: string } = {}): Promise<leaveRepo.CapListRow[]> {
  return run(tx, async (trx) => {
    if (input.storeId) await authorize(trx, actor, 'manage_attendance', { storeId: input.storeId });
    else await authorize(trx, actor, 'manage_users');
    const all = await leaveRepo.listCaps(trx, actor.orgId);
    return input.storeId ? all.filter((c) => c.storeId === null || c.storeId === input.storeId) : all;
  });
}

// ---------------------------------------------------------------------------------------------
// SIL balance

/** `{ entitlement, used, remaining }` for a person in a calendar year - derived, never stored. The person, or a manage_attendance holder. */
export function silBalance(
  tx: Tx,
  actor: Actor,
  input: { personId: string; year: number },
): Promise<{ entitlement: number; used: number; remaining: number }> {
  return run(tx, async (trx) => {
    if (actor.personId !== input.personId) {
      const spans = await leaveRepo.listEmploymentSpans(trx, actor.orgId, input.personId);
      const latest = spans[spans.length - 1];
      if (!latest) throw gone('leave: that person has no job on record', 'person');
      await authorize(trx, actor, 'manage_attendance', { storeId: latest.storeId });
    }
    const b = await computeSilBalance(trx, actor.orgId, input.personId, input.year);
    return { entitlement: b.entitlement, used: b.used, remaining: b.remaining };
  });
}

// ---------------------------------------------------------------------------------------------
// Read models

export interface LeaveRequestView {
  requestId: string;
  personId: string;
  employmentId: string;
  storeId: string;
  status: string;
  leaveType: string;
  origin: string;
  paid: boolean | null;
  birthDate: string | null;
  days: { date: string; kind: string; status: string; paid: boolean }[];
  /** Whether a certificate is attached. ⛔ Never the file's id: a permitted viewer gets it separately from `leaveProofFileId` (T-441 S4). */
  hasProof: boolean;
  /** ⛔ Present ONLY for the person and for a manage_attendance holder at the filing store (bible row 353). */
  note?: string | null;
}

/**
 * Loads one request. The person it is for and a manage_attendance holder at its store may open it; anyone else is refused.
 * The `note` key exists only on what they get back - it is never stripped by the screen, it is never selected for anyone else.
 */
export function loadLeaveRequest(tx: Tx, actor: Actor, input: { requestId: string }): Promise<LeaveRequestView> {
  return run(tx, async (trx) => {
    const request = await leaveRepo.getRequest(trx, actor.orgId, input.requestId);
    if (!request) throw gone('leave: that request does not exist', 'leave request');
    if (request.personId !== actor.personId) await authorize(trx, actor, 'manage_attendance', { storeId: request.storeId });

    const days = await leaveRepo.listDays(trx, request.id);
    const view: LeaveRequestView = {
      requestId: request.id,
      personId: request.personId,
      employmentId: request.employmentId,
      storeId: request.storeId,
      status: request.status,
      leaveType: request.leaveType,
      origin: request.origin,
      paid: request.paid,
      birthDate: request.birthDate,
      days: days.map((d) => ({ date: d.leaveDate, kind: d.kind, status: d.status, paid: d.paid })),
      hasProof: await leaveRepo.hasProof(trx, actor.orgId, request.id),
    };
    view.note = await leaveRepo.getRequestNote(trx, actor.orgId, request.id);
    return view;
  });
}

export interface LeaveRow {
  requestId: string;
  personId: string;
  personName: string;
  employmentId: string;
  date: string;
  leaveType: string;
  kind: string;
  paid: boolean;
  status: string;
  /** Punches exist on this date. */
  clash: boolean;
  hasProof: boolean;
  origin: string;
}

const MAX_RANGE_DAYS = 100;

function checkRange(input: { storeId: string; from: string; to: string }): void {
  if (!isRealDate(input.from) || !isRealDate(input.to) || isoAfter(input.from, input.to)) {
    throw leaveRefusal('LEAVE_BAD_DATE', 'Pick a valid date range (from is on or before to).');
  }
  const span = (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000;
  if (span > MAX_RANGE_DAYS) throw leaveRefusal('LEAVE_BAD_DATE', `Pick a range of at most ${MAX_RANGE_DAYS} days.`);
}

async function rows(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; from: string; to: string },
  statuses: readonly leaveRepo.LeaveDayReadRow['status'][],
): Promise<LeaveRow[]> {
  await authorize(tx, actor, 'manage_attendance', { storeId: input.storeId });
  checkRange(input);
  return leaveRepo.listDayRows(tx, actor.orgId, { ...input, statuses });
}

/** Every leave date in a store and range, whatever its status. The kind only: no note, no file id. */
export function listLeave(tx: Tx, actor: Actor, input: { storeId: string; from: string; to: string }): Promise<LeaveRow[]> {
  return run(tx, (trx) => rows(trx, actor, input, ['pending', 'approved', 'rejected', 'cancelled', 'voided', 'superseded_by_work']));
}

/** What the attendance grid draws: pending and approved leave, with Paid / Unpaid and the punches-that-day clash flag. */
export function leaveGrid(tx: Tx, actor: Actor, input: { storeId: string; from: string; to: string }): Promise<LeaveRow[]> {
  return run(tx, (trx) => rows(trx, actor, input, ['pending', 'approved']));
}

export function exportLeaveCsv(tx: Tx, actor: Actor, input: { storeId: string; from: string; to: string }): Promise<string> {
  return run(tx, async (trx) => {
    const list = await rows(trx, actor, input, ['pending', 'approved', 'voided', 'superseded_by_work']);
    const header = ['Date', 'Person', 'Kind', 'Leave type', 'Status', 'Pay', 'Punches that day', 'Proof attached'];
    const lines = [header, ...list.map((r) => [r.date, r.personName, r.kind, r.leaveType, r.status, r.paid ? 'Paid' : 'Unpaid', r.clash ? 'Yes' : 'No', r.hasProof ? 'Yes' : 'No'])];
    return lines.map((l) => l.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
  });
}

// ---------------------------------------------------------------------------------------------
// The person's own screen

export interface MyLeave {
  year: number;
  employments: leaveRepo.OpenEmploymentRow[];
  requests: leaveRepo.OwnRequestRow[];
  balance: { entitlement: number; used: number; remaining: number };
  types: leaveRepo.LeaveTypeRow[];
}

/** What a staff member sees about their own leave: their open jobs, their requests, this year's SIL balance and the kinds they may file. */
export function myLeave(tx: Tx, actor: Actor): Promise<MyLeave> {
  return run(tx, async (trx) => {
    const year = Number(toBusinessDate().slice(0, 4));
    const [employments, requests, balance, types] = await Promise.all([
      leaveRepo.openEmploymentsOfPerson(trx, actor.orgId, actor.personId),
      leaveRepo.listRequestsOfPerson(trx, actor.orgId, actor.personId),
      computeSilBalance(trx, actor.orgId, actor.personId, year),
      leaveRepo.listTypes(trx, actor.orgId),
    ]);
    return {
      year,
      employments,
      requests,
      balance: { entitlement: balance.entitlement, used: balance.used, remaining: balance.remaining },
      types: types.filter((t) => t.active && t.requestable),
    };
  });
}
