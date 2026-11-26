/**
 * T-644 S3 - the birthday song player: a plain HTML `<audio>` on the two files in `public/sounds` (ruling 5: NO native plugin; if the real-tablet test at Lipa fails, the
 * BirthdaySongPlugin of apps/pos becomes a follow-up). A port of the browser half of apps/pos/src/lib/birthday/player.ts as REQUIREMENTS: the two songs play in turn and loop
 * until stopped; the next Play starts at the song after the one last stopped when at least 75% of it played, otherwise at the same song again (remembered per tablet).
 * `play()` rejects when the first song cannot start (a browser may refuse sound with no tap: the screen then offers "Tap to play"). Everything the browser provides arrives in
 * `deps`, so a test needs no DOM.
 */

/** Played in this order, then looped until stopped. The files live in apps/erp/public/sounds. */
export const BIRTHDAY_PLAYLIST = ['/sounds/birthday-shareat.mp3', '/sounds/happy-birthday.mp3'] as const;
/** A song counts as heard once this much of it has played. */
const HEARD_FRACTION = 0.75;
const RESUME_KEY = 'erp.pos.birthdaySong.lastStop';

/** The parts of an HTMLAudioElement used here (a test passes a plain object). */
export type AudioLike = Pick<HTMLAudioElement, 'src' | 'currentTime' | 'duration' | 'onended' | 'onerror' | 'play' | 'pause' | 'removeAttribute' | 'load'>;
export interface PlayerStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
export interface PlayerDeps {
  newAudio: () => AudioLike;
  storage: PlayerStorage | null;
}
export interface BirthdayPlayer {
  /** Plays the songs on a loop until `stop()`. Resolves once the first song has started; rejects when it cannot start. */
  play(): Promise<void>;
  stop(): void;
  /** The index of the playing song, or null when nothing plays. */
  current(): number | null;
  subscribe(listener: (track: number | null) => void): () => void;
}

const next = (i: number) => (i + 1) % BIRTHDAY_PLAYLIST.length;

export function createBirthdayPlayer(deps: PlayerDeps): BirthdayPlayer {
  let track: number | null = null;
  let stopNow: (() => void) | null = null;
  const listeners = new Set<(t: number | null) => void>();
  const setTrack = (t: number | null) => {
    track = t;
    listeners.forEach((l) => l(t));
  };

  // Storage can be unavailable (private mode, cleared data): then play simply starts from the first song.
  const readLastStop = (): { track: number; fraction: number } | null => {
    try {
      const raw = deps.storage?.getItem(RESUME_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as { track?: unknown; fraction?: unknown } | null;
      return typeof v?.track === 'number' && typeof v.fraction === 'number' ? { track: v.track, fraction: v.fraction } : null;
    } catch {
      return null;
    }
  };
  const writeLastStop = (t: number, fraction: number): void => {
    try {
      deps.storage?.setItem(RESUME_KEY, JSON.stringify({ track: t, fraction }));
    } catch {
      /* storage unavailable */
    }
  };
  const startTrack = (): number => {
    const last = readLastStop();
    if (!last || !Number.isInteger(last.track) || last.track < 0 || last.track >= BIRTHDAY_PLAYLIST.length) return 0;
    return last.fraction >= HEARD_FRACTION ? next(last.track) : last.track;
  };

  function stop(): void {
    stopNow?.();
    stopNow = null;
    setTrack(null);
  }

  async function play(): Promise<void> {
    stop();
    const el = deps.newAudio();
    let index = startTrack();
    let stopped = false;
    const playAt = (i: number): Promise<void> => {
      index = i;
      el.src = BIRTHDAY_PLAYLIST[i] ?? BIRTHDAY_PLAYLIST[0];
      setTrack(i);
      return el.play();
    };
    el.onended = () => {
      if (!stopped) void playAt(next(index)).catch(() => undefined);
    };
    // A broken file skips to the other song instead of going silent.
    el.onerror = () => {
      if (!stopped) void playAt(next(index)).catch(() => undefined);
    };
    stopNow = () => {
      stopped = true;
      writeLastStop(index, el.duration > 0 ? el.currentTime / el.duration : 0);
      el.onended = null;
      el.onerror = null;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
    try {
      await playAt(index);
    } catch (e) {
      stop();
      throw e;
    }
  }

  return {
    play,
    stop,
    current: () => track,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
