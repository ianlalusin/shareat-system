"use client";

import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import type { Receipt, SessionBillLine, Payment, ModeOfPayment } from "@/lib/types";
import type { AppUser } from "@/context/auth-context";
import { createRefundReceipt } from "@/components/cashier/firestore";

interface RefundReceiptDialogProps {
  isOpen: boolean;
  onClose: () => void;
  receipt: Receipt;
  paymentMethods: ModeOfPayment[];
  actor: AppUser;
  onSuccess: (refundReceiptId: string) => void;
}

type RefundQty = Record<string, number>; // lineId -> qty to refund

function RefundContent({
  receipt,
  paymentMethods,
  actor,
  onClose,
  onSuccess,
}: RefundReceiptDialogProps) {
  const { toast } = useToast();
  const [refundQtys, setRefundQtys] = useState<RefundQty>({});
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const refundedQtys: Record<string, number> = (receipt as any).refundedQtys ?? {};
  const getMaxQty = (l: SessionBillLine) =>
    Math.max(0, l.qtyOrdered - (l.freeQty || 0) - (l.voidedQty || 0) - (refundedQtys[l.id] || 0));

  const billableLines = useMemo(() =>
    (receipt.lines || []).filter(l => {
      const refunded = refundedQtys[l.id] || 0;
      const billable = l.qtyOrdered - (l.freeQty || 0) - (l.voidedQty || 0) - refunded;
      return billable > 0;
    }),
    [receipt.lines, refundedQtys]
  );

  const getRefundQty = (id: string) => refundQtys[id] ?? 0;

  const setQty = (id: string, val: number, max: number) => {
    const clamped = Math.max(0, Math.min(max, isNaN(val) ? 0 : val));
    setRefundQtys(cur => ({ ...cur, [id]: clamped }));
  };

  const refundTotal = useMemo(() =>
    billableLines.reduce((sum, l) => sum + (getRefundQty(l.id) * l.unitPrice), 0),
    [billableLines, refundQtys]
  );

  const hasAnyQty = refundTotal > 0;

  const handleSelectAll = () => {
    const all: RefundQty = {};
    billableLines.forEach(l => { all[l.id] = getMaxQty(l); });
    setRefundQtys(all);
  };

  const handleClearAll = () => setRefundQtys({});

  const handleSubmit = async () => {
    if (!hasAnyQty) {
      toast({ variant: "destructive", title: "No items selected", description: "Select at least one item to refund." });
      return;
    }
    if (!reason.trim()) {
      toast({ variant: "destructive", title: "Reason required", description: "Please provide a reason for the refund." });
      return;
    }

    // Build refund lines — clone original lines with overridden qtyOrdered
    const refundLines: SessionBillLine[] = billableLines
      .filter(l => getRefundQty(l.id) > 0)
      .map(l => ({ ...l, qtyOrdered: getRefundQty(l.id), freeQty: 0, voidedQty: 0 }));

    // Build refund payments proportionally
    const ratio = refundTotal / (receipt.total || 1);
    const refundPayments: Payment[] = Object.entries(receipt.analytics?.mop || {}).map(([key, value], i) => ({
      id: `refund-payment-${i}`,
      methodId: paymentMethods.find(pm => pm.name === key)?.id || key,
      amount: Math.round((value as number) * ratio * 100) / 100,
    }));

    setIsSubmitting(true);
    try {
      const refundId = await createRefundReceipt(
        receipt.storeId,
        receipt,
        refundLines,
        refundPayments,
        actor,
        reason,
      );
      toast({ title: "Refund created", description: `Refund receipt RF-${receipt.receiptNumber} has been saved.` });
      onSuccess(refundId);
      onClose();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Refund failed", description: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {billableLines.length === 0 && (
          <div className="text-center text-muted-foreground py-10">
            All items on this receipt have already been fully refunded.
          </div>
        )}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Select quantities to refund.</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleSelectAll}>Select All</Button>
            <Button variant="ghost" size="sm" onClick={handleClearAll}>Clear</Button>
          </div>
        </div>

        <div className="border rounded-md divide-y">
          {billableLines.map(line => {
            const max = getMaxQty(line);
            const qty = getRefundQty(line.id);
            return (
              <div key={line.id} className="flex items-center justify-between px-4 py-3 gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{line.itemName}</p>
                  <p className="text-xs text-muted-foreground">₱{line.unitPrice.toFixed(2)} × {max} available</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setQty(line.id, qty - 1, max)} disabled={qty <= 0}>−</Button>
                  <Input
                    type="number"
                    className="w-14 h-7 text-center p-1"
                    value={qty}
                    min={0}
                    max={max}
                    onChange={e => setQty(line.id, parseInt(e.target.value), max)}
                  />
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setQty(line.id, qty + 1, max)} disabled={qty >= max}>+</Button>
                  <span className="text-sm w-20 text-right">₱{(qty * line.unitPrice).toFixed(2)}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <p className="font-semibold text-lg">Refund Total: ₱{refundTotal.toFixed(2)}</p>
        </div>

        <div>
          <Label htmlFor="refundReason">Reason for Refund (Required)</Label>
          <Textarea
            id="refundReason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g., Customer returned items, overcharge correction..."
            className="mt-2"
          />
        </div>
      </div>

      <DialogFooter className="p-4 border-t">
        <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={isSubmitting || !hasAnyQty || !reason.trim()} variant="destructive">
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
          <DialogDescription>Select items and quantities to refund. A new RF- receipt will be created.</DialogDescription>
        </DialogHeader>
        <RefundContent {...props} />
      </DialogContent>
    </Dialog>
  );
}
