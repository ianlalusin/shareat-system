import { PAYROLL_DEDUCTION_AGREEMENT_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import { PhotoUpload } from '@/components/upload/PhotoUpload';
import { Badge, Banner, Button, Field, FormGrid, Input, Select } from '@/components/ui';
import { cancelDeductionAgreementAction, recordDeductionAgreementAction } from '../actions';
import { chargeSourceLabel } from '../deduction-labels';
import type { DeductionAgreementsView } from '../lib';
import { peso } from '../lib';

/**
 * T-519 R7 - "Charges and repayment agreements". The caller passes `null` (nothing is drawn) to anyone without `run_payroll` at the store.
 * A charge stays owed; payroll takes it only under a signed agreement, at most the cap's share of that run's wages.
 */
export function DeductionAgreementsSection({ view, employmentId, storeId }: { view: DeductionAgreementsView | null; employmentId: string; storeId: string }) {
  if (!view) return null;
  const active = view.agreements.filter((a) => a.status === 'active');
  const history = view.agreements.filter((a) => a.status !== 'active');
  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="font-medium">Charges and repayment agreements</h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        A charge against this person is repaid from pay only under an agreement they signed after being told and given a chance to explain.
        Without one it stays owed and payroll leaves it alone. Payroll takes at most {view.capPercent}% of a run&rsquo;s wages (set by law; read-only here).
      </p>

      <div className="space-y-1 text-sm">
        <h3 className="font-medium">Waiting for the employee&rsquo;s signed agreement</h3>
        {view.waiting.length === 0 ? (
          <p className="text-neutral-500 dark:text-neutral-400">No charge is waiting.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {view.waiting.map((w) => (
              <li key={w.entryId} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span>{chargeSourceLabel(w.sourceType)} · {w.entryDate}</span>
                <span className="font-mono tabular-nums">{peso(Number(w.amount))} · left {peso(Number(w.left))}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {view.canAct && view.waiting.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Record signed agreement</h3>
          <CheckedForm rules={PAYROLL_DEDUCTION_AGREEMENT_RULES} action={recordDeductionAgreementAction} className="space-y-3">
            <input type="hidden" name="employmentId" value={employmentId} />
            <FormGrid layout="fields">
              <Field label="Charge" width="full" span="full">
                <Select name="sourceEntryId" className="w-full">
                  {view.waiting.map((w) => (
                    <option key={w.entryId} value={w.entryId}>
                      {chargeSourceLabel(w.sourceType)} · {w.entryDate} · {peso(Number(w.left))} left
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Agreed amount" width="code" rule={PAYROLL_DEDUCTION_AGREEMENT_RULES.amount}>
                <Input {...nativeAttrs(PAYROLL_DEDUCTION_AGREEMENT_RULES.amount)} className="w-full font-mono" />
              </Field>
              <Field label="Limit per payroll" width="code" rule={PAYROLL_DEDUCTION_AGREEMENT_RULES.perPayrollLimit}>
                <Input {...nativeAttrs(PAYROLL_DEDUCTION_AGREEMENT_RULES.perPayrollLimit)} className="w-full font-mono" />
              </Field>
              <Field label="Notice given" width="date" rule={PAYROLL_DEDUCTION_AGREEMENT_RULES.noticeGivenAt}>
                <Input type="date" {...nativeAttrs(PAYROLL_DEDUCTION_AGREEMENT_RULES.noticeGivenAt)} className="w-full" />
              </Field>
              <Field label="Signed on" width="date" rule={PAYROLL_DEDUCTION_AGREEMENT_RULES.signedOn}>
                <Input type="date" {...nativeAttrs(PAYROLL_DEDUCTION_AGREEMENT_RULES.signedOn)} className="w-full" />
              </Field>
            </FormGrid>
            <Field label={'What the employee said (write "none given" if nothing)'} rule={PAYROLL_DEDUCTION_AGREEMENT_RULES.employeeExplanation}>
              <Input {...nativeAttrs(PAYROLL_DEDUCTION_AGREEMENT_RULES.employeeExplanation)} className="w-full" />
            </Field>
            <PhotoUpload name="scan" purpose="staff_deduction_agreement" label="Scan of the signed agreement" storeId={storeId} />
            <Button type="submit" variant="primary" icon={null}>Record agreement</Button>
          </CheckedForm>
        </div>
      )}
      {!view.canAct && <Banner tone="info">You cannot record or cancel an agreement for a charge against yourself. Ask another payroll user.</Banner>}

      <div className="space-y-1 text-sm">
        <h3 className="font-medium">Active agreements</h3>
        {active.length === 0 ? (
          <p className="text-neutral-500 dark:text-neutral-400">None.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {active.map((a) => (
              <li key={a.id} className="space-y-1 py-2">
                <AgreementSummary a={a} />
                <div className="flex flex-wrap justify-between gap-2 font-mono tabular-nums">
                  <span>agreed {peso(Number(a.amount))} · repaid {peso(Number(a.recovered))} · {peso(Number(a.left))} left</span>
                  <span>max {peso(Number(a.perPayrollLimit))} per payroll</span>
                </div>
                {view.canAct && (
                  <details>
                    <summary className="inline-block cursor-pointer py-1 text-sm underline underline-offset-4">Cancel agreement</summary>
                    <form action={cancelDeductionAgreementAction} className="mt-1 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="employmentId" value={employmentId} />
                      <input type="hidden" name="agreementId" value={a.id} />
                      <Input
                        name="reason"
                        aria-label={`Reason for cancelling the ${chargeSourceLabel(a.sourceType)} agreement of ${a.signedOn}`}
                        placeholder="Why cancel this agreement?"
                        className="min-w-0 flex-1 basis-48 placeholder:text-neutral-500 dark:placeholder:text-neutral-400"
                      />
                      <Button type="submit">Cancel agreement</Button>
                    </form>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {history.length > 0 && (
        <div className="space-y-1 text-sm">
          <h3 className="font-medium">History</h3>
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {history.map((a) => (
              <li key={a.id} className="space-y-1 py-2">
                <AgreementSummary a={a} />
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono tabular-nums">
                  <span>agreed {peso(Number(a.amount))} · repaid {peso(Number(a.recovered))}</span>
                  <Badge status={a.status} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

type AgreementRow = DeductionAgreementsView['agreements'][number];

/** Who and what an agreement is: charge, charge date, signed date, what the employee said (cut short, full text on hover) and the signed scan. */
function AgreementSummary({ a }: { a: AgreementRow }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="font-medium">{chargeSourceLabel(a.sourceType)} · {a.chargeDate}</span>
      <span>signed {a.signedOn}</span>
      <span className="min-w-0 max-w-full truncate text-neutral-500 dark:text-neutral-400" title={a.explanation}>&ldquo;{a.explanation}&rdquo;</span>
      {a.evidenceFileId && (
        <a href={`/files/${a.evidenceFileId}`} target="_blank" rel="noreferrer" className="inline-block py-1 text-sm underline underline-offset-4">View signed scan</a>
      )}
    </div>
  );
}
