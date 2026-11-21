/**
 * T-532 S4 - the POS service worker (`public/sw.js`), driven as a whole through a fake worker scope: the routing table, what gets saved,
 * what is never saved, and how a deploy replaces the cache. The real proof of a cold start is a device; this is the part a unit can prove.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mayActivateUpdate, purgePosShell, SW_ACTIVATE_NOW, SW_CACHE_PREFIX, SW_SHELL_KEY } from './offline-sw';

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
  const skips = { n: 0 };
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
    skipWaiting: () => void (skips.n += 1),
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
  const module = { exports: {} as { strategyFor: (u: string, o: string, m: string, mode: string) => string; chunkUrlsIn: (html: string) => string[]; POS_TAB_PATHS: string[]; PREFIX: string; SHELL_KEY: string; ACTIVATE_NOW: string } };
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
  return { api: module.exports, request, message: (d: unknown) => wait('message', d), install: () => wait('install'), activate: () => wait('activate'), store, fetched, skips };
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
    expect([api.PREFIX, api.SHELL_KEY, api.ACTIVATE_NOW]).toEqual([SW_CACHE_PREFIX, SW_SHELL_KEY, SW_ACTIVATE_NOW]);
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

// T-614 S3: every /pos tab opens offline, and sign-out clears the saved shell.
const TAB_HTML: Record<string, string> = {
  '/pos': '<script src="/_next/static/chunks/orders-aaa.js"></script><link href="/_next/static/css/app-1.css">',
  '/pos/kitchen': '<script src="/_next/static/chunks/kitchen-bbb.js"></script>',
  '/pos/refills': '<script src="/_next/static/chunks/refills-ccc.js?dpl=x"></script>',
  '/pos/receipts': '<script src="/_next/static/chunks/receipts-ddd.js"></script>',
  '/pos/till': '<script src="/_next/static/chunks/till-eee.js"></script>',
  '/pos/printer': '<script src="/_next/static/chunks/printer-fff.js"></script>',
};
const withText = (p: string, html: string): Res => Object.assign(res(p), { text: async () => html });
const tabNet = (p: string): Res => (TAB_HTML[p] !== undefined ? withText(p, TAB_HTML[p]) : res(p));
const ALL_CHUNKS = [
  '/_next/static/chunks/orders-aaa.js',
  '/_next/static/css/app-1.css',
  '/_next/static/chunks/kitchen-bbb.js',
  '/_next/static/chunks/refills-ccc.js',
  '/_next/static/chunks/receipts-ddd.js',
  '/_next/static/chunks/till-eee.js',
  '/_next/static/chunks/printer-fff.js',
];

describe('T-614 S3 precache of every /pos tab', () => {
  it('the tab list is the six tabs, and every tabs.ts href is in it', () => {
    const { api } = boot('t1', online);
    expect(api.POS_TAB_PATHS).toEqual(['/pos', '/pos/kitchen', '/pos/refills', '/pos/receipts', '/pos/till', '/pos/printer']);
    const tabsSrc = readFileSync(path.join(__dirname, 'tabs.ts'), 'utf8');
    const hrefs = [...tabsSrc.matchAll(/href: '(\/pos[^']*)'/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThanOrEqual(5);
    for (const href of hrefs) expect(api.POS_TAB_PATHS).toContain(href);
  });

  it('chunkUrlsIn finds script and escaped-payload files, once each, and nothing else', () => {
    const { api } = boot('t1', online);
    const html = '<script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/a.js"></script>\\"static/chunks/b.js\\" <img src="/logo.png"> /api/x';
    expect(api.chunkUrlsIn(html)).toEqual(['/_next/static/chunks/a.js', '/_next/static/chunks/b.js']);
  });

  it('install fetches each tab HTML once and saves every file it names; /api is never fetched or saved', async () => {
    const w = boot('t1', tabNet);
    await w.install();
    expect([...cacheOf(w.store)!.keys()].sort()).toEqual([...ALL_CHUNKS].sort());
    for (const tab of Object.keys(TAB_HTML)) expect(w.fetched.filter((f) => f === tab)).toHaveLength(1);
    expect(w.fetched.some((f) => f.startsWith('/api'))).toBe(false);
  });

  it('a tab never opened online: after install, offline, its own files come from the cache with no network', async () => {
    const store: Store = new Map();
    await boot('t1', tabNet, store).install();
    const off = boot('t1', offline, store);
    for (const f of ALL_CHUNKS) expect(await off.request(f)).toBeDefined();
    expect(off.fetched).toEqual([]);
  });

  it('a signed-out answer (redirect) saves nothing; an offline install does not throw', async () => {
    const redirected = boot('t1', (p) => Object.assign(res(p, { redirected: true }), { text: async () => TAB_HTML['/pos']! }));
    await redirected.install();
    expect([...(cacheOf(redirected.store)?.keys() ?? [])]).toEqual([]);
    await expect(boot('t1', offline).install()).resolves.toBeUndefined();
  });

  it('the precache message also precaches every tab', async () => {
    const w = boot('t1', tabNet);
    await w.message({ type: 'precache', urls: [] });
    expect([...cacheOf(w.store)!.keys()].sort()).toEqual([...ALL_CHUNKS, SW_SHELL_KEY].sort());
  });

  it('MUTANT empty tab list -> red (install saves no tab files)', async () => {
    const w = boot('t1', tabNet, new Map(), SRC.replace(/const POS_TAB_PATHS = \[[^\]]*\];/, 'const POS_TAB_PATHS = [];'));
    await w.install();
    expect([...(cacheOf(w.store)?.keys() ?? [])].sort()).not.toEqual([...ALL_CHUNKS].sort());
  });
});

describe('T-614 S3 sign-out purge (purgePosShell, called by the POS shell and the ERP sidebar)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('deletes the saved shell from every shareat-pos-* cache and leaves other caches and hashed files alone', async () => {
    const store: Store = new Map([
      [`${SW_CACHE_PREFIX}a`, new Map([[SW_SHELL_KEY, res('/pos')], ['/_next/static/x.js', res('/x')]])],
      [`${SW_CACHE_PREFIX}b`, new Map([[SW_SHELL_KEY, res('/pos')]])],
      ['other', new Map([[SW_SHELL_KEY, res('/pos')]])],
    ]);
    vi.stubGlobal('caches', {
      keys: async () => [...store.keys()],
      open: async (n: string) => ({ delete: async (k: string) => store.get(n)!.delete(k) }),
    });
    await purgePosShell();
    expect(store.get(`${SW_CACHE_PREFIX}a`)!.has(SW_SHELL_KEY)).toBe(false);
    expect(store.get(`${SW_CACHE_PREFIX}a`)!.has('/_next/static/x.js')).toBe(true);
    expect(store.get(`${SW_CACHE_PREFIX}b`)!.has(SW_SHELL_KEY)).toBe(false);
    expect(store.get('other')!.has(SW_SHELL_KEY)).toBe(true);
  });
});

// T-621 S1: the update gate. A deploy's worker waits; the page lets it in only when nothing is waiting, no payment is open, and the till is online.
describe('T-621 S1 update gate', () => {
  it.each([
    [{ waiting: 0, paymentOpen: false, online: true }, true],
    [{ waiting: 1, paymentOpen: false, online: true }, false],
    [{ waiting: 0, paymentOpen: true, online: true }, false],
    [{ waiting: 0, paymentOpen: false, online: false }, false],
    [{ waiting: 3, paymentOpen: true, online: false }, false],
  ])('mayActivateUpdate(%o) -> %s', (input, want) => expect(mayActivateUpdate(input)).toBe(want));

  it('install no longer calls skipWaiting: the new worker waits', async () => {
    const w = boot('t2', tabNet);
    await w.install();
    expect(w.skips.n).toBe(0);
  });

  it('the activate-now message calls skipWaiting once; other messages do not', async () => {
    const w = boot('t2', online);
    await w.message({ type: 'something-else' });
    expect(w.skips.n).toBe(0);
    await w.message({ type: SW_ACTIVATE_NOW });
    expect(w.skips.n).toBe(1);
  });

  it('activate still claims the open pages (clients.claim)', () => {
    expect(SRC).toContain('.then(() => self.clients.claim())');
  });

  it('MUTANT skipWaiting back on install -> red', async () => {
    const mutated = SRC.replace("self.addEventListener('install', (event) => {", "self.addEventListener('install', (event) => {\n  self.skipWaiting();");
    expect(mutated).not.toBe(SRC);
    const w = boot('t2', tabNet, new Map(), mutated);
    await w.install();
    expect(w.skips.n).not.toBe(0);
  });
});
