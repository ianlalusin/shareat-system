'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { rememberScreen } from './screen-state';

export function ScreenState({ scope }: { readonly scope: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const pathname = usePathname(), search = useSearchParams().toString();
  useEffect(() => {
    const root = marker.current?.closest('main');
    return root ? rememberScreen(root, scope) : undefined;
  }, [scope, pathname, search]);
  return <span ref={marker} hidden data-screen-state={scope} />;
}
