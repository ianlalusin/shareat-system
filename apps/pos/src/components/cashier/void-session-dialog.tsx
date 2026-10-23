
"use client";

import { useState } from "react";
import { useAuthContext } from "@/context/auth-context";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { postPos2, Pos2Error } from "@/lib/pos2/client";
import { voidOutcome } from "@/lib/pos2/voidOutcome";
import { PIN_LENGTH, PinPad } from "@/components/pos2/PinPad";
import { voidSessionOffline } from "./offlineVoid";
import { addEffectItem, listEffectItems, removeEffectItem } from "@/lib/outbox/effects-store";
import { OFFLINE_VOID_ROLE_MESSAGE, canVoidOffline } from "@/lib/offline/offlineRules";
import { useOnlineStatus } from "@/hooks/use-online-status";
import type { ActiveSession } from "./active-sessions-grid";
import type { AppUser } from "@/context/auth-context";

interface VoidSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  session: ActiveSession;
  user: AppUser;
  storeId: string;
}

export function VoidSessionDialog({ isOpen, onClose, session, user, storeId }: VoidSessionDialogProps) {
  const { toast } = useToast();
  const { user: firebaseUser } = useAuthContext();
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isOnline = useOnlineStatus();

  const isLocked = session.isPaid;
  // T-425 (bible row 356): without the internet only a signed-in manager or admin may void an unpaid table; everyone else waits.
  const offlineRoleBlocked = !isOnline && !canVoidOffline(user.role);
  // T-424 Ruling 8: the SERVER decides who may void. A manager or admin (by their staff record) voids without a PIN; anyone else needs a store
  // manager's PIN. This only decides whether to show the pad.
  const needsPin = !(user.role === "manager" || user.role === "admin" || (user as any).isPlatformAdmin === true);

  const handleConfirm = async () => {
    const safeReason = (reason ?? '').toString().trim();
    if (!safeReason) {
      toast({ variant: 'destructive', title: 'Reason Required', description: 'Please provide a reason for voiding the session.' });
      return;
    }
    setIsSubmitting(true);
    try {
      if (isOnline) {
        const activeProjectionSnap = await getDoc(doc(db, "stores", storeId, "activeSessions", session.id));
        const currentPin = activeProjectionSnap.exists() ? String(activeProjectionSnap.data()?.customerPin || "") : "";

        // The loyalty reversal is queued BEFORE the void commits (a crash can no longer lose it), exactly as T-423 did; if the server refuses the
        // void, the entry we queued is taken back out.
        const sessionSnap = await getDoc(doc(db, "stores", storeId, "sessions", session.id));
        const redemptions = sessionSnap.exists() && Array.isArray((sessionSnap.data() as any)?.loyaltyRedemptions) ? (sessionSnap.data() as any).loyaltyRedemptions : [];
        const reversedRedemptionIds: string[] = redemptions.map((r: any) => r?.redemptionId).filter(Boolean);
        let queuedId: string | null = null;
        if (reversedRedemptionIds.length > 0 && !(await listEffectItems()).some((q) => q.sessionId === session.id && q.kind === "void")) {
          queuedId = (await addEffectItem({
            storeId,
            sessionId: session.id,
            receiptId: session.id,
            kind: "void",
            ctx: { amount: 0, redemptionIds: reversedRedemptionIds },
            effects: { analytics: "skip", loyaltyFinalize: "skip", loyaltyEarn: "skip", pinFinalize: "skip", loyaltyReverse: "pending" },
          })).id;
        }
        try {
          await postPos2("session-voids", { storeId, sessionId: session.id, reason: safeReason, ...(needsPin ? { pin } : {}) });
        } catch (voidErr) {
          // Only a DEFINITE refusal takes the queued reversal back out. No answer or a 5xx: the void may have committed, keep it (replay checks the
          // session first). "Already voided": the void happened, so carry on as success and let the reversal run.
          const outcome = voidOutcome(voidErr as { status?: unknown; message?: unknown });
          if (outcome === "refused" && queuedId) await removeEffectItem(queuedId);
          if (outcome !== "voided") throw voidErr;
        }
        const voidResult = { reversedRedemptionIds };

        // Refund any Sharelebrator rewards redeemed against this session.
        const redemptionIds = voidResult?.reversedRedemptionIds ?? [];
        if (firebaseUser && redemptionIds.length > 0) {
          const token = await firebaseUser.getIdToken();
          const results = await Promise.all(
            redemptionIds.map((redemptionId) =>
              fetch("/api/loyalty/redeem", {
                method: "DELETE",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ redemptionId, storeId, reason: "void" }),
              }).then((r) => r.ok).catch((e) => { console.warn("[Loyalty] reverse on void failed (non-fatal):", e); return false; }),
            ),
          );
          // T-423: voidSession queued this reversal before it committed. Done here => drop the queued copy; failed => the queue retries it.
          if (results.every(Boolean)) {
            for (const q of (await listEffectItems()).filter((x) => x.sessionId === session.id && x.kind === "void")) await removeEffectItem(q.id);
          }
        }

        if (firebaseUser && currentPin) {
          const token = await firebaseUser.getIdToken();
          const finalizeRes = await fetch("/api/pins/finalize", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              storeId,
              sessionId: session.id,
              pin: currentPin,
              reason: "session_voided",
            }),
          });
          if (!finalizeRes.ok) {
            const finalizeData = await finalizeRes.json().catch(() => ({}));
            console.warn("[PIN] Finalization failed after void (non-fatal):", finalizeData?.error);
          }
        }

        toast({ title: "Session Voided", description: "The session has been cancelled and the table is now free." });
        onClose();
      } else {
        const { reversedRedemptionIds, pin } = await voidSessionOffline({
          storeId,
          sessionId: session.id,
          reason: safeReason,
          actor: user,
        });
        await addEffectItem({
          storeId,
          sessionId: session.id,
          receiptId: session.id,
          kind: "void",
          ctx: { amount: 0, pin, redemptionIds: reversedRedemptionIds },
          effects: {
            analytics: "skip",
            loyaltyFinalize: "skip",
            loyaltyEarn: "skip",
            loyaltyReverse: reversedRedemptionIds.length > 0 ? "pending" : "skip",
            pinFinalize: pin ? "pending" : "skip",
          },
        });
        toast({ title: "Session Voided", description: "The session has been cancelled and the table is now free. Loyalty/PIN will sync when back online." });
        onClose();
      }
    } catch (error: any) {
      console.error("Failed to void session:", error);
      if (error instanceof Pos2Error && error.status === 403) setPin("");
      toast({ variant: 'destructive', title: 'Action Failed', description: error.message || String(error) });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void Session: Table {session.tableNumber}</DialogTitle>
          <DialogDescription>This action cannot be undone. All items will be cancelled and the table will be freed.</DialogDescription>
        </DialogHeader>
        {isLocked ? (
          <Alert variant="destructive">
            <AlertDescription>This session is already paid or closed and cannot be voided.</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-2 py-4">
            <Label htmlFor="void-reason">Reason</Label>
            <Input
              id="void-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Customer complaint, wrong order"
            />
            {offlineRoleBlocked && (
              <Alert variant="destructive" className="mt-3">
                <AlertDescription>{OFFLINE_VOID_ROLE_MESSAGE}</AlertDescription>
              </Alert>
            )}
            {needsPin && isOnline && (
              <div className="pt-3">
                <Label>Store manager PIN</Label>
                <p className="mb-2 text-xs text-muted-foreground">A store manager types their own ERP PIN. It is checked on the server and never saved.</p>
                <PinPad value={pin} onChange={setPin} disabled={isSubmitting} />
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isSubmitting || isLocked || offlineRoleBlocked || !reason.trim() || (isOnline && needsPin && pin.length !== PIN_LENGTH)}
          >
            {isSubmitting && <Loader2 className="mr-2 animate-spin" />}
            Confirm Void
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
