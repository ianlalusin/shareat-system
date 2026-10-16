
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SessionCard } from "./SessionCard";
import type { PendingSession } from "@/lib/types";

interface ActiveSessionsGridProps {
    sessions: PendingSession[];
    onVerify: (session: PendingSession, serverCount: number) => void;
    onRequestChange: (session: PendingSession) => void;
    onViewTimeline: (sessionId: string) => void;
    onAddRefill: (session: PendingSession) => void;
    onAddAddon: (session: PendingSession) => void;
}

export function ActiveSessionsGrid({ sessions, onVerify, onRequestChange, onViewTimeline, onAddRefill, onAddAddon }: ActiveSessionsGridProps) {
    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <CardTitle>Active Sessions</CardTitle>
                    <Badge variant="secondary">{sessions.length}</Badge>
                </div>
                <CardDescription>Verified sessions that are currently ongoing.</CardDescription>
            </CardHeader>
            <CardContent className="grid sm:grid-cols-2 gap-4">
                {sessions.length === 0 ? <p className="text-muted-foreground text-center py-4 sm:col-span-2">No active sessions.</p> : null}
                {sessions.map(session => (
                     <SessionCard
                        key={session.id}
                        session={session}
                        onVerify={onVerify}
                        onRequestChange={onRequestChange}
                        onViewTimeline={onViewTimeline}
                        onAddRefill={onAddRefill}
                        onAddAddon={onAddAddon}
                    />
                ))}
            </CardContent>
        </Card>
    );
}
