'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Delete } from 'lucide-react';
import { Button, Card, ErrorLine } from '@/components/ui';
import { useCustomerData, useDemoControls, useSession } from '@/data/provider';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export default function Page() {
  const router = useRouter();
  const data = useCustomerData();
  const demo = useDemoControls();
  const { session, setSession, deviceId, ready } = useSession();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function join(code: string) {
    if (!deviceId || busy) return;
    setBusy(true);
    setError(null);
    const r = await data.joinByPin(code, deviceId);
    setBusy(false);
    if (r.ok) {
      setSession(r.value);
      setPin('');
      router.push('/menu');
    } else {
      setError(r.reason);
      setPin('');
    }
  }

  function press(d: string) {
    if (busy || pin.length >= 6) return;
    const next = pin + d;
    setPin(next);
    setError(null);
    if (next.length === 6) void join(next);
  }

  return (
    <div className="space-y-4">
      <div className="pt-2 text-center">
        <h1 className="text-2xl font-extrabold">Shareat Customer v2</h1>
        <p className="mt-1 text-sm text-muted-foreground">Join your table to order from your phone.</p>
      </div>

      {ready && session ? (
        <Card className="text-center">
          <p className="font-semibold">
            You are at {session.tableLabel}, {session.store.name}.
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <Link href="/menu">
              <span className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground">
                Go to menu
              </span>
            </Link>
            <Button variant="secondary" onClick={() => setSession(null)}>
              Leave table
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <p className="text-center text-sm font-semibold">Type the 6-digit PIN on your table</p>
        <div className="my-4 flex justify-center gap-2" aria-label="PIN entered so far">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={`flex h-12 w-10 items-center justify-center rounded-md border text-xl font-bold ${i < pin.length ? 'border-primary bg-primary/10' : 'border-border'}`}
            >
              {i < pin.length ? '•' : ''}
            </span>
          ))}
        </div>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <Button key={k} variant="secondary" className="h-14 text-xl" onClick={() => press(k)} disabled={busy || !deviceId}>
              {k}
            </Button>
          ))}
          <span />
          <Button variant="secondary" className="h-14 text-xl" onClick={() => press('0')} disabled={busy || !deviceId}>
            0
          </Button>
          <Button variant="ghost" className="h-14" aria-label="Delete last digit" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy}>
            <Delete className="h-6 w-6" />
          </Button>
        </div>
      </Card>

      <Card>
        <p className="text-sm font-semibold">Or scan the table QR code</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Use your phone camera on the QR code on your table. It opens this app and seats you automatically.
        </p>
      </Card>

      {demo ? (
        <Card className="border-dashed">
          <p className="text-sm font-semibold">Demo tables</p>
          <ul className="mt-2 space-y-2 text-sm">
            {demo.tables.map((t) => (
              <li key={t.qrToken} className="flex items-center justify-between gap-2">
                <span>
                  {t.storeName}, {t.label}
                  <br />
                  <span className="text-muted-foreground">PIN {t.pin}</span>
                </span>
                <Link href={`/join?t=${encodeURIComponent(t.qrToken)}`} className="min-h-[44px] content-center text-xs underline">
                  Try QR link
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
