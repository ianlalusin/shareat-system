
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useRouter } from "next/navigation";
import { Timestamp } from "firebase/firestore";
import { useState, useEffect } from "react";
import { Clock, Ban, Scissors, Gift, Tag, Users, Package, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { toJsDate } from "@/lib/utils/date";
import { useAuthContext } from "@/context/auth-context";
import { VoidSessionDialog } from "./void-session-dialog";
import { Button } from "../ui/button";
import { CardPill } from "./CardPill";
import { LinkCardDialog } from "./LinkCardDialog";
import { sessionDialogLabel } from "@/lib/sessionLabel";

export type ActiveSession = {
    id: string;
    storeId: string;
    tableNumber: string;
    tableDisplayName?: string | null;
    status: 'active' | 'pending_verification';
    sessionMode: 'package_dinein' | 'alacarte';
    customer?: { name?: string | null };
    customerName?: string | null;
    currentSessionId: string | null;
    startedAt?: Timestamp | null;
    startedAtClientMs?: number | null;
    packageName?: string;
    guestCountCashierInitial?: number;
    guestCountServerVerified?: number | null;
    guestCountFinal?: number | null;
    isPaid?: boolean;
    guestCountChange?: { status?: string } | null;
    packageChange?: { status?: string } | null;
    // Bill-line adjustment summary, maintained at write time by
    // `recomputeSessionAdjustmentFlags`. Drives the badges below the title
    // without needing a per-session sessionBillLines listener.
    hasVoids?: boolean;
    hasFree?: boolean;
    hasDiscounts?: boolean;
    linkedCustomerPhone?: string | null;
    linkedCustomerName?: string | null;
    linkedBy?: string | null;
};

const TimeElapsed = ({ startTime, startTimeMs }: { startTime: any, startTimeMs: number | null }) => {
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

            if (totalMinutes < 0) { // Handle case where client time is behind server time
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
        const timer = setInterval(updateElapsed, 30000); // Update every 30 seconds

        return () => clearInterval(timer);
    }, [jsDate]);

    return (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock size={12} />
            {elapsed}
        </div>
    );
};

export function ActiveSessionsGrid({ sessions, storeId }: { sessions: ActiveSession[]; storeId: string }) {
    const router = useRouter();
    const { appUser } = useAuthContext();
    const [voidingSession, setVoidingSession] = useState<ActiveSession | null>(null);
    const [linkingSession, setLinkingSession] = useState<ActiveSession | null>(null);
    const canLink = appUser?.role === 'admin' || appUser?.role === 'manager' || appUser?.role === 'cashier';

    const canVoid = appUser?.role === 'admin' || appUser?.role === 'manager';

    const handleVoidClick = (e: React.MouseEvent, session: ActiveSession) => {
        e.stopPropagation(); // Prevent navigation
        setVoidingSession(session);
    };

    const activeAndPendingSessions = sessions.filter(s => s.status === 'active' || s.status === 'pending_verification');

    if (activeAndPendingSessions.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Active Sessions</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-center text-muted-foreground py-10">No active sessions.</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <>
            <Card>
                <CardHeader>
                    <CardTitle>Active Sessions</CardTitle>
                    <CardDescription>Click a session to view its bill. Red-bordered sessions are pending verification.</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {activeAndPendingSessions.map(session => {
                        const isAlaCarte = session.sessionMode === 'alacarte';
                        const title = isAlaCarte ? (session.customerName || 'Ala Carte') : (session.tableDisplayName || `Table ${session.tableNumber}`);
                        const subtitle = isAlaCarte ? "Ala Carte" : session.packageName;
                        
                        const cashier = Number(session.guestCountCashierInitial ?? 0);
                        const server = Number(session.guestCountServerVerified ?? 0);
                        const final = session.guestCountFinal ?? Math.max(cashier, server);
                        const guests = final > 0 ? final : Math.max(cashier, server);

                        const isPending = session.status === 'pending_verification';
                        const guestName = !isAlaCarte ? (session.customer?.name || session.customerName || '').trim() : '';
                        
                        return (
                        <div key={session.id} className="relative group">
                            <Card
                                className={cn(
                                    "transition-colors h-full",
                                    isPending 
                                        ? "border-red-500 cursor-not-allowed opacity-90" 
                                        : "cursor-pointer hover:bg-muted/50"
                                )}
                                onClick={() => {
                                    if (isPending) return;
                                    router.push(`/cashier?sessionId=${session.id}`)
                                }}
                            >
                                <CardHeader>
                                    <div className="flex justify-between items-center">
                                        <CardTitle className="text-xl truncate">{title}</CardTitle>
                                        <TimeElapsed startTime={session.startedAt} startTimeMs={session.startedAtClientMs ?? null} />
                                    </div>
                                    <CardDescription className="truncate">{subtitle}</CardDescription>
                                </CardHeader>
                                <div className="px-6 pb-2 flex flex-wrap items-center gap-1.5">
                                    {guestName && (
                                        <Badge variant="outline" className="gap-1 text-[11px] px-2 py-0 font-medium max-w-full">
                                            <UserRound className="h-3 w-3 shrink-0" />
                                            <span className="truncate">{guestName}</span>
                                        </Badge>
                                    )}
                                    <CardPill
                                        session={session}
                                        onLinkClick={canLink && !isPending ? (e) => { e.stopPropagation(); setLinkingSession(session); } : undefined}
                                    />
                                </div>
                                <CardContent className="flex justify-between items-center">
                                    {!isAlaCarte ? (
                                        <p className="text-sm font-medium">{guests} Guests</p>
                                    ): <div></div>}
                                    <div className="flex items-center gap-1">
                                      {session.hasVoids && (
                                        <Badge variant="outline" className="border-red-400 bg-red-50 text-red-600 text-[10px] px-1.5 py-0 gap-0.5">
                                          <Scissors className="h-3 w-3" /> Void
                                        </Badge>
                                      )}
                                      {session.hasDiscounts && (
                                        <Badge variant="outline" className="border-amber-400 bg-amber-50 text-amber-600 text-[10px] px-1.5 py-0 gap-0.5">
                                          <Tag className="h-3 w-3" /> Disc
                                        </Badge>
                                      )}
                                      {session.hasFree && (
                                        <Badge variant="outline" className="border-green-400 bg-green-50 text-green-600 text-[10px] px-1.5 py-0 gap-0.5">
                                          <Gift className="h-3 w-3" /> Free
                                        </Badge>
                                      )}
                                      {session.guestCountChange?.status === 'approved' && (
                                        <Badge variant="outline" className="border-blue-400 bg-blue-50 text-blue-600 text-[10px] px-1.5 py-0 gap-0.5">
                                          <Users className="h-3 w-3" /> Guest
                                        </Badge>
                                      )}
                                      {session.packageChange?.status === 'approved' && (
                                        <Badge variant="outline" className="border-violet-400 bg-violet-50 text-violet-600 text-[10px] px-1.5 py-0 gap-0.5">
                                          <Package className="h-3 w-3" /> Pkg
                                        </Badge>
                                      )}
                                      {isPending && <Badge variant="outline" className="border-red-500 text-red-500">Pending</Badge>}
                                    </div>
                                </CardContent>
                            </Card>
                            {canVoid && (
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                                    onClick={(e) => handleVoidClick(e, session)}
                                >
                                    <Ban className="h-4 w-4" />
                                    Void
                                </Button>
                            )}
                        </div>
                    )})}
                </CardContent>
            </Card>
            {voidingSession && appUser && storeId && (
                <VoidSessionDialog
                    isOpen={!!voidingSession}
                    onClose={() => setVoidingSession(null)}
                    session={voidingSession}
                    user={appUser}
                    storeId={storeId}
                />
            )}
            {linkingSession && (
                <LinkCardDialog
                    open={!!linkingSession}
                    onOpenChange={(v) => { if (!v) setLinkingSession(null); }}
                    storeId={storeId}
                    sessionId={linkingSession.id}
                    sessionLabel={sessionDialogLabel(linkingSession)}
                />
            )}
        </>
    );
}
