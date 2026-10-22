"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  collection, getDocsFromServer, limit, onSnapshot, orderBy, query,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useStoreContext } from "@/context/store-context";
import { useAuthContext } from "@/context/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ArrowLeft, Banknote, Loader2, Plus, RefreshCw, Trash2, Download, Save,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";
import { computeHandoverCash, getShiftDayStartMs } from "@/lib/cash/handover";
import { buildHandoverRecord, computeExpectedCash, convertLineText, handoverReadFrom, NEGATIVE_METHOD_NOTICE, parseCashAdjustment } from '@/lib/cash/convert-net';
import { commitHandover, readHandoverAttempt, saveHandoverAttempt, type HandoverAttempt } from '@/lib/cash/handover-submit';
import { parsePesoInput, storedPesosToCentavos, toWirePesos } from '@/lib/money/centavos';
import { exportToXlsx } from "@/lib/export/export-xlsx-client";
import type { CashHandover, CashHandoverDeduction } from "@/lib/types";

function peso(n: number): string {
  return `₱${(Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function CashHandoverClient() {
  const router = useRouter();
  const { activeStore, loading } = useStoreContext();
  const { appUser } = useAuthContext();
  const { toast } = useToast();

  const [history, setHistory] = useState<CashHandover[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  // Form state
  const [periodStartMs, setPeriodStartMs] = useState<number>(() => getShiftDayStartMs());
  const [startingCash, setStartingCash] = useState<string>("0");
  const [cashSales, setCashSales] = useState<string>("0");
  const [convertNet, setConvertNet] = useState(0);
  const [manualCashAdjustment, setManualCashAdjustment] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [negativeMethodNames, setNegativeMethodNames] = useState<string[]>([]);
  const [hasPrior, setHasPrior] = useState(false);
  const [computedForStore, setComputedForStore] = useState<string | null>(null);
  const storeNow = useRef(activeStore?.id);
  storeNow.current = activeStore?.id;
  const [deductions, setDeductions] = useState<CashHandoverDeduction[]>([]);
  const [dedAmount, setDedAmount] = useState<string>("");
  const [dedReason, setDedReason] = useState<string>("");
  const [countedCash, setCountedCash] = useState<string>("");
  const [outgoing, setOutgoing] = useState<string>("");
  const [incoming, setIncoming] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [computingSales, setComputingSales] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const [attempt, setAttempt] = useState<HandoverAttempt | null>(null);
  const [attemptReady, setAttemptReady] = useState(false);
  const [attemptProblem, setAttemptProblem] = useState('');
  const [priorReady, setPriorReady] = useState(false);
  const [priorProblem, setPriorProblem] = useState('');
  const [priorRetry, setPriorRetry] = useState(0);
  const identity = activeStore?.id && appUser?.uid ? `${activeStore.id}:${appUser.uid}` : '';
  const identityNow = useRef(identity); identityNow.current = identity;
  const storageKey = identity ? `shareat:cash-handover:${identity}` : '';

  useEffect(() => {
    setAttemptReady(false); setAttempt(null); setAttemptProblem('');
    if (!storageKey || !activeStore?.id || !appUser?.uid) return;
    try {
      const saved = readHandoverAttempt(localStorage, storageKey, activeStore.id, appUser.uid);
      setAttempt(saved);
      if (saved) {
        const p = saved.payload;
        setPeriodStartMs(p.periodStartMs); setHasPrior(Boolean(p.periodStartExclusive));
        setStartingCash(String(p.startingCash)); setCashSales(String(p.cashSales)); setConvertNet(p.convertNet ?? 0);
        setManualCashAdjustment(String(p.manualCashAdjustment ?? 0)); setAdjustmentReason(p.manualCashAdjustmentReason ?? '');
        setDeductions(p.deductions); setCountedCash(String(p.countedCash)); setOutgoing(p.outgoingCashierName);
        setIncoming(p.incomingCashierName); setNotes(p.notes ?? '');
      }
    } catch (error) { setAttemptProblem((error as Error).message); }
    setAttemptReady(true);
  }, [storageKey, activeStore?.id, appUser?.uid]);

  // Live history of handovers.
  useEffect(() => {
    if (!activeStore?.id) return;
    setIsLoadingHistory(true);
    const q = query(
      collection(db, "stores", activeStore.id, "cashHandovers"),
      orderBy("createdAtClientMs", "desc"),
      limit(50),
    );
    const unsub = onSnapshot(q, (snap) => {
      setHistory(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as CashHandover[]);
      setIsLoadingHistory(false);
    }, () => setIsLoadingHistory(false));
    return () => unsub();
  }, [activeStore?.id]);

  // Seed the form from the latest prior handover: carry over its counted cash as
  // the new starting float, and start the new period where the last one ended.
  // Then auto-suggest cash sales for the window.
  useEffect(() => {
    if (!activeStore?.id || !attemptReady || attempt || attemptProblem) return;
    let cancelled = false;
    setPriorReady(false); setPriorProblem('');
    setComputedForStore(null); setManualCashAdjustment(''); setAdjustmentReason('');
    (async () => {
      try {
        const snap = await getDocsFromServer(query(
          collection(db, "stores", activeStore.id, "cashHandovers"),
          orderBy("createdAtClientMs", "desc"),
          limit(1),
        ));
        const prior = snap.docs[0]?.data() as CashHandover | undefined;
        const start = prior?.periodEndMs ?? getShiftDayStartMs();
        if (cancelled) return;
        setPeriodStartMs(start);
        setHasPrior(Boolean(prior));
        setStartingCash(String(prior?.countedCash ?? 0));
        setPriorReady(true);
        await recompute(start, Boolean(prior));
      } catch {
        if (!cancelled) setPriorProblem('Could not load the previous handover. Recompute to retry before saving.');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStore?.id, attemptReady, attempt, attemptProblem, priorRetry]);

  useEffect(() => {
    if (appUser && !outgoing) {
      setOutgoing(appUser.displayName || appUser.name || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUser]);

  const recompute = async (fromMs: number, priorExists = hasPrior) => {
    if (!activeStore?.id) return;
    setComputingSales(true);
    try {
      const result = await computeHandoverCash(activeStore.id, handoverReadFrom(fromMs, priorExists), Date.now());
      if (storeNow.current !== activeStore.id) return;
      setCashSales(String(result.cashSales)); setConvertNet(result.convertNet); setNegativeMethodNames(result.negativeMethodNames);
      setComputedForStore(activeStore.id);
    } catch (e: any) {
      setComputedForStore(null);
      toast({ variant: "destructive", title: "Could not compute cash sales", description: 'Fresh totals need the internet. Recompute before saving this handover.' });
    } finally {
      setComputingSales(false);
    }
  };

  const deductionsTotal = useMemo(
    () => toWirePesos(deductions.reduce((s, d) => s + storedPesosToCentavos(d.amount), 0)),
    [deductions],
  );
  const parsed = useMemo(() => {
    try { return { ok: true as const, starting: parsePesoInput(startingCash), adjustment: parseCashAdjustment(manualCashAdjustment),
      counted: countedCash === '' ? null : parsePesoInput(countedCash), error: '' }; }
    catch (error) { return { ok: false as const, error: (error as Error).message }; }
  }, [startingCash, manualCashAdjustment, countedCash]);
  const expectedCash = parsed.ok ? computeExpectedCash({ startingCash: toWirePesos(parsed.starting), cashSales: toWirePesos(storedPesosToCentavos(cashSales)),
    convertNet, manualCashAdjustment: toWirePesos(parsed.adjustment), deductions: deductionsTotal }) : 0;
  const variance = useMemo(
    () => !parsed.ok || parsed.counted === null ? 0 : toWirePesos(parsed.counted - storedPesosToCentavos(expectedCash)),
    [parsed, expectedCash],
  );

  const addDeduction = () => {
    let cents: number;
    try { cents = parsePesoInput(dedAmount); }
    catch (error) { toast({ variant: 'destructive', title: 'Check the deduction amount', description: (error as Error).message }); return; }
    if (cents <= 0 || !dedReason.trim()) {
      toast({ variant: "destructive", title: "Add an amount and reason for the deduction." });
      return;
    }
    setDeductions((prev) => [...prev, {
      id: `ded_${Date.now()}`,
      amount: toWirePesos(cents),
      reason: dedReason.trim(),
      encodedByUid: appUser?.uid ?? null,
      encodedByName: appUser?.displayName || appUser?.name || null,
      createdAtClientMs: Date.now(),
    }]);
    setDedAmount("");
    setDedReason("");
  };

  const formLocked = saving || Boolean(attempt) || !attemptReady || Boolean(attemptProblem);
  const canSave =
    !formLocked && priorReady && !!appUser?.uid &&
    !computingSales && computedForStore === activeStore?.id && parsed.ok && parsed.counted !== null &&
    (parsed.adjustment === 0 || adjustmentReason.trim().length > 0) &&
    !!activeStore?.id &&
    countedCash !== "" &&
    outgoing.trim().length > 0 &&
    incoming.trim().length > 0;

  const handleSave = async () => {
    if (savingNow.current || !activeStore?.id || !appUser?.uid || !attemptReady || attemptProblem || (!attempt && !canSave)) return;
    if (attempt && (attempt.storeId !== activeStore.id || attempt.payload.createdByUid !== appUser.uid)) return;
    const submittingIdentity = identity;
    const submittingKey = storageKey;
    savingNow.current = true; setSaving(true);
    try {
      let request = attempt;
      if (!request) {
        if (!parsed.ok || parsed.counted === null) return;
        const now = Date.now();
        const fresh = await computeHandoverCash(activeStore.id, handoverReadFrom(periodStartMs, hasPrior), now);
        if (identityNow.current !== submittingIdentity) throw new Error('The store or staff member changed. Review this handover again before saving.');
        const figures = buildHandoverRecord({ startingCash: toWirePesos(parsed.starting), cashSales: fresh.cashSales, convertNet: fresh.convertNet,
          manualCashAdjustment: toWirePesos(parsed.adjustment), manualCashAdjustmentReason: adjustmentReason,
          deductions: deductionsTotal, countedCash: toWirePesos(parsed.counted) });
        request = { id: crypto.randomUUID(), storeId: activeStore.id, payload: {
          shiftDayId: getDayIdFromTimestamp(now), periodStartMs, periodEndMs: now, periodStartExclusive: hasPrior,
          ...figures, deductions, outgoingCashierName: outgoing.trim(), incomingCashierName: incoming.trim(),
          notes: notes.trim() || null, createdAtClientMs: now, createdByUid: appUser.uid,
          createdByName: appUser.displayName || appUser.name || null,
        } };
        saveHandoverAttempt(localStorage, submittingKey, request);
        setAttempt(request);
        setCashSales(String(fresh.cashSales)); setConvertNet(fresh.convertNet); setNegativeMethodNames(fresh.negativeMethodNames);
      }
      await commitHandover(request);
      const figures = request.payload;
      try { localStorage.removeItem(submittingKey); }
      catch {
        toast({ title: 'Handover logged', description: 'The saved retry could not be cleared on this device. Retry the same handover to confirm it; do not log another copy.' });
        return;
      }
      if (identityNow.current !== submittingIdentity) return;
      setAttempt(null);
      toast({ title: "Handover logged", description: `${figures.outgoingCashierName} → ${figures.incomingCashierName} · ${peso(figures.countedCash)}` });
      // Reset for the next handover: new float = just-counted cash, new window from now.
      setStartingCash(String(figures.countedCash)); setHasPrior(true); setManualCashAdjustment(''); setAdjustmentReason('');
      setPeriodStartMs(figures.periodEndMs);
      setDeductions([]);
      setCountedCash("");
      setNotes("");
      setOutgoing(figures.incomingCashierName);
      setIncoming("");
      await recompute(figures.periodEndMs, true);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Handover needs checking", description: e?.message || 'Retry this same handover before logging another.' });
    } finally {
      savingNow.current = false; setSaving(false);
    }
  };

  const handleExport = () => {
    if (history.length === 0) {
      toast({ variant: "destructive", title: "Nothing to export" });
      return;
    }
    exportToXlsx({
      rows: history.map((h) => ({
        "Date/Time": fmtDateTime(h.createdAtClientMs),
        "Outgoing": h.outgoingCashierName,
        "Incoming": h.incomingCashierName,
        "Starting Cash": h.startingCash,
        "Cash Sales": h.cashSales,
        "Convert and tender fixes": h.convertNet ?? 0,
        "Manual cash adjustment": h.manualCashAdjustment ?? 0,
        "Adjustment reason": h.manualCashAdjustmentReason ?? '',
        "Deductions": h.deductionsTotal,
        "Expected": h.expectedCash,
        "Counted": h.countedCash,
        "Variance": h.variance,
        "Notes": h.notes ?? "",
      })),
      sheetName: "Cash Handovers",
      filename: `cash_handovers_${activeStore?.name ?? "store"}.xlsx`,
    });
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>;
  }
  if (!activeStore) {
    return (
      <Card className="w-full max-w-md mx-auto text-center">
        <CardHeader>
          <CardTitle>No Store Selected</CardTitle>
          <CardDescription>Please select a store from the header to record a cash handover.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <>
      <PageHeader title="Cash Handover" description={`Till log for ${activeStore.name}`}>
        <Button variant="outline" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
      </PageHeader>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        {/* New handover form */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Banknote className="h-5 w-5 text-primary" /> New Handover</CardTitle>
            <CardDescription>
              Cash collected since {fmtDateTime(periodStartMs)}. Encode any cash taken out (expenses), count the drawer, and record both cashiers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {attemptProblem && <p role="alert" className="text-sm text-destructive">{attemptProblem}</p>}
            {!attempt && priorProblem && <p role="alert" className="text-sm text-destructive">{priorProblem}</p>}
            {attempt && <p role="status" className="rounded border p-3 text-sm">A handover is awaiting confirmation: {fmtDateTime(attempt.payload.periodStartMs)} to {fmtDateTime(attempt.payload.periodEndMs)}, counted {peso(attempt.payload.countedCash)}. Retry below to confirm this same record.</p>}
            <fieldset disabled={formLocked} className="min-w-0 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Starting cash (float)</Label>
                <Input inputMode="decimal" value={startingCash} onChange={(e) => setStartingCash(e.target.value)} disabled={saving} />
              </div>
              <div className="space-y-1">
                <Label className="flex items-center justify-between">
                  Cash sales
                  <Button type="button" variant="ghost" size="sm" className="min-h-11 px-2 text-xs lg:min-h-9" onClick={() => priorReady ? recompute(periodStartMs) : setPriorRetry(n => n + 1)} disabled={computingSales || saving}>
                    {computingSales ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    <span className="ml-1">Recompute</span>
                  </Button>
                </Label>
                <Input inputMode="decimal" value={cashSales} readOnly aria-label="Computed cash sales" />
                <p className="text-xs text-muted-foreground">From receipts; refreshed again when saved.</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div className="space-y-1"><Label>Manual adjustment (optional)</Label>
                <Input inputMode="decimal" placeholder="0.00 or -100.00" value={manualCashAdjustment} onChange={(e) => setManualCashAdjustment(e.target.value)} disabled={saving} /></div>
              <div className="space-y-1"><Label>Adjustment reason</Label>
                <Input value={adjustmentReason} onChange={(e) => setAdjustmentReason(e.target.value)} placeholder="Required for a nonzero adjustment" disabled={saving} /></div>
            </div>
            {!parsed.ok && <p role="alert" className="text-sm text-destructive">{parsed.error}</p>}
            {parsed.ok && parsed.adjustment !== 0 && !adjustmentReason.trim() && <p role="alert" className="text-sm text-destructive">Say why cash sales are being adjusted.</p>}
            {negativeMethodNames.length > 0 && <p role="status" className="rounded border p-3 text-sm">{NEGATIVE_METHOD_NOTICE}</p>}

            {/* Deductions */}
            <div className="space-y-2">
              <Label>Deductions (cash out for expenses)</Label>
              {deductions.length > 0 && (
                <ul className="space-y-1">
                  {deductions.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm">
                      <span className="truncate">{d.reason}</span>
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums">{peso(d.amount)}</span>
                        <Button type="button" variant="ghost" size="icon" className="h-11 w-11 lg:h-9 lg:w-9 text-muted-foreground hover:text-destructive" disabled={saving}
                          onClick={() => setDeductions((prev) => prev.filter((x) => x.id !== d.id))} aria-label="Remove deduction">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <Input placeholder="Reason (e.g. supplies)" value={dedReason} onChange={(e) => setDedReason(e.target.value.slice(0, 60))} disabled={saving} />
                <Input inputMode="decimal" placeholder="Amount" value={dedAmount} onChange={(e) => setDedAmount(e.target.value)} className="w-32" disabled={saving} />
                <Button type="button" variant="outline" size="icon" className="h-11 w-11 lg:h-9 lg:w-9 shrink-0" onClick={addDeduction} disabled={saving} aria-label="Add deduction">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Computed expected */}
            <div className="rounded-md border bg-muted/40 p-3 space-y-1 text-sm">
              <div className="flex justify-between gap-3"><span className="text-muted-foreground">Starting + Cash sales + Adjustment + Converts − Deductions</span><span className="tabular-nums">{parsed.ok ? peso(expectedCash) : '—'}</span></div>
              {convertLineText(convertNet) && <p className="tabular-nums">{convertLineText(convertNet)}</p>}
              <div className="flex justify-between font-semibold"><span>Expected cash on hand</span><span className="tabular-nums">{parsed.ok ? peso(expectedCash) : '—'}</span></div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Counted cash</Label>
                <Input inputMode="decimal" value={countedCash} onChange={(e) => setCountedCash(e.target.value)} placeholder="Physical count" disabled={saving} />
              </div>
              <div className="space-y-1">
                <Label>Variance</Label>
                <div className={`h-10 flex items-center px-3 rounded-md border tabular-nums font-semibold ${
                  countedCash === "" ? "text-muted-foreground" : Math.abs(variance) < 0.01 ? "text-emerald-600" : variance > 0 ? "text-blue-600" : "text-red-600"
                }`}>
                  {countedCash === "" ? "—" : `${variance > 0 ? "+" : ""}${peso(variance)}`}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Outgoing cashier</Label>
                <Input value={outgoing} onChange={(e) => setOutgoing(e.target.value)} placeholder="Handing over" disabled={saving} />
              </div>
              <div className="space-y-1">
                <Label>Incoming cashier</Label>
                <Input value={incoming} onChange={(e) => setIncoming(e.target.value)} placeholder="Receiving" disabled={saving} />
              </div>
            </div>

            <div className="space-y-1">
              <Label>Notes <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 120))} placeholder="Anything worth noting" disabled={saving} />
            </div>

            </fieldset>
            <Button onClick={handleSave} disabled={saving || !attemptReady || Boolean(attemptProblem) || (!attempt && !canSave)} className="sticky bottom-0 min-h-11 w-full md:static lg:min-h-9">
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              {attempt ? 'Retry same handover' : 'Log handover'}
            </Button>
          </CardContent>
        </Card>

        {/* History */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>History</CardTitle>
                <CardDescription>Recent cash handovers for this store.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={handleExport}><Download className="mr-2 h-4 w-4" /> Export</Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoadingHistory ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
            ) : history.length === 0 ? (
              <p className="text-center text-muted-foreground py-10">No handovers recorded yet.</p>
            ) : (
              <>
              <div className="divide-y md:hidden">{history.map((h) => <article key={h.id} className="py-3 space-y-2">
                <p className="text-xs text-muted-foreground">{fmtDateTime(h.createdAtClientMs)}</p>
                <p className="truncate text-sm">{h.outgoingCashierName} → {h.incomingCashierName}</p>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div><dt className="text-xs text-muted-foreground">Expected</dt><dd className="tabular-nums">{peso(h.expectedCash)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Counted</dt><dd className="tabular-nums">{peso(h.countedCash)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Variance</dt><dd className="tabular-nums">{peso(h.variance)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Converts</dt><dd className="tabular-nums">{peso(h.convertNet ?? 0)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Adjustment</dt><dd className="tabular-nums">{peso(h.manualCashAdjustment ?? 0)}</dd></div>
                </dl>
                {h.manualCashAdjustmentReason && <p className="text-xs break-words">{h.manualCashAdjustmentReason}</p>}
              </article>)}</div>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Cashiers</TableHead>
                      <TableHead className="text-right">Converts</TableHead>
                      <TableHead className="text-right">Adjustment</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="text-right">Counted</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(h.createdAtClientMs)}</TableCell>
                        <TableCell className="text-xs">{h.outgoingCashierName} → {h.incomingCashierName}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{peso(h.convertNet ?? 0)}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs"><div>{peso(h.manualCashAdjustment ?? 0)}</div>{h.manualCashAdjustmentReason && <p className="text-muted-foreground whitespace-normal">{h.manualCashAdjustmentReason}</p>}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{peso(h.expectedCash)}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{peso(h.countedCash)}</TableCell>
                        <TableCell className={`text-right tabular-nums text-xs font-medium ${
                          Math.abs(h.variance) < 0.01 ? "text-emerald-600" : h.variance > 0 ? "text-blue-600" : "text-red-600"
                        }`}>
                          {h.variance > 0 ? "+" : ""}{peso(h.variance)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
