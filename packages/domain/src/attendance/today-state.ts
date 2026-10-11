/**
 * T-387 S7 - the live roster state: who is on the clock, on break, or off, right now, at one store.
 *
 * Built from TODAY's (shift day) open `attendance_days` rows and the latest punch intent of each: `break_start` is
 * break, anything else on an open day is on. A person with no open day today (never clocked in, or clocked out) is
 * off. Read-only; nothing here posts or writes.
 *
 * ⛔ Gated exactly like `attendanceRoster`: `manage_attendance` for THIS store. A viewer without it is refused with
 * `AuthorizationError`; the page catches that and draws no chips. Without the gate this would tell any signed-in
 * person who is at work, and where.
 */
import { attendanceDaysRepo, attendancePunchesRepo, employmentRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { toShiftDay } from './shift-day';

export type LiveState = 'on' | 'break' | 'off';

export interface TodayStateEntry {
  state: LiveState;
  /** The punch that began the state: the day's first `in` for on, the latest `break_start` for break. Absent when off. */
  since?: Date;
  /** The day's first `in`, when the person is on the clock or on break (the start of the worked bar). */
  firstIn?: Date;
}

export type TodayState = Record<string, TodayStateEntry>;

export async function todayStateFor(tx: Tx, actor: Actor, storeId: string, now: Date = new Date()): Promise<TodayState> {
  await authorize(tx, actor, 'manage_attendance', { storeId });

  const today = toShiftDay(now);
  const [roster, days, punches] = await Promise.all([
    employmentRepo.listActiveRoster(tx, storeId),
    attendanceDaysRepo.listDays(tx, { storeId, from: today, to: today }),
    attendancePunchesRepo.listForStoreRange(tx, { storeId, from: today, to: today }),
  ]);

  const openEmployments = new Set(days.filter((d) => d.status === 'open').map((d) => d.employmentId));

  // A punch that a later punch supersedes (a correction or a void) is not evidence of anything.
  const superseded = new Set(punches.map((p) => p.supersedesPunchId).filter((x): x is string => x !== null));
  const live = punches.filter((p) => !superseded.has(p.id) && p.voidReason === null);
  const byEmployment = new Map<string, typeof live>();
  for (const p of live) {
    const arr = byEmployment.get(p.employmentId) ?? [];
    arr.push(p);
    byEmployment.set(p.employmentId, arr); // listForStoreRange is ordered by occurredAt
  }

  const out: TodayState = {};
  for (const r of roster) {
    const mine = byEmployment.get(r.id) ?? [];
    if (!openEmployments.has(r.id) || mine.length === 0) {
      out[r.id] = { state: 'off' };
      continue;
    }
    const firstIn = mine.find((p) => p.assertedIntent === 'in')?.occurredAt ?? mine[0]!.occurredAt;
    const latest = mine[mine.length - 1]!;
    if (latest.assertedIntent === 'break_start') {
      out[r.id] = { state: 'break', since: latest.occurredAt, firstIn };
    } else {
      out[r.id] = { state: 'on', since: firstIn, firstIn };
    }
  }
  return out;
}
