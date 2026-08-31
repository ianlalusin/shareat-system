import { requireSession } from '../../lib/session';
import { postPayRunAction, setPayRateAction, voidPayRunAction } from './actions';
import {
  cashAccountsFor,
  currentPeriod,
  listStores,
  payoutDateFor,
  periodsForMonth,
  periodLabel,
  peso,
  premiumSettingsFor,
  preview,
  rosterFor,
  runsFor,
  slipsFor,
} from './lib';

export const metadata = { title: 'Payroll — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  /** ⭐ `start|end` from the period picker. Takes precedence over the raw dates below. */
  period?: string;
  start?: string;
  end?: string;
  ok?: string;
  error?: string;
}

/**
 * Payroll. T-189, Phase 5 slice 1.
 *
 * ⭐ The point of this screen is that it produces a **payslip** — the thing v1's payroll never
 * managed once across seven stores, despite three shipped slices and a verified tax engine.
 */
export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/payroll');

  const stores = await listStores(actor.orgId);
  const storeId = sp.store || stores[0]?.id;
  if (!storeId) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-8">
        <h1 className="text-2xl font-semibold">Payroll</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No store is set up yet.</p>
      </main>
    );
  }

  // ⭐ The period comes from the STORE'S configuration, not from a hardcoded 1st-to-15th.
  const cfg = await premiumSettingsFor(actor.orgId, storeId);
  const periodOptions = cfg ? periodsForMonth(cfg) : [];
  const fallback = cfg ? currentPeriod(cfg) : { start: '', end: '', label: '' };
  // ⚠️ The picker and the two date inputs BOTH submit, so precedence has to be explicit: the
  // picker wins when it changed, otherwise the typed dates, otherwise the store's current period.
  // Without this the select looked like it worked and silently did nothing.
  const picked = sp.period?.split('|') ?? [];
  const periodStart = (picked[0] || sp.start || fallback.start) as string;
  const periodEnd = (picked[1] || sp.end || fallback.end) as string;

  const [{ preview: pv, error: previewError }, roster, runs, accounts] = await Promise.all([
    preview(actor.orgId, actor, { storeId, periodStart, periodEnd }),
    rosterFor(actor.orgId, storeId),
    runsFor(actor.orgId, storeId),
    cashAccountsFor(actor.orgId, storeId),
  ]);

  const latest = runs[0];
  const latestSlips = latest ? await slipsFor(actor.orgId, latest.id) : [];

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Payroll</h1>
        <p className="max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
          Pay computed from attendance, with what each person already drew netted off{' '}
          <code>1230</code>. ⭐ Posting <strong>freezes</strong> the days it paid — after that a
          correction goes through payroll, not by restating the day.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Store</span>
          <select name="store" defaultValue={storeId} className={`${FIELD} w-52`}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {/* ⭐ The store's OWN periods. ⚠️ The dates stay editable underneath — a late correction
            has to be payable even when it does not line up with a configured window. */}
        {periodOptions.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Period</span>
            <select
              name="period"
              defaultValue={`${periodStart}|${periodEnd}`}
              className={`${FIELD} w-64`}
            >
              {periodOptions.map((p) => (
                <option key={p.start} value={`${p.start}|${p.end}`}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className={LABEL}>From</span>
          <input name="start" type="date" defaultValue={periodStart} className={`${FIELD} w-44`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>to</span>
          <input name="end" type="date" defaultValue={periodEnd} className={`${FIELD} w-44`} />
        </label>
        <button type="submit" className={BTN}>
          Preview
        </button>
      </form>

      {/* ⭐ The premium settings this run is computed under. ⚠️ These were constants in code until
          T-189b; a number that decides somebody's pay belongs on the screen that spends it. */}
      {cfg && (
        <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-neutral-500">
          <span>
            Shift <b className="text-neutral-700 dark:text-neutral-300">{cfg.requiredHoursPerShift}h</b>
          </span>
          <span>
            Overtime{' '}
            <b className="text-neutral-700 dark:text-neutral-300">
              {cfg.overtimeMode === 'fixed'
                ? `${peso(Number(cfg.overtimeFixedHourly ?? 0))} / hour, flat`
                : `×${cfg.overtimeMultiplier}`}
            </b>
          </span>
          <span>
            Night diff <b className="text-neutral-700 dark:text-neutral-300">&times;{cfg.nightDiffMultiplier}</b>
          </span>
          <span>
            Holiday{' '}
            <b className="text-neutral-700 dark:text-neutral-300">
              regular &times;{cfg.holidayRegularMultiplier} · special non-working &times;
              {cfg.holidaySpecialNonWorkingMultiplier} · special working &times;
              {cfg.holidaySpecialWorkingMultiplier}
            </b>
          </span>
          <span>
            Periods{' '}
            <b className="text-neutral-700 dark:text-neutral-300">
              {cfg.payrollPeriodType.replace('_', '-')}
              {cfg.payrollPeriodType === 'semi_monthly' && `, cut on the ${cfg.semiMonthlyCutoffDay}th`}
            </b>
            {cfg.payoutLagDays > 0 && `, paid ${cfg.payoutLagDays}d after`}
          </span>
          <span className="text-neutral-400">
            ⭐ Hours count in half-hour steps; anything under is not paid. Late is exact.
          </span>
        </p>
      )}

      {sp.error && <Banner tone="error">{sp.error}</Banner>}
      {sp.ok && <Banner tone="ok">{sp.ok}</Banner>}
      {previewError && <Banner tone="error">{previewError}</Banner>}

      {/* ------------------------------------------------------------------ the preview */}
      {pv && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">
              {periodStart} → {periodEnd}
            </h2>
            <span className="text-xs text-neutral-500">
              {pv.slips.length} payslip(s) · gross {peso(Number(pv.totalGross))} · net{' '}
              {peso(Number(pv.totalNet))}
              {cfg && cfg.payoutLagDays > 0 && (
                <> · payable {payoutDateFor({ start: periodStart, end: periodEnd, label: '' }, cfg.payoutLagDays)}</>
              )}
            </span>
          </div>

          {pv.needsReviewDays > 0 && (
            <p className="rounded border border-amber-300 p-3 text-xs text-amber-900 dark:border-amber-800 dark:text-amber-300">
              ⚠️ <strong>{pv.needsReviewDays} day(s) still need a manager&rsquo;s review</strong> and
              are excluded from this run. ⛔ They are counted here on purpose — a run that silently
              skipped them would look identical to a run where nobody worked.
            </p>
          )}

          {pv.unratedEmployments.length > 0 && (
            <p className="rounded border border-red-300 p-3 text-xs text-red-900 dark:border-red-800 dark:text-red-300">
              ⛔ <strong>No pay rate in force</strong> for{' '}
              {pv.unratedEmployments.map((u) => `${u.personName} (${u.days}d)`).join(', ')}. Set a
              rate below — a day priced at ₱0 is indistinguishable from a day nobody worked, so the
              run refuses rather than guessing.
            </p>
          )}

          {pv.slips.length === 0 ? (
            <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
              Nothing payable in this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-1 pr-3 font-medium">Person</th>
                    <th className="py-1 pr-3 text-right font-medium">Days</th>
                    <th className="py-1 pr-3 text-right font-medium">Basic</th>
                    <th className="py-1 pr-3 text-right font-medium">OT + ND + Hol</th>
                    <th className="py-1 pr-3 text-right font-medium">Gross</th>
                    <th className="py-1 pr-3 text-right font-medium">Advance</th>
                    <th className="py-1 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {pv.slips.map((s) => (
                    <tr
                      key={s.employmentId}
                      className="border-t border-neutral-200 dark:border-neutral-800"
                    >
                      <td className="py-1.5 pr-3">{s.personName}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{s.daysWorked}</td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {peso(Number(s.basicPay))}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-neutral-500">
                        {peso(Number(s.otPay) + Number(s.nightDiffPay) + Number(s.holidayPay))}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {peso(Number(s.grossPay))}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-amber-700 dark:text-amber-400">
                        {Number(s.advanceRecovered) > 0 ? `−${peso(Number(s.advanceRecovered))}` : '—'}
                      </td>
                      <td className="py-1.5 text-right font-mono font-medium tabular-nums">
                        {peso(Number(s.netPay))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pv.slips.length > 0 && pv.unratedEmployments.length === 0 && (
            <form
              action={postPayRunAction}
              className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800"
            >
              <input type="hidden" name="storeId" value={storeId} />
              <input type="hidden" name="periodStart" value={periodStart} />
              <input type="hidden" name="periodEnd" value={periodEnd} />
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Pay from</span>
                <select name="moneyAccountId" className={`${FIELD} w-56`}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <input name="notes" placeholder="Notes (optional)" className={`${FIELD} w-64`} />
              <button type="submit" className={BTN_PRIMARY}>
                Post {pv.slips.length} payslip(s)
              </button>
            </form>
          )}
        </section>
      )}

      {/* ------------------------------------------------------------------ rates */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Pay rates</h2>
        <p className="max-w-2xl text-xs text-neutral-500">
          ⛔ A rate is never edited — a new one <strong>supersedes</strong> it from its effective
          date, because a payslip already posted was computed under the old one and has to stay
          explicable. ⚠️ Only a <strong>daily</strong> basis has a compute path.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-1 pr-3 font-medium">Person</th>
                <th className="py-1 pr-3 font-medium">Rate in force today</th>
                <th className="py-1 font-medium">Set a new rate</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((r) => (
                <tr key={r.id} className="border-t border-neutral-200 dark:border-neutral-800">
                  <td className="py-2 pr-3">{r.personName}</td>
                  <td className="py-2 pr-3 font-mono tabular-nums">
                    {r.rate ? `${peso(Number(r.rate.amount))} / ${r.rate.basis}` : '—'}
                    {r.rate && (
                      <span className="ml-2 font-sans text-xs text-neutral-500">
                        from {r.rate.effectiveFrom}
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    <form action={setPayRateAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="storeId" value={storeId} />
                      <input type="hidden" name="employmentId" value={r.id} />
                      <select name="basis" defaultValue="daily" className={`${FIELD} w-24`}>
                        <option value="daily">daily</option>
                        <option value="hourly">hourly</option>
                      </select>
                      <input
                        name="amount"
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="0.00"
                        className={`${FIELD} w-28`}
                      />
                      <input
                        name="effectiveFrom"
                        type="date"
                        defaultValue={periodStart}
                        className={`${FIELD} w-40`}
                      />
                      <button type="submit" className={BTN}>
                        Set
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------------------------ history */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Runs</h2>
        {runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No pay run yet at this store.
          </p>
        ) : (
          runs.map((run) => (
            <div
              key={run.id}
              className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{periodLabel(run)}</span>
                <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
                  {run.status}
                </span>
                {run.voidReason && (
                  <span className="text-xs text-neutral-500">voided — {run.voidReason}</span>
                )}
              </div>

              {run.id === latest?.id && latestSlips.length > 0 && (
                <ul className="text-xs text-neutral-600 dark:text-neutral-400">
                  {latestSlips.map((s) => (
                    <li key={s.id}>
                      {s.personName} — {s.daysWorked} day(s), net{' '}
                      <span className="font-mono">{peso(Number(s.netPay))}</span>
                      {Number(s.advanceRecovered) > 0 &&
                        ` (advance −${peso(Number(s.advanceRecovered))})`}
                    </li>
                  ))}
                </ul>
              )}

              {run.status === 'posted' && (
                <form action={voidPayRunAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="runId" value={run.id} />
                  <input name="reason" placeholder="Why void it?" className={`${FIELD} w-64`} />
                  <button type="submit" className={BTN}>
                    Void
                  </button>
                  <span className="text-xs text-neutral-500">
                    ⭐ Reverses the entries and unfreezes the days, so the period is payable again.
                  </span>
                </form>
              )}
            </div>
          ))
        )}
      </section>
    </main>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return <div className={`rounded-lg border p-4 text-sm ${cls}`}>{children}</div>;
}

/**
 * ⚠️ `FIELD` carries NO width, and `INPUT` is `FIELD` plus `w-full`.
 *
 * Writing `${INPUT} w-24` puts `w-full` and `w-24` in the same class string, and neither wins by
 * being written last — the order in the generated CSS decides, and `w-full` won. The rate form
 * stacked to full width in a browser while every test stayed green, because a test asserts props,
 * never geometry.
 */
const FIELD =
  'rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const INPUT = `w-full ${FIELD}`;
const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';
const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
const BTN_PRIMARY =
  'rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300';
