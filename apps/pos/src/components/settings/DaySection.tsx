"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarCheck, Printer } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { useOutboxStatus } from "@/hooks/useOutboxStatus";
import { PIN_LENGTH, PinPad } from "@/components/pos2/PinPad";
import { Pos2Error } from "@/lib/pos2/client";
import { closeDay, readX } from "@/lib/pos2/zReadingClient";
import { formatZSlip } from "@/lib/printing/zSlipFormatter";
import { paperWidthFor, printXSlipText } from "@/lib/outbox/xSlipRun";
import { unsentSalesWarningText } from "@/lib/outbox/updateGate";

const stamp = (ms: number) => new Date(ms).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });

/**
 * T-471 S3 (Ruling 8) - Settings -> Day: print an X-reading any time (no PIN, closes nothing), or close the day with a Z-reading (a manager types the PIN;
 * refused while this tablet still has unsent sales). Both slips print through the X-slip's path; with no paired printer the text is shown on screen.
 */
export function DaySection() {
  const { toast } = useToast();
  const { appUser } = useAuthContext();
  const { activeStore } = useStoreContext();
  const status = useOutboxStatus();
  const [lastZ, setLastZ] = useState<{ zNo: string; toMs: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [askPin, setAskPin] = useState(false);
  const [pin, setPin] = useState("");
  // Kept until the Z is saved so a retry after a lost answer returns the same Z instead of closing the day twice.
  const requestId = useRef<string | null>(null);

  const loadLast = useCallback(async () => {
    if (!activeStore) return;
    try { setLastZ((await readX(activeStore.id)).lastZ); } catch { /* offline: the last Z simply is not shown */ }
  }, [activeStore]);
  useEffect(() => { void loadLast(); }, [loadLast]);

  const output = async (text: string, widthMm: 58 | 80, title: string) => {
    const outcome = await printXSlipText(text, widthMm);
    if (outcome === "printed") toast({ title });
    else {
      toast({ variant: outcome === "failed" ? "destructive" : "default", title: outcome === "failed" ? "Print failed" : "No printer paired", description: "Copy the slip from the screen." });
      window.alert(text);
    }
  };

  const printX = async () => {
    if (!activeStore) return;
    setBusy(true);
    try {
      const x = await readX(activeStore.id);
      const widthMm = await paperWidthFor(activeStore.id);
      const text = formatZSlip({ kind: "X", storeName: activeStore.name, zNo: null, window: x.window, reading: x.reading, printedBy: appUser?.displayName || appUser?.name || appUser?.username || "-", approvedBy: null, widthMm });
      await output(text, widthMm, "X-reading printed");
    } catch (e) {
      toast({ variant: "destructive", title: "X-reading not printed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const closeTheDay = async () => {
    if (!activeStore || pin.length !== PIN_LENGTH) return;
    setBusy(true);
    try {
      requestId.current ??= crypto.randomUUID();
      const z = await closeDay({ storeId: activeStore.id, requestId: requestId.current, pin, unsentCount: status.unsentCount });
      requestId.current = null;
      setAskPin(false);
      setPin("");
      setLastZ({ zNo: z.zNo, toMs: z.window.toMs });
      const widthMm = await paperWidthFor(activeStore.id);
      const text = formatZSlip({ kind: "Z", storeName: activeStore.name, zNo: z.zNo, window: z.window, reading: z.reading, printedBy: z.printedBy.name, approvedBy: z.approvedByPersonId, widthMm });
      await output(text, widthMm, `${z.zNo} printed - the day is closed`);
    } catch (e) {
      if (e instanceof Pos2Error && e.status === 403) setPin("");
      if (e instanceof Pos2Error && e.status === 409) requestId.current = null;
      toast({ variant: "destructive", title: "The day was not closed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarCheck className="h-5 w-5" /> Day</CardTitle>
        <CardDescription>Cash control for the store's day. Not a BIR document. Selling can go on after you close the day.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{lastZ ? `Last Z: ${lastZ.zNo}, closed ${stamp(lastZ.toMs)}` : "Last Z: none yet"}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={printX} disabled={busy || !activeStore}><Printer className="mr-1 h-4 w-4" /> Print X-reading</Button>
          <Button size="sm" onClick={() => setAskPin(true)} disabled={busy || !activeStore}>Close the day (Z)</Button>
        </div>
        {status.unsentCount > 0 && <p className="text-xs text-amber-700">{unsentSalesWarningText(status.unsentCount)} The day cannot be closed until this is 0.</p>}
      </CardContent>
      <Dialog open={askPin} onOpenChange={(open) => { if (!busy) { setAskPin(open); if (!open) setPin(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close the day (Z)</DialogTitle>
            <DialogDescription>A manager types the store PIN. The Z-reading prints and the next sale starts the next day.</DialogDescription>
          </DialogHeader>
          {status.unsentCount > 0
            ? <p className="text-sm font-medium text-destructive">Send the unsent sales first.</p>
            : <PinPad value={pin} onChange={setPin} disabled={busy} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAskPin(false); setPin(""); }} disabled={busy}>Cancel</Button>
            <Button onClick={closeTheDay} disabled={busy || status.unsentCount > 0 || pin.length !== PIN_LENGTH}>Close the day</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
