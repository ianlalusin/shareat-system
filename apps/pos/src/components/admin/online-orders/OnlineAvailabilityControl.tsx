"use client";

import { Loader2, Clock } from "lucide-react";
import type { OnlineAvailability } from "@/lib/storefront/online-hours";

export type SelectedMode = "auto" | "open" | "closed";

/**
 * Presentational open/closed control for the Online Orders page. Pure props +
 * one callback — no contexts — so it renders the same everywhere and can be
 * driven in isolation (E2E). The live "Customers: Open/Closed" status reflects
 * `availability.openNow`; the segmented control reflects the chosen mode.
 */
export function OnlineAvailabilityControl({
  availability,
  selectedMode,
  canEdit,
  saving,
  openingTime,
  closingTime,
  onSelect,
}: {
  availability: OnlineAvailability;
  selectedMode: SelectedMode;
  canEdit: boolean;
  saving: boolean;
  openingTime?: string | null;
  closingTime?: string | null;
  onSelect: (mode: SelectedMode) => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1 rounded-lg border bg-card px-3 py-2" data-testid="availability-control">
      <div className="flex items-center gap-3">
        <span
          data-testid="status"
          className={`inline-flex items-center gap-1.5 text-sm font-semibold ${availability.openNow ? "text-green-600" : "text-muted-foreground"}`}
        >
          <span className={`h-2.5 w-2.5 rounded-full ${availability.openNow ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`} />
          Customers: {availability.openNow ? "Open" : "Closed"}
        </span>
        {canEdit ? (
          <div className="inline-flex overflow-hidden rounded-md border">
            {(["auto", "open", "closed"] as const).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`mode-${m}`}
                disabled={saving}
                onClick={() => onSelect(m)}
                className={`px-2.5 py-1 text-xs font-medium capitalize transition-colors disabled:opacity-60 ${
                  selectedMode === m
                    ? m === "closed"
                      ? "bg-destructive text-destructive-foreground"
                      : "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground capitalize" data-testid="mode-readonly">
            {selectedMode === "auto" ? "Auto" : selectedMode}
          </span>
        )}
        {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" data-testid="saving" />}
      </div>
      {availability.scheduleControlled && (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="schedule-caption">
          <Clock className="h-3 w-3" />
          {openingTime && closingTime
            ? `Auto · follows store hours ${openingTime}–${closingTime}`
            : "Auto · no store hours set — open 24h until you set them"}
        </span>
      )}
    </div>
  );
}
