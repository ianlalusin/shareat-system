import { toBusinessDate } from '@shareat/core/datetime';
import Link from 'next/link';
import { requireSession } from '../../lib/session';
import {
  REVIEW_REASON_TEXT,
  asHours,
  defaultRange,
  listStores,
  loadQueue,
  loadRoster,
} from './lib';
import type { QueuedDay, ReviewDayRow } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Attendance review — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  from?: string;
  to?: string;
}

/*
  ⭐ **THIS SCREEN IS THE FIX FOR DEF-113 — and it was promised four times under a number that no
  longer means it.**

  T-154, T-156, T-157 and T-158 all name "T-166" as the review screen. The inventory lane shipped
  T-166 as *Deliveries and receiving*. The screen was not descoped — it was overwritten, and the
  consequence went unnoticed for a month: `recordAdjustment` shipped with six adjustment kinds,
  fully tested, and NO CALLER outside tests.

  What that cost, all of it live until today:
    · overtime could never be approved, so `pendingOtMinutes` could never become money
    · a `needs_review` day could never be resolved — and `payableDays` excludes it while
      `resolveStatus` refuses to promote it, so NOTHING would ever pay that day
    · no day could be verified or voided (DEF-115, found building this)
    · `/payroll` told managers to "approve it on the attendance day", and there was no such page

  ⚠️ THE QUEUE SITS ABOVE THE ROSTER, deliberately — the same reasoning as `/attendance/lane`.
  A manager who only ever sees every day cannot tell which ones are waiting on them, and "waiting
  on a human" is the entire question this screen exists to answer.
*/
export default async function AttendanceReviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/attendance');

  const stores = await listStores(actor.orgId);
  const storeId = sp.store || stores[0]?.id;
  if (!storeId) {
    return (
      <Page density="table" className="space-y-4">
        <h1 className="text-2xl font-semibold">Attendance review</h1>
        <PageDescription>No store is set up yet.</PageDescription>
      </Page>
    );
  }

  const today = toBusinessDate();
  const fallback = await defaultRange(actor.orgId, storeId, today);
  const from = sp.from || fallback.from;
  const to = sp.to || fallback.to;

  const [queued, roster] = await Promise.all([
    loadQueue(actor.orgId, actor, { storeId, from, to }),
    loadRoster(actor.orgId, actor, { storeId, from, to }),
  ]);

  const FIELD =
    'rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900';

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Attendance review</h1>
        <PageDescription>
          The days waiting on a decision, and every day in the period. ⭐ A correction is recorded
          <strong> beside </strong>the punches, never in place of them — the original tap is a
          label, and it is never rewritten.
        </PageDescription>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          Store
          <select name="store" defaultValue={storeId} className={`${FIELD} w-full`}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          From
          <input name="from" type="date" defaultValue={from} className={`${FIELD} w-full`} />
        </label>
        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-xs uppercase tracking-wide text-neutral-500">
          to
          <input name="to" type="date" defaultValue={to} className={`${FIELD} w-full`} />
        </label>
        <button
          type="submit"
          className="rounded border border-neutral-300 px-4 py-1.5 text-sm font-medium dark:border-neutral-700"
        >
          Show
        </button>
      </form>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Waiting on you{' '}
          <span className="text-sm font-normal text-neutral-500">({queued.length})</span>
        </h2>

        {queued.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            ⭐ Nothing is waiting on a decision in this period.
          </p>
        ) : (
          <ul className="space-y-2">
            {queued.map((d) => (
              <QueueRow key={d.id} day={d} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Every day in the period{' '}
          <span className="text-sm font-normal text-neutral-500">({roster.length})</span>
        </h2>
        {roster.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No attendance days in this range.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="py-2 pr-4">Day</th>
                  <th className="pr-4">Person</th>
                  <th className="pr-4 text-right">Paid</th>
                  <th className="pr-6 text-right">Overtime</th>
                  <th className="pr-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((d) => (
                  <RosterRow key={d.id} day={d} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Page>
  );
}

/** ⚠️ Every row says WHY it is here. A queue you cannot interpret is `needs_review` all over again. */
function QueueRow({ day }: { day: QueuedDay }) {
  return (
    <li className="rounded border border-amber-300 p-3 dark:border-amber-800">
      <Link href={`/attendance/${day.id}`} className="block space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium">
            {day.personName} · {day.shiftDay}
          </span>
          <span className="text-xs text-neutral-500">
            {asHours(day.computedMinutes)} paid
            {day.pendingOtMinutes > 0 ? ` · ${asHours(day.pendingOtMinutes)} overtime` : ''}
          </span>
        </div>
        {day.reasons.map((r) => (
          <p key={r} className="text-xs text-amber-900 dark:text-amber-300">
            ⚠️ {REVIEW_REASON_TEXT[r]}
          </p>
        ))}
      </Link>
    </li>
  );
}

function RosterRow({ day }: { day: ReviewDayRow }) {
  return (
    <tr className="border-t border-neutral-200 dark:border-neutral-800">
      <td className="py-2 pr-4">
        <Link href={`/attendance/${day.id}`} className="underline underline-offset-2">
          {day.shiftDay}
        </Link>
      </td>
      <td className="pr-4">{day.personName}</td>
      <td className="pr-4 text-right tabular-nums">
        {asHours(day.computedMinutes)}
        {day.isHalfDay ? ' ½' : ''}
      </td>
      <td className="pr-6 text-right tabular-nums">
        {day.pendingOtMinutes === 0
          ? '—'
          : day.approvedOtMinutes === null
            ? `${asHours(day.pendingOtMinutes)} pending`
            : `${asHours(day.approvedOtMinutes)} approved`}
      </td>
      <td className="pr-2">
        {day.status}
        {day.frozenAt ? ' · frozen' : ''}
      </td>
    </tr>
  );
}
