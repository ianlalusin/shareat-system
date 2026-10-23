'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useConnectivity } from '@/hooks/useConnectivity';
import { useToast } from '@/hooks/use-toast';
import { mutateStatutoryDiners } from '@/lib/statutory/mutations';
import { maskIdNo, resolveHeads, statutoryPaymentBlockers } from '@/lib/statutory/capture';
import { pruneDishAssignments } from '@/lib/statutory/shares';
import { statutoryInputOf } from '@/lib/statutory/session';
import { calculateBillTotals } from '@/lib/tax';
import { getActorStamp } from './firestore';
import type { AppUser } from '@/context/auth-context';
import type { Adjustment, Discount, PendingSession, SessionBillLine, SessionLoyaltyRedemption, Store } from '@/lib/types';

interface Props { storeId: string; sessionId: string; session: PendingSession | null; lines: SessionBillLine[];
  store: Store; user: AppUser | null; billDiscount: Discount | null; adjustments: Adjustment[]; loyalty: SessionLoyaltyRedemption[] }
const money = (value: number) => `₱${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const control = 'min-h-11 rounded-md border bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 lg:min-h-9';

export function StatutoryDinersPanel({ storeId, sessionId, session, lines, store, user, billDiscount, adjustments, loyalty }: Props) {
  const { online } = useConnectivity();
  const { toast } = useToast();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('senior');
  const [name, setName] = useState(''), [idNo, setIdNo] = useState('');
  const [headsText, setHeadsText] = useState('');
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const busyNow = useRef(false);
  const count = session ? resolveHeads(session) : null;
  const diners = session?.statutoryDiners ?? [];
  const locked = !session || session.status !== 'active' || session.isPaid || !user;
  const disabled = Boolean(locked || busy || !online);
  const qualifying = statutoryInputOf(session);
  const blockers = qualifying ? statutoryPaymentBlockers({ ...qualifying, lines, loyaltyRedemptions: loyalty }) : [];
  const totals = useMemo(() => calculateBillTotals(lines, store, billDiscount, adjustments,
    loyalty.map(reward => ({ type: reward.type, value: reward.value })), statutoryInputOf(session)),
  [lines, store, billDiscount, adjustments, loyalty, session]);
  const dishes = lines.filter(line => line.type === 'addon' && !line.id.startsWith('bundleextra_')
    && line.qtyOrdered - (line.voidedQty ?? 0) - (line.freeQty ?? 0) > 0);

  useEffect(() => { setHeadsText(String(count ?? '')); }, [sessionId, count]);
  useEffect(() => { setName(''); setIdNo(''); setProblem(''); }, [sessionId]);

  type Command = Parameters<typeof mutateStatutoryDiners>[3];
  const run = async (command: Command) => {
    if (disabled || busyNow.current || !user) return false;
    busyNow.current = true; setBusy(true); setProblem('');
    try {
      const actor = getActorStamp(user);
      const result = await mutateStatutoryDiners(storeId, sessionId, { uid: actor.uid, name: actor.username, role: user.role ?? '' }, command);
      if (result.warnings.includes('same-name')) toast({ title: 'Diner added', description: 'Someone with this name is already on the list. Check that they are different people.' });
      return true;
    } catch (error) { setProblem((error as Error).message || 'Could not confirm the change. Check the list before retrying.'); return false; }
    finally { busyNow.current = false; setBusy(false); }
  };
  useEffect(() => {
    if (locked || !online || busyNow.current || !session || !diners.length) return;
    if (JSON.stringify(pruneDishAssignments(diners, lines)) !== JSON.stringify(diners)) void run({ type: 'prune' });
    // Snapshot updates trigger pruning; run itself is deliberately not an effect dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.statutoryDiners, lines, online, locked, sessionId]);
  const parsedHeads = () => /^\d{1,4}$/.test(headsText.trim()) ? Number(headsText) : 0;
  const add = async () => {
    if (await run({ type: 'add', entry: { kind, name, idNo }, heads: parsedHeads() })) { setName(''); setIdNo(''); }
  };
  const person = (index: number) => {
    const diner = diners[index];
    if (!diner) return null;
    const figure = totals.statutoryDiners.find(figure => figure.dinerId === diner.id);
    return { diner, figure };
  };
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" className="min-h-11 lg:min-h-9" disabled={!session}>Senior / PWD{diners.length ? ` (${diners.length})` : ''}</Button></DialogTrigger>
    <DialogContent className="max-w-5xl bg-white p-3 sm:p-5 [&>button:last-child]:min-h-11 [&>button:last-child]:min-w-11 lg:[&>button:last-child]:min-h-9 lg:[&>button:last-child]:min-w-9">
      <DialogHeader><DialogTitle>Senior / PWD</DialogTitle><DialogDescription>Record each person and what they alone consumed. Shared dishes stay outside their discount.</DialogDescription></DialogHeader>
      {!session ? <p role="status" className="animate-pulse py-4 text-sm">Loading bill…</p> : <>
      {!online && <p role="status" className="text-sm">Needs internet to change the diner list. Previously recorded diners still apply to offline payment.</p>}
      {locked && <p role="status" className="text-sm">This bill is read-only.</p>}
      {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
      <div className="grid min-w-0 gap-5 md:grid-cols-2 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Label htmlFor={`${formId}-heads`}>People at this table</Label>
            <Input id={`${formId}-heads`} inputMode="numeric" value={headsText} onChange={event => setHeadsText(event.target.value)} className="min-h-11 w-24 lg:min-h-9" disabled={disabled || Boolean(session.guestCountFinal || session.guestCountCashierInitial || session.guestCountServerVerified)} />
            {!session.guestCountFinal && !session.guestCountCashierInitial && !session.guestCountServerVerified
              ? <Button variant="outline" onClick={() => run({ type: 'heads', heads: parsedHeads() })} disabled={disabled} className="min-h-11 lg:min-h-9">Update count</Button>
              : <span className="text-xs text-muted-foreground">From the session’s guest count</span>}
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,2fr)]">
            <div className="space-y-1"><Label htmlFor={`${formId}-kind`}>Kind</Label><select id={`${formId}-kind`} value={kind} onChange={event => setKind(event.target.value)} disabled={disabled} className={`${control} w-full`}><option value="senior">Senior</option><option value="pwd">PWD</option></select></div>
            <div className="min-w-0 space-y-1"><Label htmlFor={`${formId}-name`}>Full name</Label><Input id={`${formId}-name`} value={name} onChange={event => setName(event.target.value)} disabled={disabled} className="min-h-11 lg:min-h-9" autoComplete="off" /></div>
            <div className="col-span-2 min-w-0 space-y-1 lg:col-span-1"><Label htmlFor={`${formId}-id`}>ID number</Label><Input id={`${formId}-id`} value={idNo} onChange={event => setIdNo(event.target.value)} disabled={disabled} className="min-h-11 lg:min-h-9" autoComplete="off" placeholder="OSCA or PWD ID" /></div>
          </div>
          <div className="hidden justify-end md:flex"><Button onClick={add} disabled={disabled || !name.trim() || !idNo.trim()} className="min-h-11 lg:min-h-9">{busy ? 'Saving…' : 'Add diner'}</Button></div>
          <section className="space-y-2"><h3 className="text-sm font-semibold">Qualifying diners <span className="font-normal text-muted-foreground">{diners.length} of {count ?? '—'} people</span></h3>
            {!diners.length ? <p className="rounded border border-dashed p-3 text-sm text-muted-foreground">No qualifying diners yet. Enter a name and ID above.</p> : <>
              <div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm"><thead className="border-y bg-muted/30 text-xs text-muted-foreground"><tr><th className="px-3 py-2">Person</th><th className="px-3 py-2 text-right">Share</th><th className="px-3 py-2 text-right">Discount</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead><tbody>
                {diners.map((_, index) => { const row = person(index); return row && <tr key={row.diner.id} className="border-b hover:bg-muted/20"><td className="max-w-48 px-3 py-2"><p className="truncate font-medium">{row.diner.name}</p><p className="text-xs text-muted-foreground">{row.diner.kind === 'senior' ? 'Senior' : 'PWD'} · {maskIdNo(row.diner.idNo)}</p></td><td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(row.figure?.share ?? 0)}</td><td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(row.figure?.discount ?? 0)}</td><td className="px-2 py-1"><Button variant="ghost" disabled={disabled} onClick={() => run({ type: 'remove', dinerId: row.diner.id })} className="min-h-11 text-destructive lg:min-h-9">Remove</Button></td></tr>; })}
              </tbody></table></div>
              <div className="divide-y md:hidden">{diners.map((_, index) => { const row = person(index); return row && <article key={row.diner.id} className="space-y-2 py-3"><p className="truncate font-medium">{row.diner.name}</p><p className="text-xs text-muted-foreground">{row.diner.kind === 'senior' ? 'Senior' : 'PWD'} · {maskIdNo(row.diner.idNo)}</p><dl className="grid grid-cols-2 gap-2 text-sm"><div><dt className="text-xs text-muted-foreground">Share</dt><dd className="tabular-nums">{money(row.figure?.share ?? 0)}</dd></div><div><dt className="text-xs text-muted-foreground">Discount</dt><dd className="tabular-nums">{money(row.figure?.discount ?? 0)}</dd></div></dl><Button variant="outline" disabled={disabled} onClick={() => run({ type: 'remove', dinerId: row.diner.id })} className="min-h-11">Remove</Button></article>; })}</div>
            </>}
          </section>
          <section className="space-y-2"><h3 className="text-sm font-semibold">Individual dishes</h3><p className="text-xs text-muted-foreground">One package head is automatic. Assign a dish only when that person alone consumed it.</p>
            {!dishes.length && <p className="text-sm text-muted-foreground">No separate dishes on this bill.</p>}
            {dishes.map(line => <div key={line.id} className="grid min-w-0 gap-2 border-b py-2 sm:grid-cols-2"><Label htmlFor={`${formId}-dish-${line.id}`} className="truncate self-center">{line.itemName}</Label><select id={`${formId}-dish-${line.id}`} className={`${control} min-w-0 w-full`} disabled={disabled || !diners.length} value={diners.find(diner => diner.dishLineIds.includes(line.id))?.id ?? ''} onChange={event => run(event.target.value ? { type: 'assign', dinerId: event.target.value, lineId: line.id } : { type: 'unassign', lineId: line.id })}><option value="">Shared / not assigned</option>{diners.map(diner => <option key={diner.id} value={diner.id}>{diner.name}</option>)}</select></div>)}
          </section>
        </div>
        <aside className="min-w-0 space-y-3 border-t pt-3 md:border-l md:border-t-0 md:pl-4 md:pt-0"><h3 className="text-sm font-semibold">Bill preview</h3>
          <dl className="space-y-2 text-sm"><div className="flex justify-between gap-3"><dt>Senior/PWD discount</dt><dd className="whitespace-nowrap tabular-nums">{money(totals.statutoryDiscountTotal)}</dd></div><div className="flex justify-between gap-3"><dt>VAT exemption</dt><dd className="whitespace-nowrap tabular-nums">{money(totals.statutoryVatRemovedTotal)}</dd></div><div className="border-t pt-3"><dt className="text-xs text-muted-foreground">Whole bill amount due</dt><dd className="break-words text-2xl font-semibold tabular-nums">{money(totals.grandTotal)}</dd></div></dl>
          {blockers.map((blocker, index) => <p key={index} role="status" className="text-sm text-destructive">{blocker.message}</p>)}
          <p className="text-xs text-muted-foreground">Names, IDs and signature lines print on the receipt. Saved lists show masked IDs.</p>
        </aside>
      </div>
      <div className="sticky bottom-0 z-10 border-t bg-white py-2 md:hidden"><Button onClick={add} disabled={disabled || !name.trim() || !idNo.trim()} className="min-h-11 w-full">{busy ? 'Saving…' : 'Add diner'}</Button></div>
      </>}
    </DialogContent>
  </Dialog>;
}
