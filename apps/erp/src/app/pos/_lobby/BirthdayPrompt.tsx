'use client';

/**
 * T-644 S3 - the birthday-song request prompt, mounted by `PosShell` so it works on EVERY tab (docs/tasks/644-lobby-in-erp-pos.md, S3). A diner's request arrives through
 * `listBirthdaysAction` (polled every 10 s, one call in flight at a time), one request at a time, oldest first. The cashier taps Accept (Now, or at a time) or one of the three fixed
 * Decline reasons; no free typing. While an Orders seat / order sheet is open the prompt is a bottom banner, not a dialog. An accepted request goes to the tablet's scheduler: at its
 * time a 10 s countdown with a Stop button runs, then the song plays (a plain `<audio>`) and the server is told. If the browser refuses sound without a tap, a "Tap to play" bar
 * stays until the cashier taps it. Only request ids and times are kept in this tablet's local storage. Nothing here decides a rule: the server judges every move.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Dialog } from '@/components/ui';
import { acceptBirthdayAction, declineBirthdayAction, listBirthdaysAction, markBirthdayPlayedAction } from '../lobby/actions';
import { BIRTHDAY_DECLINE_PRESETS, createBirthdayPoller, nextToAnswer, promptView, timeToEpoch, type BirthdayView, type PromptMode } from './birthday';
import { createBirthdayPlayer } from './birthday-player';
import { createBirthdayScheduler, type Scheduler, type SchedulerState } from './birthday-scheduler';
import { BirthdaySongButton } from './BirthdaySongButton';
import { LOBBY_NEEDS_INTERNET, LOBBY_POLL_MS } from './logic';
import { useSheetOpen } from './sheet-open';

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const CHOICE = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border px-5 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const FIELD = 'min-h-12 rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const BAR = 'fixed inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-surface-border bg-surface p-3 shadow-lg';

const IDLE: SchedulerState = { countdown: null, pending: [], blocked: null };

/** Local storage, or a plain in-memory stand-in when the browser blocks it (the schedule then lives for this run only). */
function tabletStorage() {
  try {
    return window.localStorage;
  } catch {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  }
}

/** `storeId` is the paired store when this tablet may take requests (null: nothing runs); `online` gates the poll and the answers. */
export function BirthdayPrompt({ storeId, online }: { storeId: string | null; online: boolean }) {
  const sheetOpen = useSheetOpen();
  const [rows, setRows] = useState<BirthdayView[]>([]);
  const [answered, setAnswered] = useState<string[]>([]);
  const [mode, setMode] = useState<PromptMode>('auto');
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [time, setTime] = useState('12:00');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tapFailed, setTapFailed] = useState(false);
  const [sched, setSched] = useState<SchedulerState>(IDLE);
  const scheduler = useRef<Scheduler | null>(null);
  // One player for the shell's life: the song keeps going while the cashier moves between tabs.
  const player = useMemo(() => createBirthdayPlayer({ newAudio: () => new Audio(), storage: tabletStorage() }), []);

  useEffect(() => {
    if (!storeId) return;
    const s = createBirthdayScheduler({
      storage: tabletStorage(),
      storeId,
      playSong: () => player.play(),
      markPlayed: async (requestId) => {
        const r = await markBirthdayPlayedAction({ requestId });
        // A refusal is the server's final word (closed, expired, not this store's); a thrown error (no network) is retried on the next tick.
        if (!r.ok) throw Object.assign(new Error(r.error), { final: true });
      },
    });
    scheduler.current = s;
    const off = s.subscribe(() => setSched(s.state()));
    s.restore();
    setSched(s.state());
    return () => {
      off();
      s.dispose();
      scheduler.current = null;
    };
  }, [storeId, player]);

  const poller = useMemo(
    () => createBirthdayPoller({ list: () => listBirthdaysAction(), apply: setRows, flush: async () => void (await scheduler.current?.flushPlayed()) }),
    [],
  );
  const live = storeId !== null && online;
  useEffect(() => {
    if (!live) return;
    void poller.poll();
    const t = setInterval(() => void poller.poll(), LOBBY_POLL_MS);
    return () => clearInterval(t);
  }, [live, poller]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const current = storeId ? nextToAnswer(rows, answered) : null;
  const currentId = current?.requestId ?? null;
  // A new request starts fresh: dialog (or banner over a sheet), no half-chosen answer.
  useEffect(() => {
    setMode('auto');
    setDeclining(false);
    setWhen('now');
    setProblem(null);
  }, [currentId]);

  const fail = (r: { error: string } | null) => setProblem(r ? r.error : LOBBY_NEEDS_INTERNET);

  const accept = async () => {
    if (!current) return;
    const at = when === 'now' ? Date.now() : timeToEpoch(time, Date.now());
    setBusy(true);
    setProblem(null);
    try {
      const r = await acceptBirthdayAction({ requestId: current.requestId, scheduledAt: new Date(at).toISOString() });
      if (!r.ok) return fail(r);
      setAnswered((a) => [...a, current.requestId]);
      scheduler.current?.accept({ requestId: current.requestId, scheduledAt: at });
      setNotice(when === 'now' ? 'Birthday song accepted. It plays now.' : `Birthday song accepted. It plays at ${time}.`);
    } catch {
      fail(null);
    } finally {
      setBusy(false);
      void poller.poll();
    }
  };

  const decline = async (reason: string) => {
    if (!current) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await declineBirthdayAction({ requestId: current.requestId, reason });
      if (!r.ok) return fail(r);
      setAnswered((a) => [...a, current.requestId]);
      setDeclining(false);
    } catch {
      fail(null);
    } finally {
      setBusy(false);
      void poller.poll();
    }
  };

  const tapToPlay = useCallback(async () => {
    setTapFailed(false);
    const started = await scheduler.current?.playBlocked();
    if (started === false && scheduler.current?.state().blocked) setTapFailed(true);
  }, []);

  const countdown = sched.countdown;
  const view = promptView({ hasRequest: current !== null, sheetOpen, mode });
  const who = current ? [current.code, current.displayName, current.standLabel ? `Stand ${current.standLabel}` : null, current.celebrantName ? `for ${current.celebrantName}` : null].filter(Boolean).join(' · ') : '';

  return (
    <>
      {storeId ? <BirthdaySongButton player={player} /> : null}
      {notice ? (
        <p role="status" className="fixed bottom-24 left-4 z-40 rounded-full bg-success-soft px-4 py-2 text-sm font-semibold text-success shadow-lg sm:bottom-6">
          {notice}
        </p>
      ) : null}

      {/* A small bar, not a modal: an open order underneath stays usable while the countdown runs. */}
      {countdown ? (
        <div role="status" className={`${BAR} z-50`}>
          <span className="text-base font-semibold text-ink">{`Birthday song in ${countdown.secondsLeft}…`}</span>
          <button type="button" className={SECONDARY} onClick={() => scheduler.current?.stop(countdown.requestId)}>
            Stop
          </button>
        </div>
      ) : sched.blocked ? (
        <div role="status" className={`${BAR} z-50`}>
          <span className="text-base font-semibold text-ink">{tapFailed ? 'The sound is still blocked. Check the tablet volume, then tap again.' : 'The birthday song is ready. Tap to play it.'}</span>
          <span className="flex shrink-0 gap-2">
            <button type="button" className={SECONDARY} onClick={() => void tapToPlay()}>
              Tap to play
            </button>
            <button type="button" className={SECONDARY} onClick={() => scheduler.current?.dismissBlocked()}>
              Skip
            </button>
          </span>
        </div>
      ) : view === 'banner' ? (
        <div role="status" className={`${BAR} z-40`}>
          <span className="text-base font-semibold text-ink">Birthday request waiting</span>
          <button type="button" className={SECONDARY} onClick={() => setMode('open')}>
            Answer
          </button>
        </div>
      ) : null}

      {/* Hidden while the countdown or the tap bar needs the screen (a modal would cover their buttons); closing it for that reason is not the cashier choosing "later". */}
      <Dialog open={view === 'dialog' && !countdown && !sched.blocked} onClose={() => (!countdown && !sched.blocked ? setMode('later') : undefined)} title="Birthday song request" description={who} size="sm">
        {current ? (
          declining ? (
            <div className="flex flex-col gap-2">
              {problem ? <Banner tone="error">{problem}</Banner> : null}
              {BIRTHDAY_DECLINE_PRESETS.map((p) => (
                <button key={p} type="button" className={SECONDARY} disabled={busy || !online} onClick={() => void decline(p)}>
                  {p}
                </button>
              ))}
              <button type="button" className={SECONDARY} disabled={busy} onClick={() => setDeclining(false)}>
                Back
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {problem ? <Banner tone="error">{problem}</Banner> : null}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" aria-pressed={when === 'now'} className={`${CHOICE} ${when === 'now' ? 'border-ink bg-warning-soft text-ink' : 'border-surface-border bg-surface text-ink hover:bg-canvas'}`} onClick={() => setWhen('now')}>
                  Now
                </button>
                <button type="button" aria-pressed={when === 'later'} className={`${CHOICE} ${when === 'later' ? 'border-ink bg-warning-soft text-ink' : 'border-surface-border bg-surface text-ink hover:bg-canvas'}`} onClick={() => setWhen('later')}>
                  At a time
                </button>
                {when === 'later' ? <input type="time" className={FIELD} aria-label="Birthday song time" value={time} onChange={(e) => setTime(e.target.value)} /> : null}
              </div>
              <button type="button" className={PRIMARY} disabled={busy || !online || (when === 'later' && time === '')} onClick={() => void accept()}>
                Accept
              </button>
              <button type="button" className={SECONDARY} disabled={busy || !online} onClick={() => setDeclining(true)}>
                Decline
              </button>
            </div>
          )
        ) : null}
      </Dialog>
    </>
  );
}
