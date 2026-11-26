import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIRTHDAY_DECLINE_PRESETS, createBirthdayPoller, nextToAnswer, promptView, strictIso, timeToEpoch, type BirthdayListResult, type BirthdayView } from '../src/app/pos/_lobby/birthday';
import { BIRTHDAY_PLAYLIST, createBirthdayPlayer, type AudioLike } from '../src/app/pos/_lobby/birthday-player';
import { createBirthdayScheduler, type SchedulerDeps, type SchedulerStorage } from '../src/app/pos/_lobby/birthday-scheduler';

/**
 * T-644 S3 - birthday songs in the live POS: the pure half (scheduler, player, poller, prompt rules) and its wiring. No database, no DOM; the clock is fake.
 * MUTANT INDEX (each title ends with "[kills: ...]"): a countdown that is not 10 s, or a song played before it ends; a Stop that lets the song play anyway or leaves the id in storage;
 * a request older than 30 minutes that still plays; a storage failure that throws or stops the schedule; names kept in storage; a request reported played before (or without) the song starting;
 * a refused song that is lost instead of offered as Tap to play; a failed report retried forever or a transient one dropped; a request that plays twice after a reload; a poller with no
 * single-flight rule; a time that is not a strict timestamp; a past time of day scheduled in the past; a request answered twice or an accepted one asked again; a dialog over an open sheet;
 * a decline reason the domain would refuse; a player that says it plays after the browser refused; a song rotation that ignores how much was heard; a native plugin; a birthday poll mounted on one tab only.
 */
const SRC = resolve(__dirname, '..', 'src', 'app', 'pos');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');
const T0 = new Date('2026-11-26T10:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const memStorage = () => {
  const m = new Map<string, string>();
  const s: SchedulerStorage & { m: Map<string, string> } = { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  return s;
};
const brokenStorage: SchedulerStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};
function setup(over: Partial<SchedulerDeps> = {}) {
  const storage = memStorage();
  const log: string[] = [];
  const s = createBirthdayScheduler({
    storage,
    storeId: 'st1',
    playSong: async () => void log.push('play'),
    markPlayed: async (id) => void log.push(`mark:${id}`),
    ...over,
  });
  return { s, storage, log };
}
const KEY = 'erp.pos.birthdaySchedule.st1';
const stored = (m: Map<string, string>) => JSON.parse(m.get(KEY) ?? 'null') as { items: { requestId: string; scheduledAt: number }[]; toMark: string[] } | null;

describe('the scheduler: countdown, Stop, and what plays when', () => {
  it('a request that is due starts a 10 second countdown, and the song plays only when it ends, then the server is told [kills: a countdown that is not 10 s, a song played before the countdown ends, a report sent before the song]', async () => {
    const { s, log } = setup();
    s.accept({ requestId: 'r1', scheduledAt: T0 });
    expect(s.state().countdown).toEqual({ requestId: 'r1', secondsLeft: 10 });
    await vi.advanceTimersByTimeAsync(9000);
    expect(s.state().countdown?.secondsLeft).toBe(1);
    expect(log, 'nothing played with a second to go').toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toEqual(['play', 'mark:r1']);
    expect(s.state().countdown).toBeNull();
    s.dispose();
  });

  it('a time in the future waits, then counts down [kills: a future request that plays at once]', async () => {
    const { s, log } = setup();
    s.accept({ requestId: 'r1', scheduledAt: T0 + 60_000 });
    expect(s.state()).toEqual({ countdown: null, pending: ['r1'], blocked: null });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(s.state().countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.state().countdown?.secondsLeft).toBe(10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(['play', 'mark:r1']);
    s.dispose();
  });

  it('Stop ends the countdown: no song, no report, and the request is gone from storage so a reload cannot bring it back [kills: a Stop that lets the song play anyway, a Stop that leaves the id in storage]', async () => {
    const { s, storage, log } = setup();
    s.accept({ requestId: 'r1', scheduledAt: T0 });
    await vi.advanceTimersByTimeAsync(4000);
    s.stop('r1');
    expect(s.state()).toEqual({ countdown: null, pending: [], blocked: null });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log).toEqual([]);
    expect(storage.m.has(KEY), 'storage is cleared when nothing is left').toBe(false);
    const again = createBirthdayScheduler({ storage, storeId: 'st1', playSong: async () => void log.push('play'), markPlayed: async () => undefined });
    again.restore();
    expect(again.state().countdown).toBeNull();
    again.dispose();
    s.dispose();
  });

  it('a request more than 30 minutes past its time is dropped when the tablet restarts, one inside the window still plays [kills: a request older than 30 minutes that still plays, a window that drops a fresh one]', async () => {
    const { s, storage, log } = setup();
    storage.m.set(KEY, JSON.stringify({ items: [{ requestId: 'old', scheduledAt: T0 - 31 * 60_000 }, { requestId: 'fresh', scheduledAt: T0 - 5 * 60_000 }], toMark: [] }));
    s.restore();
    expect(s.state().pending).toEqual(['fresh']);
    expect(s.state().countdown?.requestId).toBe('fresh');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(['play', 'mark:fresh']);
    s.dispose();
  });

  it('a request accepted for a time already more than 30 minutes gone is dropped at once and never plays [kills: the stale drop applied only on restart]', async () => {
    const { s, log } = setup();
    s.accept({ requestId: 'r1', scheduledAt: T0 - 31 * 60_000 });
    expect(s.state()).toEqual({ countdown: null, pending: [], blocked: null });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log).toEqual([]);
    s.dispose();
  });

  it('with local storage blocked nothing throws and the song still plays this run [kills: a storage failure that throws or stops the schedule]', async () => {
    const { s, log } = setup({ storage: brokenStorage });
    expect(() => s.restore()).not.toThrow();
    expect(() => s.accept({ requestId: 'r1', scheduledAt: T0 })).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(['play', 'mark:r1']);
    s.dispose();
  });

  it('storage keeps request ids and times only, per store, never a name [kills: names or other fields kept in storage]', () => {
    const { s, storage } = setup();
    s.accept({ requestId: 'r1', scheduledAt: T0 + 5000 });
    expect([...storage.m.keys()]).toEqual([KEY]);
    expect(stored(storage.m)).toEqual({ items: [{ requestId: 'r1', scheduledAt: T0 + 5000 }], toMark: [] });
    s.dispose();
  });

  it('after the song, a reload does not play it again [kills: a request that plays twice after a reload]', async () => {
    const { s, storage, log } = setup();
    s.accept({ requestId: 'r1', scheduledAt: T0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(['play', 'mark:r1']);
    const again = createBirthdayScheduler({ storage, storeId: 'st1', playSong: async () => void log.push('play2'), markPlayed: async () => undefined });
    again.restore();
    expect(again.state().countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log).toEqual(['play', 'mark:r1']);
    again.dispose();
    s.dispose();
  });
});

describe('played is reported only after the song starts', () => {
  it('the report waits for the song: while play() is still pending nothing is sent, and it is sent right after [kills: a request reported played before the song starts]', async () => {
    let release: () => void = () => undefined;
    const log: string[] = [];
    const { s } = setup({
      playSong: () =>
        new Promise<void>((res) => {
          release = () => {
            log.push('started');
            res();
          };
        }),
      markPlayed: async (id) => void log.push(`mark:${id}`),
    });
    s.accept({ requestId: 'r1', scheduledAt: T0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log, 'play() has not answered yet').toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['started', 'mark:r1']);
    s.dispose();
  });

  it('a song the browser refuses is NOT reported and is offered as Tap to play; a tap that fails keeps it, a tap that works plays and reports it once [kills: a refused song reported played, a refused song lost, a tap that reports without playing]', async () => {
    let allow = false;
    const { s, log } = setup({
      playSong: async () => {
        if (!allow) throw new DOMException('blocked', 'NotAllowedError');
        log.push('play');
      },
    });
    s.accept({ requestId: 'r1', scheduledAt: T0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.state().blocked, 'the screen shows Tap to play for this request').toBe('r1');
    expect(s.state().countdown).toBeNull();
    expect(log, 'nothing reported').toEqual([]);
    expect(await s.playBlocked()).toBe(false);
    expect(s.state().blocked, 'still offered after a failed tap').toBe('r1');
    expect(log).toEqual([]);
    allow = true;
    expect(await s.playBlocked()).toBe(true);
    expect(log).toEqual(['play', 'mark:r1']);
    expect(s.state().blocked).toBeNull();
    expect(await s.playBlocked(), 'nothing left to tap').toBe(false);
    expect(log).toHaveLength(2);
    s.dispose();
  });

  it('Skip clears the Tap to play offer without reporting, and a tap after the 30 minute window plays nothing [kills: a Skip that reports played, a very late song]', async () => {
    const { s, log } = setup({
      playSong: async () => {
        throw new Error('blocked');
      },
    });
    s.accept({ requestId: 'r1', scheduledAt: T0 });
    await vi.advanceTimersByTimeAsync(10_000);
    s.dismissBlocked();
    expect(s.state().blocked).toBeNull();
    s.accept({ requestId: 'r2', scheduledAt: T0 + 10_000 });
    await vi.advanceTimersByTimeAsync(10_000); // r2 due, countdown, then blocked again
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.state().blocked).toBe('r2');
    vi.setSystemTime(T0 + 20_000 + 31 * 60_000);
    expect(await s.playBlocked()).toBe(false);
    expect(s.state().blocked).toBeNull();
    expect(log).toEqual([]);
    s.dispose();
  });

  it('a final refusal from the server drops the report for good; any other failure is tried again on the next tick [kills: a report retried forever, a transient failure dropped]', async () => {
    let mode: 'final' | 'transient' = 'transient';
    let calls = 0;
    const { s, storage } = setup({
      markPlayed: async () => {
        calls += 1;
        throw mode === 'final' ? Object.assign(new Error('closed'), { final: true }) : new Error('offline');
      },
    });
    s.accept({ requestId: 'r1', scheduledAt: T0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
    expect(stored(storage.m)?.toMark, 'kept for a retry').toEqual(['r1']);
    await s.flushPlayed();
    expect(calls).toBe(2);
    mode = 'final';
    await s.flushPlayed();
    expect(calls).toBe(3);
    expect(storage.m.has(KEY), 'dropped for good').toBe(false);
    await s.flushPlayed();
    expect(calls).toBe(3);
    s.dispose();
  });
});

describe('two tabs, one song', () => {
  /** A stand-in for navigator.locks: a held name answers null to an ifAvailable request. */
  const fakeLocks = () => {
    const held = new Set<string>();
    return {
      async request(name: string, _o: { ifAvailable: true }, cb: (lock: object | null) => Promise<void>) {
        if (held.has(name)) return cb(null);
        held.add(name);
        try {
          await cb({});
        } finally {
          held.delete(name);
        }
      },
    };
  };
  const twoTabs = (locks: ReturnType<typeof fakeLocks> | null) => {
    const storage = memStorage();
    const log: string[] = [];
    const mk = (tab: string) =>
      createBirthdayScheduler({ storage, storeId: 'st1', locks, playSong: async () => void log.push(`play:${tab}`), markPlayed: async (id) => void log.push(`mark:${tab}:${id}`) });
    return { a: mk('a'), b: mk('b'), storage, log };
  };

  it('two tabs whose countdowns end together: exactly one plays, the other lets go [kills: a request that plays in every open tab, a lock that is not checked]', async () => {
    const { a, b, log } = twoTabs(fakeLocks());
    a.accept({ requestId: 'r1', scheduledAt: T0 });
    b.accept({ requestId: 'r1', scheduledAt: T0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.filter((l) => l.startsWith('play:'))).toHaveLength(1);
    expect(b.state().pending, 'the tab that lost lets go of it').toEqual([]);
    expect(b.state().countdown).toBeNull();
    a.dispose();
    b.dispose();
  });

  it('without Web Locks, a tab skips a request another tab already removed from storage [kills: a fire that never re-reads storage before playing]', async () => {
    const { a, b, log } = twoTabs(null);
    a.accept({ requestId: 'r1', scheduledAt: T0 });
    b.accept({ requestId: 'r1', scheduledAt: T0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.filter((l) => l.startsWith('play:'))).toHaveLength(1);
    a.dispose();
    b.dispose();
  });

  it('a request is out of storage the moment its song begins, not after it ends [kills: a persist that waits for the song]', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { s, storage } = setup({ playSong: () => gate });
    s.accept({ requestId: 'r1', scheduledAt: T0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.m.has(KEY), 'gone while play() is still pending').toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    s.dispose();
  });
});

describe('the poller is single-flight', () => {
  const row = (over: Partial<BirthdayView> = {}): BirthdayView => ({ requestId: 'r1', code: '4821', displayName: 'Ana', standLabel: '5', celebrantName: 'Ben', status: 'requested', scheduledAt: null, createdAt: '2026-11-26T10:00:00.000Z', ...over });

  it('asks the server once while a call is open, then once more (not once per skipped tick); each answer is followed by the played-report flush [kills: a poller with no single-flight rule, a flush that never runs]', async () => {
    vi.useRealTimers();
    let calls = 0;
    let flushes = 0;
    const open: ((r: BirthdayListResult) => void)[] = [];
    const seen: BirthdayView[][] = [];
    const poller = createBirthdayPoller({
      list: () => (calls++, new Promise<BirthdayListResult>((res) => open.push(res))),
      apply: (rows) => seen.push(rows),
      flush: async () => void flushes++,
    });
    const first = poller.poll();
    void poller.poll();
    void poller.poll();
    expect(calls).toBe(1);
    open[0]!({ ok: true, birthdays: [row()] });
    await first;
    expect(calls, 'the skipped ticks collapse into one re-run').toBe(2);
    open[1]!({ ok: true, birthdays: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([[row()], []]);
    expect(flushes).toBe(2);
  });

  it('a refused or failed call keeps the last list and never throws [kills: a failed poll that blanks the list or breaks the loop]', async () => {
    vi.useRealTimers();
    const seen: BirthdayView[][] = [];
    let mode: 'ok' | 'refused' | 'throws' = 'ok';
    const poller = createBirthdayPoller({
      list: async () => {
        if (mode === 'throws') throw new Error('network');
        return mode === 'refused' ? { ok: false, error: 'No.' } : { ok: true, birthdays: [row()] };
      },
      apply: (rows) => seen.push(rows),
      flush: async () => undefined,
    });
    await poller.poll();
    mode = 'refused';
    await poller.poll();
    mode = 'throws';
    await expect(poller.poll()).resolves.toBeUndefined();
    expect(seen).toEqual([[row()]]);
  });
});

describe('the prompt rules', () => {
  it('only a strict ISO timestamp is a time [kills: a loose date string reaching the domain as a time]', () => {
    expect(strictIso('2026-11-26T10:00:00.000Z')?.getTime()).toBe(T0);
    expect(strictIso('2026-11-26T18:00:00+08:00')?.getTime()).toBe(T0);
    for (const bad of ['2026-11-26', '2026-02-31T10:00:00Z', 'tomorrow', '5', '', null, undefined, 5, {}]) expect(strictIso(bad), String(bad)).toBeNull();
  });

  it('a time of day is today, and one already gone means tomorrow [kills: a past time of day scheduled in the past, so it plays at once]', () => {
    const now = new Date(2026, 10, 26, 10, 0, 0, 0).getTime();
    expect(timeToEpoch('12:00', now)).toBe(new Date(2026, 10, 26, 12, 0, 0, 0).getTime());
    expect(timeToEpoch('09:30', now)).toBe(new Date(2026, 10, 26, 9, 30, 0, 0).getTime() + 24 * 3_600_000);
  });

  it('one request at a time, oldest first: an accepted one and one just answered are skipped [kills: an accepted request asked again, a request answered twice]', () => {
    const rows = [
      { requestId: 'a', status: 'accepted' },
      { requestId: 'b', status: 'requested' },
      { requestId: 'c', status: 'requested' },
    ];
    expect(nextToAnswer(rows, [])?.requestId).toBe('b');
    expect(nextToAnswer(rows, ['b'])?.requestId).toBe('c');
    expect(nextToAnswer(rows, ['b', 'c'])).toBeNull();
    expect(nextToAnswer([], [])).toBeNull();
  });

  it('a dialog normally, a banner over an open sheet or after Later, the dialog again when Answer is tapped, nothing without a request [kills: a dialog over an open order sheet, a banner that cannot be opened]', () => {
    expect(promptView({ hasRequest: false, sheetOpen: true, mode: 'open' })).toBe('none');
    expect(promptView({ hasRequest: true, sheetOpen: false, mode: 'auto' })).toBe('dialog');
    expect(promptView({ hasRequest: true, sheetOpen: true, mode: 'auto' })).toBe('banner');
    expect(promptView({ hasRequest: true, sheetOpen: false, mode: 'later' })).toBe('banner');
    expect(promptView({ hasRequest: true, sheetOpen: true, mode: 'open' })).toBe('dialog');
  });

  it('the three decline reasons are fixed, distinct and inside the domain 1 to 80 character rule [kills: a preset the domain would refuse, a changed reason list]', () => {
    expect(BIRTHDAY_DECLINE_PRESETS).toEqual(['Too busy right now', 'Not available today', 'We cannot play it at this time']);
    for (const p of BIRTHDAY_DECLINE_PRESETS) {
      expect(p.trim().length).toBeGreaterThanOrEqual(1);
      expect(p.length).toBeLessThanOrEqual(80);
    }
    expect(new Set(BIRTHDAY_DECLINE_PRESETS).size).toBe(3);
  });
});

describe('the player: a plain audio element, no native plugin', () => {
  function fakeAudio(refuse = false) {
    const el = {
      src: '',
      currentTime: 0,
      duration: 100,
      onended: null as null | (() => void),
      onerror: null as null | (() => void),
      started: [] as string[],
      play: vi.fn(async () => {
        if (refuse) throw new DOMException('blocked', 'NotAllowedError');
        el.started.push(el.src);
      }),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    return el;
  }
  const asAudio = (el: ReturnType<typeof fakeAudio>) => el as unknown as AudioLike;
  const storeOf = () => {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('plays the two songs in turn and loops until stopped [kills: a player that stops after one song]', async () => {
    const el = fakeAudio();
    const p = createBirthdayPlayer({ newAudio: () => asAudio(el), storage: null });
    await p.play();
    expect(p.current()).toBe(0);
    el.onended?.();
    el.onended?.();
    await Promise.resolve();
    expect(el.started).toEqual([BIRTHDAY_PLAYLIST[0], BIRTHDAY_PLAYLIST[1], BIRTHDAY_PLAYLIST[0]]);
    p.stop();
    expect(p.current()).toBeNull();
    expect(el.pause).toHaveBeenCalled();
    el.onended?.();
    expect(el.started, 'nothing plays after Stop').toHaveLength(3);
  });

  it('a browser refusal makes play() reject and leaves nothing playing, so the caller can offer Tap to play [kills: a player that says it plays after the browser refused]', async () => {
    const el = fakeAudio(true);
    const p = createBirthdayPlayer({ newAudio: () => asAudio(el), storage: null });
    await expect(p.play()).rejects.toThrow('blocked');
    expect(p.current()).toBeNull();
    expect(el.pause).toHaveBeenCalled();
  });

  it('two load errors in a row stop the player and tell the screen; one error, then a song that starts, does not [kills: an error loop that never ends, a counter that is never reset]', async () => {
    const el = fakeAudio();
    const p = createBirthdayPlayer({ newAudio: () => asAudio(el), storage: null });
    const gaveUp = vi.fn();
    p.subscribeGaveUp(gaveUp);
    await p.play();
    el.onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.current(), 'one broken file skips to the other song').toBe(1);
    el.onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.current(), 'a song started in between: the count starts over').toBe(0);
    expect(gaveUp).not.toHaveBeenCalled();
    el.onerror?.();
    el.onerror?.();
    expect(p.current()).toBeNull();
    expect(gaveUp).toHaveBeenCalledTimes(1);
  });

  it('the next play starts at the song after the one last stopped when 75 percent was heard, else at the same song [kills: a rotation that ignores how much was heard]', async () => {
    const storage = storeOf();
    const run = async (fraction: number) => {
      const el = fakeAudio();
      const p = createBirthdayPlayer({ newAudio: () => asAudio(el), storage });
      await p.play();
      const first = p.current();
      el.currentTime = fraction * el.duration;
      p.stop();
      return first;
    };
    expect(await run(0.5)).toBe(0); // stopped at 50% of song 0
    expect(await run(0.8)).toBe(0); // restarts song 0, stopped at 80%
    expect(await run(0.1)).toBe(1); // so now song 1
  });

  it('blocked storage never stops a song from playing [kills: a storage failure that breaks play]', async () => {
    const el = fakeAudio();
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const p = createBirthdayPlayer({ newAudio: () => asAudio(el), storage });
    await p.play();
    expect(p.current()).toBe(0);
    expect(() => p.stop()).not.toThrow();
  });

  it('both song files are in the ERP public folder and are real audio, byte for byte what the old POS served [kills: a playlist that points at a missing file]', () => {
    const pub = resolve(__dirname, '..', 'public');
    for (const url of BIRTHDAY_PLAYLIST) {
      const file = resolve(pub, url.replace(/^\//, ''));
      expect(existsSync(file), url).toBe(true);
      expect(statSync(file).size, url).toBeGreaterThan(100_000);
    }
    expect(statSync(resolve(pub, 'sounds/birthday-shareat.mp3')).size).toBe(1_802_847);
    expect(statSync(resolve(pub, 'sounds/happy-birthday.mp3')).size).toBe(2_020_608);
  });
});

describe('wiring', () => {
  it('the prompt is mounted by the shell for every tab, not by the Lobby tab, and the order sheet holds the flag that turns the dialog into a banner [kills: a birthday poll mounted on one tab only, a dialog over an open sheet]', () => {
    const shell = read('_shell/PosShell.tsx');
    expect(shell).toMatch(/<BirthdayPrompt storeId=\{pairedStoreId !== null && caps\.has\('record_sale'\) \? storeId : null\} online=\{state\.online && !actor\} \/>/);
    expect(read('_lobby/Lobby.tsx')).not.toContain('BirthdayPrompt');
    expect(read('lobby/page.tsx')).not.toContain('BirthdayPrompt');
    expect(read('_orders/OrderDialogs.tsx')).toMatch(/useHoldSheetOpen\(\)/);
    const prompt = read('_lobby/BirthdayPrompt.tsx');
    expect(prompt).toMatch(/useSheetOpen\(\)/);
    expect(prompt).toMatch(/promptView\(\{ hasRequest: current !== null, sheetOpen, mode \}\)/);
    expect(prompt).toContain('LOBBY_POLL_MS'); // pos2 beat, 10 s
    expect(prompt).toContain('Tap to play');
  });

  it('the song stops when the prompt unmounts, and only the actions final flag makes a report final [kills: a song that keeps playing after the shell is gone, a transient refusal dropped as final]', () => {
    const prompt = read('_lobby/BirthdayPrompt.tsx');
    expect(prompt).toMatch(/useEffect\(\(\) => \(\) => player\.stop\(\), \[player\]\)/);
    expect(prompt).toMatch(/final: r\.final === true/);
    expect(prompt).not.toMatch(/final: true \}\)/);
    const actions = read('lobby/actions.ts');
    expect(actions).toMatch(/'LOBBY_BIRTHDAY_CLOSED' \|\| code === 'LOBBY_NOT_FOUND'/);
    expect(read('_lobby/BirthdaySongButton.tsx')).toContain('subscribeGaveUp');
  });

  it('the prompt has no free-text field and no native plugin: the only input is the time, and the decline buttons come from the three fixed reasons [kills: a free-typed decline reason, a native plugin]', () => {
    const prompt = read('_lobby/BirthdayPrompt.tsx');
    expect(prompt).not.toMatch(/<textarea/i);
    expect([...prompt.matchAll(/<input\b[^>]*/g)].map((m) => m[0])).toHaveLength(1);
    expect(prompt).toContain('type="time"');
    expect(prompt).toMatch(/BIRTHDAY_DECLINE_PRESETS\.map/);
    for (const f of ['_lobby/birthday-player.ts', '_lobby/BirthdayPrompt.tsx', '_lobby/BirthdaySongButton.tsx', '_lobby/birthday-scheduler.ts']) {
      expect(read(f), f).not.toMatch(/capacitor|registerPlugin/i);
    }
  });

  it('the birthday actions take no store from the body and always pass the pairing store as onlyStoreId [kills: a store read from the body, a request probe across stores]', () => {
    const actions = read('lobby/actions.ts');
    const birthday = actions.slice(actions.indexOf('T-644 S3 - the birthday-song requests'));
    expect(birthday.length).toBeGreaterThan(500);
    expect(birthday).not.toMatch(/input\.storeId|storeId:\s*string/);
    expect(birthday.match(/onlyStoreId: storeId/g)).toHaveLength(3);
    expect(birthday.match(/\r?\n    true,\r?\n/g)).toHaveLength(4); // every one of the four needs the pairing
  });
});
