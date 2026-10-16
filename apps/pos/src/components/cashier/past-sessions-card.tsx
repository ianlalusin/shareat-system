

"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Timestamp, doc, onSnapshot } from "firebase/firestore";
import { format } from 'date-fns';
import { Button } from "../ui/button";
import { useRouter } from "next/navigation";
import { Receipt, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { db } from "@/lib/firebase/client";
import { useStoreContext } from "@/context/store-context";
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";
import type { DailyMetric } from "@/lib/types";

export function PastSessionsCard() {
    const router = useRouter();
    const { activeStore } = useStoreContext();
    const [dailyData, setDailyData] = useState<DailyMetric | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (!activeStore) {
            setIsLoading(false);
            setDailyData(null);
            return;
        }

        setIsLoading(true);
        const todayDayId = getDayIdFromTimestamp(new Date());
        const docRef = doc(db, "stores", activeStore.id, "analytics", todayDayId);

        const unsubscribe = onSnapshot(docRef, (doc) => {
            if (doc.exists()) {
                setDailyData(doc.data() as DailyMetric);
            } else {
                setDailyData(null);
            }
            setIsLoading(false);
        }, (error) => {
            console.error("Error fetching daily analytics:", error);
            setIsLoading(false);
        });

        return () => unsubscribe();
    }, [activeStore]);
    
    const closedCount = dailyData?.sessions?.closedCount ?? 0;
    const totalRevenue = dailyData?.sessions?.totalPaid ?? 0;

    if (isLoading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Today's Closed Sessions</CardTitle>
                </CardHeader>
                <CardContent className="flex justify-center items-center h-24">
                    <Loader2 className="animate-spin" />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Today's Closed Sessions</CardTitle>
                <CardDescription>
                    A summary of all sessions completed today.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                 <div className="grid grid-cols-2 gap-4 text-center">
                    <div className="p-4 bg-muted rounded-lg">
                        <p className="text-sm text-muted-foreground">Closed Sessions</p>
                        <p className="text-2xl font-bold">{closedCount}</p>
                    </div>
                     <div className="p-4 bg-muted rounded-lg">
                        <p className="text-sm text-muted-foreground">Total Paid</p>
                        <p className="text-2xl font-bold">₱{totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    </div>
                </div>
            </CardContent>
            <CardFooter>
                 <Button className="w-full" variant="outline" onClick={() => router.push('/receipts')}>
                    <Receipt className="mr-2"/> View All Receipts
                </Button>
            </CardFooter>
        </Card>
    );
}
