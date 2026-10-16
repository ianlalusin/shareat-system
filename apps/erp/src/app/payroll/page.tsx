import { requirePageAccess, StoreNotAvailable } from '../../lib/page-access';
import { compare, money, ZERO } from '@shareat/core/money';
import { postPayRunAction, setPayRateAction, voidPayRunAction } from './actions';
import {
  cashAccountsFor,
  currentPeriod,
  payrollStoresFor,
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
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Banner, Button, ConfirmDestructive, FlashBanner, Input, Select } from '@/components/ui';

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
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/payroll');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const stores = await payrollStoresFor(actor);
  if (stores.length === 0) return <StoreNotAvailable />;
  // T-435: a requested store the actor does not hold is one sentence — never a fallback to another store.
  if (sp.store && !stores.some((s) => s.id === sp.store)) return <StoreNotAvailable />;
  const storeId = sp.store || stores[0]?.id;
  if (!storeId) {
    return (
      <Page density="table" className="space-y-4">
        <h1 className="text-2xl font-semibold">Payroll</h1>
        <PageDescription>No store is set up yet.</PageDescription>
      </Page>
    );
  }

  // ⭐ The period comes from the STORE'S configuration, not from a hardcoded 1st-to-15th.
  const cfg = await premiumSettingsFor(actor, storeId);
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
    rosterFor(actor, storeId),
    runsFor(actor, storeId),
    cashAccountsFor(actor, storeId),
  ]);

  const latest = runs[0];
  const latestSlips = latest ? await slipsFor(actor, latest.id) : [];

  return (
    <Page density="table">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Payroll</h1>
          <PageDescription>
            Pay computed from attendance, with what each person already drew netted against{' '}
            advances to employees. ⭐ Posting <strong>freezes</strong> the days it paid — after that a
            correction goes through payroll, not by restating the day.
          </PageDescription>
        </div>
        <span className="flex shrink-0 gap-3 text-sm">
          <a href="/payroll/thirteenth-month" className="underline">
            13th-month pay
          </a>
          <a href="/payroll/separations" className="underline">
            Separations
          </a>
        </span>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <span className={LABEL}>Store</span>
          <Select name="store" defaultValue={storeId} className="w-full">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        {/* ⭐ The store's OWN periods. ⚠️ The dates stay editable underneath — a late correction
            has to be payable even when it does not line up with a configured window. */}
        {periodOptions.length > 0 && (
          <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
            <span className={LABEL}>Period</span>
            <Select
              name="period"
              defaultValue={`${periodStart}|${periodEnd}`}
              className="w-full"
            >
              {periodOptions.map((p) => (
                <option key={p.start} value={`${p.start}|${p.end}`}>
                  {p.label}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
          <span className={LABEL}>From</span>
          <Input name="start" type="date" defaultValue={periodStart} className="w-full" />
        </label>
        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
          <span className={LABEL}>to</span>
          <Input name="end" type="date" defaultValue={periodEnd} className="w-full" />
        </label>
        <Button type="submit" variant="secondary">
          Preview
        </Button>
      </form>

      {/* ⭐ The premium settings this run is computed under. ⚠️ These were constants in code until
          T-189b; a number that decides somebody's pay belongs on the screen that spends it. */}
      {cfg && (
        <p className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-neutral-500">
          <a href={`/settings/attendance?store=${storeId}`} className="underline">
            Edit these settings
          </a>
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
            {cfg.payoutMode === 'fixed_days'
              ? `, paid on the ${cfg.payoutDays.join(' & ')}`
              : cfg.payoutLagDays > 0
                ? `, paid ${cfg.payoutLagDays}d after`
                : ''}
          </span>
          <span className="text-neutral-400">
            ⭐ Hours count in half-hour steps; anything under is not paid. Late is exact.
          </span>
        </p>
      )}

      <FlashBanner flash={sp} />
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
              {cfg && (
                <>
                  {' '}
                  · payable{' '}
                  {payoutDateFor(
                    { start: periodStart, end: periodEnd, label: '' },
                    cfg,
                    Math.max(0, periodOptions.findIndex((o) => o.start === periodStart)),
                  )}
                </>
              )}
            </span>
          </div>

          {pv.needsReviewDays > 0 && (
            <Banner tone="warning">
              ⚠️ <strong>{pv.needsReviewDays} day(s) still need a manager&rsquo;s review</strong> and
              are excluded from this run. ⛔ They are counted here on purpose — a run that silently
              skipped them would look identical to a run where nobody worked.
            </Banner>
          )}

          {pv.heldZeroCreditDays > 0 && (
            <Banner tone="warning">
              ⏸️ <strong>
                {pv.heldZeroCreditDays} day(s) were too short to credit a day at all
              </strong>{' '}
              and are <strong>held</strong> — not paid here, and deliberately{' '}
              <strong>not frozen</strong>. ⭐ The whole stint is waiting as overtime for a
              manager&rsquo;s decision; once decided, the next run pays it. ⛔ Held, not lost —
              paying them at ₱0 now would freeze them and put that overtime permanently out of
              reach.
            </Banner>
          )}

          {pv.unapprovedOtMinutes > 0 && (
            <Banner tone="warning">
              ⚠️ <strong>
                {Math.floor(pv.unapprovedOtMinutes / 60)}h {pv.unapprovedOtMinutes % 60}m of
                overtime is awaiting a manager&rsquo;s approval
              </strong>{' '}
              and is <strong>not</strong> in these figures. ⛔ Pending overtime is never paid
              unapproved — approve it on the attendance day, then preview again.
            </Banner>
          )}

          {pv.unratedEmployments.length > 0 && (
            <Banner tone="error">
              ⛔ <strong>No pay rate in force</strong> for{' '}
              {pv.unratedEmployments.map((u) => `${u.personName} (${u.days}d)`).join(', ')}. Set a
              rate below — a day priced at ₱0 is indistinguishable from a day nobody worked, so the
              run refuses rather than guessing.
            </Banner>
          )}

          {pv.unconfirmedRates.length > 0 && (
            <Banner tone="warning">
              ⚠️ <strong>Rates not confirmed:</strong> {pv.unconfirmedRates.join('; ')}. The figures below use them, but the run
              cannot be posted until the accountant approves them under
              Payroll rates (in the menu).
            </Banner>
          )}

          {pv.missingGovernmentIds.length > 0 && (
            <Banner tone="warning">
              ⚠️ <strong>Missing government numbers — not deducted:</strong>{' '}
              {pv.missingGovernmentIds
                .map((m) => `${m.personName} (${m.agency === 'sss' ? 'SSS' : m.agency === 'philhealth' ? 'PhilHealth' : 'Pag-IBIG'})`)
                .join(', ')}
              . An agency with no number on file is skipped for that person (both shares), and not caught up later; add the number on the
              staff page.
            </Banner>
          )}

          {pv.slips.length === 0 ? (
            <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
              Nothing payable in this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-1 pr-3 font-medium">Person</th>
                    <th className="py-1 pr-3 text-right font-medium">Days</th>
                    <th className="py-1 pr-3 text-right font-medium">Basic</th>
                    <th className="py-1 pr-3 text-right font-medium">OT + ND + Hol</th>
                    <th className="py-1 pr-3 text-right font-medium">Gross</th>
                    <th className="py-1 pr-3 text-right font-medium">SSS / PhilHealth / Pag-IBIG</th>
                    <th className="py-1 pr-3 text-right font-medium">Tax</th>
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
                      <td className="py-1.5 pr-3 text-right font-mono text-xs tabular-nums">
                        {peso(Number(s.sssEe))} / {peso(Number(s.philhealthEe))} / {peso(Number(s.pagibigEe))}
                        {s.skippedAgencies.length > 0 && (
                          <div className="font-sans text-warning-ink">
                            not deducted: no {s.skippedAgencies.map((a) => (a === 'sss' ? 'SSS' : a === 'philhealth' ? 'PhilHealth' : 'Pag-IBIG')).join(', ')} no.
                          </div>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {s.isMwe ? 'MWE' : peso(Number(s.withholding))}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-warning-ink">
                        {compare(money(s.advanceRecovered), ZERO) > 0 ? `−${peso(Number(s.advanceRecovered))}` : '—'}
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
              <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
                <span className={LABEL}>Pay from</span>
                <Select name="moneyAccountId" className="w-full">
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </label>
              <Input name="notes" placeholder="Notes (optional)" className="min-w-0 flex-1 basis-48" />
              <Button type="submit" variant="primary">
                Post {pv.slips.length} payslip(s)
              </Button>
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
                      <Select name="basis" defaultValue="daily" className="w-24">
                        <option value="daily">daily</option>
                        <option value="hourly">hourly</option>
                      </Select>
                      <input
                        name="amount"
                        inputMode="decimal"
                        placeholder="0.00"
                        // raw <input>: t343-s5-5v-number-boxes.test.ts scans the source for this tag; kit field tokens by hand
                        className="w-28 rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink"
                      />
                      <Input
                        name="effectiveFrom"
                        type="date"
                        defaultValue={periodStart}
                        className="w-40"
                      />
                      <Button type="submit" variant="secondary">
                        Save
                      </Button>
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
                <Badge status={run.status} />
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
                      {compare(money(s.advanceRecovered), ZERO) > 0 &&
                        ` (advance −${peso(Number(s.advanceRecovered))})`}
                      {` · SSS ${peso(Number(s.sssEe))}, PhilHealth ${peso(Number(s.philhealthEe))}, Pag-IBIG ${peso(Number(s.pagibigEe))}, tax ${peso(Number(s.withholding))}`}
                      {s.skippedAgencies.length > 0 &&
                        ` · not deducted: no ${s.skippedAgencies.map((x) => (x === 'sss' ? 'SSS' : x === 'philhealth' ? 'PhilHealth' : 'Pag-IBIG')).join(', ')} no.`}
                    </li>
                  ))}
                </ul>
              )}

              {run.status === 'posted' && (
                <form action={voidPayRunAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="runId" value={run.id} />
                  <Input name="reason" placeholder="Why void it?" className="min-w-0 flex-1 basis-48" />
                  <ConfirmDestructive
                    tier="admin-pin"
                    label="Void pay run"
                    consequence="Voids this pay run and reverses its entries. An administrator must approve with their own PIN."
                  />
                  <span className="text-xs text-neutral-500">
                    ⭐ Reverses the entries and unfreezes the days, so the period is payable again.
                  </span>
                </form>
              )}
            </div>
          ))
        )}
      </section>
    </Page>
  );
}

const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';
