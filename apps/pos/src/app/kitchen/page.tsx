
"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  collection, query, where, onSnapshot, doc, writeBatch, setDoc, serverTimestamp, Timestamp, collectionGroup, getDocs, getDoc, runTransaction, updateDoc, increment, orderBy, getCountFromServer, limit, startAfter, type QueryDocumentSnapshot, type DocumentSnapshot, type DocumentData, type Transaction, type QuerySnapshot,
  arrayRemove, deleteField
} from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { PageHeader } from "@/components/page-header";
import { KdsView } from "@/components/kitchen/kds-view";
import { DEFAULT_SLA_MINUTES } from "@/components/kitchen/kds-item-card";
import { HistoryView } from "@/components/kitchen/history-view";
import { useAuthContext } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { useLocalProfile } from "@/context/local-profile-context";
import { db } from "@/lib/firebase/client";
import { Loader, Send, History } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { SessionTimelineDrawer } from "@/components/session/session-timeline-drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { stripUndefined } from "@/lib/firebase/utils";
import { buildCustomerOrderBillLine, pendingBillLineFor, shouldVoidBilledQty } from "@/lib/kitchen/customer-order-billing";
import { servedQtyFields } from '@/lib/kitchen/served-qty';
import type { KitchenTicket, OrderItemStatus, RtKdsStationDoc, DailyMetric } from "@/lib/types";
import { computeSessionLabel } from "@/lib/utils/session";
import { toJsDate } from "@/lib/utils/date";
import { Badge } from "@/components/ui/badge";
import { applyKdsTicketDelta } from "@/lib/analytics/applyKdsTicketDelta";
import { applyKdsDeltaServerFirst } from "@/lib/analytics/applyKdsDeltaServerFirst";
import { computeKdsTargets } from "@/lib/analytics/kdsTargets";
import { cn } from "@/lib/utils";
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";
import { SyncKdsTicketsTool } from "@/components/kitchen/SyncKdsTicketsTool";

export type KitchenStation = {
    id: string;
    name: string;
    key: string;
    sortOrder?: number;
    isActive?: boolean;
    slaMinutes?: number;
};

type Session = {
    id: string;
    initialFlavorIds?: string[];
    customerName?: string | null;
    tableNumber?: string | null;
    tableDisplayName?: string | null;
    sessionMode?: 'package_dinein' | 'alacarte';
    guestCountFinal?: number | null;
    guestCountCashierInitial?: number;
};

type Flavor = {
    id: string;
    name: string;
};

type HistoryPreviewItem = {
    id: string;
    sessionLabel: string;
    tableNumber?: string | null;
    customerName?: string | null;
    itemName: string;
    qty: number;
    status: OrderItemStatus;
    closedAtClientMs: number;
    durationMs: number;
};


import { formatDuration } from "@/lib/utils/date";
import { resolveTicketStartMs, serverNowMs } from "@/lib/kitchen/server-clock";
import { useServerClockOffset } from "@/hooks/use-server-clock";
import { KdsFlashOverlay } from "@/components/kitchen/kds-flash-overlay";
import { writeActivityLog } from "@/components/cashier/activity-log";
import {
  fireKitchenAlert,
  primeKitchenAudio,
  requestKitchenAlertPermission,
} from "@/lib/notifications/kitchenAlert";
import { AssistanceAlerts } from "@/components/kitchen/AssistanceAlerts";

export default function KitchenPage() {
  const { appUser, user, isSigningOut } = useAuthContext();
  const { activeStore } = useStoreContext();
  const { currentProfile } = useLocalProfile();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const processedStoresRef = useRef(new Set<string>());

  const [stations, setStations] = useState<KitchenStation[]>([]);
  // Single source of truth for every station's rtKdsTickets doc. One
  // collection listener populates this Map. Both `stationCounts` (tab badges)
  // and `stationDoc` (active station) derive from it via useMemo, so the
  // page only opens ONE listener on rtKdsTickets instead of two overlapping
  // ones.
  const [stationsAllDocs, setStationsAllDocs] = useState<Map<string, RtKdsStationDoc>>(new Map());
  const [stationsAllDocsLoaded, setStationsAllDocsLoaded] = useState(false);
  const [tickets, setTickets] = useState<KitchenTicket[]>([]);
  const [sessionsMap, setSessionsMap] = useState<Map<string, Session>>(new Map());
  const [flavorsMap, setFlavorsMap] = useState<Map<string, string>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const prevTicketIdsRef = useRef(new Set());
  const didInitTicketsRef = useRef(false);
  // Ticket ids we've already attempted to auto-acknowledge (see the
  // printedOffline effect below). Guards against re-firing the serve call on
  // every rtKdsTickets snapshot — each ticket is only ever auto-served once
  // per page session.
  const autoAckedTicketIdsRef = useRef(new Set<string>());
  // Per-ticket failure counter for the silent auto-ack path. Bounds retries so
  // a permanently-failing ticket (e.g. bad data, permission issue) doesn't spam
  // transactions forever — it stops retrying after 3 failed attempts and gives
  // up. The ticket stays `printedOffline` and therefore remains excluded from
  // the rendered queue/tab badges (see the `printedOffline` filters below); it
  // is NOT surfaced for manual serve in the KDS. That's acceptable because the
  // kitchen already has the printed paper ticket from the outage, so no order
  // is missed — see the one-time give-up toast fired below for visibility.
  const autoAckFailureCountRef = useRef(new Map<string, number>());
  // Ticket ids we've already fired the give-up toast for, so a permanently
  // stuck ticket alerts the kitchen once (not on every stationsAllDocs
  // snapshot re-scan).
  const autoAckGaveUpAlertedRef = useRef(new Set<string>());

  const [flash, setFlash] = useState<{ type: "served" | "cancelled"; message: string; subtitle?: string } | null>(null);
  const showFlash = useCallback((type: "served" | "cancelled", message: string, subtitle?: string) => {
    setFlash({ type, message, subtitle });
  }, []);

  useEffect(() => {
    void requestKitchenAlertPermission();
    // Prime the Web Audio beep on the first user gesture so browser autoplay
    // policy lets us play sounds later. On native platforms this is a no-op.
    const unlock = () => {
      primeKitchenAudio();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  const [timelineSessionId, setTimelineSessionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("");
  const stationCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, d] of stationsAllDocs) {
      const map = d.tickets || {};
      // Offline-printed tickets are auto-acknowledged (see the printedOffline
      // effect below) and must not count toward the tab's active badge, even
      // in the brief window before their serve transaction lands.
      const count = (d.activeIds || []).filter((tid) => !map[tid]?.printedOffline).length;
      m.set(id, count);
    }
    return m;
  }, [stationsAllDocs]);
  const stationDoc = useMemo<RtKdsStationDoc | null>(() => {
    if (!activeTab) return null;
    return stationsAllDocs.get(activeTab) ?? null;
  }, [stationsAllDocs, activeTab]);

  // Coarse clock (20s) to drive the per-station "over SLA" tab counters without
  // a per-second re-render of the whole page. Individual ticket cards keep
  // their own 1s ticker for the live timer.
  // How far this tablet's clock is from the server's. Every age, SLA check and
  // duration below is measured in server time, so a drifting device cannot
  // inflate kitchen timers or the serve durations they get written into.
  const clientAheadMs = useServerClockOffset();

  const [slaTick, setSlaTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setSlaTick(Date.now()), 20000);
    return () => clearInterval(id);
  }, []);

  const slaByStation = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stations) m.set(s.id, s.slaMinutes ?? DEFAULT_SLA_MINUTES);
    return m;
  }, [stations]);

  // Count active tickets at each station that have aged past its SLA.
  const overSlaByStation = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [stationId, d] of stationsAllDocs) {
      const slaMs = (slaByStation.get(stationId) ?? DEFAULT_SLA_MINUTES) * 60000;
      const map = d.tickets || {};
      const ids = d.activeIds?.length ? d.activeIds : Object.keys(map);
      let late = 0;
      for (const id of ids) {
        const t = map[id];
        if (!t) continue;
        // Offline-printed tickets are auto-acknowledged and excluded from the
        // "late" alerting count — the kitchen already worked from the printed
        // paper ticket during the outage.
        if (t.printedOffline) continue;
        const start = resolveTicketStartMs((t as any).createdAt, (t as any).createdAtClientMs);
        if (start != null && serverNowMs(clientAheadMs, slaTick) - start >= slaMs) late += 1;
      }
      if (late > 0) counts.set(stationId, late);
    }
    return counts;
  }, [stationsAllDocs, slaByStation, slaTick, clientAheadMs]);

  const activeStationSla = useMemo(
    () => slaByStation.get(activeTab) ?? DEFAULT_SLA_MINUTES,
    [slaByStation, activeTab],
  );

  const [dailyAnalytics, setDailyAnalytics] = useState<DailyMetric | null>(null);
  
  const [historyPreview, setHistoryPreview] = useState<HistoryPreviewItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const [historyCollapsed, setHistoryCollapsed] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("kds_history_collapsed") !== "false";
  });
  const toggleHistoryCollapsed = () => {
    setHistoryCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("kds_history_collapsed", String(next));
      return next;
    });
  };


  useEffect(() => {
    if (!activeStore) {
      setIsLoading(false);
      setTickets([]);
      setStations([]);
      return;
    }
    
    setIsLoading(true);
    const unsubs: (() => void)[] = [];

    const stationsRef = collection(db, "stores", activeStore.id, "kitchenLocations");
    unsubs.push(onSnapshot(query(stationsRef, where("isActive", "==", true)), (snapshot: QuerySnapshot<DocumentData>) => {
        const stationsData = snapshot.docs.map((docSnap: QueryDocumentSnapshot<DocumentData>) => ({ id: docSnap.id, key: docSnap.id, ...docSnap.data() } as KitchenStation));
        stationsData.sort((a: KitchenStation, b: KitchenStation) => (a.sortOrder ?? 1000) - (b.sortOrder ?? 1000));
        setStations(stationsData);
        if (stationsData.length > 0 && !activeTab) {
            setActiveTab(stationsData[0].id);
        }
    }));
    
    // Flavors are a global, admin-curated catalog that changes maybe once or
    // twice a year. A live subscription on every kitchen device is overkill —
    // do a single fetch at session start instead. If admin renames a flavor
    // mid-shift, devices pick it up on the next reload.
    void (async () => {
        try {
            const flavorsRef = collection(db, "flavors");
            const snap = await getDocs(query(flavorsRef, where("isActive", "==", true)));
            const newFlavorsMap = new Map<string, string>();
            snap.forEach((docSnap: QueryDocumentSnapshot<DocumentData>) => newFlavorsMap.set(docSnap.id, docSnap.data().name));
            setFlavorsMap(newFlavorsMap);
        } catch (e) {
            console.warn("[kitchen] failed to load flavors:", e);
        }
    })();

    const rtKdsTicketsRef = collection(db, 'stores', activeStore.id, 'rtKdsTickets');
    unsubs.push(onSnapshot(rtKdsTicketsRef, (snapshot) => {
        const m = new Map<string, RtKdsStationDoc>();
        snapshot.forEach((d) => m.set(d.id, d.data() as RtKdsStationDoc));
        setStationsAllDocs(m);
        setStationsAllDocsLoaded(true);
    }));

    return () => unsubs.forEach(unsub => unsub());
  }, [activeStore, appUser, activeTab]);
  
  useEffect(() => {
    if (!activeStore) {
      setDailyAnalytics(null);
      return;
    }
    const todayDayId = getDayIdFromTimestamp(new Date());
    const unsub = onSnapshot(doc(db, "stores", activeStore.id, "analytics", todayDayId), (docSnap) => {
      if (docSnap.exists()) {
        setDailyAnalytics(docSnap.data() as DailyMetric);
      } else {
        setDailyAnalytics(null);
      }
    });
    return () => unsub();
  }, [activeStore]);


  const activeStationName = useMemo(() => {
    return stations.find(s => s.id === activeTab)?.name || 'Station';
  }, [stations, activeTab]);

  // Effect to load sessions referenced by the active station's tickets, plus
  // fire the new-ticket alert. Re-runs when the derived `stationDoc` changes,
  // which is whenever the collection listener gets a new snapshot for the
  // active station. No extra listener is needed — `stationDoc` is a useMemo
  // off `stationsAllDocs`.
  useEffect(() => {
    if (!activeStore || !activeTab) {
        setIsLoading(false);
        return;
    }
    // Wait for the collection listener's first snapshot before we declare loading done.
    if (!stationsAllDocsLoaded) {
        setIsLoading(true);
        return;
    }

    const currentTickets = stationDoc?.tickets || {};

    // Device notification when new ticket appears (ignore first load).
    // Offline-printed tickets are excluded — the kitchen already handled them
    // on paper during the outage, so they must not trigger the "new ticket"
    // alert sound when they sync back in.
    const ids = Object.keys(currentTickets).filter((id) => !currentTickets[id]?.printedOffline);
    if (didInitTicketsRef.current) {
        const prev = prevTicketIdsRef.current;
        const hasNew = ids.some((id) => !prev.has(id));
        if (hasNew) {
            void fireKitchenAlert({
                title: "New Kitchen Ticket",
                body: `${activeStationName || "Station"}: ${ids.length} active`,
            });
        }
    } else {
        didInitTicketsRef.current = true;
    }
    prevTicketIdsRef.current = new Set(ids);

    const sessionIds = [...new Set(Object.values(currentTickets).map((t: any) => t.sessionId).filter(Boolean))];
    let cancelled = false;
    if (sessionIds.length > 0) {
        (async () => {
            try {
                const idChunks: string[][] = [];
                for (let i = 0; i < sessionIds.length; i += 30) {
                    idChunks.push(sessionIds.slice(i, i + 30));
                }
                const newSessionsMap = new Map<string, Session>();
                for (const chunk of idChunks) {
                    if (chunk.length === 0) continue;
                    const sessionsQuery = query(collection(db, `stores/${activeStore.id}/sessions`), where("id", "in", chunk));
                    const sessionsSnap = await getDocs(sessionsQuery);
                    sessionsSnap.forEach((sDoc: QueryDocumentSnapshot<DocumentData>) => {
                        newSessionsMap.set(sDoc.id, { id: sDoc.id, ...sDoc.data() } as Session);
                    });
                }
                if (!cancelled) {
                    setSessionsMap(prev => new Map([...prev, ...newSessionsMap]));
                }
            } catch (error: any) {
                if (cancelled || isSigningOut || !appUser) return;
                console.error("Error fetching sessions for kitchen tickets:", error);
                toast({ variant: "destructive", title: "Error", description: error?.message || "Could not fetch session data." });
            }
        })();
    }
    setIsLoading(false);
    return () => { cancelled = true; };
    // activeStationName intentionally not in deps; the closure picks up the
    // latest value via lexical scope, and refreshing the effect just to update
    // the alert body string isn't worth the extra runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStore, activeTab, stationDoc, stationsAllDocsLoaded, toast, isSigningOut, appUser]);
  
  useEffect(() => {
    if (!activeStore || !activeTab) {
      setHistoryPreview([]);
      setIsLoadingHistory(false);
      return;
    }
    setIsLoadingHistory(true);
    
    const closedTicketsRef = collection(db, 'stores', activeStore.id, 'rtKdsTickets', activeTab, 'closedKdsTickets');
    const q = query(closedTicketsRef, orderBy("closedAtClientMs", "desc"), limit(25));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const historyItems = snapshot.docs.map(doc => {
        const ticket = doc.data() as KitchenTicket;
        return {
          id: doc.id,
          sessionLabel: ticket.sessionLabel || 'N/A',
          tableNumber: (ticket as any).tableDisplayName || ticket.sessionLabel || ticket.tableNumber,
          customerName: ticket.customerName,
          itemName: ticket.itemName,
          qty: ticket.qty,
          status: ticket.status,
          closedAtClientMs: ticket.servedAtClientMs || ticket.cancelledAtClientMs || 0,
          durationMs: ticket.durationMs || 0,
        };
      }).sort((a, b) => b.closedAtClientMs - a.closedAtClientMs).slice(0, 5);
      setHistoryPreview(historyItems);
      setIsLoadingHistory(false);
    }, (err) => {
      console.error(`Error fetching history preview for ${activeTab}:`, err);
      setIsLoadingHistory(false);
    });

    return () => unsubscribe();
  }, [activeStore, activeTab]);


  const avgServingTime = useMemo(() => {
    if (!dailyAnalytics || !activeTab) return { avgMs: 0, count: 0 };
    
    const sum = dailyAnalytics.kitchen?.durationMsSumByLocation?.[activeTab] || 0;
    const count = dailyAnalytics.kitchen?.durationCountByLocation?.[activeTab] || 0;
    
    if (count === 0) return { avgMs: 0, count: 0 };
    
    return { avgMs: sum / count, count };
  }, [dailyAnalytics, activeTab]);

  const ticketsWithData = useMemo(() => {
    if (!stationDoc) return [];
    
    const map = stationDoc.tickets || {};
    const ids = stationDoc.activeIds?.length ? stationDoc.activeIds : Object.keys(map);
    
    const ticketList = ids
      .map(id => ({ ...(map[id] || {}), id }))
      // ensure ticket data exists; offline-printed tickets are auto-acknowledged
      // (see the printedOffline effect below) and are excluded from the active
      // queue immediately — the served-transaction removal from `activeIds`
      // lags a snapshot round-trip, so this filter keeps them from ever
      // rendering in the meantime.
      .filter(t => t && (t.sessionId || t.onlineOrderId) && !t.printedOffline);

    const sortedTickets = ticketList.sort((a,b) => {
        // One clock for every ticket: a POS order stamped by a drifting browser
        // must not sort ahead of a customer order stamped by the server.
        const timeA = resolveTicketStartMs(a.createdAt, a.createdAtClientMs);
        const timeB = resolveTicketStartMs(b.createdAt, b.createdAtClientMs);
        return (timeA || 0) - (timeB || 0);
    });

    return sortedTickets.map((ticket: KitchenTicket) => {
        const session = ticket.sessionId ? sessionsMap.get(ticket.sessionId) : undefined;
        const flavorNames = ticket.type === 'package' 
            ? session?.initialFlavorIds?.map((id: string) => flavorsMap.get(id) || 'Unknown').filter(Boolean)
            : [];
        const finalGuestCount = session?.guestCountFinal ?? session?.guestCountCashierInitial ?? ticket.guestCount;
        // Live session is the source of truth for the table display name —
        // it carries any rename done by the cashier mid-session and is set
        // for both POS- and customer-app-created tickets.
        const tableDisplayName =
          session?.tableDisplayName ?? (ticket as any).tableDisplayName ?? null;
        return {
            ...ticket,
            tableDisplayName,
            guestCount: finalGuestCount,
            initialFlavorNames: flavorNames,
            sessionLabel: computeSessionLabel({
              sessionMode: ticket.sessionMode,
              customerName: ticket.customerName,
              tableNumber: ticket.tableNumber,
              tableDisplayName,
            }),
        };
    });
  }, [stationDoc, sessionsMap, flavorsMap]);
  
  // `opts.overrideAtMs` lets a caller stamp the served/cancelled moment with a
  // client timestamp other than "now" (used by the printedOffline auto-ack
  // effect below, which serves using `printedOfflineAt` so served
  // counts/durations reflect when the paper actually printed, not the moment
  // the ticket happened to sync back online). `opts.silent` suppresses the
  // flash overlay + activity log entry for system-driven (non-human) serves.
  const updateTicketStatus = async (
    ticketId: string,
    sessionId: string,
    newStatus: "served" | "cancelled",
    reason?: string,
    opts?: { overrideAtMs?: number; silent?: boolean; source?: "online" },
  ) => {
    if (opts?.source === "online") {
      return updateOnlineOrderTicketStatus(ticketId, sessionId, newStatus, reason, opts);
    }
    if (!appUser || !activeStore) {
        toast({ variant: "destructive", title: "Action Failed", description: "Authentication or store context is missing." });
        return false;
    }

    // Server time, because this is written to the ticket as servedAtClientMs and
    // feeds durationMs and serveTimeMsTotalByType — a skewed tablet was
    // inflating recorded serve times, not just the display.
    const nowMs = opts?.overrideAtMs ?? serverNowMs(clientAheadMs, Date.now());
    let kdsDelta: { old: any; new: any } | null = null as { old: any; new: any } | null;

    try {
        await runTransaction(db, async (transaction: Transaction) => {
            const ticketRef = doc(db, "stores", activeStore.id, "sessions", sessionId, "kitchentickets", ticketId);
            const ticketSnap = await transaction.get(ticketRef);
            
            if (!ticketSnap.exists()) {
                throw new Error("Ticket not found.");
            }

            const oldTicketState = ticketSnap.data() as KitchenTicket;
            
            if (oldTicketState.status === 'served' || oldTicketState.status === 'cancelled') {
                console.log(`Ticket ${ticketId} is already finalized. Skipping update.`);
                return;
            }

            // This is the whole-ticket serve path (the plain "Served" button);
            // handleServeBatch covers partial serves. A customer-app order bills
            // HERE too — without this a quantity-1 order, which is the common
            // case, would be served and never charged.
            const pendingBill = newStatus === 'served' ? pendingBillLineFor(oldTicketState) : null;
            const billLineRef = pendingBill
                ? doc(db, "stores", activeStore.id, "sessions", sessionId, "sessionBillLines", pendingBill.lineId)
                : null;
            const billLineSnap = billLineRef ? await transaction.get(billLineRef) : null;

            const ticketQtyOrdered = oldTicketState.qtyOrdered ?? oldTicketState.qty ?? 1;
            const alreadyServed = oldTicketState.qtyServed ?? 0;

            const updatePayload: any = { status: newStatus, updatedAt: serverTimestamp() };
            let newTicketState: KitchenTicket;
            
            if (newStatus === 'served') {
                const startMs = resolveTicketStartMs(oldTicketState.createdAt, oldTicketState.createdAtClientMs);
                const durationMs = startMs ? Math.max(0, nowMs - startMs) : 0;
                
                updatePayload.servedAt = serverTimestamp();
                updatePayload.servedAtClientMs = nowMs;
                updatePayload.servedByUid = appUser.uid;
                updatePayload.servedByProfileId = currentProfile?.profileId ?? null;
                updatePayload.servedByProfileName = currentProfile?.name ?? null;
                updatePayload.preparedAt = serverTimestamp(); // Note: setting prepared and served at same time
                updatePayload.preparedByUid = appUser.uid;
                updatePayload.durationMs = durationMs;
                
                const sessionRef = doc(db, "stores", activeStore.id, "sessions", sessionId);
                const sessionUpdate: Record<string, any> = {
                    [`serveCountByType.${oldTicketState.type}`]: increment(1),
                    [`serveTimeMsTotalByType.${oldTicketState.type}`]: increment(durationMs),
                };

                // Record the quantity explicitly. computeKdsTargets reads
                // `qtyServed ?? fallback`, and a ticket written with
                // `qtyServed: 0` (as both POS and the customer app do) would
                // otherwise report ZERO serves to KDS analytics.
                const { qtyServed: qtyNowServed, qtyRemaining } = servedQtyFields(oldTicketState);
                updatePayload.qtyServed = qtyNowServed;
                updatePayload.qtyRemaining = qtyRemaining;

                if (pendingBill && billLineRef && billLineSnap) {
                    const qtyToBill = Math.max(0, qtyNowServed - alreadyServed);
                    if (qtyToBill > 0) {
                        if (billLineSnap.exists()) {
                            transaction.update(billLineRef, {
                                qtyOrdered: increment(qtyToBill),
                                updatedAt: serverTimestamp(),
                                updatedByUid: appUser.uid,
                                updatedByName: currentProfile?.name ?? null,
                            });
                        } else {
                            transaction.set(billLineRef, stripUndefined({
                                ...buildCustomerOrderBillLine(pendingBill, qtyToBill),
                                createdAt: serverTimestamp(),
                                updatedAt: serverTimestamp(),
                                updatedByUid: appUser.uid,
                                updatedByName: currentProfile?.name ?? null,
                            }));
                        }
                        updatePayload.billLineId = pendingBill.lineId;
                        updatePayload.billedAtClientMs = nowMs;
                        // The payment path aborts on a stale billingRevision.
                        sessionUpdate.billingRevision = increment(1);
                        sessionUpdate.updatedAt = serverTimestamp();
                    }
                }

                if (oldTicketState.type === 'refill') {
                    const qty = oldTicketState.qty || 1;
                    sessionUpdate.servedRefillsTotal = increment(qty);
                    const refillName = (oldTicketState as any).refillName || oldTicketState.itemName;
                    if(refillName) {
                        sessionUpdate[`servedRefillsByName.${refillName.replace(/\./g, '_')}`] = increment(qty);
                    }
                }
                transaction.update(sessionRef, sessionUpdate);
                newTicketState = { ...oldTicketState, ...updatePayload };

            } else { // cancelled
                updatePayload.cancelledAt = serverTimestamp();
                updatePayload.cancelledAtClientMs = nowMs;
                updatePayload.cancelledByUid = appUser.uid;
                updatePayload.cancelReason = reason;
                // Same reason as the serve branch: make the quantity explicit
                // so KDS analytics does not read a literal 0.
                updatePayload.qtyCancelled = Math.max(0, ticketQtyOrdered - alreadyServed);
                updatePayload.qtyRemaining = 0;

                newTicketState = { ...oldTicketState, ...updatePayload };

                // A bill-on-serve ticket is excluded: its line only ever holds
                // what was already served, so voiding here would subtract
                // quantity that was never charged.
                const voidLineId = shouldVoidBilledQty(oldTicketState) ? oldTicketState.billLineId : null;
                if (voidLineId) {
                    const billLineRef = doc(db, "stores", activeStore.id, "sessions", sessionId, "sessionBillLines", voidLineId);
                    const sessionRef = doc(db, "stores", activeStore.id, "sessions", sessionId);
                    const ticketQty = oldTicketState.qty || 1;
                    transaction.update(billLineRef, {
                        voidedQty: increment(ticketQty),
                        voidReason: "kitchen_cancel",
                        voidNote: "Cancelled by kitchen: " + (reason || ""),
                        updatedAt: serverTimestamp(),
                    });
                    transaction.update(sessionRef, {
                        billingRevision: increment(1),
                        updatedAt: serverTimestamp(),
                    });
                }
            }
            
            transaction.update(ticketRef, updatePayload);
            
            // --- ATOMIC KDS PROJECTION UPDATE ---
            const { kitchenLocationId } = oldTicketState;
            if (kitchenLocationId) {
                // Remove from real-time view
                const rtKdsDocRef = doc(db, "stores", activeStore.id, "rtKdsTickets", kitchenLocationId);
                transaction.update(rtKdsDocRef, {
                    [`tickets.${ticketId}`]: deleteField(),
                    activeIds: arrayRemove(ticketId),
                    [`sessionIndex.${sessionId}`]: arrayRemove(ticketId),
                    "meta.updatedAt": serverTimestamp(),
                });

                // Add to historical view
                const closedTicketRef = doc(db, "stores", activeStore.id, "rtKdsTickets", kitchenLocationId, "closedKdsTickets", ticketId);
                updatePayload.updatedAt = serverTimestamp(); // bump for history ordering
                newTicketState = { ...oldTicketState, ...updatePayload };
                transaction.set(closedTicketRef, { ...newTicketState, closedAtClientMs: nowMs });
            }
            
            kdsDelta = { old: oldTicketState, new: newTicketState };
        });

        if (kdsDelta) {
          const delta = kdsDelta;
          const actor = { profileId: currentProfile?.profileId ?? null, name: currentProfile?.name ?? null };
          // Server-first (marker-based, idempotent). Fallback also writes the
          // ticket markers so a later server call doesn't double-count.
          await applyKdsDeltaServerFirst(activeStore.id, sessionId, [ticketId], actor, async () => {
            const { writeBatch: wb } = await import('firebase/firestore');
            const batch = wb(db);
            await applyKdsTicketDelta(db, activeStore.id, delta.old, delta.new, { batch, actor });
            const tg = computeKdsTargets(delta.new);
            batch.update(doc(db, 'stores', activeStore.id, 'sessions', sessionId, 'kitchentickets', ticketId), {
              analyticsServedQty: tg.servedQty, analyticsCancelledQty: tg.cancelledQty,
              analyticsDurationMs: tg.durationMs, analyticsDurationCount: tg.durationCount,
            });
            await batch.commit();
          });
        }
        // Silent (system-driven) serves — e.g. the printedOffline auto-ack —
        // skip the flash overlay and activity log: no human acted here, and
        // `ticketsWithData` won't even contain an auto-acked ticket (it's
        // filtered out of the active queue), so `ticket` would be undefined.
        if (!opts?.silent) {
          const ticket = ticketsWithData.find(t => t.id === ticketId);
          const flashType = newStatus === "cancelled" ? "cancelled" : "served";
          showFlash(flashType, `${ticket?.itemName || 'Item'} ${newStatus}`, `${ticket?.sessionLabel || ''}`);
          if (ticket) {
            writeActivityLog({ action: newStatus === "cancelled" ? "TICKET_CANCELLED" : "TICKET_SERVED", storeId: activeStore.id, sessionId, user: appUser, meta: { itemName: ticket.itemName, reason: reason || undefined }, note: `${ticket.itemName} ${newStatus}${reason ? `: ${reason}` : ""}` });
          }
        }
        return true;

    } catch (error: any) {
        console.error(`Failed to update ticket status to ${newStatus}:`, error);
        // Silent (system-driven) calls — e.g. the printedOffline auto-ack — must
        // not surface a destructive toast for a background failure; the caller
        // (the auto-ack effect) handles bounded retry/give-up instead. Manual
        // taps (Mark Served / Cancel) keep the toast.
        if (!opts?.silent) {
          toast({ variant: "destructive", title: "Update Failed", description: error.message || "Could not update the ticket status." });
        }
        return false;
    }
  };

  // Serve/cancel for an online-order ticket. Deliberately NOT a branch inside
  // updateTicketStatus above: that function's dine-in path also increments
  // session serve counters, voids sessionBillLines, and pushes KDS analytics
  // deltas — none of which have an online-order equivalent (online-order
  // analytics already flow through the receipt/completion path in
  // route.ts, unrelated to kitchen-ticket serve timing). This function does
  // only what actually applies: flip the ticket, remove it from the active
  // rtKdsTickets projection, archive it into closedKdsTickets.
  const updateOnlineOrderTicketStatus = async (
    ticketId: string,
    onlineOrderId: string,
    newStatus: "served" | "cancelled",
    reason?: string,
    opts?: { silent?: boolean },
  ): Promise<boolean> => {
    if (!appUser || !activeStore) {
      toast({ variant: "destructive", title: "Action Failed", description: "Authentication or store context is missing." });
      return false;
    }
    try {
      const authUser = user || getAuth().currentUser;
      if (!authUser) throw new Error("Not signed in.");
      const idToken = await authUser.getIdToken();
      const res = await fetch("/api/admin/online-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          op: "kitchen-ticket-status",
          storeId: activeStore.id,
          orderId: onlineOrderId,
          ticketId,
          status: newStatus,
          reason,
          profileId: currentProfile?.profileId ?? null,
          profileName: currentProfile?.name ?? null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Could not update the ticket status.");

      if (!opts?.silent) {
        const ticket = ticketsWithData.find((t) => t.id === ticketId);
        showFlash(
          newStatus === "cancelled" ? "cancelled" : "served",
          `${ticket?.itemName || "Item"} ${newStatus}`,
          ticket?.customerName ? `Online · ${ticket.customerName}` : "Online order",
        );
      }
      return true;
    } catch (error: any) {
      console.error(`Failed to update online ticket status to ${newStatus}:`, error);
      if (!opts?.silent) {
        toast({ variant: "destructive", title: "Update Failed", description: error.message || "Could not update the ticket status." });
      }
      return false;
    }
  };

  // Auto-acknowledge tickets printed to the offline backup kitchen printer
  // (kitchen-bt-printer-backup feature). While a cashier/server device is
  // disconnected, it prints the ticket to a shared Bluetooth printer and
  // stamps it `printedOffline`/`printedOfflineAt`. The kitchen already worked
  // from that paper ticket, so on reconnect it must be marked served — not
  // re-queued for prep — via the SAME serve path used for a manual "mark
  // served" tap (`updateTicketStatus`), reusing `printedOfflineAt` as the
  // serve timestamp so served counts/durations reflect when the paper
  // actually printed rather than the (possibly much later) sync moment.
  //
  // Scans every station in `stationsAllDocs` (not just the active tab) so a
  // backlog acknowledges even on tabs the kitchen isn't currently viewing.
  // `ticketsWithData` (and therefore the rendered queue / tab badges) already
  // excludes `printedOffline` tickets synchronously, so this effect only
  // needs to fire the actual serve transaction; it never gates rendering.
  //
  // Idempotency: `autoAckedTicketIdsRef` is a ref-backed Set marked BEFORE the
  // async call, so a ticket is only ever auto-served once per page session
  // even though this effect re-runs on every projection snapshot (e.g. an
  // unrelated ticket changing at the same station). `updateTicketStatus`'s own
  // transaction is additionally guarded against double-serving server-side
  // (it no-ops if the ticket is already `served`/`cancelled`). `updateTicketStatus`
  // catches its own errors and resolves `false` (never rejects — see its
  // try/catch), so a transient failure un-marks the ref via `.then` and the
  // next snapshot naturally retries.
  useEffect(() => {
    if (!activeStore) return;
    for (const stationDocEntry of stationsAllDocs.values()) {
      const map = stationDocEntry.tickets || {};
      for (const [ticketId, t] of Object.entries(map)) {
        if (!t || t.printedOffline !== true) continue;
        if (t.status !== "preparing" && t.status !== "ready") continue;
        if (!t.sessionId) continue;
        if (autoAckedTicketIdsRef.current.has(ticketId)) continue;
        // Bounded retry: once a ticket has failed 3 silent attempts, stop
        // retrying. The ticket stays `printedOffline`, so it remains excluded
        // from the rendered queue/tab badges (see the `printedOffline`
        // filters below) rather than falling back into view for manual
        // handling — it is NOT "left in the queue". This is safe KDS
        // data-hygiene, not a lost order: the kitchen already has the printed
        // paper ticket from the outage. A one-time destructive toast fires
        // below on give-up so it isn't silently dropped either.
        const failCount = autoAckFailureCountRef.current.get(ticketId) ?? 0;
        if (failCount >= 3) continue;
        autoAckedTicketIdsRef.current.add(ticketId);
        const overrideAtMs = typeof t.printedOfflineAt === "number" ? t.printedOfflineAt : undefined;
        void updateTicketStatus(ticketId, t.sessionId, "served", undefined, { overrideAtMs, silent: true })
          .then((ok) => {
            if (!ok) {
              autoAckedTicketIdsRef.current.delete(ticketId);
              const nextFailCount = failCount + 1;
              autoAckFailureCountRef.current.set(ticketId, nextFailCount);
              // Give-up: the 3rd failed silent attempt. Surface a one-time,
              // non-silent toast so this doesn't fail invisibly — the ticket
              // itself stays excluded from the KDS queue (covered by the
              // printed paper ticket), but staff should still know it needs
              // to be marked served manually in the backend/records if ever
              // needed.
              if (nextFailCount >= 3 && !autoAckGaveUpAlertedRef.current.has(ticketId)) {
                autoAckGaveUpAlertedRef.current.add(ticketId);
                toast({
                  variant: "destructive",
                  title: "Kitchen ticket needs manual serve",
                  description: "An offline-printed ticket couldn't auto-acknowledge — mark it served manually.",
                });
              }
            } else {
              autoAckFailureCountRef.current.delete(ticketId);
            }
          });
      }
    }
    // updateTicketStatus is intentionally not in deps (same pattern as the
    // activeStationName omission above) — it closes over appUser/activeStore/
    // currentProfile, which change far less often than stationsAllDocs, and
    // re-running this scan on every render just to pick up a fresh function
    // identity isn't worth it given the ref guard already makes re-scans cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationsAllDocs, activeStore]);

  const handleServeBatch = async ({ ticketId, sessionId, qtyToServe }: { ticketId: string; sessionId: string; qtyToServe: number }) => {
    if (!appUser || !activeStore) return;
    const nowMs = serverNowMs(clientAheadMs, Date.now());
    try {
      const kdsDelta = await runTransaction(db, async (transaction: Transaction): Promise<{ old: KitchenTicket; new: KitchenTicket } | null> => {
        const ticketRef = doc(db, 'stores', activeStore.id, 'sessions', sessionId, 'kitchentickets', ticketId);
        const ticketSnap = await transaction.get(ticketRef);
        if (!ticketSnap.exists()) throw new Error('Ticket not found.');
        const old = ticketSnap.data() as KitchenTicket;
        if (old.status === 'served' || old.status === 'cancelled') return null;

        // A customer-app order carries no bill line until now — the diner is
        // charged for what the kitchen actually hands over. Read the target
        // line here, while we are still in the transaction's read phase, so we
        // can tell create-vs-increment below.
        const pendingBill = pendingBillLineFor(old);
        const billLineRef = pendingBill
          ? doc(db, 'stores', activeStore.id, 'sessions', sessionId, 'sessionBillLines', pendingBill.lineId)
          : null;
        const billLineSnap = billLineRef ? await transaction.get(billLineRef) : null;

        const qtyOrdered = old.qtyOrdered ?? old.qty ?? 1;
        const qtyServed = (old.qtyServed ?? 0) + qtyToServe;
        const qtyCancelled = old.qtyCancelled ?? 0;
        const qtyRemaining = qtyOrdered - qtyServed - qtyCancelled;
        const newStatus = qtyRemaining <= 0 ? 'served' : 'partially_served';
        const startMs = resolveTicketStartMs(old.createdAt, old.createdAtClientMs);
        const durationMs = startMs ? Math.max(0, nowMs - startMs) : 0;
        const newLogEntry = { qty: qtyToServe, servedAt: nowMs, servedAtClientMs: nowMs, servedByUid: appUser.uid, servedByProfileId: currentProfile?.profileId ?? null, servedByProfileName: currentProfile?.name ?? null };
        const updatePayload: any = {
          qtyServed, qtyCancelled, qtyRemaining,
          status: newStatus,
          serveLog: [...(old.serveLog ?? []), newLogEntry],
          servedByUid: appUser.uid,
          servedByProfileId: currentProfile?.profileId ?? null,
          servedByProfileName: currentProfile?.name ?? null,
          servedAtClientMs: nowMs,
          servedAt: serverTimestamp(),
          durationMs,
          updatedAt: serverTimestamp(),
        };
        const sessionRef = doc(db, 'stores', activeStore.id, 'sessions', sessionId);
        const didBill = !!(pendingBill && billLineRef && billLineSnap);

        // Bill the served quantity for a customer-placed order. Partial serves
        // bill partially: 1-of-3 served puts exactly 1 on the bill.
        if (pendingBill && billLineRef && billLineSnap) {
          if (billLineSnap.exists()) {
            transaction.update(billLineRef, {
              qtyOrdered: increment(qtyToServe),
              updatedAt: serverTimestamp(),
              updatedByUid: appUser.uid,
              updatedByName: currentProfile?.name ?? null,
            });
          } else {
            transaction.set(billLineRef, stripUndefined({
              ...buildCustomerOrderBillLine(pendingBill, qtyToServe),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              updatedByUid: appUser.uid,
              updatedByName: currentProfile?.name ?? null,
            }));
          }
          // Link the ticket to its line from now on, so the existing cancel and
          // void paths can find it. Until this point it was deliberately null.
          updatePayload.billLineId = pendingBill.lineId;
          updatePayload.billedAtClientMs = nowMs;
        }

        transaction.update(ticketRef, updatePayload);
        const sessionUpdate: Record<string, any> = {};
        sessionUpdate[`serveCountByType.${old.type}`] = increment(1);
        sessionUpdate[`serveTimeMsTotalByType.${old.type}`] = increment(durationMs);
        if (didBill) {
          // The payment path aborts on a stale billingRevision — without this
          // bump a cashier could settle a bill computed before this line landed.
          sessionUpdate.billingRevision = increment(1);
          sessionUpdate.updatedAt = serverTimestamp();
        }
        transaction.update(sessionRef, sessionUpdate);
        if (old.kitchenLocationId) {
          const rtKdsDocRef = doc(db, 'stores', activeStore.id, 'rtKdsTickets', old.kitchenLocationId);
          if (newStatus === 'served') {
            const rtUpdate: Record<string, any> = {};
            rtUpdate[`tickets.${ticketId}`] = deleteField();
            rtUpdate['activeIds'] = arrayRemove(ticketId);
            rtUpdate[`sessionIndex.${sessionId}`] = arrayRemove(ticketId);
            rtUpdate['meta.updatedAt'] = serverTimestamp();
            transaction.update(rtKdsDocRef, rtUpdate);
            const closedRef = doc(db, 'stores', activeStore.id, 'rtKdsTickets', old.kitchenLocationId, 'closedKdsTickets', ticketId);
            transaction.set(closedRef, { ...old, ...updatePayload, closedAtClientMs: nowMs });
          } else {
            const rtUpdate: Record<string, any> = {};
            rtUpdate[`tickets.${ticketId}.qtyServed`] = qtyServed;
            rtUpdate[`tickets.${ticketId}.qtyRemaining`] = qtyRemaining;
            rtUpdate[`tickets.${ticketId}.status`] = newStatus;
            rtUpdate[`tickets.${ticketId}.serveLog`] = [...(old.serveLog ?? []), newLogEntry];
            rtUpdate['meta.updatedAt'] = serverTimestamp();
            transaction.update(rtKdsDocRef, rtUpdate);
          }
        }
        return { old, new: { ...old, ...updatePayload } as KitchenTicket };
      });
      if (kdsDelta) {
        const delta = kdsDelta;
        const actor = { profileId: currentProfile?.profileId ?? null, name: currentProfile?.name ?? null };
        await applyKdsDeltaServerFirst(activeStore.id, sessionId, [ticketId], actor, async () => {
          const { writeBatch: wb } = await import('firebase/firestore');
          const batch = wb(db);
          await applyKdsTicketDelta(db, activeStore.id, delta.old, delta.new, { batch, actor });
          const tg = computeKdsTargets(delta.new);
          batch.update(doc(db, 'stores', activeStore.id, 'sessions', sessionId, 'kitchentickets', ticketId), {
            analyticsServedQty: tg.servedQty, analyticsCancelledQty: tg.cancelledQty,
            analyticsDurationMs: tg.durationMs, analyticsDurationCount: tg.durationCount,
          });
          await batch.commit();
        });
      }
      const ticket = ticketsWithData.find(t => t.id === ticketId);
      showFlash("served", `${qtyToServe} pcs served`);
      if (ticket) {
        writeActivityLog({ action: "TICKET_BATCH_SERVED", storeId: activeStore.id, sessionId, user: appUser, meta: { itemName: ticket.itemName, qty: qtyToServe }, note: `${qtyToServe}x ${ticket.itemName} served` });
      }
    } catch (error: any) {
      toast({ variant: 'destructive', title: 'Serve Failed', description: error.message });
    }
  };

  const handleCancelRemaining = async ({ ticketId, sessionId, reason }: { ticketId: string; sessionId: string; reason: string }) => {
    if (!appUser || !activeStore) return;
    // Written to the ticket as cancelledAtClientMs, so it gets the same
    // server-time treatment as the serve stamps above.
    const nowMs = serverNowMs(clientAheadMs, Date.now());
    try {
      await runTransaction(db, async (transaction: Transaction) => {
        const ticketRef = doc(db, 'stores', activeStore.id, 'sessions', sessionId, 'kitchentickets', ticketId);
        const ticketSnap = await transaction.get(ticketRef);
        if (!ticketSnap.exists()) throw new Error('Ticket not found.');
        const old = ticketSnap.data() as KitchenTicket;
        if (old.status === 'served' || old.status === 'cancelled') return;
        const qtyOrdered = old.qtyOrdered ?? old.qty ?? 1;
        const qtyServed = old.qtyServed ?? 0;
        const qtyRemaining = old.qtyRemaining ?? (qtyOrdered - qtyServed);
        const qtyCancelled = (old.qtyCancelled ?? 0) + qtyRemaining;
        const newStatus = qtyServed > 0 ? 'served' : 'cancelled';
        const updatePayload: any = {
          qtyCancelled, qtyRemaining: 0,
          status: newStatus,
          cancelledAt: serverTimestamp(),
          cancelledAtClientMs: nowMs,
          cancelledByUid: appUser.uid,
          cancelReason: reason,
          updatedAt: serverTimestamp(),
        };
        // A bill-on-serve ticket is deliberately excluded here: its line only
        // ever carries the quantity already served, so there is no unserved
        // quantity on the bill to take back off.
        const billLineIdToVoid = shouldVoidBilledQty(old) ? old.billLineId : null;
        if (billLineIdToVoid) {
          const billLineRef = doc(db, 'stores', activeStore.id, 'sessions', sessionId, 'sessionBillLines', billLineIdToVoid);
          const sessionRef = doc(db, 'stores', activeStore.id, 'sessions', sessionId);
          transaction.update(billLineRef, { voidedQty: increment(qtyRemaining), voidReason: "kitchen_cancel", voidNote: "Cancelled by kitchen: " + reason, updatedAt: serverTimestamp() });
          transaction.update(sessionRef, { billingRevision: increment(1), updatedAt: serverTimestamp() });
        }
        transaction.update(ticketRef, updatePayload);
        if (old.kitchenLocationId) {
          const rtKdsDocRef = doc(db, 'stores', activeStore.id, 'rtKdsTickets', old.kitchenLocationId);
          const rtUpdate: Record<string, any> = {};
          rtUpdate[`tickets.${ticketId}`] = deleteField();
          rtUpdate['activeIds'] = arrayRemove(ticketId);
          rtUpdate[`sessionIndex.${sessionId}`] = arrayRemove(ticketId);
          rtUpdate['meta.updatedAt'] = serverTimestamp();
          transaction.update(rtKdsDocRef, rtUpdate);
          const closedRef = doc(db, 'stores', activeStore.id, 'rtKdsTickets', old.kitchenLocationId, 'closedKdsTickets', ticketId);
          transaction.set(closedRef, { ...old, ...updatePayload, closedAtClientMs: nowMs });
        }
      });
      const ticket = ticketsWithData.find(t => t.id === ticketId);
      showFlash("cancelled", "Remaining cancelled", "Already-served qty preserved");
      if (ticket) {
        writeActivityLog({ action: "TICKET_REMAINING_CANCELLED", storeId: activeStore.id, sessionId, user: appUser, meta: { itemName: ticket.itemName, reason }, note: `Remaining ${ticket.itemName} cancelled: ${reason}` });
      }
    } catch (error: any) {
      toast({ variant: 'destructive', title: 'Cancel Failed', description: error.message });
    }
  };
  const preparingItems = useMemo(() => ticketsWithData.filter(t => t.status === 'preparing' || t.status === 'partially_served'), [ticketsWithData]);

  if (isLoading) {
    return <div className="flex justify-center items-center h-full"><Loader className="animate-spin" size={48} /></div>;
  }

  return (
    <RoleGuard allow={["admin", "manager", "kitchen"]}>
      <PageHeader
        title="Kitchen Display System"
        description="Monitor and manage all active food and beverage orders."
      >
        <div className="flex items-center gap-2">
            <SyncKdsTicketsTool />
            <div className="text-right">
                <p className="text-sm font-medium text-muted-foreground">{activeStationName} Avg Serving Time</p>
                <p className={cn(
                    "text-2xl font-bold font-mono",
                    avgServingTime.avgMs > 0 && avgServingTime.avgMs <= 300000 ? "text-green-600" : "text-destructive"
                )}>
                    {formatDuration(avgServingTime.avgMs)}
                </p>
            </div>
        </div>
      </PageHeader>
        <div className={cn("grid grid-cols-1 gap-4 items-start", !historyCollapsed && "xl:grid-cols-4")}>
            <div className={!historyCollapsed ? "xl:col-span-3" : ""}>
                 <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                    {isMobile ? (
                        <Select value={activeTab} onValueChange={setActiveTab}>
                            <SelectTrigger>
                                <SelectValue placeholder="Select a station..." />
                            </SelectTrigger>
                            <SelectContent>
                                {stations.map((station: KitchenStation) => {
                                    const count = stationCounts.get(station.id) || 0;
                                    const late = overSlaByStation.get(station.id) || 0;
                                    return (
                                        <SelectItem key={station.id} value={station.key}>
                                            {station.name} {count > 0 && `(${count})`}{late > 0 && ` · ${late} late`}
                                        </SelectItem>
                                    )
                                })}
                            </SelectContent>
                        </Select>
                    ) : (
                        <TabsList className="gap-2">
                            {stations.map((station: KitchenStation) => {
                                const count = stationCounts.get(station.id) || 0;
                                const late = overSlaByStation.get(station.id) || 0;
                                return (
                                    <TabsTrigger key={station.id} value={station.key} className="relative">
                                        {station.name}
                                        {count > 0 && (
                                            <Badge variant="destructive" className="absolute -top-2 -right-2 h-5 w-5 justify-center p-0">{count}</Badge>
                                        )}
                                        {late > 0 && (
                                            <Badge variant="outline" className="ml-2 border-destructive bg-destructive/10 text-destructive text-[10px] px-1.5 py-0 gap-0.5">
                                                {late} late
                                            </Badge>
                                        )}
                                    </TabsTrigger>
                                )
                            })}
                        </TabsList>
                    )}
                    {stations.map((station: KitchenStation) => (
                        <TabsContent key={station.id} value={station.key}>
                            <KdsView tickets={preparingItems} onUpdateStatus={updateTicketStatus} onServeBatch={handleServeBatch} onCancelRemaining={handleCancelRemaining} slaMinutes={activeStationSla} wideLayout={historyCollapsed} />
                        </TabsContent>
                    ))}
                 </Tabs>
            </div>
            {!historyCollapsed && (
                <div className="xl:col-span-1 space-y-4">
                    <HistoryView
                      items={historyPreview}
                      isLoading={isLoadingHistory}
                      activeStationId={activeTab}
                      onCollapse={toggleHistoryCollapsed}
                    />
                </div>
            )}
        </div>
        {historyCollapsed && (
            <Button
                onClick={toggleHistoryCollapsed}
                className="fixed bottom-6 right-6 z-40 h-14 px-5 gap-2 rounded-full text-base shadow-lg"
                size="lg"
            >
                <History className="h-5 w-5" /> History
            </Button>
        )}
      {timelineSessionId && activeStore && (
        <SessionTimelineDrawer open={!!timelineSessionId} onOpenChange={(isOpen) => !isOpen && setTimelineSessionId(null)} storeId={activeStore.id} sessionId={timelineSessionId} />
       )}
      <KdsFlashOverlay
        type={flash?.type ?? null}
        message={flash?.message ?? ""}
        subtitle={flash?.subtitle}
        onDone={() => setFlash(null)}
      />
      {activeStore?.id && <AssistanceAlerts storeId={activeStore.id} />}
    </RoleGuard>
  );
}
