import { center, columnsFor, justify, printAmount, rule, wrap } from './layout';
import type { PrintLayout, ReceiptView } from './types';

/**
 * T-528a — the sales receipt as plain text, one string per paper line.
 *
 * Layout follows `docs/plans/pos-v2-design/receipts.png`: header, flags, who/where, the itemized
 * lines (bible row 439: qty × unit price = gross, its discounts, line net), the bill totals, the
 * tenders (bible row 438: several on one bill, each with its reference), the change, and the
 * senior/PWD diners (bible row 437).
 *
 * NOTHING HERE IS COMPUTED. `subtotal`, `discountTotal`, `total`, `net` and `change` arrive already
 * worked out and are printed exactly as given — even if the caller hands over figures that do not add
 * up. A receipt that silently corrected a figure would be a worse receipt than a wrong one.
 */

/** Append `text` wrapped at the print width, with every line indented. */
function pushWrapped(out: string[], text: string, cols: number, indent = 0): void {
  const width = Math.max(1, cols - indent);
  for (const line of wrap(text, width)) out.push(' '.repeat(indent) + line);
}

/** Append `text` wrapped, with each wrapped line centred. */
function pushCentered(out: string[], text: string, cols: number): void {
  const trimmed = text.trim();
  if (!trimmed) {
    out.push('');
    return;
  }
  for (const line of wrap(trimmed, cols)) out.push(center(line, cols));
}

/** `"0.00"`, `"-0.00"` and `"0"` all mean "no discount", and print no DISCOUNTS row. */
function isZeroAmount(value: string): boolean {
  return /^-?0(\.0+)?$/.test(value.trim());
}

export function formatReceipt(view: ReceiptView, layout: PrintLayout): string[] {
  const cols = columnsFor(layout);
  const out: string[] = [];

  // 1. The store's header.
  pushCentered(out, view.header.businessName.toUpperCase(), cols);
  for (const address of view.header.addressLines) pushCentered(out, address, cols);
  if (view.header.tin !== null) {
    pushCentered(out, `TIN: ${view.header.tin} ${view.header.vatRegistered ? 'VAT' : 'Non-VAT'}`, cols);
  }

  // 2. Blank line, then the two flags. They are the first thing a cashier's eye should catch.
  out.push('');
  if (view.reprint) pushCentered(out, 'REPRINT', cols);
  if (view.offline) pushCentered(out, 'OFFLINE SALE - TO SYNC', cols);

  // 3. Who, where and when.
  out.push(...justify('RECEIPT:', view.receiptNo, cols));
  out.push(...justify('DATE:', view.issuedAtLocal, cols));
  if (view.tableLabel !== null) out.push(...justify('TABLE:', view.tableLabel, cols));
  if (view.heads !== null) out.push(...justify('HEADS:', String(view.heads), cols));
  out.push(...justify('CASHIER:', view.cashierName, cols));

  // 4. The itemized lines.
  out.push(rule(cols));
  for (const line of view.lines) {
    out.push(...justify(`${line.qty} x ${line.name}`, printAmount(line.gross), cols));
    if (line.qty > 1) pushWrapped(out, `@ ${printAmount(line.unitPrice)}`, cols, 2);
    for (const discount of line.discounts) {
      out.push(...justify(`  ${discount.label} (${discount.qty})`, `-${printAmount(discount.amount)}`, cols));
    }
    // Only a discounted line shows its net; an undiscounted one's net is its gross, already printed.
    if (line.discounts.length > 0) out.push(...justify('  Net', printAmount(line.net), cols));
  }

  // 5. The bill's totals.
  out.push(rule(cols));
  out.push(...justify('SUBTOTAL', printAmount(view.subtotal), cols));
  if (!isZeroAmount(view.discountTotal)) out.push(...justify('DISCOUNTS', `-${printAmount(view.discountTotal)}`, cols));
  out.push(...justify('TOTAL', printAmount(view.total), cols));
  if (view.vat !== null) {
    const { vat } = view;
    if (!isZeroAmount(vat.vatRemovedForScPwd)) out.push(...justify('Less: VAT exemption (SC/PWD)', `-${printAmount(vat.vatRemovedForScPwd)}`, cols));
    out.push(...justify('VATABLE SALES', printAmount(vat.vatableSales), cols));
    out.push(...justify(vat.vatRegistered ? 'VAT-EXEMPT SALES' : 'SC/PWD SALES', printAmount(vat.vatExemptSales), cols));
    // Makes VATABLE + VAT + VAT-EXEMPT - this = TOTAL add up on the paper. A non-VAT store has no such identity, so it prints none.
    if (vat.vatRegistered && !isZeroAmount(vat.scPwdDiscount)) out.push(...justify('Less: SC/PWD discount', `-${printAmount(vat.scPwdDiscount)}`, cols));
    out.push(...justify(`VAT (${vat.vatRateLabel})`, printAmount(vat.vatAmount), cols));
  }

  // 6. The tenders, then the change.
  out.push(rule(cols));
  for (const tender of view.tenders) {
    const name = tender.toCheck ? `${tender.name} (to check)` : tender.name;
    out.push(...justify(name, printAmount(tender.amount), cols));
    if (tender.reference !== null) pushWrapped(out, `Ref: ${tender.reference}`, cols, 2);
  }
  out.push(...justify('CHANGE', printAmount(view.change), cols));

  // 7. The senior/PWD diners whose discount is on this bill: the paper is their evidence at the door.
  if (view.diners.length > 0) {
    out.push(rule(cols));
    for (const diner of view.diners) {
      pushWrapped(out, `${diner.kind === 'senior' ? 'SENIOR' : 'PWD'} #${diner.dinerNo}`, cols);
      pushWrapped(out, `Name: ${diner.holderName}`, cols, 2);
      pushWrapped(out, `ID: ${diner.idNumber}`, cols, 2);
    }
  }

  // 8. The store's own footer.
  for (const footer of view.footerLines) pushCentered(out, footer, cols);

  return out;
}
