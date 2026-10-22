import Link from 'next/link';
import type { LaneHealthReport, QuarantineView } from '@shareat/domain';
import { LANE_HEALTH } from '@shareat/domain';
import { requireSession } from '../../../lib/session';
import { discardEventAction, retryEventAction } from './actions';
import { ago, listStores, loadHealth, loadQuarantine, rawJson, when } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, Field, FlashBanner, Input, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { ATTENDANCE_DISCARD_RULES, nativeAttrs } from '@shareat/domain/field-rules';

export const metadata = { title: 'The clock lane — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  notice?: string;
}

/*
  ⭐ THIS SCREEN IS THE FIX FOR LANDMINE #14.

  It is the only landmine in bible §12 whose structural fix is a *screen*. v1's entire recovery path
  is `OfflineBanner.tsx:33` telling staff "N failed — tell a manager", and discovery 05 §6 confirms
  there is nothing for the manager to then open:

    "no admin/manager UI was found anywhere in the app that reads dead-lettered punches out of a
     device's IndexedDB, inspects them, or lets a manager manually re-file the underlying attendance
     session. Recovery today appears to be entirely informal."

  A quarantine nobody can read is a dead letter with better manners.

  ⚠️ HEALTH SITS ABOVE THE LIST, deliberately. A manager who only ever sees a list of failures
  cannot tell a bad hour from a broken week — three stuck events on a Tuesday is noise; three stuck
  events while the outbox has not moved since breakfast is an outage, and the same list is shown in
  both cases.
*/
export default async function LanePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/attendance/lane');

  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">The clock lane</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          There are no stores yet, so there is no lane to watch.
        </p>
      </Page>
    );
  }

  const [health, quarantine] = await Promise.all([
    loadHealth(actor, storeId),
    loadQuarantine(actor, storeId),
  ]);
  const now = health.observedAt;

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">The clock lane</h1>
        <PageDescription>
          Whether the terminals are talking to us, and what did not make it through. Every event
          here is recoverable — nothing is ever dropped.
        </PageDescription>
      </div>

      {/* ── Store picker. A GET form, so the URL stays shareable. ────────────────────── */}
      {stores.length > 1 && (
        <FilterRow>
          <label htmlFor="store" className="text-sm text-neutral-600 dark:text-neutral-400">
            Store
          </label>
          <Select id="store" name="store" defaultValue={storeId}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </FilterRow>
      )}

      <FlashBanner flash={sp} />

      <HealthPanel health={health} now={now} />

      {/* ── What is stuck ───────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Stuck events{' '}
          <span className="font-mono tabular-nums text-neutral-500">({quarantine.open.length})</span>
        </h2>

        {quarantine.open.length === 0 ? (
          <p className="rounded-lg border border-surface-border p-4 text-sm text-neutral-600">
            Nothing is stuck at this store.{' '}
            {health.healedRecently > 0 && (
              <>
                <span className="font-mono tabular-nums">{health.healedRecently}</span> event
                {health.healedRecently === 1 ? '' : 's'} came back on their own this week.
              </>
            )}
          </p>
        ) : (
          quarantine.open.map((row) => (
            <StuckEvent key={row.id} row={row} storeId={storeId} now={now} />
          ))
        )}
      </section>

      {/* ── Events that name no store at all ────────────────────────────────────────── */}
      {quarantine.unattributed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Events that name no store{' '}
            <span className="font-mono tabular-nums text-neutral-500">
              ({quarantine.unattributed.length})
            </span>
          </h2>
          {/* ⚠️ An unknown device or an unreadable body has no store to file it under — the
              ingestor could not resolve one, which is *why* it is here. These are org-wide, and
              only somebody trusted with the terminals can see them. */}
          <p className="text-xs text-neutral-500 dark:text-neutral-500">
            These came from a device we could not place, so they belong to no store. Org-wide.
          </p>
          {quarantine.unattributed.map((row) => (
            <StuckEvent key={row.id} row={row} storeId={storeId} now={now} />
          ))}
        </section>
      )}

      {/* ── The audit tail ──────────────────────────────────────────────────────────── */}
      {quarantine.resolved.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Recently resolved
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs text-neutral-500 dark:text-neutral-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Was stuck as</th>
                  <th className="py-2 pr-4 font-medium">Outcome</th>
                  <th className="py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {quarantine.resolved.map((row) => (
                  <tr key={row.id} className="border-t border-surface-border">
                    <td className="py-2 pr-4 whitespace-nowrap text-neutral-600 dark:text-neutral-400">
                      {when(row.resolvedAt)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{row.reasonCode}</td>
                    <td className="py-2 pr-4">
                      {/* ⭐ "Came back on its own" is not the same event as "somebody discarded it",
                          and the difference is exactly `resolvedBy` being null. */}
                      {row.resolution === 'ingested' ? (
                        <span className="text-success">
                          {row.resolvedBy ? 'Went through' : 'Came back on its own'}
                        </span>
                      ) : (
                        <span className="text-neutral-600 dark:text-neutral-400">Discarded</span>
                      )}
                    </td>
                    <td className="py-2 text-neutral-600 dark:text-neutral-400">
                      {row.resolutionReason ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="text-xs text-neutral-500 dark:text-neutral-500">
        <Link href="/" className="underline">
          Back
        </Link>{' '}
        · Read at {when(now)}
      </p>
    </Page>
  );
}

// ─── Health ───────────────────────────────────────────────────────────────────────────────

function HealthPanel({ health, now }: { health: LaneHealthReport; now: Date }) {
  const tone = health.needsAttention
    ? 'border-warning bg-warning-soft'
    : 'border-success bg-success-soft';

  return (
    <section className={`space-y-4 rounded-lg border p-4 sm:p-5 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          {health.needsAttention ? 'The lane needs attention' : 'The lane is healthy'}
        </span>
        <span className="text-xs text-neutral-600 dark:text-neutral-400">
          Read {ago(now, now)} · {when(now)}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Lane A — out to the terminals. */}
        <Metric
          label="Mirror out to terminals"
          status={health.outbox.status}
          value={
            health.outbox.lagMinutes === null
              ? 'Up to date'
              : `${health.outbox.lagMinutes} min behind`
          }
          detail={
            health.outbox.pending === 0
              ? 'Nothing waiting to publish.'
              : `${health.outbox.pending} waiting, oldest from ${when(health.outbox.oldestEnqueuedAt)}.` +
                (health.outbox.lastError ? ` Last error: ${health.outbox.lastError}` : '')
          }
          threshold={`Warns past ${LANE_HEALTH.outboxLagWarnMinutes} min`}
        />

        {/* Lane B — in from the terminals. */}
        <Metric
          label="Punches in from terminals"
          status={health.inbox.status}
          value={
            health.inbox.status === 'unknown'
              ? 'Not measured'
              : health.inbox.lagMinutes === null
                ? 'Up to date'
                : `${health.inbox.lagMinutes} min behind`
          }
          /* ⛔ An unmeasured lane must never render as a healthy one — that is precisely how v1's
             dead letter stayed invisible. The inbox lives in Firestore; Postgres cannot see a
             document the relay has not reached, so until the relay reports, this says so. */
          detail={
            health.inbox.status === 'unknown'
              ? 'No relay has reported yet. This is not the same as "nothing is waiting".'
              : `Reported ${when(health.inbox.reportedAt)}.`
          }
          threshold={`Warns past ${LANE_HEALTH.inboxUnprocessedWarnMinutes} min`}
        />

        <Metric
          label="Stuck events"
          status={health.quarantineOpen > 0 ? 'warn' : 'ok'}
          value={String(health.quarantineOpen)}
          detail={
            health.quarantineOpen === 0
              ? health.healedRecently > 0
                ? `${health.healedRecently} came back on their own this week.`
                : 'Nothing stuck.'
              : health.quarantineByReason.map((r) => `${r.count} ${r.reasonCode}`).join(' · ')
          }
          threshold={
            health.unattributedOpen > 0
              ? `${health.unattributedOpen} more name no store`
              : `Oldest ${ago(health.quarantineOldestAt, now)}`
          }
        />
      </div>

      {/* ⚠️ Three ways of being quiet, and only one of them is a fault. */}
      <div>
        <h3 className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Terminals</h3>
        {health.terminals.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
            No terminals are provisioned at this store, so nobody can clock in on one.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {health.terminals.map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-medium">{t.label}</span>
                <span
                  className={
                    t.status === 'silent'
                      ? 'text-warning-ink'
                      : 'text-neutral-600 dark:text-neutral-400'
                  }
                >
                  {t.status === 'silent' && `Silent for ${t.silentHours} hours`}
                  {t.status === 'ok' && `Last punch ${ago(t.lastSeenAt, now)}`}
                  {t.status === 'no_punches_yet' && 'Paired, no punches yet'}
                  {t.status === 'never_paired' && 'Provisioned but never signed in'}
                </span>
                {t.lastSeenAt && (
                  <span className="text-neutral-500 dark:text-neutral-500">
                    ({when(t.lastSeenAt)})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-500">
          A terminal is called silent past {LANE_HEALTH.terminalSilentWarnHours} hours — longer than
          a day on purpose, so a store that shut an hour early is not reported as down.
        </p>
      </div>
    </section>
  );
}

function Metric({
  label,
  status,
  value,
  detail,
  threshold,
}: {
  label: string;
  status: 'ok' | 'warn' | 'unknown';
  value: string;
  detail: string;
  threshold: string;
}) {
  const colour =
    status === 'warn'
      ? 'text-warning-ink'
      : status === 'unknown'
        ? 'text-neutral-500 dark:text-neutral-500'
        : 'text-success';
  return (
    <div>
      <div className="text-xs text-neutral-600 dark:text-neutral-400">{label}</div>
      <div className={`font-mono text-xl font-semibold tabular-nums ${colour}`}>{value}</div>
      <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">{detail}</p>
      <p className="text-xs text-neutral-500 dark:text-neutral-500">{threshold}</p>
    </div>
  );
}

// ─── One stuck event ──────────────────────────────────────────────────────────────────────

function StuckEvent({
  row,
  storeId,
  now,
}: {
  row: QuarantineView;
  storeId: string;
  now: Date;
}) {
  const occurredAt = (row.rawEvent as { occurredAt?: number } | null)?.occurredAt ?? null;

  return (
    <article className="rounded-lg border border-surface-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {/* ⭐ The SENTENCE is the headline, not the code. A code is for the database. */}
          <p className="text-sm">{row.sentence}</p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-500">
            Punched {occurredAt ? when(new Date(occurredAt)) : 'at an unreadable time'} · arrived{' '}
            {when(row.firstSeenAt)} ({ago(row.firstSeenAt, now)})
            {row.attempts > 1 && ` · seen ${row.attempts} times`}
          </p>
        </div>
        <span className="shrink-0 rounded bg-canvas px-2 py-0.5 font-mono text-xs text-neutral-600">
          {row.reasonCode}
        </span>
      </div>

      {/* ⭐ The raw body, shown exactly as received. By definition we failed to interpret this
          event, so showing our reading of it would show the mistake instead of the evidence. */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-neutral-600 dark:text-neutral-400">
          Show the raw event
        </summary>
        <pre className="mt-2 overflow-x-auto rounded border border-surface-border bg-canvas p-3 text-xs">
          {rawJson(row.rawEvent)}
        </pre>
      </details>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
        {/* ⭐ Retry is usually the whole fix — an event stuck on an unenrolled staffer goes
            through the moment they are enrolled, and nothing else has to happen. */}
        {row.retryable ? (
          <form action={retryEventAction}>
            <input type="hidden" name="quarantineId" value={row.id} />
            <input type="hidden" name="storeId" value={storeId} />
            <Button type="submit" variant="secondary" className="w-full sm:w-auto">
              Retry
            </Button>
          </form>
        ) : (
          // ⛔ The absence of the button is the message: retrying an unreadable body will fail the
          // same way forever, and a button that cannot work teaches a manager to distrust the page.
          <p className="text-xs text-neutral-500 sm:max-w-[12rem]">
            Retry cannot help here — the body will not change.
          </p>
        )}

        {/* ⛔ Discard needs a reason. The row survives forever; nothing is ever deleted. */}
        <CheckedForm rules={ATTENDANCE_DISCARD_RULES} action={discardEventAction} className="flex-1 space-y-2 sm:flex sm:gap-2 sm:space-y-0">
          <input type="hidden" name="quarantineId" value={row.id} />
          <input type="hidden" name="storeId" value={storeId} />
          <Field label="Reason to discard" rule={ATTENDANCE_DISCARD_RULES.reason} className="sm:flex-1">
            <Input
              type="text"
              {...nativeAttrs(ATTENDANCE_DISCARD_RULES.reason)}
              placeholder="Why this is not a real shift"
              className="w-full"
            />
          </Field>
          <Button type="submit" variant="danger" className="w-full sm:w-auto">
            Discard
          </Button>
        </CheckedForm>
      </div>
    </article>
  );
}
