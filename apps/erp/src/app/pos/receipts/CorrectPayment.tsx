'use client';

/**
 * T-534 S3 - "Wrong payment method" on a Receipts row that is not yet in a Z: one dialog (which paid row, the new method, the amount, a reference for a wallet, a reason,
 * and a manager PIN unless the signed-in person already approves). Pure presentation: the server (`recordTenderCorrection`) judges everything and answers with its own sentence.
 * It is an online-only door (an API call, not an outbox event): offline the button is off and says "This needs the internet." The PIN goes straight into the one request body
 * and is kept nowhere. One request id per opened dialog, so a retry after a lost answer is the same correction (idempotent), never a second one.
 */
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { money } from '@shareat/core/money';
import { Banner, Dialog } from '@/components/ui';
import { printAmount } from '@/lib/pos-print';
import { AmountPad } from '../_payment/AmountPad';
import { amountCents, appendAmountKey } from '../_payment/logic';
import { LineApprovalField } from '../_shell/LineApprovalField';
import { usePos } from '../_shell/pos-context';

export const CORRECTION_NEEDS_INTERNET = 'This needs the internet.';
const REASON_MAX = 200;
const REASON_MIN = 3;

export interface CorrectionTender {
  id: string;
  name: string;
  kind: 'cash' | 'wallet';
}
export interface CorrectionPayment {
  paymentId: string;
  tenderId: string;
  tenderName: string;
  /** What is still free to move off this paid row (decimal text). */
  left: string;
}
export type PostCorrection = (body: { requestId: string; receiptId: string; paymentId: string; toTenderId: string; amount: string; referenceNo: string; reason: string; pin: string }) => Promise<{ ok: boolean; error?: string }>;

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const CHOICE = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-field-border bg-surface px-5 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const CHOSEN = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-5 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const FIELD = 'min-h-12 flex w-full items-center rounded-2xl border border-field-border bg-field px-4 text-base text-ink placeholder:text-muted';

const peso = (m: string): string => printAmount(money(m.replace(/\.$/, '')));

/** The plain effect of a correction: what each side does. Pure. */
export function correctionEffectText(from: string | undefined, to: CorrectionTender | undefined, amount: string): string {
  if (!from || !to || amountCents(amount) <= 0n) return '';
  const a = peso(amount);
  return `${from} −${a} · ${to.name} +${a}`;
}

export function CorrectPayment({
  receiptId, receiptNo, payments, tenders, canApprove, post, onDone,
}: { receiptId: string; receiptNo: string; payments: readonly CorrectionPayment[]; tenders: readonly CorrectionTender[]; canApprove: boolean; post?: PostCorrection; onDone?: () => void }) {
  const router = useRouter();
  const pos = usePos();
  const online = pos?.online ?? true;
  const movable = payments.filter((p) => amountCents(p.left) > 0n);
  const [open, setOpen] = useState(false);
  const [paymentId, setPaymentId] = useState('');
  const [toId, setToId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef<string | null>(null);

  const payment = movable.find((p) => p.paymentId === paymentId);
  const to = tenders.find((t) => t.id === toId);
  const options = tenders.filter((t) => t.id !== payment?.tenderId);
  const reasonText = reason.trim();
  const ready =
    payment !== undefined && to !== undefined && amountCents(amountText) > 0n && amountCents(amountText) <= amountCents(payment.left) && reasonText.length >= REASON_MIN &&
    (to.kind !== 'wallet' || reference.trim().length >= 4) && (canApprove || pin !== '');

  const pick = (p: CorrectionPayment) => {
    setPaymentId(p.paymentId);
    setAmountText(p.left); // the whole paid row by default
    if (toId === p.tenderId) setToId('');
  };
  const openDialog = () => {
    if (!requestId.current) requestId.current = globalThis.crypto.randomUUID();
    setProblem(null);
    const first = movable[0];
    if (first && paymentId === '') pick(first);
    setOpen(true);
  };
  const reset = () => {
    setOpen(false);
    setPaymentId('');
    setToId('');
    setAmountText('');
    setReference('');
    setReason('');
    setPin('');
    setProblem(null);
    requestId.current = null;
  };

  const save = async () => {
    if (!ready || busy || !requestId.current || !payment) return;
    setBusy(true);
    try {
      const doPost: PostCorrection =
        post ??
        (async (body) => {
          const res = await fetch('/api/pos/tender-corrections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
          const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
          return { ok: json.ok === true, error: json.error };
        });
      const answer = await doPost({ requestId: requestId.current, receiptId, paymentId: payment.paymentId, toTenderId: toId, amount: amountText.replace(/\.$/, ''), referenceNo: reference.trim(), reason: reasonText, pin });
      if (answer.ok) {
        reset();
        (onDone ?? (() => router.refresh()))();
      } else setProblem(answer.error ?? 'The payment method could not be corrected.');
    } catch {
      setProblem('The payment method could not be corrected. Check the internet and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (movable.length === 0) return null;
  const effect = correctionEffectText(payment?.tenderName, to, amountText);
  return (
    <>
      <button type="button" data-erp-size="free" className={SECONDARY} disabled={!online} aria-disabled={!online} onClick={openDialog}>
        Wrong payment method
      </button>
      {online ? null : <p className="text-sm text-muted">{CORRECTION_NEEDS_INTERNET}</p>}
      <Dialog open={open} onClose={reset} title="Wrong payment method" description={`Receipt ${receiptNo}. The receipt stays as it was; the day's totals move the money to the right method.`} size="md">
        <div className="space-y-4 p-5">
          {movable.length > 1 ? (
            <div className="space-y-2" role="group" aria-label="Paid with">
              <p className="text-base font-semibold text-ink">Paid with</p>
              <div className="flex flex-wrap gap-2">
                {movable.map((p) => (
                  <button key={p.paymentId} type="button" data-erp-size="free" className={p.paymentId === paymentId ? CHOSEN : CHOICE} aria-pressed={p.paymentId === paymentId} disabled={busy} onClick={() => pick(p)}>
                    {p.tenderName} {peso(p.left)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="space-y-2" role="group" aria-label="It should be">
            <p className="text-base font-semibold text-ink">It should be</p>
            <div className="flex flex-wrap gap-2">
              {options.map((t) => (
                <button key={t.id} type="button" data-erp-size="free" className={t.id === toId ? CHOSEN : CHOICE} aria-pressed={t.id === toId} disabled={busy} onClick={() => setToId(t.id)}>
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-base font-semibold text-ink">
              Amount to move <span className="font-normal text-muted">(up to {payment ? peso(payment.left) : '₱0.00'})</span>
            </p>
            <div aria-label="Amount" className={`${FIELD} justify-center text-2xl font-semibold tabular-nums`}>
              {amountText === '' ? '₱0.00' : `₱${amountText}`}
            </div>
          </div>
          <AmountPad onKey={(k) => setAmountText((v) => appendAmountKey(v, k))} onBack={() => setAmountText((v) => v.slice(0, -1))} onClear={() => setAmountText('')} disabled={busy} />
          {to?.kind === 'wallet' ? (
            <label className="block space-y-2">
              <span className="text-base font-semibold text-ink">Reference number</span>
              <input type="text" data-erp-size="free" className={FIELD} value={reference} onChange={(e) => setReference(e.target.value.slice(0, 40))} />
            </label>
          ) : null}
          <label className="block space-y-2">
            <span className="text-base font-semibold text-ink">Reason</span>
            <input type="text" data-erp-size="free" className={FIELD} value={reason} onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))} />
          </label>
          <LineApprovalField mode={canApprove ? 'none' : 'pin'} pin={pin} onPin={setPin} />
          {effect ? <p className="text-base font-semibold tabular-nums text-ink">{effect}</p> : null}
          {payment && amountCents(amountText) > amountCents(payment.left) ? <Banner tone="warning">That is more than this payment can give up.</Banner> : null}
          {problem ? <Banner tone="error">{problem}</Banner> : null}
          <button type="button" data-erp-size="free" className={PRIMARY} disabled={!ready || busy} aria-disabled={!ready || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      </Dialog>
    </>
  );
}
