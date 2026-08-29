/**
 * T-180 Contract §2 — the four assertions that ARE Phase 4's gate.
 *
 * PROJECT_BIBLE.md §5.2 asserts three things as PLATFORM behaviour, and rests the whole of Phase 4
 * on them: "the Firestore SDK provides offline persistence, automatic replay, and conflict-free
 * append-only writes as platform behaviour, which v1 reimplemented by hand and got partly wrong."
 *
 * Nothing in this repo has ever executed that claim. These tests are the first time.
 *
 * ⚠️ This runs the CLIENT SDK (`firebase/firestore`) against the emulator, and simulates the pulled
 * cable with disableNetwork()/enableNetwork() — which is what the SDK's own documentation prescribes
 * and is closer to a real outage than mocking the transport.
 *
 * ⚠️ IndexedDB does not exist in Node, and `persistentLocalCache` needs it. `fake-indexeddb` supplies
 * it. That makes assertion 2 (survives a process restart) a REAL test of the persistence layer, but
 * against a shimmed store rather than a browser's own — see README §Limits.
 */
import 'fake-indexeddb/auto';

// Firestore's IndexedDb persistence takes a PRIMARY-TAB LEASE through localStorage. Without one it
// warns "persistence may not work reliably" and, as the first spike run showed, a second instance
// over the same store does not rehydrate. fake-indexeddb supplies IndexedDB and not this, so the
// shim is required for assertion 2 to be testing the persistence layer rather than its absence.
class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const g = globalThis as Record<string, unknown>;
g.localStorage ??= new MemoryStorage();
g.sessionStorage ??= new MemoryStorage();
if (typeof g.window === 'undefined') {
  g.window = g;
}

import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithCustomToken, type Auth } from 'firebase/auth';
import { unsignedCustomToken } from './device-principal';
import {
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocs,
  getDocFromServer,
  where,
  initializeFirestore,
  persistentLocalCache,
  query,
  orderBy,
  setDoc,
  terminate,
  type Firestore,
} from 'firebase/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8181';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9199';

const PROJECT = 'shareat-spike';
const DEVICE = 'terminal-lipa-01';

let seq = 0;
/**
 * ⭐ FINDING (README §2): Firestore's persistent store is keyed
 *   `firestore/{FIREBASE APP NAME}/{projectId}/main`
 * — the APP NAME, not the project, not the Firestore database id. Two instances must share an app
 * name to share a queue, and renaming a terminal's app ORPHANS every punch it has not yet synced.
 * The first version of this suite used a fresh app name per instance and concluded persistence was
 * broken; it was opening a different database each time.
 */
const nextAppName = () => `spike-${Date.now()}-${seq++}`;

interface Terminal {
  app: FirebaseApp;
  db: Firestore;
  auth: Auth;
}

/**
 * A terminal, as the real one will be built: client SDK, persistent cache, emulator host.
 * `appName` IS the persistence identity — passing the same one to two successive instances is how
 * assertion 2 simulates a power cycle.
 */
function bootTerminal(appName: string = nextAppName()): Terminal {
  const app = initializeApp(
    { projectId: PROJECT, apiKey: 'fake-api-key', appId: 'fake-app-id' },
    appName,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9199', { disableWarnings: true });
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({}),
    host: '127.0.0.1:8181',
    ssl: false,
    experimentalForceLongPolling: true,
  });
  return { app, db, auth };
}

/** Sign in as the provisioned terminal. MUST happen before the network is disabled — a device
 *  that has never authenticated cannot start doing so offline, which is itself a constraint on
 *  T-184: the terminal signs in while online and the SDK keeps the session alive from there. */
async function signInAsDevice(t: Terminal) {
  await signInWithCustomToken(t.auth, unsignedCustomToken(`device:${DEVICE}`, { deviceId: DEVICE }));
}

async function shutdown(t: Terminal) {
  await terminate(t.db);
  await deleteApp(t.app);
}

const open: Terminal[] = [];
const boot = (appName?: string) => {
  const t = bootTerminal(appName);
  open.push(t);
  return t;
};

beforeEach(() => { open.length = 0; });
afterEach(async () => {
  for (const t of open.splice(0)) {
    try { await shutdown(t); } catch { /* already terminated by the test */ }
  }
});

const punch = (id: string, occurredAt: number) => ({
  clientPunchId: id,
  occurredAt,
  deviceId: DEVICE,
});

describe('bible §5.2 — the client SDK is the offline queue', () => {
  it('1. with the network DOWN, a write resolves locally and is readable from the cache', async () => {
    const t = boot();
    await signInAsDevice(t);
    await disableNetwork(t.db);

    const id = `p-${Date.now()}-1`;
    // ⭐ Deliberately NOT awaited against the server: offline, setDoc's promise only settles once
    // the write reaches the backend. The SDK applies it to the local cache SYNCHRONOUSLY, which is
    // the property a terminal actually needs — the staffer sees "clocked in" immediately.
    void setDoc(doc(t.db, `inbox/${id}`), punch(id, Date.now()));

    const snap = await getDoc(doc(t.db, `inbox/${id}`));
    expect(snap.exists()).toBe(true);
    expect(snap.metadata.fromCache).toBe(true);
    expect(snap.metadata.hasPendingWrites).toBe(true);
    expect(snap.data()?.clientPunchId).toBe(id);
  });

  it('2. the queued write SURVIVES the terminal being power-cycled', async () => {
    // ⭐ The SAME app name on both sides of the shutdown. That is the power cycle.
    const appName = `terminal-${Date.now()}`;
    const id = `p-${Date.now()}-2`;

    const first = boot(appName);
    await signInAsDevice(first);
    await disableNetwork(first.db);
    void setDoc(doc(first.db, `inbox/${id}`), punch(id, Date.now()));
    // Prove it landed locally before we pull the plug.
    const local = await getDoc(doc(first.db, `inbox/${id}`));
    expect(local.exists()).toBe(true);
    expect(local.metadata.hasPendingWrites).toBe(true);
    // Give the LocalStore a moment to flush the mutation queue to IndexedDB before the plug is
    // pulled. A real power cut would not be so polite; see README §Limits.
    await new Promise((r) => setTimeout(r, 500));
    await shutdown(first);
    open.length = 0;

    // A brand-new SDK instance over the SAME persisted store: the power cycle.
    // ⭐ The business question is not "can it read its own queue back" — it is "does the punch
    // still reach the server". So this instance comes up ONLINE and we check the backend.
    const second = boot(appName);
    await signInAsDevice(second);

    // Deterministic instead of a sleep: poll the SERVER until the replayed punch shows up.
    let onServer: Awaited<ReturnType<typeof getDocFromServer>> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        onServer = await getDocFromServer(doc(second.db, `inbox/${id}`));
        if (onServer.exists()) break;
      } catch { /* not yet reachable */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(onServer?.exists()).toBe(true);
    expect(onServer?.data()?.clientPunchId).toBe(id);
  });

  it('3. on reconnect the write reaches the SERVER with no application replay code', async () => {
    const t = boot();
    await signInAsDevice(t);
    await disableNetwork(t.db);

    const id = `p-${Date.now()}-3`;
    const pending = setDoc(doc(t.db, `inbox/${id}`), punch(id, Date.now()));

    // ⚠️ The load-bearing line: nothing between here and the assertion replays anything.
    await enableNetwork(t.db);
    await pending;

    // getDocFromServer, not getDoc: a cache hit would prove nothing about the backend.
    const fromServer = await getDocFromServer(doc(t.db, `inbox/${id}`));
    expect(fromServer.exists()).toBe(true);
    expect(fromServer.metadata.fromCache).toBe(false);
    expect(fromServer.data()?.clientPunchId).toBe(id);
  });

  it('3b. FINDING — the device-principal claim survives into request.auth.token', async () => {
    // T-180 Contract §4: "Does request.auth.token.deviceId work from a custom token, which is what
    // T-159's device-principal design assumes?" The read rule compares against exactly that claim,
    // so a successful constrained read IS the proof. A token without the claim fails this.
    const t = boot();
    await signInAsDevice(t);
    const id = `p-${Date.now()}-3b`;
    await setDoc(doc(t.db, `inbox/${id}`), punch(id, Date.now()));
    const back = await getDocFromServer(doc(t.db, `inbox/${id}`));
    expect(back.data()?.deviceId).toBe(DEVICE);
  });

  it('4. two writes made offline arrive in the order they were made', async () => {
    const t = boot();
    await signInAsDevice(t);
    await disableNetwork(t.db);

    const stamp = Date.now();
    const first = `p-${stamp}-4a`;
    const second = `p-${stamp}-4b`;
    const a = setDoc(doc(t.db, `inbox/${first}`), punch(first, stamp));
    const b = setDoc(doc(t.db, `inbox/${second}`), punch(second, stamp + 60_000));

    await enableNetwork(t.db);
    await Promise.all([a, b]);

    // ⭐ FINDING (see README): the query MUST carry the same constraint the rule checks. Firestore
    // rules are not filters — an unconstrained list over /inbox is refused outright, because the
    // rule cannot be proven to hold for every document the query might return.
    const ordered = await getDocs(
      query(collection(t.db, 'inbox'), where('deviceId', '==', DEVICE), orderBy('occurredAt')),
    );
    const ids = ordered.docs.map((d) => d.id).filter((i) => i === first || i === second);
    expect(ids).toEqual([first, second]);
  });
});
