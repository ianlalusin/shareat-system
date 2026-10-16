
'use client';

import { useState, useEffect, useRef } from 'react';
import { db } from '@/lib/firebase/client';
import { subscribeReceiptSettings, mergeReceiptSettings } from '@/lib/receipts/receipt-settings';
import { cacheLogoForStore } from '@/lib/printing/printHub';
import type { ReceiptSettings } from '@/lib/types';

export function useReceiptSettings(storeId?: string | null) {
    const [settings, setSettings] = useState<ReceiptSettings>(() => mergeReceiptSettings(null));
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const lastLogoUrlRef = useRef<string | null | undefined>(undefined);

    useEffect(() => {
        if (!storeId) {
            setSettings(mergeReceiptSettings(null));
            setIsLoading(false);
            setError(null);
            return;
        }

        setIsLoading(true);

        const unsubscribe = subscribeReceiptSettings(db, storeId,
            (newSettings) => {
                setSettings(newSettings);
                setIsLoading(false);
                setError(null);

                // Auto-cache logo when settings load or logoUrl changes
                if (newSettings.logoUrl !== lastLogoUrlRef.current) {
                    lastLogoUrlRef.current = newSettings.logoUrl;
                    cacheLogoForStore(storeId, newSettings.logoUrl);
                }
            },
            (err) => {
                setError(err);
                setIsLoading(false);
                console.error("Failed to subscribe to receipt settings:", err);
            }
        );

        return () => unsubscribe();

    }, [storeId]);

    return { settings, isLoading, error };
}
