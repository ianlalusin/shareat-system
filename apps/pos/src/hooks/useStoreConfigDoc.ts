
'use client';

import { useState, useEffect, useMemo } from 'react';
import { doc, onSnapshot, DocumentData } from 'firebase/firestore';
import { db } from '@/lib/firebase/client';
import { useErpAdapted } from '@/lib/menu/useErpMenu';
import type { StoreTable, StorePackage, StoreFlavor, MenuSchedule, Discount, Charge, ModeOfPayment } from '@/lib/types';

export interface StoreConfig {
  tables: StoreTable[];
  packages: StorePackage[];
  flavors: StoreFlavor[];
  schedules: MenuSchedule[];
  discounts: Discount[];
  charges: Charge[];
  modesOfPayment: ModeOfPayment[];
  meta?: {
    updatedAt?: any;
    version?: number;
  };
}

export function useStoreConfigDoc(storeId?: string | null) {
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const erp = useErpAdapted();

  useEffect(() => {
    if (!storeId) {
      setIsLoading(false);
      setConfig(null);
      return;
    }

    setIsLoading(true);
    const configRef = doc(db, 'stores', storeId, 'storeConfig', 'current');

    const unsubscribe = onSnapshot(
      configRef,
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data() as DocumentData;
          setConfig({
            tables: data.tables || [],
            packages: data.packages || [],
            flavors: data.flavors || [],
            schedules: data.schedules || [],
            discounts: data.discounts || [],
            charges: data.charges || [],
            modesOfPayment: data.modesOfPayment || [],
            meta: data.meta || {},
          });
        } else {
          setConfig(null); // Document does not exist
        }
        setError(null);
        setIsLoading(false);
      },
      (err) => {
        console.error('Error fetching store config:', err);
        setError(err);
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [storeId]);

  // T-508 S5 (R9): with POS_MENU_SOURCE=erp the packages and flavours come from the ERP menu adapter (no dayparts: schedules empty);
  // tables, discounts, charges and tenders stay on the Firestore doc. Source `firestore` returns the doc untouched.
  const merged = useMemo<StoreConfig | null>(() => {
    if (!erp) return null;
    const base: StoreConfig = config ?? { tables: [], packages: [], flavors: [], schedules: [], discounts: [], charges: [], modesOfPayment: [] };
    return { ...base, packages: erp.packages, flavors: erp.flavors, schedules: [] };
  }, [erp, config]);
  return { config: merged ?? config, isLoading, error };
}
