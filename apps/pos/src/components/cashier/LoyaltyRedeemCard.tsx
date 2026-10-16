"use client";

import { useCallback, useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { db } from "@/lib/firebase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Gift, Loader2, Sparkles, Ticket, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { isRewardOfferedAtStore } from "@/lib/loyaltyRewardScope";
import type { LoyaltyReward, SessionLoyaltyRedemption } from "@/lib/types";

interface Props {
  storeId: string;
  sessionId: string;
  linkedPhone: string | null | undefined;
  linkedName?: string | null;
  redemptions: SessionLoyaltyRedemption[];
  disabled?: boolean;
}

async function token(): Promise<string> {
  const u = getAuth().currentUser;
  if (!u) throw new Error("Not signed in.");
  return u.getIdToken();
}

function fmtReward(r: { type: "fixed" | "percent"; value: number }) {
  return r.type === "percent" ? `${r.value}% off` : `₱${r.value.toLocaleString()} off`;
}

export function LoyaltyRedeemCard({ storeId, sessionId, linkedPhone, linkedName, redemptions, disabled }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [voucherCode, setVoucherCode] = useState("");
  const [applyingVoucher, setApplyingVoucher] = useState(false);

  const load = useCallback(async () => {
    if (!linkedPhone) return;
    setLoading(true);
    try {
      const t = await token();
      const [lookupRes, rewardsSnap] = await Promise.all([
        // storeId is required for store-scoped staff since /pins customer
        // scoping landed; without it the lookup 400s and the balance silently
        // renders as 0 for every non-admin cashier.
        fetch(
          `/api/loyalty/lookup?phone=${encodeURIComponent(linkedPhone)}&storeId=${encodeURIComponent(storeId)}`,
          { headers: { Authorization: `Bearer ${t}` } },
        ),
        getDocs(collection(db, "loyaltyRewards")),
      ]);
      const lookup = await lookupRes.json().catch(() => ({}));
      setBalance(lookup?.found ? Number(lookup.customer?.pointsBalance ?? 0) : 0);
      setRewards(
        rewardsSnap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          // Store scoping, not just the global on/off switch: managers choose
          // which of the global rewards their branch offers.
          .filter((r: any) => isRewardOfferedAtStore(r, storeId))
          .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) as LoyaltyReward[],
      );
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not load rewards", description: e?.message });
    } finally {
      setLoading(false);
    }
  }, [linkedPhone, storeId, toast]);

  useEffect(() => {
    if (open && balance === null) void load();
  }, [open, balance, load]);

  const apply = async (reward: LoyaltyReward) => {
    if (!linkedPhone) return;
    setBusyId(reward.id);
    try {
      const t = await token();
      const res = await fetch("/api/loyalty/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ storeId, sessionId, phone: linkedPhone, rewardId: reward.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Redeem failed");
      toast({ title: "Reward applied", description: `${reward.name} — ${reward.pointsCost} pts` });
      setBalance(null); // refresh balance after the debit
    } catch (e: any) {
      toast({ variant: "destructive", title: "Redeem failed", description: e?.message });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (r: SessionLoyaltyRedemption) => {
    setBusyId(r.redemptionId);
    try {
      const t = await token();
      const res = await fetch("/api/loyalty/redeem", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ redemptionId: r.redemptionId, storeId, reason: "removed" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Remove failed");
      const refunded = Number(json?.refunded ?? 0);
      toast({
        title: "Reward removed",
        description: refunded > 0 ? `${refunded} pts refunded.` : "Voucher released — the code can be used again.",
      });
      setBalance(null);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Remove failed", description: e?.message });
    } finally {
      setBusyId(null);
    }
  };

  const applyVoucher = async () => {
    const code = voucherCode.trim().toUpperCase();
    if (!code) return;
    setApplyingVoucher(true);
    try {
      const t = await token();
      const res = await fetch("/api/loyalty/redeem-voucher", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ storeId, sessionId, code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Could not apply voucher");
      toast({ title: "Voucher applied", description: json.reward?.name });
      setVoucherCode("");
    } catch (e: any) {
      toast({ variant: "destructive", title: "Voucher failed", description: e?.message });
    } finally {
      setApplyingVoucher(false);
    }
  };

  if (!linkedPhone) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="h-4 w-4 text-primary" /> Sharelebrator
        </CardTitle>
        <CardDescription>{linkedName ? `${linkedName} · ` : ""}{linkedPhone}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Applied rewards */}
        {redemptions.length > 0 && (
          <ul className="space-y-1.5">
            {redemptions.map((r) => (
              <li key={r.redemptionId} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div className="min-w-0">
                  <div className="font-medium text-sm flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-amber-500" /> {r.rewardName}
                  </div>
                  <div className="text-xs text-muted-foreground">{fmtReward(r)} · {r.pointsCost} pts</div>
                </div>
                {!disabled && (
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => remove(r)} disabled={busyId === r.redemptionId}>
                    {busyId === r.redemptionId ? <Loader2 className="h-4 w-4 animate-spin" /> : <><X className="h-4 w-4 mr-1" /> Remove</>}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Add a reward */}
        {disabled ? (
          redemptions.length === 0 ? <p className="text-xs text-muted-foreground">Session is locked.</p> : null
        ) : !open ? (
          <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen(true)}>
            <Gift className="h-4 w-4 mr-2" /> {redemptions.length > 0 ? "Add another reward" : "Redeem a reward"}
          </Button>
        ) : loading ? (
          <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">Balance: <span className="font-semibold tabular-nums">{(balance ?? 0).toLocaleString()} pts</span></div>
            {rewards.length === 0 ? (
              <p className="text-xs text-muted-foreground">No rewards available.</p>
            ) : (
              <ul className="space-y-1.5">
                {rewards.map((r) => {
                  const affordable = (balance ?? 0) >= r.pointsCost;
                  return (
                    <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{r.name}</div>
                        <div className="text-xs text-muted-foreground">{fmtReward(r)} · {r.pointsCost} pts</div>
                      </div>
                      <Button size="sm" disabled={!affordable || busyId === r.id} onClick={() => apply(r)}>
                        {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : affordable ? "Apply" : "Short"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Button variant="ghost" size="sm" className="w-full" onClick={() => setOpen(false)}>Done</Button>
          </div>
        )}

        {/* Apply a Hub voucher by code */}
        {!disabled && (
          <div className="flex items-center gap-2 border-t pt-3">
            <Ticket className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              value={voucherCode}
              onChange={(e) => setVoucherCode(e.target.value.toUpperCase())}
              placeholder="Voucher code"
              className="h-8 text-sm uppercase"
              maxLength={8}
              disabled={applyingVoucher}
            />
            <Button size="sm" variant="outline" onClick={applyVoucher} disabled={applyingVoucher || voucherCode.trim().length === 0}>
              {applyingVoucher ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apply"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
