'use client';

/**
 * T-644 S3 - the manual play / stop badge (apps/pos BirthdaySongButton): tap to play the birthday songs on a loop, tap again to stop. Playback lives in the player the shell
 * prompt owns, so it keeps going while the cashier moves between tabs. It does not tell the server anything: a request is reported played only by the scheduler.
 */
import { useEffect, useRef, useState } from 'react';
import type { BirthdayPlayer } from './birthday-player';

export function BirthdaySongButton({ player }: { player: BirthdayPlayer }) {
  const [track, setTrack] = useState<number | null>(() => player.current());
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  useEffect(() => player.subscribe(setTrack), [player]);
  useEffect(() => player.subscribeGaveUp(() => setFailed(true)), [player]);
  const playing = track !== null;

  const toggle = async () => {
    if (busy.current) return; // a quick double tap cannot interleave a start and a stop
    busy.current = true;
    setFailed(false);
    try {
      if (player.current() !== null) player.stop();
      else await player.play();
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="fixed bottom-24 right-4 z-40 flex items-center gap-2 sm:bottom-6">
      {failed ? (
        <span role="alert" className="rounded-full bg-danger-surface px-3 py-2 text-sm font-semibold text-danger">
          Could not play
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void toggle()}
        aria-pressed={playing}
        aria-label={playing ? 'Stop birthday song' : 'Play birthday song'}
        title={playing ? 'Stop birthday song' : 'Play birthday song'}
        className={`flex h-14 w-14 items-center justify-center rounded-full border-2 shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink ${playing ? 'border-danger bg-surface text-danger' : 'border-transparent bg-brand text-white'}`}
      >
        {playing ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" width={24} height={24} fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24" width={24} height={24} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V6l10-2v12" />
            <circle cx="6.5" cy="18" r="2.5" />
            <circle cx="16.5" cy="16" r="2.5" />
          </svg>
        )}
      </button>
    </div>
  );
}
