"use client";

import { useEffect, useState } from "react";
import { getAuth } from "firebase/auth";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { useAuthContext } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { sanitizeDeliveryConfig, type DeliveryConfig } from "@/lib/storefront/delivery-config";

// Full raw config as stored on stores/{storeId}/storefrontConfig/main. Wider
// than DeliveryConfig — pickupEnabled/deliveryEnabled are NOT edited by this
// dialog (they're owned by the separate on/off switches on the Online Orders
// page header) but MUST be read and re-submitted unchanged. set-config
// rebuilds every field it knows about from the request body, defaulting the
// ones the body omits, so `merge: true` does not protect them: dropping these
// two here would silently turn delivery/pickup back on/off.
type FullConfig = DeliveryConfig & { pickupEnabled: boolean; deliveryEnabled: boolean };

// Both booleans default to TRUE here, matching how every READER of this doc
// interprets an absent field (functions/index.js:140-141,
// OnlineOrdersClient.tsx:414 — both `!== false`). Defaulting deliveryEnabled
// to false would be the opt-in reading that set-config writes, and using it
// here would turn delivery OFF for every store that has never touched the
// pause toggle — which is almost all of them, since nothing wrote the field
// before today. This value is only reached if the load fails, and `loadError`
// blocks saving in that case, but it must still be the safe default.
const EMPTY: FullConfig = {
  pickupEnabled: true,
  deliveryEnabled: true,
  deliveryFee: 0,
  minOrder: 0,
  prepEtaMinutes: 0,
  serviceAreaNote: "",
};

const EMPTY_FORM = { deliveryFee: "0", minOrder: "0", prepEtaMinutes: "0", serviceAreaNote: "" };

export function DeliveryPricingSettings({
  storeId,
  open,
  onClose,
}: {
  storeId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { user } = useAuthContext();
  const { toast } = useToast();
  // Starts true (not false) so the very first render of a freshly-opened
  // dialog shows the spinner, not a one-frame flash of EMPTY defaults or a
  // previous store's leftover config before the load effect below has had a
  // chance to run. See the effect's `!open` branch for how this stays
  // correctly armed across close/reopen and store switches too.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<FullConfig>(EMPTY);
  const [form, setForm] = useState(EMPTY_FORM);

  // Refetches on every open (`open` is a dep), and resets both config and the
  // form to a clean slate first, so a second open can never show — or submit —
  // values left over from a previous open of a different store.
  useEffect(() => {
    if (!open || !storeId) {
      // Dialog is closed (or has no store yet) — Radix doesn't mount
      // DialogContent while `open` is false, so nothing is visibly shown
      // regardless of `loading` here. But pre-arm `loading` back to true
      // now, while nothing is on screen, rather than waiting for the next
      // open to do it: `storeId` can change while this dialog stays closed
      // (e.g. an admin switches stores via the store picker without this
      // component unmounting), and if we waited for the branch below to
      // reset on open, the very first paint after the NEXT open would still
      // show the previous store's stale config/loading=false for one frame
      // before this effect re-runs. Setting it here closes that window.
      setLoading(true);
      return;
    }
    let cancelled = false;
    setConfig(EMPTY);
    setForm(EMPTY_FORM);
    setLoadError(null);
    setLoading(true);
    (async () => {
      try {
        const u = user || getAuth().currentUser;
        if (!u) throw new Error("Not signed in.");
        const idToken = await u.getIdToken();
        const res = await fetch("/api/admin/storefront-catalog", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ op: "get", storeId }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json?.ok) throw new Error(json?.error || `Load failed (${res.status})`);
        const c: Partial<FullConfig> = json.config || {};
        const full: FullConfig = {
          // BOTH booleans read with `!== false` — the opt-out reading every
          // other consumer of this doc uses. `!!c.deliveryEnabled` here would
          // silently disable delivery on save for any store whose config doc
          // has no deliveryEnabled field yet. See Global Constraints.
          pickupEnabled: c.pickupEnabled !== false,
          deliveryEnabled: c.deliveryEnabled !== false,
          deliveryFee: Number(c.deliveryFee) || 0,
          minOrder: Number(c.minOrder) || 0,
          prepEtaMinutes: Number(c.prepEtaMinutes) || 0,
          serviceAreaNote: String(c.serviceAreaNote || ""),
        };
        if (cancelled) return;
        setConfig(full);
        setForm({
          deliveryFee: String(full.deliveryFee),
          minOrder: String(full.minOrder),
          prepEtaMinutes: String(full.prepEtaMinutes),
          serviceAreaNote: full.serviceAreaNote,
        });
      } catch (e: any) {
        if (!cancelled) {
          // Record it, not just toast it: saving on top of a failed load would
          // write EMPTY over the store's real fee/minOrder. Save stays disabled.
          setLoadError(e?.message || "Could not load settings.");
          toast({ variant: "destructive", title: "Could not load settings", description: e?.message });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, storeId, user, toast]);

  const handleSave = async () => {
    if (saving || loadError) return;
    const clean = sanitizeDeliveryConfig(form);
    setSaving(true);
    try {
      const u = user || getAuth().currentUser;
      if (!u) throw new Error("Not signed in.");
      const idToken = await u.getIdToken();

      // Re-read pickupEnabled/deliveryEnabled immediately before writing,
      // instead of trusting the `config` this dialog loaded when it first
      // opened. That `config` can go stale: e.g. a cashier flips the
      // separate "pause delivery" switch on the Online Orders page while
      // this dialog is still open (no rider on shift), then this manager
      // finishes editing the fee and clicks Save. set-config rebuilds the
      // whole document from the request body, so submitting the dialog's
      // load-time boolean here would silently re-enable delivery over the
      // cashier's change. A failed re-fetch aborts the save rather than
      // falling back to the stale `config` state — see catch below.
      const freshRes = await fetch("/api/admin/storefront-catalog", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op: "get", storeId }),
      });
      const freshJson = await freshRes.json().catch(() => ({}));
      if (!freshRes.ok || !freshJson?.ok) {
        throw new Error(freshJson?.error || `Could not confirm current settings before saving (${freshRes.status}).`);
      }
      const freshConfig: Partial<FullConfig> = freshJson.config || {};
      // Same opt-out `!== false` reading used everywhere else in this file
      // (see the FullConfig / EMPTY comments above) — never `!!`.
      const payload: FullConfig = {
        pickupEnabled: freshConfig.pickupEnabled !== false,
        deliveryEnabled: freshConfig.deliveryEnabled !== false,
        ...clean,
      };
      const res = await fetch("/api/admin/storefront-catalog", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op: "set-config", storeId, config: payload }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Save failed (${res.status})`);
      toast({ title: "Delivery & pricing settings saved" });
      onClose();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not save settings", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delivery & Pricing</DialogTitle>
          <DialogDescription>
            Fee, minimum order, and prep-time baseline for this branch's online orders. The prep time shown to
            customers is this baseline plus a live bump for how busy the kitchen currently is.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : loadError ? (
          <div className="py-6 text-center text-sm text-destructive">
            {loadError}
            <p className="mt-1 text-xs text-muted-foreground">Close and reopen to try again — saving is disabled so nothing gets overwritten.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="deliveryFee">Delivery fee (₱)</Label>
              <Input
                id="deliveryFee"
                inputMode="decimal"
                value={form.deliveryFee}
                onChange={(e) => setForm((f) => ({ ...f, deliveryFee: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="minOrder">Minimum order (₱)</Label>
              <Input
                id="minOrder"
                inputMode="decimal"
                value={form.minOrder}
                onChange={(e) => setForm((f) => ({ ...f, minOrder: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prepEtaMinutes">Baseline prep time (minutes)</Label>
              <Input
                id="prepEtaMinutes"
                inputMode="numeric"
                value={form.prepEtaMinutes}
                onChange={(e) => setForm((f) => ({ ...f, prepEtaMinutes: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">0 = don't show a prep-time estimate to customers.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="serviceAreaNote">Service area note</Label>
              <Textarea
                id="serviceAreaNote"
                rows={2}
                maxLength={300}
                value={form.serviceAreaNote}
                onChange={(e) => setForm((f) => ({ ...f, serviceAreaNote: e.target.value }))}
                placeholder="e.g. Delivery covers Lipa proper only"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={handleSave} disabled={loading || saving || !!loadError}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
