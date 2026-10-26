import { LOAN_ADD_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { INTEREST_METHODS, PAYMENT_FREQUENCIES, RATE_PERIODS } from '@shareat/db';
import { requirePageAccess } from '../../lib/page-access';
import { createLoanAction } from './actions';
import { METHOD_LABEL, listRegister, listStores, peso, today } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Button, FlashBanner, Input, LinkRow, RowLink, Select, FormModal, FormGrid, FormSection, type FieldProps } from '@/components/ui';

export const metadata = { title: 'Loans — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

export default async function LoansPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/loans');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, loans] = await Promise.all([listStores(actor.orgId), listRegister(actor.orgId)]);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const owed = loans
    .filter((l) => l.status === 'active')
    .reduce((sum, l) => sum + Number(l.position.outstanding), 0);

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">Loans</h1>
          <PageDescription>
            What the business has borrowed, what it has repaid, and what is left. Every figure here is
            summed from the ledger — <strong>there is no stored balance to go stale</strong>.
          </PageDescription>
        </div>
        <FormModal trigger="+ Record loan" title="Record a loan" size="lg"
          description="This records the agreement. No money moves until it is drawn: a signed loan that has not been drawn is a commitment, not a debt.">
            <CheckedForm rules={LOAN_ADD_RULES} action={createLoanAction} className="space-y-4">
              <>
                <FormSection title="Loan and lender">
                  <FormGrid layout="fields">
                    <div className="min-w-0 erp-field-name">
                      <Field rule={LOAN_ADD_RULES.name} label="What it is called">
                        <Input {...nativeAttrs(LOAN_ADD_RULES.name)}    placeholder="Grab cash advance" className="w-full" />
                      </Field>
                    </div>
                    <div className="min-w-0 erp-field-name">
                      <Field rule={LOAN_ADD_RULES.lenderName} label="Lender">
                        <Input {...nativeAttrs(LOAN_ADD_RULES.lenderName)}    placeholder="Grab" className="w-full" />
                      </Field>
                    </div>
                    <div className="min-w-0">
                      <Field rule={LOAN_ADD_RULES.storeId} label="Store">
                        <Select {...nativeAttrs(LOAN_ADD_RULES.storeId)}   defaultValue="" className="w-full">
                          <option value="">Choose a store…</option>
                          {stores.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ({s.code})
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    <div className="min-w-0">
                      <Field rule={LOAN_ADD_RULES.principalAmount} label="Amount agreed">
                        <input {...nativeAttrs(LOAN_ADD_RULES.principalAmount)}



                          placeholder="0.00"
                          className={INPUT}
                        />
                      </Field>
                    </div>
                  </FormGrid>
                </FormSection>
                <FormSection title="Interest">
                  <FormGrid layout="fields">
                    <div className="min-w-0">
                      <Field rule={LOAN_ADD_RULES.interestRate} label="Interest rate (%)">
                        <input {...nativeAttrs(LOAN_ADD_RULES.interestRate)} inputMode="decimal"



                          className={INPUT}
                        />
                      </Field>
                    </div>
                    {/* ⛔ No default, deliberately. In v1 an absent rate period meant ANNUAL on old rows and
                    MONTHLY on new ones, with nothing on the row to tell them apart — so the same "2"
                    described two very different debts. */}
                    <div className="min-w-0 erp-field-code">
                      <Field rule={LOAN_ADD_RULES.ratePeriod} label="…per" hint="A month is 30 days and a year is 365. Say which.">
                        <Select {...nativeAttrs(LOAN_ADD_RULES.ratePeriod)}   defaultValue="" className="w-full">
                          <option value="">Choose…</option>
                          {RATE_PERIODS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    <div className="min-w-0">
                      <Field label="How interest is charged">
                        <Select name="interestMethod" defaultValue="straight" className="w-full">
                          {INTEREST_METHODS.map((m) => (
                            <option key={m} value={m}>
                              {METHOD_LABEL[m] ?? m}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                  </FormGrid>
                </FormSection>
                <FormSection title="Repayment schedule">
                  <FormGrid layout="fields">
                    <div className="min-w-0 erp-field-code">
                      <Field label="Repaid">
                        <Select name="paymentFrequency" defaultValue="monthly" className="w-full">
                          {PAYMENT_FREQUENCIES.map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    <div className="min-w-0 erp-field-short">
                      <Field rule={LOAN_ADD_RULES.termPeriods} label="Number of payments">
                        <input {...nativeAttrs(LOAN_ADD_RULES.termPeriods)}    defaultValue={12} className={INPUT} />
                      </Field>
                    </div>
                    <div className="min-w-0 erp-field-date">
                      <Field rule={LOAN_ADD_RULES.startDate} label="Starts">
                        <Input {...nativeAttrs(LOAN_ADD_RULES.startDate)}  type="date"  defaultValue={today()} className="w-full" />
                      </Field>
                    </div>
                  </FormGrid>
                </FormSection>
              </>
              <Field label="Notes">
                <Input name="notes" className="w-full" />
              </Field>

              <Button type="submit" variant="primary">
                Record loan
              </Button>
            </CheckedForm>
        </FormModal>
      </div>

      <FlashBanner flash={sp} />

      {loans.length > 0 && (
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <span className="text-neutral-600 dark:text-neutral-400">Still owed, across active loans</span>{' '}
          <span className="font-mono font-medium tabular-nums">{peso(owed)}</span>
        </div>
      )}

      {/* ── The register ─────────────────────────────────────────────────────────────── */}
      {loans.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Loan</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Terms</th>
                <th className="px-3 py-2 text-right font-medium">Drawn</th>
                <th className="px-3 py-2 text-right font-medium">Repaid</th>
                <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => (
                <LinkRow
                  key={l.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    l.status === 'active' ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2">
                    <RowLink href={`/loans/${l.id}`}>
                      {l.name}
                    </RowLink>
                    <div className="text-xs text-neutral-400 dark:text-neutral-600">
                      {l.lenderName}
                    </div>
                  </td>
                  <td className="px-3 py-2">{storeById.get(l.storeId)?.code ?? '—'}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {/* ⚠️ The rate is meaningless without its period — "2%" is twelve times more
                        per year when it is monthly, and v1 had rows where nobody had said which. */}
                    {Number(l.interestRate)}% per {l.ratePeriod} · {l.termPeriods}{' '}
                    {l.paymentFrequency}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(l.position.disbursed)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(l.position.principalPaid)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(l.position.outstanding)}
                  </td>
                  <td className="px-3 py-2 text-xs"><Badge status={l.status} /></td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No loans recorded.</p>
      )}
    </Page>
  );
}

const INPUT =
  'w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink';

function Field({ width, label, hint, rule, children }: FieldProps) {
  const body = <><span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>{children}{hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}</>;
  const sizing = width ? ` erp-field-${width}` : '';
  if (!rule) return <label className={`flex min-w-0 flex-col gap-1${sizing}`}>{body}</label>;
  return <div className={`min-w-0${sizing}`}><label className="flex min-w-0 flex-col gap-1">{body}</label><FieldCheck rule={rule} /></div>;
}
