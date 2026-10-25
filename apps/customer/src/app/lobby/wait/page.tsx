'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorLine } from '@/components/ui';
import { getLobbyData } from '@/data/lobby-source';
import { createWaitController } from '../wait-controller';
import type { WaitView } from '../lobby-view';

/**
 * /lobby/wait?s=CODE - the big code, where the party stands (refreshed every 10 s while this page is visible), Cancel, and the hand-off:
 * when the cashier seats the party the phone moves to the server's link with location.replace, once.
 */
function WaitScreen() {
  const storeCode = useSearchParams().get('s') ?? '';
  const [view, setView] = useState<WaitView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const controller = useRef<ReturnType<typeof createWaitController> | null>(null);

  useEffect(() => {
    if (!storeCode) return;
    const c = createWaitController({
      data: getLobbyData(),
      storeCode,
      doc: document,
      loc: window.location,
      origin: window.location.origin,
      onView: (v) => {
        setProblem(null);
        setView(v);
      },
      onMissing: (m) => setProblem(m),
      onCancelError: (m) => setProblem(m),
    });
    controller.current = c;
    c.start();
    return () => {
      c.stop();
      controller.current = null;
    };
  }, [storeCode]);

  if (!storeCode) {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">Scan the QR code at the entrance</p>
      </Card>
    );
  }
  if (problem && !view) {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">{problem}</p>
        <Link href={`/lobby?s=${encodeURIComponent(storeCode)}`} className="mt-3 inline-block text-sm underline">
          Back to the line
        </Link>
      </Card>
    );
  }
  if (!view) return <p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>;

  if (view.kind === 'closed') {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">Your place in line is closed.</p>
        <p className="mt-1 text-sm text-muted-foreground">Please check in at the counter if you are still here.</p>
        <Link href={`/lobby?s=${encodeURIComponent(storeCode)}`} className="mt-3 inline-block text-sm underline">
          Back to the line
        </Link>
      </Card>
    );
  }
  if (view.kind === 'handoff') {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">Your table is ready.</p>
        <p className="mt-1 text-sm text-muted-foreground">{view.handoffUrl && !problem ? 'Opening your table...' : 'Please check in at the counter.'}</p>
      </Card>
    );
  }

  return (
    <div className="text-center">
      <p className="mt-4 text-sm text-muted-foreground">Your number</p>
      <p aria-label="Your code" className="text-7xl font-extrabold tracking-widest">
        {view.code}
      </p>
      <p className="mt-3 text-lg font-semibold">{view.positionText}</p>
      {view.notice ? (
        <p role="status" className="mt-4 rounded-md bg-primary px-3 py-3 text-base font-bold text-primary-foreground">
          {view.notice}
        </p>
      ) : null}
      {problem ? (
        <div className="mt-4">
          <ErrorLine>{problem}</ErrorLine>
        </div>
      ) : null}
      {view.canCancel ? (
        <div className="mt-8">
          {confirming ? (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(false);
                  void controller.current?.cancel();
                }}
              >
                Yes, cancel my place
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Keep my place
              </Button>
            </div>
          ) : (
            <Button variant="secondary" className="w-full" onClick={() => setConfirming(true)}>
              Cancel
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>}>
      <WaitScreen />
    </Suspense>
  );
}
