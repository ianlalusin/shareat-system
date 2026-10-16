"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, doc, getDoc, onSnapshot, orderBy, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuthContext } from "@/context/auth-context";
import { useLocalProfile } from "@/context/local-profile-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, BellRing, Flame } from "lucide-react";
import { fireKitchenAlert, primeKitchenAudio } from "@/lib/notifications/kitchenAlert";
import { writeActivityLog } from "@/components/cashier/activity-log";
import { useToast } from "@/hooks/use-toast";
import { resolveGrillerCharge, buildChargeAdjustment, appendSessionAdjustment } from "@/lib/billing/adjustments";

const KNOWN_TYPES = ["assistance", "griller"] as const;
type RequestType = (typeof KNOWN_TYPES)[number];

type AssistanceRequest = {
  id: string;
  sessionId: string;
  type: RequestType;
  text?: string;
  tableNumber?: string;
  tableDisplayName?: string | null;
  customerName?: string | null;
  status: "pending" | "done";
  createdAtClientMs: number;
};

function tableLabel(r: AssistanceRequest): string {
  return r.tableDisplayName || (r.tableNumber ? `Table ${r.tableNumber}` : "Unknown table");
}

function waitedLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * Blocking, must-resolve alert (with chime) for customer-initiated requests:
 * "Ask for assistance" (single "OK, on my way" acknowledge) and "Add
 * Griller" (staff choose "Add", which applies the ₱50 charge to the
 * session's bill, or "Cancel", which resolves with no charge). Mounted on
 * the KDS and Server pages. One unified oldest-first queue across both
 * request types, since they share the same customerRequests collection and
 * only one blocking AlertDialog can sensibly be open at a time.
 */
export function AssistanceAlerts({ storeId }: { storeId: string | null | undefined }) {
  const { appUser } = useAuthContext();
  const { currentProfile } = useLocalProfile();
  const { toast } = useToast();
  const [requests, setRequests] = useState<AssistanceRequest[]>([]);
  const [acking, setAcking] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const seenIds = useRef<Set<string>>(new Set());

  useEffect(() => { primeKitchenAudio(); }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!storeId) {
      setRequests([]);
      return;
    }
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const ref = collection(db, `stores/${storeId}/customerRequests`);
    // Single-field range+order (no composite index); filter status/type client-side.
    const q = query(ref, where("createdAtClientMs", ">=", todayStart.getTime()), orderBy("createdAtClientMs", "asc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const pending = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .filter((r) => r.status === "pending" && KNOWN_TYPES.includes(r.type)) as AssistanceRequest[];

        // Chime + OS notify on newly-seen pending requests.
        for (const r of pending) {
          if (!seenIds.current.has(r.id)) {
            seenIds.current.add(r.id);
            const title = r.type === "griller" ? "Griller requested" : "Assistance requested";
            void fireKitchenAlert({ title, body: tableLabel(r) });
          }
        }
        setRequests(pending);
      },
      (err) => console.error("[AssistanceAlerts] snapshot error:", err),
    );
    return () => unsub();
  }, [storeId]);

  // Oldest waiting request drives the modal; resolving it advances to the next.
  const current = useMemo(
    () => requests.slice().sort((a, b) => (a.createdAtClientMs || 0) - (b.createdAtClientMs || 0))[0] ?? null,
    [requests],
  );

  async function acknowledge() {
    if (!storeId || !current) return;
    setAcking(true);
    try {
      const doneAtClientMs = Date.now();
      await updateDoc(doc(db, `stores/${storeId}/customerRequests/${current.id}`), {
        status: "done",
        doneAt: serverTimestamp(),
        doneAtClientMs,
        doneByUid: appUser?.uid ?? null,
        doneByUsername: appUser?.displayName || appUser?.name || null,
        doneByProfileId: currentProfile?.profileId ?? null,
        doneByProfileName: currentProfile?.name ?? null,
      });
      void writeActivityLog({
        storeId,
        sessionId: current.sessionId,
        user: appUser ?? null,
        action: "CUSTOMER_REQUEST_COMPLETED",
        sessionContext: {
          customerName: current.customerName ?? null,
          tableNumber: current.tableNumber ?? null,
          tableDisplayName: current.tableDisplayName ?? null,
        },
        meta: { requestId: current.id, type: "assistance", responseMs: Math.max(0, doneAtClientMs - current.createdAtClientMs) },
      });
    } catch (e) {
      console.error("[AssistanceAlerts] acknowledge failed:", e);
    } finally {
      setAcking(false);
    }
  }

  async function handleGrillerResolve(applyCharge: boolean) {
    if (!storeId || !current || current.type !== "griller") return;
    setResolving(true);
    try {
      const doneAtClientMs = Date.now();
      let resolution: "added" | "cancelled" | "add_failed_session_closed" = applyCharge ? "added" : "cancelled";

      if (applyCharge) {
        const sessionSnap = await getDoc(doc(db, `stores/${storeId}/sessions/${current.sessionId}`));
        const sessionData = sessionSnap.data() as any;
        const billable = !!sessionData && sessionData.status === "active" && !sessionData.isPaid;

        if (!billable) {
          resolution = "add_failed_session_closed";
          toast({ variant: "destructive", title: "Couldn't add charge", description: "This session is no longer open for billing." });
        } else {
          const charge = await resolveGrillerCharge(db, storeId);
          if (!charge) {
            // Admin disabled/archived the charge — leave the request pending
            // so staff can retry once it's fixed, don't silently resolve it.
            toast({ variant: "destructive", title: "Couldn't add charge", description: "Additional Griller is not configured or is disabled for this store." });
            setResolving(false);
            return;
          }
          const adjustment = buildChargeAdjustment(charge, current.id);
          await appendSessionAdjustment(db, storeId, current.sessionId, adjustment);
        }
      }

      await updateDoc(doc(db, `stores/${storeId}/customerRequests/${current.id}`), {
        status: "done",
        doneAt: serverTimestamp(),
        doneAtClientMs,
        doneByUid: appUser?.uid ?? null,
        doneByUsername: appUser?.displayName || appUser?.name || null,
        doneByProfileId: currentProfile?.profileId ?? null,
        doneByProfileName: currentProfile?.name ?? null,
        resolution,
      });

      void writeActivityLog({
        storeId,
        sessionId: current.sessionId,
        user: appUser ?? null,
        action: "CUSTOMER_REQUEST_COMPLETED",
        sessionContext: {
          customerName: current.customerName ?? null,
          tableNumber: current.tableNumber ?? null,
          tableDisplayName: current.tableDisplayName ?? null,
        },
        meta: { requestId: current.id, type: "griller", resolution, responseMs: Math.max(0, doneAtClientMs - current.createdAtClientMs) },
      });
    } catch (e) {
      console.error("[AssistanceAlerts] griller resolve failed:", e);
      toast({ variant: "destructive", title: "Something went wrong", description: "Please try again." });
    } finally {
      setResolving(false);
    }
  }

  const isGriller = current?.type === "griller";

  return (
    <AlertDialog open={!!current}>
      <AlertDialogContent
        className="max-w-md border-4 border-destructive"
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            {isGriller ? (
              <><Flame className="h-6 w-6 animate-pulse" /> Griller requested</>
            ) : (
              <><BellRing className="h-6 w-6 animate-pulse" /> Assistance needed</>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1 pt-1">
              <div className="text-xl font-bold text-foreground">
                {current ? tableLabel(current) : ""}
                {current?.customerName ? <span className="font-medium text-muted-foreground"> · {current.customerName}</span> : null}
              </div>
              {isGriller && current?.text && (
                <div className="text-sm font-medium text-foreground">{current.text}</div>
              )}
              {current && (
                <div className="text-sm text-muted-foreground">
                  Waiting {waitedLabel(now - current.createdAtClientMs)}
                  {requests.length > 1 ? ` · ${requests.length - 1} more waiting` : ""}
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {isGriller ? (
            <>
              <AlertDialogCancel onClick={(e) => { e.preventDefault(); void handleGrillerResolve(false); }} disabled={resolving}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction onClick={(e) => { e.preventDefault(); void handleGrillerResolve(true); }} disabled={resolving} className="min-w-24">
                {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void acknowledge(); }} disabled={acking} className="min-w-24">
              {acking ? <Loader2 className="h-4 w-4 animate-spin" /> : "OK, on my way"}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
