"use client";
import { doc, getDoc, getDocFromServer } from "firebase/firestore";
import { usePaymentQueueSync } from "@/hooks/use-payment-queue-sync";
import { replayDeferredEffects } from "@/lib/offline/replayDeferredEffects";
import { updateQueueItem } from "@/lib/offline/payment-queue";
import { useAuthContext } from "@/context/auth-context";
import { db } from "@/lib/firebase/client";

export function PaymentQueueSyncProvider() {
  const { user: firebaseUser } = useAuthContext();

  usePaymentQueueSync(async (item) => {
    if (!firebaseUser) return { item, complete: false }; // transient: auth not ready

    // Guardrail 5a: only a NETWORK/read failure is transient; a genuine online
    // final receipt is a terminal conflict. Void items have no receipt — skip.
    if (item.kind !== "void") {
      let receiptSnap;
      try {
        receiptSnap = await getDoc(doc(db, "stores", item.storeId, "receipts", item.sessionId));
      } catch {
        return { item, complete: false }; // transient read failure — retry later
      }
      if (receiptSnap.exists()) {
        const r: any = receiptSnap.data();
        if (r.status === "final" && r.offlineOrigin !== true) {
          throw new Error(`Server already has an online receipt for session ${item.sessionId}; offline effects skipped (conflict).`);
        }
      }
    }

    return await replayDeferredEffects(item, {
      getToken: () => firebaseUser.getIdToken(),
      isSessionVoided: async (storeId, sessionId) => {
        const snap = await getDocFromServer(doc(db, "stores", storeId, "sessions", sessionId));
        return snap.exists() && (snap.data() as any)?.status === "voided";
      },
      onEffectDone: (updated) => updateQueueItem(updated.id, { effects: updated.effects }),
    });
  }, !!firebaseUser);

  return null;
}
