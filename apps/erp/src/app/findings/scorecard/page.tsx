import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import { scorecardFor, scorecardRange } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Responsiveness scorecard — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-214 — the manager responsiveness scorecard.
 *
 * ⭐ **It scores what was FIXED, never what was accepted, and that is the whole design.** v1 scored
 * findings a manager marked *resolved*. In v2 a finding cannot be resolved while it is still true —
 * only fixed, or **acknowledged**, which means the condition still holds and the risk is accepted
 * for 30 days. Scoring acknowledgements would pay a manager to accept risk and would be maximised
 * by accepting everything having fixed nothing: exactly the gaming T-135's derived model closed off.
 *
 * A cleared occurrence needs honesty from nobody — the detector simply stopped returning the key.
 * ⚠️ It also has no actor, which is why the unit here is the STORE and not a person.
 */
export default async function ScorecardPage() {
  const { actor } = await requireSession('/findings/scorecard');
  const range = scorecardRange();
  const { card, storeName } = await scorecardFor(actor.orgId, range);

  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const num = (v: number | null) => (v == null ? '—' : String(v));

  return (
    <Page density="wide">
      <div>
        <Link href="/findings" className="text-sm underline underline-offset-2">
          ← Findings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Responsiveness scorecard</h1>
        <PageDescription>
          Findings raised between {range.from} and {range.to}, and how many of them stopped being
          true. A finding clears when the condition goes away — nobody can clear one by clicking.
        </PageDescription>
      </div>

      {/* ⛔ The disclosure is part of the deliverable, not a nicety. There is no backfill and there
          cannot be one: findings carry no clock, so anything older than this date is shown as
          starting then. A number that silently understates how long a problem has been ignored is
          worse than no number. */}
      <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
        {card.recordBeganOn ? (
          <>
            Ages are measured from <strong>{card.recordBeganOn}</strong>, when this record began.
            Findings older than that are shown as starting then; their true age is not recoverable.
          </>
        ) : (
          <>
            <strong>Nothing has been observed yet.</strong> The daily observation job has not run, so
            there is nothing to score. Until it runs, this page is empty because the clock has not
            started — not because everything is fine.
          </>
        )}
      </p>

      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {card.lastViewedBy ? (
          <>
            Findings last opened by <strong>{card.lastViewedBy}</strong>
            {card.lastViewedDaysAgo === 0 ? ' today' : ` ${card.lastViewedDaysAgo} day(s) ago`}.
          </>
        ) : (
          // ⚠️ The null is the useful answer, not a missing one.
          <strong>Nobody has ever opened the findings screen.</strong>
        )}
      </p>

      <section className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th className="p-3">Store</th>
              <th className="p-3 text-right">Raised</th>
              <th className="p-3 text-right">Cleared</th>
              <th className="p-3 text-right">Still open</th>
              <th className="p-3 text-right">Pending</th>
              <th className="p-3 text-right">Clear rate</th>
              <th className="p-3 text-right">Avg days</th>
              <th className="p-3 text-right">Score</th>
              <th className="p-3 text-right">Accepted</th>
            </tr>
          </thead>
          <tbody>
            {card.stores.map((s) => (
              <tr key={s.storeId ?? 'org'} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="p-3 font-medium">
                  {s.storeId == null ? (
                    // ⛔ Org-wide findings are their own row and never spread across stores — a
                    // trial balance belongs to no branch, and charging one for it would be a lie.
                    <span title="Findings that belong to no single branch">Organisation-wide</span>
                  ) : (
                    storeName.get(s.storeId) ?? s.storeId
                  )}
                </td>
                <td className="p-3 text-right tabular-nums">{s.raised}</td>
                <td className="p-3 text-right tabular-nums">{s.cleared}</td>
                <td className="p-3 text-right tabular-nums">{s.stillOpen}</td>
                <td
                  className="p-3 text-right tabular-nums text-neutral-500"
                  title="Raised too recently to judge — not counted for or against"
                >
                  {s.pending === 0 ? '—' : s.pending}
                </td>
                <td className="p-3 text-right tabular-nums">{pct(s.clearRate)}</td>
                <td className="p-3 text-right tabular-nums">{num(s.avgDaysToClear)}</td>
                <td className="p-3 text-right tabular-nums font-medium">
                  {/* ⚠️ Null, never 0. Zero says "responded badly"; a dash says "nothing to judge". */}
                  {s.score == null ? (
                    <span className="text-neutral-400" title="Nothing cleared or raised — nothing to judge">
                      —
                    </span>
                  ) : (
                    s.score
                  )}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {s.acknowledged === 0 ? (
                    '—'
                  ) : (
                    <span
                      className={s.oldestAcknowledgementDays != null && s.oldestAcknowledgementDays > 21 ? 'text-amber-600' : ''}
                      title="Accepted, not fixed — the condition still holds"
                    >
                      {s.acknowledged}
                      {s.oldestAcknowledgementDays != null && ` · ${s.oldestAcknowledgementDays}d`}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {card.stores.length === 0 && (
              <tr>
                <td className="p-4 text-neutral-500" colSpan={9}>
                  No findings were raised in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <div className="space-y-2 rounded-lg border border-neutral-200 p-4 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        <p>
          <strong>Score</strong> weights clear rate at 57% and speed at 43% — v1&rsquo;s own 0.4/0.3
          ratio, normalised over the two components that survive. v1&rsquo;s third component was
          &ldquo;did you open the AI briefing&rdquo;, and there is no briefing here, so it is dropped
          rather than carried as a permanently-zero term.
        </p>
        <p>
          <strong>Speed</strong> scores against a 14-day horizon: cleared the same day scores 1,
          cleared in 14 days or more scores 0.
        </p>
        <p>
          ⭐ <strong>Pending findings are not judged.</strong> A finding raised in the last 14 days
          has not been ignored — it has not had a chance yet — so it counts neither for nor against.
          The clear rate answers &ldquo;of the findings that have had a fair chance, how many were
          cleared?&rdquo;, and a store whose findings are all still pending scores a dash, not a
          zero.
        </p>
        <p>
          ⚠️ <strong>Accepted is reported, never scored.</strong> Acknowledging a finding means the
          condition still holds and the risk is accepted for now. Counting it as a win would pay
          people to accept problems instead of fixing them. The age beside it is the point — an
          ageing acceptance is a smell.
        </p>
      </div>
    </Page>
  );
}
