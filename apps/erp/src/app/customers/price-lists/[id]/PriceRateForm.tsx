'use client';
/**
 * T-649 - the "Set a rate" form on a price list. A rate is one of three things: a fixed price, the delivery cost + an amount, or the delivery cost + a percent
 * (the same three ways as the item pricing screen, ItemPricingFields). The one figure the chosen way needs is shown; a read-only line says what the figures typed so
 * far would charge against the item's delivery cost today. The preview comes from `previewListRateAction`, which asks `computeBranchPrice` itself.
 *
 * All three figure boxes stay in the form (a refused save puts the typing back by name); only the chosen way's is shown, and the action reads only that one.
 */
import { useMemo, type ReactNode } from 'react';
import { PRICE_SET_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm, useFormValues, useLookupCheck } from '@/components/forms';
import { Button, DialogActions, Field, FormGrid, Input, Select } from '@/components/ui';
import { peso } from '../../../../lib/format';
import { previewListRateAction, setPriceAction } from '../../actions';

export interface RateItemOption {
  id: string;
  name: string;
  code: string;
  baseUnit: string;
}

type Mode = 'fixed' | 'fixed_markup' | 'percent_markup';

const NAMES = ['itemId', 'pricingMode', 'markupAmount', 'markupPercent'] as const;

/** The form: ONE ruled record, so every control below sits lexically inside its own `rules` (T-440 S2 G2). */
export function PriceRateForm({ listId, items }: { listId: string; items: RateItemOption[] }) {
  return (
    <CheckedForm rules={PRICE_SET_RULES} action={setPriceAction} className="space-y-3">
      <input type="hidden" name="priceListId" value={listId} />
      <LiveMode>
        {(mode) => (
          <FormGrid>
            <Field label="Item" width="long" hint="From the item master. Item not listed? Add it under Items first." rule={PRICE_SET_RULES.itemId}>
              <Select {...nativeAttrs(PRICE_SET_RULES.itemId)} defaultValue="" className="w-full">
                <option value="" disabled>
                  {items.length === 0 ? 'No items yet' : 'Select…'}
                </option>
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} ({it.code}) — priced per {it.baseUnit}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Price" width="long" rule={PRICE_SET_RULES.pricingMode}>
              <Select {...nativeAttrs(PRICE_SET_RULES.pricingMode)} defaultValue="fixed" className="w-full">
                <option value="fixed">Fixed price</option>
                <option value="fixed_markup">Delivery cost + an amount</option>
                <option value="percent_markup">Delivery cost + a percent</option>
              </Select>
            </Field>
            <div hidden={mode !== 'fixed'}>
              <Field label="Rate (₱)" width="short" hint="Zero is allowed: a sample is genuinely free." rule={PRICE_SET_RULES.rate}>
                <Input {...nativeAttrs(PRICE_SET_RULES.rate)} inputMode="decimal" className="w-full" />
              </Field>
            </div>
            <div hidden={mode !== 'fixed_markup'}>
              <Field label="Amount over the cost (₱)" width="short" rule={PRICE_SET_RULES.markupAmount}>
                <Input {...nativeAttrs(PRICE_SET_RULES.markupAmount)} inputMode="decimal" className="w-full" />
              </Field>
            </div>
            <div hidden={mode !== 'percent_markup'}>
              <Field label="Percent over the cost (%)" width="short" rule={PRICE_SET_RULES.markupPercent}>
                <Input {...nativeAttrs(PRICE_SET_RULES.markupPercent)} inputMode="decimal" className="w-full" />
              </Field>
            </div>
            <Field label="Unit" width="short" hint="Optional.">
              <Input name="unit" placeholder="kg" className="w-full" />
            </Field>
          </FormGrid>
        )}
      </LiveMode>
      <DialogActions>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </DialogActions>
    </CheckedForm>
  );
}

/** Hooks need to sit INSIDE the form: watches it, hands the chosen way to the controls, then draws the live line. */
function LiveMode({ children }: { children: (mode: Mode) => ReactNode }) {
  const values = useFormValues(NAMES);
  const mode = (values?.pricingMode || 'fixed') as Mode;
  const itemId = values?.itemId ?? '';
  const inputs = useMemo(
    () => (values && itemId && mode !== 'fixed' ? { itemId, pricingMode: mode, markupAmount: values.markupAmount ?? '', markupPercent: values.markupPercent ?? '' } : null),
    [values, itemId, mode],
  );
  const preview = useLookupCheck(previewListRateAction, inputs);

  return (
    <div className="space-y-3">
      {children(mode)}
      {mode !== 'fixed' && (
        <p aria-live="polite" className="text-sm text-neutral-700 dark:text-neutral-300">
          {!itemId
            ? 'Choose an item to see its delivery cost.'
            : preview === null
              ? 'Looking up the delivery cost…'
              : preview.cost === null
                ? 'No delivery yet: this item has no price until its first delivery.'
                : preview.price !== null
                  ? `Delivery cost ${peso(preview.cost)} → ${peso(preview.price)}`
                  : `Delivery cost ${peso(preview.cost)}. Type the figure to see the price.`}
        </p>
      )}
    </div>
  );
}
