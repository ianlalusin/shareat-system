import { FormDisclosure } from '@/components/forms/FormDisclosure';
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
import { isBlockingAnomaly } from '@shareat/domain';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Banner, Button, ConfirmDestructive, Field, FlashBanner, Input, Select, statusLabel } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { ATTENDANCE_EARLY_OUT_RULES, ATTENDANCE_OVERTIME_RULES, ATTENDANCE_START_ANCHOR_RULES, nativeAttrs } from '@shareat/domain/field-rules';

/**
 * Plain-language names for the engine's anomaly codes.
 *
 * ⚠️ A manager reading `half_day_near_full` learns nothing; the point of surfacing it is that they
 * act on it. Missing keys fall through to the raw code rather than being hidden, so a new anomaly
 * is ugly here rather than invisible.
 */
const ANOMALY_LABEL: Record<string, string> = {
  missing_in: 'No clock-in recorded',
  missing_out: 'No clock-out recorded',
  no_punches: 'No punches at all',
  overlapping: 'Overlapping punches',
  start_not_allowed: 'Started at an hour this store does not list',
  break_not_closed: 'A break was started and never ended',
  late_event_arrival: 'A punch reached the server more than 72h late',
  inverted_window: 'Clock-out is before clock-in',
  implausible_span: 'Credited far more time than the person was present',
  half_day_near_full:
    'Credited a half day, but worked closer to a FULL day — confirm whether the undertime was permitted',
};

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

const CARD = 'rounded border border-surface-border p-4';

export default async function AttendanceDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ dayId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { dayId } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/attendance/${dayId}`);

  const detail = await loadDay(actor.orgId, actor, dayId);
  if (!detail) notFound();

  const { day, punches, lockedReason } = detail;
  const locked = lockedReason !== null;

  return (
    <Page view="detail" sectioned density="table">
      <div className="space-y-1">
        <Link href="/attendance" className="text-sm underline underline-offset-2">
          ← Attendance review
        </Link>
        <h1 className="text-2xl font-semibold">
          {day.personName} · {day.shiftDay}
        </h1>
        <PageDescription>
          {asHours(day.computedMinutes)} paid{day.isHalfDay ? ' (half day)' : ''} ·{' '}
          {day.pendingOtMinutes > 0 ? `${asHours(day.pendingOtMinutes)} overtime recorded` : 'no overtime'} ·
          status <strong>{statusLabel(day.status)}</strong>
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />
      {lockedReason && (
        <Banner tone="warning">
          🔒 <strong>No decision can be made on this day.</strong> {lockedReason}
        </Banner>
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
    </Page>
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
        <div className="rounded border border-warning p-4">
          <h3 className="text-xs uppercase tracking-wide text-warning-ink">
            Anomalies
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-warning-ink">
            {day.anomalies.map((a) => (
              <li key={a}>
                {isBlockingAnomaly(a) ? '⛔' : '⚠️'} {ANOMALY_LABEL[a] ?? a}
                {!isBlockingAnomaly(a) && (
                  <span className="ml-1 text-xs text-warning-ink">
                    — advisory, does not block sign-off
                  </span>
                )}
              </li>
            ))}
          </ul>
          {/* ⚠️ This used to read "a day with an unresolved anomaly cannot be verified" for EVERY
              anomaly, which was already untrue for `start_not_allowed` — advisory by design,
              because on a stale grid it fires on a large share of sessions and blocking would hold
              a store's pay for a data-entry problem (DEF-087). Prose claiming what the code does
              not do is the exact class this project keeps filing defects about, so the line now
              renders only when something actually blocks. */}
          {day.anomalies.some((a) => isBlockingAnomaly(a)) && (
            <p className="mt-2 text-xs text-warning-ink">
              ⛔ The blocking items above must be settled before this day can be verified — a
              sign-off that ignores them records an approval nobody actually made.
            </p>
          )}

          {/* ⭐ T-225 §4, Ian's decision 2026-09-06. The flag is only useful if it says what to DO,
              and the two available actions pay differently — so naming the wrong one is a real cost,
              not a wording preference. Approving the pending overtime credits the time actually
              worked; overriding the half day pays a FULL day for a shift that was short, which is
              what v1 did and why it over-paid relative to presence in 58 of 346 sessions. */}
          {day.anomalies.includes('half_day_near_full') && (
            <p className="mt-3 rounded bg-warning-soft p-2 text-xs text-warning-ink">
              <strong>If the undertime was permitted, approve the pending overtime</strong> — that
              credits the hours actually worked. ⛔ Do <strong>not</strong> override the half day to
              a full one: permission excuses the absence, it does not pay for the missing time.
            </p>
          )}
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
    <CheckedForm rules={ATTENDANCE_OVERTIME_RULES} action={approveOvertimeAction} className={`${CARD} space-y-2`}>
      <Ident day={day} />
      <h3 className="text-sm font-medium">
        Overtime — {asHours(day.pendingOtMinutes)} recorded
        {day.approvedOtMinutes !== null && (
          <span className="ml-2 text-xs font-normal text-success">
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
        <Field label="Minutes to pay" rule={ATTENDANCE_OVERTIME_RULES.approvedOtMinutes} className="basis-40 flex-1">
          <Input {...nativeAttrs(ATTENDANCE_OVERTIME_RULES.approvedOtMinutes)} defaultValue={day.approvedOtMinutes ?? day.pendingOtMinutes} className="w-full" />
        </Field>
        <Button type="submit" variant="primary" disabled={locked}>
          Decide
        </Button>
      </div>
    </CheckedForm>
  );
}

function StartAnchor({ day, locked }: { day: Day; locked: boolean }) {
  return (
    <CheckedForm rules={ATTENDANCE_START_ANCHOR_RULES} action={setStartAnchorAction} className={`${CARD} space-y-2`}>
      <Ident day={day} />
      <h3 className="text-sm font-medium">
        Paid from
        {day.hasStartAnchor && (
          <span className="ml-2 text-xs font-normal text-success">
            ✅ decided
          </span>
        )}
      </h3>
      <p className="text-xs text-neutral-500">
        Currently {asClock(day.anchorMinute)} ({day.anchorMode}). ⚠️ This sets the start the day is
        PAID from. The tap itself does not move.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Minute of shift day" rule={ATTENDANCE_START_ANCHOR_RULES.chosenAnchorMinute} className="basis-40 flex-1">
          <Input {...nativeAttrs(ATTENDANCE_START_ANCHOR_RULES.chosenAnchorMinute)} defaultValue={day.anchorMinute ?? 0} className="w-full" />
        </Field>
        <Button type="submit" variant="secondary" disabled={locked}>
          Save
        </Button>
      </div>
    </CheckedForm>
  );
}

function EarlyOut({ day, locked }: { day: Day; locked: boolean }) {
  return (
    <CheckedForm rules={ATTENDANCE_EARLY_OUT_RULES} action={approveEarlyOutAction} className={`${CARD} space-y-2`}>
      <Ident day={day} />
      <h3 className="text-sm font-medium">
        Paid until
        {day.hasEarlyOut && (
          <span className="ml-2 text-xs font-normal text-success">
            ✅ decided
          </span>
        )}
      </h3>
      <p className="text-xs text-neutral-500">
        Currently {asClock(day.endMinute)}. Approving an early out pays to the scheduled end rather
        than to the actual tap.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Minute of shift day" rule={ATTENDANCE_EARLY_OUT_RULES.effectiveOutMinute} className="basis-40 flex-1">
          <Input {...nativeAttrs(ATTENDANCE_EARLY_OUT_RULES.effectiveOutMinute)} defaultValue={day.endMinute ?? 0} className="w-full" />
        </Field>
        <Button type="submit" variant="secondary" disabled={locked}>
          Approve
        </Button>
      </div>
    </CheckedForm>
  );
}

function HalfDay({ day, locked }: { day: Day; locked: boolean }) {
  return (
    <FormDisclosure><form action={overrideHalfDayAction} className={`${CARD} space-y-2`}>
      <Ident day={day} />
      <h3 className="text-sm font-medium">
        Half day
        {day.hasHalfDayOverride && (
          <span className="ml-2 text-xs font-normal text-success">
            ✅ overridden
          </span>
        )}
      </h3>
      <p className="text-xs text-neutral-500">
        Currently <strong>{day.isHalfDay ? 'yes' : 'no'}</strong>. A half day pays half the daily
        rate, never the hours covered.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          Set to
          <Select name="isHalfDay" defaultValue={String(day.isHalfDay)} className="w-full">
            <option value="true">Half day</option>
            <option value="false">Full day</option>
          </Select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          Reason (required)
          <Input name="reason" className="w-full" placeholder="Why this override?" />
        </label>
        <Button type="submit" variant="secondary" disabled={locked}>
          Override
        </Button>
      </div>
    </form></FormDisclosure>
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
        <Button type="submit" variant="secondary" disabled={locked || day.status === 'verified'}>
          {day.status === 'verified' ? 'Verified' : 'Verify'}
        </Button>
      </form>

      <FormDisclosure><form action={voidDayAction} className="space-y-1 border-t border-surface-border pt-3">
        <Ident day={day} />
        <p className="text-xs text-neutral-500">
          ⛔ A voided day contributes nothing to payroll. The punches survive — the evidence outlives
          the decision.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
            Reason (required)
            <Input name="reason" className="w-full" placeholder="Duplicate tap, etc." />
          </label>
          {locked || day.status === 'voided' ? (
            <Button type="button" variant="secondary" disabled>
              {day.status === 'voided' ? 'Voided' : 'Void'}
            </Button>
          ) : (
            <ConfirmDestructive
              tier="admin-pin"
              label="Void day"
              consequence="Voids this day so it pays nothing in payroll. The punches stay. An administrator must approve with their own PIN."
            />
          )}
        </div>
      </form></FormDisclosure>
    </div>
  );
}
