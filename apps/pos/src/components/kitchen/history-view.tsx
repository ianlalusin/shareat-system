

"use client";

import { useMemo, useState } from "react";
import type { KitchenTicket } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { ArrowLeft, ArrowRight, Clock, Loader2, ChevronRight } from "lucide-react";
import Link from "next/link";
import { formatDurationHuman as formatDuration } from "@/lib/utils/date";

interface HistoryViewProps {
    items: any[];
    isLoading: boolean;
    activeStationId: string;
    onCollapse?: () => void;
}

export function HistoryView({ items, isLoading, activeStationId, onCollapse }: HistoryViewProps) {
    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div>
                    <CardTitle>Order History</CardTitle>
                    <CardDescription>Recently completed or cancelled items.</CardDescription>
                </div>
                {onCollapse && (
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onCollapse} aria-label="Collapse history">
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                )}
            </CardHeader>
            <CardContent>
                {isLoading && items.length === 0 ? (
                    <div className="flex justify-center py-8">
                        <Loader2 className="animate-spin" />
                    </div>
                ) : items.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">No items in history yet.</p>
                ) : (
                    <div className="space-y-2">
                        {items.map(item => {
                             const isAlaCarte = item.sessionMode === 'alacarte';
                             const displayLocation = item.sessionLabel || (isAlaCarte ? item.customerName || 'Ala Carte' : `Table ${item.tableNumber}`);
                             const hasDuration = item.status === 'served' && item.durationMs && item.durationMs > 0;
                             return (
                            <div key={item.id} className="border rounded-lg p-3 text-sm">
                                <div className="flex justify-between items-start">
                                    <div>
                                      <p className="font-semibold">{displayLocation}</p>
                                      <p className="text-muted-foreground">{item.itemName}{item.qtyOrdered > 1 ? ` (${item.qtyServed ?? item.qty} served${item.qtyCancelled > 0 ? `, ${item.qtyCancelled} cancelled` : ""})` : ""}</p>
                                    </div>
                                    <Badge 
                                        variant="outline"
                                        className={cn(
                                            "capitalize flex-shrink-0",
                                            item.status === 'served' && "bg-green-100 text-green-800 border-green-300",
                                            item.status === 'cancelled' && "bg-red-100 text-red-800 border-red-300",
                                        )}
                                    >
                                        {item.status}
                                    </Badge>
                                </div>
                                {hasDuration && (
                                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                                        <Clock size={12} />
                                        <span>Served in {formatDuration(item.durationMs!)}</span>
                                    </div>
                                )}
                            </div>
                        )})}
                    </div>
                )}
            </CardContent>
            <CardFooter>
                <Button asChild variant="outline" className="w-full">
                    <Link href={`/kitchen/history?kitchenLocationId=${activeStationId}`}>View Full History</Link>
                </Button>
            </CardFooter>
        </Card>
    );
}
