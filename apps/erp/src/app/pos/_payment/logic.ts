/**
 * T-528 R2/R3 - the pure payment logic of the POS v2 Payment screen: balance and change, the Pay blockers, the discount sheet's rules (the server's own
 * sentences, so a cashier is refused before sending), the sale.completed payload, and `paySale` (reserve, enqueue, print, drain).
 * No React, no clock, no network: every dependency arrives in an argument. Every amount goes through @shareat/core/money (centavos in bigint, no floats).
 * docs/tasks/528-pos-payment-screen.md. The rules mirror packages/domain/src/pos/{discounts,sale}.ts line for line: change them there first.
 */
import { fromCentavos, money, toCentavos, type Money } from '@shareat/core/money';
import { checkAll, POS_PAYMENT_REFERENCE_RULES } from '@shareat/domain/field-rules';
import { priceSession, type PriceLineInput, type PricedSession } from '@shareat/domain/pos/price';
import type { NewPosEvent, PosEvent } from '@/lib/pos-device';
import type { ApprovalFields } from '../_shell/line-approval';
import { printAmount } from '@/lib/pos-print/layout';
import { formatReceipt } from '@/lib/pos-print/receipt-text';
import type { PrintLayout, ReceiptDiner, ReceiptHeader, ReceiptLine, ReceiptView } from '@/lib/pos-print/types';

/** The server takes between 1 and 20 payments (completeSale). */
export const MAX_TENDERS = 20;
/** The statutory discount is one diner number from 1; the server accepts up to 200. */
const DINER_MAX = 200;

export interface Tender {
  id: string;
  name: string;
  kind: string;
}
export interface PayRow {
  tenderId: string;
  /** A 2-dp decimal string, or what the cashier has typed so far. */
  amount: string;
  referenceNo?: string;
}
export interface Senior {
  dinerNo: number;
  kind: 'senior' | 'pwd';
  idNumber: string;
  holderName: string;
}
export interface BillDiscount {
  kind: 'senior' | 'pwd' | 'preset' | 'custom';
  qty: number;
  dinerNo: number | null;
}
export interface BillLine {
  lineId: string;
  name: string;
  kind: 'package' | 'item';
  qty: number;
  bundleHeads: number | null;
  unitPrice: string;
  discounts: BillDiscount[];
}
export interface DiscountAdd {
  lineId: string;
  kind: 'senior' | 'pwd' | 'preset' | 'custom';
  qty: number;
  dinerNo?: number;
  valueType?: 'percent' | 'fixed';
  value?: string;
}

export const SENTENCES = {
  noPayment: 'Add a payment.',
  tooMany: `Take between 1 and ${MAX_TENDERS} payments.`,
  notPositive: 'Each payment must be more than zero.',
  underpaid: 'The payments add up to less than the total.',
  onlyCash: 'Only cash can give change.',
  unknownTender: 'That way of paying is not available at this store.',
  enqueueFailed: 'This tablet could not save the sale. Nothing was charged. Try again.',
  printFailed: 'Receipt did not print. Tap Reprint.',
  lineGone: 'That line was cancelled.',
  freeItem: 'A free item takes no discount.',
  percentRange: 'A percent discount is more than 0 and at most 100.',
  pesoRange: 'A peso discount is more than 0 and at most the item price.',
  moreSeniors: 'There are more senior or PWD discounts than guests at this table.',
  pickDiner: 'Pick which diner holds the card.',
  pickType: 'Choose a percent or a peso amount.',
  pickTender: 'Pick a way to pay for the new payment.',
} as const;

/** What a typed amount is worth in centavos: blank, half-typed (".5", "500.") or invalid counts as zero, never a throw. */
export function amountCents(raw: string | undefined): bigint {
  const t = (raw ?? '').trim();
  if (t === '' || t === '.') return 0n;
  const fixed = (t.startsWith('.') ? `0${t}` : t).replace(/\.$/, '');
  try {
    return toCentavos(money(fixed));
  } catch {
    return 0n;
  }
}

/** One keypad tap on an amount buffer: digits and one decimal point, at most 2 decimals. */
export function appendAmountKey(buffer: string, key: string): string {
  if (key === '.') return buffer.includes('.') ? buffer : `${buffer === '' ? '0' : buffer}.`;
  if (!/^\d$/.test(key)) return buffer;
  const dot = buffer.indexOf('.');
  if (dot >= 0 && buffer.length - dot > 2) return buffer; // already two decimals
  return buffer === '0' ? key : buffer + key;
}

const centsText = (c: bigint): Money => fromCentavos(c);
const kindOf = (tenders: readonly Tender[], id: string): string | undefined => tenders.find((t) => t.id === id)?.kind;

export function receiptNoOf(terminalNo: number, terminalSeq: number): string {
  return `T${terminalNo}-${String(terminalSeq).padStart(6, '0')}`;
}

export function paymentSummary(i: { total: string; rows: readonly PayRow[]; tenders: readonly Tender[] }): { paid: string; balance: string; change: string } {
  const paid = i.rows.reduce((a, r) => a + amountCents(r.amount), 0n);
  const total = toCentavos(money(i.total));
  return { paid: centsText(paid), balance: centsText(paid >= total ? 0n : total - paid), change: centsText(paid > total ? paid - total : 0n) };
}

export const canAddPayment = (rows: readonly PayRow[]): boolean => rows.length < MAX_TENDERS;

export function addPaymentRow(rows: readonly PayRow[], tender: Tender, balance: string): PayRow[] {
  if (!canAddPayment(rows)) return [...rows];
  return [...rows, tender.kind === 'wallet' ? { tenderId: tender.id, amount: balance, referenceNo: '' } : { tenderId: tender.id, amount: balance }];
}

/** "Split: add another payment": ONE new row, no tender yet, the balance filled in. `chooseTender` gives it its tender. */
export function addSplitRow(rows: readonly PayRow[], balance: string): PayRow[] {
  return canAddPayment(rows) ? [...rows, { tenderId: '', amount: balance }] : [...rows];
}

/** A tender tap: it fills the row Split prepared (keeping its amount) when there is one, otherwise it adds a row with the balance. `index` is the row to make active. */
export function chooseTender(rows: readonly PayRow[], tender: Tender, balance: string): { rows: PayRow[]; index: number } {
  const open = rows.findIndex((r) => r.tenderId === '');
  if (open < 0) {
    const next = addPaymentRow(rows, tender, balance);
    return { rows: next, index: next.length > rows.length ? next.length - 1 : rows.length - 1 };
  }
  return { rows: rows.map((r, i) => (i === open ? { ...r, tenderId: tender.id, ...(tender.kind === 'wallet' ? { referenceNo: r.referenceNo ?? '' } : {}) } : { ...r })), index: open };
}

/** The server's own sentence for a wallet reference, or null when it is fine. */
export function referenceProblem(referenceNo: string | undefined): string | null {
  const c = checkAll(POS_PAYMENT_REFERENCE_RULES, { referenceNo: referenceNo ?? '' });
  return c.ok ? null : c.requirement;
}

/** Where the cashier has to look to clear a blocker: a card holder field, a payment row's tender / amount / reference, or the tender buttons. */
export type BlockerTarget =
  | { kind: 'holder'; dinerNo: number; field: 'holderName' | 'idNumber' }
  | { kind: 'row'; index: number; field: 'tender' | 'amount' | 'reference' }
  | { kind: 'tenders' };

/** null = Pay may be enabled; otherwise the one sentence under the Pay button and the field it is about. Senior/PWD details first (they are filled in before paying). */
export function payBlockerDetail(i: {
  total: string;
  rows: readonly PayRow[];
  tenders: readonly Tender[];
  diners: readonly { dinerNo: number; kind: string }[];
  holders: Readonly<Record<number, { holderName: string; idNumber: string }>>;
}): { message: string; target: BlockerTarget } | null {
  for (const d of [...i.diners].sort((a, b) => a.dinerNo - b.dinerNo)) {
    const h = i.holders[d.dinerNo];
    const nameMissing = !h || h.holderName.trim() === '';
    if (nameMissing || (h?.idNumber ?? '').trim() === '') return { message: `Add the name and ID for ${d.kind === 'pwd' ? 'PWD' : 'Senior'} #${d.dinerNo}.`, target: { kind: 'holder', dinerNo: d.dinerNo, field: nameMissing ? 'holderName' : 'idNumber' } };
  }
  if (i.rows.length === 0) return { message: SENTENCES.noPayment, target: { kind: 'tenders' } };
  if (i.rows.length > MAX_TENDERS) return { message: SENTENCES.tooMany, target: { kind: 'tenders' } };
  for (const [index, r] of i.rows.entries()) {
    if (r.tenderId === '') return { message: SENTENCES.pickTender, target: { kind: 'row', index, field: 'tender' } };
    const kind = kindOf(i.tenders, r.tenderId);
    if (kind === undefined) return { message: SENTENCES.unknownTender, target: { kind: 'row', index, field: 'tender' } };
    if (amountCents(r.amount) <= 0n) return { message: SENTENCES.notPositive, target: { kind: 'row', index, field: 'amount' } };
    if (kind === 'wallet') {
      const problem = referenceProblem(r.referenceNo);
      if (problem) return { message: problem, target: { kind: 'row', index, field: 'reference' } };
    }
  }
  const total = toCentavos(money(i.total));
  const paid = i.rows.reduce((a, r) => a + amountCents(r.amount), 0n);
  if (paid < total) return { message: SENTENCES.underpaid, target: { kind: 'row', index: i.rows.length - 1, field: 'amount' } };
  const change = paid - total;
  if (change > 0n) {
    // completeSale compares the change with the LARGEST single cash row; the screen must refuse exactly what the server would.
    const biggestCash = i.rows.filter((r) => kindOf(i.tenders, r.tenderId) === 'cash').reduce((m, r) => (amountCents(r.amount) > m ? amountCents(r.amount) : m), 0n);
    if (change > biggestCash) return { message: SENTENCES.onlyCash, target: { kind: 'tenders' } };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The discount sheet: the server's checks, in the server's order (addLineDiscount)
// ---------------------------------------------------------------------------------------------------------------------
const capacityOf = (qty: number, bundleHeads: number | null): number => (bundleHeads !== null && bundleHeads > 1 ? bundleHeads : qty);
const coveredOf = (l: { discounts: readonly { qty: number }[] }): number => l.discounts.reduce((a, d) => a + d.qty, 0);

/** Units still free of discount: qty (the heads on a bundle line) minus those covered. */
export const freeUnits = (line: Pick<BillLine, 'qty' | 'bundleHeads' | 'discounts'>): number => capacityOf(line.qty, line.bundleHeads) - coveredOf(line);

const freeSentence = (name: string, free: number): string =>
  free <= 0 ? `No unit of ${name} is free of discount.` : `Only ${free} ${free === 1 ? 'unit' : 'units'} of ${name} ${free === 1 ? 'is' : 'are'} free of discount.`;

const isZeroPrice = (unitPrice: string): boolean => amountCents(unitPrice) === 0n;

/** null = the sheet may add it; otherwise the server's own sentence. `heads` is the table's billed heads. */
export function checkDiscount(bill: readonly BillLine[], heads: number, add: DiscountAdd): string | null {
  const line = bill.find((l) => l.lineId === add.lineId);
  if (!line) return SENTENCES.lineGone;
  if (isZeroPrice(line.unitPrice)) return SENTENCES.freeItem;
  const free = freeUnits(line);
  if (!Number.isInteger(add.qty) || add.qty < 1) return freeSentence(line.name, 0);
  if (add.qty > free) return freeSentence(line.name, free);

  if (add.kind === 'senior' || add.kind === 'pwd') {
    const dinerNo = add.dinerNo;
    if (dinerNo === undefined || !Number.isInteger(dinerNo) || dinerNo < 1 || dinerNo > DINER_MAX) return SENTENCES.pickDiner;
    const all = bill.flatMap((l) => l.discounts.map((d) => ({ ...d, lineKind: l.kind })));
    const statutory = all.filter((d) => d.kind === 'senior' || d.kind === 'pwd');
    const sameDiner = statutory.filter((d) => d.dinerNo === dinerNo);
    if (sameDiner.some((d) => d.kind !== add.kind)) return `Diner ${dinerNo} already has a ${sameDiner[0]!.kind === 'pwd' ? 'PWD' : 'senior'} discount: one card per diner.`;
    if (line.kind === 'package') {
      if (add.qty !== 1 || sameDiner.some((d) => d.lineKind === 'package')) return `Diner ${dinerNo} already has their own package head discounted.`;
      const onPackage = statutory.filter((d) => d.lineKind === 'package').reduce((a, d) => a + d.qty, 0);
      if (onPackage + add.qty > heads) return SENTENCES.moreSeniors;
    }
    return null;
  }
  if (add.kind === 'custom') {
    if (add.valueType !== 'percent' && add.valueType !== 'fixed') return SENTENCES.pickType;
    const range = add.valueType === 'percent' ? SENTENCES.percentRange : SENTENCES.pesoRange;
    const typed = (add.value ?? '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(typed)) return range;
    const cents = amountCents(typed);
    const limit = add.valueType === 'percent' ? 10000n : amountCents(line.unitPrice);
    if (cents <= 0n || cents > limit) return range;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pricing: the SAME function the server uses
// ---------------------------------------------------------------------------------------------------------------------
export function priceBill(i: { lines: PriceLineInput[]; rules: { vatPercentBasisPoints: number; scPwdPercentBasisPoints: number }; vatRegistered: boolean }): PricedSession {
  return priceSession({
    vatRegistered: i.vatRegistered,
    vatPercentBasisPoints: BigInt(i.rules.vatPercentBasisPoints),
    scPwdPercentBasisPoints: BigInt(i.rules.scPwdPercentBasisPoints),
    lines: i.lines,
  });
}

/** The statutory percent only (80.18 + 17.68 on the payment.png bill), summed over the senior/PWD discounts; the VAT removed is separate (`vat.vatRemovedForScPwd`). With VATable + VAT + VAT-exempt it makes the printed block add up to the total. */
export function scPwdDiscountOf(lines: readonly { discounts: readonly { discountId: string; kind: string }[] }[], priced: PricedSession): Money {
  const statutory = new Set(lines.flatMap((l) => l.discounts.filter((d) => d.kind === 'senior' || d.kind === 'pwd').map((d) => d.discountId)));
  let cents = 0n;
  for (const l of priced.lines) for (const d of l.discounts) if (statutory.has(d.discountId)) cents += toCentavos(d.discountAmount);
  return fromCentavos(cents);
}

/** A rate in basis points as the receipt label, e.g. 1200 -> "12%", 750 -> "7.5%". Integer arithmetic only; the rate itself comes from the snapshot rules. */
export function rateLabel(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const frac = String(basisPoints % 100).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------------
interface SaleInput {
  sessionId: string;
  receiptId: string;
  terminalNo: number;
  terminalSeq: number;
  now: Date;
  online: boolean;
  priced: PricedSession;
  rows: readonly PayRow[];
  tenders: readonly Tender[];
  seniors: readonly Senior[];
}

/** The T-524 completeSale input minus storeId and pairingId (the server takes both from the pairing). */
export function buildSalePayload(i: SaleInput): Record<string, unknown> {
  return {
    sessionId: i.sessionId,
    receiptId: i.receiptId,
    terminalNo: i.terminalNo,
    terminalSeq: i.terminalSeq,
    issuedAtDevice: i.now.toISOString(),
    offline: !i.online,
    // The inbox needs all three per line, and completeSale compares all three.
    device: {
      subtotal: i.priced.subtotal,
      discountTotal: i.priced.discountTotal,
      total: i.priced.total,
      lines: i.priced.lines.map((l) => ({ lineId: l.lineId, gross: l.gross, discountTotal: l.discountTotal, net: l.net })),
    },
    payments: i.rows.map((r) => {
      const wallet = kindOf(i.tenders, r.tenderId) === 'wallet';
      const ref = (r.referenceNo ?? '').trim();
      return { tenderId: r.tenderId, amount: centsText(amountCents(r.amount)), ...(wallet && ref ? { referenceNo: ref } : {}), toCheck: !i.online && wallet };
    }),
    seniors: i.seniors.map((s) => ({ dinerNo: s.dinerNo, kind: s.kind, idNumber: s.idNumber.trim(), holderName: s.holderName.trim() })),
  };
}

export function saleCompletedEvent(i: SaleInput & { personId: string }): NewPosEvent {
  return { kind: 'sale.completed', personId: i.personId, occurredAtDevice: i.now.toISOString(), payload: buildSalePayload(i) };
}

export function discountAddedEvent(d: { personId: string; now: Date; discountId: string; lineId: string; kind: DiscountAdd['kind']; qty: number; presetId?: string; valueType?: 'percent' | 'fixed'; value?: string; dinerNo?: number; /** T-576: the manager PIN, or offline: true. */ approval?: ApprovalFields }): NewPosEvent {
  const at = d.now.toISOString();
  return {
    kind: 'discount.added',
    personId: d.personId,
    occurredAtDevice: at,
    payload: {
      discountId: d.discountId,
      lineId: d.lineId,
      kind: d.kind,
      ...(d.presetId !== undefined ? { presetId: d.presetId } : {}),
      ...(d.valueType !== undefined ? { valueType: d.valueType } : {}),
      ...(d.value !== undefined ? { value: d.value } : {}),
      qty: d.qty,
      ...(d.dinerNo !== undefined ? { dinerNo: d.dinerNo } : {}),
      appliedAtDevice: at,
      ...d.approval,
    },
  };
}

export function discountRemovedEvent(i: { personId: string; now: Date; discountId: string; approval?: ApprovalFields }): NewPosEvent {
  const at = i.now.toISOString();
  return { kind: 'discount.removed', personId: i.personId, occurredAtDevice: at, payload: { discountId: i.discountId, removedAtDevice: at, ...i.approval } };
}

export function applyToAllEvent(i: { personId: string; now: Date; sessionId: string; presetId: string; applyId: string; approval?: ApprovalFields }): NewPosEvent {
  const at = i.now.toISOString();
  return { kind: 'discount.applied_to_all', personId: i.personId, occurredAtDevice: at, payload: { sessionId: i.sessionId, presetId: i.presetId, applyId: i.applyId, appliedAtDevice: at, ...i.approval } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pay: one tap, local-first
// ---------------------------------------------------------------------------------------------------------------------
export type PrintOutcome = 'printed' | 'fallback' | 'failed';
/**
 * T-546: the layout and copy count the tablet prints with come from the till's settings in the snapshot (`store.receiptPaperMm`, `store.receiptCopies`),
 * set on Admin > POS tablets. Release 1 prints normal Font A; a font column comes when a store asks.
 */
export function printSettingsOf(store: { receiptPaperMm: 58 | 80; receiptCopies: number }): { layout: PrintLayout; copies: number } {
  return { layout: { width: store.receiptPaperMm, font: 'normal' }, copies: store.receiptCopies };
}

export interface PayDeps {
  reserveTerminalSeq(): Promise<number>;
  newId(): string;
  enqueue(e: NewPosEvent): Promise<PosEvent>;
  requestDrain(): void;
  print(lines: string[], opts: { copies: number }): Promise<PrintOutcome>;
}
export interface PayInput {
  personId: string;
  sessionId: string;
  online: boolean;
  terminalNo: number;
  now: Date;
  priced: PricedSession;
  rows: readonly PayRow[];
  tenders: readonly Tender[];
  seniors: readonly Senior[];
  vatRateLabel: string;
  layout: PrintLayout;
  /** Customer copies, from the till's settings (printSettingsOf). */
  copies: number;
  receipt: { header: ReceiptHeader; tableLabel: string | null; heads: number | null; cashierName: string; issuedAtLocal: string; footerLines: string[]; lines: ReceiptLine[]; scPwdDiscount: Money };
}
export type PayResult = { ok: true; receiptNo: string; print: PrintOutcome; lines: string[]; notice: string | null; view: ReceiptView } | { ok: false; message: string };

export function receiptViewOf(i: PayInput, receiptNo: string): ReceiptView {
  const summary = paymentSummary({ total: i.priced.total, rows: i.rows, tenders: i.tenders });
  const payments = (buildSalePayload({ ...i, receiptId: '', terminalSeq: 0 }).payments as { tenderId: string; amount: string; referenceNo?: string; toCheck: boolean }[]);
  const diners: ReceiptDiner[] = [...i.seniors].sort((a, b) => a.dinerNo - b.dinerNo).map((s) => ({ dinerNo: s.dinerNo, kind: s.kind, holderName: s.holderName.trim(), idNumber: s.idNumber.trim() }));
  return {
    header: i.receipt.header,
    receiptNo,
    issuedAtLocal: i.receipt.issuedAtLocal,
    tableLabel: i.receipt.tableLabel,
    heads: i.receipt.heads,
    cashierName: i.receipt.cashierName,
    lines: i.receipt.lines,
    subtotal: i.priced.subtotal,
    discountTotal: i.priced.discountTotal,
    total: i.priced.total,
    tenders: payments.map((p) => ({ name: i.tenders.find((t) => t.id === p.tenderId)?.name ?? 'Tender', amount: money(p.amount), reference: p.referenceNo ?? null, toCheck: p.toCheck })),
    change: money(summary.change),
    diners,
    footerLines: i.receipt.footerLines,
    offline: !i.online,
    reprint: false,
    vat: { vatRegistered: i.receipt.header.vatRegistered, vatableSales: i.priced.vat.vatableSales, vatExemptSales: i.priced.vat.vatExemptSales, vatAmount: i.priced.vat.vatAmount, vatRateLabel: i.vatRateLabel, vatRemovedForScPwd: i.priced.vat.vatRemovedForScPwd, scPwdDiscount: i.receipt.scPwdDiscount },
  };
}

/**
 * Reserve the receipt number, save the sale to the outbox, print, ask for a send. If saving fails nothing prints and the panel stays open (the reserved
 * number is spent; the gap is harmless: numbers are continuous per terminal and never reused, DEF-587). A print that fails never undoes the sale.
 */
export async function paySale(deps: PayDeps, input: PayInput): Promise<PayResult> {
  let receiptNo: string;
  let view: ReceiptView;
  let lines: string[];
  try {
    const terminalSeq = await deps.reserveTerminalSeq();
    const receiptId = deps.newId();
    receiptNo = receiptNoOf(input.terminalNo, terminalSeq);
    view = receiptViewOf(input, receiptNo);
    lines = formatReceipt(view, input.layout);
    await deps.enqueue(saleCompletedEvent({ ...input, receiptId, terminalSeq }));
  } catch {
    return { ok: false, message: SENTENCES.enqueueFailed };
  }
  deps.requestDrain(); // the sale is safe in the outbox: send it now, whatever the printer does
  let print: PrintOutcome;
  try {
    print = await deps.print(lines, { copies: input.copies });
  } catch {
    print = 'failed';
  }
  return { ok: true, receiptNo, print, lines, notice: print === 'failed' ? SENTENCES.printFailed : null, view };
}

/** The one-line summary on the Finish button: "GCASH ₱500.00 + CASH ₱1,600.00". */
export function finishLabel(rows: readonly PayRow[], tenders: readonly Tender[]): string {
  return rows
    .filter((r) => amountCents(r.amount) > 0n)
    .map((r) => `${(tenders.find((t) => t.id === r.tenderId)?.name ?? 'Tender').toUpperCase()} ₱${printAmount(centsText(amountCents(r.amount)))}`)
    .join(' + ');
}
