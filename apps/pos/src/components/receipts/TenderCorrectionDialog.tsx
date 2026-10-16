"use client";

import { useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { Receipt, ModeOfPayment } from "@/lib/types";
import { parsePesoInput, storedPesosToCentavos } from "@/lib/money/centavos";
import { Pos2Error, postPos2 } from "@/lib/pos2/client";
import { PIN_LENGTH, PinPad } from "@/components/pos2/PinPad";

/**
 * T-424 S9 (Ruling 7) - "Mark wrong tender" on a PAID receipt. The receipt is never edited (row 272): the server moves the money between payment
 * methods for the receipt's day and keeps the record. It needs a manager PIN and an open ERP till shift; after the shift closes the answer is
 * "Shift closed: refund and ring again".
 */
interface Props {
  isOpen: boolean;
  onClose: () => void;
  receipt: Receipt;
  paymentMethods: ModeOfPayment[];
  onSuccess: () => void;
}

const peso = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function TenderCorrectionDialog({ isOpen, onClose, receipt, paymentMethods, onSuccess }: Props) {
  const { toast } = useToast();
  const mop = ((receipt.analytics as any)?.mop ?? {}) as Record<string, number>;
  const fromOptions = useMemo(() => Object.keys(mop).filter((k) => storedPesosToCentavos(mop[k]) > 0), [receipt]);
  const [from, setFrom] = useState<string>(fromOptions[0] ?? "");
  const toOptions = useMemo(
    () => paymentMethods.filter((m) => m.isActive !== false && !m.isArchived && m.name.trim().toLowerCase() !== from.trim().toLowerCase()),
    [paymentMethods, from],
  );
  const [to, setTo] = useState<string>("");
  const chosenTo = toOptions.find((m) => m.name === to) ?? toOptions[0];
  const fromCentavos = from ? storedPesosToCentavos(mop[from]) : 0;
  const [amountText, setAmountText] = useState<string>("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  // One request id per distinct request: a retry (wrong PIN, lost connection) re-sends the SAME id so the server can tell a retry from a second correction.
  const requestId = useRef<{ key: string; id: string } | null>(null);

  const amountShown = amountText.trim() === "" ? peso(fromCentavos).replace(/,/g, "") : amountText;
  let amountCentavos = 0;
  let amountError: string | null = null;
  try {
    amountCentavos = parsePesoInput(amountShown);
    if (amountCentavos <= 0) amountError = "The amount must be more than zero.";
    else if (amountCentavos > fromCentavos) amountError = `At most ₱${peso(fromCentavos)} was paid by ${from}.`;
  } catch (e: any) {
    amountError = e?.message ?? "Enter an amount like 12.50.";
  }
  const needsRef = !!chosenTo?.hasRef;
  const canSubmit = !busy && !!from && !!chosenTo && !amountError && !!reason.trim() && (!needsRef || !!reference.trim()) && pin.length === PIN_LENGTH;

  const submit = async () => {
    if (!canSubmit || !chosenTo) return;
    const key = JSON.stringify({ from, to: chosenTo.name, amountCentavos, reference: reference.trim(), reason: reason.trim() });
    if (!requestId.current || requestId.current.key !== key) requestId.current = { key, id: uuidv4() };
    setBusy(true);
    try {
      await postPos2("tender-corrections", {
        storeId: receipt.storeId,
        receiptId: receipt.receiptId ?? receipt.id,
        fromMethod: from,
        toMethod: chosenTo.name,
        amount: amountCentavos,
        reference: reference.trim(),
        reason: reason.trim(),
        requestId: requestId.current.id,
        pin,
      });
      toast({ title: "Tender corrected", description: `₱${peso(amountCentavos)} moved from ${from} to ${chosenTo.name}. The receipt itself is unchanged.` });
      onSuccess();
      onClose();
    } catch (err: any) {
      if (err instanceof Pos2Error && err.status === 403) setPin("");
      toast({ variant: "destructive", title: "Tender not corrected", description: err?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Mark wrong tender: {receipt.receiptNumber}</DialogTitle>
          <DialogDescription>
            Moves money from one payment method to another for the day of this sale. The receipt is not changed. A store manager must approve it with their PIN, and the till shift must be open.
          </DialogDescription>
        </DialogHeader>

        {fromOptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">This receipt has no payment recorded that can be moved.</p>
        ) : (
          <div className="space-y-3">
            <div>
              <Label htmlFor="tcFrom">Was paid by</Label>
              <select id="tcFrom" className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={from} onChange={(e) => { setFrom(e.target.value); setAmountText(""); }} disabled={busy}>
                {fromOptions.map((k) => (
                  <option key={k} value={k}>{k} (₱{peso(storedPesosToCentavos(mop[k]))})</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="tcTo">Really paid by</Label>
              <select id="tcTo" className="mt-1 w-full rounded-md border bg-background p-2 text-sm" value={chosenTo?.name ?? ""} onChange={(e) => setTo(e.target.value)} disabled={busy || toOptions.length === 0}>
                {toOptions.map((m) => (
                  <option key={m.id} value={m.name}>{m.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="tcAmount">Amount to move (₱)</Label>
              <Input id="tcAmount" inputMode="decimal" className="mt-1" value={amountShown} onChange={(e) => setAmountText(e.target.value)} disabled={busy} />
              {amountError && <p className="mt-1 text-xs text-destructive">{amountError}</p>}
            </div>
            {needsRef && (
              <div>
                <Label htmlFor="tcRef">{chosenTo?.name} reference number (Required)</Label>
                <Input id="tcRef" className="mt-1" value={reference} onChange={(e) => setReference(e.target.value)} disabled={busy} />
              </div>
            )}
            <div>
              <Label htmlFor="tcReason">Reason (Required)</Label>
              <Textarea id="tcReason" className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g., Customer paid by GCash but cash was picked" disabled={busy} />
            </div>
            <div>
              <Label>Store manager PIN</Label>
              <p className="mb-2 text-xs text-muted-foreground">The manager types their own ERP PIN. It is checked on the server and never saved.</p>
              <PinPad value={pin} onChange={setPin} disabled={busy} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? <Loader2 className="animate-spin mr-2 h-4 w-4" /> : null}
            Move the money
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
