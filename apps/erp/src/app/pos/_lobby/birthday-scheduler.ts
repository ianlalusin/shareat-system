/**
 * T-644 S3 - the tablet's birthday scheduler, a port of apps/pos/src/lib/birthday/scheduler.ts as REQUIREMENTS. An ACCEPTED request plays at its time with a short Stop
 * countdown. The server does not time-gate play (T-455 S6a ruling 7), so this clock is the tablet's own. What is kept in storage: request id and time only, per store
 * - never a diner or celebrant name - plus the ids still to be reported as played. A request more than 30 minutes past its time is dropped on restore and while waiting.
 * Each request is forgotten the moment its countdown ends, so it can never play twice, even across a reload.
 * New here: a browser can refuse to start sound without a tap (autoplay policy). That request is then `blocked` (not lost): the screen shows "Tap to play", and only a
 * tap that really starts the song reports it played. A blocked request is held in memory only (a reload drops it; the server expires it 30 minutes after its time).
 */
export interface SchedulerStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface SchedulerDeps {
  storage: SchedulerStorage;
  /** Starts the song; rejects when it cannot start (for example the autoplay policy). */
  playSong(): Promise<void>;
  /** Tells the server. Throws an error with `final: true` when the server closed the request for good (never going to work); any other throw is retried on the next tick. */
  markPlayed(requestId: string): Promise<void>;
  storeId: string;
  countdownSeconds?: number;
  /** Web Locks (`navigator.locks`): only one tab plays a given request. Left out, the browser's own is used; `null` means none (a tab then plays without asking). */
  locks?: LocksLike | null;
}

export interface LocksLike {
  request(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<void>): Promise<unknown>;
}

export interface SchedulerState {
  countdown: { requestId: string; secondsLeft: number } | null;
  pending: string[];
  /** The request whose song the browser would not start by itself: the screen shows "Tap to play". */
  blocked: string | null;
}

export interface Scheduler {
  accept(i: { requestId: string; scheduledAt: number }): void;
  restore(): void;
  stop(requestId: string): void;
  /** The "Tap to play" tap: starts the song for the blocked request now, and reports it played when it starts. False when it still cannot start (or nothing is blocked). */
  playBlocked(): Promise<boolean>;
  dismissBlocked(): void;
  flushPlayed(): Promise<void>;
  state(): SchedulerState;
  /** Unmount: clears every timer and the countdown. Storage is left as is, so a remount restores the schedule. */
  dispose(): void;
  /** Called whenever the state changes (a screen re-reads `state()`); returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const STALE_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

interface Stored {
  items: { requestId: string; scheduledAt: number }[];
  toMark: string[];
}

export function createBirthdayScheduler(deps: SchedulerDeps): Scheduler {
  const key = `erp.pos.birthdaySchedule.${deps.storeId}`;
  const seconds = deps.countdownSeconds ?? 10;
  const clock = () => Date.now();
  const items = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const toMark: string[] = [];
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let countdown: { requestId: string; secondsLeft: number } | null = null;
  let blocked: { requestId: string; scheduledAt: number } | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let storageOk = true; // false once a write failed: then storage cannot say whether another tab took a request

  const emit = () => listeners.forEach((l) => l());

  function persist(): void {
    try {
      if (items.size === 0 && toMark.length === 0) {
        deps.storage.removeItem(key);
        return;
      }
      const v: Stored = { items: [...items].map(([requestId, scheduledAt]) => ({ requestId, scheduledAt })), toMark: [...toMark] };
      deps.storage.setItem(key, JSON.stringify(v));
    } catch {
      storageOk = false; // storage unavailable or blocked: the schedule lives in memory for this run only
    }
  }

  /** Another tab that fired first has already removed the id from storage. Unreadable storage counts as "not taken". */
  function takenByAnotherTab(requestId: string): boolean {
    if (!storageOk) return false;
    try {
      const raw = deps.storage.getItem(key);
      const st = raw ? (JSON.parse(raw) as Stored) : null;
      return !(st && Array.isArray(st.items) && st.items.some((i) => i?.requestId === requestId));
    } catch {
      return false;
    }
  }

  function endCountdown(): void {
    if (tick) clearInterval(tick);
    tick = null;
    countdown = null;
  }

  async function fire(requestId: string): Promise<void> {
    if (disposed) return;
    const locks = deps.locks !== undefined ? deps.locks : typeof navigator !== 'undefined' ? ((navigator as unknown as { locks?: LocksLike }).locks ?? null) : null;
    if (!locks) return play(requestId);
    await locks.request(`shareat-birthday:${requestId}`, { ifAvailable: true }, async (lock) => {
      if (lock) await play(requestId);
      else giveUp(requestId); // another tab is playing this request
    });
  }

  function giveUp(requestId: string): void {
    items.delete(requestId);
    endCountdown();
    emit();
    startNextDue();
  }

  async function play(requestId: string): Promise<void> {
    if (disposed) return;
    if (takenByAnotherTab(requestId)) return giveUp(requestId);
    const scheduledAt = items.get(requestId) ?? clock();
    items.delete(requestId);
    endCountdown();
    persist(); // forgotten before the song starts, so another tab (or a reload) cannot play it again
    let started = false;
    try {
      await deps.playSong();
      started = true;
    } catch {
      // The browser would not start the sound: keep the request for a "Tap to play" tap. Nothing is reported to the server.
      blocked = { requestId, scheduledAt };
    }
    if (started) toMark.push(requestId);
    persist();
    emit();
    if (disposed) return;
    if (started) await flushPlayed();
    startNextDue();
  }

  function startCountdown(requestId: string): void {
    const t = timers.get(requestId);
    if (t) clearTimeout(t);
    timers.delete(requestId);
    countdown = { requestId, secondsLeft: seconds };
    emit();
    tick = setInterval(() => {
      if (!countdown) return;
      countdown = { requestId: countdown.requestId, secondsLeft: countdown.secondsLeft - 1 };
      if (countdown.secondsLeft <= 0) {
        void fire(requestId);
      } else {
        emit();
      }
    }, 1000);
  }

  function startNextDue(): void {
    if (countdown || disposed) return;
    const now = clock();
    let dropped = false;
    for (const [id, at] of [...items]) {
      if (now - at > STALE_MS) {
        items.delete(id);
        const t = timers.get(id);
        if (t) clearTimeout(t);
        timers.delete(id);
        dropped = true;
      }
    }
    if (dropped) {
      persist();
      emit();
    }
    const due = [...items].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1])[0];
    if (due) startCountdown(due[0]);
  }

  function arm(requestId: string): void {
    const at = items.get(requestId);
    if (at === undefined) return;
    const old = timers.get(requestId);
    if (old) clearTimeout(old);
    timers.delete(requestId);
    const wait = at - clock();
    if (wait <= 0) {
      startNextDue();
      return;
    }
    timers.set(
      requestId,
      setTimeout(() => {
        timers.delete(requestId);
        const due = items.get(requestId);
        if (due !== undefined && due > clock()) arm(requestId); // fired early (clock moved, or a clamped long wait): wait again
        else startNextDue();
      }, Math.min(wait, MAX_TIMEOUT_MS)),
    );
  }

  async function flushPlayed(): Promise<void> {
    for (const id of [...toMark]) {
      if (inFlight.has(id)) continue;
      inFlight.add(id);
      try {
        await deps.markPlayed(id);
        const i = toMark.indexOf(id);
        if (i >= 0) toMark.splice(i, 1);
        persist();
      } catch (err) {
        // `final`: the server closed that request (played, expired, cancelled, not ours): never going to succeed, drop it. Offline / server down: retry on the next tick.
        if ((err as { final?: unknown } | null)?.final === true) {
          const i = toMark.indexOf(id);
          if (i >= 0) toMark.splice(i, 1);
          persist();
        }
      } finally {
        inFlight.delete(id);
      }
    }
  }

  return {
    accept({ requestId, scheduledAt }) {
      items.set(requestId, scheduledAt);
      persist();
      arm(requestId);
      emit();
    },
    restore() {
      let stored: Stored | null = null;
      try {
        const raw = deps.storage.getItem(key);
        stored = raw ? (JSON.parse(raw) as Stored) : null;
      } catch {
        stored = null;
      }
      const now = clock();
      for (const it of stored && Array.isArray(stored.items) ? stored.items : []) {
        if (typeof it?.requestId !== 'string' || typeof it.scheduledAt !== 'number') continue;
        if (now - it.scheduledAt > STALE_MS) continue;
        if (!items.has(it.requestId)) items.set(it.requestId, it.scheduledAt);
      }
      for (const id of stored && Array.isArray(stored.toMark) ? stored.toMark : []) {
        if (typeof id === 'string' && !toMark.includes(id)) toMark.push(id);
      }
      persist();
      for (const id of [...items.keys()]) arm(id);
      emit();
    },
    stop(requestId) {
      const t = timers.get(requestId);
      if (t) clearTimeout(t);
      timers.delete(requestId);
      items.delete(requestId);
      if (countdown?.requestId === requestId) endCountdown();
      persist();
      emit();
      startNextDue();
    },
    async playBlocked() {
      const b = blocked;
      if (!b || disposed) return false;
      if (clock() - b.scheduledAt > STALE_MS) {
        // too late to sing: let it go (the server expires it by itself)
        blocked = null;
        emit();
        return false;
      }
      try {
        await deps.playSong();
      } catch {
        return false; // still blocked: the button stays
      }
      blocked = null;
      toMark.push(b.requestId);
      persist();
      emit();
      await flushPlayed();
      return true;
    },
    dismissBlocked() {
      blocked = null;
      emit();
    },
    flushPlayed,
    state() {
      return { countdown, pending: [...items.keys()], blocked: blocked ? blocked.requestId : null };
    },
    dispose() {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      endCountdown();
      listeners.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
