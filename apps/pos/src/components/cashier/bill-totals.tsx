
"use client";

import { useMemo } from "react";
import { Separator } from "../ui/separator";
import type { SessionBillLine, Discount, Store, Adjustment, LineAdjustment, SessionLoyaltyRedemption } from "@/lib/types";
import { calculateBillTotals, type TaxAndTotals } from "@/lib/tax";

interface BillTotalsProps {
  lines: SessionBillLine[];
  store: Store;
  billDiscount: Discount | null;
  customAdjustments: Adjustment[];
  loyaltyRedemptions?: SessionLoyaltyRedemption[];
  totalPaid: number;
  isLocked?: boolean;
  onRemoveLineAdjustment?: (lineId: string, adjId: string) => void;
}

export function BillTotals({
  lines,
  store,
  billDiscount,
  customAdjustments,
  loyaltyRedemptions,
  totalPaid,
  isLocked,
  onRemoveLineAdjustment,
}: BillTotalsProps) {

    const redemptions = loyaltyRedemptions ?? [];
    const totals = useMemo(() => {
        if (!store) return {
          subtotal: 0, taxableAmount: 0, taxTotal: 0, lineDiscountsTotal: 0,
          billDiscountTotal: 0, loyaltyDiscountTotal: 0, totalDiscounts: 0, chargesTotal: 0, grandTotal: 0,
          vatableSales: 0, vatExemptSales: 0
        };
        return calculateBillTotals(lines, store, billDiscount, customAdjustments,
          redemptions.map((r) => ({ type: r.type, value: r.value })));
    }, [lines, store, billDiscount, customAdjustments, redemptions]);

    // Add guards for totals being null
    const grandTotal = totals?.grandTotal ?? 0;
    const totalPaidNum = totalPaid ?? 0;
    const remainingBalance = grandTotal - totalPaidNum;
    const change = totalPaidNum > grandTotal ? totalPaidNum - grandTotal : 0;
    
    const activeLines = useMemo(() => lines.filter(line => (line.qtyOrdered - (line.voidedQty || 0)) > 0), [lines]);

  return (
    <div className="p-3 bg-background space-y-2 text-sm">
        {activeLines.map(line => {
            const orderedQty = line.qtyOrdered - (line.voidedQty || 0);
            const freeQty = line.freeQty || 0;
            const billableQty = Math.max(0, orderedQty - freeQty);

            const baseUnit = Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice) : 0;
            const modTotal = Number((line as any).modifiersTotal || 0);
            const unitPrice = baseUnit + modTotal;
            const lineGross = billableQty * unitPrice;
            const modifiersText = (line as any).modifiersText as string | undefined;
            
            const hasAdjDiscount = Object.values(line.lineAdjustments ?? {}).some((a: any) => a.kind === "discount");
            const hasDiscount = !hasAdjDiscount && line.discountValue && line.discountValue > 0 && line.discountQty > 0;
            const hasFree = freeQty > 0;
            
            const lineSubRows: React.ReactNode[] = [];
            
            if (hasDiscount) {
                const taxRate = (store.taxRatePct || 0) / 100;
                const isVatInclusive = store.taxType === "VAT_INCLUSIVE";

                const baseUnitPrice = isVatInclusive ? (unitPrice / (1 + taxRate)) : unitPrice;

                const discountBasePerUnit =
                  line.discountType === "percent"
                    ? baseUnitPrice * ((line.discountValue ?? 0) / 100)
                    : Math.min(baseUnitPrice, (line.discountValue ?? 0));
                
                const discountAmount = discountBasePerUnit * line.discountQty;

                lineSubRows.push(
                    <div key={`${line.id}-disc`} className="flex justify-between pl-4 text-destructive">
                        <span>{` - ${line.discountQty}x Discount`}</span>
                        <span>-₱{discountAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                );
            }
             if (hasFree) {
                lineSubRows.push(
                    <div key={`${line.id}-free`} className="flex justify-between pl-4 text-destructive">
                        <span>{` - ${freeQty}x Free`}</span>
                        <span className="text-muted-foreground">FREE</span>
                    </div>
                );
            }

            const adjs = Object.values(line.lineAdjustments ?? {}).sort((a,b)=>a.createdAtClientMs - b.createdAtClientMs);

            return (
                <div key={line.id} className="space-y-1">
                    <div className="flex justify-between">
                        <span>{billableQty}x {line.itemName}</span>
                        <span>₱{lineGross.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    {modifiersText && (
                      <div className="pl-4 text-xs italic text-muted-foreground">— {modifiersText}</div>
                    )}
                    {lineSubRows}
                    {adjs.map(adj => {
                        const billableQtyForAdj = line.qtyOrdered - (line.voidedQty || 0) - (line.freeQty || 0);
                        const taxRate = (store.taxRatePct || 0) / 100;
                        const isVatInclusive = store.taxType === "VAT_INCLUSIVE";
                        const baseUnitPrice = isVatInclusive ? (unitPrice / (1 + taxRate)) : unitPrice;
                        
                        let adjAmount = 0;
                        const qtyToApply = Math.min(adj.qty, billableQtyForAdj);

                        if (adj.kind === 'discount') {
                            if (adj.type === 'percent') {
                                adjAmount = qtyToApply * baseUnitPrice * (adj.value / 100);
                            } else { // fixed
                                adjAmount = Math.min(baseUnitPrice, adj.value) * qtyToApply;
                            }
                        } else if (adj.kind === 'charge') {
                            if (adj.type === 'percent') {
                                adjAmount = qtyToApply * baseUnitPrice * (adj.value / 100);
                            } else { // fixed
                                adjAmount = adj.value * qtyToApply;
                            }
                        }

                        return (
                            <div key={adj.id} className="flex justify-between items-center pl-4 text-xs">
                                <span className={adj.kind === 'discount' ? 'text-destructive' : 'text-green-600'}>
                                    {adj.kind === 'discount' ? '-' : '+'} {adj.qty}x {adj.note}
                                </span>
                                <div className="flex items-center gap-2">
                                     <span className={adj.kind === 'discount' ? 'text-destructive' : 'text-green-600'}>
                                        {adj.kind === 'discount' ? '-' : '+'}₱{adjAmount.toFixed(2)}
                                    </span>
                                    {onRemoveLineAdjustment && !isLocked && (
                                        <button
                                            onClick={() => onRemoveLineAdjustment(line.id, adj.id)}
                                            className="text-muted-foreground hover:text-destructive leading-none text-lg px-1 rounded"
                                            aria-label={`Remove ${adj.note}`}
                                            title={`Remove ${adj.note}`}
                                        >
                                            &times;
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )
        })}

        <Separator className="my-2"/>

        <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>₱{(totals?.subtotal ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        
        {(((totals?.totalDiscounts ?? 0) - (totals?.loyaltyDiscountTotal ?? 0)) > 0) && (
             <div className="flex justify-between text-red-600">
                <span>Discounts</span>
                <span>- ₱{((totals?.totalDiscounts ?? 0) - (totals?.loyaltyDiscountTotal ?? 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
        )}

        {((totals?.loyaltyDiscountTotal ?? 0) > 0) && (
             <div className="flex justify-between text-red-600">
                <span>★ Sharelebrator{redemptions.length === 1 ? `: ${redemptions[0].rewardName}` : ` (${redemptions.length} rewards)`}</span>
                <span>- ₱{(totals?.loyaltyDiscountTotal ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
        )}

        {((totals?.chargesTotal ?? 0) > 0) && (
             <div className="flex justify-between text-green-600">
                <span>Charges</span>
                <span>+ ₱{(totals?.chargesTotal ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
        )}

        {((totals?.taxTotal ?? 0) > 0) && (
            <>
                <Separator className="my-1"/>
                <div className="flex justify-between text-muted-foreground">
                    <span>VATable Sales</span>
                    <span>₱{(totals?.vatableSales ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                 <div className="flex justify-between text-muted-foreground">
                    <span>VAT-Exempt Sales</span>
                    <span>₱{(totals?.vatExemptSales ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                 <div className="flex justify-between text-muted-foreground">
                    <span>VAT ({((store.taxRatePct || 0))}%)</span>
                    <span>₱{(totals?.taxTotal ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
            </>
        )}
        
        <Separator className="my-2"/>
        
         <div className="flex justify-between font-bold text-lg pt-1">
          <span>Amount Due</span>
          <span>₱{grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        
         <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Total Paid</span>
            <span className="font-medium">₱{totalPaid.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div className={`flex justify-between text-sm ${remainingBalance > 0 ? 'text-destructive' : 'text-green-600'}`}>
            <span className="text-muted-foreground">{remainingBalance > 0 ? "Balance" : "Change"}</span>
            <span className="font-medium">₱{(remainingBalance > 0 ? remainingBalance : change).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
    </div>
  );
}
