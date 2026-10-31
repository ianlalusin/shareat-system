/**
 * T-500: the "Add a contribution row" form. Only the blocks that apply to the chosen agency are in it (see `rate-fields.ts` and
 * `AgencyBlocks.tsx`), each rate box reads as a percent, and Save is written out as "Save".
 */
import { PAYROLL_STATUTORY_RATE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import { Button, Field, FormGrid, FormSection, Input, Select } from '@/components/ui';
import { addStatutoryRateAction } from './actions';
import { AgencyProvider, AgencySelect, ForAgency, RateInput } from './AgencyBlocks';
import type { RateAgency } from './rate-fields';

export function StatutoryRateForm({ initialAgency = 'sss', initialValues = {} }: { initialAgency?: RateAgency; initialValues?: Record<string, string> }) {
  return (
    <CheckedForm rules={PAYROLL_STATUTORY_RATE_RULES} action={addStatutoryRateAction}>
      <AgencyProvider initialAgency={initialAgency}>
        <FormSection title="Agency and effective date">
          <FormGrid layout="fields">
            <div className="min-w-0 erp-field-code">
              <Field label="Agency">
                <AgencySelect name="agency" />
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
              <Field label="Employee rate" rule={PAYROLL_STATUTORY_RATE_RULES.eeRate}>
                <RateInput {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.eeRate)} defaultValue={initialValues.eeRate} />
              </Field>
            </div>
            <div className="min-w-0 erp-field-code">
              <Field label="Employer rate" rule={PAYROLL_STATUTORY_RATE_RULES.erRate}>
                <RateInput {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.erRate)} defaultValue={initialValues.erRate} />
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
            <ForAgency uses="step">
              <div className="min-w-0 erp-field-code">
                <Field label="Step" hint="SSS rounds pay to this" rule={PAYROLL_STATUTORY_RATE_RULES.step}>
                  <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.step)} className="w-full" />
                </Field>
              </div>
            </ForAgency>
          </FormGrid>
        </FormSection>
        <ForAgency uses="lowBand">
          <FormSection title="Pag-IBIG low band">
            <FormGrid layout="fields">
              <div className="min-w-0 erp-field-code">
                <Field label="Low band: pay up to" hint="Pay at or under this uses the low-band rate" rule={PAYROLL_STATUTORY_RATE_RULES.lowThreshold}>
                  <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.lowThreshold)} className="w-full" />
                </Field>
              </div>
              <div className="min-w-0 erp-field-code">
                <Field label="Low band: employee rate" rule={PAYROLL_STATUTORY_RATE_RULES.lowEeRate}>
                  <RateInput {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.lowEeRate)} defaultValue={initialValues.lowEeRate} />
                </Field>
              </div>
            </FormGrid>
          </FormSection>
        </ForAgency>
        <ForAgency uses="ec">
          <FormSection title="Employees’ compensation">
            <FormGrid layout="fields">
              <div className="min-w-0 erp-field-code">
                <Field label="EC: switch point" hint="Pay below this pays the lower EC amount" rule={PAYROLL_STATUTORY_RATE_RULES.ecThreshold}>
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
        </ForAgency>
        <FormSection title="Source">
          <FormGrid layout="fields">
            <div className="min-w-0 erp-field-long">
              <Field label="Where it comes from" hint="Circular or law" span="full" rule={PAYROLL_STATUTORY_RATE_RULES.sourceRef}>
                <Input {...nativeAttrs(PAYROLL_STATUTORY_RATE_RULES.sourceRef)} className="w-full" />
              </Field>
            </div>
            <div className="flex items-end">
              <Button type="submit" variant="primary" icon={null}>
                Save
              </Button>
            </div>
          </FormGrid>
        </FormSection>
      </AgencyProvider>
    </CheckedForm>
  );
}
