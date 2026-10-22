"use client";

import { useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import type { Receipt, SessionBillLine, ModeOfPayment } from "@/lib/types";
import type { AppUser } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { formatTerminalReceiptNumber, reserveNext } from "@/lib/terminal/counter";
import { paidShares, unitsRefundCentavos } from "@/lib/money/refundShare";
import { Pos2Error, postPos2 } from "@/lib/pos2/client";
import { PIN_LENGTH, PinPad } from "@/components/pos2/PinPad";
// T-425 (bible row 356): no refunds without the internet. The server needs the manager PIN and the real receipt, so it is refused here with a plain sentence.
import { OFFLINE_REFUND_MESSAGE, canRefundOffline } from "@/lib/offline/offlineRules";
import { useOnlineStatus } from "@/hooks/use-online-status";

/**
 * T-424 S9 - the refund dialog. A refund is checked by the POS v2 server (never the tablet): it needs a manager's ERP PIN, prices each unit as
 * its share of what the customer PAID, counts the refunds that already exist, and applies the day's numbers itself. Cash only for now: the ERP
 * day feed cannot yet read a refund tender, so an e-wallet refund would book cash short and the wallet over.
 */
interface RefundReceiptDialogProps {
  isOpen: boolean;
  onClose: () => void;
  receipt: Receipt;
  paymentMethods: ModeOfPayment[];
  actor: AppUser;
  onSuccess: (refundReceiptId: string) => void;
}

type RefundQty = Record<string, number>; // lineId -> qty to refund

export const CASH_ONLY_SENTENCE = "E-wallet refunds come later; refund in cash for now.";

function RefundContent({ receipt, paymentMethods, onClose, onSuccess }: RefundReceiptDialogProps) {
  const { toast } = useToast();
  const { activeStore } = useStoreContext();
  const isOnline = useOnlineStatus();
  const offlineBlocked = !isOnline && !canRefundOffline();
  const [refundQtys, setRefundQtys] = useState<RefundQty>({});
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cashMethods = useMemo(() => paymentMethods.filter((m) => m.type === "cash" && m.isActive !== false && !m.isArchived), [paymentMethods]);
  const [tenderId, setTenderId] = useState<string>("");
  const chosenTender = tenderId || cashMethods[0]?.id || "";
  // One receipt number per distinct request: a retry (wrong PIN, lost connection) re-sends the SAME number, so the server can tell a retry from a new refund.
  const reserved = useRef<{ key: string; number: string; terminalNo: number; terminalSeq: number } | null>(null);

  // The parent's own counters are client-writable, so they only shape this screen; the server counts the real refunds.
  const refundedQtys: Record<string, number> = (receipt as any).refundedQtys ?? {};
  const lines: SessionBillLine[] = receipt.lines || [];
  const getMaxQty = (l: SessionBillLine) =>
    Math.max(0, l.qtyOrdered - (l.freeQty || 0) - (l.voidedQty || 0) - (refundedQtys[l.id] || 0));

  const billableLines = useMemo(() => lines.filter((l) => getMaxQty(l) > 0), [lines, refundedQtys]);

  const getRefundQty = (id: string) => refundQtys[id] ?? 0;
  const setQty = (id: string, val: number, max: number) => {
    const clamped = Math.max(0, Math.min(max, Number.isNaN(val) ? 0 : val));
    setRefundQtys((cur) => ({ ...cur, [id]: clamped }));
  };

  const shares = useMemo(() => paidShares(lines as any, receipt.total), [lines, receipt.total]);
  const lineRefundCentavos = (l: SessionBillLine, qty: number): number => {
    if (!shares || qty <= 0) return 0;
    const i = lines.findIndex((x) => x.id === l.id);
    return i < 0 ? 0 : unitsRefundCentavos(lines as any, shares, i, refundedQtys[l.id] || 0, qty);
  };
  const refundCentavos = billableLines.reduce((sum, l) => sum + lineRefundCentavos(l, getRefundQty(l.id)), 0);
  const peso = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const hasAnyQty = billableLines.some((l) => getRefundQty(l.id) > 0);
  const canSubmit = !offlineBlocked && hasAnyQty && !!reason.trim() && pin.length === PIN_LENGTH && !!chosenTender && !isSubmitting;

  const handleSelectAll = () => {
    const all: RefundQty = {};
    billableLines.forEach((l) => { all[l.id] = getMaxQty(l); });
    setRefundQtys(all);
  };
  const handleClearAll = () => setRefundQtys({});

  const handleSubmit = async () => {
    if (!canSubmit || !activeStore) return;
    const asked = billableLines.filter((l) => getRefundQty(l.id) > 0).map((l) => ({ lineId: l.id, qty: getRefundQty(l.id) }));
    const key = JSON.stringify({ asked, reason: reason.trim(), chosenTender });
    setIsSubmitting(true);
    try {
      if (!reserved.current || reserved.current.key !== key) {
        const r = await reserveNext();
        if (r.storeId !== receipt.storeId) throw new Error("This tablet is set up for a different store. Check Settings.");
        reserved.current = { key, number: formatTerminalReceiptNumber(activeStore.code, r.terminalNo, r.terminalSeq), terminalNo: r.terminalNo, terminalSeq: r.terminalSeq };
      }
      const res = await postPos2<{ refundReceiptId: string; receiptNumber: string }>("refunds", {
        storeId: receipt.storeId,
        parentReceiptId: receipt.receiptId ?? receipt.id,
        lines: asked,
        tenderMethodId: chosenTender,
        reason: reason.trim(),
        terminalNo: reserved.current.terminalNo,
        terminalSeq: reserved.current.terminalSeq,
        receiptNumber: reserved.current.number,
        pin,
      });
      toast({ title: "Refund saved", description: `Refund receipt ${res.receiptNumber} has been saved.` });
      onSuccess(res.refundReceiptId);
      onClose();
    } catch (err: any) {
      if (err instanceof Pos2Error && err.status === 409) reserved.current = null; // that number is taken or the receipt changed: ask for a fresh one
      if (err instanceof Pos2Error && err.status === 403) setPin("");
      toast({ variant: "destructive", title: "Refund not done", description: err?.message ?? String(err) });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {offlineBlocked && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive">{OFFLINE_REFUND_MESSAGE}</p>
        )}
        {billableLines.length === 0 && (
          <div className="text-center text-muted-foreground py-10">All items on this receipt have already been fully refunded.</div>
        )}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Select quantities to refund.</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleSelectAll}>Select All</Button>
            <Button variant="ghost" size="sm" onClick={handleClearAll}>Clear</Button>
          </div>
        </div>

        <div className="border rounded-md divide-y">
          {billableLines.map((line) => {
            const max = getMaxQty(line);
            const qty = getRefundQty(line.id);
            return (
              <div key={line.id} className="flex items-center justify-between px-4 py-3 gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{line.itemName}</p>
                  <p className="text-xs text-muted-foreground">{max} available</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setQty(line.id, qty - 1, max)} disabled={qty <= 0}>−</Button>
                  <Input
                    type="number"
                    className="w-14 h-7 text-center p-1"
                    value={qty}
                    min={0}
                    max={max}
                    onChange={(e) => setQty(line.id, parseInt(e.target.value), max)}
                  />
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setQty(line.id, qty + 1, max)} disabled={qty >= max}>+</Button>
                  <span className="text-sm w-24 text-right">₱{peso(lineRefundCentavos(line, qty))}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <p className="font-semibold text-lg">Refund Total: ₱{peso(refundCentavos)}</p>
        </div>
        <p className="text-xs text-muted-foreground text-right">What the customer paid for these items, after discounts and taxes.</p>

        <div>
          <Label htmlFor="refundTender">Pay the refund in</Label>
          <select
            id="refundTender"
            className="mt-2 w-full rounded-md border bg-background p-2 text-sm"
            value={chosenTender}
            onChange={(e) => setTenderId(e.target.value)}
            disabled={isSubmitting || cashMethods.length === 0}
          >
            {cashMethods.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{CASH_ONLY_SENTENCE}</p>
          {cashMethods.length === 0 && <p className="mt-1 text-xs text-destructive">This store has no cash payment method set up.</p>}
        </div>

        <div>
          <Label htmlFor="refundReason">Reason for Refund (Required)</Label>
          <Textarea
            id="refundReason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g., Customer returned items, overcharge correction..."
            className="mt-2"
          />
        </div>

        <div>
          <Label>Store manager PIN</Label>
          <p className="mb-2 text-xs text-muted-foreground">The manager types their own ERP PIN. It is checked on the server and never saved.</p>
          <PinPad value={pin} onChange={setPin} disabled={isSubmitting} />
        </div>
      </div>

      <DialogFooter className="p-4 border-t">
        <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={!canSubmit} variant="destructive">
          {isSubmitting ? <Loader2 className="animate-spin mr-2 h-4 w-4" /> : null}
          Issue Refund
        </Button>
      </DialogFooter>
    </>
  );
}

export function RefundReceiptDialog(props: RefundReceiptDialogProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={props.isOpen} onOpenChange={props.onClose}>
        <DrawerContent className="h-[90dvh] flex flex-col">
          <DrawerHeader>
            <DrawerTitle>Refund: {props.receipt.receiptNumber}</DrawerTitle>
            <DrawerDescription>Select items and quantities to refund.</DrawerDescription>
          </DrawerHeader>
          <RefundContent {...props} />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={props.isOpen} onOpenChange={props.onClose}>
      <DialogContent className="max-w-2xl h-[85dvh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-4 border-b">
          <DialogTitle>Refund: {props.receipt.receiptNumber}</DialogTitle>
          <DialogDescription>Select items and quantities to refund. A new refund receipt will be created and a store manager must approve it with their PIN.</DialogDescription>
        </DialogHeader>
        <RefundContent {...props} />
      </DialogContent>
    </Dialog>
  );
}
