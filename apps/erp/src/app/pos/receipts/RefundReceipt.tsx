'use client';

/**
 * T-534 S4 - "Refund" on a Receipts row: pick the items and how many, see the money back split across the receipt's own paid rows (cash first, changeable within what each can take),
 * a reason, and a manager PIN unless the signed-in person already approves. Pure presentation: the server (`recordRefund`) judges everything and answers with its own sentence, and
 * the money of each item comes from the server too (discounted, remainder-exact).
 * Online only (an API call, not an outbox event): offline the button is off and says "This needs the internet." The PIN goes straight into the one request body and is kept nowhere.
 * One request id per opened dialog, so a retry after a lost answer is the same refund (idempotent), never a second one. On success the slip prints once through the adapter.
 */
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Banner, Dialog } from '@/components/ui';
import { formatRefundSlip, printAmount, type PrintLayout } from '@/lib/pos-print';
import { printLines, type PrintResult } from '@/lib/pos-print/adapter';
import { money } from '@shareat/core/money';
import { amountCents } from '../_payment/logic';
import { LineApprovalField } from '../_shell/LineApprovalField';
import { usePos } from '../_shell/pos-context';
import { autoSplit, centsToText, refundOrder, refundTotalCents, splitProblem, type RefundLineChoice, type RefundPaymentChoice } from './refund-logic';
import { refundSlipView, type RefundSlipContext, type RefundSlipJson } from './refund-slip';

export const REFUND_NEEDS_INTERNET = 'This needs the internet.';
const REASON_MAX = 200;
const REASON_MIN = 3;

export type PostRefund = (body: {
  requestId: string;
  receiptId: string;
  lines: { receiptLineId: string; qty: number }[];
  payments: { paymentId: string; amount: string; referenceNo: string }[];
  reason: string;
  pin: string;
}) => Promise<{ ok: boolean; error?: string; slip?: RefundSlipJson }>;

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-field-border bg-surface px-4 text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const FIELD = 'min-h-12 flex w-full items-center rounded-2xl border border-field-border bg-field px-4 text-base text-ink placeholder:text-muted';

const peso = (text: string): string => printAmount(money(text));

export interface RefundReceiptProps {
  receiptId: string;
  receiptNo: string;
  lines: readonly RefundLineChoice[];
  payments: readonly RefundPaymentChoice[];
  canApprove: boolean;
  slipContext: RefundSlipContext;
  layout: PrintLayout;
  post?: PostRefund;
  print?: (lines: string[], opts: { copies: number }) => Promise<PrintResult>;
  onDone?: () => void;
}

export function RefundReceipt({ receiptId, receiptNo, lines, payments, canApprove, slipContext, layout, post, print, onDone }: RefundReceiptProps) {
  const router = useRouter();
  const pos = usePos();
  const online = pos?.online ?? true;
  const open = lines.filter((l) => l.left > 0);
  const order = refundOrder(payments);
  const [dialog, setDialog] = useState(false);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [split, setSplit] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState(false);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ refundNo: string; slip: RefundSlipJson; printed: PrintResult | null } | null>(null);
  const requestId = useRef<string | null>(null);

  const totalCents = refundTotalCents(lines, qtys);
  const reasonText = reason.trim();
  const splitText = splitProblem(payments, split, references, totalCents);
  const ready = totalCents > 0n && splitText === null && reasonText.length >= REASON_MIN && (canApprove || pin !== '');

  const spread = (next: Record<string, number>) => {
    if (edited) return;
    const parts = autoSplit(payments, refundTotalCents(lines, next));
    setSplit(Object.fromEntries(Object.entries(parts).map(([id, c]) => [id, centsToText(c)])));
  };
  const setQty = (l: RefundLineChoice, q: number) => {
    const next = { ...qtys, [l.lineId]: Math.max(0, Math.min(l.left, q)) };
    setQtys(next);
    spread(next);
  };
  const openDialog = () => {
    if (!requestId.current) requestId.current = globalThis.crypto.randomUUID();
    setProblem(null);
    setDialog(true);
  };
  const reset = () => {
    setDialog(false);
    setQtys({});
    setSplit({});
    setEdited(false);
    setReferences({});
    setReason('');
    setPin('');
    setProblem(null);
    setSaved(null);
    requestId.current = null;
  };
  const finish = () => {
    reset();
    (onDone ?? (() => router.refresh()))();
  };

  const printSlip = async (slip: RefundSlipJson, reprint: boolean): Promise<PrintResult> => {
    const doPrint = print ?? printLines;
    return doPrint(formatRefundSlip(refundSlipView(slip, slipContext, reprint), layout), { copies: 1 });
  };

  const save = async () => {
    if (!ready || busy || !requestId.current) return;
    setBusy(true);
    try {
      const doPost: PostRefund =
        post ??
        (async (body) => {
          const res = await fetch('/api/pos/refunds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
          const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; slip?: RefundSlipJson };
          return { ok: json.ok === true, error: json.error, slip: json.slip };
        });
      const answer = await doPost({
        requestId: requestId.current,
        receiptId,
        lines: open.filter((l) => (qtys[l.lineId] ?? 0) > 0).map((l) => ({ receiptLineId: l.lineId, qty: qtys[l.lineId]! })),
        payments: order.filter((p) => amountCents(split[p.paymentId]) > 0n).map((p) => ({ paymentId: p.paymentId, amount: split[p.paymentId]!.replace(/\.$/, ''), referenceNo: (references[p.paymentId] ?? '').trim() })),
        reason: reasonText,
        pin,
      });
      if (answer.ok && answer.slip) {
        setSaved({ refundNo: answer.slip.refundNo, slip: answer.slip, printed: await printSlip(answer.slip, false) });
      } else if (answer.ok) finish();
      else setProblem(answer.error ?? 'The refund could not be saved.');
    } catch {
      setProblem('The refund could not be saved. Check the internet and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (open.length === 0 || order.length === 0) return null;
  return (
    <>
      <button type="button" data-erp-size="free" className={SECONDARY} disabled={!online} aria-disabled={!online} onClick={openDialog}>
        Refund
      </button>
      {online ? null : <p className="text-sm text-muted">{REFUND_NEEDS_INTERNET}</p>}
      <Dialog open={dialog} onClose={saved ? finish : reset} title="Refund" description={`Receipt ${receiptNo}. The receipt stays as it was; the money goes back the way it was paid.`} size="md">
        {saved ? (
          <div className="space-y-4 p-5">
            <Banner tone="success">Refund {saved.refundNo} saved.</Banner>
            {saved.printed === 'failed' ? <Banner tone="warning">The slip did not print. Tap Print slip again.</Banner> : null}
            <button type="button" data-erp-size="free" className={SECONDARY} onClick={() => void printSlip(saved.slip, true).then((r) => setSaved({ ...saved, printed: r }))}>
              Print slip again
            </button>
            <button type="button" data-erp-size="free" className={PRIMARY} onClick={finish}>
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            <div className="space-y-2" role="group" aria-label="Items to refund">
              <p className="text-base font-semibold text-ink">Items to refund</p>
              {open.map((l) => {
                const q = qtys[l.lineId] ?? 0;
                return (
                  <div key={l.lineId} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base text-ink">{l.name}</p>
                      <p className="text-sm text-muted">
                        {l.left} of {l.qty} can be refunded{q > 0 ? ` · ${peso(l.amounts[q - 1] ?? '0')}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" data-erp-size="free" className={STEP} aria-label={`One less ${l.name}`} disabled={busy || q <= 0} onClick={() => setQty(l, q - 1)}>
                        −
                      </button>
                      <span className="min-w-6 text-center text-lg font-semibold tabular-nums" aria-label={`${l.name} to refund`}>
                        {q}
                      </span>
                      <button type="button" data-erp-size="free" className={STEP} aria-label={`One more ${l.name}`} disabled={busy || q >= l.left} onClick={() => setQty(l, q + 1)}>
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-lg font-semibold tabular-nums text-ink">Refund total {peso(centsToText(totalCents))}</p>
            <div className="space-y-2" role="group" aria-label="Money back">
              <p className="text-base font-semibold text-ink">Money back</p>
              {order.map((p) => (
                <div key={p.paymentId} className="space-y-2">
                  <label className="block space-y-1">
                    <span className="text-sm text-muted">
                      {p.tenderName} <span className="text-muted">(up to {peso(p.left)})</span>
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      data-erp-size="free"
                      className={FIELD}
                      aria-label={`${p.tenderName} money back`}
                      value={split[p.paymentId] ?? ''}
                      onChange={(e) => {
                        setEdited(true);
                        setSplit({ ...split, [p.paymentId]: e.target.value.replace(/[^0-9.]/g, '') });
                      }}
                    />
                  </label>
                  {p.kind === 'wallet' && amountCents(split[p.paymentId]) > 0n ? (
                    <label className="block space-y-1">
                      <span className="text-sm text-muted">Reference number of the money sent back</span>
                      <input type="text" data-erp-size="free" className={FIELD} value={references[p.paymentId] ?? ''} onChange={(e) => setReferences({ ...references, [p.paymentId]: e.target.value.slice(0, 40) })} />
                    </label>
                  ) : null}
                </div>
              ))}
            </div>
            <label className="block space-y-2">
              <span className="text-base font-semibold text-ink">Reason</span>
              <input type="text" data-erp-size="free" className={FIELD} value={reason} onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))} />
            </label>
            <LineApprovalField mode={canApprove ? 'none' : 'pin'} pin={pin} onPin={setPin} />
            {splitText && totalCents > 0n ? <Banner tone="warning">{splitText}</Banner> : null}
            {problem ? <Banner tone="error">{problem}</Banner> : null}
            <button type="button" data-erp-size="free" className={PRIMARY} disabled={!ready || busy} aria-disabled={!ready || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : `Refund ${peso(centsToText(totalCents))}`}
            </button>
          </div>
        )}
      </Dialog>
    </>
  );
}
