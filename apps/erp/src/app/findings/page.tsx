import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { acknowledgeFindingAction } from './actions';
import {
  KIND_LABEL,
  bySeverityThenStatus,
  findingsFor,
  lastCompletedPeriod,
  noteFindingView,
  selectablePeriods,
} from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Findings — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  period?: string;
  error?: string;
  ok?: string;
}

export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/findings');

  const periods = selectablePeriods();
  const period = sp.period && periods.includes(sp.period) ? sp.period : lastCompletedPeriod();
  const { feed, readiness } = await findingsFor(actor.orgId, period);

  // ⭐ T-214 — record that a human actually looked. ⚠️ Deliberately AFTER the read and outside its
  // transaction, and it swallows its own failure: the log is accountability, the page is the work.
  await noteFindingView(actor.orgId, actor.personId);

  const rows = [...feed.findings].sort(bySeverityThenStatus);
  const hard = rows.filter((f) => f.severity === 'hard');
  const soft = rows.filter((f) => f.severity === 'soft');

  return (
    <Page density="table">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold">Findings</h1>
          {/* ⚠️ Linked, not orphaned. DEF-139 and DEF-181 were both screens reachable only by
              typing the URL — a link is part of shipping. */}
          <Link href="/findings/scorecard" className="text-sm underline underline-offset-2">
            Responsiveness scorecard →
          </Link>
        </div>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          Every question the books are asked, answered on this page load. There is no findings
          table — <strong>a finding cannot be resolved while it is still true</strong>, only fixed
          or accepted for now.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {sp.ok}
        </div>
      )}

      {/* ⚠️ The period matters: the periodic-posting detectors ask about a MONTH, and closing
          January means asking about January. Defaults to the last completed month. */}
      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Period</span>
          <select name="period" defaultValue={period} className={`${INPUT} w-40`}>
            {periods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Show
        </button>
      </form>

      {/* ⭐ acknowledgedCount is shown on purpose. An acknowledged finding is STILL COUNTED —
          that is the whole difference from "resolved", and a screen showing only the open count
          would quietly restore the v1 behaviour this feature was built to kill. */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Open" value={String(feed.openCount)} hint="Nobody has accepted these" />
        <Tile
          label="Accepted for now"
          value={String(feed.acknowledgedCount)}
          hint="Still counted, still ageing"
        />
        <Tile
          label="Blocking a close"
          value={String(feed.hardCount)}
          hint="The books do not add up"
        />
        <Tile
          label={`${period} close`}
          value={readiness.ready ? 'Ready' : 'Blocked'}
          hint={
            readiness.ready
              ? 'No hard finding stands'
              : `${readiness.blocking.length} hard finding(s)`
          }
        />
      </section>

      {rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Nothing is wrong that this system knows how to ask about. ⚠️ That is not the same as
          nothing being wrong — it is the twelve questions above, answered.
        </p>
      )}

      {hard.length > 0 && (
        <FindingGroup
          title="The books do not add up"
          blurb="⛔ Each of these blocks the period close, and an acknowledgement does NOT lift that — accepting a risk is not the same as the books tying."
          rows={hard}
          period={period}
          tone="hard"
        />
      )}

      {soft.length > 0 && (
        <FindingGroup
          title="Something is overdue or adrift"
          blurb="These do not block a close. The ledger is right; something in the business is behind."
          rows={soft}
          period={period}
          tone="soft"
        />
      )}
    </Page>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="font-mono text-2xl tabular-nums">{value}</div>
      <div className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</div>
    </div>
  );
}

function FindingGroup({
  title,
  blurb,
  rows,
  period,
  tone,
}: {
  title: string;
  blurb: string;
  rows: Awaited<ReturnType<typeof findingsFor>>['feed']['findings'];
  period: string;
  tone: 'hard' | 'soft';
}) {
  const border = tone === 'hard' ? 'border-red-300 dark:border-red-800' : 'border-amber-300 dark:border-amber-800';
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="max-w-2xl text-xs text-neutral-500 dark:text-neutral-500">{blurb}</p>
      </div>
      {rows.map((f) => (
        <div key={f.key} className={`space-y-2 rounded-lg border p-4 ${border}`}>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium">{KIND_LABEL[f.kind] ?? f.kind}</span>
            {/* ⚠️ The KIND stays visible beside the label: a label can drift, a kind is the key. */}
            <code className="text-xs text-neutral-500">{f.kind}</code>
            {f.status === 'acknowledged' && (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
                {/* ⭐ Age is the point — an ageing acceptance is a smell. */}
                accepted {f.acknowledgementAgeDays ?? 0}d ago
              </span>
            )}
          </div>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{f.detail}</p>

          {f.status === 'open' ? (
            <form action={acknowledgeFindingAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="findingKey" value={f.key} />
              <input type="hidden" name="period" value={period} />
              <input
                name="note"
                placeholder="Why is this acceptable for now?"
                className={`${INPUT} w-72`}
              />
              <button
                type="submit"
                className="rounded border border-neutral-300 px-3 py-2 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Accept for now
              </button>
            </form>
          ) : (
            <p className="text-xs text-neutral-500">
              Accepted — it expires on its own, and it is still counted above. ⛔ The only way it
              leaves this list is for the condition to stop being true.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
