'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorLine, PageTitle } from '@/components/ui';
import type { LobbyBirthday } from '@/data/http-lobby-data';
import { getLobbyData } from '@/data/lobby-source';
import { createLobbyPoll } from '../lobby-poll';
import { BIRTHDAY_NAME_MAX, birthdayScreenView, validateBirthdayName } from '../lobby-view';

/**
 * /lobby/birthday?s=CODE - the celebrant's first name (optional) and Send; then the status: waiting for the cashier, "Accepted for 7:30 PM",
 * or "Sorry, not tonight: (reason)". Refreshed every 10 s while the page is visible, until nothing can change any more. The phone is identified
 * by its cookie only; no entry id or request id is ever shown or sent.
 */
function BirthdayScreen() {
  const storeCode = useSearchParams().get('s') ?? '';
  const [loaded, setLoaded] = useState(false);
  const [birthday, setBirthday] = useState<LobbyBirthday | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pollRef = useRef<ReturnType<typeof createLobbyPoll> | null>(null);
  const finalRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!storeCode || finalRef.current) return;
    let r;
    try {
      r = await getLobbyData().birthday(storeCode);
    } catch {
      return; // a failed poll keeps the last view
    }
    if (r.ok) {
      setMissing(null);
      setBirthday(r.value);
      setLoaded(true);
      if (birthdayScreenView(r.value).final) {
        finalRef.current = true;
        pollRef.current?.stop();
      }
    } else if (r.status === 404 || r.status === 401) {
      finalRef.current = true;
      pollRef.current?.stop();
      setMissing(r.error);
    }
  }, [storeCode]);

  useEffect(() => {
    if (!storeCode) return;
    finalRef.current = false;
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
    const checked = validateBirthdayName(name);
    if (!checked.ok) {
      setNameError(checked.error);
      return;
    }
    setNameError(null);
    setServerError(null);
    setBusy(true);
    const r = await getLobbyData().requestBirthday(storeCode, checked.value);
    setBusy(false);
    if (r.ok) {
      setBirthday(r.value);
      setLoaded(true);
      finalRef.current = false;
      pollRef.current?.start();
    } else {
      setServerError(r.error);
    }
  }

  async function cancel() {
    if (busy) return;
    setConfirming(false);
    setServerError(null);
    setBusy(true);
    const r = await getLobbyData().cancelBirthday(storeCode);
    setBusy(false);
    if (r.ok) setBirthday(r.value);
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

  const view = birthdayScreenView(birthday);

  if (view.kind === 'form') {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        noValidate
      >
        <PageTitle hint="Tell us who is celebrating. The cashier will pick a time or let you know.">Birthday song</PageTitle>
        {serverError ? <ErrorLine>{serverError}</ErrorLine> : null}
        <label className="mt-3 block text-sm font-medium" htmlFor="birthday-name">
          Celebrant&apos;s first name (optional)
        </label>
        <input
          id="birthday-name"
          name="celebrantName"
          type="text"
          maxLength={BIRTHDAY_NAME_MAX}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 min-h-[44px] w-full rounded-md border border-border bg-card px-3"
        />
        {nameError ? <p className="mt-1 text-sm text-destructive">{nameError}</p> : null}
        <Button type="submit" disabled={busy} className="mt-6 w-full">
          {busy ? 'Sending...' : 'Send'}
        </Button>
        {back}
      </form>
    );
  }

  return (
    <div className="text-center">
      <PageTitle hint="">Birthday song</PageTitle>
      <p role="status" className="mt-4 rounded-md bg-primary px-3 py-3 text-base font-bold text-primary-foreground">
        {view.message}
      </p>
      {serverError ? (
        <div className="mt-4">
          <ErrorLine>{serverError}</ErrorLine>
        </div>
      ) : null}
      {view.canCancel ? (
        <div className="mt-8">
          {confirming ? (
            <div className="flex items-center justify-center gap-2">
              <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
                Yes, cancel the song
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </div>
          ) : (
            <Button variant="secondary" className="w-full" onClick={() => setConfirming(true)}>
              Cancel the request
            </Button>
          )}
        </div>
      ) : null}
      {back}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>}>
      <BirthdayScreen />
    </Suspense>
  );
}
