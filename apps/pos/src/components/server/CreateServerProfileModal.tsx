"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, UserPlus, ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { postServerProfileOp } from "@/lib/server-profiles/api";
import { PasscodePad } from "./PasscodePad";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  storeId: string;
  onCreated: (profileId: string, name: string) => void;
}

type Step = "name" | "passcode" | "confirm";

export function CreateServerProfileModal({ open, onOpenChange, storeId, onCreated }: Props) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [firstPasscode, setFirstPasscode] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const [shake, setShake] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setStep("name");
      setName("");
      setFirstPasscode("");
      setResetToken(t => t + 1);
      setShake(false);
    }
  }, [open]);

  const handleFirstComplete = (pc: string) => {
    setFirstPasscode(pc);
    setStep("confirm");
    setResetToken(t => t + 1);
  };

  const handleConfirmComplete = async (pc: string) => {
    if (pc !== firstPasscode) {
      setShake(true);
      setTimeout(() => setShake(false), 450);
      setResetToken(t => t + 1);
      toast({ title: "Passcodes don't match", description: "Try again.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const trimmedName = name.trim();

      // Creation (and the duplicate-name check that keeps attribution
      // unambiguous) runs server-side, so the passcode hash is never written
      // from, or readable by, a client.
      const json = await postServerProfileOp({
        op: "create",
        storeId,
        name: trimmedName,
        passcode: pc,
      });

      toast({ title: "Profile created", description: `Signed in as ${trimmedName}.` });
      onCreated(json.profile.id, trimmedName);
      onOpenChange(false);
    } catch (err: any) {
      // A duplicate name is a correctable mistake, not a failure — send them
      // back to the name step rather than closing the flow.
      if (err?.status === 409) {
        toast({ title: "Name already exists", description: err.message, variant: "destructive" });
        setStep("name");
        setResetToken((t) => t + 1);
        return;
      }
      toast({ title: "Error", description: err?.message || "Could not create profile.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            {step === "name" ? "New local user" : step === "passcode" ? "Choose a 6-digit passcode" : "Confirm passcode"}
          </DialogTitle>
          <DialogDescription>
            {step === "name"
              ? "Your name shows on this device while you're signed in. Store-local, no email linked."
              : step === "passcode"
              ? "You'll enter this to sign back in later."
              : "Enter the same 6 digits again."}
          </DialogDescription>
        </DialogHeader>

        {step === "name" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Ian Lalusin"
                maxLength={40}
              />
            </div>
            <Button className="w-full" disabled={name.trim().length < 2} onClick={() => { setStep("passcode"); setResetToken(t => t + 1); }}>
              Continue
            </Button>
          </div>
        )}

        {step === "passcode" && (
          <div className="space-y-3">
            <PasscodePad onComplete={handleFirstComplete} resetToken={resetToken} isProcessing={saving} />
            <Button variant="ghost" size="sm" className="w-full" onClick={() => setStep("name")} disabled={saving}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Back
            </Button>
          </div>
        )}

        {step === "confirm" && (
          <div className="space-y-3">
            <PasscodePad onComplete={handleConfirmComplete} resetToken={resetToken} shake={shake} isProcessing={saving} />
            {saving && (
              <p className="text-xs text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Saving profile…
              </p>
            )}
            <Button variant="ghost" size="sm" className="w-full" onClick={() => { setStep("passcode"); setResetToken(t => t + 1); }} disabled={saving}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Re-enter first passcode
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
