
"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase/client';
import { useStoreContext } from '@/context/store-context';

const LOG_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
const CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
const API_STALE_MS = 3 * 60 * 60 * 1000; // API weather older than 3h ⇒ treat as down
const API_FRESH_CACHE_MS = 45 * 60 * 1000; // once seen fresh, don't re-read for ~45 min

/**
 * True when the OpenWeatherMap cron has already logged today's weather recently
 * for this store. When it has, the manual modal stays closed — manual logging is
 * only a fallback for when the API is unreachable.
 */
async function apiWeatherFresh(storeId: string): Promise<boolean> {
  try {
    const manila = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    const y = manila.getFullYear();
    const m = String(manila.getMonth() + 1).padStart(2, '0');
    const d = String(manila.getDate()).padStart(2, '0');
    const snap = await getDoc(doc(db, 'stores', storeId, 'weatherForecasts', `${y}-${m}`));
    if (!snap.exists()) return false;
    const day = (snap.data()?.days ?? {})[`${y}${m}${d}`];
    if (!day || day.source !== 'owm') return false;
    return Date.now() - (day.fetchedAtMs ?? 0) < API_STALE_MS;
  } catch {
    return false; // on any read error, fall back to prompting
  }
}

export function useWeatherLogger() {
    const { activeStore } = useStoreContext();
    const [isModalOpen, setIsModalOpen] = useState(false);
    // Cache the "API weather is fresh" result so we don't read the monthly doc
    // every 15-min tick — the forecast only changes hourly.
    const apiFreshCache = useRef<{ ms: number; fresh: boolean } | null>(null);

    const openModal = useCallback(() => {
        // Prevent opening if another modal-like element is already present
        if (document.querySelector('[data-radix-popper-content-wrapper]')) {
            return;
        }
        setIsModalOpen(true);
    }, []);

    const closeModal = useCallback(() => {
        localStorage.setItem('lastWeatherLogTime', Date.now().toString());
        setIsModalOpen(false);
    }, []);

    useEffect(() => {
        const checkTime = async () => {
            const lastLogTime = parseInt(localStorage.getItem('lastWeatherLogTime') || '0', 10);
            if (Date.now() - lastLogTime < LOG_INTERVAL) {
                return; // Don't show if logged recently
            }

            // Primary source is the hourly API logger — only prompt the cashier
            // when the API hasn't logged today's weather recently (fallback).
            // Cached when fresh so this doesn't read Firestore every tick.
            if (activeStore?.id) {
                const cached = apiFreshCache.current;
                let fresh: boolean;
                if (cached?.fresh && Date.now() - cached.ms < API_FRESH_CACHE_MS) {
                    fresh = true;
                } else {
                    fresh = await apiWeatherFresh(activeStore.id);
                    apiFreshCache.current = { ms: Date.now(), fresh };
                }
                if (fresh) return;
            }

            // If no store hours are set, show the modal as before.
            if (!activeStore || !activeStore.openingTime || !activeStore.closingTime) {
                openModal();
                return;
            }

            // Check if within store hours
            try {
                // Use store's timezone, assuming Asia/Manila for this app
                const nowInStoreTz = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
                const currentTimeInMinutes = nowInStoreTz.getHours() * 60 + nowInStoreTz.getMinutes();

                const [startHour, startMinute] = activeStore.openingTime.split(':').map(Number);
                const startTimeInMinutes = startHour * 60 + startMinute;

                const [endHour, endMinute] = activeStore.closingTime.split(':').map(Number);
                const endTimeInMinutes = endHour * 60 + endMinute;
                
                if (isNaN(startTimeInMinutes) || isNaN(endTimeInMinutes)) {
                    throw new Error("Invalid time format in store settings.");
                }
                
                let isInHours = false;
                if (startTimeInMinutes <= endTimeInMinutes) { // Same day (e.g., 09:00 - 22:00)
                    isInHours = currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes < endTimeInMinutes;
                } else { // Overnight (e.g., 21:00 - 05:00)
                    isInHours = currentTimeInMinutes >= startTimeInMinutes || currentTimeInMinutes < endTimeInMinutes;
                }
                
                if (isInHours) {
                    openModal();
                }

            } catch (error) {
                console.error("Error parsing store hours for weather logger:", error);
                // Fallback to showing the modal if parsing fails, to not lose data.
                openModal();
            }
        };

        // Check immediately on mount
        checkTime();
        
        // Then check periodically
        const interval = setInterval(checkTime, CHECK_INTERVAL);
        
        return () => clearInterval(interval);
    }, [openModal, activeStore]);

    return { isModalOpen, closeModal };
}
