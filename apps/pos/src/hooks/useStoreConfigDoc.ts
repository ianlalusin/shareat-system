
'use client';

import { useState, useEffect } from 'react';
import { doc, onSnapshot, DocumentData } from 'firebase/firestore';
import { db } from '@/lib/firebase/client';
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

  return { config, isLoading, error };
}
