/**
 * Toast de-dupe and timings - T-387 S4. Pure, so it is unit-tested in node (L6).
 *
 * The flash cookie lives 60 s and is not one-time (flash.ts): a reload or Back inside the minute replays it. The
 * Toaster therefore remembers each flash TOKEN it has shown in sessionStorage and shows a token once.
 */

export const TOAST_SEEN_KEY = 'shareat.toast.seen';
/** From the Feedback board: a success toast stays 4 s, a stamp 1.2 s. */
export const TOAST_MS = 4000;
export const STAMP_MS = 1200;
/** The seen list is capped so a long session cannot grow storage without limit. */
const MAX_SEEN = 20;

export interface SeenStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function readSeen(store: SeenStore): string[] {
  try {
    const raw = store.getItem(TOAST_SEEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** True when `token` is present and has not been shown yet. Never throws. */
export function shouldShow(token: string | null | undefined, store: SeenStore): boolean {
  if (!token) return false;
  return !readSeen(store).includes(token);
}

/** Remember `token`. Never throws (a blocked store just means the next load may show it again). */
export function markShown(token: string, store: SeenStore): void {
  try {
    const seen = readSeen(store).filter((t) => t !== token);
    seen.push(token);
    store.setItem(TOAST_SEEN_KEY, JSON.stringify(seen.slice(-MAX_SEEN)));
  } catch {
    /* storage blocked: nothing to remember with */
  }
}

/** Reduced motion skips the slam and fades the word in instead. */
export function stampAnimation(reducedMotion: boolean): 'slam' | 'fade' {
  return reducedMotion ? 'fade' : 'slam';
}
