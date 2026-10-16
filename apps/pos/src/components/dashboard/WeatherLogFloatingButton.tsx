
'use client';

import { useState, useEffect, useCallback } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Sun, Cloudy, CloudRain, CloudLightning, Moon, CloudSun } from "lucide-react";
import { db } from "@/lib/firebase/client";
import { doc, getDoc } from "firebase/firestore";
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";
import { toJsDate } from "@/lib/utils/date";
import { format } from "date-fns";
import type { WeatherEntry, WeatherRecord } from "@/lib/types";
import { Skeleton } from "../ui/skeleton";
import { ScrollArea } from "../ui/scroll-area";

const weatherConfig: Record<string, { icon: React.ElementType; label: string; gradient: string; iconColor: string; dot: string }> = {
    sunny: { icon: Sun, label: "Sunny", gradient: "from-amber-400 to-orange-500", iconColor: "text-amber-500", dot: "bg-amber-400" },
    cloudy: { icon: Cloudy, label: "Cloudy", gradient: "from-slate-300 to-slate-500", iconColor: "text-slate-500", dot: "bg-slate-400" },
    light_rain: { icon: CloudRain, label: "Light Rain", gradient: "from-sky-400 to-blue-600", iconColor: "text-blue-500", dot: "bg-blue-400" },
    heavy_rain: { icon: CloudLightning, label: "Heavy Rain", gradient: "from-indigo-500 to-purple-700", iconColor: "text-purple-500", dot: "bg-purple-500" },
};

const nightClearConfig = { icon: Moon, label: "Clear", gradient: "from-indigo-900 to-slate-800", iconColor: "text-indigo-400", dot: "bg-indigo-400" };

function isNightHour(hour: number): boolean {
    return hour >= 18 || hour < 6;
}

function getWeatherDisplay(condition: string, timestamp?: Date) {
    const hour = (timestamp || new Date()).getHours();
    if (condition === 'sunny' && isNightHour(hour)) return nightClearConfig;
    return weatherConfig[condition] || { icon: CloudSun, label: condition.replace('_', ' '), gradient: "from-gray-300 to-gray-500", iconColor: "text-gray-500", dot: "bg-gray-400" };
}


export function WeatherLogFloatingButton({ storeId }: { storeId: string }) {
    const [entries, setEntries] = useState<WeatherEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    // One-time read (on mount + whenever the sheet opens) instead of a live
    // listener — the log doesn't need to be realtime, and the listener would
    // re-read on every hourly API append for every open device.
    const loadEntries = useCallback(async () => {
        if (!storeId) {
            setIsLoading(false);
            return;
        }
        setIsLoading(true);
        try {
            const dayId = getDayIdFromTimestamp(new Date());
            const snap = await getDoc(doc(db, 'stores', storeId, 'weatherRecords', dayId));
            if (snap.exists()) {
                const data = snap.data() as WeatherRecord;
                const sortedEntries = (data.entries || []).sort((a, b) => {
                    const timeA = toJsDate(a.timestamp)?.getTime() || 0;
                    const timeB = toJsDate(b.timestamp)?.getTime() || 0;
                    return timeB - timeA;
                });
                setEntries(sortedEntries);
            } else {
                setEntries([]);
            }
        } catch (error) {
            console.error("Error fetching weather logs:", error);
        } finally {
            setIsLoading(false);
        }
    }, [storeId]);

    useEffect(() => { loadEntries(); }, [loadEntries]);

    const latestEntry = entries.length > 0 ? entries[0] : null;
    const latestDisplay = latestEntry ? getWeatherDisplay(latestEntry.condition, toJsDate(latestEntry.timestamp) ?? undefined) : null;
    const LatestIcon = latestDisplay?.icon || CloudSun;
    const btnGradient = latestDisplay?.gradient || "from-gray-400 to-gray-600";

    return (
        <Sheet onOpenChange={(o) => { if (o) loadEntries(); }}>
            <SheetTrigger asChild>
                <button
                    className={`fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg z-50 bg-gradient-to-br ${btnGradient} flex items-center justify-center hover:shadow-xl hover:scale-105 active:scale-95 transition-all duration-150 border-0 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary`}
                    aria-label="View weather logs"
                >
                    {isLoading ? <Skeleton className="h-8 w-8 rounded-full" /> : <LatestIcon className="h-8 w-8 text-white drop-shadow-sm" strokeWidth={1.8} />}
                </button>
            </SheetTrigger>
            <SheetContent className="flex flex-col">
                <SheetHeader>
                    <SheetTitle>Today's Weather Log</SheetTitle>
                    <SheetDescription>
                        Weather conditions recorded throughout the day.
                    </SheetDescription>
                </SheetHeader>
                <ScrollArea className="flex-1">
                  <div className="py-4 pr-6 space-y-2">
                      {entries.length === 0 ? (
                          <p className="text-center text-sm text-muted-foreground py-10">No weather logged today.</p>
                      ) : (
                          entries.map((entry, index) => {
                              const entryDate = toJsDate(entry.timestamp);
                              if (!entryDate) return null;

                              const display = getWeatherDisplay(entry.condition, entryDate);
                              const Icon = display.icon;

                              return (
                                  <div key={index} className="flex items-center gap-3 rounded-lg border p-3">
                                      <div className={`h-10 w-10 rounded-lg bg-gradient-to-br ${display.gradient} flex items-center justify-center shrink-0`}>
                                          <Icon className="h-5 w-5 text-white" strokeWidth={1.8} />
                                      </div>
                                      <div className="flex-1 min-w-0">
                                          <p className="text-sm font-medium">
                                              {display.label}
                                              {entry.tempC != null ? <span className="text-muted-foreground font-normal"> · {entry.tempC}°</span> : null}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                              {format(entryDate, 'h:mm a')}
                                              {entry.loggedByProfileName ? ` · ${entry.loggedByProfileName}` : ""}
                                          </p>
                                      </div>
                                      <div className={`h-2 w-2 rounded-full ${display.dot} shrink-0`} />
                                  </div>
                              );
                          })
                      )}
                  </div>
                </ScrollArea>
            </SheetContent>
        </Sheet>
    );
}
