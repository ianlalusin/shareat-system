/**
 * T-532 S4 - the page's side of `public/sw.js` (POS offline cold start). Production only: in `next dev` the files are not hashed, so a cache-first worker would serve stale code.
 * ⛔ Must never block or break the till: every call swallows its own failure.
 */

/** Must equal `PREFIX` and `SHELL_KEY` in `public/sw.js` (a test pins both). */
export const SW_CACHE_PREFIX = 'shareat-pos-';
export const SW_SHELL_KEY = '/pos-shell';

const swSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

const hashedFilesLoaded = () =>
  performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .filter((n) => n.startsWith(`${location.origin}/_next/static/`));

/** Register the worker for /pos and tell it which hashed files this page loaded. */
export async function registerPosServiceWorker(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || !swSupported()) return;
  try {
    // The build id in the URL makes a deploy a new worker, which clears the old caches. `none`: the browser never serves the script from its HTTP cache.
    await navigator.serviceWorker.register(`/sw.js?v=${process.env.NEXT_PUBLIC_POS_SW_VERSION ?? 'dev'}`, { scope: '/pos', updateViaCache: 'none' });
    if (document.readyState !== 'complete') await new Promise<void>((done) => window.addEventListener('load', () => done(), { once: true }));
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({ type: 'precache', urls: hashedFilesLoaded() });
  } catch {
    // no service worker: the app still works online, it just cannot cold-start offline
  }
}

/** Delete the saved /pos page. Call before signing out, so the next person never gets the last person's page. */
export async function purgePosShell(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    for (const name of await caches.keys()) {
      if (name.startsWith(SW_CACHE_PREFIX)) await (await caches.open(name)).delete(SW_SHELL_KEY);
    }
  } catch {
    // nothing saved, or storage is blocked
  }
}
