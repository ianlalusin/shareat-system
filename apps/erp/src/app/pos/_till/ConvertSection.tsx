'use client';

/**
 * T-534 S2 - Convert (GCash cash-in / cash-out) on the Till tab: one dialog (From, To, amount, note) and today's open Converts with Void.
 * Pure presentation: it decides nothing and computes no balance. The server (`recordConversion` / `voidConversion`) judges everything and answers with its own sentence.
 * It is an online-only door (an API call, not an outbox event): offline the button is off and says "This needs the internet." The amount is tapped on the keypad (row 371).
 * One request id per opened dialog, so a retry after a lost answer is the same Convert (idempotent), never a second one.
 */
import { useRef, useState } from 'react';
import { money } from '@shareat/core/money';
import { Banner, Dialog } from '@/components/ui';
import { printAmount } from '@/lib/pos-print';
import { AmountPad } from '../_payment/AmountPad';
import { amountCents, appendAmountKey } from '../_payment/logic';

export const CONVERT_NEEDS_INTERNET = 'This needs the internet.';
const NOTE_MAX = 200;

export interface ConvertTender {
  id: string;
  name: string;
  kind: 'cash' | 'wallet';
}
export interface ConvertRow {
  id: string;
  fromName: string;
  toName: string;
  amount: string;
  note: string | null;
  voided: boolean;
  canVoid: boolean;
}
export interface ConvertDeps {
  postConvert: (body: { requestId: string; fromTenderId: string; toTenderId: string; amount: string; note: string }) => Promise<{ ok: boolean; error?: string }>;
  postVoidConvert: (conversionId: string) => Promise<{ ok: boolean; error?: string }>;
  newId: () => string;
}

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const CHOICE = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-field-border bg-surface px-5 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const CHOSEN = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-5 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const FIELD = 'min-h-12 flex w-full items-center rounded-2xl border border-field-border bg-field px-4 text-base text-ink placeholder:text-muted';

const peso = (m: string): string => printAmount(money(m));

/** The plain effect of a Convert: what each side does. Pure. */
export function convertEffectText(from: ConvertTender | undefined, to: ConvertTender | undefined, amount: string): string {
  if (!from || !to || amountCents(amount) <= 0n) return '';
  const a = peso(money(amount.replace(/\.$/, '')));
  return `${from.name} −${a} · ${to.name} +${a}`;
}

export function ConvertSection({ online, tenders, conversions, deps, onChanged }: { online: boolean; tenders: readonly ConvertTender[]; conversions: readonly ConvertRow[]; deps: ConvertDeps; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const requestId = useRef<string | null>(null);

  const reset = () => {
    setOpen(false);
    setFromId('');
    setToId('');
    setAmountText('');
    setNote('');
    setProblem(null);
    requestId.current = null;
  };
  const openDialog = () => {
    if (!requestId.current) requestId.current = deps.newId();
    setProblem(null);
    setOpen(true);
  };
  const from = tenders.find((t) => t.id === fromId);
  const to = tenders.find((t) => t.id === toId);
  const ready = from !== undefined && to !== undefined && from.id !== to.id && amountCents(amountText) > 0n;
  const effect = convertEffectText(from, to, amountText);

  const save = async () => {
    if (!ready || busy || !requestId.current) return;
    setBusy(true);
    try {
      const answer = await deps.postConvert({ requestId: requestId.current, fromTenderId: fromId, toTenderId: toId, amount: amountText.replace(/\.$/, ''), note: note.trim() });
      if (answer.ok) {
        reset();
        setMessage({ text: 'Convert saved.', ok: true });
        onChanged();
      } else setProblem(answer.error ?? 'The Convert could not be saved.');
    } catch {
      setProblem('The Convert could not be saved. Check the internet and try again.');
    } finally {
      setBusy(false);
    }
  };
  const voidRow = async (row: ConvertRow) => {
    setBusy(true);
    try {
      const answer = await deps.postVoidConvert(row.id);
      setMessage({ text: answer.ok ? 'Convert voided.' : (answer.error ?? 'The Convert could not be voided.'), ok: answer.ok });
      if (answer.ok) onChanged();
    } catch {
      setMessage({ text: 'The Convert could not be voided. Check the internet and try again.', ok: false });
    } finally {
      setBusy(false);
    }
  };

  const picker = (label: string, hint: string, value: string, set: (id: string) => void) => (
    <div className="space-y-2" role="group" aria-label={label}>
      <p className="text-base font-semibold text-ink">
        {label} <span className="font-normal text-muted">{hint}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {tenders.map((t) => (
          <button key={t.id} type="button" data-erp-size="free" className={t.id === value ? CHOSEN : CHOICE} aria-pressed={t.id === value} disabled={busy} onClick={() => set(t.id)}>
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section aria-labelledby="till-convert" className="space-y-3">
      <h2 id="till-convert" className="text-xl font-semibold text-ink">
        Convert
      </h2>
      <button type="button" data-erp-size="free" className={SECONDARY} disabled={!online || busy || tenders.length < 2} aria-disabled={!online || busy || tenders.length < 2} onClick={openDialog}>
        Convert (GCash cash-in / cash-out)
      </button>
      {online ? null : <p className="text-base text-muted">{CONVERT_NEEDS_INTERNET}</p>}
      {message ? <Banner tone={message.ok ? 'success' : 'error'}>{message.text}</Banner> : null}
      {conversions.length === 0 ? <p className="text-base text-muted">No Convert since the last Z.</p> : null}
      <ul className="divide-y divide-surface-border">
        {conversions.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <p className={`min-w-0 text-base tabular-nums ${row.voided ? 'text-muted line-through' : 'text-ink'}`}>
              {row.fromName} → {row.toName} · {peso(row.amount)}
              {row.note ? <span className="text-muted"> · {row.note}</span> : null}
              {row.voided ? <span className="no-underline"> (voided)</span> : null}
            </p>
            {row.canVoid ? (
              <button type="button" data-erp-size="free" className={SECONDARY} disabled={!online || busy} aria-disabled={!online || busy} onClick={() => void voidRow(row)}>
                Void
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <Dialog
        open={open}
        onClose={reset}
        title="Convert (GCash cash-in / cash-out)"
        description="The customer gives cash and gets GCash, or the other way round. This is not a sale."
        size="md"
      >
        <div className="space-y-4 p-5">
          {picker('From', '(the money that leaves)', fromId, setFromId)}
          {picker('To', '(the money that comes in)', toId, setToId)}
          <div className="space-y-2">
            <p className="text-base font-semibold text-ink">Amount</p>
            <div aria-label="Amount" className={`${FIELD} justify-center text-2xl font-semibold tabular-nums`}>
              {amountText === '' ? '₱0.00' : `₱${amountText}`}
            </div>
          </div>
          <AmountPad onKey={(k) => setAmountText((v) => appendAmountKey(v, k))} onBack={() => setAmountText((v) => v.slice(0, -1))} onClear={() => setAmountText('')} disabled={busy} />
          <label className="block space-y-2">
            <span className="text-base font-semibold text-ink">
              Note <span className="font-normal text-muted">(optional)</span>
            </span>
            <input type="text" data-erp-size="free" className={FIELD} value={note} onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))} />
          </label>
          {effect ? <p className="text-base font-semibold tabular-nums text-ink">{effect}</p> : null}
          {from && to && from.id === to.id ? <Banner tone="warning">Pick two different payment methods.</Banner> : null}
          {problem ? <Banner tone="error">{problem}</Banner> : null}
          <button type="button" data-erp-size="free" className={PRIMARY} disabled={!ready || busy} aria-disabled={!ready || busy} onClick={() => void save()}>
            Save Convert
          </button>
        </div>
      </Dialog>
    </section>
  );
}
