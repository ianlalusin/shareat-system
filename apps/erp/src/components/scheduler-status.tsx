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
import { schedulerRepo, type SchedulerJob } from '@shareat/db';
import { withOrgPrincipal } from '../app/expenses/lib';

function monthsSince(date: Date): number {
  const now = new Date();
  return (
    (now.getUTCFullYear() - date.getUTCFullYear()) * 12 + (now.getUTCMonth() - date.getUTCMonth())
  );
}

export async function SchedulerStatus({
  orgId,
  job,
  label,
}: {
  orgId: string;
  job: SchedulerJob;
  label: string;
}) {
  const [last, unfinished] = await withOrgPrincipal(orgId, async (tx) => [
    await schedulerRepo.lastRunFor(tx, orgId, job),
    await schedulerRepo.unfinishedRuns(tx, orgId),
  ]);

  // ⛔ NEVER RUN AT ALL. The loudest state, and the one v1 was in for its entire life while its
  // seed data claimed a cron existed.
  if (!last) {
    return (
      <Box tone="alarm">
        <strong className="font-medium">{label} has never run.</strong> Nothing is posting it on a
        schedule. Until <code className="font-mono">npm run month-end</code> is on a timer, the
        charge only lands when somebody remembers to press a button — which is exactly how v1 lost
        two months without noticing.
      </Box>
    );
  }

  const stale = monthsSince(last.startedAt) >= 2;
  const stuck = unfinished.filter((r) => r.job === job);
  const when = last.startedAt.toISOString().slice(0, 10);

  if (stuck.length > 0) {
    // Started and never reported back — a killed process. Invisible without a row written BEFORE
    // the work, which is why `startRun` writes one.
    return (
      <Box tone="alarm">
        <strong className="font-medium">A {label.toLowerCase()} run started and never finished.</strong>{' '}
        Began {stuck[0]!.startedAt.toISOString().slice(0, 16).replace('T', ' ')} for{' '}
        {stuck[0]!.period}. The process was probably killed. Re-running is safe.
      </Box>
    );
  }

  if (last.outcome !== 'ok') {
    return (
      <Box tone="alarm">
        <strong className="font-medium">
          The last {label.toLowerCase()} run ({last.period}, {when}) did not complete cleanly.
        </strong>{' '}
        {last.postedCount} posted, {last.failedCount} failed.
        {last.error && <div className="mt-1">{last.error}</div>}
        {/* ⚠️ Verbatim, on the page. The likeliest reason is mundane — "no fiscal period covers
            2026-06-30" — and it is only actionable if somebody can read it. */}
        {last.failures && last.failures.length > 0 && (
          <ul className="mt-2 space-y-1">
            {last.failures.map((f) => (
              <li key={f.subjectId} className="text-xs">
                ⛔ <strong>{f.subjectName}</strong>: {f.reason}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 text-xs">
          Nothing was rolled back — each item posts in its own transaction, so re-running picks up
          whatever is fixed.
        </div>
      </Box>
    );
  }

  if (stale) {
    return (
      <Box tone="alarm">
        <strong className="font-medium">
          {label} last ran {when}, for {last.period}.
        </strong>{' '}
        That is more than a month ago. The schedule may have stopped.
      </Box>
    );
  }

  return (
    <p className="text-xs text-neutral-400 dark:text-neutral-600">
      {label} last ran <strong className="font-medium">{when}</strong> for {last.period} ·{' '}
      {last.postedCount} posted, {last.skippedCount} already done, no failures · {last.trigger}
    </p>
  );
}

function Box({ tone, children }: { tone: 'alarm'; children: React.ReactNode }) {
  return (
    <div
      className={
        tone === 'alarm'
          ? 'rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300'
          : ''
      }
    >
      {children}
    </div>
  );
}
