"use client";

import { RoleGuard } from "@/components/guards/RoleGuard";
import { CashHandoverClient } from "@/components/cashier/CashHandoverClient";

export default function CashHandoverPage() {
  return (
    <RoleGuard allow={["admin", "manager", "cashier"]}>
      <CashHandoverClient />
    </RoleGuard>
  );
}
