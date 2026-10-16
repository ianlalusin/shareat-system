import type { ReservationStatus } from "@/lib/types";

export const STATUS_META: Record<ReservationStatus, { label: string; className: string }> = {
  booked: { label: "Pending", className: "border-blue-400 bg-blue-50 text-blue-600" },
  confirmed: { label: "Confirmed", className: "border-emerald-400 bg-emerald-50 text-emerald-600" },
  seated: { label: "Seated", className: "border-violet-400 bg-violet-50 text-violet-600" },
  cancelled: { label: "Cancelled", className: "border-muted-foreground/30 bg-muted text-muted-foreground" },
  no_show: { label: "No-show", className: "border-red-400 bg-red-50 text-red-600" },
  handled: { label: "Handled", className: "border-amber-400 bg-amber-50 text-amber-600" },
};

export const OPEN_STATUSES: ReservationStatus[] = ["booked", "confirmed"];
