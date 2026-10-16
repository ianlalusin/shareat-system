

"use client";

import { useState, useEffect } from "react";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { PageHeader } from "@/components/page-header";
import { useAuthContext } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { collection, query, where, onSnapshot, doc, updateDoc, serverTimestamp, getDocs, collectionGroup, orderBy, limit, runTransaction, increment, writeBatch } from "firebase/firestore";
import { auth } from "@/lib/firebase/client";
import { db } from "@/lib/firebase/client";
import { useToast } from "@/hooks/use-toast";
import { Loader } from "lucide-react";
import { SessionTimelineDrawer } from "@/components/session/session-timeline-drawer";
import { RequestChangeDialog } from "@/components/server/request-change-dialog";
import { AddonsPOSModal } from "@/components/shared/AddonsPOSModal";
import type { StorePackage, MenuSchedule, KitchenTicket, PendingSession } from "@/lib/types";
import { RefillPOSModal } from "@/components/server/RefillPOSModal";
import { writeActivityLog } from "@/components/cashier/activity-log";
import { reconcileBundleLines } from "@/components/cashier/firestore";
import { toJsDate } from "@/lib/utils/date";
import { PendingVerificationCard } from "@/components/server/PendingVerificationCard"; // New import
import { ActiveSessionsGrid } from "@/components/server/ActiveSessionsGrid"; // New import
import { useLocalProfile } from "@/context/local-profile-context";
import { AssistanceAlerts } from "@/components/kitchen/AssistanceAlerts";
import { useIdleTimer } from "@/hooks/useIdleTimer";
import { formatElapsedShort } from "@/components/server/SessionCard";
import { VerifyAverageCard } from "@/components/server/VerifyAverageCard";

type GCC = PendingSession["guestCountChange"];

function normalizeGuestCountChange(raw: any): GCC {
  const s = raw?.status;
  if (s === "none" || s === "pending" || s === "approved" || s === "rejected") {
    return { ...raw, status: s };
  }
  return { status: "none" };
}


export function ServerPageClient() {
  const { appUser } = useAuthContext();
  const { activeStore, loading: storeLoading } = useStoreContext();
  const { toast } = useToast();
  const { currentProfile, signOut, isReady: profileReady } = useLocalProfile();

  // Idle auto sign-out (30 minutes). Any click/key/scroll resets the timer.
  const { isIdle } = useIdleTimer({ idleMs: 30 * 60_000 });
  useEffect(() => {
    if (isIdle && currentProfile) {
      signOut();
      toast({ title: "Signed out", description: "Inactive for 30 minutes." });
    }
  }, [isIdle, currentProfile, signOut, toast]);

  const [pendingSessions, setPendingSessions] = useState<PendingSession[]>([]);
  const [activeSessions, setActiveSessions] = useState<PendingSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const [timelineSessionId, setTimelineSessionId] = useState<string | null>(null);

  // Data for Dialogs
  const [isRequestDialogOpen, setIsRequestDialogOpen] = useState(false);
  const [isAddonDialogOpen, setIsAddonDialogOpen] = useState(false);
  const [isRefillDialogOpen, setIsRefillDialogOpen] = useState(false);
  const [sessionForRequest, setSessionForRequest] = useState<PendingSession | null>(null);
  const [storePackages, setStorePackages] = useState<StorePackage[]>([]);
  const [schedules, setSchedules] = useState<Map<string, MenuSchedule>>(new Map());
  

  useEffect(() => {
    if (!activeStore) {
      setIsLoading(false);
      setPendingSessions([]);
      setActiveSessions([]);
      return;
    }
    setIsLoading(true);

    const unsubs: (() => void)[] = [];
    
    // Point to the NEW projection collection
    const sessionsQuery = query(
        collection(db, "stores", activeStore.id, "activeSessions"),
        orderBy("startedAtClientMs", "asc")
    );
    
    unsubs.push(onSnapshot(sessionsQuery, (snapshot) => {
        const allSessionsFromProjection = snapshot.docs.map(doc => {
            const data = doc.data();
            
            const cashierCount = Number(
                data.guestCountCashierInitial ?? 0
            );

            return { 
                id: doc.id,
                ...data,
                packageName: data.packageSnapshot?.name || 'Unknown Package',
                guestCountCashierInitial: cashierCount,
            } as PendingSession
        });
        
        // Filter for package_dinein sessions as this page is for servers managing them
        const allSessions = allSessionsFromProjection.filter(s => s.sessionMode === 'package_dinein');
        
        // Sort client-side
        allSessions.sort((a, b) => {
          const tableNumA = parseInt(a.tableNumber, 10);
          const tableNumB = parseInt(b.tableNumber, 10);
          if (!isNaN(tableNumA) && !isNaN(tableNumB)) {
            return tableNumA - tableNumB;
          }
          return (a.tableNumber || "").localeCompare(b.tableNumber || "");
        });
        
        setPendingSessions(allSessions.filter(s => s.status === 'pending_verification'));
        setActiveSessions(allSessions.filter(s => s.status === 'active'));
    }));
    
    // Fetch data needed for dialogs
    unsubs.push(onSnapshot(collection(db, "stores", activeStore.id, "storePackages"), s => setStorePackages(s.docs.map(d => d.data() as StorePackage))));
    const schedulesRef = collection(db, "stores", activeStore.id, "menuSchedules");
    const schedulesQuery = query(schedulesRef, where("isActive", "==", true));
    unsubs.push(onSnapshot(schedulesQuery, (snapshot) => {
        const schedulesMap = new Map<string, MenuSchedule>();
        snapshot.docs.forEach(doc => schedulesMap.set(doc.id, { id: doc.id, ...doc.data() } as MenuSchedule));
        setSchedules(schedulesMap);
    }));


    setIsLoading(false);
    return () => unsubs.forEach(unsub => unsub());

  }, [activeStore]);
  
  const handleOpenRequestDialog = (session: PendingSession) => {
    setSessionForRequest(session);
    setIsRequestDialogOpen(true);
  }
  
  const handleOpenAddonDialog = (session: PendingSession) => {
    setSessionForRequest(session);
    setIsAddonDialogOpen(true);
  };
  
  const handleOpenRefillDialog = (session: PendingSession) => {
    setSessionForRequest(session);
    setIsRefillDialogOpen(true);
  }
  
  const handleVerify = async (session: PendingSession, serverCount: number) => {
    if (!activeStore || !appUser || !session.tableId) return;

    const isBundle = !!session.packageSnapshot?.isBundle;
    const cashierInitial = session.guestCountCashierInitial ?? 0;
    // Never capped by the package: a bundle's `bundleMaxCap` is the headcount its
    // flat price covers, not a seating limit. Guests beyond it are billed on the
    // Extra Pax line, reconciled by reconcileBundleLines below.
    const finalCount = Math.max(cashierInitial, serverCount);
    const startedMs = (session.startedAtClientMs ?? toJsDate(session.startedAt)?.getTime()) ?? null;
    const verifyDurationMs = startedMs != null ? Math.max(0, Date.now() - startedMs) : null;

    const batch = writeBatch(db);
    const sessionRef = doc(db, 'stores', activeStore.id, 'sessions', session.id);
    
    batch.update(sessionRef, {
      guestCountServerVerified: serverCount,
      guestCountFinal: finalCount,
      guestCountVerifyLocked: true,
      status: "active",
      verifiedAt: serverTimestamp(),
      verifyDurationMs,
      verifiedByUid: appUser.uid,
      verifiedByServerProfileId: currentProfile?.profileId ?? null,
      verifiedByServerProfileName: currentProfile?.name ?? null,
      billingRevision: increment(1),
      updatedAt: serverTimestamp(),
    });

    // Also update the quantity on the package billable line item — but only for
    // per-head packages. Bundle lines stay at qty 1 (flat price).
    if (!isBundle) {
      const packageLineRef = doc(db, `stores/${activeStore.id}/sessions/${session.id}/sessionBillLines`, `package_${session.packageOfferingId}`);
      batch.update(packageLineRef, {
          qtyOrdered: finalCount,
          updatedAt: serverTimestamp(),
      });
    }
    
    // Update session projection in the NEW location
    const sessionProjectionRef = doc(db, `stores/${activeStore.id}/activeSessions`, session.id);
    batch.update(sessionProjectionRef, {
      status: "active",
      guestCountFinal: finalCount,
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
      // Bundle: keep the flat line at qty 1 and the Extra Pax overflow line in
      // step with the verified headcount immediately (no bill-view dependency).
      if (isBundle) await reconcileBundleLines(activeStore.id, session.id, appUser);

      // Fire-and-forget: analytics writes are server-only (M-1 lockdown) so the
      // batch above cannot include them. Send them through the server endpoint.
      if (verifyDurationMs != null) {
        auth.currentUser?.getIdToken().then((token) => {
          fetch("/api/analytics/verify-confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              storeId: activeStore.id,
              verifyDurationMs,
              profileId: currentProfile?.profileId ?? null,
              profileName: currentProfile?.name ?? null,
            }),
          }).catch(() => {/* non-fatal */});
        }).catch(() => {/* non-fatal */});
      }

      const durationStr = verifyDurationMs != null ? formatElapsedShort(verifyDurationMs) : "unknown";
      writeActivityLog({ action: "SESSION_VERIFIED", storeId: activeStore.id, sessionId: session.id, user: appUser, meta: { serverCount, finalCount, beforeQty: cashierInitial, afterQty: finalCount, verifyDurationMs } as any, note: `Verified ${finalCount} guests after ${durationStr}`, sessionContext: { sessionStatus: "active", sessionStartedAt: session.startedAt, sessionMode: session.sessionMode, customerName: session.customer?.name ?? session.customerName, tableNumber: session.tableNumber, tableDisplayName: session.tableDisplayName ?? null }, serverProfile: currentProfile ? { id: currentProfile.profileId, name: currentProfile.name } : null });
      toast({ title: 'Session Verified' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Verification Failed', description: e.message });
    }
  };

  const sessionForRequestWithStore = sessionForRequest && activeStore ? { 
    ...sessionForRequest, 
    storeId: activeStore.id,
    guestCountChange: normalizeGuestCountChange(sessionForRequest?.guestCountChange),
    packageChange: sessionForRequest?.packageChange,
  } as PendingSession : null;

  if (isLoading || storeLoading) {
      return (
          <div className="flex items-center justify-center h-full">
              <Loader className="animate-spin" size={48} />
          </div>
      )
  }

  const sharedProps = {
      onVerify: handleVerify,
      onRequestChange: handleOpenRequestDialog,
      onViewTimeline: (sid: string) => setTimelineSessionId(sid),
      onAddRefill: handleOpenRefillDialog,
      onAddAddon: handleOpenAddonDialog,
  };

  if (!profileReady || storeLoading) {
    return (
      <RoleGuard allow={["admin", "manager", "server"]}>
        <PageHeader title="Server Station" description="Verify guest sessions and track items for serving." />
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader className="h-5 w-5 animate-spin" />
        </div>
      </RoleGuard>
    );
  }

  return (
    <RoleGuard allow={["admin", "manager", "server"]}>
      <PageHeader title="Server Station" description="Verify guest sessions and track items for serving.">
        {/* Store-level stat — show whenever a store is selected, including for
            admins who bypassed the local profile sign-in. */}
        {activeStore && <VerifyAverageCard storeId={activeStore.id} />}
      </PageHeader>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2">
            <ActiveSessionsGrid
                sessions={activeSessions}
                {...sharedProps}
            />
        </div>
        <div className="lg:col-span-1 space-y-6">
           <PendingVerificationCard
                sessions={pendingSessions}
                {...sharedProps}
           />
        </div>
      </div>
       {timelineSessionId && activeStore && (
        <SessionTimelineDrawer
            open={!!timelineSessionId}
            onOpenChange={(isOpen) => !isOpen && setTimelineSessionId(null)}
            storeId={activeStore.id}
            sessionId={timelineSessionId}
        />
       )}
        {isRequestDialogOpen && sessionForRequestWithStore && activeStore && (
            <RequestChangeDialog
                isOpen={isRequestDialogOpen}
                onClose={() => setIsRequestDialogOpen(false)}
                session={sessionForRequestWithStore}
                storeId={activeStore.id}
                storePackages={storePackages}
                schedules={schedules}
                serverProfile={currentProfile ? { id: currentProfile.profileId, name: currentProfile.name } : null}
            />
        )}
         {isAddonDialogOpen && sessionForRequestWithStore && activeStore && (
            <AddonsPOSModal
                open={isAddonDialogOpen}
                onOpenChange={setIsAddonDialogOpen}
                storeId={activeStore.id}
                session={sessionForRequestWithStore}
                sessionIsLocked={sessionForRequest?.status === 'closed' || sessionForRequest?.isPaid}
                serverProfile={currentProfile ? { id: currentProfile.profileId, name: currentProfile.name } : null}
            />
        )}
        {isRefillDialogOpen && sessionForRequestWithStore && activeStore && (
            <RefillPOSModal
                open={isRefillDialogOpen}
                onOpenChange={setIsRefillDialogOpen}
                storeId={activeStore.id}
                session={sessionForRequestWithStore}
                sessionIsLocked={sessionForRequest?.status === 'closed' || sessionForRequest?.isPaid}
                serverProfile={currentProfile ? { id: currentProfile.profileId, name: currentProfile.name } : null}
            />
        )}
        {activeStore?.id && <AssistanceAlerts storeId={activeStore.id} />}
    </RoleGuard>
  );
}
