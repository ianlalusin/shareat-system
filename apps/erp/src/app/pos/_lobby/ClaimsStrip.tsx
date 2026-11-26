'use client';

/**
 * T-644 S4 - the "Discount claims" strip on the Lobby tab: the store's pending senior / PWD claims (parties still waiting and parties already seated), each with Open.
 * It polls its own list every 10 s while the tab is open (one call in flight, `createClaimsPoller`); it never stamps `pos_seen_at` (the shell's lobby poll does that).
 * The list carries a masked ID only: the name and number appear in `ClaimDialog`, in its memory alone. Online only; nothing is decided here.
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge, Banner } from '@/components/ui';
import { listClaimsAction } from '../lobby/actions';
import { ClaimDialog } from './ClaimDialog';
import { claimLine, createClaimsPoller, type ClaimView } from './claims';
import { LOBBY_POLL_MS } from './logic';

// Plain literal: the touch-target census reads it.
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';

export function ClaimsStrip({ ready }: { ready: boolean }) {
  const [claims, setClaims] = useState<ClaimView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const poller = useMemo(() => createClaimsPoller({ list: () => listClaimsAction(), apply: (o) => ('claims' in o ? (setClaims(o.claims), setError(null)) : setError(o.error)) }), []);
  useEffect(() => {
    if (!ready) return;
    void poller.poll();
    const t = setInterval(() => void poller.poll(), LOBBY_POLL_MS);
    return () => clearInterval(t);
  }, [ready, poller]);

  if (!ready || (claims.length === 0 && !error && !notice && !openId)) return null;
  return (
    <section aria-label="Discount claims" className="flex flex-col gap-2 rounded-2xl border border-surface-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-ink">Discount claims</h2>
        {claims.length > 0 ? <Badge tone="info" label={`${claims.length} to check`} /> : null}
      </div>
      {notice ? <Banner tone="success">{notice}</Banner> : null}
      {error ? <Banner tone="warning">{error}</Banner> : null}
      <ul className="flex flex-col gap-2">
        {claims.map((c) => (
          <li key={c.claimId} className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-base text-ink">
              {claimLine(c)}
              {c.displayName ? ` · ${c.displayName}` : ''}
            </p>
            <button type="button" className={SECONDARY} aria-label={`Open claim ${c.code}`} onClick={() => (setNotice(null), setOpenId(c.claimId))}>
              Open
            </button>
          </li>
        ))}
      </ul>
      {openId ? (
        <ClaimDialog
          claimId={openId}
          onClose={(changed, said) => {
            setOpenId(null);
            if (said) setNotice(said);
            if (changed) void poller.poll();
          }}
        />
      ) : null}
    </section>
  );
}
