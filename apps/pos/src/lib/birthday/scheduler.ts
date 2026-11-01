/**
 * T-455 S6b - the tablet's birthday scheduler. An ACCEPTED request plays at its time with a short Stop countdown (A8). The server does not
 * time-gate play (S6a ruling 7), so this clock is the tablet's own. What is kept in storage (A6): request id and time only, per store - never a
 * diner or celebrant name - plus the ids still to be reported as played. A request more than 30 minutes past its time is dropped on restore (A7).
 * Each request is forgotten the moment its countdown ends, so it can never play twice, even across a reload.
 */
export interface SchedulerStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface SchedulerDeps {
  storage: SchedulerStorage;
  playSong(): Promise<void>;
  markPlayed(requestId: string): Promise<void>;
  storeId: string;
  countdownSeconds?: number;
}

export interface SchedulerState {
  countdown: { requestId: string; secondsLeft: number } | null;
  pending: string[];
}

export interface Scheduler {
  accept(i: { requestId: string; scheduledAt: number }): void;
  restore(): void;
  stop(requestId: string): void;
  flushPlayed(): Promise<void>;
  state(): SchedulerState;
  /** Unmount: clears every timer and the countdown. Storage is left as is, so a remount restores the schedule. */
  dispose(): void;
  /** Called whenever the state changes (a screen re-reads `state()`); returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export const BIRTHDAY_STALE_MINUTES = 30;
const STALE_MS = BIRTHDAY_STALE_MINUTES * 60_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

interface Stored {
  items: { requestId: string; scheduledAt: number }[];
  toMark: string[];
}

export function createBirthdayScheduler(deps: SchedulerDeps): Scheduler {
  const key = `pos2.birthdaySchedule.${deps.storeId}`;
  const seconds = deps.countdownSeconds ?? 10;
  const items = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const toMark: string[] = [];
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let countdown: { requestId: string; secondsLeft: number } | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

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
      /* storage unavailable: the schedule lives in memory for this run only */
    }
  }

  function endCountdown(): void {
    if (tick) clearInterval(tick);
    tick = null;
    countdown = null;
  }

  async function fire(requestId: string): Promise<void> {
    if (disposed) return;
    items.delete(requestId);
    endCountdown();
    let started = false;
    try {
      await deps.playSong();
      started = true;
    } catch {
      /* the song could not start: nothing to report; the request stays accepted on the server until it expires */
    }
    if (started) {
      toMark.push(requestId);
    }
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
    const now = Date.now();
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
    const wait = at - Date.now();
    if (wait <= 0) {
      startNextDue();
      return;
    }
    timers.set(requestId, setTimeout(() => {
      timers.delete(requestId);
      const due = items.get(requestId);
      if (due !== undefined && due > Date.now()) arm(requestId); // fired early (clock moved, or a clamped long wait): wait again
      else startNextDue();
    }, Math.min(wait, MAX_TIMEOUT_MS)));
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
        // 409: the server closed that request (played, expired, cancelled): never going to succeed, drop it. Offline (0) / 5xx: retry on the next poll.
        if ((err as { status?: unknown } | null)?.status === 409) {
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
      const now = Date.now();
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
    flushPlayed,
    state() {
      return { countdown, pending: [...items.keys()] };
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
