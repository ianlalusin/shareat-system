"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { collection, doc, onSnapshot, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useStoreContext } from "@/context/store-context";
import { useAuthContext } from "@/context/auth-context";
import { useLocalProfile } from "@/context/local-profile-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, CalendarPlus, ChevronLeft, ChevronRight, Clock, Loader2, Phone, Users,
  Check, X, UserCheck, CalendarClock, Handshake, CalendarRange,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";
import { setReservationSeatHandoff } from "@/lib/reservations/seat-handoff";
import type { Reservation, ReservationStatus, ReservationEventType } from "@/lib/types";
import { STATUS_META, OPEN_STATUSES } from "@/lib/reservations/status";
import { reservationEvent, appendReservationEvent } from "@/lib/reservations/history";
import { ReservationFormModal } from "./ReservationFormModal";
import { ChatInbox } from "@/components/cashier/ChatInbox";

function dayIdToInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function ReservationsClient() {
  const router = useRouter();
  const { activeStore, loading } = useStoreContext();
  const { appUser } = useAuthContext();
  const { currentProfile } = useLocalProfile();
  const { toast } = useToast();
  const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();

  const [viewMode, setViewMode] = useState<"upcoming" | "day">("upcoming");
  const [selectedDay, setSelectedDay] = useState<Date>(() => new Date());
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Default to showing every booking (each carries a status badge); the toggle
  // lets staff narrow to just open (pending/confirmed) when they want.
  const [showOpenOnly, setShowOpenOnly] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Reservation | null>(null);

  const dayId = useMemo(() => getDayIdFromTimestamp(selectedDay), [selectedDay]);

  useEffect(() => {
    if (!activeStore?.id) return;
    setIsLoading(true);
    const base = collection(db, "stores", activeStore.id, "reservations");
    const q =
      viewMode === "day"
        ? query(base, where("reservedForDayId", "==", dayId))
        : query(base, where("reservedForMs", ">=", startOfTodayMs()));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Reservation[];
        rows.sort((a, b) => (a.reservedForMs ?? 0) - (b.reservedForMs ?? 0));
        setReservations(rows);
        setIsLoading(false);
      },
      () => setIsLoading(false),
    );
    return () => unsub();
  }, [activeStore?.id, viewMode, dayId]);

  const visible = useMemo(
    () => (showOpenOnly ? reservations.filter((r) => OPEN_STATUSES.includes(r.status)) : reservations),
    [reservations, showOpenOnly],
  );

  const shiftDay = (delta: number) => {
    setSelectedDay((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + delta);
      return next;
    });
  };

  const setStatus = async (r: Reservation, status: ReservationStatus, confirmCopy?: { title: string; description: string; confirmText: string }) => {
    if (!activeStore?.id) return;
    if (confirmCopy && !(await confirm(confirmCopy))) return;
    try {
      const actor = {
        uid: appUser?.uid ?? null,
        name: currentProfile?.name || appUser?.displayName || appUser?.name || null,
      };
      await updateDoc(doc(db, "stores", activeStore.id, "reservations", r.id), {
        status,
        history: appendReservationEvent(reservationEvent(status as ReservationEventType, actor)),
        updatedAt: serverTimestamp(),
      });
      toast({ title: STATUS_META[status].label, description: r.customerName });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err?.message });
    }
  };

  const handleSeatNow = (r: Reservation) => {
    if (!activeStore?.id) return;
    setReservationSeatHandoff({
      reservationId: r.id,
      storeId: activeStore.id,
      name: r.customerName,
      partySize: r.partySize,
      phone: r.phone ?? null,
    });
    router.push("/cashier");
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>;
  }

  if (!activeStore) {
    return (
      <Card className="w-full max-w-md mx-auto text-center">
        <CardHeader>
          <CardTitle>No Store Selected</CardTitle>
          <CardDescription>Please select a store from the header to manage reservations.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const openCount = reservations.filter((r) => OPEN_STATUSES.includes(r.status)).length;

  return (
    <>
      <PageHeader title="Reservations" description={`Forward bookings for ${activeStore.name}`}>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Back
          </Button>
          <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
            <CalendarPlus className="mr-2 h-4 w-4" /> New Reservation
          </Button>
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2">
                {viewMode === "upcoming" ? (
                  <>
                    <CalendarRange className="h-5 w-5 text-primary" />
                    Upcoming bookings
                  </>
                ) : (
                  <>
                    <CalendarClock className="h-5 w-5 text-primary" />
                    {selectedDay.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                  </>
                )}
                {openCount > 0 && <Badge variant="secondary">{openCount} open</Badge>}
              </CardTitle>
              <CardDescription>
                {viewMode === "upcoming" ? "All bookings from today onward." : "Bookings for the selected day."}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex rounded-md border p-0.5">
                <Button
                  variant={viewMode === "upcoming" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8"
                  onClick={() => setViewMode("upcoming")}
                >
                  Upcoming
                </Button>
                <Button
                  variant={viewMode === "day" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8"
                  onClick={() => setViewMode("day")}
                >
                  By day
                </Button>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowOpenOnly((v) => !v)}>
                {showOpenOnly ? "Show all" : "Open only"}
              </Button>
              {viewMode === "day" && (
                <>
                  <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => shiftDay(-1)} aria-label="Previous day">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Input
                    type="date"
                    value={dayIdToInputValue(selectedDay)}
                    onChange={(e) => {
                      const [y, m, d] = e.target.value.split("-").map(Number);
                      if (y && m && d) setSelectedDay(new Date(y, m - 1, d));
                    }}
                    className="w-auto"
                  />
                  <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => shiftDay(1)} aria-label="Next day">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedDay(new Date())}>Today</Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : visible.length === 0 ? (
            <p className="text-center text-muted-foreground py-10">
              {viewMode === "upcoming"
                ? (showOpenOnly ? "No open upcoming reservations." : "No upcoming reservations.")
                : (showOpenOnly ? "No open reservations for this day." : "No reservations for this day.")}
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((r) => {
                const meta = STATUS_META[r.status];
                const isOpen = OPEN_STATUSES.includes(r.status);
                const canModify = r.status === "booked" || r.status === "confirmed" || r.status === "handled";
                return (
                  <li
                    key={r.id}
                    onClick={() => router.push(`/reservations/details?id=${r.id}`)}
                    className="rounded-lg border p-3 flex items-start gap-3 cursor-pointer hover:bg-muted/40 transition"
                  >
                    <div className="flex flex-col items-center justify-center rounded-md bg-muted px-3 py-2 min-w-[78px]">
                      {viewMode === "upcoming" && (
                        <span className="text-[10px] font-medium text-muted-foreground">{fmtShortDate(r.reservedForMs)}</span>
                      )}
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm font-semibold tabular-nums">{fmtTime(r.reservedForMs)}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold truncate">{r.customerName}</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          <Users className="h-3 w-3 mr-0.5" />{r.partySize}
                        </Badge>
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${meta.className}`}>{meta.label}</Badge>
                        {r.source === "website" && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">web</Badge>
                        )}
                      </div>
                      {(r.phone || r.notes) && (
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground truncate">
                          {r.phone && <span className="flex items-center gap-0.5"><Phone className="h-3 w-3" /> {r.phone}</span>}
                          {r.notes && <span className="truncate">· {r.notes}</span>}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-wrap justify-end" onClick={(e) => e.stopPropagation()}>
                      {isOpen && (
                        <Button size="sm" onClick={() => handleSeatNow(r)} className="h-8">
                          <UserCheck className="h-4 w-4 mr-1" /> Seat now
                        </Button>
                      )}
                      {r.status === "booked" && (
                        <Button size="sm" variant="outline" className="h-8" onClick={() => setStatus(r, "confirmed")}>
                          <Check className="h-4 w-4 mr-1" /> Confirm
                        </Button>
                      )}
                      {canModify && (
                        <Button size="sm" variant="outline" className="h-8" onClick={() => { setEditing(r); setFormOpen(true); }}>
                          Edit
                        </Button>
                      )}
                      {isOpen && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-amber-600 border-amber-300 hover:text-amber-700"
                          onClick={() => setStatus(r, "handled", {
                            title: `Mark ${r.customerName} as handled?`,
                            description: "Use when there was a scheduling conflict and you've already spoken with the customer and agreed on an arrangement. This clears it from the pending alert.",
                            confirmText: "Mark handled",
                          })}
                        >
                          <Handshake className="h-4 w-4 mr-1" /> Handled
                        </Button>
                      )}
                      {isOpen && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-muted-foreground"
                          onClick={() => setStatus(r, "no_show", {
                            title: `Mark ${r.customerName} as no-show?`,
                            description: "Use this when the party didn't arrive.",
                            confirmText: "No-show",
                          })}
                        >
                          No-show
                        </Button>
                      )}
                      {canModify && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          aria-label={`Cancel reservation for ${r.customerName}`}
                          onClick={() => setStatus(r, "cancelled", {
                            title: `Cancel ${r.customerName}'s reservation?`,
                            description: "This frees the slot. You can still see it under 'Show all'.",
                            confirmText: "Cancel reservation",
                          })}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ReservationFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        storeId={activeStore.id}
        editing={editing}
        defaultDateMs={selectedDay.getTime()}
      />
      {ConfirmDialog}
      {activeStore?.id && <ChatInbox storeId={activeStore.id} />}
    </>
  );
}
