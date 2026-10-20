'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { ArrowLeftRight } from 'lucide-react';
import { db } from '@/lib/firebase/client';
import { useAuthContext } from '@/context/auth-context';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { getDayIdFromTimestamp } from '@/lib/analytics/daily';
import { parsePesoInput, storedPesosToCentavos } from '@/lib/money/centavos';
import { formatCentavos } from '@/lib/money/format';
import { postPos2 } from '@/lib/pos2/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { convertButtonState, convertEffectText, conversionRows, conversionsNet, decodeConversionAttempt, directionLabel,
  type ConversionAttempt, type ConversionDoc, type Direction } from './convert-sheet-logic';

export function ConvertSheet({ storeId }: { storeId: string }) {
  const { appUser } = useAuthContext();
  const online = useOnlineStatus();
  const button = convertButtonState(online);
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<Direction>('cash_in');
  const [wallet, setWallet] = useState('GCash');
  const [wallets, setWallets] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [attempt, setAttempt] = useState<ConversionAttempt | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [docs, setDocs] = useState<ConversionDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowsFailed, setRowsFailed] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState<string | null>(null);
  const [dayId, setDayId] = useState(() => getDayIdFromTimestamp(Date.now()));
  const storageKey = `pos2.convert.${appUser?.uid ?? ''}.${storeId}`;

  useEffect(() => {
    try {
      const text = sessionStorage.getItem(storageKey);
      const recovered = text ? decodeConversionAttempt(JSON.parse(text)) : null;
      setAttempt(recovered); setRecoveryBlocked(Boolean(text && !recovered));
    } catch { setRecoveryBlocked(true); }
  }, [storageKey]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setDayId(getDayIdFromTimestamp(Date.now())), 60_000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setDayId(getDayIdFromTimestamp(Date.now())); setLoading(true); setRowsFailed(false);
    const stopMethods = onSnapshot(collection(db, 'stores', storeId, 'storeModesOfPayment'), (snap) => {
      const available = snap.docs.map((d) => d.data()).filter((m) => m.type === 'online' && m.isActive !== false && m.isArchived !== true)
        .map((m) => String(m.name)).sort();
      setWallets(available);
      setWallet((old) => available.includes(old) ? old : available.find((m) => m.toLowerCase() === 'gcash') ?? available[0] ?? '');
    }, () => setError('Could not load payment methods. Close and reopen Convert to try again.'));
    const stopRows = onSnapshot(query(collection(db, 'stores', storeId, 'paymentConversions'), where('dayId', '==', dayId)), { includeMetadataChanges: true }, (snap) => {
      setDocs(snap.docs.map((d) => ({ ...d.data(), id: d.id } as ConversionDoc))); setLoading(snap.metadata.fromCache);
    }, () => { setLoading(false); setRowsFailed(true); setError("Could not load today's conversions. Close and reopen Convert to try again."); });
    return () => { stopMethods(); stopRows(); };
  }, [open, storeId, dayId]);

  const parsed = useMemo(() => {
    if (!amount.trim()) return { cents: 0, error: '' };
    try { return { cents: parsePesoInput(amount), error: '' }; }
    catch (e) { return { cents: 0, error: (e as Error).message }; }
  }, [amount]);
  const rows = conversionRows(docs);
  const net = conversionsNet(docs);
  const effect = convertEffectText(attempt?.direction ?? direction, attempt?.walletMethod ?? wallet, attempt?.amountCentavos ?? parsed.cents);
  const locked = busy || Boolean(attempt) || recoveryBlocked;

  const save = async () => {
    if (inFlight.current || !online || recoveryBlocked) return;
    if (!attempt && (!wallet || parsed.cents <= 0 || parsed.error)) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const request = attempt ?? { requestId: crypto.randomUUID(), direction, walletMethod: wallet, amountCentavos: parsed.cents, note: note.trim() };
      // Persist the SAME request before sending. Reload/close/network failure never silently creates another money move.
      try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
      catch { throw new Error('This browser could not remember the request safely. Enable session storage before recording a conversion.'); }
      setAttempt(request);
      const result = await postPos2<{ warning?: string }>('conversions', { storeId, ...request });
      // A cleanup failure must never turn a known successful save into a failure message. Retrying this envelope is safe.
      try { sessionStorage.removeItem(storageKey); setAttempt(null); } catch { /* Keep the successful envelope for safe replay. */ }
      setAmount(''); setNote(''); setNotice(result.warning ?? 'Recorded.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not confirm the result. Retry this same request.'); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const clearCheckedAttempt = () => {
    if (busy) return;
    try { sessionStorage.removeItem(storageKey); setAttempt(null); setRecoveryBlocked(false); setError(''); }
    catch { setError('This browser could not clear the stored request. Keep this page open and ask a manager.'); }
  };
  const voidConversion = async (id: string) => {
    if (inFlight.current || !online) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await postPos2('conversions/void', { storeId, conversionId: id, requestId: crypto.randomUUID() });
      setConfirmVoid(null); setNotice('Conversion voided.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not confirm the void. Check the conversion and retry.'); }
    finally { inFlight.current = false; setBusy(false); }
  };

  if (!appUser) return null;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" size="sm" disabled={button.disabled} title={button.hint ?? undefined} className="min-h-11 lg:min-h-9">
      <ArrowLeftRight className="mr-2 h-4 w-4" />{button.label}{button.hint && <span className="ml-2 text-xs">{button.hint}</span>}
    </Button></DialogTrigger>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
      <DialogHeader><DialogTitle>Convert</DialogTitle><DialogDescription>Move money between the drawer and an e-wallet. Sales stay the same.</DialogDescription></DialogHeader>
      {!online && <p role="status">Needs the internet</p>}
      {error && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="rounded border p-3 text-sm">{notice}</p>}
      {(attempt || recoveryBlocked) && <div className="rounded border p-3 text-sm space-y-2">
        <p>{recoveryBlocked ? 'The stored request could not be read. Check today’s conversions before starting another.' : 'A request is saved on this tab. Retry it to confirm the result before starting another conversion.'}</p>
        <Button variant="outline" className="min-h-11 whitespace-normal" disabled={busy || loading || rowsFailed || !online} onClick={clearCheckedAttempt}>I checked the list; start another conversion</Button>
      </div>}
      <div className="grid gap-4 md:grid-cols-2">
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset disabled={locked} className="grid grid-cols-2 gap-2">
            {(['cash_in', 'cash_out'] as const).map((d) => <Button type="button" key={d} variant={(attempt?.direction ?? direction) === d ? 'default' : 'outline'}
              aria-pressed={(attempt?.direction ?? direction) === d} className="min-h-11 h-auto whitespace-normal p-2 text-sm" onClick={() => setDirection(d)}>{directionLabel(d, wallet)}</Button>)}
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-sm">E-wallet<select className="min-h-11 rounded-md border bg-background px-2 lg:min-h-9" disabled={locked || wallets.length === 0}
              value={attempt?.walletMethod ?? wallet} onChange={(event) => setWallet(event.target.value)}>
              {attempt && !wallets.includes(attempt.walletMethod) && <option>{attempt.walletMethod}</option>}
              {wallets.map((name) => <option key={name}>{name}</option>)}
            </select></label>
            <label className="grid gap-1 text-sm">Amount<Input inputMode="decimal" value={attempt ? formatCentavos(attempt.amountCentavos) : amount} disabled={locked}
              onChange={(event) => setAmount(event.target.value)} className="min-h-11 lg:min-h-9" placeholder="500.00" /></label>
          </div>
          {parsed.error && !attempt && <p role="alert" className="text-sm text-destructive">{parsed.error}</p>}
          {!wallets.length && <p className="text-sm text-muted-foreground">No active e-wallet. Ask a manager to check the payment methods.</p>}
          <label className="grid gap-1 text-sm">Note (optional)<Input value={attempt?.note ?? note} disabled={locked} onChange={(event) => setNote(event.target.value)} className="min-h-11 lg:min-h-9" /></label>
          <Button type="submit" className="min-h-11 w-full lg:min-h-9" disabled={busy || !online || recoveryBlocked || (!attempt && (!wallet || !wallets.length || parsed.cents <= 0 || Boolean(parsed.error)))}>
            {busy ? 'Checking…' : attempt ? 'Retry confirmation' : 'Record conversion'}
          </Button>
        </form>
        <aside className="border-t pt-3 md:border-l md:border-t-0 md:pl-4 md:pt-0 space-y-3">
          <h3 className="font-semibold">Money movement</h3><p className="text-sm tabular-nums">{effect || 'Enter an amount to preview the movement.'}</p>
          <h3 className="font-semibold">Today’s net conversions</h3>
          {Object.keys(net).length ? <dl className="grid grid-cols-2 gap-2 text-sm">{Object.entries(net).map(([method, total]) =>
            <div key={method} className="min-w-0 border rounded p-2"><dt className="break-words">{method}</dt><dd className="tabular-nums">{total < 0 ? '−' : '+'}₱{formatCentavos(Math.abs(storedPesosToCentavos(total)))}</dd></div>)}</dl>
            : <p className="text-sm text-muted-foreground">No active conversions today.</p>}
        </aside>
      </div>
      <section className="border-t pt-3 space-y-2"><h3 className="font-semibold">Today’s conversions</h3>
        {loading ? <p role="status">Loading conversions…</p> : !rows.length ? <p className="text-sm text-muted-foreground">No conversions recorded today.</p> :
          <ul className="divide-y">{rows.map((row) => <li key={row.id} className="grid gap-2 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0"><p className={row.struck ? 'line-through text-muted-foreground break-words' : 'break-words'}>{row.text}</p>
              <p className="text-xs text-muted-foreground">{new Date(row.createdAtClientMs).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}{row.struck ? ' · Voided' : ''}</p></div>
            {row.canVoid && (confirmVoid === row.id ? <div className="flex flex-wrap gap-2 items-center"><span>Void this conversion?</span>
              <Button size="sm" variant="destructive" className="min-h-11 lg:min-h-9" disabled={busy || !online} onClick={() => void voidConversion(row.id)}>Confirm void</Button>
              <Button size="sm" variant="outline" className="min-h-11 lg:min-h-9" disabled={busy} onClick={() => setConfirmVoid(null)}>Cancel</Button></div>
              : <Button size="sm" variant="outline" className="min-h-11 lg:min-h-9" disabled={busy || !online} onClick={() => setConfirmVoid(row.id)}>Void</Button>)}
          </li>)}</ul>}
      </section>
    </DialogContent>
  </Dialog>;
}
