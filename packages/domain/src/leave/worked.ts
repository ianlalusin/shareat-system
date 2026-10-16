/**
 * T-436 S4 - what happens when punches arrive on a date that has approved leave (spec D8). Called by the attendance recompute
 * (`adjudicateDay`) after it writes a day, so every route a punch can take (live punch, sweep, manager edit) reaches it.
 *
 * Two cases, and the order they happened in decides which:
 *  - the leave day is NOT yet paid: it becomes `superseded_by_work` (not paid, the SIL day goes back to the balance by itself because
 *    the balance counts only approved days). The day is paid once, as worked.
 *  - the leave day WAS paid in a run (frozen): the attendance day is held from payroll as `needs_review` with a clash flag, so it is
 *    not paid a second time; a manager resolves it (void the attendance day, or void the run and then the leave day).
 *
 * Deliberately depends only on the db repos and the audit writer, so the attendance module can import it without a cycle.
 */
import { auditLogRepo, leaveRepo, type Tx } from '@shareat/db';

export type LeaveWorkOutcome = 'none' | 'superseded' | 'held';

export async function reconcileLeaveWithWorkedDay(
  tx: Tx,
  input: { orgId: string; personId: string; shiftDay: string; attendanceStatus: string },
): Promise<LeaveWorkOutcome> {
  // A voided attendance day is not "worked": it never supersedes or blocks leave.
  if (input.attendanceStatus === 'voided') return 'none';
  const live = await leaveRepo.liveLeaveDaysOn(tx, input.personId, input.shiftDay);
  if (live.length === 0) return 'none';

  let outcome: LeaveWorkOutcome = 'none';
  for (const day of live) {
    if (day.frozen) {
      if (await leaveRepo.holdAttendanceDay(tx, input.personId, input.shiftDay)) outcome = 'held';
      continue;
    }
    if (await leaveRepo.supersedeDay(tx, day.id)) {
      outcome = outcome === 'held' ? outcome : 'superseded';
      await auditLogRepo.appendSystem(tx, input.orgId, {
        action: 'leave.superseded_by_work',
        storeId: day.storeId,
        entityId: day.requestId,
        before: { status: 'approved' },
        after: { personId: input.personId, leaveType: day.leaveType, dates: [input.shiftDay], status: 'superseded_by_work' },
        source: 'web',
      });
    }
  }
  return outcome;
}
