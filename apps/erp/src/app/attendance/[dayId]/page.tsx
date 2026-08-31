import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../lib/session';
import { asClock, asHours, loadDay } from '../lib';
import type { DayReviewDetail } from '../lib';
import {
  approveEarlyOutAction,
  approveOvertimeAction,
  overrideHalfDayAction,
  setStartAnchorAction,
  verifyDayAction,
  voidDayAction,
} from './actions';

export const metadata = { title: 'Attendance day — Shareat System' };
export const dynamic = 'force-dynamic';

/*
  ⭐ **The decision surface. T-195, DEF-113.**

  Two halves, and the split is the whole architecture of T-158 made visible:

    LEFT   the EVIDENCE — punches, the engine's own explanation, anomalies. All read-only.
    RIGHT  the DECISIONS — one control per adjustment kind, each showing what already stands.

  ⚠️ v1's dialog carries the principle in a comment and v2's adjustment table is built on it:
  *"The original clock-in is never changed. It is a label."* A correction is a decision recorded
  BESIDE the fact, never a rewrite of the fact. That is why nothing on the left is editable.

  ⚠️ Phone portrait is the default canvas (Ian's standing rule): one column stacked, two side by
  side only from `lg`. Every control is a real form control — no hover-only affordances.
*/

const CARD = 'rounded border border-neutral-200 p-4 dark:border-neutral-800';
const FIELD =
  'rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900';
const BTN =
  'rounded border border-neutral-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 dark:border-neutral-700';

export default async function AttendanceDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ dayId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { dayId } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/attendance/${dayId}`);

  const detail = await loadDay(actor.orgId, actor, dayId);
  if (!detail) notFound();

  const { day, punches, lockedReason } = detail;
  const locked = lockedReason !== null;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <div className="space-y-1">
        <Link href="/attendance" className="text-sm underline underline-offset-2">
          ← Attendance review
        </Link>
        <h1 className="text-2xl font-semibold">
          {day.personName} · {day.shiftDay}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {asHours(day.computedMinutes)} paid{day.isHalfDay ? ' (half day)' : ''} ·{' '}
          {day.pendingOtMinutes > 0 ? `${asHours(day.pendingOtMinutes)} overtime recorded` : 'no overtime'} ·
          status <strong>{day.status}</strong>
        </p>
      </div>

      {sp.ok && (
        <p className="rounded border border-emerald-300 p-3 text-xs text-emerald-900 dark:border-emerald-800 dark:text-emerald-300">
          ✅ {sp.ok}
        </p>
      )}
      {sp.error && (
        <p className="rounded border border-red-300 p-3 text-xs text-red-900 dark:border-red-800 dark:text-red-300">
          ⛔ {sp.error}
        </p>
      )}
      {lockedReason && (
        <p className="rounded border border-amber-300 p-3 text-xs text-amber-900 dark:border-amber-800 dark:text-amber-300">
          🔒 <strong>No decision can be made on this day.</strong> {lockedReason}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Evidence detail={detail} />
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Decisions</h2>
          <Overtime day={day} locked={locked} />
          <StartAnchor day={day} locked={locked} />
          <EarlyOut day={day} locked={locked} />
          <HalfDay day={day} locked={locked} />
          <VerifyVoid day={day} locked={locked} />
        </div>
      </div>
    </main>
  );
}

/** ⛔ Read-only, all of it. The tap is a label. */
function Evidence({ detail }: { detail: DayReviewDetail }) {
  const { day, punches } = detail;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">What happened</h2>

      <div className={CARD}>
        <h3 className="text-xs uppercase tracking-wide text-neutral-500">
          Recorded taps — never edited
        </h3>
        {punches.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">No punches on this day.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm tabular-nums">
            {punches.map((p) => (
              <li key={p.id} className="flex justify-between gap-4">
                <span className="uppercase text-neutral-500">{p.assertedIntent}</span>
                <span>{new Date(p.occurredAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ⭐ The engine narrates every decision it made. Showing that verbatim is most of this
          screen's value and costs nothing — it is the difference between "5 hours" and "5 hours,
          and here is why it is not 7". */}
      <div className={CARD}>
        <h3 className="text-xs uppercase tracking-wide text-neutral-500">How it was worked out</h3>
        <ul className="mt-2 space-y-1 text-sm">
          {day.explain.map((line, i) => (
            <li key={i}>· {line}</li>
          ))}
        </ul>
      </div>

      {day.anomalies.length > 0 && (
        <div className="rounded border border-amber-300 p-4 dark:border-amber-800">
          <h3 className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Anomalies
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-amber-900 dark:text-amber-300">
            {day.anomalies.map((a) => (
              <li key={a}>⚠️ {a}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-400">
            ⛔ A day with an unresolved anomaly cannot be verified — a sign-off that ignores them
            records an approval nobody actually made.
          </p>
        </div>
      )}
    </div>
  );
}

type Day = DayReviewDetail['day'];

/** Hidden fields every decision form needs. */
function Ident({ day }: { day: Day }) {
  return (
    <>
      <input type="hidden" name="dayId" value={day.id} />
      <input type="hidden" name="employmentId" value={day.employmentId} />
      <input type="hidden" name="shiftDay" value={day.shiftDay} />
    </>
  );
}

/**
 * ⭐ The DEF-109 gate, with a face on it.
 *
 * ⚠️ The box is pre-filled with what was WORKED, not with zero — approving what actually happened
 * is the common case and should take one tap. A manager who wants to approve less types less; a
 * manager who wants to approve nothing types 0, and that is a decision the system records.
 */
function Overtime({ day, locked }: { day: Day; locked: boolean }) {
  if (day.pendingOtMinutes === 0) return null;
  return (
    <form action={approveOvertimeAction} className={`${CARD} space-y-2`}>
      <Ident day={day} />
      <h3 className="text-sm font-medium">
        Overtime — {asHours(day.pendingOtMinutes)} recorded
        {day.approvedOtMinutes !== null && (
          <span className="ml-2 text-xs font-normal text-emerald-700 dark:text-emerald-400">
            ✅ {asHours(day.approvedOtMinutes)} already approved
          </span>
        )}
      </h3>
      <p className="text-xs text-neutral-500">
        {day.computedMinutes <= 0
          ? '⛔ This day credits no basic pay at all — the whole stint is here. The pay run HOLDS it until you decide.'
          : '⛔ Pending overtime pays nothing until decided. Approving 0 is a decision; leaving it undecided is not.'}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          Minutes to pay
          <input
            name="approvedOtMinutes"
            type="number"
            min={0}
            max={day.pendingOtMinutes}
            defaultValue={day.approvedOtMinutes ?? day.pendingOtMinutes}
            className={FIELD + ' w-32'}
          />
        </label>
        <button type="submit" className={BTN} disabled={locked}>
          Decide
        </button>
      </div>
    </form>
  );
}

function StartAnchor({ day, locked }: { day: Day; locked: boolean }) {
  return (
    <form action={setStartAnchorAction} className={`${CARD} space-y-2`}>
      <Ident day={day} />
      <h3 className="text-sm font-medium">
        Paid from
        {day.hasStartAnchor && (
          <span className="ml-2 text-xs font-normal text-emerald-700 dark:text-emerald-400">
            ✅ decided
          </span>
        )}
      </h3>
      <p className="text-xs text-neutral-500">
        Currently {asClock(day.anchorMinute)} ({day.anchorMode}). ⚠️ This sets the start the day is
        PAID from. The tap itself does not move.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          Minute of shift day
          <input
            name="chosenAnchorMinute"
            type="number"
            min={0}
            defaultValue={day.anchorMinute ?? 0}
            className={FIELD + ' w-32'}
          />
        </label>
        <button type="submit" className={BTN} disabled={locked}>
          Set
        </button>
      </div>
    </form>
  );
}

function EarlyOut({ day, locked }: { day: Day; locked: boolean }) {
  return (
    <form action={approveEarlyOutAction} className={`${CARD} space-y-2`}>
      <Ident day={day} />
      <h3 className="text-sm font-medium">
        Paid until
        {day.hasEarlyOut && (
          <span className="ml-2 text-xs font-normal text-emerald-700 dark:text-emerald-400">
            ✅ decided
          </span>
        )}
      </h3>
      <p className="text-xs text-neutral-500">
        Currently {asClock(day.endMinute)}. Approving an early out pays to the scheduled end rather
        than to the actual tap.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          Minute of shift day
          <input
            name="effectiveOutMinute"
            type="number"
            min={0}
            defaultValue={day.endMinute ?? 0}
            className={FIELD + ' w-32'}
          />
        </label>
        <button type="submit" className={BTN} disabled={locked}>
          Approve
        </button>
      </div>
    </form>
  );
}

function HalfDay({ day, locked }: { day: Day; locked: boolean }) {
  return (
    <form action={overrideHalfDayAction} className={`${CARD} space-y-2`}>
      <Ident day={day} />
      <h3 className="text-sm font-medium">
        Half day
        {day.hasHalfDayOverride && (
          <span className="ml-2 text-xs font-normal text-emerald-700 dark:text-emerald-400">
            ✅ overridden
          </span>
        )}
      </h3>
      <p className="text-xs text-neutral-500">
        Currently <strong>{day.isHalfDay ? 'yes' : 'no'}</strong>. A half day pays half the daily
        rate, never the hours covered.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          Set to
          <select name="isHalfDay" defaultValue={String(day.isHalfDay)} className={FIELD + ' w-28'}>
            <option value="true">Half day</option>
            <option value="false">Full day</option>
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          Reason (required)
          <input name="reason" className={FIELD + ' w-full'} placeholder="Why this override?" />
        </label>
        <button type="submit" className={BTN} disabled={locked}>
          Override
        </button>
      </div>
    </form>
  );
}

/**
 * ⛔ **DEF-115 lived here.** Until T-195 both of these recorded an audit row and changed the day's
 * status not at all — so a voided day stayed `computed` and payroll **paid it in full**, and
 * `verified` was unreachable, which also meant a flagged day could never be rescued by anything.
 */
function VerifyVoid({ day, locked }: { day: Day; locked: boolean }) {
  return (
    <div className={`${CARD} space-y-3`}>
      <h3 className="text-sm font-medium">Settle this day</h3>

      <form action={verifyDayAction} className="space-y-1">
        <Ident day={day} />
        <p className="text-xs text-neutral-500">
          ⭐ Verifying is the <strong>only</strong> thing that can make a flagged day payable — a
          recompute deliberately will not.
        </p>
        <button type="submit" className={BTN} disabled={locked || day.status === 'verified'}>
          {day.status === 'verified' ? 'Verified' : 'Verify'}
        </button>
      </form>

      <form action={voidDayAction} className="space-y-1 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <Ident day={day} />
        <p className="text-xs text-neutral-500">
          ⛔ A voided day contributes nothing to payroll. The punches survive — the evidence outlives
          the decision.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
            Reason (required)
            <input name="reason" className={FIELD + ' w-full'} placeholder="Duplicate tap, etc." />
          </label>
          <button type="submit" className={BTN} disabled={locked || day.status === 'voided'}>
            {day.status === 'voided' ? 'Voided' : 'Void'}
          </button>
        </div>
      </form>
    </div>
  );
}
