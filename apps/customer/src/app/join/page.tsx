'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Card, ErrorLine } from '@/components/ui';
import { useCustomerData, useSession } from '@/data/provider';

/** QR landing. useSearchParams must sit inside Suspense so the page can be pre-rendered (static export). */
function QrJoin() {
  const params = useSearchParams();
  const token = params.get('t');
  const router = useRouter();
  const data = useCustomerData();
  const { setSession, deviceId } = useSession();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!deviceId || started.current) return;
    if (!token) {
      setError('This link has no table code. Please scan the QR code on your table again.');
      return;
    }
    started.current = true;
    void data.joinByQr(token, deviceId).then((r) => {
      if (r.ok) {
        setSession(r.value);
        router.replace('/menu');
      } else {
        setError(r.reason);
      }
    });
  }, [data, deviceId, router, setSession, token]);

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorLine>{error}</ErrorLine>
        <Link href="/" className="inline-block">
          <span className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground">
            Type the table PIN instead
          </span>
        </Link>
      </div>
    );
  }
  return <p className="py-8 text-center text-sm text-muted-foreground">Joining your table...</p>;
}

export default function Page() {
  return (
    <Card className="mt-4">
      <h1 className="mb-2 text-xl font-bold">Joining your table</h1>
      <Suspense fallback={<p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>}>
        <QrJoin />
      </Suspense>
    </Card>
  );
}
