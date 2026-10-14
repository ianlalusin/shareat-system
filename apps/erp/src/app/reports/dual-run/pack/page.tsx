import Link from 'next/link';
import { dualRunOverview, dualRunPack } from '@shareat/domain';
import { reportScope, runReport } from '../../lib';
import { EmptyState } from '@/components/reports/EmptyState';
import { Page } from '@/components/shell/Page';
import { Badge, Button, Input } from '@/components/ui';
import { FAMILY_LABEL, VerdictBadge, isMonday, peso } from '../ui';

export const metadata = { title: 'Dual run pack — Shareat System' };
export const dynamic = 'force-dynamic';

const DEFAULT_FROM = '2026-10-19';

interface SearchParams {
  from?: string;
  to?: string;
}

/**
 * T-392 S5 - the go / no-go pack: every store-week's CURRENT version in the range, compared days per store and in total,
 * no-data weeks listed apart, class totals in pesos, every defect with its DEF reference. Printable.
 * Needs every store of the org: a pack over some stores must never read "signable" (the domain refuses it too).
 */
export default async function DualRunPackPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = await reportScope('/reports/dual-run/pack', 'view_financial_reports', undefined);

  if (!scope.coversWholeOrg) {
    return (
      <Page density="wide">
        <h1 className="text-2xl font-semibold">Dual run pack</h1>
        <EmptyState message="The pack needs every store of the organisation. Ask an administrator." />
      </Page>
    );
  }

  const orgId = scope.actor.orgId;
  const from = sp.from && isMonday(sp.from) ? sp.from : DEFAULT_FROM;
  let to = sp.to && isMonday(sp.to) ? sp.to : undefined;
  if (!to) {
    const all = await runReport(orgId, (tx) =>
      dualRunOverview(tx, scope.actor, { storeIds: scope.stores.map((s) => s.id), fromWeek: from }),
    );
    to = all.reduce((latest, r) => (r.weekStart.localeCompare(latest, 'en') > 0 ? r.weekStart : latest), from);
  }
  const toWeek = to;
  const pack = await runReport(orgId, (tx) => dualRunPack(tx, scope.actor, { fromWeek: from, toWeek }));
  const storeName = new Map(scope.stores.map((s) => [s.id, s.name]));
  const storeCode = new Map(scope.stores.map((s) => [s.id, s.code]));
  const nameOf = (id: string) => storeName.get(id) ?? id;

  return (
    <Page density="wide">
      {/* Print: hide the app shell (sidebar and top bar) so only the pack prints. Scoped to this page. */}
      <style>{'@media print { .shell-sidebar, header.shell-nav-row { display: none !important; } }'}</style>
      <div>
        <h1 className="text-2xl font-semibold">Dual run: go / no-go pack</h1>
        <p className="mt-1 text-sm text-muted">
          Only the newest report of each store and week counts. Weeks with no data are listed apart and not counted.
        </p>
      </div>

      <form method="GET" action="/reports/dual-run/pack" className="flex flex-wrap items-end gap-3 text-sm print:hidden">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">From (a Monday)</span>
          <Input type="date" name="from" defaultValue={from} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">To (a Monday)</span>
          <Input type="date" name="to" defaultValue={toWeek} />
        </label>
        <Button type="submit" variant="primary">
          Apply
        </Button>
        <Link href="/reports/dual-run" className="inline-flex min-h-11 items-center text-sm underline font-medium">
          Back to the weeks
        </Link>
      </form>

      <section
        role="status"
        className={pack.signable ? 'rounded-lg border-2 border-success bg-success-soft p-4' : 'rounded-lg border-2 border-danger bg-danger-surface p-4'}
      >
        <p className={pack.signable ? 'text-lg font-bold text-success' : 'text-lg font-bold text-danger'}>
          {pack.signable ? 'Signable' : 'Not signable'}
        </p>
        <p className="mt-1 text-sm">
          {pack.totalDays} compared day{pack.totalDays === 1 ? '' : 's'} over {pack.countedWeeks} counted week{pack.countedWeeks === 1 ? '' : 's'}.
          Needs {pack.minTotalDays} in total and {pack.minStoreDays} per store.
        </p>
        {pack.reasons.length > 0 ? (
          <ul className="mt-2 list-disc pl-5 text-sm">
            {pack.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Compared days per store</h2>
        {pack.stores.length === 0 ? (
          <EmptyState message="No compare report in this range." />
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {pack.stores.map((s) => (
              <li key={s.storeId} className="flex justify-between gap-2 border-b border-surface-border py-1">
                <span>{s.name}</span>
                <span className="tabular-nums">
                  {s.days} / {pack.minStoreDays}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Weeks</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {pack.weeks.map((w) => (
            <li key={`${w.storeId}|${w.weekStart}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border py-1">
              <Link href={`/reports/dual-run/${encodeURIComponent(storeCode.get(w.storeId) ?? '')}/${w.weekStart}`} className="inline-flex min-h-11 items-center text-sm underline">
                {nameOf(w.storeId)} · {w.weekStart}
              </Link>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-muted">{w.comparedDays} d</span>
                <VerdictBadge verdict={w.verdict} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      {pack.noData.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">No data (not counted)</h2>
          <ul className="list-disc pl-5 text-sm">
            {pack.noData.map((w) => (
              <li key={`${w.storeId}|${w.weekStart}`}>
                {nameOf(w.storeId)} · {w.weekStart}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {pack.stale.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Re-run compare</h2>
          <p className="text-sm text-muted">A disposition was recorded after these reports were made. It counts only after a fresh extract and compare.</p>
          <ul className="list-disc pl-5 text-sm">
            {pack.stale.map((w) => (
              <li key={`${w.storeId}|${w.weekStart}`}>
                {nameOf(w.storeId)} · {w.weekStart}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Differences by class (counted weeks)</h2>
        {pack.classTotals.length === 0 ? (
          <p className="text-sm text-muted">No line differs.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {pack.classTotals.map((c) => (
              <li key={c.class} className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border py-1">
                <span className="flex items-center gap-2">
                  <Badge tone={c.family === 'open' ? 'danger' : c.family === 'defect' ? 'warning' : 'info'} label={FAMILY_LABEL[c.family] ?? c.family} />
                  <span>{c.class}</span>
                </span>
                <span className="tabular-nums">
                  {c.lines} line{c.lines === 1 ? '' : 's'} · {peso(c.absDelta)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Defects</h2>
        {pack.defects.length === 0 ? (
          <p className="text-sm text-muted">No line is classed as a defect.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {pack.defects.map((d) => (
              <li key={`${d.storeId}|${d.weekStart}|${d.kind}|${d.lineKey}`} className="flex flex-wrap justify-between gap-2 border-b border-surface-border py-1">
                <span>
                  {nameOf(d.storeId)} · {d.weekStart} · {d.label}
                </span>
                <span className="font-medium">
                  {d.class} {d.ref || '(no reference found)'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="hidden text-xs text-muted print:block">
        Range {pack.fromWeek} to {pack.toWeek}.
      </p>
    </Page>
  );
}
