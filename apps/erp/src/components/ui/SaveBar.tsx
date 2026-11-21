import type { ReactNode } from 'react';

/** The sticky bottom bar of a long form: the save stays on screen while the form scrolls under it. */
export function SaveBar({ children }: { readonly children: ReactNode }) {
  return <div className="sticky bottom-0 z-10 -mx-2 border-t border-surface-border bg-canvas/95 px-2 py-3 backdrop-blur">{children}</div>;
}
