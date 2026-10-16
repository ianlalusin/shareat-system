
"use client";

import type { Discount, Charge, Receipt as ReceiptType, ModeOfPayment, Store, SessionBillLine } from "@/lib/types";
import * as React from "react";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { Loader2, Printer, Search, Settings, Download, Calendar as CalendarIcon, Trash2, Edit, Ban, ArrowLeft, ArrowLeftRight, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useStoreContext } from "@/context/store-context";
import { db } from "@/lib/firebase/client";
import { collection, query, orderBy, onSnapshot, doc, getDoc, updateDoc, increment, serverTimestamp, where, Timestamp, deleteDoc, writeBatch, limit, startAfter, getDocs, type DocumentData, type QueryDocumentSnapshot } from "firebase/firestore";
import { format } from "date-fns";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import { ReceiptView } from "@/components/receipt/receipt-view";
import { RefundReceiptDialog } from "@/components/receipts/RefundReceiptDialog";
import { TenderCorrectionDialog } from "@/components/receipts/TenderCorrectionDialog";
import { useAuthContext } from "@/context/auth-context";
import { toJsDate, formatDuration } from "@/lib/utils/date";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import CompactCalendar from "@/components/ui/CompactCalendar";
import { writeActivityLog } from "@/components/cashier/activity-log";
import { exportToXlsx } from "@/lib/export/export-xlsx-client";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import { applyAnalyticsDeltaV2 } from "@/lib/analytics/applyAnalyticsDeltaV2";
import { applyReceiptDeltaServerFirst } from "@/lib/analytics/applyReceiptDeltaServerFirst";
import { v4 as uuidv4 } from "uuid";
import { Badge } from "@/components/ui/badge";
import type { ReceiptData } from "@/lib/types";
import { useReceiptSettings } from "@/hooks/use-receipt-settings";
import { usePrint } from "@/hooks/use-print";
import { subscribeApplicableGlobalDiscounts, subscribeApplicableGlobalCharges, isDiscountDateActive } from "@/lib/collections/globalCollections";
import type { GlobalDiscount, GlobalCharge } from "@/lib/types";


import { startOfDay, endOfDay, isSameDay, fmtDate } from "@/lib/utils/date";
function customBtnLabel(range: {start: Date; end: Date} | null, active: boolean) {
    if (!active || !range) return "Custom";
    return isSameDay(range.start, range.end)
        ? `Custom: ${fmtDate(range.start)}`
        : `Custom: ${fmtDate(range.start)} — ${fmtDate(range.end)}`;
}

// Dine-in (package) session duration = payment time − session start. "N/A" for
// ala carte or when the session start wasn't captured. Excel export only.
function sessionDurationLabel(r: ReceiptType): string {
    if (r.sessionMode !== 'package_dinein') return 'N/A';
    const startMs = (r.analytics?.sessionStartedAtClientMs ?? toJsDate(r.analytics?.sessionStartedAt)?.getTime()) || null;
    const endMs = (r.createdAtClientMs ?? toJsDate(r.createdAt)?.getTime()) || null;
    if (!startMs || !endMs || endMs <= startMs) return 'N/A';
    return formatDuration(endMs - startMs);
}

type DatePreset = "today" | "yesterday" | "week" | "month" | "custom";
const presets: { label: string, value: DatePreset }[] = [
    { label: "Today", value: "today" },
    { label: "Yesterday", value: "yesterday" },
    { label: "This Week", value: "week" },
    { label: "This Month", value: "month" },
];



export default function ReceiptsPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();
    const { appUser, isSigningOut } = useAuthContext();
    const { activeStore, loading: storeLoading } = useStoreContext();
    
    const [receipts, setReceipts] = useState<ReceiptType[]>([]);
    const [isLoadingReceipts, setIsLoadingReceipts] = useState(true);
    const [isExporting, setIsExporting] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const debouncedSearchTerm = useDebounce(searchTerm, 300);

    const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
    const [selectedReceiptData, setSelectedReceiptData] = useState<Omit<ReceiptData, 'settings'> | null>(null);
    const [isLoadingPreview, setIsLoadingPreview] = useState(false);
    const [isProcessing, setIsProcessing] = useState<string | null>(null);
    
    const { settings, isLoading: settingsLoading } = useReceiptSettings(activeStore?.id);
    const { printReceipt, isPrinting } = usePrint({ receiptData: selectedReceiptData as ReceiptData | null, storeId: activeStore?.id, sessionId: selectedReceiptId, appUser });

    const [paymentMethods, setPaymentMethods] = useState<ModeOfPayment[]>([]);

    const [refundTarget, setRefundTarget] = useState<ReceiptType | null>(null);
    const [tenderTarget, setTenderTarget] = useState<ReceiptType | null>(null);

    // --- Pagination State ---
    const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
    const [hasMore, setHasMore] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const PAGE_SIZE = 20;

    // --- Date State ---
    const [datePreset, setDatePreset] = useState<DatePreset>("today");
    const [isCalendarOpen, setIsCalendarOpen] = useState(false);
    const [customRange, setCustomRange] = useState<{ start: Date; end: Date } | null>(null);

    const { start, end } = useMemo(() => {
        const now = new Date();
        let s = new Date();
        let e = new Date();

        switch (datePreset) {
            case "today":
                s.setHours(0, 0, 0, 0);
                e.setHours(23, 59, 59, 999);
                break;
            case "yesterday":
                s.setDate(now.getDate() - 1);
                s.setHours(0, 0, 0, 0);
                e.setDate(now.getDate() - 1);
                e.setHours(23, 59, 59, 999);
                break;
            case "week":
                s.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
                s.setHours(0, 0, 0, 0);
                break;
            case "month":
                s = new Date(now.getFullYear(), now.getMonth(), 1);
                break;
            case "custom":
                if (customRange) {
                    s = startOfDay(customRange.start);
                    e = endOfDay(customRange.end);
                } else {
                    s.setHours(0, 0, 0, 0);
                    e.setHours(23, 59, 59, 999);
                }
                break;
        }
        return { start: s, end: e };
    }, [datePreset, customRange]);

    const dateRangeLabel = useMemo(() => {
        if (isSameDay(start, end)) {
            return fmtDate(start);
        }
        return `${fmtDate(start)} - ${fmtDate(end)}`;
    }, [start, end]);
    
    useEffect(() => {
        if (!searchParams) return;
      
        const rid = searchParams.get("rid");
        if (rid) setSelectedReceiptId(rid);
      }, [searchParams]);

    const fetchReceipts = useCallback(async (loadMore = false) => {
        if (!activeStore || !appUser) return;

        if (loadMore) setIsLoadingMore(true);
        else setIsLoadingReceipts(true);

        let q = query(
            collection(db, "stores", activeStore.id, "receipts"), 
            where("createdAt", ">=", start),
            where("createdAt", "<=", end),
            orderBy("createdAt", "desc"),
            limit(PAGE_SIZE)
        );

        if (loadMore && lastDoc) {
            q = query(q, startAfter(lastDoc));
        }

        try {
            const snapshot = await getDocs(q);
            const newReceipts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ReceiptType));
            
            setLastDoc(snapshot.docs[snapshot.docs.length - 1] || null);
            setHasMore(snapshot.docs.length === PAGE_SIZE);
            
            setReceipts(prev => loadMore ? [...prev, ...newReceipts] : newReceipts);

        } catch (error) {
            if (isSigningOut) return;
            console.error("Error fetching receipts:", error);
            toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch receipts.' });
        } finally {
            setIsLoadingReceipts(false);
            setIsLoadingMore(false);
        }
    }, [activeStore, start, end, lastDoc, toast, appUser, isSigningOut]);
      
    // Effect for initial load and date/store changes
    useEffect(() => {
        setReceipts([]);
        setLastDoc(null);
        setHasMore(true);
        fetchReceipts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeStore, start, end]);

    useEffect(() => {
        if (!activeStore?.id) return;
        const unsubPm = onSnapshot(
            query(collection(db, "stores", activeStore.id, "storeModesOfPayment"), where("isArchived", "==", false), orderBy("sortOrder")),
            snap => setPaymentMethods(snap.docs.map(d => ({id: d.id, ...d.data()}) as ModeOfPayment)),
            (err) => {
                if (isSigningOut || !appUser) return;
                console.error("MOP listener error:", err);
            }
        );
        return () => unsubPm();
    }, [activeStore?.id, appUser, isSigningOut]);
    
    const [storeDiscounts, setStoreDiscounts] = React.useState<Discount[]>([]);
    const [storeCharges, setStoreCharges] = React.useState<Charge[]>([]);
    const [globalDiscounts, setGlobalDiscounts] = React.useState<GlobalDiscount[]>([]);
    const [globalCharges, setGlobalCharges] = React.useState<GlobalCharge[]>([]);
     useEffect(() => {
        if (!activeStore?.id) return;
        const handleError = (err: any) => {
            if(isSigningOut || !appUser) return;
            console.error("Collections listener error:", err);
        }
        // Store-scoped: include enabled + not-archived; also include entries the admin hasn't suspended.
        const unsubDiscounts = onSnapshot(
            query(collection(db, "stores", activeStore.id, "storeDiscounts"), where("isArchived", "==", false), where("isEnabled", "==", true)),
            snap => setStoreDiscounts(
              snap.docs
                .map(d => ({id: d.id, ...d.data()}) as Discount)
                .filter(d => !d.adminSuspended)
            ),
            handleError
        );
         const unsubCharges = onSnapshot(
            query(collection(db, "stores", activeStore.id, "storeCharges"), where("isArchived", "==", false), where("isEnabled", "==", true)),
            snap => setStoreCharges(
              snap.docs
                .map(d => ({id: d.id, ...d.data()}) as Charge)
                .filter(c => !c.adminSuspended)
            ),
            handleError
        );
        const unsubGlobalDiscounts = subscribeApplicableGlobalDiscounts(
            db,
            activeStore.id,
            (items) => setGlobalDiscounts(items.filter(g => g.isEnabled)),
            handleError,
        );
        const unsubGlobalCharges = subscribeApplicableGlobalCharges(
            db,
            activeStore.id,
            (items) => setGlobalCharges(items.filter(g => g.isEnabled)),
            handleError,
        );
        return () => {
            unsubDiscounts();
            unsubCharges();
            unsubGlobalDiscounts();
            unsubGlobalCharges();
        };
    }, [activeStore?.id, appUser, isSigningOut]);

    const discounts = useMemo<Discount[]>(() => {
      const merged: Discount[] = [
        ...storeDiscounts.map(d => ({ ...d, source: "store" as const })),
        ...globalDiscounts.map(g => ({
          id: g.id,
          name: g.name,
          type: g.type,
          value: g.value,
          scope: g.scope,
          stackable: g.stackable,
          isEnabled: g.isEnabled,
          sortOrder: g.sortOrder,
          isArchived: g.isArchived,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
          createdBy: g.createdBy,
          updatedBy: g.updatedBy,
          startDate: g.startDate,
          endDate: g.endDate,
          source: "global" as const,
        })),
      ];
      merged.sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
      return merged.filter(d => isDiscountDateActive(d));
    }, [storeDiscounts, globalDiscounts]);

    const charges = useMemo<Charge[]>(() => {
      const merged: Charge[] = [
        ...storeCharges.map(c => ({ ...c, source: "store" as const })),
        ...globalCharges.map(g => ({
          id: g.id,
          name: g.name,
          type: g.type,
          value: g.value,
          appliesTo: g.appliesTo,
          scope: g.scope,
          isEnabled: g.isEnabled,
          sortOrder: g.sortOrder,
          isArchived: g.isArchived,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
          createdBy: g.createdBy,
          updatedBy: g.updatedBy,
          source: "global" as const,
        })),
      ];
      merged.sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
      return merged;
    }, [storeCharges, globalCharges]);

    const filteredReceipts = useMemo(() => {
        if (!debouncedSearchTerm) return receipts;
        const lowercasedFilter = debouncedSearchTerm.toLowerCase();
        return receipts.filter(r => 
            r.receiptNumber?.toLowerCase().includes(lowercasedFilter) ||
            r.customerName?.toLowerCase().includes(lowercasedFilter) ||
            r.tableNumber?.toLowerCase().includes(lowercasedFilter) ||
            r.createdByUsername?.toLowerCase().includes(lowercasedFilter)
        );
    }, [receipts, debouncedSearchTerm]);

    const handleSelectReceipt = useCallback((receiptId: string) => {
        setSelectedReceiptId(receiptId);
        const newUrl = `${window.location.pathname}?rid=${receiptId}`;
        window.history.replaceState({ ...window.history.state, as: newUrl, url: newUrl }, '', newUrl);
    }, []);

    useEffect(() => {
        if (!selectedReceiptId || !activeStore) {
            setSelectedReceiptData(null);
            return;
        }
        setIsLoadingPreview(true);
        const fetchReceiptDetails = async () => {
             try {
                const receiptSnap = await getDoc(doc(db, "stores", activeStore.id, "receipts", selectedReceiptId));
                
                if (!receiptSnap.exists()) throw new Error("Receipt not found.");

                const receiptDocData = receiptSnap.data({ serverTimestamps: "estimate" }) as any;
                
                const sessionDataForPreview = {
                    id: receiptDocData.sessionId,
                    tableNumber: receiptDocData.tableNumber,
                    customerName: receiptDocData.customerName,
                    sessionMode: receiptDocData.sessionMode,
                    paymentSummary: receiptDocData.analytics,
                    closedAt: receiptDocData.createdAt,
                    startedByUid: "N/A",
                };
                
                setSelectedReceiptData({
                    session: sessionDataForPreview as any,
                    lines: receiptDocData.lines || [],
                    payments: Object.entries(receiptDocData.analytics?.mop || {}).map(([key, value]) => ({ methodId: key, amount: value as number})),
                    store: activeStore as Store,
                    receiptCreatedAt: receiptDocData.createdAt,
                    createdByUsername: receiptDocData.createdByUsername,
                    receiptNumber: receiptDocData.receiptNumber,
                    analytics: receiptDocData.analytics,
                    isRefund: receiptDocData.isRefund ?? false,
                    createdByEmail: receiptDocData.createdByEmail ?? null,
                } as any);
                
            } catch (err: any) {
                toast({ variant: 'destructive', title: 'Error loading preview', description: err.message });
                setSelectedReceiptData(null);
            } finally {
                setIsLoadingPreview(false);
            }
        };
        fetchReceiptDetails();
    }, [selectedReceiptId, activeStore, toast]);
    

    const handleExport = async () => {
        if (!activeStore) return;
        setIsExporting(true);

        try {
            const allReceiptsQuery = query(
                collection(db, "stores", activeStore.id, "receipts"),
                where("createdAt", ">=", start),
                where("createdAt", "<=", end),
                orderBy("createdAt", "desc")
            );
            
            const snapshot = await getDocs(allReceiptsQuery);
            const allReceipts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ReceiptType));
            
            if (allReceipts.length === 0) {
                 toast({ description: "No data to export for the selected range." });
                 setIsExporting(false);
                 return;
            }

            // Sheet 1: Summary Data
            const summaryData = allReceipts.map(r => {
                const date = toJsDate(r.createdAt);
                return {
                    "Receipt #": r.receiptNumber || 'N/A',
                    "Date": date ? format(date, 'yyyyMMdd') : 'N/A',
                    "Time": date ? format(date, 'HH:mm:ss') : 'N/A',
                    "Customer Name": r.customerName || 'N/A',
                    "Address": r.customerAddress || 'N/A',
                    "TIN": r.customerTin || 'N/A',
                    "Table No.": r.tableNumber || 'N/A',
                    "Package": r.lines?.find(l => l.type === 'package')?.itemName || 'Ala Carte',
                    "Session Time": sessionDurationLabel(r),
                    "Subtotal": r.analytics?.subtotal ?? 0,
                    "Discount": r.analytics?.discountsTotal ?? 0,
                    "Charges": r.analytics?.chargesTotal ?? 0,
                    "VAT": r.analytics?.taxAmount ?? 0,
                    "Total": r.total,
                    "Paid": r.totalPaid,
                    "Mode of Payment": Object.keys(r.analytics?.mop || {}).join(', '),
                };
            });
        
            // Sheet 2: Itemized Data
            const itemizedData: any[] = [];
            allReceipts.forEach(r => {
                const date = toJsDate(r.createdAt);
                (r.lines as SessionBillLine[])?.forEach(line => {
                    const billableQty = line.qtyOrdered - (line.voidedQty || 0);
                    if (billableQty <= 0) return; // Skip voided/zero-qty lines

                    const lineSubtotal = billableQty * line.unitPrice;
                    let lineDiscount = 0;
                    if ((line.discountValue ?? 0) > 0 && line.discountQty > 0) {
                         const discountedQty = Math.min(line.discountQty, billableQty);
                         if (line.discountType === 'percent') {
                             lineDiscount = discountedQty * line.unitPrice * (line.discountValue! / 100);
                         } else {
                             lineDiscount = discountedQty * line.discountValue!;
                         }
                    }
                    
                    itemizedData.push({
                        "Receipt #": r.receiptNumber || 'N/A',
                        "Date": date ? format(date, 'yyyyMMdd') : 'N/A',
                        "Time": date ? format(date, 'HH:mm:ss') : 'N/A',
                        "QTY": billableQty,
                        "Package/Add-on": line.itemName,
                        "Price": line.unitPrice,
                        "Discount": lineDiscount,
                        "Subtotal": lineSubtotal - lineDiscount,
                    });
                });
            });
        
            await exportToXlsx({
                sheets: [
                    { data: summaryData, name: "Summary" },
                    { data: itemizedData, name: "Items" }
                ],
                filename: `Receipts_${activeStore.code}_${format(start, 'yyyyMMdd')}_${format(end, 'yyyyMMdd')}.xlsx`,
            });
        } catch (error: any) {
             toast({ variant: 'destructive', title: 'Export Failed', description: error.message });
        } finally {
            setIsExporting(false);
        }
    };

    const handleCalendarChange = (range: { start: Date; end: Date }, preset: string | null) => {
        const presetMap: Record<string, DatePreset> = {
          today: "today", yesterday: "yesterday", lastWeek: "week", lastMonth: "month",
        };
        if (preset && preset !== "custom" && presetMap[preset]) {
          setDatePreset(presetMap[preset]);
          setCustomRange(null);
        } else {
          setCustomRange({ start: range.start, end: range.end });
          setDatePreset("custom");
        }
        setIsCalendarOpen(false);
    };

    if (storeLoading) {
        return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>;
    }

    if (!activeStore) {
        return (
            <Card className="w-full max-w-md mx-auto text-center">
                <CardHeader>
                    <CardTitle>No Store Selected</CardTitle>
                    <CardDescription>Please select a store to view receipts.</CardDescription>
                </CardHeader>
            </Card>
        );
    }
    
    return (
        <RoleGuard allow={["admin", "manager", "cashier"]}>
            <div className="no-print">
                <PageHeader title="Receipts" description="Browse, preview, and reprint past receipts.">
                    <div className="flex items-center gap-2">
                        <Button variant="outline" onClick={() => router.back()}>
                            <ArrowLeft className="mr-2 h-4 w-4" /> Back
                        </Button>
                        <Button onClick={handleExport} disabled={isExporting || isLoadingReceipts || filteredReceipts.length === 0} variant="outline">
                            {isExporting ? <Loader2 className="mr-2 animate-spin"/> : <Download className="mr-2" />}
                            Export
                        </Button>
                    </div>
                </PageHeader>
                
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mt-6">
                    <div className="relative flex-1 w-full sm:w-auto">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input placeholder="Search by Receipt #, Table, Customer..." className="pl-8" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
                    </div>
                    <div className="flex flex-col items-start sm:items-end gap-2">
                        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-1">
                            {presets.map(p => (
                                <Button key={p.value} variant={datePreset === p.value ? 'default' : 'ghost'} size="sm" onClick={() => { setDatePreset(p.value); setCustomRange(null); }} className="h-8">{p.label}</Button>
                            ))}
                            <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
                                <PopoverTrigger asChild>
                                    <Button variant={datePreset === "custom" ? "default" : "ghost"} size="sm" className="h-8 min-w-[100px]">{customBtnLabel(customRange, datePreset === "custom")}</Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-0"><CompactCalendar onChange={handleCalendarChange}/></PopoverContent>
                            </Popover>
                        </div>
                         <p className="text-sm text-muted-foreground text-right">{dateRangeLabel}</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start mt-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>Transactions</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {isLoadingReceipts ? <div className="flex justify-center p-8"><Loader2 className="mx-auto animate-spin" /></div> : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Identifier</TableHead>
                                            <TableHead>Total</TableHead>
                                            {(appUser?.role === 'admin' || appUser?.role === 'manager') && <TableHead className="text-right">Actions</TableHead>}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {filteredReceipts.map(r => {
                                            return (
                                            <TableRow 
                                                key={r.id} 
                                                onClick={(e) => {
                                                    const el = e.target as HTMLElement;
                                                    if (el.closest("button")) return;
                                                    handleSelectReceipt(r.id);
                                                }}
                                                className={cn("cursor-pointer", selectedReceiptId === r.id && "bg-muted", r.status === 'voided' && 'text-muted-foreground line-through')}
                                            >
                                                <TableCell className="font-medium py-2">
                                                    <div>{r.receiptNumber || `Tbl ${r.tableNumber}` || r.customerName} {r.status === 'voided' && <Badge variant="destructive">VOIDED</Badge>}{r.isRefund && <Badge variant="secondary" className="ml-1">REFUND</Badge>}</div>
                                                    <div className="text-xs">{r.createdByUsername || 'N/A'} - {format(toJsDate(r.createdAt)!, 'p')}</div>
                                                </TableCell>
                                                <TableCell className="font-bold py-2">₱{r.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</TableCell>
                                                {(appUser?.role === 'admin' || appUser?.role === 'manager') && (
                                                    <TableCell
                                                        className="text-right py-2"
                                                    >
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRefundTarget(r); }}
                                                            disabled={r.status === "voided" || !!r.isRefund}
                                                            className="mr-2"
                                                            title="Refund this receipt (a store manager PIN is needed)"
                                                            type="button"
                                                        >
                                                            <RotateCcw className="mr-1 h-4 w-4" /> Refund
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTenderTarget(r); }}
                                                            disabled={r.status !== "final" || !!r.isRefund}
                                                            title="Money went to the wrong payment method (a store manager PIN is needed)"
                                                            type="button"
                                                        >
                                                            <ArrowLeftRight className="mr-1 h-4 w-4" /> Mark wrong tender
                                                        </Button>
                                                    </TableCell>
                                                )}
                                            </TableRow>
                                        )})}
                                    </TableBody>
                                </Table>
                            )}
                             {filteredReceipts.length === 0 && !isLoadingReceipts && <p className="text-center text-muted-foreground py-10">No receipts found for this period.</p>}
                             {hasMore && !isLoadingReceipts && (
                                <div className="text-center py-4">
                                    <Button onClick={() => fetchReceipts(true)} disabled={isLoadingMore}>
                                        {isLoadingMore ? <Loader2 className="animate-spin mr-2"/> : null}
                                        Load More
                                    </Button>
                                </div>
                             )}
                        </CardContent>
                    </Card>

                    <div className="sticky top-20">
                         <Card>
                            <CardHeader className="flex flex-row items-center justify-between">
                                <CardTitle>Preview</CardTitle>
                                <Button onClick={printReceipt} disabled={!selectedReceiptData || isPrinting || settingsLoading}>
                                    {isPrinting || settingsLoading ? <Loader2 className="mr-2 animate-spin" /> : <Printer className="mr-2"/>} Reprint
                                </Button>
                            </CardHeader>
                            <CardContent id="print-receipt-area" className="bg-gray-100 dark:bg-gray-800 p-2 rounded-b-lg">
                            {isLoadingPreview ? <div className="flex justify-center p-8"><Loader2 className="animate-spin"/></div> : selectedReceiptData && settings ? (
                                <ReceiptView data={{ ...selectedReceiptData, settings }} paymentMethods={paymentMethods} />
                            ) : (
                                <div className="text-center text-muted-foreground py-20">Select a receipt to preview</div>
                            )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </div>
            
            {/* This div is only for printing */}
            <div id="receipt-print-root" className="hidden">
                {selectedReceiptData && settings && <ReceiptView data={{...selectedReceiptData, settings}} paymentMethods={paymentMethods} />}
            </div>
            {ConfirmDialog}
            {tenderTarget && (
                <TenderCorrectionDialog
                    isOpen={!!tenderTarget}
                    onClose={() => setTenderTarget(null)}
                    receipt={tenderTarget}
                    paymentMethods={paymentMethods}
                    onSuccess={() => { fetchReceipts(); }}
                />
            )}
            {refundTarget && appUser && (
                <RefundReceiptDialog
                    isOpen={!!refundTarget}
                    onClose={() => setRefundTarget(null)}
                    receipt={refundTarget}
                    paymentMethods={paymentMethods}
                    actor={appUser}
                    onSuccess={(refundId) => {
                        fetchReceipts();
                    }}
                />
            )}
        </RoleGuard>
    )
}


    