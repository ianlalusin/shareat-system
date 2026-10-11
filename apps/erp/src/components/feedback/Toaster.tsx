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
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-50 max-w-[calc(100vw-2.5rem)]">
        {text ? (
          <div className="toast-in rounded-2xl bg-ink px-[18px] py-3.5 text-[15px] text-canvas shadow-lg">{text}</div>
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
