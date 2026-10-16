"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addDoc, collection, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp,
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
import { computeCashSales, getShiftDayStartMs } from "@/lib/cash/handover";
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
  const [deductions, setDeductions] = useState<CashHandoverDeduction[]>([]);
  const [dedAmount, setDedAmount] = useState<string>("");
  const [dedReason, setDedReason] = useState<string>("");
  const [countedCash, setCountedCash] = useState<string>("");
  const [outgoing, setOutgoing] = useState<string>("");
  const [incoming, setIncoming] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [computingSales, setComputingSales] = useState(false);
  const [saving, setSaving] = useState(false);

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
    if (!activeStore?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, "stores", activeStore.id, "cashHandovers"),
          orderBy("createdAtClientMs", "desc"),
          limit(1),
        ));
        const prior = snap.docs[0]?.data() as CashHandover | undefined;
        const start = prior?.periodEndMs ?? getShiftDayStartMs();
        if (cancelled) return;
        setPeriodStartMs(start);
        setStartingCash(String(prior?.countedCash ?? 0));
        await recompute(start);
      } catch {
        // keep defaults
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStore?.id]);

  useEffect(() => {
    if (appUser && !outgoing) {
      setOutgoing(appUser.displayName || appUser.name || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUser]);

  const recompute = async (fromMs: number) => {
    if (!activeStore?.id) return;
    setComputingSales(true);
    try {
      const total = await computeCashSales(activeStore.id, fromMs, Date.now());
      setCashSales(String(Math.round(total * 100) / 100));
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not compute cash sales", description: e?.message });
    } finally {
      setComputingSales(false);
    }
  };

  const deductionsTotal = useMemo(
    () => deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0),
    [deductions],
  );
  const expectedCash = useMemo(
    () => (Number(startingCash) || 0) + (Number(cashSales) || 0) - deductionsTotal,
    [startingCash, cashSales, deductionsTotal],
  );
  const variance = useMemo(
    () => (countedCash === "" ? 0 : (Number(countedCash) || 0) - expectedCash),
    [countedCash, expectedCash],
  );

  const addDeduction = () => {
    const amt = Number(dedAmount);
    if (!Number.isFinite(amt) || amt <= 0 || !dedReason.trim()) {
      toast({ variant: "destructive", title: "Add an amount and reason for the deduction." });
      return;
    }
    setDeductions((prev) => [...prev, {
      id: `ded_${Date.now()}`,
      amount: Math.round(amt * 100) / 100,
      reason: dedReason.trim(),
      encodedByUid: appUser?.uid ?? null,
      encodedByName: appUser?.displayName || appUser?.name || null,
      createdAtClientMs: Date.now(),
    }]);
    setDedAmount("");
    setDedReason("");
  };

  const canSave =
    !saving &&
    !!activeStore?.id &&
    countedCash !== "" &&
    outgoing.trim().length > 0 &&
    incoming.trim().length > 0;

  const handleSave = async () => {
    if (!canSave || !activeStore?.id) return;
    setSaving(true);
    try {
      const now = Date.now();
      await addDoc(collection(db, "stores", activeStore.id, "cashHandovers"), {
        shiftDayId: getDayIdFromTimestamp(now),
        periodStartMs,
        periodEndMs: now,
        startingCash: Number(startingCash) || 0,
        cashSales: Number(cashSales) || 0,
        deductions,
        deductionsTotal,
        expectedCash,
        countedCash: Number(countedCash) || 0,
        variance,
        outgoingCashierName: outgoing.trim(),
        incomingCashierName: incoming.trim(),
        notes: notes.trim() || null,
        createdAt: serverTimestamp(),
        createdAtClientMs: now,
        createdByUid: appUser?.uid ?? null,
        createdByName: appUser?.displayName || appUser?.name || null,
      });
      toast({ title: "Handover logged", description: `${outgoing.trim()} → ${incoming.trim()} · ${peso(countedCash === "" ? 0 : Number(countedCash))}` });
      // Reset for the next handover: new float = just-counted cash, new window from now.
      setStartingCash(String(Number(countedCash) || 0));
      setPeriodStartMs(now);
      setDeductions([]);
      setCountedCash("");
      setNotes("");
      setOutgoing(incoming.trim());
      setIncoming("");
      await recompute(now);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Save failed", description: e?.message });
    } finally {
      setSaving(false);
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Starting cash (float)</Label>
                <Input type="number" inputMode="decimal" value={startingCash} onChange={(e) => setStartingCash(e.target.value)} disabled={saving} />
              </div>
              <div className="space-y-1">
                <Label className="flex items-center justify-between">
                  Cash sales
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => recompute(periodStartMs)} disabled={computingSales || saving}>
                    {computingSales ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    <span className="ml-1">Recompute</span>
                  </Button>
                </Label>
                <Input type="number" inputMode="decimal" value={cashSales} onChange={(e) => setCashSales(e.target.value)} disabled={saving} />
              </div>
            </div>

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
                        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive"
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
                <Input type="number" inputMode="decimal" placeholder="Amount" value={dedAmount} onChange={(e) => setDedAmount(e.target.value)} className="w-32" disabled={saving} />
                <Button type="button" variant="outline" size="icon" className="h-10 w-10 shrink-0" onClick={addDeduction} disabled={saving} aria-label="Add deduction">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Computed expected */}
            <div className="rounded-md border bg-muted/40 p-3 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Starting + Cash sales − Deductions</span><span className="tabular-nums">{peso(expectedCash)}</span></div>
              <div className="flex justify-between font-semibold"><span>Expected cash on hand</span><span className="tabular-nums">{peso(expectedCash)}</span></div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Counted cash</Label>
                <Input type="number" inputMode="decimal" value={countedCash} onChange={(e) => setCountedCash(e.target.value)} placeholder="Physical count" disabled={saving} />
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

            <Button onClick={handleSave} disabled={!canSave} className="w-full">
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Log handover
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
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Cashiers</TableHead>
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
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
