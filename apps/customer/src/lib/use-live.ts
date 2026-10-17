'use client';

import { useEffect, useRef, useState } from 'react';
import type { CustomerData } from '@/data/customer-data';
import { useCustomerData, useSession } from '@/data/provider';
import type { Result } from '@/data/types';

export interface LiveState<T> {
  value: T | null;
  error: string | null;
  loading: boolean;
}

/** Loads something for the joined table and reloads it whenever the store pushes an order change. */
export function useLive<T>(load: (data: CustomerData, sessionId: string) => Promise<Result<T>>, live = true): LiveState<T> {
  const data = useCustomerData();
  const { session } = useSession();
  const loadRef = useRef(load);
  loadRef.current = load;
  const [state, setState] = useState<LiveState<T>>({ value: null, error: null, loading: true });
  const sessionId = session?.sessionId ?? null;

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const run = () => {
      void loadRef.current(data, sessionId).then((r) => {
        if (!alive) return;
        setState(r.ok ? { value: r.value, error: null, loading: false } : { value: null, error: r.reason, loading: false });
      });
    };
    run();
    const off = live ? data.subscribe(sessionId, run) : undefined;
    return () => {
      alive = false;
      off?.();
    };
  }, [data, sessionId, live]);

  return state;
}
