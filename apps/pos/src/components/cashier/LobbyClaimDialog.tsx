"use client";

/**
 * T-455 S7b - the cashier's side of a diner's senior / PWD discount claim: the T-426 dialog, pre-filled from the claim.
 * The name and ID number live ONLY in this component's state while it is open: closing resets the form and drops the opened claim,
 * and the card mounts this dialog only while a claim is open. Nothing is stored, logged or passed up in props.
 * Save = write the T-426 diner through `mutateStatutoryDiners` (the one transactional writer), THEN approve the claim; if approve is
 * refused the diner stays on the bill and the dialog says the claim was not confirmed. Reject uses the fixed reason chips only.
 */
import { useEffect, useRef, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";
import { db } from "@/lib/firebase/client";
import { postPos2 } from "@/lib/pos2/client";
import { mutateStatutoryDiners } from "@/lib/statutory/mutations";
import { normalizeIdNo, resolveHeads } from "@/lib/statutory/capture";
import {
  LOBBY_REJECT_REASONS,
  approveClaimFlow,
  claimFailure,
  claimSaveBlock,
  emptyClaimForm,
  prefillFromClaim,
  rejectClaimFlow,
  type ClaimForm,
  type ClaimKind,
  type OpenedClaim,
} from "@/lib/pos2/lobbyClaims";
import { getActorStamp } from "./firestore";
import type { PendingSession } from "@/lib/types";

interface Props {
  storeId: string;
  claimId: string;
  /** Called when the dialog closes; `changed` is true after an approve or a reject so the card can refresh at once. */
  onClose: (changed: boolean) => void;
}

type OpenedAnswer = { claimId: string; kind: ClaimKind; holderName: string; idNumber: string; sessionRef: string | null; partySize: number };
type Err = { status?: unknown; message?: unknown };

export function LobbyClaimDialog({ storeId, claimId, onClose }: Props) {
  const { toast } = useToast();
  const { appUser } = useAuthContext();
  const [opened, setOpened] = useState<OpenedClaim | null>(null);
  const [form, setForm] = useState<ClaimForm>(emptyClaimForm());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const busyNow = useRef(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await postPos2<OpenedAnswer>("lobby/claim-open", { storeId, claimId });
        if (!live) return;
        const view: OpenedClaim = { claimId: r.claimId, kind: r.kind, holderName: r.holderName, idNumber: r.idNumber, sessionRef: r.sessionRef, partySize: r.partySize };
        setOpened(view);
        setForm(prefillFromClaim(view));
      } catch (err) {
        if (live) setProblem(claimFailure(err as Err).message);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [storeId, claimId]);

  // Closing wipes the name and ID number from memory.
  const close = (changed: boolean) => {
    setOpened(null);
    setForm(emptyClaimForm());
    onClose(changed);
  };

  const saveBlock = claimSaveBlock(form, opened?.sessionRef ?? null);

  const handleSave = async () => {
    if (!opened || !appUser || busyNow.current || !saveBlock.ok || !opened.sessionRef) return;
    busyNow.current = true;
    setBusy(true);
    setProblem("");
    const sessionRef = opened.sessionRef;
    try {
      const snap = await getDoc(doc(db, "stores", storeId, "sessions", sessionRef));
      const session = snap.exists() ? (snap.data() as PendingSession) : null;
      if (!session) {
        setProblem("This table's session could not be found. Refresh and try again.");
        return;
      }
      const diners = (session.statutoryDiners ?? []).map((d) => ({ id: d.id, idNo: d.idNo }));
      const heads = resolveHeads(session) ?? undefined;
      const actor = getActorStamp(appUser);
      const r = await approveClaimFlow({
        open: opened,
        form,
        diners,
        addDiner: async (entry) => {
          // Heads are only read when the session has none yet; a seated party's size is the fallback.
          await mutateStatutoryDiners(storeId, sessionRef, { uid: actor.uid, name: actor.username, role: appUser.role ?? "" }, {
            type: "add",
            entry,
            heads: heads ?? opened.partySize ?? 1,
          });
          const after = await getDoc(doc(db, "stores", storeId, "sessions", sessionRef));
          const list = ((after.data() as PendingSession | undefined)?.statutoryDiners ?? []) as { id: string; idNo: string }[];
          const found = list.find((d) => normalizeIdNo(d.idNo) === normalizeIdNo(entry.idNo));
          if (!found) throw new Error("Could not confirm the diner was saved. Check the diner list before trying again.");
          return { dinerId: found.id };
        },
        approve: (b) => postPos2("lobby/claim-approve", { storeId, claimId: b.claimId, cardSeen: b.cardSeen, sessionId: b.sessionRef, statutoryDinerId: b.statutoryDinerRef }),
        // A retried approve whose first call worked but whose answer was lost: done only when the server says this claim is approved.
        isApproved: async (id) => (await postPos2<{ status: string }>("lobby/claim-status", { storeId, claimId: id })).status === "approved",
      });
      if (r.done) {
        toast({ title: "Discount claim approved" });
        close(true);
      } else {
        setProblem(r.message);
      }
    } catch (err) {
      setProblem(claimFailure(err as Err).message);
    } finally {
      busyNow.current = false;
      setBusy(false);
    }
  };

  const handleReject = async (reasonCode: string) => {
    if (!opened || busyNow.current) return;
    busyNow.current = true;
    setBusy(true);
    setProblem("");
    try {
      const r = await rejectClaimFlow({ claimId: opened.claimId, reasonCode, reject: (b) => postPos2("lobby/claim-reject", { storeId, ...b }) });
      if (r.done) {
        toast({ title: "Discount claim declined" });
        close(true);
      } else {
        setProblem(r.message);
      }
    } finally {
      busyNow.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) close(false); }}>
      <DialogContent className="max-w-md bg-white p-4">
        <DialogHeader>
          <DialogTitle>Senior / PWD discount claim</DialogTitle>
          <DialogDescription>Check the diner&apos;s card against what they typed. Fix anything that is wrong before saving.</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : !opened ? (
          <p role="alert" className="text-sm text-destructive">{problem || "Could not open this claim."}</p>
        ) : (
          <div className="space-y-3">
            {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
            {!opened.sessionRef && <p role="status" className="text-sm">{saveBlock.ok ? "" : saveBlock.message}</p>}
            <div className="space-y-1">
              <Label htmlFor="claim-kind">Kind</Label>
              <select
                id="claim-kind"
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as ClaimKind }))}
                disabled={busy}
                className="min-h-11 w-full rounded-md border bg-white px-3 text-sm"
              >
                <option value="senior">Senior</option>
                <option value="pwd">PWD</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="claim-name">Full name</Label>
              <Input id="claim-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} disabled={busy} autoComplete="off" className="min-h-11" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="claim-id">ID number</Label>
              <Input id="claim-id" value={form.idNo} onChange={(e) => setForm((f) => ({ ...f, idNo: e.target.value }))} disabled={busy} autoComplete="off" className="min-h-11" />
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.cardSeen}
                onChange={(e) => setForm((f) => ({ ...f, cardSeen: e.target.checked }))}
                disabled={busy}
                className="h-5 w-5"
              />
              I have seen the card
            </label>
            <Button className="min-h-11 w-full" onClick={handleSave} disabled={busy || !saveBlock.ok}>
              {busy ? "Saving…" : "Save and approve"}
            </Button>
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs text-muted-foreground">Or decline. The diner will read the sentence you pick.</p>
              <div className="flex flex-col gap-2">
                {LOBBY_REJECT_REASONS.map((r) => (
                  <Button key={r.code} type="button" variant="outline" className="min-h-11 h-auto whitespace-normal text-left" disabled={busy} onClick={() => handleReject(r.code)}>
                    {r.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
