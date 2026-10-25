'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Card, PageTitle } from '@/components/ui';
import type { LobbyResult } from '@/data/http-lobby-data';
import type { LobbyStoreView } from '@/data/lobby-data';
import { getLobbyData } from '@/data/lobby-source';
import { LobbyMenu } from './lobby-menu';
import { storeScreenView } from './lobby-view';

/** /lobby?s=CODE - store name, "N parties waiting", the way in to the check-in form, and the menu. A closed store shows only the counter sentence and the menu. */
function StoreScreen() {
  const storeCode = useSearchParams().get('s') ?? '';
  const [result, setResult] = useState<LobbyResult<LobbyStoreView> | null>(null);

  useEffect(() => {
    if (!storeCode) return;
    let alive = true;
    void getLobbyData()
      .getStore(storeCode)
      .then((r) => {
        if (alive) setResult(r);
      });
    return () => {
      alive = false;
    };
  }, [storeCode]);

  if (!storeCode) {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">Scan the QR code at the entrance</p>
        <p className="mt-1 text-sm text-muted-foreground">It opens the line for this branch.</p>
      </Card>
    );
  }
  if (!result) return <p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>;

  const view = storeScreenView(result);
  return (
    <div>
      <PageTitle hint={view.waitingText || undefined}>{view.title}</PageTitle>
      {view.notice ? (
        <p role="status" className="mb-4 rounded-md border border-border bg-muted px-3 py-3 text-center text-sm font-semibold">
          {view.notice}
        </p>
      ) : null}
      {view.showForm && view.checkInHref ? (
        <Link
          href={view.checkInHref}
          className="mb-6 inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
        >
          Join the line
        </Link>
      ) : null}
      {view.showMenu ? (
        <section aria-label="Menu">
          <h3 className="mb-2 text-base font-bold">Menu</h3>
          <LobbyMenu />
        </section>
      ) : null}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>}>
      <StoreScreen />
    </Suspense>
  );
}
