import { PAYROLL_BRACKET_SET_RULES, PAYROLL_MIN_WAGE_RULES, PAYROLL_STATUTORY_RATE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import {
  addMinimumWageAction,
  addStatutoryRateAction,
  addWithholdingBracketSetAction,
  confirmMinimumWageAction,
  confirmStatutoryRateAction,
  confirmWithholdingBracketSetAction,
  discardMinimumWageAction,
  discardStatutoryRateAction,
  discardWithholdingBracketSetAction,
  saveStatutoryEmployerAction,
} from './actions';
import { employersView, listStores, ratesView } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Button, CardGrid, Field, FlashBanner, FormGrid, FormModal, FormSection, HelpTip, Input, Select } from '@/components/ui';

export const metadata = { title: 'Payroll rates — Shareat System' };
export const dynamic = 'force-dynamic';

const AGENCY_NAME = { sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG' } as const;
const EMPLOYER_AGENCIES = [
  { value: 'sss', label: 'SSS' },
  { value: 'philhealth', label: 'PhilHealth' },
  { value: 'pagibig', label: 'Pag-IBIG' },
  { value: 'bir', label: 'BIR' },
] as const;
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
  const [view, stores, employerView] = await Promise.all([ratesView(actor.orgId), listStores(actor.orgId), employersView(actor.orgId)]);

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

      {/* T-448: the three cards share a row when they fit; each add form is a modal opened from its header. */}
      <CardGrid min="lg">
      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Contributions (SSS, PhilHealth, Pag-IBIG)</h2>
          <FormModal trigger="+ Add row" triggerVariant="secondary" triggerLabel="Add a contribution row" title="Add a contribution row" size="lg">
            <CheckedForm rules={PAYROLL_STATUTORY_RATE_RULES} action={addStatutoryRateAction}>
            <>
              <FormSection title="Agency and effective date">
                <FormGrid layout="fields">
                  <div className="min-w-0 erp-field-code">
                    <Field label="Agency">
                      <Select name="agency" defaultValue="sss">
                        <option value="sss">SSS</option>
                        <option value="philhealth">PhilHealth</option>
                        <option value="pagibig">Pag-IBIG</option>
                      </Select>
                    </Field>
                  </div>
                  <div className="min-w-0 erp-field-date">
                    <Field label="Effective from" hint="The 1st of a month" rule={PAYROLL_STATUTORY_RATE_RULES.effectiveFrom}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.effectiveFrom)} placeholder="2026-07-01" className="w-full" />
                    </Field>
                  </div>
                  <div className="min-w-0 erp-field-code">
                    <Field label="Counted on">
                      <Select name="baseKind" defaultValue="basic">
                        <option value="basic">Basic pay</option>
                        <option value="gross">Gross pay</option>
                      </Select>
                    </Field>
                  </div>
                </FormGrid>
              </FormSection>
              <FormSection title="Contribution rates">
                <FormGrid layout="fields">
                  <div className="min-w-0 erp-field-code">
                    <Field label="Employee rate" hint="0.05 is 5%" rule={PAYROLL_STATUTORY_RATE_RULES.eeRate}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.eeRate)} className="w-full" />
                    </Field>
                  </div>
                  <div className="min-w-0 erp-field-code">
                    <Field label="Employer rate" rule={PAYROLL_STATUTORY_RATE_RULES.erRate}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.erRate)} className="w-full" />
                    </Field>
                  </div>
                </FormGrid>
              </FormSection>
              <FormSection title="Pay bands">
                <FormGrid layout="fields">
                  <div className="min-w-0 erp-field-code">
                    <Field label="Floor" hint="Lowest pay it counts" rule={PAYROLL_STATUTORY_RATE_RULES.floor}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.floor)} className="w-full" />
                    </Field>
                  </div>
                  <div className="min-w-0 erp-field-code">
                    <Field label="Ceiling" hint="Highest pay it counts" rule={PAYROLL_STATUTORY_RATE_RULES.ceiling}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.ceiling)} className="w-full" />
                    </Field>
                  </div>
                  <div className="min-w-0 erp-field-code">
                    <Field label="Step" hint="SSS rounds pay to this" rule={PAYROLL_STATUTORY_RATE_RULES.step}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.step)} className="w-full" />
                    </Field>
                  </div>
                </FormGrid>
              </FormSection>
              <FormSection title="Pag-IBIG low band">
                <FormGrid layout="fields">
                  <div className="min-w-0 erp-field-code">
                    <Field label="Low band: pay up to" hint="Pag-IBIG" rule={PAYROLL_STATUTORY_RATE_RULES.lowThreshold}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.lowThreshold)} className="w-full" />
                    </Field>
                  </div>
                  <div className="min-w-0 erp-field-code">
                    <Field label="Low band: employee rate" rule={PAYROLL_STATUTORY_RATE_RULES.lowEeRate}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.lowEeRate)} className="w-full" />
                    </Field>
                  </div>
                </FormGrid>
              </FormSection>
              <FormSection title="Employees’ compensation">
                <FormGrid layout="fields">
                  <div className="min-w-0 erp-field-code">
                    <Field label="EC: switch point" hint="SSS" rule={PAYROLL_STATUTORY_RATE_RULES.ecThreshold}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.ecThreshold)} className="w-full" />
                    </Field>
                  </div>
                  <div className="min-w-0 erp-field-code">
                    <Field label="EC below the switch point" rule={PAYROLL_STATUTORY_RATE_RULES.ecLow}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.ecLow)} className="w-full" />
                    </Field>
                  </div>
                  <div className="min-w-0 erp-field-code">
                    <Field label="EC at or above it" rule={PAYROLL_STATUTORY_RATE_RULES.ecHigh}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.ecHigh)} className="w-full" />
                    </Field>
                  </div>
                </FormGrid>
              </FormSection>
              <FormSection title="Source">
                <FormGrid layout="fields">
                  <div className="min-w-0 erp-field-long">
                    <Field label="Where it comes from" hint="Circular or law" span="full" rule={PAYROLL_STATUTORY_RATE_RULES.sourceRef}>
                      <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.sourceRef)} className="w-full" />
                    </Field>
                  </div>
                  <div className="flex items-end">
                    <Button type="submit" variant="primary">
                      Save
                    </Button>
                  </div>
                </FormGrid>
              </FormSection>
            </>
            </CheckedForm>
          </FormModal>
        </div>
        {view.rates.length === 0 ? (
          <p className="text-sm text-neutral-500">No contribution rates yet. Add one each for SSS, PhilHealth and Pag-IBIG, then approve each one. Payroll cannot post until all three are approved.</p>
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

      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Withholding tax tables</h2>
          <FormModal trigger="+ Add table" triggerVariant="secondary" triggerLabel="Add a withholding table" title="Add a withholding table" size="md">
            <CheckedForm rules={PAYROLL_BRACKET_SET_RULES} action={addWithholdingBracketSetAction}>
              <FormGrid layout="fields">
                <Field label="Pay frequency" width="code">
                  <Select name="frequency" defaultValue="semi_monthly">
                    <option value="monthly">Monthly</option>
                    <option value="semi_monthly">Semi-monthly</option>
                    <option value="weekly">Weekly</option>
                  </Select>
                </Field>
                <Field label="Effective from" width="date" rule={PAYROLL_BRACKET_SET_RULES.effectiveFrom}>
                  <Input {...nativeAttrs(PAYROLL_BRACKET_SET_RULES.effectiveFrom)} placeholder="2027-01-01" className="w-full" />
                </Field>
                <Field label="Rows" hint="One per line: over, base tax, rate (e.g. 10417, 0, 0.15)" span="full" rule={PAYROLL_BRACKET_SET_RULES.rows}>
                  <textarea {...nativeAttrs(PAYROLL_BRACKET_SET_RULES.rows)}
                    rows={7}
                    className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </Field>
                <Field label="Where it comes from" width="long" rule={PAYROLL_BRACKET_SET_RULES.sourceRef}>
                  <Input {...nativeAttrs(PAYROLL_BRACKET_SET_RULES.sourceRef)} className="w-full" />
                </Field>
                <div className="!flex-none self-end">
                  <Button type="submit" variant="primary">
                    Save
                  </Button>
                </div>
              </FormGrid>
            </CheckedForm>
          </FormModal>
        </div>
        {view.bracketSets.length === 0 ? (
          <p className="text-sm text-neutral-500">No withholding tables yet. Add a withholding table (the BIR brackets) for your pay frequency, then approve it.</p>
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
                    <form action={discardWithholdingBracketSetAction}>
                      <input type="hidden" name="frequency" value={b.frequency} />
                      <input type="hidden" name="effectiveFrom" value={b.effectiveFrom} />
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
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <h2 className="text-sm font-medium">Minimum wage by store</h2>
            <HelpTip label="Minimum wage by store">
              A person paid at or under their store&rsquo;s minimum daily wage is a minimum-wage earner and pays no withholding tax. A payroll run
              for a store refuses until it has a confirmed minimum wage.
            </HelpTip>
          </div>
          <FormModal trigger="+ Add wage" triggerVariant="secondary" triggerLabel="Add a minimum wage" title="Add a minimum wage" size="sm">
            <CheckedForm rules={PAYROLL_MIN_WAGE_RULES} action={addMinimumWageAction}>
              <FormGrid layout="fields">
                <Field label="Store" width="name">
                  <Select name="storeId" defaultValue={stores[0]?.id}>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Effective from" width="date" rule={PAYROLL_MIN_WAGE_RULES.effectiveFrom}>
                  <Input {...nativeAttrs(PAYROLL_MIN_WAGE_RULES.effectiveFrom)} placeholder="2026-01-01" className="w-full" />
                </Field>
                <Field label="Minimum daily wage" width="code" rule={PAYROLL_MIN_WAGE_RULES.dailyRate}>
                  <Input {...nativeAttrs(PAYROLL_MIN_WAGE_RULES.dailyRate)} className="w-full" />
                </Field>
                <Field label="Wage order" width="name" rule={PAYROLL_MIN_WAGE_RULES.wageOrderRef}>
                  <Input {...nativeAttrs(PAYROLL_MIN_WAGE_RULES.wageOrderRef)} className="w-full" />
                </Field>
                <div className="!flex-none self-end">
                  <Button type="submit" variant="primary">
                    Save
                  </Button>
                </div>
              </FormGrid>
            </CheckedForm>
          </FormModal>
        </div>
        {view.minimumWages.length === 0 ? (
          <p className="text-sm text-neutral-500">No minimum wages yet. Add a minimum wage for each store, then approve it.</p>
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
                    <form action={discardMinimumWageAction}>
                      <input type="hidden" name="id" value={m.id} />
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
      </section>
      </CardGrid>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex items-center gap-1">
          <h2 className="text-sm font-medium">Employer numbers</h2>
          <HelpTip label="Employer numbers">
            The company&rsquo;s own number at each agency, and the day of the FOLLOWING month the payment is due. A payment to an agency is
            refused until its employer number is on file. BIR has no employer number: it uses the company TIN.
          </HelpTip>
        </div>
        <ul className="space-y-2 text-sm">
          {EMPLOYER_AGENCIES.map((a) => {
            const row = employerView.employers.find((e) => e.agency === a.value);
            return (
              <li key={a.value} className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
                <div className="min-w-24">
                  <span className="font-medium">{a.label}</span>
                  <div className="font-mono text-xs text-neutral-500">
                    {a.value === 'bir' ? (employerView.tin ? `TIN ${employerView.tin}` : 'No TIN on file') : (row?.employerNo ?? 'No number yet')}
                    {' · '}
                    {row ? `due day ${row.dueDay}` : 'no due day yet'}
                  </div>
                </div>
                <form action={saveStatutoryEmployerAction} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="agency" value={a.value} />
                  {a.value !== 'bir' && (
                    <Field label="Employer number" width="name">
                      <Input name="employerNo" defaultValue={row?.employerNo ?? ''} className="w-full" />
                    </Field>
                  )}
                  {a.value === 'bir' && <input type="hidden" name="employerNo" value="" />}
                  <Field label="Due day (1-31)" width="code">
                    <Input name="dueDay" defaultValue={row ? String(row.dueDay) : ''} className="w-full" />
                  </Field>
                  <Button type="submit" variant="secondary">
                    Save
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      </section>
    </Page>
  );
}
