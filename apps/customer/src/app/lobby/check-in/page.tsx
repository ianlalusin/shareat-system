'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button, Card, ErrorLine, PageTitle } from '@/components/ui';
import { getLobbyData } from '@/data/lobby-source';
import { useLobbyMenu } from '../lobby-menu';
import {
  LOBBY_NAME_MAX,
  LOBBY_NOTE_MAX,
  LOBBY_PARTY_MAX,
  LOBBY_PARTY_MIN,
  createCheckInAttempt,
  validateCheckIn,
  type CheckInErrors,
} from '../lobby-view';

/**
 * /lobby/check-in?s=CODE - name to call, party size, optional order, optional note. No phone, no email, no price.
 * One attempt keeps one request id, so tapping again after a bad connection never creates a second place in line.
 */
function CheckInScreen() {
  const router = useRouter();
  const storeCode = useSearchParams().get('s') ?? '';
  const menu = useLobbyMenu();
  const attempt = useRef(createCheckInAttempt());
  const [displayName, setDisplayName] = useState('');
  const [partySize, setPartySize] = useState(2);
  const [note, setNote] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<CheckInErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addons = (menu.items ?? []).filter((i) => i.kind === 'addon');

  async function submit() {
    if (busy) return;
    const lines = Object.entries(qty)
      .filter(([, n]) => n > 0)
      .map(([variantId, n]) => ({ variantId, qty: n, lineKind: 'a_la_carte' as const }));
    const v = validateCheckIn(storeCode, { displayName, partySize, note, lines }, attempt.current);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setServerError(null);
    setBusy(true);
    const r = await getLobbyData().checkIn(v.value);
    setBusy(false);
    if (r.ok) router.replace(`/lobby/wait?s=${encodeURIComponent(storeCode)}`);
    else setServerError(r.error);
  }

  if (!storeCode) {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">Scan the QR code at the entrance</p>
      </Card>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <PageTitle hint="We will call this name at the counter.">Join the line</PageTitle>
      {serverError ? <ErrorLine>{serverError}</ErrorLine> : null}

      <label className="mt-3 block text-sm font-medium" htmlFor="lobby-name">
        Name to call
      </label>
      <input
        id="lobby-name"
        name="displayName"
        type="text"
        maxLength={LOBBY_NAME_MAX}
        autoComplete="off"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        className="mt-1 min-h-[44px] w-full rounded-md border border-border bg-card px-3"
      />
      {errors.displayName ? <p className="mt-1 text-sm text-destructive">{errors.displayName}</p> : null}

      <p className="mt-4 text-sm font-medium">How many are in your party?</p>
      <div className="mt-1 flex items-center gap-3">
        <Button variant="secondary" aria-label="One less person" className="w-11 px-0" onClick={() => setPartySize((n) => Math.max(LOBBY_PARTY_MIN, n - 1))}>
          <Minus className="h-4 w-4" />
        </Button>
        <span aria-live="polite" className="w-8 text-center text-lg font-semibold">
          {partySize}
        </span>
        <Button variant="secondary" aria-label="One more person" className="w-11 px-0" onClick={() => setPartySize((n) => Math.min(LOBBY_PARTY_MAX, n + 1))}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {errors.partySize ? <p className="mt-1 text-sm text-destructive">{errors.partySize}</p> : null}

      {addons.length > 0 ? (
        <section className="mt-5" aria-label="Your order">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Order ahead (optional)</h3>
          <div className="space-y-2">
            {addons.map((item) => {
              const n = qty[item.id] ?? 0;
              return (
                <Card key={item.id} className="flex items-center justify-between gap-3 p-3">
                  <p className="font-medium">{item.name}</p>
                  <div className="flex items-center gap-1">
                    <Button variant="secondary" aria-label={`One less ${item.name}`} className="w-11 px-0" onClick={() => setQty((q) => ({ ...q, [item.id]: Math.max(0, n - 1) }))}>
                      <Minus className="h-4 w-4" />
                    </Button>
                    <span className="w-6 text-center font-semibold">{n}</span>
                    <Button aria-label={`One more ${item.name}`} className="w-11 px-0" onClick={() => setQty((q) => ({ ...q, [item.id]: n + 1 }))}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
          {errors.lines ? <p className="mt-1 text-sm text-destructive">{errors.lines}</p> : null}
        </section>
      ) : null}

      <label className="mt-5 block text-sm font-medium" htmlFor="lobby-note">
        Note (optional)
      </label>
      <input
        id="lobby-note"
        name="note"
        type="text"
        maxLength={LOBBY_NOTE_MAX}
        autoComplete="off"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="mt-1 min-h-[44px] w-full rounded-md border border-border bg-card px-3"
      />
      {errors.note ? <p className="mt-1 text-sm text-destructive">{errors.note}</p> : null}

      <Button type="submit" disabled={busy} className="mt-6 w-full">
        {busy ? 'Sending...' : 'Join the line'}
      </Button>
      <Link href={`/lobby?s=${encodeURIComponent(storeCode)}`} className="mt-3 block text-center text-sm text-muted-foreground underline">
        Back
      </Link>
    </form>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>}>
      <CheckInScreen />
    </Suspense>
  );
}
