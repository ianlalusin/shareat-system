'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorLine, PageTitle } from '@/components/ui';
import type { LobbyClaim } from '@/data/http-lobby-data';
import { getLobbyData } from '@/data/lobby-source';
import { createLobbyPoll } from '../lobby-poll';
import { CLAIM_ID_MAX, CLAIM_NAME_MAX, claimRowView, validateClaimForm, type ClaimForm } from '../lobby-view';

/**
 * /lobby/discount?s=CODE - claim the senior / PWD discount by typing the name and ID number as they are on the card. TYPED ONLY: there is no photo
 * or file control here (the "Scan my ID" button is S8). The name and ID number live in this form's state until Send and are then cleared; they are
 * never put in a URL, in storage or in the claim list (which shows the ID only as ****1187). The cashier still looks at the card and approves.
 */
const EMPTY: ClaimForm = { kind: '', holderName: '', idNumber: '' };

function DiscountScreen() {
  const storeCode = useSearchParams().get('s') ?? '';
  const [loaded, setLoaded] = useState(false);
  const [claims, setClaims] = useState<LobbyClaim[]>([]);
  const [missing, setMissing] = useState<string | null>(null);
  const [form, setForm] = useState<ClaimForm>(EMPTY);
  const [errors, setErrors] = useState<{ kind?: string; holderName?: string; idNumber?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof createLobbyPoll> | null>(null);

  const refresh = useCallback(async () => {
    if (!storeCode) return;
    let r;
    try {
      r = await getLobbyData().claims(storeCode);
    } catch {
      return; // a failed poll keeps the last view
    }
    if (r.ok) {
      setMissing(null);
      setClaims(r.value);
      setLoaded(true);
    } else if (r.status === 404 || r.status === 401) {
      pollRef.current?.stop();
      setMissing(r.error);
    }
  }, [storeCode]);

  useEffect(() => {
    if (!storeCode) return;
    const poll = createLobbyPoll({ poll: refresh, doc: document });
    pollRef.current = poll;
    poll.start();
    void refresh();
    return () => {
      poll.stop();
      pollRef.current = null;
    };
  }, [storeCode, refresh]);

  async function send() {
    if (busy) return;
    const checked = validateClaimForm(form);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setServerError(null);
    setBusy(true);
    const r = await getLobbyData().submitClaim({ storeCode, ...checked.value });
    setBusy(false);
    if (r.ok) {
      setForm(EMPTY); // the name and ID number leave the screen at once
      setClaims(r.value);
      setLoaded(true);
    } else {
      setServerError(r.error);
    }
  }

  async function cancel(claimId: string) {
    if (busy) return;
    setConfirmingId(null);
    setServerError(null);
    setBusy(true);
    const r = await getLobbyData().cancelClaim(storeCode, claimId);
    setBusy(false);
    if (r.ok) setClaims(r.value);
    else setServerError(r.error);
  }

  const back = (
    <Link href={`/lobby/wait?s=${encodeURIComponent(storeCode)}`} className="mt-4 block text-center text-sm text-muted-foreground underline">
      Back to my place in line
    </Link>
  );

  if (!storeCode) {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">Scan the QR code at the entrance</p>
      </Card>
    );
  }
  if (missing && !loaded) {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">{missing}</p>
        <Link href={`/lobby?s=${encodeURIComponent(storeCode)}`} className="mt-3 inline-block text-sm underline">
          Back to the line
        </Link>
      </Card>
    );
  }
  if (!loaded) return <p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>;

  const rows = claims.map(claimRowView);

  return (
    <div>
      <PageTitle hint="Show your card to the cashier. The discount is added only after the cashier checks it.">Senior / PWD discount</PageTitle>
      {rows.length > 0 ? (
        <ul className="mt-3 space-y-2" aria-label="Your discount claims">
          {rows.map((c) => (
            <li key={c.claimId} className="rounded-md border border-border bg-card px-3 py-3">
              <p className="text-sm font-semibold">
                {c.kindLabel} <span className="tabular-nums text-muted-foreground">{c.idMasked}</span>
              </p>
              <p role="status" className="mt-1 text-sm">
                {c.message}
              </p>
              {c.canCancel ? (
                confirmingId === c.claimId ? (
                  <div className="mt-2 flex items-center gap-2">
                    <Button variant="danger" disabled={busy} onClick={() => void cancel(c.claimId)}>
                      Yes, remove this claim
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirmingId(null)}>
                      Keep it
                    </Button>
                  </div>
                ) : (
                  <Button variant="secondary" className="mt-2" onClick={() => setConfirmingId(c.claimId)}>
                    Remove this claim
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {serverError ? (
        <div className="mt-3">
          <ErrorLine>{serverError}</ErrorLine>
        </div>
      ) : null}
      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        noValidate
      >
        <h2 className="text-base font-semibold">{rows.length > 0 ? 'Add another person' : 'Add a person'}</h2>
        <fieldset className="mt-2">
          <legend className="text-sm font-medium">Card type</legend>
          <div className="mt-1 flex gap-4">
            <label className="flex min-h-[44px] items-center gap-2 text-sm">
              <input type="radio" name="kind" value="senior" checked={form.kind === 'senior'} onChange={() => setForm({ ...form, kind: 'senior' })} />
              Senior
            </label>
            <label className="flex min-h-[44px] items-center gap-2 text-sm">
              <input type="radio" name="kind" value="pwd" checked={form.kind === 'pwd'} onChange={() => setForm({ ...form, kind: 'pwd' })} />
              PWD
            </label>
          </div>
          {errors.kind ? <p className="text-sm text-destructive">{errors.kind}</p> : null}
        </fieldset>
        <label className="mt-3 block text-sm font-medium" htmlFor="claim-name">
          Name as on the card
        </label>
        <input
          id="claim-name"
          name="holderName"
          type="text"
          maxLength={CLAIM_NAME_MAX}
          autoComplete="off"
          value={form.holderName}
          onChange={(e) => setForm({ ...form, holderName: e.target.value })}
          className="mt-1 min-h-[44px] w-full rounded-md border border-border bg-card px-3"
        />
        {errors.holderName ? <p className="mt-1 text-sm text-destructive">{errors.holderName}</p> : null}
        <label className="mt-3 block text-sm font-medium" htmlFor="claim-id">
          ID number
        </label>
        <input
          id="claim-id"
          name="idNumber"
          type="text"
          maxLength={CLAIM_ID_MAX}
          autoComplete="off"
          autoCapitalize="characters"
          value={form.idNumber}
          onChange={(e) => setForm({ ...form, idNumber: e.target.value })}
          className="mt-1 min-h-[44px] w-full rounded-md border border-border bg-card px-3"
        />
        {errors.idNumber ? <p className="mt-1 text-sm text-destructive">{errors.idNumber}</p> : null}
        <Button type="submit" disabled={busy} className="mt-6 w-full">
          {busy ? 'Sending...' : 'Send'}
        </Button>
      </form>
      {back}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>}>
      <DiscountScreen />
    </Suspense>
  );
}
