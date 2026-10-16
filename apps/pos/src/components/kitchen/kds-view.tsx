"use client";

import { KdsItemCard, type ServeBatchPayload, type CancelRemainingPayload } from "./kds-item-card";
import type { KitchenTicket } from "@/lib/types";
import { cn } from "@/lib/utils";

interface KdsViewProps {
    tickets: KitchenTicket[];
    onUpdateStatus: (ticketId: string, sessionId: string, newStatus: "served" | "cancelled", reason?: string) => void;
    onServeBatch?: (payload: ServeBatchPayload) => void;
    onCancelRemaining?: (payload: CancelRemainingPayload) => void;
    slaMinutes?: number;
    wideLayout?: boolean;
}

export function KdsView({ tickets, onUpdateStatus, onServeBatch, onCancelRemaining, slaMinutes, wideLayout }: KdsViewProps) {
    if (tickets.length > 0) {
        return (
            <div className={cn("grid grid-cols-1 md:grid-cols-2 gap-4", wideLayout && "xl:grid-cols-3")}>
                {tickets.map(ticket => (
                    <KdsItemCard
                        key={ticket.id}
                        ticket={ticket}
                        onUpdateStatus={onUpdateStatus}
                        onServeBatch={onServeBatch}
                        onCancelRemaining={onCancelRemaining}
                        slaMinutes={slaMinutes}
                    />
                ))}
            </div>
        );
    }

    return (
        <div className="text-center text-muted-foreground py-20">
            No active orders for this station.
        </div>
    );
}
