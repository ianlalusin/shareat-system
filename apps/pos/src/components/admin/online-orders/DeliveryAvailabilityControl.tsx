"use client";

import { Loader2, Truck } from "lucide-react";
import { Switch } from "@/components/ui/switch";

/**
 * Pause/resume delivery independent of pickup — e.g. no rider on shift right
 * now. Pure props + one callback, mirrors OnlineAvailabilityControl. Only
 * meaningful when the store has a delivery radius configured; the caller is
 * expected to not render this otherwise.
 */
export function DeliveryAvailabilityControl({
  deliveryEnabled,
  canEdit,
  saving,
  onToggle,
}: {
  deliveryEnabled: boolean;
  canEdit: boolean;
  saving: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2" data-testid="delivery-availability-control">
      <Truck className={`h-4 w-4 ${deliveryEnabled ? "text-green-600" : "text-muted-foreground"}`} />
      <span className="text-sm font-semibold">Delivery: {deliveryEnabled ? "On" : "Paused"}</span>
      <Switch
        data-testid="delivery-toggle"
        checked={deliveryEnabled}
        disabled={!canEdit || saving}
        onCheckedChange={onToggle}
      />
      {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" data-testid="delivery-saving" />}
    </div>
  );
}
