/**
 * T-532 S4 - the POS service worker (`public/sw.js`), driven as a whole through a fake worker scope: the routing table, what gets saved,
 * what is never saved, and how a deploy replaces the cache. The real proof of a cold start is a device; this is the part a unit can prove.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SW_CACHE_PREFIX, SW_SHELL_KEY } from './offline-sw';

const ORIGIN = 'https://erp2.example';
const SRC = readFileSync(path.join(__dirname, '..', '..', '..', '..', 'public', 'sw.js'), 'utf8');

type Res = { status: number; type: string; redirected: boolean; url: string; clone(): Res };
const res = (url: string, o: Partial<Res> = {}): Res => {
  const r: Res = { status: 200, type: 'basic', redirected: false, url: ORIGIN + url, clone: () => r, ...o };
  return r;
};

type Store = Map<string, Map<string, Res>>;

/** Run sw.js in a fake worker scope. `net` answers fetches (throw = offline); `store` is the fake Cache Storage. */
function boot(version: string, net: (pathname: string) => Res, store: Store = new Map(), src: string = SRC) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const fetched: string[] = [];
  const keyOf = (r: unknown) => new URL(typeof r === 'string' ? r : (r as { url: string }).url, ORIGIN).pathname;
  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      return {
        match: async (r: unknown) => m.get(keyOf(r)),
        put: async (r: unknown, v: Res) => void m.set(keyOf(r), v),
        delete: async (r: unknown) => m.delete(keyOf(r)),
      };
    },
    keys: async () => [...store.keys()],
    delete: async (n: string) => store.delete(n),
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js?v=${version}`),
    addEventListener: (t: string, h: (e: unknown) => void) => void (handlers[t] = h),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  class FakeResponse {
    status: number;
    constructor(
      public body: string,
      init: { status?: number } = {},
    ) {
      this.status = init.status ?? 200;
    }
  }
  const module = { exports: {} as { strategyFor: (u: string, o: string, m: string, mode: string) => string; PREFIX: string; SHELL_KEY: string } };
  vm.runInNewContext(src, {
    self,
    caches,
    module,
    URL,
    URLSearchParams,
    Promise,
    setTimeout,
    Response: FakeResponse,
    fetch: async (r: unknown) => {
      const p = new URL(typeof r === 'string' ? r : (r as { url: string }).url, ORIGIN).pathname;
      fetched.push(p);
      return net(p);
    },
  });
  /** Fire a fetch event. Returns what the worker answered, or 'passthrough' when it did not intercept. */
  const request = async (url: string, o: { method?: string; mode?: string } = {}) => {
    let given: Promise<unknown> | undefined;
    handlers.fetch!({ request: { url: ORIGIN + url, method: o.method ?? 'GET', mode: o.mode ?? 'no-cors' }, respondWith: (p: Promise<unknown>) => void (given = p) });
    return given ? ((await given) as Res & { status: number }) : 'passthrough';
  };
  const wait = (name: string, data?: unknown) => {
    let p: Promise<unknown> = Promise.resolve();
    handlers[name]!({ data, waitUntil: (x: Promise<unknown>) => void (p = x) });
    return p;
  };
  return { api: module.exports, request, message: (d: unknown) => wait('message', d), activate: () => wait('activate'), store, fetched };
}

const online = (p: string) => res(p);
const offline = (): Res => {
  throw new TypeError('Failed to fetch');
};
const nav = { mode: 'navigate' };
const cacheOf = (store: Store, v = 't1') => store.get(`${SW_CACHE_PREFIX}${v}`);

describe('T-532 S4 sw.js routing (strategyFor)', () => {
  const { api } = boot('t1', online);
  const s = (url: string, method = 'GET', mode = 'no-cors') => api.strategyFor(ORIGIN + url, ORIGIN, method, mode);
  it.each([
    ['/api/pos/state', 'GET', 'cors', 'network-only'],
    ['/api/pos/sync', 'POST', 'cors', 'untouched'],
    ['/_next/static/chunks/a-123.js', 'GET', 'no-cors', 'cache-first'],
    ['/pos', 'GET', 'navigate', 'shell'],
    ['/pos?storeId=x', 'GET', 'navigate', 'shell'],
    ['/pos/printer', 'GET', 'navigate', 'page'],
    ['/pos', 'GET', 'cors', 'network-only'], // a client-side (RSC) fetch of the page: left to the network
    ['/sign-in', 'GET', 'navigate', 'network-only'],
    ['/posx', 'GET', 'navigate', 'network-only'],
    ['/pos', 'POST', 'same-origin', 'untouched'], // a Server Action
  ])('%s %s %s -> %s', (url, method, mode, want) => expect(s(url, method, mode)).toBe(want));
  it('another origin is untouched, even for /_next/static', () => expect(api.strategyFor('https://cdn.other/_next/static/a.js', ORIGIN, 'GET', 'no-cors')).toBe('untouched'));
});

describe('T-532 S4 sw.js behaviour', () => {
  it('never answers or stores /api/* (passes through, cache stays empty)', async () => {
    const w = boot('t1', online);
    expect(await w.request('/api/pos/state', { mode: 'cors' })).toBe('passthrough');
    expect(await w.request('/api/pos/state', { mode: 'cors', method: 'POST' })).toBe('passthrough');
    expect([...w.store.values()].flatMap((m) => [...m.keys()])).toEqual([]);
  });

  it('cache-first: the second load of a hashed file does not touch the network', async () => {
    const w = boot('t1', online);
    await w.request('/_next/static/a-1.js');
    await w.request('/_next/static/a-1.js');
    expect(w.fetched).toEqual(['/_next/static/a-1.js']);
  });

  it('a /pos navigation saves the shell; offline, /pos and /pos/receipts both open it', async () => {
    const store: Store = new Map();
    await boot('t1', online, store).request('/pos', nav);
    const shell = cacheOf(store)?.get(SW_SHELL_KEY);
    expect(shell).toBeDefined();
    const w = boot('t1', offline, store);
    expect(await w.request('/pos', nav)).toBe(shell);
    expect(await w.request('/pos/receipts', nav)).toBe(shell);
  });

  it('offline with nothing saved says so in words (503), never a throw', async () => {
    const r = await boot('t1', offline).request('/pos', nav);
    expect((r as { status: number }).status).toBe(503);
  });

  it('a redirect to sign-in (signed out) deletes the saved shell; the redirect itself is returned as is', async () => {
    const store: Store = new Map();
    await boot('t1', online, store).request('/pos', nav);
    const redirect = res('/sign-in', { status: 0, type: 'opaqueredirect' });
    expect(await boot('t1', () => redirect, store).request('/pos', nav)).toBe(redirect);
    expect(cacheOf(store)?.has(SW_SHELL_KEY)).toBe(false);
  });

  it('a followed redirect (response.redirected) is never saved as the shell', async () => {
    const store: Store = new Map();
    await boot('t1', () => res('/pos', { redirected: true }), store).request('/pos', nav);
    expect(cacheOf(store)?.has(SW_SHELL_KEY) ?? false).toBe(false);
  });

  it('a server error (502 in a deploy) serves the saved shell and keeps it', async () => {
    const store: Store = new Map();
    await boot('t1', online, store).request('/pos', nav);
    const shell = cacheOf(store)?.get(SW_SHELL_KEY);
    expect(await boot('t1', () => res('/pos', { status: 502 }), store).request('/pos', nav)).toBe(shell);
    expect(cacheOf(store)?.get(SW_SHELL_KEY)).toBe(shell);
  });

  it('a /pos/* page is never saved', async () => {
    const store: Store = new Map();
    await boot('t1', online, store).request('/pos/receipts', nav);
    expect(cacheOf(store)?.has('/pos/receipts') ?? false).toBe(false);
    expect(cacheOf(store)?.has(SW_SHELL_KEY) ?? false).toBe(false);
  });

  it('activate deletes the other shareat-pos-* caches, and only those', async () => {
    const store: Store = new Map([
      [`${SW_CACHE_PREFIX}old`, new Map()],
      [`${SW_CACHE_PREFIX}t2`, new Map()],
      ['someone-elses', new Map()],
    ]);
    await boot('t2', online, store).activate();
    expect([...store.keys()].sort()).toEqual([`${SW_CACHE_PREFIX}t2`, 'someone-elses']);
  });

  it('precache message: stores hashed files and the shell, ignores /api and other origins', async () => {
    const w = boot('t1', online);
    await w.message({ type: 'precache', urls: [`${ORIGIN}/_next/static/a.js`, `${ORIGIN}/api/secret`, 'https://cdn.other/_next/static/x.js', 42] });
    expect([...cacheOf(w.store)!.keys()].sort()).toEqual(['/_next/static/a.js', SW_SHELL_KEY]);
    expect(w.fetched).not.toContain('/api/secret');
  });

  it('the worker constants match the page-side ones', () => {
    const { api } = boot('t1', online);
    expect([api.PREFIX, api.SHELL_KEY]).toEqual([SW_CACHE_PREFIX, SW_SHELL_KEY]);
  });
});

// Mutants: each edit to sw.js must turn one of the four checks red.
describe('T-532 S4 sw.js mutants', () => {
  const probe = async (src: string) => {
    const store: Store = new Map();
    const w = boot('t1', online, store, src);
    const apiAnswer = await w.request('/api/pos/state', { mode: 'cors' });
    await w.request('/pos', nav);
    const signedOut = res('/sign-in', { status: 0, type: 'opaqueredirect' });
    await boot('t1', () => signedOut, store, src).request('/pos', nav);
    const twice = boot('t1', online, new Map(), src);
    await twice.request('/_next/static/a-1.js');
    await twice.request('/_next/static/a-1.js');
    const old: Store = new Map([[`${SW_CACHE_PREFIX}old`, new Map()]]);
    await boot('t1', online, old, src).activate();
    return {
      apiPassthrough: apiAnswer === 'passthrough',
      shellGone: !cacheOf(store)?.has(SW_SHELL_KEY),
      staticOnce: twice.fetched.length === 1,
      oldDeleted: !old.has(`${SW_CACHE_PREFIX}old`),
    };
  };
  const swap = (from: string, to: string) => {
    expect(SRC).toContain(from);
    return SRC.replace(from, to);
  };

  it('baseline: all four hold', async () => expect(await probe(SRC)).toEqual({ apiPassthrough: true, shellGone: true, staticOnce: true, oldDeleted: true }));
  it('MUTANT cache /api (route it like static) -> red', async () =>
    expect((await probe(swap("p.startsWith('/api/')) return 'network-only';", "p.startsWith('/api/')) return 'cache-first';"))).apiPassthrough).toBe(false));
  it('MUTANT never delete the shell on a non-200 -> red', async () => expect((await probe(swap('else await cache.delete(SHELL_KEY);', ''))).shellGone).toBe(false));
  it('MUTANT static is network-only -> red', async () =>
    expect((await probe(swap("startsWith('/_next/static/')) return 'cache-first';", "startsWith('/_next/static/')) return 'network-only';"))).staticOnce).toBe(false));
  it('MUTANT activate keeps old caches -> red', async () => expect((await probe(swap('n !== CACHE', 'n === CACHE'))).oldDeleted).toBe(false));
});
