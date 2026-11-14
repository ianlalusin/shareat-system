import Link from 'next/link';
import { requireSession } from '../../lib/session';
import {
  acknowledgeFindingAction,
  bookMissedMonthAction,
  closePeriodAction,
  createMissingClosedPeriodAction,
} from './actions';
import {
  KIND_LABEL,
  bySeverityThenStatus,
  findingsFor,
  lastCompletedPeriod,
  noteFindingView,
  peso,
  selectablePeriods,
  withOrgPrincipal,
} from './lib';
import { classifyHoles, missedMonths, type ClassifiedHolePiece, type MissedMonthRow } from '@shareat/domain';
import { heldCapabilities } from '@shareat/auth';
// T-345 Amendment R3.4 — the Manila month, not UTC.
import { currentPeriod } from '../fixed-assets/lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { CheckedForm } from '@/components/forms';
import { Button, Field, FlashBanner, Input, Select } from '@/components/ui';
import { ChevronIcon } from '@/components/shell/icons';
import { FINDINGS_MISSED_MONTH_RULES, FINDINGS_MISSING_PERIOD_RULES, nativeAttrs } from '@shareat/domain/field-rules';

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
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/findings');

  const periods = selectablePeriods();
  const period = sp.period && periods.includes(sp.period) ? sp.period : lastCompletedPeriod();
  const { feed, readiness } = await findingsFor(actor.orgId, period);

  // T-344 / DEF-422 §3.6 — independent of the 12-month period selector above, so a hole older
  // than a year still shows. Through the same M+11 window the monthly seed job itself covers.
  const missingPeriodsThrough = monthsAheadThrough(new Date(), 11);
  const { pieces } = await withOrgPrincipal(actor.orgId, (tx) => classifyHoles(tx, actor.orgId, missingPeriodsThrough));
  const missingClosedPieces = pieces.filter((p) => p.class === 'B' || p.class === 'C');
  const held = await withOrgPrincipal(actor.orgId, (tx) => heldCapabilities(tx, actor));
  const canCreateMissingPeriod = held.has('create_missing_period');

  // T-345 §3.5 — the last COMPLETED month, same as the periodic-posting detectors themselves, and
  // independent of the 12-month period selector above (a hole can be older than a year).
  // ⚠️ Amendment R3.2 — asset/item NAMES and AMOUNTS are read only for a `book_missed_month`
  // holder; a non-holder never triggers this query at all, and sees only the plain refusal line.
  const canBookMissedMonth = held.has('book_missed_month');
  const missedMonthRows = canBookMissedMonth
    ? await withOrgPrincipal(actor.orgId, (tx) => missedMonths(tx, actor.orgId, lastCompletedPeriod()))
    : [];

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
        <PageDescription>
          Every question the books are asked, answered on this page load. There is no findings
          table — <strong>a finding cannot be resolved while it is still true</strong>, only fixed
          or accepted for now.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {/* ⚠️ The period matters: the periodic-posting detectors ask about a MONTH, and closing
          January means asking about January. Defaults to the last completed month. */}
      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Period</span>
          <Select name="period" defaultValue={period} className="w-full">
            {periods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary">
          Show
        </Button>
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

      {/* ⛔ `readiness.ready` here is a HINT, never the authority — `closePeriod` re-checks the
          capability, the unposted-draft gate, `closeReadiness` and the earlier-period-open rule
          itself, so a stale page or a second click cannot close a period that is not closeable. */}
      {readiness.ready && (
        <form action={closePeriodAction} className="flex items-center gap-3 rounded-lg border border-success bg-success-soft p-4">
          <input type="hidden" name="period" value={period} />
          <div className="flex-1 text-sm text-success">
            <span className="font-medium">{period} is ready to close.</span> This is a human
            decision, made once the remittance for the period has actually arrived — never
            scheduled.
          </div>
          <Button type="submit" variant="primary">
            Close {period}
          </Button>
        </form>
      )}

      {missingClosedPieces.length > 0 && (
        <MissingPeriodsSection
          pieces={missingClosedPieces}
          period={period}
          canCreate={canCreateMissingPeriod}
        />
      )}

      {(canBookMissedMonth ? missedMonthRows.length > 0 : true) && (
        <ScheduledChargesMissedSection
          rows={missedMonthRows}
          period={period}
          canBook={canBookMissedMonth}
        />
      )}

      {rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Nothing is wrong that this system knows how to ask about. ⚠️ That is not the same as
          nothing being wrong — it is the twelve questions above, answered.
        </p>
      )}

      {hard.length > 0 && (
        <FindingGroup
          title="The books do not add up"
          blurb="Each of these blocks the period close, and an acknowledgement does NOT lift that — accepting a risk is not the same as the books tying."
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
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</div>
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
  const border = tone === 'hard' ? 'border-danger' : 'border-warning';
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="max-w-2xl text-xs text-neutral-500 dark:text-neutral-500">{blurb}</p>
      </div>
      {rows.map((f) => (
        <details key={f.key} className={`group rounded-[20px] border bg-surface ${border}`}>
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{KIND_LABEL[f.kind] ?? f.kind}</span>
                <code className="text-xs text-muted">{f.kind}</code>
                {f.status === 'acknowledged' && (
                  <span className="rounded-full bg-canvas px-2 py-0.5 text-xs text-muted">
                    accepted {f.acknowledgementAgeDays ?? 0}d ago
                  </span>
                )}
              </span>
              <span className="mt-1 block truncate text-xs text-muted">{f.detail}</span>
            </span>
            <ChevronIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted transition group-open:rotate-180" />
          </summary>
          <div className="space-y-2 border-t border-surface-border p-4">
            <p className="text-sm">{f.detail}</p>
            {f.status === 'open' ? (
              <form action={acknowledgeFindingAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="findingKey" value={f.key} />
                <input type="hidden" name="period" value={period} />
                <Input
                  name="note"
                  placeholder="Why is this acceptable for now?"
                  className="w-full min-w-0 flex-1 basis-72"
                />
                <Button type="submit" variant="secondary">
                  Accept for now
                </Button>
              </form>
            ) : (
              <p className="text-xs text-muted">
                Accepted — it expires on its own, and it is still counted above. The only way it
                leaves this list is for the condition to stop being true.
              </p>
            )}
          </div>
        </details>
      ))}
    </section>
  );
}

/** The last day of the month `monthsAhead` months after `now`'s (UTC) month — the same M+11
 *  window the monthly fiscal-period seed job itself covers (T-344 §1). */
function monthsAheadThrough(now: Date, monthsAhead: number): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const idx = y * 12 + m + monthsAhead;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return new Date(Date.UTC(ny, nm, 0)).toISOString().slice(0, 10);
}

/**
 * T-344 / DEF-422 §3.6 — "Months missing inside closed books". Rendered from `classifyHoles`
 * classes B and C directly, NOT from the 12-month period selector above, so a hole older than a
 * year still appears. The button renders only for an actor holding `create_missing_period`;
 * anyone else sees why it is missing, never a disabled control that looks broken.
 */
function MissingPeriodsSection({
  pieces,
  period,
  canCreate,
}: {
  pieces: ClassifiedHolePiece[];
  period: string;
  canCreate: boolean;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-warning bg-warning-soft p-4">
      <div>
        <h2 className="text-sm font-medium">Months missing inside closed books</h2>
        <p className="max-w-2xl text-xs text-neutral-600 dark:text-neutral-400">
          The monthly coverage job never fills these — it would reopen closed books. An
          administrator can create each one explicitly, with a reason.
        </p>
      </div>
      {pieces.map((p) => {
        const label = p.whole ? p.yearMonth : `${p.startsOn} to ${p.endsOn} (part of ${p.yearMonth})`;
        return (
          <details key={`${p.startsOn}-${p.endsOn}`} className="group rounded-[20px] border border-warning bg-surface">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
              <span>
                <span className="font-medium">{label}</span>
                <span className="ml-2 text-muted">will be created as {p.targetStatus}</span>
              </span>
              <ChevronIcon className="h-4 w-4 shrink-0 text-muted transition group-open:rotate-180" />
            </summary>
            <div className="border-t border-warning/40 p-3">
              {canCreate ? (
                <CheckedForm rules={FINDINGS_MISSING_PERIOD_RULES} action={createMissingClosedPeriodAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="period" value={period} />
                  <input type="hidden" name="startsOn" value={p.startsOn} />
                  <input type="hidden" name="endsOn" value={p.endsOn} />
                  <Field label="Reason" rule={FINDINGS_MISSING_PERIOD_RULES.reason} className="w-full flex-1 basis-72">
                    <Input {...nativeAttrs(FINDINGS_MISSING_PERIOD_RULES.reason)} placeholder="Why is this being created now?" className="w-full min-w-0" />
                  </Field>
                  <Button type="submit" variant="secondary">
                    Create the missing month
                  </Button>
                </CheckedForm>
              ) : (
                <p className="text-xs text-muted">Only an administrator can create a missing month.</p>
              )}
            </div>
          </details>
        );
      })}
    </section>
  );
}

/**
 * T-345 §3.5 — beside "Months missing inside closed books": a scheduled charge that could not post
 * in its own month, with the amount the schedule says and a required reason. The button renders
 * only for an actor holding `book_missed_month`; anyone else sees why it is missing, never a
 * disabled control that looks broken.
 */
function ScheduledChargesMissedSection({
  rows,
  period,
  canBook,
}: {
  rows: MissedMonthRow[];
  period: string;
  canBook: boolean;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-warning bg-warning-soft p-4">
      <div>
        <h2 className="text-sm font-medium">Scheduled charges missed in closed months</h2>
        <p className="max-w-2xl text-xs text-neutral-600 dark:text-neutral-400">
          A depreciation or amortisation charge that could not post in its own month. An
          administrator can book it once, in the current open month, for the amount the schedule
          says — never typed.
        </p>
      </div>
      {/* ⚠️ Amendment R3.2 — a non-holder sees only this line, never a name or an amount. The
          caller already skips the `missedMonths` read entirely for them; `rows` is empty here too,
          but the branch is on `canBook`, not on row count, so the disclosure holds either way. */}
      {!canBook ? (
        <p className="text-xs text-neutral-500">Only an administrator can book a missed month.</p>
      ) : (
        rows.map((r) => (
          <details
            key={`${r.schedule}-${r.subjectId}-${r.belongsToPeriod}`}
            className="group rounded-[20px] border border-warning bg-surface"
          >
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
              <span className="min-w-0">
                <span className="font-medium">{r.subjectName}</span>
                <span className="ml-2 text-muted">
                  {r.belongsToPeriod} · {peso(Number(r.amount))}
                </span>
              </span>
              <ChevronIcon className="h-4 w-4 shrink-0 text-muted transition group-open:rotate-180" />
            </summary>
            <div className="border-t border-warning/40 p-3">
              <p className="mb-2 text-xs text-muted">
                Will be booked in {currentPeriod()}.
              </p>
              <CheckedForm rules={FINDINGS_MISSED_MONTH_RULES} action={bookMissedMonthAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="period" value={period} />
                <input type="hidden" name="schedule" value={r.schedule} />
                <input type="hidden" name="subjectId" value={r.subjectId} />
                <input type="hidden" name="belongsToPeriod" value={r.belongsToPeriod} />
                <Field label="Reason" rule={FINDINGS_MISSED_MONTH_RULES.reason} className="w-full flex-1 basis-72">
                  <Input {...nativeAttrs(FINDINGS_MISSED_MONTH_RULES.reason)} placeholder="Why is this being booked now?" className="w-full min-w-0" />
                </Field>
                <Button type="submit" variant="secondary">
                  Book it
                </Button>
              </CheckedForm>
            </div>
          </details>
        ))
      )}
    </section>
  );
}
