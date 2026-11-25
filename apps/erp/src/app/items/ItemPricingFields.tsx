'use client';
/**
 * T-638 - the fields of the "Price to stores" dialog on /items/[id]: the pricing rule, the one figure that rule needs, the
 * optional margin alert, and a live line saying what the figures typed so far would charge against the cost today.
 *
 * All three figure boxes stay in the form (a refused save puts the typing back by name); only the chosen rule's is shown.
 * The preview comes from `previewItemPricingAction`, which asks `computeBranchPrice` itself, so the screen never does the maths.
 */
import { useMemo, type ReactNode } from 'react';
import { ITEMS_PRICING_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { EditableRecord, useFormValues, useLookupCheck } from '@/components/forms';
import { Field, FormGrid, Input, Select } from '@/components/ui';
import type { TypedView } from '@/lib/keep-typing';
import { peso } from '../../lib/format';
import { previewItemPricingAction, setItemPricingAction } from './actions';

export interface ItemPricingFieldsProps {
  itemId: string;
  itemName: string;
  /** T-389: `typedFor(sp, ITEM_PRICING, item.id, personId)`, what was typed before a refused save. */
  typed: TypedView | null;
  mode: 'fixed' | 'fixed_markup' | 'percent_markup';
  fixedAmount: string;
  fixedMarkupAmount: string;
  markupPercent: string;
  marginAlertThresholdPct: string;
  /** The cost the markup rules add to, as a plain decimal; null when no delivery has landed yet. */
  basis: string | null;
}

const NAMES = ['pricingMode', 'fixedAmount', 'fixedMarkupAmount', 'markupPercent', 'marginAlertThresholdPct'] as const;

/** The form: ONE ruled record, so every control below sits lexically inside its own `rules` (T-440 S2 G2). */
export function ItemPricingFields(p: ItemPricingFieldsProps) {
  return (
    <EditableRecord
      action={setItemPricingAction}
      rules={ITEMS_PRICING_RULES}
      quiet
      label={`${p.itemName} price to stores`}
      hidden={{ itemId: p.itemId }}
      typed={p.typed}
    >
      <LiveMode p={p}>
        {(mode) => (
          <FormGrid>
            <Field label="How the price is worked out" width="long" rule={ITEMS_PRICING_RULES.pricingMode}>
              <Select {...nativeAttrs(ITEMS_PRICING_RULES.pricingMode)} defaultValue={p.mode} className="w-full">
                <option value="percent_markup">Delivery cost + a percent</option>
                <option value="fixed_markup">Delivery cost + an amount</option>
                <option value="fixed">A fixed price</option>
              </Select>
            </Field>
            <div hidden={mode !== 'fixed'}>
              <Field label="Fixed price (₱)" width="short" rule={ITEMS_PRICING_RULES.fixedAmount}>
                <Input {...nativeAttrs(ITEMS_PRICING_RULES.fixedAmount)} defaultValue={p.fixedAmount} className="w-full" />
              </Field>
            </div>
            <div hidden={mode !== 'fixed_markup'}>
              <Field label="Markup (₱)" width="short" rule={ITEMS_PRICING_RULES.fixedMarkupAmount}>
                <Input {...nativeAttrs(ITEMS_PRICING_RULES.fixedMarkupAmount)} defaultValue={p.fixedMarkupAmount} className="w-full" />
              </Field>
            </div>
            <div hidden={mode !== 'percent_markup'}>
              <Field label="Markup (%)" width="short" rule={ITEMS_PRICING_RULES.markupPercent}>
                <Input {...nativeAttrs(ITEMS_PRICING_RULES.markupPercent)} defaultValue={p.markupPercent} className="w-full" />
              </Field>
            </div>
            <Field label="Margin alert (%), optional" width="short" rule={ITEMS_PRICING_RULES.marginAlertThresholdPct}>
              <Input {...nativeAttrs(ITEMS_PRICING_RULES.marginAlertThresholdPct)} defaultValue={p.marginAlertThresholdPct} className="w-full" />
            </Field>
          </FormGrid>
        )}
      </LiveMode>
    </EditableRecord>
  );
}

/** Watches the form (hooks need to sit INSIDE the record) and hands the chosen rule to the controls, then draws the live line. */
function LiveMode({ p, children }: { p: ItemPricingFieldsProps; children: (mode: ItemPricingFieldsProps['mode']) => ReactNode }) {
  const values = useFormValues(NAMES);
  const mode = (values?.pricingMode || p.mode) as ItemPricingFieldsProps['mode'];
  const inputs = useMemo(
    () =>
      values
        ? {
            itemId: p.itemId,
            pricingMode: mode,
            fixedAmount: values.fixedAmount ?? '',
            fixedMarkupAmount: values.fixedMarkupAmount ?? '',
            markupPercent: values.markupPercent ?? '',
            marginAlertThresholdPct: values.marginAlertThresholdPct ?? '',
          }
        : null,
    [values, mode, p.itemId],
  );
  const preview = useLookupCheck(previewItemPricingAction, inputs);
  const needsBasis = mode !== 'fixed';

  return (
    <div className="space-y-3">
      {children(mode)}
      <p aria-live="polite" className="text-sm text-neutral-700 dark:text-neutral-300">
        {needsBasis && p.basis === null
          ? 'No delivery has landed yet, so this rule has nothing to add to. Orders use the manual cost until one does.'
          : preview
            ? `${p.basis !== null ? `With the delivery cost at ${peso(p.basis)}, ` : ''}this charges ${peso(preview.price)}${preview.marginPct !== null ? ` (${preview.marginPct}% margin)` : ''}.${preview.marginAlert ? ' Below your margin alert.' : ''}`
            : 'Type the figure to see the price it gives.'}
      </p>
    </div>
  );
}
