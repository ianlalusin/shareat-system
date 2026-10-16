"use client";
import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, CheckCircle, XCircle, Info, Send, ChevronDown, ChevronUp, Minus, Plus, AlarmClock } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirmDialog } from "../global/confirm-dialog";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import type { KitchenTicket } from "@/lib/types";
import { toJsDate, formatDuration } from "@/lib/utils/date";
import { cleanupRadixOverlays } from "@/lib/ui/cleanup-radix";
import { resolveTicketStartMs, ticketAgeMs } from "@/lib/kitchen/server-clock";
import { useServerClockOffset } from "@/hooks/use-server-clock";


export { DEFAULT_SLA_MINUTES } from "@/lib/kitchen/sla";
import { DEFAULT_SLA_MINUTES } from "@/lib/kitchen/sla";

// Live ticket age in ms, ticking every second. Single source of truth for both
// the elapsed display and the SLA "late" state on the card.
//
// Measured server-time-to-server-time: `resolveTicketStartMs` prefers the
// serverTimestamp both writers set, and the device's own drift is subtracted
// from `now`. Differencing two machines' clocks is what made a customer-app
// order land showing 47s on a tablet running 47s fast.
function useTicketAge(createdAt: any, createdAtClientMs?: number | null): number | null {
  const clientAheadMs = useServerClockOffset();
  const startMs = useMemo(
    () => resolveTicketStartMs(createdAt, createdAtClientMs),
    [createdAt, createdAtClientMs]
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startMs == null) return;
    const timerId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timerId);
  }, [startMs]);
  return ticketAgeMs(startMs, now, clientAheadMs);
}

function TimeLapse({ elapsedMs, isLate }: { elapsedMs: number | null; isLate: boolean }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-lg font-mono", isLate ? "text-destructive font-semibold" : "text-amber-600")}>
      <Clock size={18} />
      <span>{elapsedMs == null ? "00:00:00" : formatDuration(elapsedMs)}</span>
    </div>
  );
}

const CANCELLATION_REASONS = ["Out of stock", "Customer request", "Incorrect order"];

export interface ServeBatchPayload {
  ticketId: string;
  sessionId: string;
  qtyToServe: number;
}

export interface CancelRemainingPayload {
  ticketId: string;
  sessionId: string;
  reason: string;
}

interface KdsItemCardProps {
    ticket: KitchenTicket;
    onUpdateStatus: (
      ticketId: string,
      sessionId: string,
      newStatus: "served" | "cancelled",
      reason?: string,
      opts?: { source?: "online" },
    ) => void;
    onServeBatch?: (payload: ServeBatchPayload) => void;
    onCancelRemaining?: (payload: CancelRemainingPayload) => void;
    slaMinutes?: number;
}

export function KdsItemCard({ ticket, onUpdateStatus, onServeBatch, onCancelRemaining, slaMinutes = DEFAULT_SLA_MINUTES }: KdsItemCardProps) {
    const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();
    const [serveBatchOpen, setServeBatchOpen] = useState(false);
    const [serveQtyInput, setServeQtyInput] = useState("1");
    const [showServeLog, setShowServeLog] = useState(false);

    const elapsedMs = useTicketAge(ticket.createdAt, ticket.createdAtClientMs ?? null);
    const isActiveTicket = ticket.status === 'preparing' || ticket.status === 'partially_served';
    const isLate = isActiveTicket && elapsedMs != null && elapsedMs >= slaMinutes * 60000;

    // Weight/measured items (e.g. "32.97 g" of side dishes) are ONE serving, not
    // a 32.97-count batch — otherwise serving decrements fractionally and float
    // residue (0.9699…) never reaches zero. Detect a weight uom or a non-integer
    // qty and serve the whole thing in one tap.
    const isWeightUom = !!ticket.uom && /^(kg|g|gram|grams|ml|l|liter|litre)$/i.test(ticket.uom.trim());
    const isMeasuredItem = isWeightUom || (ticket.qtyOrdered != null && !Number.isInteger(ticket.qtyOrdered));
    const isBatchTicket = !isMeasuredItem && ticket.qtyOrdered != null && ticket.qtyOrdered > 1;
    const qtyOrdered = ticket.qtyOrdered ?? ticket.qty ?? 1;
    const qtyServed = ticket.qtyServed ?? 0;
    const qtyCancelled = ticket.qtyCancelled ?? 0;
    const qtyRemaining = ticket.qtyRemaining ?? (qtyOrdered - qtyServed - qtyCancelled);
    const serveLog = ticket.serveLog ?? [];

    const isAlaCarte = ticket.sessionMode === 'alacarte';
    const isPackage = ticket.type === 'package';
    const isOnline = !!ticket.onlineOrderId;
    const tableLabel = isOnline
        ? (ticket.customerName || "Online Order")
        : isAlaCarte
        ? (ticket.sessionLabel ?? (ticket.customerName || "Ala Carte"))
        : ((ticket as any).tableDisplayName || ticket.sessionLabel || `Table ${ticket.tableNumber}`);
    const paxCount = Number((ticket as any).guestCount ?? 0);
    const identifier = !isAlaCarte && paxCount > 0
        ? `${tableLabel} (${paxCount} pax)`
        : tableLabel;

    const handleCancel = async (reason: string) => {
        if (!reason) return;
        const confirmed = await confirm({
            title: `Cancel Item: ${ticket.itemName}?`,
            description: `Reason: ${reason}. This cannot be undone.`,
            confirmText: "Yes, Cancel Item",
            destructive: true,
        });
        cleanupRadixOverlays();
        if (confirmed) onUpdateStatus(ticket.id, ticket.sessionId || ticket.onlineOrderId!, "cancelled", reason, isOnline ? { source: "online" } : undefined);
    };

    const handleCancelRemaining = async (reason: string) => {
        if (!ticket.sessionId) return;
        if (!reason) return;
        const confirmed = await confirm({
            title: `Cancel remaining ${qtyRemaining} of ${ticket.itemName}?`,
            description: `Reason: ${reason}. ${qtyServed} already served will remain served.`,
            confirmText: "Yes, Cancel Remaining",
            destructive: true,
        });
        cleanupRadixOverlays();
        if (confirmed) {
            if (onCancelRemaining) onCancelRemaining({ ticketId: ticket.id, sessionId: ticket.sessionId ?? "", reason });
            else onUpdateStatus(ticket.id, ticket.sessionId ?? "", "cancelled", reason);
        }
    };

    const handleServeBatchConfirm = () => {
        if (!ticket.sessionId) return;
        const qty = parseInt(serveQtyInput, 10);
        if (isNaN(qty) || qty <= 0 || qty > qtyRemaining) return;
        if (onServeBatch) onServeBatch({ ticketId: ticket.id, sessionId: ticket.sessionId ?? "", qtyToServe: qty });
        setServeBatchOpen(false);
        setServeQtyInput("1");
    };

    const openServeBatch = () => {
        setServeQtyInput(String(qtyRemaining));
        setServeBatchOpen(true);
    };

    const statusColor = ticket.status === 'served'
        ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
        : ticket.status === 'cancelled'
        ? 'bg-gray-50 dark:bg-gray-900/20 border-gray-200'
        : isLate
        ? 'border-destructive border-2 bg-destructive/5'
        : isOnline
        ? 'bg-gradient-to-br from-green-50 to-white dark:from-green-950/40 dark:to-background border-green-300 dark:border-green-800'
        : '';

    return (
        <>
            <Card className={cn("flex flex-col", statusColor)}>
                <CardHeader className="p-4 pb-2">
                    <div className="flex justify-between items-center gap-2">
                        <p className={cn("text-2xl font-bold truncate", isOnline ? "text-green-700 dark:text-green-400" : "text-destructive")}>{identifier}</p>
                        <div className="flex items-center gap-2 shrink-0">
                            {isLate && (
                                <Badge variant="destructive" className="gap-1 animate-pulse">
                                    <AlarmClock className="h-3.5 w-3.5" /> Late
                                </Badge>
                            )}
                            <TimeLapse elapsedMs={elapsedMs} isLate={isLate} />
                        </div>
                    </div>
                    {isOnline && (
                        <Badge className="mt-1.5 w-fit gap-1 bg-green-600 text-white hover:bg-green-600">
                            ● Online
                        </Badge>
                    )}
                    {/* Flavor reads inline with the meat — "Pork - Bulgogi" — now that
                        a refill carries exactly one flavor. Keeps the Notes block for
                        the guest's own text only. */}
                    <CardTitle className="text-xl leading-tight">
                        {ticket.itemName}
                        {(ticket as any).flavorNote && (
                          <span className="text-amber-700"> - {(ticket as any).flavorNote}</span>
                        )}
                    </CardTitle>
                    {(ticket as any).modifiersText && (
                      <p className="text-sm text-muted-foreground -mt-1 italic">
                        — {(ticket as any).modifiersText}
                      </p>
                    )}

                    {/* Qty progress for batch tickets */}
                    {isBatchTicket && (
                        <div className="mt-2 space-y-1.5">
                            <div className="flex gap-3 text-sm flex-wrap">
                                <span className="font-semibold">Ord: <span className="text-foreground">{qtyOrdered}</span></span>
                                <span className="text-green-700 font-semibold">Srv: {qtyServed}</span>
                                {qtyCancelled > 0 && <span className="text-destructive font-semibold">Cxl: {qtyCancelled}</span>}
                                {qtyRemaining > 0 && <span className="text-amber-600 font-semibold">Rem: {qtyRemaining}</span>}
                            </div>
                            <div className="w-full h-2 bg-muted rounded-full overflow-hidden flex">
                                <div className="bg-green-500 h-full transition-all" style={{ width: `${(qtyServed/qtyOrdered)*100}%` }} />
                                <div className="bg-destructive h-full transition-all" style={{ width: `${(qtyCancelled/qtyOrdered)*100}%` }} />
                            </div>
                        </div>
                    )}
                </CardHeader>

                <CardContent className="flex-grow space-y-2 p-4 pt-0">
                    {ticket.type === 'refill' && (ticket as any).refillRequest && (
                        <div className="space-y-1">
                            {Object.entries((ticket as any).refillRequest as Record<string, any>)
                              .filter(([, v]) => Number(v || 0) > 0)
                              .map(([k, v]) => (
                                <p key={k} className="text-lg font-semibold">{String(k).replace(/_/g, " ")} {Number(v)}</p>
                              ))}
                        </div>
                    )}
                    {ticket.initialFlavorNames && ticket.initialFlavorNames.length > 0 && (
                        <div className="text-sm flex items-baseline gap-1.5 flex-wrap">
                            <span className="font-semibold">Flv:</span>
                            {ticket.initialFlavorNames.map(name => <Badge key={name} variant="secondary" className="text-xs px-2 py-0.5">{name}</Badge>)}
                        </div>
                    )}
                    {ticket.notes && (
                        <div className="text-sm p-2 bg-yellow-50 border border-yellow-200 rounded dark:bg-yellow-900/20 dark:border-yellow-800">
                            <p className="font-semibold flex items-center gap-1"><Info size={14}/> Notes</p>
                            <p className="text-muted-foreground pl-1">{ticket.notes}</p>
                        </div>
                    )}

                    {/* Serve log */}
                    {serveLog.length > 0 && (
                        <div>
                            <button onClick={() => setShowServeLog(v => !v)} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
                                {showServeLog ? <ChevronUp size={10}/> : <ChevronDown size={10}/>}
                                Log ({serveLog.length})
                            </button>
                            {showServeLog && (
                                <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground border rounded p-1.5">
                                    {serveLog.map((log, i) => (
                                        <div key={i} className="flex justify-between">
                                            <span>#{i+1}: <strong className="text-green-700">{log.qty}</strong></span>
                                            <span>{log.servedAtClientMs ? format(new Date(log.servedAtClientMs), 'HH:mm') : ''}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </CardContent>

                <CardFooter className="flex justify-between items-center gap-2 p-4 pt-2 flex-wrap">
                    <div>
                        {ticket.status === 'served' ? (
                            <Badge variant="default" className="bg-green-600 whitespace-nowrap text-sm px-2.5 py-0.5"><CheckCircle className="h-4 w-4 mr-1" />Served</Badge>
                        ) : ticket.status === 'cancelled' ? (
                            <Badge variant="destructive" className="text-sm px-2.5 py-0.5">Cancelled</Badge>
                        ) : (
                            <Badge variant="outline" className="capitalize text-sm px-2.5 py-0.5">{ticket.status}</Badge>
                        )}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap justify-end">
                        {(ticket.status === 'preparing' || ticket.status === 'partially_served') && (
                            <>
                                {/* Cancel — full cancel or cancel remaining */}
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="destructive" className="h-11 px-4 text-base">
                                            <XCircle className="h-5 w-5 mr-1.5" /> {qtyServed > 0 ? 'Cancel Rem' : 'Cancel'}
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent>
                                        {CANCELLATION_REASONS.map(reason => (
                                            <DropdownMenuItem key={reason} onSelect={() =>
                                                qtyServed > 0 ? handleCancelRemaining(reason) : handleCancel(reason)
                                            }>
                                                {reason}
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>

                                {/* Serve button */}
                                {isBatchTicket ? (
                                    <Button className="h-11 px-4 text-base" onClick={openServeBatch}>
                                        <Send className="h-5 w-5 mr-1.5" /> Serve ({qtyRemaining})
                                    </Button>
                                ) : (
                                    <Button className="h-11 px-4 text-base" onClick={() => onUpdateStatus(ticket.id, ticket.sessionId || ticket.onlineOrderId!, 'served', undefined, isOnline ? { source: "online" } : undefined)}>
                                        <Send className="h-5 w-5 mr-1.5" /> Served
                                    </Button>
                                )}
                            </>
                        )}
                    </div>
                </CardFooter>
            </Card>

            {/* Batch serve modal */}
            <Dialog open={serveBatchOpen} onOpenChange={setServeBatchOpen}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Serve: {ticket.itemName}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <p className="text-sm text-muted-foreground text-center">{qtyRemaining} remaining · {qtyServed} already served</p>
                        <div className="space-y-2">
                            <Label htmlFor="serve-qty" className="text-center block">Qty to serve now</Label>
                            <div className="flex items-center justify-center gap-3">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    className="h-12 w-12 rounded-full shrink-0"
                                    disabled={parseInt(serveQtyInput, 10) <= 1 || isNaN(parseInt(serveQtyInput, 10))}
                                    onClick={() => {
                                        const cur = parseInt(serveQtyInput, 10);
                                        if (!isNaN(cur) && cur > 1) setServeQtyInput(String(cur - 1));
                                    }}
                                >
                                    <Minus className="h-5 w-5" />
                                </Button>
                                <span className="text-4xl font-bold tabular-nums w-16 text-center select-none">{serveQtyInput || "0"}</span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    className="h-12 w-12 rounded-full shrink-0"
                                    disabled={parseInt(serveQtyInput, 10) >= qtyRemaining}
                                    onClick={() => {
                                        const cur = parseInt(serveQtyInput, 10);
                                        if (!isNaN(cur) && cur < qtyRemaining) setServeQtyInput(String(cur + 1));
                                    }}
                                >
                                    <Plus className="h-5 w-5" />
                                </Button>
                            </div>
                            {qtyRemaining > 1 && (
                                <div className="flex justify-center gap-2 pt-1">
                                    <Button variant="ghost" size="sm" className="text-xs h-7 px-3" onClick={() => setServeQtyInput("1")}>1</Button>
                                    {qtyRemaining >= 3 && <Button variant="ghost" size="sm" className="text-xs h-7 px-3" onClick={() => setServeQtyInput(String(Math.ceil(qtyRemaining / 2)))}>Half</Button>}
                                    <Button variant="ghost" size="sm" className="text-xs h-7 px-3" onClick={() => setServeQtyInput(String(qtyRemaining))}>All ({qtyRemaining})</Button>
                                </div>
                            )}
                        </div>
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => setServeBatchOpen(false)}>Cancel</Button>
                        <Button
                            onClick={handleServeBatchConfirm}
                            disabled={isNaN(parseInt(serveQtyInput,10)) || parseInt(serveQtyInput,10) <= 0 || parseInt(serveQtyInput,10) > qtyRemaining}
                        >
                            <Send className="mr-2"/> Confirm Serve
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {ConfirmDialog}
        </>
    );
}
