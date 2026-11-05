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
              <Field label="Charge" width="name">
                <Select name="sourceEntryId" className="w-full">
                  {view.waiting.map((w) => (
                    <option key={w.entryId} value={w.entryId}>
                      {chargeSourceLabel(w.sourceType)} {w.entryDate} · left {peso(Number(w.left))}
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
            <Button type="submit" variant="primary">Save</Button>
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
              <li key={a.id} className="space-y-1 py-1.5">
                <div className="flex flex-wrap justify-between gap-2">
                  <span>{chargeSourceLabel(a.sourceType)} · signed {a.signedOn}</span>
                  <span className="font-mono tabular-nums">
                    agreed {peso(Number(a.amount))} · repaid {peso(Number(a.recovered))} · left {peso(Number(a.left))} · max {peso(Number(a.perPayrollLimit))} per payroll
                  </span>
                </div>
                {view.canAct && (
                  <form action={cancelDeductionAgreementAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="employmentId" value={employmentId} />
                    <input type="hidden" name="agreementId" value={a.id} />
                    <Input name="reason" placeholder="Why cancel this agreement?" className="min-w-0 flex-1 basis-48" />
                    <Button type="submit">Cancel</Button>
                  </form>
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
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>{chargeSourceLabel(a.sourceType)} · signed {a.signedOn} <Badge status={a.status} /></span>
                <span className="font-mono tabular-nums">agreed {peso(Number(a.amount))} · repaid {peso(Number(a.recovered))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
