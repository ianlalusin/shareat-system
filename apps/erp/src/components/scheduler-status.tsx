/**
 * "Is anybody keeping these books?" — the month-end run's health, on the page. T-140, DEF-044.
 *
 * ## ⭐ Why this component exists
 *
 * v1's depreciation stopped for two months and **nothing on any screen changed**, because the only
 * evidence of a run was the postings it made — and a run that posts nothing looks exactly like a
 * run that never happened. It was found by an audit.
 *
 * So this reads `scheduler_runs`, not the ledger. The single most valuable thing here is not the
 * counts; it is **the date of the last attempt**.
 *
 * ⚠️ It renders even when everything is fine, and says so plainly. A banner that only ever appears
 * on failure trains people to read a blank page as healthy — and a blank page is exactly what a
 * dead scheduler produces.
 */
import { formatBusinessDateTime, toBusinessDate } from '@shareat/core/datetime';
import { schedulerRepo, type SchedulerJob } from '@shareat/db';
import { listStores, withOrgPrincipal } from '../app/expenses/lib';
import { containsIdentifier } from '../lib/error-shape';
import { Banner } from '@/components/ui/Banner';

/**
 * T-343 S4b — this screen has no session-scoped gate of its own (`SchedulerStatus` is embedded
 * wherever a page already decided who may see it), so `last.error`/`f.subjectName`/`f.reason` are
 * UNTRUSTED for the same reason a raw driver message is (S1): whatever a job happened to interpolate
 * into a stored diagnostic reaches this render verbatim otherwise. `containsIdentifier` (S1,
 * `../lib/error-shape`) is the one shared UUID test; a detail-shaped field degrades to a pointer at
 * the server log, a label degrades to a generic one — never a raw id on screen.
 */
function redactDetail(text: string): string {
  return containsIdentifier(text) ? '(detail in the server log)' : text;
}
function redactSubject(subjectName: string): string {
  return containsIdentifier(subjectName) ? 'an item from an earlier run' : subjectName;
}

function monthsSince(date: Date): number {
  const [ny, nm] = toBusinessDate().split('-').map(Number) as [number, number];
  const [dy, dm] = toBusinessDate(date).split('-').map(Number) as [number, number];
  return (ny - dy) * 12 + (nm - dm);
}

/** The command that runs each job by hand, named on the never-run banner. */
const JOB_COMMAND: Partial<Record<SchedulerJob, string>> = { pos_day_import: 'npm run pos-day-import' };

const DAILY_STALE_MS = 26 * 3_600_000;

export async function SchedulerStatus({
  orgId,
  job,
  label,
  cadence = 'monthly',
  visibleSubjectIds,
}: {
  orgId: string;
  job: SchedulerJob;
  label: string;
  /** `monthly` (default): stale after 2 calendar months. `daily`: stale after 26 h (T-396 S2). */
  cadence?: 'daily' | 'monthly';
  /** When given, only lines whose `subjectId` is in this list are shown (per-store visibility, T-396 S2). */
  visibleSubjectIds?: readonly string[];
}) {
  const [last, unfinished] = await withOrgPrincipal(orgId, async (tx) => [
    await schedulerRepo.lastRunFor(tx, orgId, job),
    await schedulerRepo.unfinishedRuns(tx, orgId),
  ]);

  // ⛔ NEVER RUN AT ALL. The loudest state, and the one v1 was in for its entire life while its
  // seed data claimed a cron existed.
  if (!last) {
    if (cadence === 'daily') {
      return (
        <Banner tone="warning">
          <strong className="font-medium">The {label.toLowerCase()} has never run.</strong> Nothing is drafting
          the stores&apos; days on a schedule. Until the timer is armed, or someone runs{' '}
          <code className="font-mono">{JOB_COMMAND[job] ?? job}</code> by hand, days are only typed in.
        </Banner>
      );
    }
    return (
      <Banner tone="warning">
        <strong className="font-medium">{label} has never run.</strong> Nothing is posting it on a
        schedule. Until <code className="font-mono">npm run month-end</code> is on a timer, the
        charge only lands when somebody remembers to press a button — which is exactly how v1 lost
        two months without noticing.
      </Banner>
    );
  }

  const stale =
    cadence === 'daily' ? Date.now() - last.startedAt.getTime() > DAILY_STALE_MS : monthsSince(last.startedAt) >= 2;
  const stuck = unfinished.filter((r) => r.job === job);
  const when = toBusinessDate(last.startedAt);

  if (stuck.length > 0) {
    // Started and never reported back — a killed process. Invisible without a row written BEFORE
    // the work, which is why `startRun` writes one.
    return (
      <Banner tone="warning">
        <strong className="font-medium">A {label.toLowerCase()} run started and never finished.</strong>{' '}
        Began {toBusinessDate(stuck[0]!.startedAt)} {formatBusinessDateTime(stuck[0]!.startedAt, { hour: '2-digit', minute: '2-digit', hour12: false })} for{' '}
        {stuck[0]!.period}. The process was probably killed. Re-running is safe.
      </Banner>
    );
  }

  // A viewer who cannot see every store gets the run-level text (error, all-store counts) only as a generic line: it can name
  // another store. A viewer who sees all of the org's stores gets it whole.
  const orgWide = !visibleSubjectIds || (await listStores(orgId)).every((st) => visibleSubjectIds.includes(st.id));

  // T-368: a `kind: 'notice'` entry is said, not failed - it never renders as a failure.
  const shown = (last.failures ?? []).filter((f) => !visibleSubjectIds || visibleSubjectIds.includes(f.subjectId));
  const failureRows = shown.filter((f) => f.kind !== 'notice');
  const notices = shown.filter((f) => f.kind === 'notice');

  if (last.outcome !== 'ok') {
    return (
      <Banner tone="warning">
        <strong className="font-medium">
          The last {label.toLowerCase()} run ({last.period}, {when}) did not complete cleanly.
        </strong>{' '}
        {!orgWide ? (
          <div className="mt-1">The last morning import had problems at stores you don&apos;t manage.</div>
        ) : (
          <>
            {last.postedCount} posted, {last.failedCount} failed.
            {last.error && <div className="mt-1">{redactDetail(last.error)}</div>}
          </>
        )}
        {/* ⚠️ Verbatim WHEN id-free, on the page. The likeliest reason is mundane — "no fiscal
            period covers 2026-06-30" — and it is only actionable if somebody can read it; an
            id-bearing one is redacted above (`redactSubject`/`redactDetail`, T-343 S4b). */}
        {failureRows.length > 0 && (
          <ul className="mt-2 space-y-1">
            {failureRows.map((f) => (
              <li key={f.subjectId} className="text-xs">
                ⛔ <strong>{redactSubject(f.subjectName)}</strong>: {redactDetail(f.reason)}
              </li>
            ))}
          </ul>
        )}
        {notices.map((n) => (
          <div key={n.subjectId} className="mt-2 text-xs">
            {redactDetail(n.reason)}
          </div>
        ))}
        <div className="mt-2 text-xs">
          Nothing was rolled back — each item posts in its own transaction, so re-running picks up
          whatever is fixed.
        </div>
      </Banner>
    );
  }

  if (stale) {
    return (
      <Banner tone="warning">
        <strong className="font-medium">
          {label} last ran {when}, for {last.period}.
        </strong>{' '}
        {cadence === 'daily'
          ? 'That is more than a day ago. The schedule may have stopped.'
          : 'That is more than a month ago. The schedule may have stopped.'}
      </Banner>
    );
  }

  return (
    <>
      <p className="text-xs text-neutral-400 dark:text-neutral-600">
        {label} last ran <strong className="font-medium">{when}</strong> for {last.period} ·{' '}
        {last.postedCount} posted, {last.skippedCount} already done, no failures · {last.trigger}
      </p>
      {notices.map((n) => (
        <p key={n.subjectId} className="text-xs text-neutral-500 dark:text-neutral-400">
          {redactDetail(n.reason)}
        </p>
      ))}
    </>
  );
}
