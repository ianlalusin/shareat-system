'use client';

/**
 * T-528 R2-R4 - the Payment screen (payment.png, payment-offline.png): the itemized bill on the left, the payments on the right. Tap a line to discount it;
 * tap a tender to add a payment with the remaining balance filled in; Finish saves the sale to the outbox, prints the receipt and closes. Online or offline
 * it is the same path. Every figure comes from `priceBill` (the server's own function) and `logic.ts`; this file only draws them and forwards taps.
 * Tokens only. Every control is 3rem or taller (`min-h-12`) and opts out of the compact-control rule (`data-erp-size="free"`).
 */
import { useMemo, useState } from 'react';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { fromCentavos, money, toCentavos, type Money } from '@shareat/core/money';
import { nativeAttrs, POS_STATUTORY_HOLDER_RULES, rulesOf } from '@shareat/domain/field-rules';
import type { PricedSession } from '@shareat/domain/pos/price';
import type { NewPosEvent } from '@/lib/pos-device';
import { printAmount } from '@/lib/pos-print/layout';
import type { PrintLayout, ReceiptView } from '@/lib/pos-print/types';
import { AmountPad } from './AmountPad';
import { receiptLinesOf, statutoryDiners, toPriceLines, type BillLineRow, type PresetLike, type ProjectedBill } from './bill';
import { DiscountSheet, type SheetTarget } from './DiscountSheet';
import {
  addPaymentRow, amountCents, appendAmountKey, applyToAllEvent, canAddPayment, discountAddedEvent, discountRemovedEvent, finishLabel, paySale, payBlocker, paymentSummary, priceBill, rateLabel,
  type DiscountAdd, type PayDeps, type PayRow, type PrintOutcome, type Tender,
} from './logic';

// Plain literals: the touch-target census reads them.
const TENDER = 'min-h-16 flex flex-1 flex-col items-center justify-center rounded-2xl border px-3 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const FINISH = 'min-h-16 w-full inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const LINE_BUTTON = 'min-h-12 w-full rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink hover:bg-canvas';
const FIELD = 'min-h-12 w-full rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const ROW = 'flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl border px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const chosen = 'border-brand bg-surface text-ink';
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
  onPaid: (done: { receiptNo: string; print: PrintOutcome; notice: string | null; view: ReceiptView; layout: PrintLayout }) => void;
}

const HEADS_SENDING_NOTE = 'The head count is still sending. You can add a discount to this line once it has sent.';
const money2 = (cents: bigint): string => printAmount(fromCentavos(cents));
const peso2 = (m: string): string => `₱${printAmount(m as Money)}`;

function BillLineView({ line, priced, scLabel, holders, onOpen, onRemove }: { line: BillLineRow; priced: PricedSession; scLabel: string; holders: Record<number, { holderName: string }>; onOpen: () => void; onRemove: (id: string) => void }) {
  const pl = priced.lines.find((x) => x.lineId === line.lineId)!;
  const hasDiscount = line.discounts.length > 0;
  return (
    <li className="border-b border-dashed border-surface-border py-2">
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
        return (
          <div key={d.id} className="flex items-center justify-between gap-3 px-2 text-sm text-success">
            <p className="min-w-0">
              {d.label} · {d.qty} {d.qty === 1 ? 'unit' : 'units'}
              {statutory && d.dinerNo !== null ? ` · diner ${d.dinerNo}${holder ? ` (${holder})` : ''}` : ''}
              {statutory && pd && toCentavos(pd.vatRemoved) > 0n ? ` · VAT off ${printAmount(pd.vatRemoved)} + ${scLabel} ${printAmount(pd.discountAmount)}` : ''}
              {d.pending ? ' · sending' : ''}
            </p>
            <span className="flex shrink-0 items-center gap-2">
              <span className="tabular-nums">{share ? `−${printAmount(share)}` : ''}</span>
              {d.removable ? (
                <button type="button" data-erp-size="free" className={SECONDARY} aria-label={`Remove ${d.label} from ${line.name}`} onClick={() => onRemove(d.id)}>
                  Remove
                </button>
              ) : null}
            </span>
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

  const priced = useMemo<PricedSession | null>(() => {
    try {
      return priceBill({ lines: toPriceLines(p.bill.lines), rules: p.rules, vatRegistered: p.vatRegistered });
    } catch {
      return null;
    }
  }, [p.bill.lines, p.rules, p.vatRegistered]);

  const diners = useMemo(() => statutoryDiners(p.bill.lines), [p.bill.lines]);
  const total = priced?.total ?? '0.00';
  const summary = paymentSummary({ total, rows, tenders: p.tenders });
  const billProblem = p.bill.problem ?? (priced === null ? 'This bill could not be priced. Check the lines and try again.' : p.bill.lines.length === 0 ? 'There is nothing on this table to pay for.' : null);
  const blocker = billProblem ?? payBlocker({ total, rows, tenders: p.tenders, diners, holders });
  const scLabel = rateLabel(p.rules.scPwdPercentBasisPoints);
  // Only cash and wallet tenders take a payment here (those are the tender kinds there are, T-524 ruling 5); both work offline, so `online` never switches one off.
  const cashEnabled = (t: Tender) => t.kind === 'cash' || t.kind === 'wallet';

  const addRow = (tender: Tender) => {
    if (!canAddPayment(rows)) return;
    setRows((r) => addPaymentRow(r, tender, summary.balance));
    setActive(rows.length);
    setFresh(true);
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
    if (blocker !== null || priced === null || busy) return;
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
      },
    });
    setBusy(false);
    if (!result.ok) setProblem(result.message);
    else p.onPaid({ receiptNo: result.receiptNo, print: result.print, notice: result.notice, view: result.view, layout: p.layout });
  };

  const changeCents = amountCents(summary.change);
  const balanceCents = amountCents(summary.balance);
  const vat = priced?.vat;

  return (
    <section aria-label={`Payment · ${p.label}`} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
      {/* Left: the bill */}
      <div className="rounded-2xl border border-surface-border bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-2xl font-bold">Bill · {p.label}</h2>
          <button type="button" data-erp-size="free" className={SECONDARY} onClick={p.onBack}>
            Back
          </button>
        </div>
        <div className="mt-2 flex justify-end">
          <button type="button" data-erp-size="free" className={SECONDARY} onClick={() => setSheet({ kind: 'all' })} disabled={p.bill.lines.length === 0}>
            Discount every line
          </button>
        </div>
        {p.bill.notices.map((n) => (
          <p key={n} role="status" className="mt-2 rounded-2xl bg-warning-soft px-4 py-3 text-sm font-semibold text-warning-ink">
            {n}
          </p>
        ))}
        {note ? (
          <p role="status" className="mt-2 rounded-2xl bg-warning-soft px-4 py-3 text-sm font-semibold text-warning-ink">
            {note}
          </p>
        ) : null}
        {priced ? (
          <ul aria-label="Bill lines" className="mt-2">
            {p.bill.lines.map((l) => (
              <BillLineView key={l.lineId} line={l} priced={priced} scLabel={scLabel} holders={holders} onOpen={() => (l.discountsBlocked ? setNote(HEADS_SENDING_NOTE) : (setNote(null), setSheet({ kind: 'line', line: l })))} onRemove={(id) => void sendDiscount(discountRemovedEvent({ personId: p.personId, now: new Date(), discountId: id }))} />
            ))}
          </ul>
        ) : null}
        {priced ? (
          <>
            <p className="mt-3 flex justify-between gap-3 border-b-2 border-ink pb-2 text-base font-semibold">
              <span>
                Subtotal {printAmount(priced.subtotal)} · discounts
              </span>
              <span className="tabular-nums">−{printAmount(priced.discountTotal)}</span>
            </p>
            <p className="mt-3 flex items-baseline justify-between gap-3">
              <span className="font-display text-3xl font-bold">Due</span>
              <span className="font-display text-3xl font-bold tabular-nums">{peso2(priced.total)}</span>
            </p>
            {vat ? (
              <p className="mt-3 text-sm text-muted">
                {p.vatRegistered
                  ? `VATable ${printAmount(vat.vatableSales)} · VAT (${rateLabel(p.rules.vatPercentBasisPoints)}) ${printAmount(vat.vatAmount)} · VAT-exempt ${printAmount(vat.vatExemptSales)} · VAT removed for SC/PWD ${printAmount(vat.vatRemovedForScPwd)}`
                  : `SC/PWD sales ${printAmount(vat.vatExemptSales)}`}
              </p>
            ) : null}
          </>
        ) : null}
        {diners.length > 0 ? (
          <div className="mt-4 space-y-3" role="group" aria-label="Senior and PWD card details">
            {diners.map((d) => (
              <fieldset key={d.dinerNo} className="space-y-2">
                <legend className="text-sm font-semibold">
                  {d.kind === 'pwd' ? 'PWD' : 'Senior'} #{d.dinerNo}
                </legend>
                <input type="text" data-erp-size="free" className={FIELD} {...HOLDER_ATTRS.holderName} placeholder="Name on the card" aria-label={`Name for ${d.kind === 'pwd' ? 'PWD' : 'Senior'} #${d.dinerNo}`} value={holders[d.dinerNo]?.holderName ?? ''} onChange={(e) => setHolders((h) => ({ ...h, [d.dinerNo]: { holderName: e.target.value, idNumber: h[d.dinerNo]?.idNumber ?? '' } }))} />
                <input type="text" data-erp-size="free" className={FIELD} {...HOLDER_ATTRS.idNumber} placeholder="ID number" aria-label={`ID number for ${d.kind === 'pwd' ? 'PWD' : 'Senior'} #${d.dinerNo}`} value={holders[d.dinerNo]?.idNumber ?? ''} onChange={(e) => setHolders((h) => ({ ...h, [d.dinerNo]: { holderName: h[d.dinerNo]?.holderName ?? '', idNumber: e.target.value } }))} />
              </fieldset>
            ))}
          </div>
        ) : null}
      </div>

      {/* Right: the payments */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Pay with">
          {p.tenders.map((t) => (
            <button key={t.id} type="button" data-erp-size="free" className={`${TENDER} ${rows[active ?? -1]?.tenderId === t.id ? chosen : idle}`} disabled={!canAddPayment(rows) || !cashEnabled(t) || billProblem !== null} onClick={() => addRow(t)}>
              <span className="text-base font-semibold">{t.name}</span>
              <span className="text-xs text-muted">{t.kind === 'cash' ? 'gives change' : p.online ? 'ref no.' : '"to check"'}</span>
            </button>
          ))}
        </div>

        <div className="rounded-2xl border border-surface-border bg-surface p-4">
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-semibold">Payments on this bill</span>
            <span className="text-sm text-muted">Split: one bill, several tenders</span>
          </p>
          {rows.length === 0 ? <p className="mt-3 text-sm text-muted">Tap a way to pay.</p> : null}
          <ul className="mt-2 space-y-2" aria-label="Payments">
            {rows.map((r, i) => {
              const tender = p.tenders.find((t) => t.id === r.tenderId);
              const wallet = tender?.kind === 'wallet';
              const shown = i === active && !fresh ? r.amount : money2(amountCents(r.amount));
              return (
                <li key={i} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <button type="button" data-erp-size="free" aria-pressed={i === active} aria-label={`${tender?.name ?? 'Payment'} amount`} className={`${ROW} flex-1 ${i === active ? chosen : idle}`} onClick={() => (setActive(i), setFresh(true))}>
                      <span className="text-base font-semibold">
                        {tender?.name ?? 'Tender'}
                        {wallet && !p.online ? <span className="ml-2 rounded-full bg-warning-soft px-2 py-1 text-xs font-semibold text-warning-ink">to check</span> : null}
                      </span>
                      <span className="font-display text-2xl font-bold tabular-nums">₱{shown === '' ? '0' : shown}</span>
                    </button>
                    <button type="button" data-erp-size="free" className={SECONDARY} aria-label={`Remove ${tender?.name ?? 'payment'} payment`} onClick={() => removeRow(i)}>
                      Remove
                    </button>
                  </div>
                  {wallet ? (
                    <input type="text" data-erp-size="free" className={FIELD} placeholder="Reference number" aria-label={`${tender?.name ?? 'Wallet'} reference number`} value={r.referenceNo ?? ''} maxLength={40} onChange={(e) => setRow(i, { referenceNo: e.target.value })} />
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" data-erp-size="free" className={SECONDARY} disabled={!canAddPayment(rows) || balanceCents === 0n || p.tenders.length === 0 || billProblem !== null} onClick={() => addRow(p.tenders.find((t) => t.id === rows[rows.length - 1]?.tenderId) ?? p.tenders[0]!)}>
              + Split: add another payment
            </button>
            <button type="button" data-erp-size="free" className={SECONDARY} disabled={active === null} onClick={exact}>
              Exact
            </button>
          </div>
        </div>

        <AmountPad
          disabled={active === null}
          onKey={key}
          onBack={() => active !== null && (setRow(active, { amount: (fresh ? '' : (rows[active]?.amount ?? '')).slice(0, -1) }), setFresh(false))}
          onClear={() => active !== null && (setRow(active, { amount: '' }), setFresh(false))}
        />

        <p className={`flex items-baseline justify-between gap-3 rounded-2xl px-4 py-3 text-lg font-semibold ${changeCents > 0n ? 'bg-success-soft text-success' : 'bg-closed-soft text-ink'}`} role="status">
          <span>{changeCents > 0n ? 'Change to give (cash)' : 'Balance'}</span>
          <span className="tabular-nums">₱{printAmount((changeCents > 0n ? summary.change : summary.balance) as Money)}</span>
        </p>

        <div className="space-y-2">
          {problem ? <p role="alert" className="text-sm font-semibold text-danger">{problem}</p> : null}
          {blocker && rows.length + diners.length + p.bill.lines.length > 0 ? <p className="text-sm text-muted" role="status">{blocker}</p> : null}
          <button type="button" data-erp-size="free" className={FINISH} disabled={blocker !== null || busy} aria-disabled={blocker !== null || busy} onClick={finish}>
            {busy ? 'Saving…' : `Finish${rows.length > 0 ? ` · ${finishLabel(rows, p.tenders)}` : ''} · print`}
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
