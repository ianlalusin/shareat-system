'use client';

/**
 * T-528 R2-R4 - the Payment screen (payment.png, payment-offline.png): the itemized bill on the left, the payments on the right. Tap a line to discount it;
 * tap a tender to add a payment with the remaining balance filled in; Finish saves the sale to the outbox, prints the receipt and closes. Online or offline
 * it is the same path. Every figure comes from `priceBill` (the server's own function) and `logic.ts`; this file only draws them and forwards taps.
 * Tokens only. Every control is 3rem or taller (`min-h-12`) and opts out of the compact-control rule (`data-erp-size="free"`).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { fromCentavos, money, toCentavos, type Money } from '@shareat/core/money';
import { nativeAttrs, POS_STATUTORY_HOLDER_RULES, rulesOf } from '@shareat/domain/field-rules';
import type { PricedSession } from '@shareat/domain/pos/price';
import { peso } from '@/lib/format';
import type { NewPosEvent } from '@/lib/pos-device';
import { printAmount } from '@/lib/pos-print/layout';
import type { PrintLayout, ReceiptView } from '@/lib/pos-print/types';
import { AmountPad } from './AmountPad';
import { receiptLinesOf, statutoryDiners, toPriceLines, type BillLineRow, type PresetLike, type ProjectedBill } from './bill';
import { DiscountSheet, type SheetTarget } from './DiscountSheet';
import {
  addSplitRow, amountCents, appendAmountKey, applyToAllEvent, canAddPayment, chooseTender, discountAddedEvent, discountRemovedEvent, finishLabel, paySale, payBlockerDetail, paymentSummary, priceBill, rateLabel, scPwdDiscountOf,
  type BlockerTarget, type DiscountAdd, type PayDeps, type PayRow, type PrintOutcome, type Tender,
} from './logic';

// Plain literals: the touch-target census reads them.
const TENDER = 'min-h-14 flex flex-1 flex-col items-center justify-center rounded-2xl border px-3 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const FINISH = 'min-h-14 w-full inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const REASON = 'min-h-12 w-full rounded-2xl bg-warning-soft px-4 py-2 text-left text-base font-semibold text-warning-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const ICON_BUTTON = 'min-h-12 min-w-12 shrink-0 inline-flex items-center justify-center rounded-full text-muted hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const LINE_BUTTON = 'min-h-12 w-full rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink hover:bg-canvas';
const FIELD = 'min-h-12 w-full rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const REF_FIELD = 'min-h-12 min-w-0 flex-1 scroll-mt-8 rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const ROW = 'flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl border px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const chosen = 'border-surface-border bg-warning-soft text-ink';
const idle = 'border-surface-border bg-surface text-ink hover:bg-canvas';
const HOLDER_ATTRS = Object.fromEntries(rulesOf(POS_STATUTORY_HOLDER_RULES).map((r) => [r.name, nativeAttrs(r)]));

export interface PaymentPanelProps {
  sessionId: string;
  /** "Stand 7" or "Take-out". */
  label: string;
  /** The billed heads: the larger of the cashier's and the server's count. */
  heads: number;
  isTakeOut: boolean;
  bill: ProjectedBill;
  presets: readonly PresetLike[];
  tenders: readonly Tender[];
  rules: { vatPercentBasisPoints: number; scPwdPercentBasisPoints: number };
  vatRegistered: boolean;
  terminalNo: number;
  storeName: string;
  cashierName: string;
  personId: string;
  online: boolean;
  layout: PrintLayout;
  deps: PayDeps;
  /** Saves one discount event to the outbox (and asks for a send); resolves to a sentence when that failed. */
  sendEvent: (event: NewPosEvent) => Promise<string | null>;
  newId: () => string;
  onBack: () => void;
  /** The sale is saved (and sent to the printer). Orders now owns the receipt screen, so it outlives this panel and the table leaving the open list. */
  onPaid: (done: { receiptNo: string; print: PrintOutcome; notice: string | null; view: ReceiptView; layout: PrintLayout; lines: string[] }) => void;
}

const HEADS_SENDING_NOTE = 'The head count is still sending. You can add a discount to this line once it has sent.';
/** A row's amount: a finished figure is a peso figure (₱1,600.00); what the cashier is still typing keeps its own decimals but never loses its comma (₱1,600). */
const rowAmount = (raw: string, typing: boolean): string => (typing ? `₱${printAmount((raw === '' ? '0' : raw) as Money)}` : peso(fromCentavos(amountCents(raw))));
const FOCUS_SELECTORS = {
  holder: (t: Extract<BlockerTarget, { kind: 'holder' }>) => `[data-holder="${t.dinerNo}-${t.field}"]`,
  row: (t: Extract<BlockerTarget, { kind: 'row' }>) => (t.field === 'tender' ? '[data-tender]:not(:disabled)' : `[data-row="${t.index}"] [data-focus="${t.field}"]`),
  tenders: () => '[data-tender]:not(:disabled)',
} as const;

function BillLineView({ line, priced, scLabel, holders, onOpen, onRemove }: { line: BillLineRow; priced: PricedSession; scLabel: string; holders: Record<number, { holderName: string }>; onOpen: () => void; onRemove: (id: string) => void }) {
  const pl = priced.lines.find((x) => x.lineId === line.lineId)!;
  const hasDiscount = line.discounts.length > 0;
  return (
    <li className="border-b border-dashed border-surface-border py-1">
      <button type="button" data-erp-size="free" className={`${LINE_BUTTON} px-2 py-2`} aria-label={`Discount ${line.name}`} onClick={onOpen}>
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 text-base font-semibold">
            {line.qty} × {line.name} <span className="font-normal text-muted">@ {printAmount(line.unitPrice as Money)}</span>
          </span>
          <span className="shrink-0 text-base font-semibold tabular-nums">{printAmount(pl.gross)}</span>
        </span>
      </button>
      {line.discounts.map((d) => {
        const pd = pl.discounts.find((x) => x.discountId === d.id);
        const statutory = d.kind === 'senior' || d.kind === 'pwd';
        const holder = statutory && d.dinerNo !== null ? holders[d.dinerNo]?.holderName?.trim() : '';
        const share = pd ? fromCentavos(toCentavos(pd.vatRemoved) + toCentavos(pd.discountAmount)) : null;
        const detail = [
          statutory && d.dinerNo !== null ? `diner ${d.dinerNo}${holder ? ` (${holder})` : ''}` : '',
          statutory && pd && toCentavos(pd.vatRemoved) > 0n ? `VAT off ${printAmount(pd.vatRemoved)} + ${scLabel} ${printAmount(pd.discountAmount)}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <div key={d.id} className="flex items-center justify-between gap-2 px-2 text-sm text-success">
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-baseline gap-1">
                <span className="truncate" title={d.label}>{d.label}</span>
                <span className="shrink-0">
                  · {d.qty} {d.qty === 1 ? 'unit' : 'units'}
                  {d.pending ? ' · sending' : ''}
                </span>
              </p>
              {detail ? <p className="text-xs">{detail}</p> : null}
            </div>
            <span className="shrink-0 tabular-nums">{share ? `−${printAmount(share)}` : ''}</span>
            {d.removable ? (
              <button type="button" data-erp-size="free" className={ICON_BUTTON} aria-label={`Remove ${d.label}`} onClick={() => onRemove(d.id)}>
                <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true" focusable="false">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            ) : null}
          </div>
        );
      })}
      {hasDiscount ? (
        <p className="flex justify-between gap-3 px-2 text-sm text-muted">
          <span>Line net</span>
          <span className="tabular-nums">{printAmount(pl.net)}</span>
        </p>
      ) : null}
    </li>
  );
}

export function PaymentPanel(p: PaymentPanelProps) {
  const [rows, setRows] = useState<PayRow[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [fresh, setFresh] = useState(false); // the next digit replaces the pre-filled amount
  const [holders, setHolders] = useState<Record<number, { holderName: string; idNumber: string }>>({});
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [focusNew, setFocusNew] = useState<number | null>(null);
  const billScrollRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // A second tap in the same moment sees the old `busy`, so the guard is a ref: one sale per Finish.
  const finishing = useRef(false);
  const [fitPx, setFitPx] = useState<number | null>(null);
  const fitRef = useRef<number | null>(null);
  const uid = useId();

  // The panel is exactly one screen tall from where it starts (whatever the top bar and notices above it are): the bill and the payment rows scroll inside it, the totals and Finish do not.
  // It measures again whenever the page changes size (a font arriving, a banner), and trims whatever still overflows the window, so the page itself never scrolls.
  useLayoutEffect(() => {
    const fit = () => {
      const el = sectionRef.current;
      if (!el) return;
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const room = Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - rem);
      const overflow = document.documentElement.scrollHeight - window.innerHeight;
      const next = Math.max(0, overflow > 0 && fitRef.current !== null ? Math.min(room, fitRef.current - overflow) : room);
      fitRef.current = next;
      setFitPx((cur) => (cur === next ? cur : next));
    };
    fit();
    window.addEventListener('resize', fit);
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    watch?.observe(document.body);
    void document.fonts?.ready.then(fit);
    return () => {
      window.removeEventListener('resize', fit);
      watch?.disconnect();
    };
  }, []);

  // The bill box always opens at its first line, whatever the browser remembers: on mount, for a different table, and when the table's lines first arrive.
  const billLoaded = p.bill.lines.length > 0;
  useLayoutEffect(() => {
    if (billScrollRef.current) billScrollRef.current.scrollTop = 0;
  }, [p.sessionId, billLoaded]);

  // Split: bring the new row into view inside the payments box and put focus on the first way to pay (the new row has none yet).
  useEffect(() => {
    if (focusNew === null) return;
    const root = sectionRef.current;
    root?.querySelector(`[data-row="${focusNew}"]`)?.scrollIntoView?.({ block: 'nearest' });
    root?.querySelector<HTMLElement>('[data-tender]:not(:disabled)')?.focus();
    setFocusNew(null);
  }, [focusNew]);

  const priced = useMemo<PricedSession | null>(() => {
    try {
      return priceBill({ lines: toPriceLines(p.bill.lines), rules: p.rules, vatRegistered: p.vatRegistered });
    } catch {
      return null;
    }
  }, [p.bill.lines, p.rules, p.vatRegistered]);

  const diners = useMemo(() => statutoryDiners(p.bill.lines), [p.bill.lines]);
  const scPwdDiscount = useMemo(() => (priced ? scPwdDiscountOf(toPriceLines(p.bill.lines), priced) : null), [priced, p.bill.lines]);
  const total = priced?.total ?? '0.00';
  const summary = paymentSummary({ total, rows, tenders: p.tenders });
  const billProblem = p.bill.problem ?? (priced === null ? 'This bill could not be priced. Check the lines and try again.' : p.bill.lines.length === 0 ? 'There is nothing on this table to pay for.' : null);
  const detail = billProblem ? null : payBlockerDetail({ total, rows, tenders: p.tenders, diners, holders });
  const blocker = billProblem ?? detail?.message ?? null;
  const scLabel = rateLabel(p.rules.scPwdPercentBasisPoints);
  // Only cash and wallet tenders take a payment here (those are the tender kinds there are, T-524 ruling 5); both work offline, so `online` never switches one off.
  const cashEnabled = (t: Tender) => t.kind === 'cash' || t.kind === 'wallet';
  const hasOpenRow = rows.some((r) => r.tenderId === '');

  const addRow = (tender: Tender) => {
    if (!hasOpenRow && !canAddPayment(rows)) return;
    const out = chooseTender(rows, tender, summary.balance);
    setRows(out.rows);
    setActive(out.index);
    setFresh(true);
  };
  const split = () => {
    if (!canAddPayment(rows) || hasOpenRow) return;
    setRows((r) => addSplitRow(r, summary.balance));
    setActive(rows.length);
    setFresh(true);
    setFocusNew(rows.length);
  };
  const setRow = (i: number, patch: Partial<PayRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeRow = (i: number) => {
    setRows((r) => r.filter((_, j) => j !== i));
    setActive((a) => (a === null || a === i ? null : a > i ? a - 1 : a));
  };
  const key = (k: string) => {
    if (active === null) return;
    const current = rows[active];
    if (!current) return;
    setRow(active, { amount: appendAmountKey(fresh ? '' : current.amount, k) });
    setFresh(false);
  };
  const exact = () => {
    if (active === null) return;
    const others = rows.reduce((a, r, j) => (j === active ? a : a + amountCents(r.amount)), 0n);
    const due = toCentavos(money(total));
    setRow(active, { amount: fromCentavos(due > others ? due - others : 0n) });
    setFresh(false);
  };

  /** The reason beside Finish takes the cashier to the field that needs fixing and scrolls it into view. */
  const goToBlocker = () => {
    const t = detail?.target;
    const root = sectionRef.current;
    if (!t || !root) return;
    const sel = t.kind === 'holder' ? FOCUS_SELECTORS.holder(t) : t.kind === 'row' ? FOCUS_SELECTORS.row(t) : FOCUS_SELECTORS.tenders();
    const el = root.querySelector<HTMLElement>(sel);
    if (t.kind === 'row' && t.field === 'amount') {
      setActive(t.index);
      setFresh(true);
    }
    if (!el) return;
    el.focus();
    el.scrollIntoView?.({ block: 'center' });
  };

  const sendDiscount = async (event: NewPosEvent): Promise<string | null> => {
    try {
      return await p.sendEvent(event);
    } catch (e) {
      return e instanceof Error ? e.message : 'That could not be saved.';
    }
  };
  const addDiscount = (add: DiscountAdd & { presetId?: string }) =>
    sendDiscount(
      discountAddedEvent({
        personId: p.personId,
        now: new Date(),
        discountId: p.newId(),
        lineId: add.lineId,
        kind: add.kind,
        qty: add.qty,
        ...(add.presetId !== undefined ? { presetId: add.presetId } : {}),
        ...(add.valueType !== undefined ? { valueType: add.valueType } : {}),
        ...(add.value !== undefined ? { value: add.value } : {}),
        ...(add.dinerNo !== undefined ? { dinerNo: add.dinerNo } : {}),
      }),
    );

  const finish = async () => {
    if (blocker !== null || priced === null || scPwdDiscount === null || busy || sent || finishing.current) return;
    finishing.current = true;
    setBusy(true);
    setProblem(null);
    const now = new Date();
    const result = await paySale(p.deps, {
      personId: p.personId,
      sessionId: p.sessionId,
      online: p.online,
      terminalNo: p.terminalNo,
      now,
      priced,
      rows,
      tenders: p.tenders,
      seniors: diners.map((d) => ({ dinerNo: d.dinerNo, kind: d.kind, holderName: holders[d.dinerNo]!.holderName, idNumber: holders[d.dinerNo]!.idNumber })),
      vatRateLabel: rateLabel(p.rules.vatPercentBasisPoints),
      layout: p.layout,
      receipt: {
        header: { businessName: p.storeName, addressLines: [], tin: null, vatRegistered: p.vatRegistered },
        tableLabel: p.isTakeOut ? null : p.label,
        heads: p.isTakeOut ? null : p.heads,
        cashierName: p.cashierName,
        issuedAtLocal: formatBusinessDateTime(now, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''),
        footerLines: [],
        lines: receiptLinesOf(p.bill.lines, priced),
        scPwdDiscount,
      },
    });
    setBusy(false);
    if (!result.ok) {
      finishing.current = false; // nothing was saved: Finish may be tried again
      setProblem(result.message);
    } else {
      setSent(true);
      p.onPaid({ receiptNo: result.receiptNo, print: result.print, notice: result.notice, view: result.view, layout: p.layout, lines: result.lines });
    }
  };

  const changeCents = amountCents(summary.change);
  const balanceCents = amountCents(summary.balance);
  const vat = priced?.vat;
  const vatRow = (label: string, amount: string) => (
    <p key={label} className="flex justify-between gap-3">
      <span>{label}</span>
      <span className="tabular-nums">{amount}</span>
    </p>
  );

  return (
    <section
      ref={sectionRef}
      aria-label={`Payment · ${p.label}`}
      style={fitPx === null ? undefined : ({ '--pay-h': `${fitPx}px` } as CSSProperties)}
      className="grid gap-4 lg:h-[var(--pay-h,calc(100dvh-8rem))] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden"
    >
      {/* Left: the bill. The lines scroll on their own; the totals stay in view under them. */}
      <div className="flex min-h-0 flex-col rounded-2xl border border-surface-border bg-surface">
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-3">
          <h2 className="min-w-0 truncate font-display text-2xl font-bold">Bill · {p.label}</h2>
          <span className="flex shrink-0 gap-2">
            <button type="button" data-erp-size="free" className={SECONDARY} onClick={() => setSheet({ kind: 'all' })} disabled={p.bill.lines.length === 0}>
              Discount every line
            </button>
            <button type="button" data-erp-size="free" className={SECONDARY} onClick={p.onBack}>
              Back
            </button>
          </span>
        </div>
        <div ref={billScrollRef} data-region="bill-scroll" className="min-h-0 flex-1 px-4 pb-2 [overflow-anchor:none] lg:overflow-y-auto">
          {p.bill.notices.map((n) => (
            <p key={n} role="status" className="mb-2 rounded-2xl bg-warning-soft px-4 py-3 text-sm font-semibold text-warning-ink">
              {n}
            </p>
          ))}
          {note ? (
            <p role="status" className="mb-2 rounded-2xl bg-warning-soft px-4 py-3 text-sm font-semibold text-warning-ink">
              {note}
            </p>
          ) : null}
          {priced ? (
            <ul aria-label="Bill lines">
              {p.bill.lines.map((l) => (
                <BillLineView key={l.lineId} line={l} priced={priced} scLabel={scLabel} holders={holders} onOpen={() => (l.discountsBlocked ? setNote(HEADS_SENDING_NOTE) : (setNote(null), setSheet({ kind: 'line', line: l })))} onRemove={(id) => void sendDiscount(discountRemovedEvent({ personId: p.personId, now: new Date(), discountId: id }))} />
              ))}
            </ul>
          ) : null}
          {diners.length > 0 ? (
            <div className="mt-4 space-y-3" role="group" aria-label="Senior and PWD card details">
              {diners.map((d) => (
                <fieldset key={d.dinerNo} className="space-y-2">
                  <legend className="text-sm font-semibold">
                    {d.kind === 'pwd' ? 'PWD' : 'Senior'} #{d.dinerNo}
                  </legend>
                  <input type="text" data-erp-size="free" data-holder={`${d.dinerNo}-holderName`} className={FIELD} {...HOLDER_ATTRS.holderName} placeholder="Name on the card" aria-label={`Name for ${d.kind === 'pwd' ? 'PWD' : 'Senior'} #${d.dinerNo}`} value={holders[d.dinerNo]?.holderName ?? ''} onChange={(e) => setHolders((h) => ({ ...h, [d.dinerNo]: { holderName: e.target.value, idNumber: h[d.dinerNo]?.idNumber ?? '' } }))} />
                  <input type="text" data-erp-size="free" data-holder={`${d.dinerNo}-idNumber`} className={FIELD} {...HOLDER_ATTRS.idNumber} placeholder="ID number" aria-label={`ID number for ${d.kind === 'pwd' ? 'PWD' : 'Senior'} #${d.dinerNo}`} value={holders[d.dinerNo]?.idNumber ?? ''} onChange={(e) => setHolders((h) => ({ ...h, [d.dinerNo]: { holderName: h[d.dinerNo]?.holderName ?? '', idNumber: e.target.value } }))} />
                </fieldset>
              ))}
            </div>
          ) : null}
        </div>
        {priced ? (
          <div data-region="bill-totals" className="shrink-0 border-t-2 border-ink px-4 py-3">
            <p className="flex justify-between gap-3 text-base font-semibold">
              <span>Subtotal {printAmount(priced.subtotal)} · discounts</span>
              <span className="tabular-nums">−{printAmount(priced.discountTotal)}</span>
            </p>
            <p className="flex items-baseline justify-between gap-3">
              <span className="font-display text-3xl font-bold">Due</span>
              <span className="font-display text-3xl font-bold tabular-nums">{peso(priced.total)}</span>
            </p>
            <details className="text-sm">
              <summary className="flex min-h-12 cursor-pointer items-center font-semibold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink">VAT details</summary>
              {vat ? (
            <div role="group" aria-label="VAT breakdown" className="space-y-0.5 pb-2 text-sm text-muted">
              {p.vatRegistered ? (
                <>
                  {vatRow('VATable', printAmount(vat.vatableSales))}
                  {vatRow(`VAT (${rateLabel(p.rules.vatPercentBasisPoints)})`, printAmount(vat.vatAmount))}
                  {vatRow('VAT-exempt', printAmount(vat.vatExemptSales))}
                  {scPwdDiscount !== null && amountCents(scPwdDiscount) > 0n ? vatRow('Less: SC/PWD discount', `−${printAmount(scPwdDiscount)}`) : null}
                  {vatRow('VAT removed for SC/PWD', printAmount(vat.vatRemovedForScPwd))}
                </>
              ) : (
                vatRow('SC/PWD sales', printAmount(vat.vatExemptSales))
              )}
            </div>
          ) : null}
            </details>
          </div>
        ) : null}
      </div>

      {/* Right: the payments. Only the payment rows scroll; the pad, the change line and Finish stay where the thumb is. */}
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex shrink-0 flex-wrap gap-2" role="group" aria-label="Pay with">
          {p.tenders.map((t) => (
            <button key={t.id} type="button" data-erp-size="free" data-tender className={`${TENDER} ${rows[active ?? -1]?.tenderId === t.id ? chosen : idle}`} disabled={(!canAddPayment(rows) && !hasOpenRow) || !cashEnabled(t) || billProblem !== null} onClick={() => addRow(t)}>
              <span className="text-base font-semibold">{t.name}</span>
              <span className="text-xs text-muted">{t.kind === 'cash' ? 'gives change' : p.online ? 'ref no.' : '"to check"'}</span>
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-surface-border bg-surface p-2">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
            <span className="text-base font-semibold">Payments on this bill</span>
            <span className="flex gap-2">
              <button type="button" data-erp-size="free" className={SECONDARY} disabled={!canAddPayment(rows) || hasOpenRow || balanceCents === 0n || p.tenders.length === 0 || billProblem !== null} onClick={split}>
                + Split: add another payment
              </button>
              <button type="button" data-erp-size="free" className={SECONDARY} disabled={active === null} onClick={exact}>
                Exact
              </button>
            </span>
          </div>
          <div data-region="payments-scroll" className="mt-2 min-h-0 flex-1 scroll-pt-2 pt-1 lg:overflow-y-auto">
            {rows.length === 0 ? <p className="text-sm text-muted">Tap a way to pay.</p> : null}
            <ul className="space-y-1" aria-label="Payments">
              {rows.map((r, i) => {
                const tender = p.tenders.find((t) => t.id === r.tenderId);
                const wallet = tender?.kind === 'wallet';
                const refId = `${uid}-ref-${i}`;
                return (
                  <li key={i} data-row={i} className="space-y-1 border-b border-dashed border-surface-border pb-2">
                    <div className="flex items-center gap-2">
                      <button type="button" data-erp-size="free" data-focus="amount" aria-pressed={i === active} aria-label={`${tender?.name ?? 'Payment'} amount`} className={`${ROW} flex-1 ${i === active ? chosen : idle}`} onClick={() => (setActive(i), setFresh(true))}>
                        <span className="text-base font-semibold">
                          {tender?.name ?? 'Pick a way to pay'}
                          {wallet && !p.online ? <span className="ml-2 rounded-full bg-warning-soft px-2 py-1 text-xs font-semibold text-warning-ink">to check</span> : null}
                        </span>
                        <span data-amount className="font-display text-2xl font-bold tabular-nums">
                          {rowAmount(r.amount, i === active && !fresh)}
                        </span>
                      </button>
                      <button type="button" data-erp-size="free" className={SECONDARY} aria-label={`Remove ${tender?.name ?? 'payment'} payment`} onClick={() => removeRow(i)}>
                        Remove
                      </button>
                    </div>
                    {wallet ? (
                      <div className="flex items-center gap-2">
                        <label htmlFor={refId} className="shrink-0 text-sm font-semibold text-ink">
                          Reference no.
                        </label>
                        <input id={refId} type="text" data-erp-size="free" data-focus="reference" className={REF_FIELD} aria-label={`${tender?.name ?? 'Wallet'} Reference no.`} value={r.referenceNo ?? ''} maxLength={40} onChange={(e) => setRow(i, { referenceNo: e.target.value })} onFocus={(e) => e.currentTarget.closest('[data-row]')?.scrollIntoView?.({ block: 'nearest' })} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="shrink-0">
          <AmountPad
            disabled={active === null}
            onKey={key}
            onBack={() => active !== null && (setRow(active, { amount: (fresh ? '' : (rows[active]?.amount ?? '')).slice(0, -1) }), setFresh(false))}
            onClear={() => active !== null && (setRow(active, { amount: '' }), setFresh(false))}
          />
        </div>

        <div data-region="pay-footer" className="shrink-0 space-y-2">
          <p className={`flex items-baseline justify-between gap-3 rounded-2xl px-4 py-1.5 text-lg font-semibold ${changeCents > 0n ? 'bg-success-soft text-success' : 'bg-closed-soft text-ink'}`} role="status">
            <span>{changeCents > 0n ? 'Change to give (cash)' : 'Balance'}</span>
            <span className="tabular-nums">{peso(changeCents > 0n ? summary.change : summary.balance)}</span>
          </p>
          <div data-region="pay-reason-slot" className="min-h-12">
            {blocker && rows.length + diners.length + p.bill.lines.length > 0 ? (
              detail ? (
                <button type="button" data-erp-size="free" className={REASON} onClick={goToBlocker}>
                  {blocker}
                </button>
              ) : (
                <p role="status" className="flex min-h-12 items-center rounded-2xl bg-warning-soft px-4 py-2 text-base font-semibold text-warning-ink">{blocker}</p>
              )
            ) : problem ? (
              <p role="alert" className="flex min-h-12 items-center text-base font-semibold text-danger">{problem}</p>
            ) : null}
          </div>
          <button type="button" data-erp-size="free" className={FINISH} disabled={blocker !== null || busy || sent} aria-disabled={blocker !== null || busy || sent} onClick={finish}>
            {busy ? 'Saving…' : hasOpenRow ? 'Pick a way to pay' : `Finish${rows.length > 0 ? ` · ${finishLabel(rows, p.tenders)}` : ''} · print`}
          </button>
        </div>
      </div>

      {sheet ? (
        <DiscountSheet
          target={sheet}
          bill={p.bill.lines}
          heads={p.heads}
          presets={p.presets}
          onClose={() => setSheet(null)}
          onAdd={addDiscount}
          onApplyAll={(presetId) => sendDiscount(applyToAllEvent({ personId: p.personId, now: new Date(), sessionId: p.sessionId, presetId, applyId: p.newId() }))}
        />
      ) : null}

    </section>
  );
}
