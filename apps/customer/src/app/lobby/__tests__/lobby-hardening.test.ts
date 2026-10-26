import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LOBBY_POLL_MS, createLobbyPoll } from '@/app/lobby/lobby-poll';
import { createWaitController } from '@/app/lobby/wait-controller';
import type { LobbyData } from '@/data/lobby-data';
import type { LobbyMyEntry, LobbyResult } from '@/data/http-lobby-data';

/**
 * T-455 S4 audit follow-ups F1-F4 (tester). Each test names the mutant it kills.
 * New controller options pinned here (see CONTRACT.md "Hardening"): `handoffHosts?: string[]` (default ['customer.shareat.net']) and `origin?: string`
 * (the page's own origin, for the same-origin case). A refused link calls `onMissing('Please check in at the counter.')`, never `loc.replace`.
 */

class FakeDoc extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  set(state: 'visible' | 'hidden') {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const seated = (url: string | null): LobbyMyEntry => ({
  entryId: 'e1',
  code: '4821',
  status: 'seated',
  partiesAhead: 0,
  displayName: 'Ana',
  partySize: 2,
  standLabel: '7',
  handoffUrl: url,
});
function dataReturning(entry: LobbyMyEntry): LobbyData {
  return {
    getStore: vi.fn(),
    checkIn: vi.fn(),
    cancel: vi.fn(),
    myEntry: vi.fn(async (): Promise<LobbyResult<LobbyMyEntry>> => ({ ok: true, value: entry })),
  } as unknown as LobbyData;
}
async function runWith(url: string, extra: Record<string, unknown> = {}) {
  const loc = { replace: vi.fn() };
  const onMissing = vi.fn();
  const c = createWaitController({
    data: dataReturning(seated(url)),
    storeCode: 'LIPA',
    doc: new FakeDoc() as never,
    loc,
    onView: () => undefined,
    onMissing,
    ...extra,
  } as never);
  c.start();
  await vi.advanceTimersByTimeAsync(0);
  c.stop();
  return { loc, onMissing };
}

describe('F1 the hand-off link is validated before location.replace', () => {
  it('positive control: the allow-listed https customer host is followed, once, with the exact URL', async () => {
    // kills: a validator that refuses everything (the hand-off would never happen)
    const url = 'https://customer.shareat.net/join?t=SERVER-TOKEN';
    const { loc, onMissing } = await runWith(url);
    expect(loc.replace).toHaveBeenCalledTimes(1);
    expect(loc.replace).toHaveBeenCalledWith(url);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it('positive control: a same-origin https link is followed', async () => {
    // kills: refusing our own origin
    const url = 'https://order.shareat.net/lobby/ok?t=1';
    const { loc } = await runWith(url, { origin: 'https://order.shareat.net' });
    expect(loc.replace).toHaveBeenCalledWith(url);
  });

  it('a configured host list replaces the default (staging host accepted, production host then refused)', async () => {
    // kills: a hard-coded host that ignores configuration
    const a = await runWith('https://customer-staging.example.test/join?t=1', { handoffHosts: ['customer-staging.example.test'] });
    expect(a.loc.replace).toHaveBeenCalledTimes(1);
    const b = await runWith('https://customer.shareat.net/join?t=1', { handoffHosts: ['customer-staging.example.test'] });
    expect(b.loc.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['javascript scheme', 'javascript:alert(document.cookie)'],
    ['data scheme', 'data:text/html,<script>1</script>'],
    ['plain http', 'http://customer.shareat.net/join?t=1'],
    ['another host', 'https://evil.example/join?t=1'],
    ['allowed name as a prefix of another host', 'https://customer.shareat.net.evil.example/join'],
    ['allowed name inside the path', 'https://evil.example/customer.shareat.net/join'],
    ['userinfo trick', 'https://customer.shareat.net@evil.example/join'],
    ['protocol-relative', '//evil.example/join'],
    ['relative path', '/join?t=1'],
    ['malformed', 'not a url'],
    ['empty string', ''],
    ['whitespace padded scheme', ' javascript:alert(1)'],
  ])('refused: %s -> replace never called, the counter sentence is shown', async (_n, bad) => {
    // kills: replace() on whatever string the server (or a man in the middle) sends
    const { loc, onMissing } = await runWith(bad);
    expect(loc.replace).not.toHaveBeenCalled();
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(String(onMissing.mock.calls[0]?.[0])).toContain('Please check in at the counter');
  });

  it('a refused link also stops the poll (no retry loop on a bad link)', async () => {
    // kills: polling forever after a refusal
    await runWith('javascript:alert(1)');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('F2 NEXT_PUBLIC_LOBBY_DEMO is ignored in production', () => {
  async function source() {
    vi.resetModules();
    const mod = await import('@/data/lobby-source');
    return mod.getLobbyData() as unknown as Record<string, unknown>;
  }

  it('control: demo=1 outside production uses the fixture (it has the demo hooks)', async () => {
    // kills: a switch that never switches
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_LOBBY_DEMO', '1');
    expect((await source()).demo).toBeDefined();
  });

  it('demo=1 with NODE_ENV=production uses the http source (no demo hooks)', async () => {
    // kills: a production build shipped with fake data because a flag leaked into the environment
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_LOBBY_DEMO', '1');
    expect((await source()).demo).toBeUndefined();
  });

  it('production without the flag is http too', async () => {
    // kills: inverting the check
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_LOBBY_DEMO', '');
    expect((await source()).demo).toBeUndefined();
  });
});

describe('F3 the poll never overlaps a request still in flight', () => {
  it('createLobbyPoll: a tick is skipped while the previous poll has not settled', async () => {
    // kills: stacking a new request every 10 s on a slow network
    const doc = new FakeDoc();
    const poll = vi.fn(() => new Promise<void>(() => undefined));
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    await vi.advanceTimersByTimeAsync(LOBBY_POLL_MS * 5);
    expect(poll).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('createLobbyPoll: after the pending poll settles the next tick polls again', async () => {
    // kills: a skip flag that is never cleared (polling dies after one slow answer); also after a rejection
    const doc = new FakeDoc();
    let release: () => void = () => undefined;
    let n = 0;
    const poll = vi.fn(() => {
      n += 1;
      if (n === 1) return new Promise<void>((r) => (release = r));
      if (n === 2) return Promise.reject(new Error('boom'));
      return Promise.resolve();
    });
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    await vi.advanceTimersByTimeAsync(LOBBY_POLL_MS * 2);
    expect(poll).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(LOBBY_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LOBBY_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('wait controller: a never-answering myEntry gets one call, not one per tick', async () => {
    // kills: the screen-level overlap (the controller refreshes outside the poll's guard)
    const myEntry = vi.fn(() => new Promise<never>(() => undefined));
    const c = createWaitController({
      data: { myEntry, getStore: vi.fn(), checkIn: vi.fn(), cancel: vi.fn() } as unknown as LobbyData,
      storeCode: 'LIPA',
      doc: new FakeDoc() as never,
      loc: { replace: vi.fn() },
      onView: () => undefined,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(LOBBY_POLL_MS * 5);
    expect(myEntry).toHaveBeenCalledTimes(1);
    c.stop();
  });
});

describe('F4 becoming visible again refreshes at once, then the 10 s rhythm', () => {
  it('hidden -> visible: exactly one immediate poll, the next 10 s later', async () => {
    // kills: waiting up to 10 s on return to the tab (stale place in line); a burst of polls; losing the rhythm
    const doc = new FakeDoc();
    const poll = vi.fn();
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    doc.set('hidden');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(poll).toHaveBeenCalledTimes(0);
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LOBBY_POLL_MS - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('start() while visible still does not poll before 10 s (the page reads the entry itself)', async () => {
    // kills: an immediate poll on start that doubles the controller read
    const doc = new FakeDoc();
    const poll = vi.fn();
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    await vi.advanceTimersByTimeAsync(LOBBY_POLL_MS - 1);
    expect(poll).toHaveBeenCalledTimes(0);
    p.stop();
  });

  it('a visibilitychange to visible when already visible does not add a poll or a timer', async () => {
    // kills: refreshing on every event, including no-op ones
    const doc = new FakeDoc();
    const poll = vi.fn();
    const p = createLobbyPoll({ poll, doc: doc as never });
    p.start();
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(0);
    expect(vi.getTimerCount()).toBe(1);
    p.stop();
  });
});
