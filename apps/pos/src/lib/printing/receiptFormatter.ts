'use client';

import { toJsDate } from "@/lib/utils/date";
import type { ReceiptData, SessionBillLine } from "@/lib/types";
import { format } from "date-fns";

/**
 * Formats receipt data into plain text for thermal printing (ESC/POS).
 */
export function formatReceiptText(
  data: ReceiptData,
  width: 58 | 80 = 80,
  fontMode: 'small' | 'normal' | 'large' = 'normal',
): string {
  // Thermal fonts: Font A (normal) and the denser Font B (small) fit a
  // different number of columns per line. "large" is Font A at double height —
  // the character WIDTH is unchanged, so it uses the same columns as normal.
  const charsPerLine =
    fontMode === 'small' ? (width === 58 ? 42 : 64) : (width === 58 ? 32 : 48);
  const qtyWidth = 4;
  const priceWidth = 10;
  const nameWidth = charsPerLine - qtyWidth - priceWidth;
  const lines: string[] = [];

  const center = (text: string) => {
    const padding = Math.max(0, Math.floor((charsPerLine - text.length) / 2));
    return " ".repeat(padding) + text;
  };
  const justify = (left: string, right: string) => {
    const space = charsPerLine - left.length - right.length;
    return left + " ".repeat(Math.max(1, space)) + right;
  };
  const hr = () => "-".repeat(charsPerLine);

  const settings = data.settings;
  if (settings.businessName) lines.push(center(settings.businessName.toUpperCase()));
  if (settings.address) lines.push(center(settings.address));
  if (settings.contact) lines.push(center(settings.contact));
  if (settings.tin) lines.push(center(`TIN: ${settings.tin} ${settings.vatType === 'VAT' ? 'VAT' : 'Non-VAT'}`));
  lines.push("");

  const receiptDate = toJsDate(data.receiptCreatedAt) ?? toJsDate(data.session.closedAt);
  lines.push(justify("DATE:", receiptDate ? format(receiptDate, "MM/dd/yy HH:mm") : "N/A"));
  lines.push(justify("RECEIPT:", data.receiptNumber ?? "—"));

  if (settings.showTableOrCustomer) {
    const label = data.session.sessionMode === 'alacarte' ? "CUSTOMER:" : "TABLE:";
    const val = data.session.sessionMode === 'alacarte'
      ? (data.session.customer?.name || data.session.customerName || "N/A")
      : (data.session.tableNumber || "N/A");
    lines.push(justify(label, val));
  }

  if (settings.showCashierName) {
    lines.push(justify("CASHIER:", data.createdByUsername || "N/A"));
  }

  lines.push(hr());

  const headerRow = 'Qty'.padEnd(qtyWidth) + 'Item'.padEnd(nameWidth) + 'Total'.padStart(priceWidth);
  lines.push(headerRow);

  const activeLines = (data.lines || [])
    .filter(l => (l.qtyOrdered - (l.voidedQty || 0)) > 0)
    // Pin the package/bundle line to the top (dine-in); stable for the rest.
    .sort((a, b) => ((a.type === 'package' ? 0 : 1) - (b.type === 'package' ? 0 : 1)));
  activeLines.forEach(line => {
    const billableQty = line.qtyOrdered - (line.voidedQty || 0);
    const lineTotal = (billableQty * line.unitPrice).toFixed(2);
    const name = line.itemName.substring(0, nameWidth - 1);
    lines.push(String(billableQty).padEnd(qtyWidth) + name.padEnd(nameWidth) + lineTotal.padStart(priceWidth));
  });

  lines.push(hr());

  const analytics = data.analytics || {};
  const statutory = data.statutoryDiners ?? [];
  lines.push(justify("SUBTOTAL", (analytics.subtotal || 0).toFixed(2)));
  if ((analytics.discountsTotal || 0) > 0) {
    lines.push(justify("DISCOUNTS", `(-${analytics.discountsTotal.toFixed(2)})`));
  }
  if ((analytics.chargesTotal || 0) > 0) {
    lines.push(justify("CHARGES", `+${analytics.chargesTotal.toFixed(2)}`));
  }
  if (statutory.length && (analytics.statutoryVatRemovedTotal || 0) > 0) {
    const label = 'Less: VAT exemption (SC/PWD)';
    const amount = `-${analytics.statutoryVatRemovedTotal.toFixed(2)}`;
    if (label.length + amount.length + 1 > charsPerLine) lines.push(label, amount.padStart(charsPerLine));
    else lines.push(justify(label, amount));
  }
  if (statutory.length && ((analytics.taxAmount || 0) > 0 || (analytics.vatExemptSales || 0) > 0)) {
    lines.push(hr());
    lines.push(justify('VATABLE SALES', (analytics.vatableSales || 0).toFixed(2)));
    lines.push(justify(settings.vatType === 'NON_VAT' ? 'SC/PWD SALES' : 'VAT-EXEMPT SALES', (analytics.vatExemptSales || 0).toFixed(2)));
    lines.push(justify(`VAT (${data.store?.taxRatePct || 0}%)`, (analytics.taxAmount || 0).toFixed(2)));
  }

  lines.push(hr());
  lines.push(justify("TOTAL", `PHP ${(analytics.grandTotal || 0).toFixed(2)}`));
  lines.push(hr());

  const mop = analytics.mop || {};
  Object.entries(mop).forEach(([method, amount]) => {
    lines.push(justify(method.toUpperCase(), (amount as number).toFixed(2)));
  });
  lines.push(justify("TOTAL PAID", (analytics.totalPaid || 0).toFixed(2)));
  lines.push(justify("CHANGE", (analytics.change || 0).toFixed(2)));
  for (const diner of statutory) {
    lines.push(hr(), diner.kind === 'senior' ? 'SENIOR CITIZEN' : 'PWD', diner.name, `ID: ${diner.idNo}`);
    lines.push(justify('Discount', diner.discount.toFixed(2)));
    if (diner.promoWasHigher) lines.push('promo was higher');
    lines.push('Signature: ________________');
  }

  lines.push("");
  if (settings.footerText) lines.push(center(settings.footerText));
  lines.push(center("THANK YOU!"));
  lines.push("\n\n\n\n");

  return lines.join("\n");
}

/**
 * PIN slip split into top/bottom halves around a QR code.
 * top    → printed before QR
 * bottom → printed after QR
 */
export interface PinTextParts {
  top: string;
  bottom: string;
}

export function formatSharelebratorPasswordText(opts: {
  name: string;
  phone: string;
  tempPassword: string;
  resetAtMs?: number;
  width: 58 | 80;
}): string {
  const charsPerLine = opts.width === 58 ? 32 : 38;
  const center = (text: string) => text.trim();
  const hr = () => '-'.repeat(charsPerLine);
  const dashed = () => '='.repeat(charsPerLine);

  const lines: string[] = [
    center('* SHARELEBRATOR *'),
    center('Password Reset'),
    hr(),
    '',
    center('Cardholder:'),
    center(opts.name),
    '',
    center('Phone:'),
    center(opts.phone),
    '',
    dashed(),
    center('TEMPORARY PASSWORD'),
    '',
    center(opts.tempPassword),
    '',
    dashed(),
    '',
    center('Use this to log in to your'),
    center('Sharelebrator account.'),
    center('Please change it after login.'),
    '',
    hr(),
    center(new Date(opts.resetAtMs ?? Date.now()).toLocaleString()),
    '\n\n\n\n',
  ];

  return lines.join('\n');
}

export function formatPinText(opts: {
  pin: string;
  customerName?: string | null;
  storeName?: string;
  width: 58 | 80;
  qrPosition?: "top" | "middle" | "bottom";
  /** Table the slip belongs to ("Table 3"); printed as its own bold line under the greeting. */
  tableLabel?: string | null;
}): PinTextParts {
  const qrPos = opts.qrPosition ?? 'middle';

  // No software centering — printer handles alignment via ESC a 01
  const center = (text: string) => text.trim();

  // Line markup read by the native plugin (writePinSlipLines): a "**" prefix prints
  // the line bold, and a line of exactly 6 uppercase letters/digits is the PIN
  // (bold, double size). Every line here is ≤32 chars, so none wraps on 58mm.
  let tableLine: string | null = null;
  const rawTable = (opts.tableLabel ?? '').trim().slice(0, 32).trim();
  if (rawTable) {
    // A label that is exactly 6 uppercase letters/digits would be printed by the plugin
    // as the PIN (double size), so give it a prefix that can never match.
    const safe = /^[A-Z0-9]{6}$/.test(rawTable) ? ('Table ' + rawTable).slice(0, 32) : rawTable;
    tableLine = '**' + center(safe);
  }

  const headerLines: string[] = [
    ...(opts.customerName ? [center('Welcome ' + opts.customerName + ',')] : [center('Welcome,')]),
    ...(tableLine ? [tableLine] : []),
    '',
    center('Scan the QR code or go to'),
    '**' + center('CUSTOMER.SHAREAT.NET'),
    center('and enter this PIN to access'),
    center('our smart refilling system.'),
    '',
  ];

  const footerLines: string[] = [
    '',
    center(opts.pin),
    '',
    center(`- ${opts.storeName || 'The SharEat Team'}`),
    '\n\n\n\n',
  ];

  let topLines: string[];
  let bottomLines: string[];

  if (qrPos === 'top') {
    topLines = [];
    bottomLines = [...headerLines, ...footerLines];
  } else if (qrPos === 'bottom') {
    topLines = [...headerLines, ...footerLines];
    bottomLines = [];
  } else {
    // middle (default)
    topLines = headerLines;
    bottomLines = footerLines;
  }

  return { top: topLines.join('\n'), bottom: bottomLines.join('\n') };
}
