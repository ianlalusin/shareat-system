'use client';
import { TRADE_ORDER_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';

/**
 * The "New trade order" form — DEF-138. One document for a wholesale sale and an internal
 * transfer alike (ADR-008 §8); the customer picked here decides which, and the form says so.
 *
 * ⭐ The rate is OPTIONAL on purpose. Left blank, `createTradeOrder` takes the customer's
 * price-list rate (a sale) or the branch price (a transfer) and CAPTURES it onto the line. The
 * placeholder shows that default so the person sees the agreed price before it is captured — and
 * sees "no default" before the server refuses the line.
 */
import { useState } from 'react';
import { Button, FormGrid, FormSection, Input, Select , Field } from '@/components/ui';
import type { CustomerOption, ItemOption, StoreOption } from './lib';

interface LineDraft {
  key: number;
  itemId: string;
  quantity: string;
  rate: string;
}

const TREATMENT_HINT: Record<string, string> = {
  internal: 'One of our own stores — an internal transfer. No revenue, no receivable; stock moves at cost and the branch price is the default rate.',
  external: 'An outside buyer — a real sale. Dispatch raises the receivable and books wholesale revenue; the price list is the default rate.',
  inter_entity: 'Inter-entity sale to another company. Dispatch bills them and ships the stock; they confirm what they received on their side.',
};

export function NewOrderForm({
  // T-440: the prop is the page's `createOrderAction`; it keeps that name here so the form's server action is the one the guard traces.
  action: createOrderAction,
  stores,
  storeId,
  customers,
  items,
  quotes,
  branchPrices,
  today,
}: {
  action: (fd: FormData) => void | Promise<void>;
  stores: readonly StoreOption[];
  /** The store the register is showing — the default SELLING store. */
  storeId: string;
  customers: readonly CustomerOption[];
  items: readonly ItemOption[];
  quotes: Record<string, Record<string, string>>;
  branchPrices: Record<string, string>;
  today: string;
}) {
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '');
  const [sellingStoreId, setSellingStoreId] = useState(storeId);
  const [lines, setLines] = useState<LineDraft[]>([{ key: 1, itemId: items[0]?.id ?? '', quantity: '', rate: '' }]);
  const [nextKey, setNextKey] = useState(2);

  const customer = customers.find((c) => c.id === customerId);
  const treatment = customer?.treatment ?? 'external';
  const itemById = new Map(items.map((i) => [i.id, i]));

  function defaultRate(itemId: string): string | null {
    if (!itemId) return null;
    if (treatment === 'internal') return branchPrices[itemId] ?? null;
    return quotes[customerId]?.[itemId] ?? null;
  }

  function update(key: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { key: nextKey, itemId: items[0]?.id ?? '', quantity: '', rate: '' }]);
    setNextKey((k) => k + 1);
  }
  function removeLine(key: number) {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.key !== key)));
  }

  const label = 'flex min-w-0 flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400';

  if (customers.length === 0 || items.length === 0) {
    return (
      <p className="mt-3 text-sm text-warning-ink">
        {customers.length === 0
          ? 'No active customers yet — record one under Trade › Customers first.'
          : 'No active items yet — add one under Inventory › Items first.'}
      </p>
    );
  }

  return (
    <CheckedForm rules={TRADE_ORDER_RULES} action={createOrderAction} className="mt-3 space-y-4">
      <FormSection title="Document">
        <FormGrid layout="fields">
          <Field label="Selling store" rule={TRADE_ORDER_RULES.storeId} className={`${label} erp-field-code`}>
            <Select {...nativeAttrs(TRADE_ORDER_RULES.storeId)}


              value={sellingStoreId}
              onChange={(e) => setSellingStoreId(e.target.value)}
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Customer" rule={TRADE_ORDER_RULES.customerId} className={`${label} erp-field-long`}>
            <Select {...nativeAttrs(TRADE_ORDER_RULES.customerId)}


              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.treatment === 'internal' ? ' — our own store' : c.treatment === 'inter_entity' ? ' — another company' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Order date" rule={TRADE_ORDER_RULES.orderDate} className={`${label} erp-field-date`}>
            <Input {...nativeAttrs(TRADE_ORDER_RULES.orderDate)}  type="date"  defaultValue={today} />
          </Field>
          <label className={`${label} erp-field-code`}>
            Reference (optional)
            <Input name="referenceNo" placeholder="DR-0001" />
          </label>
        </FormGrid>
      </FormSection>

      <p
        className={`text-xs ${treatment === 'internal'
            ? 'text-info'
            : 'text-neutral-600 dark:text-neutral-400'
          }`}
      >
        {treatment === 'inter_entity' && customer?.counterpartyOrgName
          ? `Inter-entity sale to ${customer.counterpartyOrgName}. Dispatch bills them and ships the stock; they confirm what they received on their side.`
          : TREATMENT_HINT[treatment]}
        {treatment === 'internal' && customer?.counterpartyStoreId === sellingStoreId && (
          <span className="ml-1 text-danger">⛔ That is the selling store itself — a store cannot transfer to itself.</span>
        )}
      </p>

      <FormSection title="Order lines" className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Lines</h3>
          <Button type="button" variant="secondary" onClick={addLine}>
            + Add line
          </Button>
        </div>
        {lines.map((l, idx) => {
          const item = itemById.get(l.itemId);
          const dflt = defaultRate(l.itemId);
          return (
            <div
              key={l.key}
              className="grid grid-cols-2 gap-2 rounded-md border border-neutral-200 p-2 sm:grid-cols-[1fr_7rem_9rem_auto] sm:items-end dark:border-neutral-800"
            >
              <span className="col-span-2 text-xs font-medium text-neutral-600 dark:text-neutral-400 sm:col-span-4">
                Line {idx + 1}
              </span>
              <label className={`${label} col-span-2 sm:col-span-1`}>
                Item
                <Select
                  name="itemId"
                  required
                  value={l.itemId}
                  onChange={(e) => update(l.key, { itemId: e.target.value })}
                >
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.baseUnit})
                    </option>
                  ))}
                </Select>
              </label>
              <label className={label}>
                Quantity{item ? ` (${item.baseUnit})` : ''}
                <Input
                  name="quantity"
                  required
                  inputMode="decimal"
                  placeholder="0.000"
                  value={l.quantity}
                  onChange={(e) => update(l.key, { quantity: e.target.value })}
                  className="tabular-nums"
                />
              </label>
              <label className={label}>
                Rate ₱ (blank = default)
                <Input
                  name="rate"
                  inputMode="decimal"
                  placeholder={dflt ? `₱${dflt}` : 'no default — state one'}
                  value={l.rate}
                  onChange={(e) => update(l.key, { rate: e.target.value })}
                  className={`tabular-nums ${dflt || l.rate ? '' : 'ring-1 ring-warning-ink'}`}
                />
              </label>
              <Button
                type="button"
                variant="danger"
                onClick={() => removeLine(l.key)}
                disabled={lines.length === 1}
                aria-label="Remove line"
              >
                Remove
              </Button>
            </div>
          );
        })}
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          ⚠️ Whatever rate is used is <strong>captured</strong> onto the line — a later price-list
          edit never reaches back. An amber rate box means nothing can price that line by default.
        </p>
      </FormSection>

      <FormSection title="Fees and notes">
        <FormGrid layout="fields">
          <Field label="Delivery fee ₱ (optional)" rule={TRADE_ORDER_RULES.deliveryFee} className={`${label} erp-field-code`}>
            <Input {...nativeAttrs(TRADE_ORDER_RULES.deliveryFee)}   placeholder="0.00" className="tabular-nums" />
          </Field>
          <Field label="Other fees ₱ (optional)" rule={TRADE_ORDER_RULES.otherFees} className={`${label} erp-field-code`}>
            <Input {...nativeAttrs(TRADE_ORDER_RULES.otherFees)}   placeholder="0.00" className="tabular-nums" />
          </Field>
          <label className={`${label} erp-field-long`}>
            Notes (optional)
            <Input name="notes" />
          </label>
        </FormGrid>
      </FormSection>

      <Button type="submit" variant="primary">
        Save draft
      </Button>
    </CheckedForm>
  );
}
