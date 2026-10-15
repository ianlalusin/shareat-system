import Link from 'next/link';
import { notFound } from 'next/navigation';
import { dualRunWeekView, mayRecordDualRunDisposition } from '@shareat/domain';
import { reportScope, runReport } from '../../../lib';
import { recordDualRunDispositionAction } from '../../actions';
import { EmptyState } from '@/components/reports/EmptyState';
import { Page } from '@/components/shell/Page';
import { withFlash } from '@/lib/flash';
import { Badge, Button, Field, FlashBanner, FormGrid, Input, Select, Textarea } from '@/components/ui';
import { FAMILY_LABEL, VerdictBadge, isMonday, manilaDateTime, peso } from '../../ui';

export const metadata = { title: 'Dual run week — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  version?: string;
}

const KIND_TITLE: Record<string, string> = {
  cash_bank: 'Cash and bank',
  staff_cash: 'Staff cash',
  sales_tender: 'Sales by tender',
  expense_category: 'Expenses by category',
  ap_supplier: 'Suppliers (payables)',
  inventory_basis: 'Inventory basis',
  unassigned_store: 'Not assigned to a store',
};

/**
 * T-392 S5 - one store-week: every line of the compare report with v1, v2, the difference and its class, per-day states,
 * the version history, and (administrators only, current version only) a form to record a disposition.
 * The form is a hint; `recordDualRunDisposition` re-checks the role, both capabilities and the line.
 */
export default async function DualRunWeekPage({
  params,
  searchParams,
}: {
  params: Promise<{ store: string; week: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { store: storeParam, week: weekParam } = await params;
  let code: string;
  let week: string;
  try {
    code = decodeURIComponent(storeParam);
    week = decodeURIComponent(weekParam);
  } catch {
    notFound();
  }
  if (!isMonday(week)) notFound();
  const sp = await withFlash(searchParams, { getKeys: ['version'] });

  const scope = await reportScope(`/reports/dual-run/${storeParam}/${weekParam}`, 'view_financial_reports', undefined);
  const store = scope.stores.find((s) => s.code === code);
  if (!store) notFound();

  const { view, canRecord } = await runReport(scope.actor.orgId, async (tx) => {
    const v = await dualRunWeekView(tx, scope.actor, { storeId: store.id, weekStart: week, ...(sp.version ? { versionId: sp.version } : {}) });
    const may = v && v.report.isCurrent ? await mayRecordDualRunDisposition(tx, scope.actor, store.id) : false;
    return { view: v, canRecord: may };
  });

  if (!view) {
    if (sp.version) notFound();
    return (
      <Page density="wide">
        <h1 className="text-2xl font-semibold">
          {store.name} · week of {week}
        </h1>
        <EmptyState message="No compare report for this store and week yet." />
        <Link href="/reports/dual-run" className="inline-flex min-h-11 items-center text-sm underline">
          Back to the weeks
        </Link>
      </Page>
    );
  }

  const groups = new Map<string, typeof view.lines>();
  for (const l of view.lines) groups.set(l.kind, [...(groups.get(l.kind) ?? []), l]);

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">
          {view.store.name} · week of {view.report.weekStart}
        </h1>
        <p className="mt-1 text-sm text-muted">
          To {view.report.through}. {view.report.comparedDays} compared day{view.report.comparedDays === 1 ? '' : 's'}. Report made{' '}
          {manilaDateTime(view.report.createdAt)}.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={view.report.verdict} />
          {!view.report.isCurrent ? <Badge tone="warning" label="Older version (read only)" /> : null}
          <Link href="/reports/dual-run" className="inline-flex min-h-11 items-center text-sm underline">
            All weeks
          </Link>
          {!view.report.isCurrent ? (
            <Link href={`/reports/dual-run/${encodeURIComponent(view.store.code)}/${view.report.weekStart}`} className="inline-flex min-h-11 items-center text-sm underline">
              Show the current version
            </Link>
          ) : null}
        </div>
      </div>

      <FlashBanner flash={sp} />

      {view.versions.length > 1 ? (
        <section className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Versions</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {view.versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border py-1">
                <span>
                  {v.id === view.report.id ? (
                    <span className="font-semibold">{manilaDateTime(v.createdAt)}</span>
                  ) : (
                    <Link
                      href={`/reports/dual-run/${encodeURIComponent(view.store.code)}/${view.report.weekStart}?version=${v.id}`}
                      className="inline-flex min-h-11 items-center text-sm underline"
                    >
                      {manilaDateTime(v.createdAt)}
                    </Link>
                  )}
                  {v.isCurrent ? ' (current)' : ''}
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted">{v.changes.length === 0 ? 'first report' : v.changes.join(' · ')}</span>
                  <VerdictBadge verdict={v.verdict} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.lines.length === 0 ? <EmptyState message="This report has no lines." /> : null}

      {[...groups.entries()].map(([kind, lines]) => (
        <section key={kind} className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{KIND_TITLE[kind] ?? kind}</h2>
          {lines.map((l) => (
            <article key={`${l.kind}|${l.lineKey}`} className="rounded-lg border border-surface-border bg-surface p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words font-medium">{l.label}</p>
                  {l.label !== l.lineKey ? <p className="break-all text-xs text-muted">{l.lineKey}</p> : null}
                </div>
                <Badge
                  tone={l.family === 'tie' ? 'success' : l.family === 'open' ? 'danger' : l.family === 'defect' ? 'warning' : 'info'}
                  label={`${FAMILY_LABEL[l.family] ?? l.family}: ${l.class}`}
                />
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-right tabular-nums">
                <div>
                  <dt className="text-xs text-muted">v1 (old)</dt>
                  <dd>{peso(l.v1)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">v2 (new)</dt>
                  <dd>{peso(l.v2)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Difference</dt>
                  <dd className="font-semibold">{peso(l.delta)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-muted">{l.autoReason ?? l.meaning}</p>

              {l.reCheck ? (
                <p className="mt-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-ink">
                  Re-check: the amount changed since the last disposition, so it no longer applies.
                </p>
              ) : null}
              {l.latestDisposition ? (
                <p className="mt-2 text-xs">
                  Latest disposition: <span className="font-medium">{l.latestDisposition.class} {l.latestDisposition.ref}</span> at{' '}
                  {peso(l.latestDisposition.deltaAt)} — {l.latestDisposition.note}
                </p>
              ) : null}
              {l.pending.length > 0 ? (
                <p className="mt-1 text-xs text-muted">Applies from the next compare run: {l.pending.map((p) => `${p.class} ${p.ref}`).join(', ')}.</p>
              ) : null}

              {l.perDay.length > 0 ? (
                <details className="mt-2">
                  <summary className="min-h-11 cursor-pointer content-center text-xs font-medium underline">Per day ({l.perDay.length})</summary>
                  <ul className="mt-1 flex flex-col gap-1 text-xs tabular-nums">
                    {l.perDay.map((d) => (
                      <li key={d.date} className="flex flex-wrap justify-between gap-2 border-b border-surface-border py-1">
                        <span>
                          {d.date} · {d.state}
                        </span>
                        <span>
                          {peso(d.v1)} / {peso(d.v2)} / <span className="font-semibold">{peso(d.delta)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {canRecord && view.report.isCurrent && l.dispositionable ? (
                <form action={recordDualRunDispositionAction} className="mt-3 flex flex-col gap-2 border-t border-surface-border pt-3">
                  <input type="hidden" name="storeId" value={view.store.id} />
                  <input type="hidden" name="weekStart" value={view.report.weekStart} />
                  <input type="hidden" name="kind" value={l.kind} />
                  <input type="hidden" name="lineKey" value={l.lineKey} />
                  <p className="text-xs font-medium">Record a disposition (counts from the next compare run)</p>
                  <FormGrid>
                    <Field label="Whose defect">
                      <Select name="class" defaultValue="V2_DEFECT" className="w-full">
                        <option value="V1_DEFECT">V1_DEFECT (old system is wrong)</option>
                        <option value="V2_DEFECT">V2_DEFECT (new system is wrong)</option>
                      </Select>
                    </Field>
                    <Field label="Defect reference">
                      <Input name="ref" placeholder="DEF-123" pattern="DEF-[0-9]+" required className="w-full" />
                    </Field>
                    <Field label="Note" span="full">
                      <Textarea name="note" required maxLength={500} className="w-full" />
                    </Field>
                  </FormGrid>
                  <Button type="submit" variant="primary">
                    Record
                  </Button>
                </form>
              ) : null}
            </article>
          ))}
        </section>
      ))}
    </Page>
  );
}
