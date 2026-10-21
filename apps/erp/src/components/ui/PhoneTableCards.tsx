'use client';

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { observePhoneTables } from './phone-table-cards';

const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Server-rendered children stay server-rendered; only presentation annotations run in the browser. */
export function PhoneTableCards({ children }: { readonly children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useBeforePaint(() => root.current ? observePhoneTables(root.current) : undefined, []);
  return <div ref={root} className="contents" data-phone-table-root="">{children}</div>;
}
