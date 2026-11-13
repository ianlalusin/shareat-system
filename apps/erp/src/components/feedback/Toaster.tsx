'use client';

/**
 * Toaster - T-387 S4. Shows the flash `ok` as a toast (bottom right, 4 s) and the flash `stamp` word (1.2 s).
 * Mounted once in `app/layout.tsx`, outside AppShell, so sign-in and the kiosk get it too (L13).
 *
 * Server HTML is ONLY an empty polite live region: the text arrives from an effect, never in the server markup, so a
 * screen reader has the region before text is put in it and a replayed page never paints a stale toast. The
 * decisions (show once per token, which animation) live in `./toast-dedupe` (L6, L7).
 * Looks copied from docs/design/t387/Feedback.dc.html. Tokens only; animations live in globals.css.
 */
import { useEffect, useState } from 'react';
import { STAMP_MS, TOAST_MS, markShown, shouldShow, stampAnimation } from './toast-dedupe';

export interface ToasterProps {
  readonly token?: string | undefined;
  readonly ok?: string | undefined;
  readonly stamp?: string | undefined;
}

export function Toaster({ token, ok, stamp }: ToasterProps) {
  const [text, setText] = useState<string | null>(null);
  const [word, setWord] = useState<{ word: string; anim: 'slam' | 'fade' } | null>(null);

  useEffect(() => {
    if (!ok && !stamp) return;
    let store: Storage;
    try {
      store = window.sessionStorage;
    } catch {
      return; // storage blocked: cannot de-dupe, so show nothing rather than replay
    }
    if (!shouldShow(token, store)) return;
    markShown(token as string, store);
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (ok) {
      setText(ok);
      timers.push(setTimeout(() => setText(null), TOAST_MS));
    }
    if (stamp) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setWord({ word: stamp, anim: stampAnimation(reduced) });
      timers.push(setTimeout(() => setWord(null), STAMP_MS));
    }
    return () => timers.forEach(clearTimeout);
  }, [token, ok, stamp]);

  const stampTone = word?.word === 'VOID' ? 'border-danger text-danger' : 'border-success text-success';

  return (
    <>
      {/* T-448 (Ian, 2026-10-22): every toast shows in the middle of the screen, not the bottom-right corner. Below the
          VOID/POSTED stamp when both show, so they never cover each other. */}
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-none fixed inset-0 z-50 flex justify-center px-5 ${word ? 'items-end pb-[22vh]' : 'items-center'}`}
      >
        {text ? (
          <div
            data-toast-variant="ticket"
            className="toast-in relative flex min-w-0 max-w-md items-start gap-3 overflow-hidden rounded-[18px] border-2 border-[var(--toast-ink)] bg-[var(--toast)] py-3 pl-10 pr-5 text-sm text-[var(--toast-ink)] shadow-[6px_6px_0_var(--toast-edge)]"
          >
            <span aria-hidden="true" className="absolute inset-y-3 left-[14px] border-l-2 border-dashed border-black/25" />
            <span aria-hidden="true" className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white">
              <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" focusable="false">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
            <span className="relative min-w-0 break-words font-semibold leading-5 [overflow-wrap:anywhere]">{text}</span>
            <span aria-hidden="true" className="toast-progress absolute inset-x-0 bottom-0 h-[3px] origin-left bg-brand" />
          </div>
        ) : null}
      </div>
      {word ? (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
          <span
            className={`stamp-${word.anim} rounded-[14px] border-[6px] border-double px-[26px] py-2.5 font-display text-5xl font-extrabold tracking-[0.12em] ${stampTone}`}
          >
            {word.word}
          </span>
        </div>
      ) : null}
    </>
  );
}
