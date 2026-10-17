'use client';

import { useState } from 'react';
import { RequireSession } from '@/components/app-shell';
import { Button, Card, ErrorLine, PageTitle, Stars } from '@/components/ui';
import { useCustomerData, useSession } from '@/data/provider';
import type { FeedbackOutcome } from '@/data/types';

function FeedbackScreen() {
  const data = useCustomerData();
  const { session } = useSession();
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<(FeedbackOutcome & { rating: number }) | null>(null);

  async function send() {
    if (!session || busy) return;
    if (rating < 1) {
      setError('Please choose 1 to 5 stars.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await data.submitFeedback(session.sessionId, session.participantId, rating, text.trim());
    setBusy(false);
    if (r.ok) setDone({ ...r.value, rating });
    else setError(r.reason);
  }

  if (done) {
    return (
      <Card className="mt-4 space-y-3 text-center">
        <p className="text-lg font-bold">Thank you!</p>
        {done.managerAlerted ? <p className="text-sm">We are sorry about your visit. A manager has been told.</p> : null}
        {done.googleReviewUrl ? (
          <p className="text-sm">
            Glad you enjoyed it.{' '}
            <a href={done.googleReviewUrl} target="_blank" rel="noreferrer" className="font-semibold underline">
              Leave us a Google review
            </a>
          </p>
        ) : null}
      </Card>
    );
  }

  return (
    <div>
      <PageTitle hint="How was your visit today?">Feedback</PageTitle>
      <Card className="space-y-4">
        <Stars value={rating} onChange={setRating} disabled={busy} />
        <label className="block text-sm font-medium">
          Anything you want to tell us? (optional)
          <textarea
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded-md border border-input bg-background p-3 text-base"
          />
        </label>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <Button className="w-full" onClick={() => void send()} disabled={busy}>
          {busy ? 'Sending...' : 'Send feedback'}
        </Button>
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <RequireSession>
      <FeedbackScreen />
    </RequireSession>
  );
}
