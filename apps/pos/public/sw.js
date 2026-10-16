// Enhanced Service Worker with Background Sync support

const SYNC_TAG = "offline-payment-sync";
const QUEUE_KEY = "offline_payment_queue";

self.addEventListener('install', (event) => {
  self.skipWaiting();
  console.log('[SW] Installing...');
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
  console.log('[SW] Activating...');
});

self.addEventListener('fetch', (event) => {
  // No-op. Firebase SDK handles its own caching via IndexedDB.
  return;
});

// --- Background Sync ---
self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    console.log('[SW] Background sync triggered:', SYNC_TAG);
    event.waitUntil(notifyClientsToSync());
  }
});

// Tell all open tabs to process the queue
async function notifyClientsToSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: 'PROCESS_PAYMENT_QUEUE' });
  }
}

// Listen for messages from the app to register a sync
self.addEventListener('message', (event) => {
  if (event.data?.type === 'REGISTER_PAYMENT_SYNC') {
    self.registration.sync.register(SYNC_TAG).then(() => {
      console.log('[SW] Background sync registered:', SYNC_TAG);
    }).catch(err => {
      console.warn('[SW] Background sync registration failed:', err);
    });
  }
});
