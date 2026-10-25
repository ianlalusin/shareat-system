'use client';
/**
 * T-475 S1 (A5, Q1) - feeds the "this invoice number is already recorded" warning on the log form.
 *
 * It reads the store, supplier and number the person has typed, asks `checkInvoiceNumberAction` (debounced, `useLookupCheck`) and
 * hands the answer to the RuleChecks beneath it as their facts. While the lookup is pending, failed, or answered for a number
 * since edited there are no facts, so there is NO verdict: it never warns on a guess and never blocks. The check itself
 * (`ap.invoice.duplicateNumber`) only ever WARNS; Save stays on.
 */
import { useMemo, type ReactNode } from 'react';
import { RuleFactsContext, useFormValues, useLookupCheck } from '@/components/forms';
import { checkInvoiceNumberAction } from './actions';

export function InvoiceNumberCheck({ supplierNames, children }: { supplierNames: Readonly<Record<string, string>>; children: ReactNode }) {
  const values = useFormValues(['storeId', 'supplierId', 'invoiceNo']);
  const storeId = values?.storeId?.trim() ?? '';
  const supplierId = values?.supplierId?.trim() ?? '';
  const invoiceNo = values?.invoiceNo?.trim() ?? '';
  const inputs = useMemo(
    () => (storeId && supplierId && invoiceNo ? { storeId, supplierId, invoiceNo } : null),
    [storeId, supplierId, invoiceNo],
  );
  const answer = useLookupCheck(checkInvoiceNumberAction, inputs);
  const facts = useMemo(
    () =>
      answer && inputs
        ? { supplierName: supplierNames[inputs.supplierId] ?? 'This supplier', invoiceNo: inputs.invoiceNo, supplierId: inputs.supplierId, matches: answer.matches }
        : undefined,
    [answer, inputs, supplierNames],
  );
  return <RuleFactsContext.Provider value={facts}>{children}</RuleFactsContext.Provider>;
}
