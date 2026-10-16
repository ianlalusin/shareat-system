
"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, PlusCircle, AlarmClock } from "lucide-react";
import { toJsDate } from "@/lib/utils/date";
import type { PendingSession } from "@/lib/types";
import { GuestCountModal } from "./GuestCountModal";

export function formatElapsedShort(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "0s";
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}h ${remM}m`;
}

export const PendingTimer = ({ startMs }: { startMs: number | null }) => {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (startMs == null) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [startMs]);
    if (startMs == null) return <span>—</span>;
    return <span className="tabular-nums">{formatElapsedShort(Math.max(0, now - startMs))}</span>;
};

export const TimeElapsed = ({ startTime, startTimeMs }: { startTime: any, startTimeMs: number | null }) => {
    const [elapsed, setElapsed] = useState("...");
    const jsDate = startTimeMs ? new Date(startTimeMs) : toJsDate(startTime);

    useEffect(() => {
        if (!jsDate) {
            setElapsed("...");
            return;
        }

        const updateElapsed = () => {
            const now = Date.now();
            const totalMinutes = Math.floor((now - jsDate.getTime()) / 60000);

            if (totalMinutes < 0) {
                setElapsed("0m");
                return;
            }

            if (totalMinutes < 60) {
                setElapsed(`${totalMinutes}m`);
            } else {
                const hours = Math.floor(totalMinutes / 60);
                const minutes = totalMinutes % 60;
                const paddedMinutes = minutes < 10 ? `0${minutes}` : minutes;
                setElapsed(`${hours}h ${paddedMinutes}m`);
            }
        };

        updateElapsed();
        const timer = setInterval(updateElapsed, 30000);

        return () => clearInterval(timer);
    }, [jsDate]);

    return (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock size={12} />
            {elapsed}
        </div>
    );
};

export function SessionCard({ session, onVerify, onRequestChange, onViewTimeline, onAddRefill, onAddAddon }: {
    session: PendingSession;
    onVerify: (session: PendingSession, serverCount: number) => void;
    onRequestChange: (session: PendingSession) => void;
    onViewTimeline: (sessionId: string) => void;
    onAddRefill: (session: PendingSession) => void;
    onAddAddon: (session: PendingSession) => void;
}) {
    const [countModalOpen, setCountModalOpen] = useState(false);

    const getStatusBadge = (session: PendingSession) => {
      if (session.status === 'active') {
          if (session.guestCountChange?.status === 'pending') {
              return <Badge variant="destructive" className="ml-auto">Guest Change Pending</Badge>
          }
           if (session.packageChange?.status === 'pending') {
              return <Badge variant="destructive" className="ml-auto">Package Change Pending</Badge>
          }
          return <TimeElapsed startTime={session.startedAt} startTimeMs={session.startedAtClientMs ?? null} />;
      }
      return null;
    }

    const cashierCount = Number(session.guestCountCashierInitial ?? 0);
    const guestCount = Number(session.guestCountFinal ?? cashierCount);
    const isLocked = session.status === 'closed' || session.isPaid === true;

    const isAlaCarte = session.sessionMode === 'alacarte';
    const tableLabel = session.tableDisplayName || `Table ${session.tableNumber}`;
    const displayLocation = isAlaCarte ? (`${session.customerName} (Ala Carte)` || 'Ala Carte') : tableLabel;

    if (session.status === 'pending_verification') {
        return (
            <>
                <Card
                    key={session.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setCountModalOpen(true)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCountModalOpen(true); } }}
                    className="bg-red-50 border-2 border-red-500 hover:bg-red-100 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                >
                    <CardContent className="p-4 text-center">
                        <p className="text-2xl font-black text-red-600 tracking-tight truncate">{tableLabel}</p>
                        <p className="mt-1 text-sm font-semibold text-red-900/80 truncate">{session.packageName}</p>
                        <p className="mt-1 flex items-center justify-center gap-1 text-xs font-semibold text-red-700">
                            <AlarmClock className="h-3.5 w-3.5" />
                            Waiting <PendingTimer startMs={session.startedAtClientMs ?? toJsDate(session.startedAt)?.getTime() ?? null} />
                        </p>
                        <p className="mt-1 text-[10px] uppercase tracking-wider text-red-700/70">Tap to count guests</p>
                    </CardContent>
                </Card>
                <GuestCountModal
                    open={countModalOpen}
                    onOpenChange={setCountModalOpen}
                    tableLabel={tableLabel}
                    onConfirm={(count) => {
                        setCountModalOpen(false);
                        onVerify(session, count);
                    }}
                />
            </>
        );
    }

    const cardTitle = session.status === 'active'
        ? (isAlaCarte ? displayLocation : `${displayLocation} - ${guestCount}pax`)
        : displayLocation;

    return (
         <Card key={session.id} className="bg-background">
            <CardHeader className="pb-2 pt-4">
              <div className="flex items-center">
                  <CardTitle className="text-xl">
                      {cardTitle}
                  </CardTitle>
                   <div className="ml-auto flex items-center gap-2">
                        {getStatusBadge(session)}
                    </div>
              </div>
               <p className="font-bold text-base">{session.packageName}</p>
            </CardHeader>
            {session.status === 'active' && <CardContent className="p-0"/>}
            <CardFooter className="flex-col items-stretch space-y-2 pt-2 pb-4">
                <div className="flex gap-2 w-full">
                    <Button variant="outline" className="flex-1" onClick={() => onAddRefill(session)} disabled={isLocked}><PlusCircle className="mr-2" /> Refill</Button>
                    <Button variant="outline" className="flex-1" onClick={() => onAddAddon(session)} disabled={isLocked}><PlusCircle className="mr-2" /> Add-on</Button>
                </div>
                {session.status === 'active' && (
                    <Button variant="secondary" className="w-full" onClick={() => onRequestChange(session)} disabled={isLocked}>Request Change</Button>
                )}
            </CardFooter>
          </Card>
    )
}
