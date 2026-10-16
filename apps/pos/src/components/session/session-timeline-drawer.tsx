

"use client";

import { useState, useEffect, useMemo } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { db } from "@/lib/firebase/client";
import { collection, doc, onSnapshot, query, orderBy, limit, getDocs } from "firebase/firestore";
import { Loader, User, Clock, Package, Users, Utensils, CreditCard, Scissors, Gift, Tag, Ban, ArrowRightLeft, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { format, formatDistanceToNow } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toJsDate } from "@/lib/utils/date";
import { describeActivityLog } from "@/lib/logs/describe-log";
import { actorLabel, collectLocalActorNames, resolveStaffNames, type ActorNameMap } from "@/lib/session-timeline/actors";

interface SessionTimelineDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string;
  sessionId: string;
}

type TimelineEvent = {
  id: string;
  timestamp: Date;
  type: string;
  description: string;
  actorUid?: string;
  actorName?: string;
  serverProfileName?: string | null;
  detail?: string;
};

export function SessionTimelineDrawer({ open, onOpenChange, storeId, sessionId }: SessionTimelineDrawerProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  // Names carried by the events themselves (activity logs, serve stamps) —
  // free, and enough for most actors. See lib/session-timeline/actors.
  const [localNames, setLocalNames] = useState<ActorNameMap>(() => new Map());
  const [staffNames, setStaffNames] = useState<ActorNameMap>(() => new Map());

  const actorUids = useMemo(() => {
    return [...new Set(events.map(e => e.actorUid).filter(Boolean) as string[])];
  }, [events]);

  // Anything the events could not name themselves gets one chunked staff lookup,
  // shared process-wide so reopening the drawer costs nothing.
  useEffect(() => {
    const missing = actorUids.filter((uid) => !localNames.has(uid));
    if (missing.length === 0) return;
    let cancelled = false;
    resolveStaffNames(missing)
      .then((resolved) => { if (!cancelled && resolved.size) setStaffNames((prev) => new Map([...prev, ...resolved])); })
      .catch(() => {/* tier 3 renders a shortened uid */});
    return () => { cancelled = true; };
  }, [actorUids, localNames]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);

    const sessionRef = doc(db, "stores", storeId, "sessions", sessionId);
    const ticketsRef = collection(db, "stores", storeId, "sessions", sessionId, "kitchentickets");
    const activityLogsRef = collection(db, "stores", storeId, "sessions", sessionId, "activityLogs");
    const activityQuery = query(activityLogsRef, orderBy("createdAt", "desc"), limit(200));

    const processAndSetEvents = (
        sessionData: any,
        ticketsData: any[],
        activityLogsData: any[]
    ) => {
        let allEvents: (TimelineEvent | null)[] = [];

        // 1. Session Start — enhanced with mode, package, guest count
        if (sessionData?.startedAt) {
            const mode = sessionData.sessionMode === 'alacarte' ? 'Ala Carte' : 'Package Dine-in';
            const pkg = sessionData.packageSnapshot?.name;
            const guests = sessionData.guestCountCashierInitial;
            let desc = `Session started (${mode})`;
            let detail = [
              pkg ? `Package: ${pkg}` : null,
              guests ? `Initial guests: ${guests}` : null,
              sessionData.customerName || sessionData.customer?.name ? `Customer: ${sessionData.customerName || sessionData.customer?.name}` : null,
            ].filter(Boolean).join(" · ");
            allEvents.push({
                id: `${sessionId}-start`,
                timestamp: toJsDate(sessionData.startedAt)!,
                type: 'session',
                description: desc,
                detail: detail || undefined,
                actorUid: sessionData.startedByUid,
            });
        }
        if (sessionData?.verifiedAt) {
             allEvents.push({
                id: `${sessionId}-verified`,
                timestamp: toJsDate(sessionData.verifiedAt)!,
                type: 'session',
                description: `Session verified — ${sessionData.guestCountServerVerified ?? sessionData.guestCountFinal ?? "?"} guests confirmed`,
                actorUid: sessionData.verifiedByUid,
            });
        }

        // 2. Guest Count & Package Changes
        const { guestCountChange, packageChange } = sessionData ?? {};
        if (guestCountChange?.requestedAt) {
             allEvents.push({
                id: `${sessionId}-gc-req`,
                timestamp: toJsDate(guestCountChange.requestedAt)!,
                type: 'change_request',
                description: `Guest count change requested → ${guestCountChange.requestedCount}`,
                detail: guestCountChange.previousCount != null ? `Was ${guestCountChange.previousCount}` : undefined,
                actorUid: guestCountChange.requestedByUid,
            });
        }
        if (guestCountChange?.approvedAt) {
             allEvents.push({
                id: `${sessionId}-gc-approve`,
                timestamp: toJsDate(guestCountChange.approvedAt)!,
                type: 'change_approval',
                description: `Guest count change approved → ${sessionData.guestCountFinal}`,
                actorUid: guestCountChange.approvedByUid,
            });
        }
        if (guestCountChange?.rejectedAt) {
            allEvents.push({
               id: `${sessionId}-gc-reject`,
               timestamp: toJsDate(guestCountChange.rejectedAt)!,
               type: 'change_rejection',
               description: `Guest count change request rejected`,
               actorUid: guestCountChange.rejectedByUid,
           });
       }
        if (packageChange?.requestedAt) {
             allEvents.push({
                id: `${sessionId}-pkg-req`,
                timestamp: toJsDate(packageChange.requestedAt)!,
                type: 'change_request',
                description: `Package change requested → "${packageChange.requestedPackageSnapshot?.name}"`,
                actorUid: packageChange.requestedByUid,
            });
        }
        if (packageChange?.approvedAt) {
             allEvents.push({
                id: `${sessionId}-pkg-approve`,
                timestamp: toJsDate(packageChange.approvedAt)!,
                type: 'change_approval',
                description: `Package changed to "${sessionData?.packageSnapshot?.name}"`,
                actorUid: packageChange.approvedByUid,
            });
        }
        if (packageChange?.rejectedAt) {
            allEvents.push({
                id: `${sessionId}-pkg-reject`,
                timestamp: toJsDate(packageChange.rejectedAt)!,
                type: 'change_rejection',
                description: `Package change request rejected`,
                actorUid: packageChange.rejectedByUid,
            });
        }

        // 3. Kitchen Tickets — with qty for batch items
        ticketsData.forEach(ticket => {
            const isRefill = ticket.type === 'refill';
            const qtyLabel = (ticket.qtyOrdered ?? ticket.qty ?? 1) > 1 ? ` (${ticket.qtyOrdered ?? ticket.qty}x)` : "";
            if (ticket.createdAt) allEvents.push({
                id: `${ticket.id}-created`,
                timestamp: toJsDate(ticket.createdAt)!,
                type: isRefill ? 'refill_order' : 'kitchen',
                description: `${isRefill ? 'Refill ordered' : 'Order sent'}: ${ticket.itemName}${qtyLabel}`,
                actorUid: ticket.createdByUid
            });
            if (ticket.servedAt) allEvents.push({
                id: `${ticket.id}-served`,
                timestamp: toJsDate(ticket.servedAt)!,
                type: 'kitchen',
                description: `${ticket.itemName} served${qtyLabel}`,
                actorUid: ticket.servedByUid
            });
            if (ticket.cancelledAt) allEvents.push({
                id: `${ticket.id}-cancelled`,
                timestamp: toJsDate(ticket.cancelledAt)!,
                type: 'void',
                description: `${ticket.itemName} cancelled`,
                detail: ticket.cancelReason ? `Reason: ${ticket.cancelReason}` : undefined,
                actorUid: ticket.cancelledByUid
            });
            // Batch serve logs
            if (Array.isArray(ticket.serveLog)) {
              ticket.serveLog.forEach((entry: any, i: number) => {
                if (entry.servedAt) {
                  allEvents.push({
                    id: `${ticket.id}-serve-${i}`,
                    timestamp: toJsDate(entry.servedAt)!,
                    type: 'kitchen',
                    // `qty`, not `qtyServed` — that is the field handleServeBatch
                    // writes, and reading the wrong one rendered "Served ?x".
                    description: `Served ${entry.qty ?? "?"}x ${ticket.itemName}`,
                    actorUid: entry.servedByUid,
                    serverProfileName: entry.servedByProfileName ?? null,
                  });
                }
              });
            }
        });

        // 4. Activity Logs — voids, discounts, free, adjustments
        activityLogsData.forEach(log => {
            const result = describeActivityLog(log);
            // The session-document walk above already rendered these, with more
            // context than the log carries.
            if (result.redundantWithSessionDoc) return;
            const ts = toJsDate(log.createdAt);
            if (!ts) return;
            allEvents.push({
                id: log.id,
                timestamp: ts,
                type: result.type,
                description: result.title,
                detail: result.detail,
                actorUid: log.actorUid || log.user?.uid,
                actorName: log.actorName || log.user?.name,
                serverProfileName: log.serverProfileName ?? null,
            });
        });

        // 6. Session closed
        if (sessionData?.closedAt) {
            const totals = sessionData.receiptSnapshot ?? {};
            let detail = [
              totals.grandTotal != null ? `Grand Total: ₱${Number(totals.grandTotal).toFixed(2)}` : null,
              totals.change != null && totals.change > 0 ? `Change: ₱${Number(totals.change).toFixed(2)}` : null,
            ].filter(Boolean).join(" · ");
            allEvents.push({
                id: `${sessionId}-closed`,
                timestamp: toJsDate(sessionData.closedAt)!,
                type: 'session',
                description: `Session closed — billed ${sessionData.guestCountFinal ?? "?"} guests`,
                detail: detail || undefined,
                actorUid: sessionData.closedByUid,
            });
        }

        const validEvents = allEvents.filter(event => event !== null && event.timestamp instanceof Date) as TimelineEvent[];
        validEvents.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        setEvents(validEvents);
        setLocalNames(collectLocalActorNames({
          session: sessionData as any,
          tickets: ticketsData as any,
          activityLogs: activityLogsData as any,
        }));
        setLoading(false);
    };

    const unsubSession = onSnapshot(sessionRef, async (sessionSnap) => {
        const sessionData = sessionSnap.data({ serverTimestamps: "estimate" });

        const [ticketsSnap, activitySnap] = await Promise.all([
            getDocs(ticketsRef),
            getDocs(activityQuery),
        ]);

        const ticketsData = ticketsSnap.docs.map(d => ({id: d.id, ...d.data()}));
        const activityData = activitySnap.docs.map(d => ({id: d.id, ...d.data()}));

        processAndSetEvents(sessionData, ticketsData, activityData);
    });

    return () => {
      unsubSession();
    };
  }, [open, storeId, sessionId]);

  const getBadgeVariant = (type: string): "default" | "secondary" | "outline" | "destructive" => {
    switch(type) {
        case 'session': return 'default';
        case 'kitchen': return 'secondary';
        case 'refill_order': return 'secondary';
        case 'payment': return 'default';
        case 'change_request': return 'outline';
        case 'change_approval': return 'default';
        case 'change_rejection': return 'destructive';
        case 'void': return 'destructive';
        case 'free': return 'default';
        case 'discount': return 'outline';
        case 'adjustment': return 'outline';
        case 'billing': return 'outline';
        default: return 'secondary';
    }
  };

  const getBadgeClassName = (type: string) => {
    switch(type) {
      case 'void': return 'bg-red-100 text-red-700 border-red-200';
      case 'free': return 'bg-green-100 text-green-700 border-green-200';
      case 'discount': return 'bg-amber-100 text-amber-700 border-amber-200';
      default: return '';
    }
  };

  const getIcon = (type: string) => {
    switch(type) {
        case 'session': return <Users className="h-4 w-4" />;
        case 'kitchen': return <Utensils className="h-4 w-4" />;
        case 'refill_order': return <Utensils className="h-4 w-4" />;
        case 'change_request': return <ArrowRightLeft className="h-4 w-4" />;
        case 'change_approval': return <Package className="h-4 w-4" />;
        case 'change_rejection': return <Ban className="h-4 w-4" />;
        case 'payment': return <CreditCard className="h-4 w-4" />;
        case 'void': return <Scissors className="h-4 w-4" />;
        case 'free': return <Gift className="h-4 w-4" />;
        case 'discount': return <Tag className="h-4 w-4" />;
        case 'adjustment': return <FileText className="h-4 w-4" />;
        case 'billing': return <FileText className="h-4 w-4" />;
        default: return <Clock className="h-4 w-4" />;
    }
  };

  const getDotColor = (type: string) => {
    switch (type) {
      case 'void': return 'border-red-500 bg-red-50';
      case 'free': return 'border-green-500 bg-green-50';
      case 'discount': return 'border-amber-500 bg-amber-50';
      case 'payment': return 'border-blue-500 bg-blue-50';
      default: return 'border-primary bg-background';
    }
  };

  const getLabel = (type: string) => {
    switch(type) {
      case 'session': return 'Session';
      case 'kitchen': return 'Kitchen';
      case 'refill_order': return 'Refill';
      case 'change_request': return 'Request';
      case 'change_approval': return 'Approved';
      case 'change_rejection': return 'Rejected';
      case 'payment': return 'Payment';
      case 'void': return 'Void';
      case 'free': return 'Free';
      case 'discount': return 'Discount';
      case 'adjustment': return 'Adjustment';
      case 'billing': return 'Billing';
      default: return type;
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[440px] sm:w-[540px] flex flex-col">
        <SheetHeader>
          <SheetTitle>Session Timeline</SheetTitle>
          <SheetDescription>Audit trail for session {sessionId?.substring(0,6)}.</SheetDescription>
        </SheetHeader>
        {loading ? (
          <div className="flex-grow flex items-center justify-center">
            <Loader className="animate-spin" />
          </div>
        ) : (
          <ScrollArea className="flex-grow">
            <div className="pr-4">
              {events.map((event, index) => (
                <div key={`${event.id}-${index}`} className="relative pl-8 py-3 group">
                    {/* Vertical line */}
                    <div className="absolute left-3 top-0 h-full w-px bg-border"></div>

                    {/* Dot on the line */}
                    <div className={`absolute left-3 top-[18px] -translate-x-1/2 w-2.5 h-2.5 border-2 rounded-full z-10 ${getDotColor(event.type)}`}></div>

                    <div className="flex items-center justify-between gap-2">
                         <div className="flex items-center gap-1.5 min-w-0">
                            <Badge variant={getBadgeVariant(event.type)} className={`text-[10px] px-1.5 py-0 shrink-0 ${getBadgeClassName(event.type)}`}>
                              {getLabel(event.type)}
                            </Badge>
                            <p className="text-[10px] text-muted-foreground flex items-center gap-0.5 shrink-0">
                                <Clock size={10} />
                                {format(event.timestamp, "HH:mm:ss")}
                            </p>
                         </div>
                         <p className="text-[10px] text-muted-foreground shrink-0">
                            {formatDistanceToNow(event.timestamp, { addSuffix: true })}
                         </p>
                    </div>

                    <p className="text-sm mt-1">{event.description}</p>
                    {event.detail && (
                      <p className="text-xs text-muted-foreground mt-0.5">{event.detail}</p>
                    )}

                    {(() => {
                      if (!event.actorUid && !event.actorName && !event.serverProfileName) return null;
                      const actor = actorLabel(
                        event.actorUid,
                        [localNames, staffNames],
                        event.serverProfileName || event.actorName
                      );
                      return (
                        <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
                            <User size={10} />
                            <span title={actor.resolved ? undefined : actor.uid ?? undefined}>{actor.name}</span>
                        </div>
                      );
                    })()}
                </div>
              ))}
              {events.length === 0 && (
                <p className="text-center text-muted-foreground py-8 text-sm">No events found.</p>
              )}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
