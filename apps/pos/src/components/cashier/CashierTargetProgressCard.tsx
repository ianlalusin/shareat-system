"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuthContext } from "@/context/auth-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Settings, ShoppingBasket, Target, TrendingUp } from "lucide-react";
import { TargetEditDialog, fmtPeso } from "./target-edit-dialog";

interface Props {
  storeId: string;
}

function getTodayDayId(): string {
  const manila = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const y = manila.getFullYear();
  const m = String(manila.getMonth() + 1).padStart(2, "0");
  const d = String(manila.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function getTodayDate(): string {
  const manila = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const y = manila.getFullYear();
  const m = String(manila.getMonth() + 1).padStart(2, "0");
  const d = String(manila.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function CashierTargetProgressCard({ storeId }: Props) {
  const { appUser } = useAuthContext();
  const [avgBasket, setAvgBasket] = useState<number | null>(null);
  const [actualSales, setActualSales] = useState<number>(0);
  const [forecastedSales, setForecastedSales] = useState<number | null>(null);
  const [targetSales, setTargetSales] = useState<number | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const canEditTarget =
    appUser?.role === "admin" || appUser?.role === "manager" || appUser?.isPlatformAdmin;

  // Today's analytics — actual sales + per-head dine-in avg basket
  useEffect(() => {
    if (!storeId) return;
    const dayId = getTodayDayId();
    const ref = doc(db, "stores", storeId, "analytics", dayId);
    return onSnapshot(ref, (snap) => {
      const data = snap.data() as any;
      const totalGross = Number(data?.payments?.totalGross ?? 0);
      setActualSales(totalGross);

      const guestCount = Number(data?.guests?.guestCountFinalTotal ?? 0);
      const dineInSalesGross = Number(data?.sales?.dineInSalesGross ?? 0);
      const dineInDiscounts = Number(data?.sales?.dineInDiscountsTotal ?? 0);
      const dineInCharges = Number(data?.sales?.dineInChargesTotal ?? 0);
      const dineInNet = dineInSalesGross - dineInDiscounts - dineInCharges;
      setAvgBasket(guestCount > 0 ? dineInNet / guestCount : 0);
    });
  }, [storeId]);

  // Today's forecast (live)
  useEffect(() => {
    if (!storeId) return;
    const today = getTodayDate();
    const ref = doc(db, "stores", storeId, "salesForecasts", today);
    return onSnapshot(ref, (snap) => {
      const data = snap.data() as any;
      setForecastedSales(data?.projectedSales ?? null);
    });
  }, [storeId]);

  // Today's manager target override (live)
  useEffect(() => {
    if (!storeId) return;
    const today = getTodayDate();
    const ref = doc(db, "stores", storeId, "salesTargets", today);
    return onSnapshot(ref, (snap) => {
      const data = snap.data() as any;
      const amt = Number(data?.amount ?? 0);
      setTargetSales(amt > 0 ? amt : null);
    });
  }, [storeId]);

  const goal = targetSales ?? forecastedSales ?? 0;
  const goalLabel = targetSales != null ? "TARGET" : "FORECAST";
  const percent = goal > 0 ? Math.min(999, (actualSales / goal) * 100) : 0;
  const displayPercent = Math.round(percent);

  const barColor =
    percent >= 100 ? "bg-green-500" : percent >= 50 ? "bg-blue-500" : "bg-zinc-400";
  const goalColor = targetSales != null ? "text-primary" : "text-foreground";

  return (
    <>
      <Card className="w-full sm:w-auto sm:min-w-[420px] sm:max-w-[520px]">
        <CardContent className="p-2 px-3">
          <div className="flex items-center gap-3">
            {/* Avg basket */}
            <div className="flex items-center gap-1.5 shrink-0">
              <ShoppingBasket className="h-4 w-4 text-muted-foreground" />
              <div className="leading-tight">
                <p className="text-[8px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Basket
                </p>
                <p className="text-sm font-bold tabular-nums leading-tight">
                  {avgBasket == null ? "—" : fmtPeso(avgBasket)}
                </p>
              </div>
            </div>

            <div className="h-7 w-px bg-border shrink-0" />

            {/* Center: actual / goal + progress bar */}
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-1 min-w-0">
                  <TrendingUp className="h-3.5 w-3.5 text-green-600 self-center" />
                  <span className="text-base font-black tabular-nums truncate">{fmtPeso(actualSales)}</span>
                </div>
                <div className="flex items-baseline gap-1 shrink-0">
                  <span className="text-[8px] uppercase tracking-wider text-muted-foreground font-semibold">
                    {goalLabel}
                  </span>
                  <span className={`text-sm font-bold tabular-nums ${goalColor}`}>
                    {goal > 0 ? fmtPeso(goal) : "—"}
                  </span>
                </div>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full ${barColor} transition-all duration-700`}
                  style={{ width: `${Math.min(100, percent)}%` }}
                />
              </div>
              <p className="text-[9px] text-muted-foreground leading-none">
                {goal > 0 ? `${displayPercent}% of ${goalLabel.toLowerCase()} today` : "Set a target or wait for the forecast"}
              </p>
            </div>

            {/* Gear */}
            {canEditTarget && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setEditOpen(true)}
                aria-label="Edit sales target"
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {canEditTarget && (
        <TargetEditDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          storeId={storeId}
          userUid={appUser?.uid ?? null}
          currentTargetAmount={targetSales}
        />
      )}
    </>
  );
}
