'use client';

/**
 * InvoicePartsPicker - T-502 section 12. "Which part of this bill?" for an expense form.
 *
 * An expense is one CATEGORY slice of an itemised invoice, so instead of a free category select the form offers the invoice's
 * parts (its lines grouped by their items' category, plus Uncategorised and Fees), each with what is left to record. Picking a part
 * pre-fills Particulars (from the part's item names) and the first payment (the amount left). For Uncategorised / Fees the person
 * also picks the category. A bill with no lines gets a panel linking to the invoice page, and Save stays off.
 *
 * It posts: `categoryId` (hidden, resolved), `partKey`, `pickedCategoryId`, `particulars`, and (with payments) the MoneyLines rows.
 * The server still judges everything (`createExpense`: itemised rule, per-part room); this only makes the right choice easy.
 *
 * The invoice is either followed from a select in the same form (`invoiceField`, /expenses/new) or fixed (`fixedInvoiceId`, the
 * invoice page's own modal and the draft editor).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { FieldCheck } from '@/components/forms';
import { ACTION_LINK } from '@/components/action-link';
import { Banner, Input, Select } from '@/components/ui';
import { InvoiceMoneyLines, type InvoiceSupplierOption } from '@/components/money/InvoiceMoneyLines';
import type { MoneyLinesProps } from '@/components/money/MoneyLines';
import { hasLeft, particularsOf, type CategoryChoice, type InvoicePartsView, type PartView } from './parts-types';

const peso = (v: string | number) => `₱${Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const GROUPS: Array<CategoryChoice['group']> = ['COGS', 'OPEX', 'PERSONAL', 'CAPEX'];

type PaymentProps = Omit<MoneyLinesProps, 'direction' | 'supplierId' | 'supplierName' | 'supplierCreditTermsDays' | 'initialLines'>;

export interface InvoicePartsPickerProps {
  /** Every invoice the form may pick, by id. */
  views: Record<string, InvoicePartsView>;
  categories: CategoryChoice[];
  /** The `name` of the invoice select to follow. Ignored when `fixedInvoiceId` is set. */
  invoiceField?: string;
  fixedInvoiceId?: string;
  /** The form's rule for the particulars box. Omit on a form that has none (the draft editor): the box is then plain. */
  particularsRule?: FieldRule;
  /** Present on a form that records payments (not on the draft editor). */
  payments?: { moneyLines: PaymentProps; invoices: Record<string, InvoiceSupplierOption>; creditFirst?: boolean };
  /** Edit mode: start on this part and these particulars. */
  initialPartKey?: string;
  initialPickedCategoryId?: string;
  initialParticulars?: string;
}

export function InvoicePartsPicker({
  views,
  categories,
  invoiceField = 'supplierInvoiceId',
  fixedInvoiceId,
  particularsRule,
  payments,
  initialPartKey,
  initialPickedCategoryId,
  initialParticulars,
}: InvoicePartsPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string>(fixedInvoiceId ?? '');
  const [partKey, setPartKey] = useState<string>(initialPartKey ?? '');
  const [pickedCategory, setPickedCategory] = useState<string>(initialPickedCategoryId ?? '');
  const [particulars, setParticulars] = useState<string>(initialParticulars ?? '');

  // Follow the invoice select (the same way InvoiceMoneyLines does).
  useEffect(() => {
    if (fixedInvoiceId) return undefined;
    const field = rootRef.current?.closest('form')?.elements.namedItem(invoiceField);
    if (!(field instanceof HTMLSelectElement)) return undefined;
    const sync = () => {
      setPicked(field.value);
      setPartKey('');
      setPickedCategory('');
    };
    sync();
    field.addEventListener('change', sync);
    return () => field.removeEventListener('change', sync);
  }, [invoiceField, fixedInvoiceId]);

  const view = views[picked];
  const part: PartView | undefined = view?.parts.find((p) => p.key === partKey);
  const needsPick = !!part && part.kind !== 'category';
  const resolvedCategory = !part ? '' : part.kind === 'category' ? (part.categoryId ?? '') : pickedCategory;

  // The hidden control changes without an input event: say so, so the form re-reads its rule for the category.
  useEffect(() => {
    hiddenRef.current?.dispatchEvent(new Event('input', { bubbles: true }));
  }, [resolvedCategory]);

  const choosePart = (key: string) => {
    setPartKey(key);
    setPickedCategory('');
    const next = view?.parts.find((p) => p.key === key);
    if (next) setParticulars(particularsOf(next));
  };

  const offered = useMemo(() => categories.filter((c) => c.isActive), [categories]);
  const method = payments?.creditFirst && payments.invoices[picked]?.creditTermsDays != null ? 'credit' : 'cash';

  return (
    <div ref={rootRef} className="space-y-4">
      <input ref={hiddenRef} type="hidden" name="categoryId" value={resolvedCategory} />

      {!view && <p className="text-sm text-neutral-500 dark:text-neutral-400">Pick the supplier invoice first, then which part of that bill this expense is for.</p>}

      {view && !view.itemised && (
        <Banner tone="warning">
          <strong>This bill isn&apos;t itemised yet.</strong> An expense records one part of a bill, so list what was on it first.{' '}
          <a className={ACTION_LINK} href={`/ap/invoices/${view.invoiceId}`}>
            List what was on it
          </a>
          . Save stays off until then.
        </Banner>
      )}

      {view && view.itemised && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Which part of this bill?</span>
              <Select name="partKey" value={partKey} onChange={(e) => choosePart(e.target.value)} className="w-full">
                <option value="" disabled>
                  Select a part…
                </option>
                {view.parts.map((p) => (
                  <option key={p.key} value={p.key} disabled={!hasLeft(p.left)}>
                    {`${p.label} — ${peso(p.left)} left`}
                  </option>
                ))}
              </Select>
            </label>
            {part && part.itemNames.length > 0 && (
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{[...new Set(part.itemNames)].join(', ')}</p>
            )}
          </div>

          {needsPick && (
            <div>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Category for these items</span>
                <Select name="pickedCategoryId" value={pickedCategory} onChange={(e) => setPickedCategory(e.target.value)} className="w-full">
                  <option value="" disabled>
                    Select a category…
                  </option>
                  {GROUPS.map((g) => {
                    const rows = offered.filter((c) => c.group === g);
                    if (rows.length === 0) return null;
                    return (
                      <optgroup key={g} label={g}>
                        {rows.map((c) => (
                          <option key={c.id} value={c.id} disabled={!c.accountCode && c.id !== initialPickedCategoryId}>
                            {c.category}
                            {!c.accountCode ? ' (unmapped — cannot post)' : ''}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </Select>
              </label>
              {part?.kind === 'uncategorised' && (
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  These items have no category yet.{' '}
                  <a className={ACTION_LINK} href="/items">
                    Set the item&apos;s category
                  </a>{' '}
                  so this isn&apos;t asked next time.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {(!view || view.itemised) && (
        <div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Particulars — what this was actually for</span>
            <Input
              type="text"
              {...(particularsRule ? nativeAttrs(particularsRule) : { name: 'particulars' })}
              value={particulars}
              onChange={(e) => setParticulars(e.target.value)}
              className="w-full"
            />
          </label>
          {particularsRule && <FieldCheck rule={particularsRule} />}
        </div>
      )}

      {payments && (
        <div>
          <h2 className="mb-2 text-sm font-medium">Payments — add a line for each place the money came from. A split expense posts as ONE entry with one credit line per row.</h2>
          <InvoiceMoneyLines
            key={`${picked}:${partKey}`}
            direction="out"
            {...payments.moneyLines}
            invoices={payments.invoices}
            invoiceField={fixedInvoiceId ? 'supplierInvoiceId' : invoiceField}
            initialLines={part && hasLeft(part.left) ? [{ method, amount: part.left, moneyAccountId: null }] : undefined}
          />
        </div>
      )}
    </div>
  );
}
