/**
 * T-532 S4 - the page's side of `public/sw.js` (POS offline cold start). Production only: in `next dev` the files are not hashed, so a cache-first worker would serve stale code.
 * ⛔ Must never block or break the till: every call swallows its own failure.
 */

/** Must equal `PREFIX` and `SHELL_KEY` in `public/sw.js` (a test pins both). */
export const SW_CACHE_PREFIX = 'shareat-pos-';
export const SW_SHELL_KEY = '/pos-shell';
/** T-621 S1: the message that lets a waiting worker take over. Must equal `ACTIVATE_NOW` in `public/sw.js` (a test pins it). */
export const SW_ACTIVATE_NOW = 'activate-now';

/** T-621 S1: what the update gate looks at. `waiting` is the outbox's count of events not yet sent. */
export interface UpdateGateInput {
  waiting: number;
  paymentOpen: boolean;
  online: boolean;
}

/** T-621 S1: a held update may take over only when nothing is waiting to send, no payment screen is open, and the till is online. Pure. */
export const mayActivateUpdate = (i: UpdateGateInput): boolean => i.waiting === 0 && !i.paymentOpen && i.online;

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

/**
 * T-621 S1: tells `onReady(true)` while a new worker is installed and waiting behind a controlling one (an update held back), `false` otherwise.
 * A first install has no controller, so it never counts as held: it activates at once. Returns a stop function. Never throws.
 */
export function watchPosUpdate(onReady: (ready: boolean) => void): () => void {
  if (process.env.NODE_ENV !== 'production' || !swSupported()) return () => undefined;
  let stopped = false;
  const sw = navigator.serviceWorker;
  void sw.ready
    .then((reg) => {
      const check = () => {
        if (!stopped) onReady(Boolean(reg.waiting) && Boolean(sw.controller));
      };
      check();
      reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', check));
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
  };
}

/** T-621 S1: let the waiting worker take over, then reload once when it controls the page. Call only when `mayActivateUpdate` says yes. Never throws. */
export async function activatePosUpdate(): Promise<void> {
  if (!swSupported()) return;
  try {
    const sw = navigator.serviceWorker;
    const reg = await sw.ready;
    if (!reg.waiting) return;
    sw.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    reg.waiting.postMessage({ type: SW_ACTIVATE_NOW });
  } catch {
    // the old code keeps running; the next check tries again
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
