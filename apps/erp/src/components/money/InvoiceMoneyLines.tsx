'use client';

/**
 * InvoiceMoneyLines - T-475 S2 (C2 / F1). `<MoneyLines>` for a form where the SUPPLIER comes from a picked supplier invoice
 * (`/expenses/new`): the invoice select sits outside this component, so it listens to that control (by name) and feeds the picked
 * invoice's supplier, name and credit terms into MoneyLines. Before this, the page passed `supplierId={null}`, which disables
 * Credit for everyone, so a credit expense could never be entered even against a supplier on terms.
 *
 * It also posts the hidden `supplierId` (the invoice owns its supplier; the server re-reads it from the invoice and refuses a
 * mismatch), and nudges the enclosing CheckedForm to re-read the payment lines whenever a row is added or removed (those change
 * hidden controls without an input event, and the rule lines for the amount and the Credit method read them).
 */
import { useEffect, useRef, useState } from 'react';
import { MoneyLines, type MoneyLinesProps } from './MoneyLines';

export interface InvoiceSupplierOption {
  supplierId: string;
  supplierName: string;
  /** null = cash-on-delivery. */
  creditTermsDays: number | null;
}

export function InvoiceMoneyLines({
  invoices,
  invoiceField = 'supplierInvoiceId',
  ...moneyLines
}: Omit<MoneyLinesProps, 'supplierId' | 'supplierName' | 'supplierCreditTermsDays'> & {
  /** The picker's invoices by id. */
  invoices: Record<string, InvoiceSupplierOption>;
  /** The `name` of the invoice select in the same form. */
  invoiceField?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<string>('');

  // Follow the invoice select (the same way ClosedMonthOverride follows its date input).
  useEffect(() => {
    const field = rootRef.current?.closest('form')?.elements.namedItem(invoiceField);
    if (!(field instanceof HTMLSelectElement)) return;
    const sync = () => setPicked(field.value);
    sync();
    field.addEventListener('input', sync);
    field.addEventListener('change', sync);
    return () => {
      field.removeEventListener('input', sync);
      field.removeEventListener('change', sync);
    };
  }, [invoiceField]);

  // A row added or removed changes the count and shifts the rows without an input event: say so, once the DOM has settled.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      for (const el of Array.from(root.querySelectorAll('input[name="lineCount"], [name^="lineMethod_"], input[name^="lineAmount_"]'))) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const supplier = invoices[picked];
  return (
    <div ref={rootRef}>
      <input type="hidden" name="supplierId" value={supplier?.supplierId ?? ''} />
      <MoneyLines
        {...moneyLines}
        supplierId={supplier?.supplierId ?? null}
        supplierName={supplier?.supplierName ?? null}
        supplierCreditTermsDays={supplier?.creditTermsDays ?? null}
      />
    </div>
  );
}
