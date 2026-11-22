'use client';

/**
 * T-628 - the Reservations tab: today's and upcoming reservations with the deposit held on each, New reservation, Take deposit (tender + amount + reference for a wallet),
 * Seat (opens the table as usual and links it), Cancel / No-show, and, for a manager, Settle: refund or keep what is held, with a reason, before a cancelled or no-show
 * reservation can close. A narrow extension of the Orders / Till patterns (same sheets, same touch sizes): nothing new visually.
 *
 * Creating, depositing, seating, cancelling and marking a no-show are outbox events (they work offline; the list is the snapshot with the outbox laid on top). Settling is an API
 * call: it needs the internet, and the manager's PIN goes straight into that one request and is cleared after every attempt. Nothing here decides: the server judges every rule.
 */
import { useMemo, useState } from 'react';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { Banner, Dialog } from '@/components/ui';
import { enqueue } from '@/lib/pos-device';
import { printLines } from '@/lib/pos-print/adapter';
import { formatDepositSlip } from '@/lib/pos-print';
import { peso } from '@/lib/format';
import { printSettingsOf } from '../_payment/logic';
import { makeIdGenerator } from '../_orders/ids';
import { actingPersonId, submitPosEvent } from '../_orders/payloads';
import { usePos } from '../_shell/pos-context';
import {
  checkDeposit, checkReservation, depositSlipView, depositTakenEvent, heldCents, needsSettling, projectReservations, reasonProblem, reservationCreatedEvent, reservationSeatedEvent,
  reservationStatusEvent, seatTableEvent, SENTENCES, sortReservations, statusLabel, type DepositTender, type ReservationRow,
} from './logic';

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const FIELD = 'min-h-12 w-full rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const CHOICE = 'min-h-12 min-w-12 rounded-2xl border px-4 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed disabled:opacity-50';
const chosen = 'border-ink bg-warning-soft text-ink';
const idle = 'border-surface-border bg-surface text-ink hover:bg-canvas';

const newId = makeIdGenerator();
type Sheet = { kind: 'new' } | { kind: 'deposit'; r: ReservationRow } | { kind: 'seat'; r: ReservationRow } | { kind: 'settle'; r: ReservationRow };

/** The value a `datetime-local` input starts with: tonight at 19:00 on the tablet's own clock (a starting value, not a business setting). */
const startValue = (now: Date): string => {
  const d = new Date(now.getTime());
  d.setHours(19, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function Reservations() {
  const pos = usePos();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // New reservation
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [party, setParty] = useState('2');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  // Deposit / settle
  const [tenderId, setTenderId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [choice, setChoice] = useState<'refund' | 'keep' | ''>('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');

  const snapshot = pos?.ordersSnapshot ?? null;
  const tenders = (snapshot?.payment?.tenders ?? []) as DepositTender[];
  const stands = snapshot?.stands ?? [];
  const rows = useMemo(
    () => sortReservations(projectReservations((snapshot?.reservations ?? []) as ReservationRow[], pos?.pendingEvents ?? [])).filter((r) => r.status !== 'closed'),
    [snapshot?.reservations, pos?.pendingEvents],
  );
  if (!pos) return null;
  const paired = pos.paired;
  const isManager = pos.held?.has('approve_pos_correction') === true;
  const personId = actingPersonId(pos.offlineActorPersonId ? { personId: pos.offlineActorPersonId } : null, pos.personId);
  const tender = tenders.find((t) => t.id === tenderId);

  const close = () => {
    setSheet(null);
    setProblem(null);
    setBusy(false);
    setPin('');
  };
  const send = async (event: Parameters<typeof submitPosEvent>[1]): Promise<boolean> => {
    const r = await submitPosEvent({ enqueue, requestDrain: pos.requestDrain }, event);
    if (!r.ok) setProblem(r.message);
    return r.ok;
  };

  const openNew = () => {
    setName('');
    setPhone('');
    setParty('2');
    setWhen(startValue(new Date()));
    setNote('');
    setProblem(null);
    setSheet({ kind: 'new' });
  };
  const saveNew = async () => {
    const partySize = Number(party);
    const p = checkReservation({ name, phone, partySize, reservedFor: when === '' ? '' : new Date(when).toISOString(), note });
    if (p) return setProblem(p);
    setBusy(true);
    if (await send(reservationCreatedEvent({ personId, now: new Date(), reservationId: newId(), name, phone, partySize, reservedFor: new Date(when), note }))) {
      setNotice(`${name.trim()} is booked.`);
      close();
    } else setBusy(false);
  };

  const openDeposit = (r: ReservationRow) => {
    setTenderId(tenders.find((t) => t.kind === 'cash')?.id ?? '');
    setAmount('');
    setReference('');
    setProblem(null);
    setSheet({ kind: 'deposit', r });
  };
  const saveDeposit = async (r: ReservationRow) => {
    const p = checkDeposit({ amount, tender, referenceNo: reference });
    if (p) return setProblem(p);
    setBusy(true);
    const now = new Date();
    if (await send(depositTakenEvent({ personId, now, depositId: newId(), reservationId: r.id, tenderId, amount, referenceNo: tender?.kind === 'wallet' ? reference : undefined }))) {
      const store = snapshot?.payment?.store;
      if (store) {
        const slip = formatDepositSlip(
          depositSlipView({ storeName: store.name, vatRegistered: store.vatRegistered, identity: store.identity, mode: store.mode, reservation: r, takenAt: now, amount, tenderName: tender?.name ?? '', referenceNo: tender?.kind === 'wallet' ? reference : null, takenBy: pos.personName ?? '' }),
          printSettingsOf(store).layout,
        );
        await printLines(slip, { copies: 1 }).catch(() => undefined);
      }
      setNotice(`Deposit of ${peso(amount)} taken for ${r.customerName}.`);
      close();
    } else setBusy(false);
  };

  const saveSeat = async (r: ReservationRow, standId: string) => {
    setBusy(true);
    const now = new Date();
    const sessionId = newId();
    if ((await send(seatTableEvent({ personId, now, sessionId, standId, heads: r.partySize }))) && (await send(reservationSeatedEvent({ personId, now: new Date(now.getTime() + 1), reservationId: r.id, sessionId })))) {
      setNotice(`${r.customerName} is seated. Add their order on the Orders tab.`);
      close();
    } else setBusy(false);
  };

  const mark = async (r: ReservationRow, status: 'cancelled' | 'no_show') => {
    if (await send(reservationStatusEvent({ personId, now: new Date(), reservationId: r.id, status }))) setNotice(status === 'cancelled' ? `${r.customerName} is cancelled.` : `${r.customerName} is marked a no-show.`);
  };

  const openSettle = (r: ReservationRow) => {
    setChoice('');
    setReason('');
    setPin('');
    setReference('');
    setTenderId(tenders.find((t) => t.kind === 'cash')?.id ?? '');
    setProblem(null);
    setSheet({ kind: 'settle', r });
  };
  const saveSettle = async (r: ReservationRow) => {
    if (!pos.online) return setProblem(SENTENCES.manager);
    if (choice === '') return setProblem('Choose what happens to the deposit: refund it or keep it.');
    const why = reasonProblem(reason);
    if (why) return setProblem(why);
    if (choice === 'refund' && !tender) return setProblem(SENTENCES.pickTender);
    if (!isManager && pin.trim() === '') return setProblem('A manager must approve with their PIN.');
    setBusy(true);
    try {
      const res = await fetch('/api/pos/deposits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          action: 'close', reservationId: r.id,
          ...(heldCents(r) > 0n ? { resolution: { choice, eventId: newId(), reason: reason.trim(), ...(choice === 'refund' ? { tenderId, referenceNo: tender?.kind === 'wallet' ? reference : undefined } : {}) } } : {}),
          ...(pin.trim() !== '' ? { pin: pin.trim() } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (json.ok === true) {
        setNotice(choice === 'refund' ? `${peso(r.held)} refunded to ${r.customerName}.` : `${peso(r.held)} kept. ${r.customerName} is closed.`);
        close();
      } else {
        setProblem(typeof json.error === 'string' ? json.error : 'The deposit could not be settled. Try again.');
        setBusy(false);
      }
    } catch {
      setProblem('Could not reach the server. Try again when the internet is back.');
      setBusy(false);
    } finally {
      setPin('');
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">Reservations</h1>
        <button type="button" className={SECONDARY} disabled={!paired} onClick={openNew}>
          New reservation
        </button>
      </div>
      {!paired ? <Banner tone="info">Reservations are taken on the store tablet.</Banner> : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}
      {snapshot === null ? <Banner tone="warning">This tablet has not loaded the store list yet. Open it once with the internet on.</Banner> : null}
      {rows.length === 0 && snapshot !== null ? <p className="text-base text-muted">No reservations today or coming up.</p> : null}
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.id} className="rounded-2xl border border-surface-border bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 truncate text-base font-semibold text-ink">
                {r.customerName} · {r.partySize} {r.partySize === 1 ? 'guest' : 'guests'}
              </p>
              <p className="shrink-0 text-base font-semibold text-ink">{statusLabel(r.status)}</p>
            </div>
            <p className="text-base text-muted">
              {formatBusinessDateTime(new Date(r.reservedFor))}
              {r.phone ? ` · ${r.phone}` : ''}
              {r.note ? ` · ${r.note}` : ''}
            </p>
            {heldCents(r) > 0n ? <p className="text-base font-semibold text-ink tabular-nums">Deposit held {peso(r.held)}</p> : null}
            {needsSettling(r) ? <p className="text-base text-warning-ink">A manager must refund or keep this deposit before it can close.</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {paired && (r.status === 'booked' || r.status === 'seated') ? (
                <button type="button" className={SECONDARY} onClick={() => openDeposit(r)}>
                  Take deposit
                </button>
              ) : null}
              {paired && r.status === 'booked' ? (
                <button type="button" className={SECONDARY} onClick={() => { setProblem(null); setSheet({ kind: 'seat', r }); }}>
                  Seat
                </button>
              ) : null}
              {paired && r.status === 'booked' ? (
                <button type="button" className={SECONDARY} onClick={() => mark(r, 'no_show')}>
                  No-show
                </button>
              ) : null}
              {paired && (r.status === 'booked' || r.status === 'seated') ? (
                <button type="button" className={SECONDARY} onClick={() => mark(r, 'cancelled')}>
                  Cancel
                </button>
              ) : null}
              {paired && (needsSettling(r) || ((r.status === 'cancelled' || r.status === 'no_show') && heldCents(r) === 0n) || (r.status === 'seated' && heldCents(r) > 0n)) ? (
                <button type="button" className={SECONDARY} onClick={() => openSettle(r)}>
                  {heldCents(r) > 0n ? 'Settle deposit' : 'Close'}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={sheet?.kind === 'new'} onClose={close} title="New reservation" description="Hold a table for a customer." size="md">
        <div className="flex flex-col gap-3">
          <input className={FIELD} aria-label="Customer name" placeholder="Customer name" value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} />
          <input className={FIELD} aria-label="Phone number" placeholder="Phone (optional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.slice(0, 30))} />
          <input className={FIELD} aria-label="Party size" placeholder="Guests" value={party} onChange={(e) => setParty(e.target.value.replace(/\D/g, '').slice(0, 3))} />
          <input className={FIELD} aria-label="Date and time" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          <input className={FIELD} aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} />
          {problem ? <Banner tone="error">{problem}</Banner> : null}
          <button type="button" className={PRIMARY} disabled={busy} onClick={saveNew}>
            Book table
          </button>
        </div>
      </Dialog>

      <Dialog open={sheet?.kind === 'deposit'} onClose={close} title={sheet?.kind === 'deposit' ? `Deposit · ${sheet.r.customerName}` : 'Deposit'} description="The slip prints when it is saved. It counts in the drawer of today." size="md">
        {sheet?.kind === 'deposit' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {tenders.map((t) => (
                <button key={t.id} type="button" aria-pressed={tenderId === t.id} className={`${CHOICE} ${tenderId === t.id ? chosen : idle}`} onClick={() => setTenderId(t.id)}>
                  {t.name}
                </button>
              ))}
            </div>
            <input className={FIELD} aria-label="Deposit amount" placeholder="Amount (pesos)" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, '').slice(0, 15))} />
            {tender?.kind === 'wallet' ? <input className={FIELD} aria-label="Reference number" placeholder="Reference number" value={reference} onChange={(e) => setReference(e.target.value.slice(0, 40))} /> : null}
            {problem ? <Banner tone="error">{problem}</Banner> : null}
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => saveDeposit(sheet.r)}>
              Take deposit
            </button>
          </div>
        ) : null}
      </Dialog>

      <Dialog open={sheet?.kind === 'seat'} onClose={close} title={sheet?.kind === 'seat' ? `Seat · ${sheet.r.customerName}` : 'Seat'} description="Pick the table. It opens as usual with their guests." size="md">
        {sheet?.kind === 'seat' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {stands.map((s) => (
                <button key={s.id} type="button" className={`${CHOICE} ${sheet.r.standId === s.id ? chosen : idle}`} disabled={busy} onClick={() => saveSeat(sheet.r, s.id)}>
                  {s.number}
                </button>
              ))}
            </div>
            {problem ? <Banner tone="error">{problem}</Banner> : null}
          </div>
        ) : null}
      </Dialog>

      <Dialog open={sheet?.kind === 'settle'} onClose={close} title={sheet?.kind === 'settle' ? `Settle · ${sheet.r.customerName}` : 'Settle'} description="A manager decides each time. It needs the internet." size="md">
        {sheet?.kind === 'settle' ? (
          <div className="flex flex-col gap-3">
            {heldCents(sheet.r) > 0n ? (
              <>
                <p className="text-base font-semibold text-ink tabular-nums">Held {peso(sheet.r.held)}</p>
                <div className="flex gap-2">
                  <button type="button" aria-pressed={choice === 'refund'} className={`${CHOICE} flex-1 ${choice === 'refund' ? chosen : idle}`} onClick={() => setChoice('refund')}>
                    Refund it
                  </button>
                  <button type="button" aria-pressed={choice === 'keep'} className={`${CHOICE} flex-1 ${choice === 'keep' ? chosen : idle}`} onClick={() => setChoice('keep')}>
                    Keep it
                  </button>
                </div>
                {choice === 'refund' ? (
                  <div className="flex flex-wrap gap-2">
                    {tenders.map((t) => (
                      <button key={t.id} type="button" aria-pressed={tenderId === t.id} className={`${CHOICE} ${tenderId === t.id ? chosen : idle}`} onClick={() => setTenderId(t.id)}>
                        {t.name}
                      </button>
                    ))}
                  </div>
                ) : null}
                {choice === 'refund' && tender?.kind === 'wallet' ? <input className={FIELD} aria-label="Reference number" placeholder="Reference number" value={reference} onChange={(e) => setReference(e.target.value.slice(0, 40))} /> : null}
                <input className={FIELD} aria-label="Reason" placeholder="Reason (3 to 200 characters)" value={reason} onChange={(e) => setReason(e.target.value.slice(0, 200))} />
              </>
            ) : (
              <p className="text-base text-ink">Nothing is held. This closes the reservation.</p>
            )}
            {!isManager ? <input className={FIELD} aria-label="Manager PIN" placeholder="Manager PIN" type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /> : null}
            {!pos.online ? <Banner tone="warning">{SENTENCES.manager}</Banner> : null}
            {problem ? <Banner tone="error">{problem}</Banner> : null}
            <button type="button" className={PRIMARY} disabled={busy || !pos.online} onClick={() => saveSettle(sheet.r)}>
              {heldCents(sheet.r) > 0n ? 'Settle and close' : 'Close reservation'}
            </button>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
