
"use client";

import { useMemo } from "react";
import { format } from 'date-fns';
import Image from "next/image";
import type { ModeOfPayment, SessionBillLine, Store, ReceiptData, ReceiptSettings } from "@/lib/types";
import { toJsDate } from "@/lib/utils/date";
import { cn } from "@/lib/utils";

interface ReceiptViewProps {
    data: ReceiptData | null;
    paymentMethods?: ModeOfPayment[];
}

function ReceiptRow({ label, value, isBold = false, isEmphasized = false, isCurrency = false, prefix = '', suffix = '' }: { label: string, value: string | number, isBold?: boolean, isEmphasized?: boolean, isCurrency?: boolean, prefix?: string, suffix?: string }) {
    const valueClass = isEmphasized ? 'text-lg' : '';
    const formattedValue = isCurrency && typeof value === 'number'
      ? `${prefix}${(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suffix}`
      : `${prefix}${value}${suffix}`;

    return (
        <div className={`flex justify-between items-baseline ${isBold ? 'font-bold' : ''} ${valueClass} receipt-section`}>
            <span>{label}</span>
            <span className="text-right">{formattedValue}</span>
        </div>
    );
}

export function ReceiptView({ data, paymentMethods = [] }: ReceiptViewProps) {
    if (!data || !data.session || !data.settings) {
        return null;
    }
    const { session, lines, settings, createdByUsername, store } = data;
    const paperWidth = settings.paperWidth || "80mm";
    const analytics = data.analytics || {};

    const paymentMethodMap = useMemo(() => new Map(paymentMethods.map(p => [p.id, p.name])), [paymentMethods]);

    const activeLines = useMemo(() => (lines || [])
        .filter(line => (line.qtyOrdered - (line.voidedQty || 0)) > 0)
        // Pin the package/bundle line to the top (dine-in); stable for the rest.
        .sort((a, b) => (a.type === 'package' ? 0 : 1) - (b.type === 'package' ? 0 : 1)), [lines]);

    const freeItems = useMemo(() => {
        const map = new Map<string, { qty: number }>();
        (lines || []).forEach(item => {
            if (item.freeQty > 0) {
                 const key = item.itemName;
                 const existing = map.get(key);
                 if (existing) existing.qty += item.freeQty;
                 else map.set(key, { qty: item.freeQty });
            }
        });
        return Array.from(map.entries());
    }, [lines]);

    const isRefundReceipt = !!(data.receiptNumber?.startsWith('RF-') || (data as any).isRefund);
    const receiptDate = toJsDate(data.receiptCreatedAt) ?? toJsDate(session.closedAt);
    const dateLabel = receiptDate ? format(receiptDate, "MM/dd/yy HH:mm") : "N/A";
    const rawCashier = createdByUsername || session.cashierName || session.startedByUid?.substring(0, 6);
    const cashierName = rawCashier && rawCashier !== "N/A" ? rawCashier : ((data as any).createdByEmail ? String((data as any).createdByEmail).split("@")[0] : "N/A");

    const getPaymentMethodName = (id: string) => {
        const fromMap = paymentMethodMap.get(id);
        if (fromMap) return fromMap;
        const found = paymentMethods.find(pm => pm.name.toLowerCase() === id.toLowerCase());
        if (found) return found.name;
        return id;
    };
    
    const { 
        subtotal = 0,
        discountsTotal = 0,
        chargesTotal = 0,
        grandTotal = 0,
        taxAmount = 0,
        totalPaid = 0,
        change = 0,
        mop = {}
    } = analytics;

    const paymentsFromAnalytics = Object.entries(mop).map(([methodId, amount]) => ({ methodId, amount: amount as number }));
    // Prefer the VAT split persisted on the receipt; historical receipts predate
    // these fields, so fall back to the old derivation (no exempt portion).
    const vatExemptSales = (analytics as any)?.vatExemptSales ?? 0;
    const vatableSales = (analytics as any)?.vatableSales ?? (grandTotal - taxAmount - vatExemptSales);

    const receiptStyles: React.CSSProperties = {
        fontFamily: settings?.fontFamily || undefined,
        fontSize: settings?.fontSize ? `${settings.fontSize}px` : undefined,
    };
    
    const headerFontSize = {
        fontSize: settings?.fontSize ? `${settings.fontSize * 1.5}px` : undefined,
    };
    
    const widthClass = paperWidth === "58mm" ? "receipt-58" : "receipt-80";

    return (
        <div 
            className={cn("receipt-view bg-white text-black mx-auto p-4 shadow-lg", widthClass)}
            style={receiptStyles}
        >
            {isRefundReceipt && (
                <div className="text-center font-bold border border-black rounded px-2 py-1 mb-2 text-lg tracking-widest">
                    *** REFUND RECEIPT ***
                </div>
            )}
            <header className="text-center space-y-px mb-2 receipt-section">
                {settings.showLogo && settings.logoUrl && (
                    <div className="relative mx-auto mb-1" style={{width: `${settings.logoWidthPct || 80}%`, height: 'auto', aspectRatio: '1 / 1'}}>
                        <Image 
                            src={settings.logoUrl} 
                            alt="Logo" 
                            width={160} 
                            height={160} 
                            className="object-contain mx-auto" 
                        />
                    </div>
                )}
                <h1 className="font-bold" style={headerFontSize}>{settings.businessName || 'Your Business'}</h1>
                <p>{settings.address}</p>
                <p>{settings.contact}</p>
                {settings.tin && <p>TIN: {settings.tin} {settings.vatType === 'VAT' ? 'VAT' : 'Non-VAT'}</p>}
            </header>

            <hr className="border-dashed border-black my-2" />

            <section className="space-y-px mb-2 receipt-section">
                <ReceiptRow label="Date:" value={dateLabel} />
                <ReceiptRow label="Receipt:" value={data.receiptNumber ?? "—"} />
                {settings.showTableOrCustomer && (
                     <ReceiptRow 
                        label={session.sessionMode === 'alacarte' ? "Customer:" : "Table:"} 
                        value={session.sessionMode === 'alacarte' ? (session.customer?.name || session.customerName || 'N/A') : session.tableNumber || 'N/A'}
                     />
                )}
                {settings.showCashierName && <ReceiptRow label="Cashier:" value={cashierName} />}
            </section>

            <hr className="border-dashed border-black my-2" />

            <section className="mb-2 receipt-section">
                <div className="grid grid-cols-[20px,1fr,auto] gap-x-2 font-bold mb-1">
                    <span>Qty</span>
                    <span>Item</span>
                    <span className="text-right">Total</span>
                </div>
                {activeLines.map(line => {
                    const billableQty = line.qtyOrdered - (line.voidedQty || 0);
                    const modTotal = Number((line as any).modifiersTotal || 0);
                    const lineTotal = billableQty * (line.unitPrice + modTotal);

                    const hasDiscount = (line.discountValue ?? 0) > 0 && line.discountQty > 0;
                    
                    let lineDiscountAmount = 0;
                    if (hasDiscount && store) {
                        const taxRate = (store.taxRatePct || 0) / 100;
                        const isVatInclusive = store.taxType === "VAT_INCLUSIVE";
                        const discountedQty = Math.min(line.discountQty, billableQty);
                        
                        const discountBaseUnit = isVatInclusive && taxRate > 0
                          ? (line.unitPrice / (1 + taxRate))
                          : line.unitPrice;

                        if (line.discountType === "percent") {
                           lineDiscountAmount = (discountedQty * discountBaseUnit) * (line.discountValue! / 100);
                        } else { // fixed
                           lineDiscountAmount = Math.min(discountBaseUnit, (line.discountValue ?? 0)) * discountedQty;
                        }
                    }

                    return (
                        <div key={line.id} className="receipt-item-row mb-1">
                             <div className="grid grid-cols-[20px,1fr,auto] gap-x-2 items-start">
                                <span>{billableQty}</span>
                                <div className="min-w-0">
                                  <div className="whitespace-normal break-words leading-tight">
                                    {line.itemName}
                                  </div>
                                  {(line as any).modifiersText && (
                                    <div className="text-xs italic pl-2 opacity-80 break-words leading-tight">
                                      — {(line as any).modifiersText}
                                    </div>
                                  )}
                                  {(line as any).note && (
                                    <div className="text-xs italic pl-2 opacity-80 break-words leading-tight">
                                      Note: {(line as any).note}
                                    </div>
                                  )}
                                </div>
                                <span className="text-right whitespace-nowrap">
                                  {lineTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                            </div>
                             {hasDiscount && settings.showDiscountBreakdown && (
                                <div className="pl-4 italic">
                                    <span>Discount ({line.discountQty}x)</span>
                                    <span className="text-right whitespace-nowrap">- {lineDiscountAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                            )}
                        </div>
                    );
                })}
            </section>

             <hr className="border-dashed border-black my-2" />
             <section className="space-y-px mb-2 receipt-section">
                <ReceiptRow label="Subtotal" value={subtotal} isCurrency />
                {(discountsTotal > 0) && (
                    <ReceiptRow label="Discounts" value={discountsTotal} isCurrency prefix="(- " suffix=")" />
                )}
                 {(chargesTotal > 0) && (
                    <ReceiptRow label="Charges" value={chargesTotal} isCurrency prefix="+ " />
                )}
             </section>
             
             {(taxAmount > 0 || vatExemptSales > 0) && (
                 <>
                    <hr className="border-dashed border-black my-2" />
                    <section className="space-y-px mb-2 receipt-section">
                         <ReceiptRow label="VATable Sales" value={vatableSales} isCurrency />
                         <ReceiptRow label="VAT-Exempt Sales" value={vatExemptSales} isCurrency />
                         <ReceiptRow label={`VAT (${store?.taxRatePct || 12}%)`} value={taxAmount} isCurrency />
                    </section>
                </>
             )}

             <hr className="border-dashed border-black my-2" />
             <section className="space-y-px my-2 receipt-section">
                <ReceiptRow label="TOTAL" value={isRefundReceipt ? -Math.abs(grandTotal) : grandTotal} isBold={true} isCurrency prefix="PHP " />
             </section>
            
             <hr className="border-dashed border-black my-2" />
             <section className="space-y-px mb-2 receipt-section">
                {paymentsFromAnalytics.map((p, i) => (
                    <ReceiptRow key={i} label={getPaymentMethodName(p.methodId).toUpperCase()} value={p.amount} isCurrency />
                ))}
                 <ReceiptRow label={isRefundReceipt ? "Total Refunded" : "Total Paid"} value={isRefundReceipt ? -Math.abs(totalPaid) : totalPaid} isCurrency />
                 <ReceiptRow label="CHANGE" value={change} isBold={true} isCurrency />
             </section>

             {freeItems.length > 0 && (
                <>
                 <hr className="border-dashed border-black my-2" />
                 <section className="space-y-px mb-2 receipt-section">
                    <p className="font-bold">Free Items:</p>
                    {freeItems.map(([name, item]) => (
                        <p key={name}>{item.qty}x {name}</p>
                    ))}
                 </section>
                </>
             )}

            <footer className="text-center mt-4 space-y-2 receipt-section">
                {settings.footerText && <p>{settings.footerText}</p>}
                <p>Thank you for sharelebrating with us!</p>
            </footer>
        </div>
    );
}

    