"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Timer } from "lucide-react";
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";
import { formatElapsedShort } from "./SessionCard";

interface Props {
  storeId: string;
}

export function VerifyAverageCard({ storeId }: Props) {
  const [avgMs, setAvgMs] = useState<number | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!storeId) return;
    const dayId = getDayIdFromTimestamp(new Date());
    const q = query(
      collection(db, "stores", storeId, "activityLogsByDay", dayId, "logs"),
      where("action", "==", "SESSION_VERIFIED")
    );
    const unsub = onSnapshot(q, (snap) => {
      const durations = snap.docs
        .map(d => (d.data() as any)?.meta?.verifyDurationMs)
        .filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
      if (durations.length === 0) {
        setAvgMs(null);
        setCount(0);
        return;
      }
      const sum = durations.reduce((s, v) => s + v, 0);
      setAvgMs(sum / durations.length);
      setCount(durations.length);
    }, (err) => {
      console.error("[VerifyAverageCard] snapshot error:", err);
    });
    return () => unsub();
  }, [storeId]);

  const label = avgMs == null ? "—" : formatElapsedShort(avgMs);

  return (
    <Card>
      <CardContent className="p-2 pl-3 flex items-center gap-2">
        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
          <Timer className="h-5 w-5" />
        </div>
        <div className="leading-tight pr-2">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Avg verify · today</p>
          <p className="text-sm font-bold tabular-nums">
            {label}
            {count > 0 && <span className="text-[10px] text-muted-foreground font-normal ml-1">({count})</span>}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
