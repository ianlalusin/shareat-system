"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { doc, onSnapshot, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useStoreContext } from "@/context/store-context";
import { useAuthContext } from "@/context/auth-context";
import { useLocalProfile } from "@/context/local-profile-context";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import {
  ArrowLeft, Loader2, Phone, Users, Clock, Check, X, UserCheck, UserX,
  Handshake, CalendarPlus, Pencil, Globe, Wallet, Ban, Banknote, Plus,
} from "lucide-react";
import type { Reservation, ReservationStatus, ReservationEventType, ReservationEvent, ReservationPayment } from "@/lib/types";
import { STATUS_META, OPEN_STATUSES } from "@/lib/reservations/status";
import { reservationEvent, appendReservationEvent, EVENT_LABEL } from "@/lib/reservations/history";
import { setReservationSeatHandoff } from "@/lib/reservations/seat-handoff";
import { ReservationFormModal } from "@/components/reservations/ReservationFormModal";
import { ReservationPaymentModal } from "@/components/reservations/ReservationPaymentModal";
import { ReservationPaymentVoidModal } from "@/components/reservations/ReservationPaymentVoidModal";

const EVENT_ICON: Record<ReservationEventType, React.ElementType> = {
  created: CalendarPlus,
  edited: Pencil,
  confirmed: Check,
  seated: UserCheck,
  cancelled: X,
  no_show: UserX,
  handled: Handshake,
  payment_recorded: Wallet,
  payment_voided: Ban,
  payments_applied: Banknote,
};

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function ReservationDetailInner() {
  // Query-param route (static-export friendly so the cashier APK can open it):
  // /reservations/details?id=<reservationId>.
  const searchParams = useSearchParams();
  const id = String(searchParams?.get("id") || "");
  const router = useRouter();
  const { activeStore, loading } = useStoreContext();
  const { appUser } = useAuthContext();
  const { currentProfile } = useLocalProfile();
  const { toast } = useToast();
  const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();

  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<ReservationPayment | null>(null);

  useEffect(() => {
    if (!activeStore?.id || !id) return;
    setIsLoading(true);
    const unsub = onSnapshot(
      doc(db, "stores", activeStore.id, "reservations", id),
      (snap) => {
        if (!snap.exists()) {
          setReservation(null);
          setNotFound(true);
        } else {
          setReservation({ id: snap.id, ...(snap.data() as any) } as Reservation);
          setNotFound(false);
        }
        setIsLoading(false);
      },
      () => setIsLoading(false),
    );
    return () => unsub();
  }, [activeStore?.id, id]);

  const history = useMemo(
    () => (reservation?.history ?? []).slice().sort((a, b) => a.at - b.at),
    [reservation],
  );

  const activePayments = useMemo(
    () => (reservation?.payments ?? []).filter((p) => !p.voidedAt).slice().sort((a, b) => a.recordedAtClientMs - b.recordedAtClientMs),
    [reservation],
  );
  const voidedPayments = useMemo(
    () => (reservation?.payments ?? []).filter((p) => p.voidedAt).slice().sort((a, b) => a.recordedAtClientMs - b.recordedAtClientMs),
    [reservation],
  );
  const paymentsTotal = useMemo(
    () => activePayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
    [activePayments],
  );

  const setStatus = async (
    status: ReservationStatus,
    confirmCopy?: { title: string; description: string; confirmText: string },
  ) => {
    if (!activeStore?.id || !reservation) return;
    if (confirmCopy && !(await confirm(confirmCopy))) return;
    try {
      const actor = {
        uid: appUser?.uid ?? null,
        name: currentProfile?.name || appUser?.displayName || appUser?.name || null,
      };
      await updateDoc(doc(db, "stores", activeStore.id, "reservations", reservation.id), {
        status,
        history: appendReservationEvent(reservationEvent(status as ReservationEventType, actor)),
        updatedAt: serverTimestamp(),
      });
      toast({ title: STATUS_META[status].label, description: reservation.customerName });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err?.message });
    }
  };

  const handleSeatNow = () => {
    if (!activeStore?.id || !reservation) return;
    setReservationSeatHandoff({
      reservationId: reservation.id,
      storeId: activeStore.id,
      name: reservation.customerName,
      partySize: reservation.partySize,
      phone: reservation.phone ?? null,
    });
    router.push("/cashier");
  };

  if (loading || isLoading) {
    return <div className="flex items-center justify-center h-full py-20"><Loader2 className="animate-spin" /></div>;
  }

  if (!activeStore) {
    return (
      <Card className="w-full max-w-md mx-auto text-center mt-10">
        <CardHeader>
          <CardTitle>No Store Selected</CardTitle>
          <CardDescription>Select a store from the header to view this reservation.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (notFound || !reservation) {
    return (
      <>
        <PageHeader title="Reservation" description="">
          <Button variant="outline" onClick={() => router.push("/reservations")}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Back
          </Button>
        </PageHeader>
        <Card className="w-full max-w-md mx-auto text-center mt-6">
          <CardHeader>
            <CardTitle>Reservation not found</CardTitle>
            <CardDescription>It may belong to a different store, or it was removed.</CardDescription>
          </CardHeader>
        </Card>
      </>
    );
  }

  const meta = STATUS_META[reservation.status];
  const isOpen = OPEN_STATUSES.includes(reservation.status);
  // A booking can still be rescheduled / re-noted / cancelled until it's
  // seated or already closed.
  const canModify = reservation.status === "booked" || reservation.status === "confirmed" || reservation.status === "handled";

  return (
    <>
      <PageHeader title="Reservation" description={activeStore.name}>
        <Button variant="outline" onClick={() => router.push("/reservations")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-[1fr_minmax(0,360px)] max-w-4xl">
        {/* Details + actions */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="text-2xl flex items-center gap-2">
                  {reservation.customerName}
                  {reservation.source === "website" && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0"><Globe className="h-3 w-3 mr-0.5" /> web</Badge>
                  )}
                </CardTitle>
                <CardDescription className="mt-1 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" /> {fmtDateTime(reservation.reservedForMs)}
                </CardDescription>
              </div>
              <Badge variant="outline" className={`${meta.className}`}>{meta.label}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Party size</div>
                <div className="font-semibold flex items-center gap-1"><Users className="h-4 w-4" /> {reservation.partySize}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Phone</div>
                <div className="font-semibold flex items-center gap-1">
                  {reservation.phone ? (<><Phone className="h-4 w-4" /> {reservation.phone}</>) : <span className="text-muted-foreground">—</span>}
                </div>
              </div>
            </div>
            {reservation.notes && (
              <div className="rounded-lg border p-3 text-sm">
                <div className="text-xs text-muted-foreground mb-0.5">Notes</div>
                <div>{reservation.notes}</div>
              </div>
            )}

            {/* Payments */}
            <div className="rounded-lg border p-3 text-sm space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <Wallet className="h-3.5 w-3.5" /> Payments
                </div>
                <div className="text-xs text-muted-foreground">
                  Total: <span className="font-semibold text-foreground tabular-nums">₱{fmtMoney(paymentsTotal)}</span>
                </div>
              </div>

              {activePayments.length === 0 && voidedPayments.length === 0 ? (
                <p className="text-xs text-muted-foreground">No payments recorded yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {activePayments.map((p) => (
                    <li key={p.id} className="flex items-start justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">
                          <span className="font-medium">{p.methodName}</span>
                          <span className="tabular-nums"> · ₱{fmtMoney(p.amount)}</span>
                          {p.reference ? <span className="text-muted-foreground"> · ref {p.reference}</span> : null}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {fmtDateTime(p.recordedAtClientMs)}{p.recordedByName ? ` · ${p.recordedByName}` : ""}
                          {p.label ? ` · ${p.label}` : ""}
                        </div>
                        {p.note && <div className="text-[11px] text-muted-foreground mt-0.5 break-words">{p.note}</div>}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => setVoidTarget(p)}
                        aria-label="Void payment"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                  {voidedPayments.map((p) => (
                    <li key={p.id} className="flex items-start justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 opacity-70">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm line-through">
                          <span className="font-medium">{p.methodName}</span>
                          <span className="tabular-nums"> · ₱{fmtMoney(p.amount)}</span>
                          {p.reference ? <span className="text-muted-foreground"> · ref {p.reference}</span> : null}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Voided{p.voidedAtClientMs ? ` ${fmtDateTime(p.voidedAtClientMs)}` : ""}
                          {p.voidedByName ? ` · ${p.voidedByName}` : ""}
                          {p.voidReason ? ` · ${p.voidReason}` : ""}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setPaymentModalOpen(true)}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Record payment
              </Button>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2 pt-1">
              {isOpen && (
                <Button onClick={handleSeatNow}>
                  <UserCheck className="h-4 w-4 mr-1" /> Seat now
                </Button>
              )}
              {reservation.status === "booked" && (
                <Button variant="outline" onClick={() => setStatus("confirmed")}>
                  <Check className="h-4 w-4 mr-1" /> Confirm
                </Button>
              )}
              {canModify && (
                <Button variant="outline" onClick={() => setFormOpen(true)}>
                  <Pencil className="h-4 w-4 mr-1" /> Reschedule / Edit
                </Button>
              )}
              {isOpen && (
                <Button
                  variant="outline"
                  className="text-amber-600 border-amber-300 hover:text-amber-700"
                  onClick={() => setStatus("handled", {
                    title: `Mark ${reservation.customerName} as handled?`,
                    description: "Use when there was a scheduling conflict and you've already spoken with the customer and agreed on an arrangement. This clears it from the pending alert.",
                    confirmText: "Mark handled",
                  })}
                >
                  <Handshake className="h-4 w-4 mr-1" /> Handled
                </Button>
              )}
              {isOpen && (
                <Button
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setStatus("no_show", {
                    title: `Mark ${reservation.customerName} as no-show?`,
                    description: "Use this when the party didn't arrive.",
                    confirmText: "No-show",
                  })}
                >
                  <UserX className="h-4 w-4 mr-1" /> No-show
                </Button>
              )}
              {canModify && (
                <Button
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setStatus("cancelled", {
                    title: `Cancel ${reservation.customerName}'s reservation?`,
                    description: "This frees the slot. The booking stays visible in the history.",
                    confirmText: "Cancel reservation",
                  })}
                >
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Lifecycle timeline */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lifecycle</CardTitle>
            <CardDescription>From booking to seated.</CardDescription>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No history recorded yet.</p>
            ) : (
              <ol className="space-y-3">
                {history.map((ev: ReservationEvent, i) => {
                  const Icon = EVENT_ICON[ev.type] ?? Clock;
                  return (
                    <li key={`${ev.at}-${i}`} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted">
                          <Icon className="h-3.5 w-3.5 text-foreground/70" />
                        </span>
                        {i < history.length - 1 && <span className="w-px flex-1 bg-border mt-1" />}
                      </div>
                      <div className="pb-1 min-w-0">
                        <div className="text-sm font-medium">{EVENT_LABEL[ev.type] ?? ev.type}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {fmtDateTime(ev.at)}{ev.byName ? ` · ${ev.byName}` : ""}
                        </div>
                        {ev.note && <div className="text-xs text-muted-foreground mt-0.5 break-words">{ev.note}</div>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <ReservationFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        storeId={activeStore.id}
        editing={reservation}
        defaultDateMs={reservation.reservedForMs}
      />
      <ReservationPaymentModal
        open={paymentModalOpen}
        onOpenChange={setPaymentModalOpen}
        storeId={activeStore.id}
        reservation={reservation}
      />
      <ReservationPaymentVoidModal
        open={!!voidTarget}
        onOpenChange={(v) => { if (!v) setVoidTarget(null); }}
        storeId={activeStore.id}
        reservationId={reservation.id}
        payment={voidTarget}
      />
      {ConfirmDialog}
    </>
  );
}

export default function ReservationDetailPage() {
  return (
    <RoleGuard allow={["admin", "manager", "cashier"]}>
      <ReservationDetailInner />
    </RoleGuard>
  );
}
