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
          <div className="toast-in flex max-w-md items-center gap-3 rounded-[20px] bg-ink py-3 pl-3 pr-5 text-[15px] font-medium text-canvas shadow-2xl ring-1 ring-black/5">
            <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success text-white">
              <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" focusable="false">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
            <span>{text}</span>
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
