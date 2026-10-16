"use client";

import { RoleGuard } from "@/components/guards/RoleGuard";
import { ReservationsClient } from "@/components/reservations/ReservationsClient";

export default function ReservationsPage() {
  return (
    <RoleGuard allow={["admin", "manager", "cashier"]}>
      <ReservationsClient />
    </RoleGuard>
  );
}
