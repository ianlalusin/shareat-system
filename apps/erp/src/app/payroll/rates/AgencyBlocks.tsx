'use client';
/**
 * T-500: the client pieces of the "Add a contribution row" form. The chosen agency lives in a context; `ForAgency` leaves a block
 * out of the form (so it is never submitted) when that agency does not use it; `RateInput` says what a rate is as a percent.
 * Changing the agency first clears the blocks about to disappear, so a value typed for another agency can neither be sent nor
 * keep Save off. The rule-bound controls themselves are rendered by the server form (`StatutoryRateForm.tsx`).
 */
import { createContext, useContext, useState, type ChangeEvent, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Input, Select } from '@/components/ui';
import { agencyFields, hiddenFieldNames, percentText, rateExceedsOne, type RateAgency } from './rate-fields';

const AgencyContext = createContext<{ agency: RateAgency; set(next: RateAgency): void }>({ agency: 'sss', set: () => {} });

export function AgencyProvider({ initialAgency = 'sss', children }: { initialAgency?: RateAgency; children?: ReactNode }) {
  const [agency, set] = useState<RateAgency>(initialAgency);
  return <AgencyContext.Provider value={{ agency, set }}>{children}</AgencyContext.Provider>;
}

export function AgencySelect({ name }: { name: string }) {
  const { agency, set } = useContext(AgencyContext);
  const onChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as RateAgency;
    const form = e.target.form;
    for (const hidden of hiddenFieldNames(next)) {
      const el = form?.elements.namedItem(hidden);
      if (el instanceof HTMLInputElement && el.value !== '') {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    set(next);
  };
  return (
    <Select name={name} defaultValue={agency} onChange={onChange}>
      <option value="sss">SSS</option>
      <option value="philhealth">PhilHealth</option>
      <option value="pagibig">Pag-IBIG</option>
    </Select>
  );
}

/** Shows its children only when the chosen agency uses this block. */
export function ForAgency({ uses, children }: { uses: 'step' | 'lowBand' | 'ec'; children?: ReactNode }) {
  const { agency } = useContext(AgencyContext);
  return agencyFields(agency)[uses] ? <>{children}</> : null;
}

/** A rate box: the input plus "enter 0.05 for 5%" and, as you type, "= 5%". */
export function RateInput(props: ComponentPropsWithoutRef<typeof Input>) {
  const [v, setV] = useState(typeof props.defaultValue === 'string' ? props.defaultValue : '');
  const pct = percentText(v);
  return (
    <>
      <Input {...props} onChange={(e) => setV(e.target.value)} className="w-full" />
      <span className="mt-1 block text-xs text-muted">
        enter 0.05 for 5%
        {pct !== null ? <strong className={`ml-2 ${rateExceedsOne(v) ? 'text-danger' : 'text-ink'}`}>= {pct}</strong> : null}
      </span>
    </>
  );
}
