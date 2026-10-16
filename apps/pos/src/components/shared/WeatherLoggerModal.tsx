"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuthContext } from "@/context/auth-context";
import { useLocalProfile } from "@/context/local-profile-context";
import { db } from "@/lib/firebase/client";
import { doc, setDoc, arrayUnion, getCountFromServer, collection, Timestamp } from "firebase/firestore";
import { getDayIdFromTimestamp } from "@/lib/analytics/daily";
import { getWeatherOptions, isNightHour, type WeatherIconMeta } from "@/lib/weather/icons";
import type { WeatherCondition, WeatherEntry } from "@/lib/types";

interface WeatherLoggerModalProps {
    isOpen: boolean;
    onClose: () => void;
    storeId: string;
}

type WeatherOption = WeatherIconMeta & { value: WeatherCondition };

const FOCUS_COUNTDOWN_SECONDS = 5;

function isNightTime(): boolean {
    return isNightHour(new Date().getHours());
}

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export function WeatherLoggerModal({ isOpen, onClose, storeId }: WeatherLoggerModalProps) {
    const { appUser } = useAuthContext();
    const { currentProfile } = useLocalProfile();

    // Shuffled per-open so the cashier can't rely on positional muscle memory
    // (today they always tap the same tile without checking).
    const [weatherOptions, setWeatherOptions] = useState<WeatherOption[]>([]);
    // Buttons are locked until the countdown elapses — gives the cashier
    // 5 seconds to actually look out the window before tapping.
    const [countdown, setCountdown] = useState(FOCUS_COUNTDOWN_SECONDS);

    useEffect(() => {
        if (!isOpen) return;
        setWeatherOptions(shuffle(getWeatherOptions(isNightTime())));
        setCountdown(FOCUS_COUNTDOWN_SECONDS);
        const tick = setInterval(() => {
            setCountdown(c => {
                if (c <= 1) {
                    clearInterval(tick);
                    return 0;
                }
                return c - 1;
            });
        }, 1000);
        return () => clearInterval(tick);
    }, [isOpen]);

    const isLocked = countdown > 0;

    const handleLogWeather = async (condition: WeatherCondition) => {
        if (!appUser || !storeId) {
            onClose();
            return;
        }

        onClose();

        try {
            const now = new Date();
            const dayId = getDayIdFromTimestamp(now);

            const activeSessionsRef = collection(db, 'stores', storeId, 'activeSessions');
            const snapshot = await getCountFromServer(activeSessionsRef);
            const activeSessionCount = snapshot.data().count;
            const activeGuestCount = 0;

            const newEntry: WeatherEntry = {
                timestamp: Timestamp.fromDate(now),
                condition,
                activeSessionCount,
                activeGuestCount,
                loggedByUid: appUser.uid,
                loggedByProfileId: currentProfile?.profileId ?? null,
                loggedByProfileName: currentProfile?.name ?? null,
            };

            const recordRef = doc(db, 'stores', storeId, 'weatherRecords', dayId);
            await setDoc(recordRef, {
                dayId,
                entries: arrayUnion(newEntry)
            }, { merge: true });

            // Mirror into the monthly weatherForecasts doc (source: manual) so the
            // sales projection — which reads that doc — picks it up when the API
            // was unreachable. dayId is YYYYMMDD.
            const ym = `${dayId.slice(0, 4)}-${dayId.slice(4, 6)}`;
            const date = `${dayId.slice(0, 4)}-${dayId.slice(4, 6)}-${dayId.slice(6, 8)}`;
            const monthRef = doc(db, 'stores', storeId, 'weatherForecasts', ym);
            await setDoc(monthRef, {
                ym, storeId, updatedAtMs: Date.now(),
                days: { [dayId]: { date, condition, am: condition, pm: condition, tempC: null, pop: null, owmMain: null, source: "manual", fetchedAtMs: Date.now() } },
            }, { merge: true });

        } catch (error) {
            console.error("Failed to log weather:", error);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                className="sm:max-w-sm"
                onEscapeKeyDown={(e) => { if (isLocked) e.preventDefault(); }}
                onPointerDownOutside={(e) => { if (isLocked) e.preventDefault(); }}
                onInteractOutside={(e) => { if (isLocked) e.preventDefault(); }}
            >
                <DialogHeader>
                    <DialogTitle>Quick Weather Update</DialogTitle>
                    <DialogDescription>
                        {isLocked
                            ? "Look outside the window and check the weather. Buttons unlock in a moment."
                            : "Tap what you see right now — this feeds sales forecasting."}
                    </DialogDescription>
                </DialogHeader>
                {isLocked && (
                    <div className="flex flex-col items-center justify-center py-2">
                        <div className="text-5xl font-bold tabular-nums text-primary leading-none">{countdown}</div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-1">Look outside…</div>
                    </div>
                )}
                <div className={`grid grid-cols-2 gap-3 py-3 ${isLocked ? "pointer-events-none" : ""}`} aria-hidden={isLocked}>
                    {weatherOptions.map(({ label, value, icon: Icon, gradient, iconColor }) => (
                        <button
                            key={value}
                            disabled={isLocked}
                            className={`relative h-24 rounded-xl bg-gradient-to-br ${gradient} flex flex-col items-center justify-center gap-2 shadow-md transition-all duration-150 border-0 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary ${isLocked ? "opacity-40 grayscale cursor-not-allowed" : "hover:shadow-lg hover:scale-[1.03] active:scale-[0.97] cursor-pointer"}`}
                            onClick={() => handleLogWeather(value)}
                        >
                            <Icon className={`h-9 w-9 ${iconColor} drop-shadow-sm`} strokeWidth={1.8} />
                            <span className="text-sm font-semibold text-white drop-shadow-sm">{label}</span>
                        </button>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}
