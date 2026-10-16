import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import {
  addMinimumWageAction,
  addStatutoryRateAction,
  addWithholdingBracketSetAction,
  confirmMinimumWageAction,
  confirmStatutoryRateAction,
  confirmWithholdingBracketSetAction,
  discardStatutoryRateAction,
} from './actions';
import { listStores, ratesView } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Button, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';

export const metadata = { title: 'Payroll rates — Shareat System' };
export const dynamic = 'force-dynamic';

const AGENCY_NAME = { sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG' } as const;
const FREQUENCY_NAME = { monthly: 'Monthly', semi_monthly: 'Semi-monthly', weekly: 'Weekly' } as const;

/**
 * `/payroll/rates`. T-190.
 *
 * The SSS / PhilHealth / Pag-IBIG tables, the withholding tax tables and each store's minimum wage. Every row starts UNCONFIRMED and a
 * payroll POST refuses until the rows it uses are confirmed. A confirmed row is never edited: a correction is a new row with a later
 * date. Admin only (`manage_payroll_rates`): whoever holds it is "the accountant".
 */
export default async function PayrollRatesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/payroll/rates');
  if (refusal) return refusal;
  const [view, stores] = await Promise.all([ratesView(actor.orgId), listStores(actor.orgId)]);

  return (
    <Page density="table" className="space-y-6">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">Payroll / Rates</p>
        <h1 className="text-2xl font-semibold">Payroll rates</h1>
        <PageDescription>
          The contribution and tax tables every payslip is computed from, each effective from a date. A new row is unconfirmed and unused until
          the accountant confirms it; a confirmed row can never be changed, so an old payslip can always be explained. To correct a rate, add
          a new row with a later date.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Contributions (SSS, PhilHealth, Pag-IBIG)</h2>
        {view.rates.length === 0 ? (
          <p className="text-sm text-neutral-500">No contribution rates yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {view.rates.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
                <span className="font-medium">{AGENCY_NAME[r.agency]}</span>
                <span className="font-mono text-xs">from {r.effectiveFrom}</span>
                <span className="font-mono text-xs">
                  employee {r.eeRate} · employer {r.erRate} · on {r.baseKind} pay
                </span>
                <span className="font-mono text-xs">
                  floor {r.floor ?? '-'} · ceiling {r.ceiling ?? '-'}
                </span>
                <span className="text-xs text-neutral-500">{r.sourceRef}</span>
                {r.confirmedAt ? (
                  <Badge tone="success" label="Approved" />
                ) : (
                  <>
                    <Badge tone="warning" label="Not yet approved" />
                    <form action={confirmStatutoryRateAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <Button type="submit" variant="secondary">
                        Approve
                      </Button>
                    </form>
                    <form action={discardStatutoryRateAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <Button type="submit" variant="secondary">
                        Discard
                      </Button>
                    </form>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        <details className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <summary className="cursor-pointer py-2.5 text-sm font-medium">Add a contribution row</summary>
          <form action={addStatutoryRateAction} className="mt-3">
<FormGrid>
            <Field label="Agency">
<Select name="agency" defaultValue="sss">
                <option value="sss">SSS</option>
                <option value="philhealth">PhilHealth</option>
                <option value="pagibig">Pag-IBIG</option>
              </Select>
</Field>
            <Field label="Effective from (the 1st of a month)">
<Input name="effectiveFrom" placeholder="2026-07-01" required className="w-full" />
</Field>
            <Field label="Counted on">
<Select name="baseKind" defaultValue="basic">
                <option value="basic">Basic pay</option>
                <option value="gross">Gross pay</option>
              </Select>
</Field>
            <Field label="Employee rate (0.05 is 5%)">
<Input name="eeRate" inputMode="decimal" required className="w-full" />
</Field>
            <Field label="Employer rate">
<Input name="erRate" inputMode="decimal" required className="w-full" />
</Field>
            <Field label="Floor (lowest pay it counts)">
<Input name="floor" inputMode="decimal" className="w-full" />
</Field>
            <Field label="Ceiling (highest pay it counts)">
<Input name="ceiling" inputMode="decimal" className="w-full" />
</Field>
            <Field label="Step (SSS rounds pay to this)">
<Input name="step" inputMode="decimal" className="w-full" />
</Field>
            <Field label="Low band: pay up to (Pag-IBIG)">
<Input name="lowThreshold" inputMode="decimal" className="w-full" />
</Field>
            <Field label="Low band: employee rate">
<Input name="lowEeRate" inputMode="decimal" className="w-full" />
</Field>
            <Field label="EC: switch point (SSS)">
<Input name="ecThreshold" inputMode="decimal" className="w-full" />
</Field>
            <Field label="EC below the switch point">
<Input name="ecLow" inputMode="decimal" className="w-full" />
</Field>
            <Field label="EC at or above it">
<Input name="ecHigh" inputMode="decimal" className="w-full" />
</Field>
            <Field label="Where it comes from (circular or law)" span="full">
<Input name="sourceRef" required className="w-full" />
</Field>
            <div className="flex items-end">
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </FormGrid>
</form>
        </details>
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Withholding tax tables</h2>
        {view.bracketSets.length === 0 ? (
          <p className="text-sm text-neutral-500">No withholding tables yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {view.bracketSets.map((b) => (
              <li key={`${b.frequency}-${b.effectiveFrom}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{FREQUENCY_NAME[b.frequency]}</span>
                <span className="font-mono text-xs">from {b.effectiveFrom}</span>
                <span className="text-xs text-neutral-500">
                  {b.rows} rows · {b.sourceRef}
                </span>
                {b.unconfirmed === 0 ? (
                  <Badge tone="success" label="Approved" />
                ) : (
                  <>
                    <Badge tone="warning" label="Not yet approved" />
                    <form action={confirmWithholdingBracketSetAction}>
                      <input type="hidden" name="frequency" value={b.frequency} />
                      <input type="hidden" name="effectiveFrom" value={b.effectiveFrom} />
                      <Button type="submit" variant="secondary">
                        Approve
                      </Button>
                    </form>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <details className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <summary className="cursor-pointer py-2.5 text-sm font-medium">Add a withholding table</summary>
          <form action={addWithholdingBracketSetAction} className="mt-3">
<FormGrid>
            <Field label="Pay frequency">
<Select name="frequency" defaultValue="semi_monthly">
                <option value="monthly">Monthly</option>
                <option value="semi_monthly">Semi-monthly</option>
                <option value="weekly">Weekly</option>
              </Select>
</Field>
            <Field label="Effective from">
<Input name="effectiveFrom" placeholder="2027-01-01" required className="w-full" />
</Field>
            <Field label="Rows, one per line: over, base tax, rate (e.g. 10417, 0, 0.15)" span="full">
<textarea
                name="rows"
                required
                rows={7}
                className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
</Field>
            <Field label="Where it comes from" span="full">
<Input name="sourceRef" required className="w-full" />
</Field>
            <div>
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </FormGrid>
</form>
        </details>
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Minimum wage by store</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          A person paid at or under their store&rsquo;s minimum daily wage is a minimum-wage earner and pays no withholding tax. A payroll run
          for a store refuses until it has a confirmed minimum wage.
        </p>
        {view.minimumWages.length === 0 ? (
          <p className="text-sm text-neutral-500">No minimum wages yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {view.minimumWages.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.storeName}</span>
                <span className="font-mono text-xs">
                  {m.dailyRate} a day from {m.effectiveFrom}
                </span>
                <span className="text-xs text-neutral-500">{m.wageOrderRef}</span>
                {m.confirmedAt ? (
                  <Badge tone="success" label="Approved" />
                ) : (
                  <>
                    <Badge tone="warning" label="Not yet approved" />
                    <form action={confirmMinimumWageAction}>
                      <input type="hidden" name="id" value={m.id} />
                      <Button type="submit" variant="secondary">
                        Approve
                      </Button>
                    </form>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <form action={addMinimumWageAction} className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
<FormGrid>
          <Field label="Store">
<Select name="storeId" defaultValue={stores[0]?.id}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
</Field>
          <Field label="Effective from">
<Input name="effectiveFrom" placeholder="2026-01-01" required className="w-full" />
</Field>
          <Field label="Minimum daily wage">
<Input name="dailyRate" inputMode="decimal" required className="w-full" />
</Field>
          <Field label="Wage order">
<Input name="wageOrderRef" required className="w-full" />
</Field>
          <div>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </div>
        </FormGrid>
</form>
      </section>
    </Page>
  );
}
