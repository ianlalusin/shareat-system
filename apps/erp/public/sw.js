/*
 * T-532 S4 - POS offline cold start. Registered with scope /pos by apps/erp/src/app/pos/_shell/offline-sw.ts, so only /pos is ever controlled.
 * Its one job: open the app with no network. Data offline is IndexedDB's job (T-530a), never this file's.
 *
 *   /api/*                 -> network-only. Never cached, never touched.
 *   /_next/static/*        -> cache-first (files are content-hashed, so a hit can never be stale).
 *   navigation to /pos     -> network-first (5 s), the answer is saved as the shell; offline falls back to that saved shell.
 *   navigation to /pos/*   -> network-first, not saved; offline falls back to the saved /pos shell.
 *   everything else        -> not intercepted (other origins, Server Actions = POST, RSC fetches).
 *
 * The saved shell is one signed-in person's page. It is replaced on every online visit, deleted the moment the server answers /pos with anything
 * but a plain 200 (signed out = a redirect), and deleted by the page itself before it signs out (offline-sw.ts purgePosShell).
 * The cache name carries the build (`sw.js?v=<build>`): a deploy installs a new worker, which deletes every other shareat-pos-* cache.
 * T-621 S1: a new worker WAITS after install (no skipWaiting there). The page posts { type: 'activate-now' } only when the outbox is empty, no payment
 *   screen is open and the till is online (offline-sw.ts mayActivateUpdate), then reloads once. A first install (no worker yet) activates at once, as browsers do.
 * T-614 S3: after install (and on the page's precache message) every /pos tab's HTML is fetched once and the hashed files it names are saved, so a tab never opened online opens offline too.
 * Pure routing is `strategyFor`; the tests drive this whole file through a fake worker scope.
 */
'use strict';

const PREFIX = 'shareat-pos-';
const SHELL_KEY = '/pos-shell';
const VERSION = new URLSearchParams(self.location.search).get('v') || 'dev';
const CACHE = PREFIX + VERSION;
const NETWORK_TIMEOUT_MS = 5000;
/** T-621 S1: the one message that lets a waiting worker take over. Must equal SW_ACTIVATE_NOW in offline-sw.ts (a test pins both). */
const ACTIVATE_NOW = 'activate-now';
/** T-614 S3: every /pos tab. Each one's HTML is fetched once after install and the hashed files it names are saved, so a tab never opened online still opens offline. A test pins this to the tabs in _shell/tabs.ts plus Printer. */
const POS_TAB_PATHS = ['/pos', '/pos/kitchen', '/pos/refills', '/pos/receipts', '/pos/till', '/pos/printer'];

/** Which strategy a request gets. Pure; the one place that decides what may be cached. */
function strategyFor(url, origin, method, mode) {
  let u;
  try {
    u = new URL(url, origin);
  } catch {
    return 'untouched';
  }
  if (u.origin !== origin || method !== 'GET') return 'untouched';
  const p = u.pathname;
  if (p === '/api' || p.startsWith('/api/')) return 'network-only';
  if (p.startsWith('/_next/static/')) return 'cache-first';
  if (mode === 'navigate' && p === '/pos') return 'shell';
  if (mode === 'navigate' && p.startsWith('/pos/')) return 'page';
  return 'network-only';
}

/** The hashed static files a tab's HTML names (script/link tags and the escaped Next payload). Pure; returns same-origin /_next/static/... paths, de-duplicated. */
function chunkUrlsIn(html) {
  const found = new Set();
  const re = /(?:\/_next\/)?static\/(?:chunks|css|media)\/[^"'\\\s<>)]+/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const raw = m[0].split('\\u0026').join('&');
    found.add(raw.startsWith('/_next/') ? raw : '/_next/' + raw);
  }
  return [...found];
}

/** Keep the answer as the shell only when it is the plain /pos page; any other answer (a redirect to sign-in, 401, 404) deletes it. A 5xx changes nothing. */
async function storeShell(cache, res) {
  if (res.status >= 500) return;
  const plain = res.status === 200 && !res.redirected && res.type === 'basic' && new URL(res.url).pathname === '/pos';
  if (plain) await cache.put(SHELL_KEY, res);
  else await cache.delete(SHELL_KEY);
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.status === 200 && res.type === 'basic') await cache.put(request, res.clone());
  return res;
}

const withTimeout = (p) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS))]);

const OFFLINE_PAGE = () =>
  new Response('You are offline and this screen is not saved on this device yet. Connect once, then open it again.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

async function navigation(request, isShell) {
  const cache = await caches.open(CACHE);
  let res;
  try {
    res = await withTimeout(fetch(request));
  } catch {
    return (await cache.match(SHELL_KEY)) || OFFLINE_PAGE();
  }
  if (isShell) await storeShell(cache, res.clone()).catch(() => undefined);
  if (res.status >= 500) return (await cache.match(SHELL_KEY)) || res;
  return res;
}

/** Save these hashed files (cache-first routes only; anything else, /api included, is ignored). */
async function cacheStatic(cache, urls) {
  const wanted = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && strategyFor(u, self.location.origin, 'GET', 'no-cors') === 'cache-first');
  await Promise.all(
    wanted.map(async (u) => {
      try {
        if (await cache.match(u)) return;
        const res = await fetch(u);
        if (res.status === 200 && res.type === 'basic') await cache.put(u, res);
      } catch {
        // offline or a missing file: the runtime cache-first fills it on the next load
      }
    }),
  );
}

/** T-614 S3: fetch each tab's HTML once and save the hashed files it names. The HTML itself is never saved (only /pos as the shell). A signed-out answer (a redirect) saves nothing. */
async function precacheTabs() {
  const cache = await caches.open(CACHE);
  for (const tab of POS_TAB_PATHS) {
    try {
      const res = await fetch(tab);
      if (res.status !== 200 || res.redirected || res.type !== 'basic') continue;
      await cacheStatic(cache, chunkUrlsIn(await res.text()));
    } catch {
      // offline: the next online load tries again
    }
  }
}

/** The page tells us which hashed files it loaded (the first visit happened before this worker controlled it) and we make sure a shell is saved. */
async function precache(urls) {
  const cache = await caches.open(CACHE);
  await cacheStatic(cache, urls);
  try {
    if (!(await cache.match(SHELL_KEY))) await storeShell(cache, await fetch('/pos'));
  } catch {
    // offline: nothing to save
  }
  await precacheTabs();
}

// T-621 S1: no skipWaiting here. A deploy during service must not swap the code under an open till; the page says when (ACTIVATE_NOW).
self.addEventListener('install', (event) => {
  event.waitUntil(precacheTabs().catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const r = event.request;
  const s = strategyFor(r.url, self.location.origin, r.method, r.mode);
  if (s === 'cache-first') event.respondWith(cacheFirst(r));
  else if (s === 'shell' || s === 'page') event.respondWith(navigation(r, s === 'shell'));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'precache') event.waitUntil(precache(event.data.urls));
  else if (event.data && event.data.type === ACTIVATE_NOW) self.skipWaiting();
});

if (typeof module !== 'undefined' && module.exports) module.exports = { strategyFor, chunkUrlsIn, POS_TAB_PATHS, PREFIX, SHELL_KEY, CACHE, ACTIVATE_NOW };
