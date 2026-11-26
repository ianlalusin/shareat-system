'use client';

/**
 * T-644 S4 - the cashier's side of one senior / PWD discount claim (docs/tasks/644-lobby-in-erp-pos.md, S4 and ruling 6). It is mounted ONLY while a claim is open, so closing it drops
 * everything. ⛔ The name and ID number live ONLY in this component's state: never localStorage, never a prop handed up, never a log line. The cashier compares them with the card, ticks
 * "I have seen the card", picks the diner number at the party's seated table and approves; or declines with one of the fixed reasons (no typing). Approving records the claim only: the
 * discount itself is added at payment, where the claim is offered to the cashier (`DiscountSheet`). A lost answer is checked with the server before anything is said.
 */
import { useEffect, useRef, useState } from 'react';
import { Banner, Dialog } from '@/components/ui';
import { approveClaimAction, claimStatusAction, openClaimAction, rejectClaimAction } from '../lobby/actions';
import { CLAIM_REJECT_REASONS, DINER_NO_MAX, claimApproveBlock, decideWithRecheck, type OpenedClaimView } from './claims';
import { LOBBY_NEEDS_INTERNET } from './logic';

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const CHIP = 'min-h-12 inline-flex w-full items-center justify-start rounded-2xl border border-surface-border bg-surface px-4 py-2 text-left text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const DINER = 'min-h-12 min-w-12 shrink-0 rounded-2xl border px-3 text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const idle = 'border-surface-border bg-surface text-ink hover:bg-canvas';

/** `changed` is true after an approve or a reject, so the strip re-reads at once; `notice` is the sentence for the strip. */
export function ClaimDialog({ claimId, onClose }: { claimId: string; onClose: (changed: boolean, notice?: string) => void }) {
  const [opened, setOpened] = useState<OpenedClaimView | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [dinerNo, setDinerNo] = useState<number | null>(null);
  const [cardSeen, setCardSeen] = useState(false); // always starts OFF: the cashier sees the card every time
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const started = useRef(false); // one "open" per mount: every open writes an audit row

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const r = await openClaimAction({ claimId });
        if (r.ok) setOpened(r.claim);
        else setProblem(r.error);
      } catch {
        setProblem(LOBBY_NEEDS_INTERNET);
      } finally {
        setLoading(false);
      }
    })();
  }, [claimId]);

  // Closing wipes the name and ID number from memory (the dialog unmounts with it).
  const close = (changed: boolean, notice?: string) => {
    setOpened(null);
    setCardSeen(false);
    onClose(changed, notice);
  };

  const block = claimApproveBlock({ sessionRef: opened?.sessionRef ?? null, dinerNo, cardSeen });
  const kindLabel = opened?.kind === 'pwd' ? 'PWD' : 'Senior';
  const diners = opened ? Array.from({ length: Math.min(Math.max(1, opened.partySize), DINER_NO_MAX) }, (_, n) => n + 1) : [];

  /** One move at a time (a ref, so a second tap in the same moment sees it). */
  const run = async (wanted: 'approved' | 'rejected', act: () => ReturnType<typeof approveClaimAction>) => {
    if (busyNow.current) return;
    busyNow.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const r = await decideWithRecheck(wanted, { act, status: () => claimStatusAction({ claimId }) });
      if (r.done) close(true, wanted === 'approved' ? 'Discount claim approved. Add the discount when the table pays.' : 'Discount claim declined.');
      else setProblem(r.message);
    } finally {
      busyNow.current = false;
      setBusy(false);
    }
  };
  const approve = () => {
    if (!opened || opened.sessionRef === null || dinerNo === null || block !== null) return;
    const sessionId = opened.sessionRef;
    void run('approved', () => approveClaimAction({ claimId, sessionId, dinerNo, cardSeen: true }));
  };
  const reject = (reasonCode: string) => {
    if (!opened) return;
    void run('rejected', () => rejectClaimAction({ claimId, reasonCode }));
  };

  return (
    <Dialog open onClose={() => close(false)} title="Senior / PWD discount claim" description="Check the card against what the diner typed. Approving does not take any money off: add the discount when the table pays." size="md">
      {loading ? (
        <p className="text-base text-muted">Opening the claim…</p>
      ) : !opened ? (
        <Banner tone="error">{problem ?? 'Could not open this claim.'}</Banner>
      ) : (
        <div className="flex flex-col gap-4">
          {problem ? <Banner tone="error">{problem}</Banner> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base text-ink">
            <dt className="text-muted">Kind</dt>
            <dd className="font-semibold">{kindLabel}</dd>
            <dt className="text-muted">Name</dt>
            <dd className="font-semibold break-words">{opened.holderName}</dd>
            <dt className="text-muted">ID number</dt>
            <dd className="font-semibold break-all">{opened.idNumber}</dd>
          </dl>
          {opened.sessionRef === null ? (
            <Banner tone="info">Seat the party first, then approve the claim. You can still decline it.</Banner>
          ) : (
            <section aria-label="Diner" className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-muted">Diner number at the table</h3>
              <div className="flex flex-nowrap gap-2 overflow-x-auto pb-2 [scrollbar-width:thin]">
                {diners.map((n) => (
                  <button key={n} type="button" className={`${DINER} ${dinerNo === n ? 'border-ink bg-ink text-canvas' : idle}`} aria-pressed={dinerNo === n} aria-label={`Diner ${n}`} disabled={busy} onClick={() => setDinerNo(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </section>
          )}
          <label className="flex min-h-12 items-center gap-3 text-base text-ink">
            <input type="checkbox" className="h-6 w-6" checked={cardSeen} disabled={busy} onChange={(e) => setCardSeen(e.target.checked)} />I have seen the card
          </label>
          {opened.sessionRef !== null && block ? <p className="text-sm text-muted">{block}</p> : null}
          <button type="button" className={PRIMARY} disabled={busy || block !== null} aria-disabled={busy || block !== null} onClick={approve}>
            {busy ? 'Saving…' : 'Approve'}
          </button>
          <div className="flex flex-col gap-2 border-t border-surface-border pt-3">
            <p className="text-sm text-muted">Or decline. The diner reads the sentence you pick.</p>
            {CLAIM_REJECT_REASONS.map((r) => (
              <button key={r.code} type="button" className={CHIP} disabled={busy} onClick={() => reject(r.code)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
