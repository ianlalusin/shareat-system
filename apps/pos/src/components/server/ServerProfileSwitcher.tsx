"use client";

import { useCallback, useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ArrowLeft, LogOut, Plus, UserCircle2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { postServerProfileOp } from "@/lib/server-profiles/api";
import { PasscodePad } from "./PasscodePad";
import { CreateServerProfileModal } from "./CreateServerProfileModal";

/** No passcodeHash: the secret is server-side only and never sent to clients. */
interface ProfileDoc {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  storeId: string;
  currentProfileId: string | null;
  onSignIn: (profileId: string, name: string) => void;
  onSignOut: () => void;
}

export function ServerProfileSwitcher({ open, onOpenChange, storeId, currentProfileId, onSignIn, onSignOut }: Props) {
  const [profiles, setProfiles] = useState<ProfileDoc[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selected, setSelected] = useState<ProfileDoc | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [shake, setShake] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setShake(false);
    }
  }, [open]);

  // Fetch the roster on demand (when the dialog opens) instead of holding a
  // persistent listener — the profile list changes rarely, so a one-shot read
  // per open is far cheaper than an always-on snapshot subscription.
  const loadProfiles = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const snap = await getDocs(collection(db, "stores", storeId, "serverProfiles"));
      const rows = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .filter((p) => typeof p.name === "string" && p.name.trim().length > 0);
      rows.sort((a, b) => a.name.localeCompare(b.name));
      setProfiles(rows);
    } catch (err) {
      console.error("[ServerProfileSwitcher] load error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    if (open) void loadProfiles();
  }, [open, loadProfiles]);

  // Verification happens server-side. The passcode hash is deliberately not
  // readable here any more: it protects a 6-digit code, so a client-side
  // comparison meant anyone who could read the roster could crack every
  // colleague's passcode offline in under a second.
  const handlePasscodeComplete = async (passcode: string) => {
    if (!selected) return;
    setVerifying(true);
    try {
      const json = await postServerProfileOp({
        op: "verify",
        storeId,
        profileId: selected.id,
        passcode,
      });
      onSignIn(selected.id, json.profile?.name ?? selected.name);
      onOpenChange(false);
    } catch (err: any) {
      setShake(true);
      setTimeout(() => setShake(false), 450);
      setResetToken(t => t + 1);
      // A plain wrong passcode just shakes the pad, as before. Lockout (429)
      // and anything unexpected need words, or it looks like the pad is broken.
      if (err?.status === 429) {
        toast({ variant: "destructive", title: "Locked", description: err.message });
      } else if (err?.status !== 401) {
        toast({
          variant: "destructive",
          title: "Sign-in Failed",
          description: err?.message || "Could not verify the passcode.",
        });
      }
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCircle2 className="h-5 w-5 text-primary" />
              {selected ? `Enter passcode for ${selected.name}` : "Who's using this tablet?"}
            </DialogTitle>
            <DialogDescription>
              {selected
                ? "6-digit passcode."
                : "Tap your name, or create a new local user."}
            </DialogDescription>
          </DialogHeader>

          {!selected && (
            <div className="space-y-2">
              {isLoading ? (
                <p className="text-sm text-muted-foreground flex items-center gap-2 py-6 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading profiles…
                </p>
              ) : profiles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No profiles yet on this store.</p>
              ) : (
                <div className="max-h-64 overflow-y-auto -mx-6 px-6 space-y-1">
                  {profiles.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { setSelected(p); setResetToken(t => t + 1); }}
                      className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-yellow-100 hover:border-yellow-300 hover:text-foreground transition text-left"
                    >
                      <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">
                        {p.name.slice(0, 1).toUpperCase()}
                      </div>
                      <span className="font-medium">{p.name}</span>
                    </button>
                  ))}
                </div>
              )}

              <Button variant="outline" className="w-full" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> Create new local user
              </Button>

              {currentProfileId && (
                <Button variant="ghost" className="w-full text-destructive hover:text-destructive" onClick={() => { onSignOut(); onOpenChange(false); }}>
                  <LogOut className="h-4 w-4 mr-1" /> Sign out
                </Button>
              )}
            </div>
          )}

          {selected && (
            <div className="space-y-3">
              <PasscodePad
                onComplete={handlePasscodeComplete}
                resetToken={resetToken}
                shake={shake}
                isProcessing={verifying}
              />
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setSelected(null)} disabled={verifying}>
                <ArrowLeft className="h-4 w-4 mr-1" /> Back to profiles
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <CreateServerProfileModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        storeId={storeId}
        onCreated={(id, name) => {
          setCreateOpen(false);
          onSignIn(id, name);
          onOpenChange(false);
        }}
      />
    </>
  );
}
