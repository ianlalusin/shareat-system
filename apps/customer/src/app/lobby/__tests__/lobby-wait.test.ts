import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOBBY_POLL_MS, createLobbyPoll } from '@/app/lobby/lobby-poll';
import { createWaitController } from '@/app/lobby/wait-controller';
import { createFixtureLobbyData } from '@/data/fixture-lobby-data';
import type { LobbyMyEntry } from '@/data/http-lobby-data';

/**
 * T-455 S4 tester: the 10 s poll (3.1 "Live position"), the one-time hand-off (2.6) and source-level guards on the screens.
 * No jsdom here, so the browser is injected: `doc` = { visibilityState, addEventListener, removeEventListener } and `loc` = { replace }.
 * Every test names the mutant it kills.
 */

class FakeDoc extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  set(state: 'visible' | 'hidden') {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('poll cadence: every 10 s, only while the page is visible', () => {
  it('the interval is 10 000 ms', () => {
    // kills: 5 s / 30 s interval (60 phones = 6 req/s is the ruling)
    expect(LOBBY_POLL_MS).toBe(10_000);
  });

  it('polls once per 10 s while visible, not before', async () => {
    // kills: a poll every second; a missing interval
    const doc = new FakeDoc();
    const poll = vi.fn();
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(poll).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(poll).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('hidden page: no polls at all; visible again: polling resumes', async () => {
    // kills: polling in a background tab; never resuming after the tab returns
    const doc = new FakeDoc();
    const poll = vi.fn();
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    doc.set('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(0);
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(1);
    const before = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll.mock.calls.length).toBeGreaterThan(before);
    p.stop();
  });

  it('starting while already hidden does not poll until visible', async () => {
    // kills: checking visibility only on the change event, not at start
    const doc = new FakeDoc();
    doc.visibilityState = 'hidden';
    const poll = vi.fn();
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll).toHaveBeenCalledTimes(0);
    p.stop();
  });

  it('no double timer: hide/show cycles never poll faster than every 10 s', async () => {
    // kills: a new interval per visibility event (pile-up)
    const doc = new FakeDoc();
    const poll = vi.fn();
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    for (let i = 0; i < 5; i++) {
      doc.set('hidden');
      doc.set('visible');
    }
    poll.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll.mock.calls.length).toBeLessThanOrEqual(4);
    p.stop();
  });

  it('stop(): the timer is cleared and the visibility listener removed', async () => {
    // kills: a leaked interval after leaving the page; a leaked listener that restarts polling
    const doc = new FakeDoc();
    const poll = vi.fn();
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    p.stop();
    doc.set('hidden');
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('wait controller: poll the server, hand off exactly once', () => {
  async function setup(entryOver: Partial<LobbyMyEntry> | null = null) {
    const doc = new FakeDoc();
    const loc = { replace: vi.fn() };
    const lobby = createFixtureLobbyData({ now: () => 1_000_000 });
    const views: { kind: string; handoffUrl: string | null }[] = [];
    const c = createWaitController({ data: lobby, storeCode: 'LIPA', doc: doc as never, loc, onView: (v) => views.push(v) });
    const made = await lobby.checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: '0190aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    if (!made.ok) throw new Error('fixture check-in refused');
    void entryOver;
    return { doc, loc, lobby, views, c };
  }

  it('start() reads the entry immediately, then follows the server every 10 s (waiting -> called)', async () => {
    // kills: the screen showing nothing for 10 s after load; ignoring what the poll returns
    const { lobby, views, c } = await setup();
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(views.at(-1)?.kind).toBe('waiting');
    lobby.demo.call();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(views.at(-1)?.kind).toBe('called');
    c.stop();
  });

  it('seated with the server link: location.replace is called EXACTLY once with that exact URL, however many polls follow', async () => {
    // kills: replace on every poll (reload loop); replace never; a client-rebuilt URL; polling on after hand-off
    const { lobby, loc, c } = await setup();
    const url = 'https://customer.shareat.net/join?t=SERVER-ISSUED-TOKEN';
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    lobby.demo.seat(url, '7');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loc.replace).toHaveBeenCalledTimes(1);
    expect(loc.replace).toHaveBeenCalledWith(url);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loc.replace).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    c.stop();
  });

  it('even if the server sent the link twice, the phone still replaces once', async () => {
    // kills: relying on the server alone for once-only (a replayed response must not navigate twice)
    const { lobby, loc, c } = await setup();
    c.start();
    lobby.demo.seat('https://customer.shareat.net/join?t=A', '7', { repeatLink: true });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(loc.replace).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it('seated but the link is already spent (null): no navigation and no invented URL', async () => {
    // kills: building customer.shareat.net/join from the stand label or code
    const { lobby, loc, c } = await setup();
    c.start();
    lobby.demo.seat(null, '7');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(loc.replace).not.toHaveBeenCalled();
    c.stop();
  });

  it('a terminal entry (cancelled / removed / expired) stops the poll and never navigates', async () => {
    // kills: polling forever on a dead entry; a link on a closed entry used
    const { lobby, loc, c } = await setup();
    c.start();
    lobby.demo.close('removed');
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loc.replace).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    c.stop();
  });

  it('cancel(): sends the cancel call once and shows a closed view; the poll stops', async () => {
    // kills: Cancel that only hides the button; a poll that resurrects the entry
    const { lobby, views, c } = await setup();
    const spy = vi.spyOn(lobby, 'cancel');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.cancel();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('LIPA');
    expect(views.at(-1)?.kind).toBe('closed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0);
    c.stop();
  });

  it('a failed poll (offline) keeps the last view and keeps trying', async () => {
    // kills: a blank/error screen replacing the place in line on one dropped request; giving up after one failure
    const { lobby, views, c } = await setup();
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    const spy = vi.spyOn(lobby, 'myEntry');
    spy.mockResolvedValueOnce({ ok: false, status: 0, error: 'offline' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(views.at(-1)?.kind).toBe('waiting');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    c.stop();
  });

  it('stop() makes no further data calls', async () => {
    // kills: a leaked interval after the diner leaves /lobby/wait
    const { lobby, c } = await setup();
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    const spy = vi.spyOn(lobby, 'myEntry');
    c.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------- source-level guards on the screens ----------
const LOBBY_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');
function walkSrc(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    if (n === '__tests__') continue;
    const f = join(dir, n);
    if (statSync(f).isDirectory()) out.push(...walkSrc(f));
    else if (/\.(ts|tsx)$/.test(n)) out.push(f);
  }
  return out;
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('screens exist and obey the hand-off / privacy rules (source guards)', () => {
  it('the three S4 screens exist (birthday and discount belong to later slices)', () => {
    // kills: a slice shipped without a screen
    for (const p of ['page.tsx', 'check-in/page.tsx', 'wait/page.tsx']) {
      expect(existsSync(join(LOBBY_DIR, p)), p).toBe(true);
    }
  });

  it('only location.replace navigates away; no href assignment, assign(), open(), or router push to the link', () => {
    // kills: location.href = url (leaves a back-button loop into the wait page); window.open
    const files = walkSrc(LOBBY_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const s = strip(readFileSync(f, 'utf8'));
      expect(s, f).not.toMatch(/location\.href\s*=[^=]/);
      expect(s, f).not.toMatch(/location\.assign\(/);
      expect(s, f).not.toMatch(/window\.open\(/);
    }
  });

  it('no file under app/lobby builds a customer.shareat.net URL: the link only comes from the server', () => {
    // kills: a hard-coded or template-built hand-off target (spec 2.6: handoff_url is the server's bearer link)
    for (const f of walkSrc(LOBBY_DIR)) {
      expect(strip(readFileSync(f, 'utf8')), f).not.toMatch(/customer\.shareat\.net/);
    }
  });

  it('no localStorage / sessionStorage / document.cookie: the hand-off link and the name are never kept', () => {
    // kills: stashing the bearer link or personal data on the phone (http-lobby-data header: never keeps the link)
    for (const f of walkSrc(LOBBY_DIR)) {
      const s = strip(readFileSync(f, 'utf8'));
      expect(s, f).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    }
  });

  it('screens do not call fetch directly (only src/data/http-* may) and do not put a name or code in a URL', () => {
    // kills: bypassing the data door; personal data in a query string (4.3)
    for (const f of walkSrc(LOBBY_DIR)) {
      const s = strip(readFileSync(f, 'utf8'));
      expect(s, f).not.toMatch(/\bfetch\(/);
      expect(s, f).not.toMatch(/[?&](name|displayName|phone|email|code|entry)=/i);
    }
  });

  it('the check-in screen has no phone or email field and no price field', () => {
    // kills: data minimisation lost in the markup (4: no phone, no email)
    const p = join(LOBBY_DIR, 'check-in', 'page.tsx');
    expect(existsSync(p)).toBe(true);
    const s = strip(readFileSync(p, 'utf8'));
    expect(s).not.toMatch(/type=["'](tel|email)["']/i);
    expect(s).not.toMatch(/autoComplete=["'](tel|email)/i);
    expect(s).not.toMatch(/name=["'](phone|email|price)["']/i);
    expect(s).toContain('Join the line');
  });

  it('the wait screen offers the spec buttons and a Cancel, and imports no Firebase', () => {
    // kills: a wait page without Cancel; a stream instead of the poll (ruling: poll, Customer v2 holds no Firestore)
    const p = join(LOBBY_DIR, 'wait', 'page.tsx');
    expect(existsSync(p)).toBe(true);
    const s = strip(readFileSync(p, 'utf8'));
    expect(s).toMatch(/Cancel/);
    expect(s).not.toMatch(/firebase|onSnapshot|EventSource|WebSocket/i);
  });
});
