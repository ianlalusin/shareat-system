/**
 * T-425 slice T - the ONE shared opener of `shareat-pos-terminal` (Ruling 1 ✎R2). Acceptance 5 (version-1 database upgrades; the counter keeps counting).
 *
 * CONTRACT for the builder (S1) - file `apps/pos/src/lib/terminal/db.ts`, native IndexedDB read LAZILY from `globalThis.indexedDB`. Exports exactly:
 *   DB_NAME = 'shareat-pos-terminal'     DB_VERSION = 2
 *   STORE_TERMINAL = 'terminal' (out-of-line keys; the counter's single row under key 'current')
 *   STORE_EVENTS   = 'events'   (keyPath ['deviceId', 'terminalSeq'] - the ledger)
 *   STORE_EFFECTS  = 'effects'  (keyPath 'id' - deferred effects)
 *   STORE_META     = 'meta'     (out-of-line keys - offline period / X-slip state)
 *   openTerminalDb(): Promise<IDBDatabase>   - opens DB_NAME at DB_VERSION; `onupgradeneeded` creates every store that is missing and
 *        never touches an existing row (a version-1 database holds only `terminal`); the returned connection closes ITSELF on `versionchange`
 *        (db.onversionchange -> db.close()) so another tab's upgrade is never blocked.
 * `counter.ts` (reserveNext / readTerminal / saveTerminalClaim) and `lib/outbox/*` all open through openTerminalDb(); nothing else calls
 * indexedDB.open('shareat-pos-terminal', ...). An older build's version-1 open would fail with VersionError - the runbook forbids installing an older APK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '@/test-helpers/fakeIdb';
import * as dbmod from '@/lib/terminal/db';
import * as counter from '@/lib/terminal/counter';

let idb: FakeIdbFactory;
beforeEach(() => {
  idb = createFakeIdb({ commitDelayMs: 2 });
  vi.stubGlobal('indexedDB', idb);
});
afterEach(() => { vi.unstubAllGlobals(); });

const V1_ROW = { storeId: 'S1', terminalNo: 1, deviceId: 'DEV-A', nextSeq: 41 };

describe('openTerminalDb', () => {
  it('exports the fixed names and version', () => {
    expect(dbmod.DB_NAME).toBe('shareat-pos-terminal');
    expect(dbmod.DB_VERSION).toBe(2);
    expect([dbmod.STORE_TERMINAL, dbmod.STORE_EVENTS, dbmod.STORE_EFFECTS, dbmod.STORE_META]).toEqual(['terminal', 'events', 'effects', 'meta']);
  });

  it('a fresh install is created at version 2 with every store', async () => {
    const db = await dbmod.openTerminalDb();
    expect(db.version).toBe(2);
    for (const s of ['terminal', 'events', 'effects', 'meta']) expect(db.objectStoreNames.contains(s), s).toBe(true);
    db.close();
  });

  it('Acceptance 5: a version-1 database (counter row only) upgrades to 2 and keeps the row', async () => {
    idb.seedDatabase('shareat-pos-terminal', 1, { terminal: { rows: [['current', V1_ROW]] } });
    expect(idb.versionOf('shareat-pos-terminal')).toBe(1);
    const db = await dbmod.openTerminalDb();
    expect(db.version).toBe(2);
    expect(idb.versionOf('shareat-pos-terminal')).toBe(2);
    for (const s of ['events', 'effects', 'meta']) expect(db.objectStoreNames.contains(s), s).toBe(true);
    db.close();
    expect(idb.rows('terminal')).toEqual([V1_ROW]);
  });

  it('Acceptance 5: reserveNext keeps counting from the stored value after the upgrade (no reuse, no reset)', async () => {
    idb.seedDatabase('shareat-pos-terminal', 1, { terminal: { rows: [['current', V1_ROW]] } });
    const a = await counter.reserveNext();
    const b = await counter.reserveNext();
    expect([a.terminalSeq, b.terminalSeq]).toEqual([41, 42]);
    expect(idb.versionOf('shareat-pos-terminal')).toBe(2);
    expect((await counter.readTerminal())?.nextSeq).toBe(43);
  });

  it('counter.ts no longer hard-codes version 1: a version-2 database does not throw VersionError', async () => {
    await dbmod.openTerminalDb().then((d) => d.close());
    await counter.saveTerminalClaim({ ...V1_ROW });
    await expect(counter.readTerminal()).resolves.toEqual(V1_ROW);
  });

  it('the connection closes itself on versionchange from another tab (an upgrade is never blocked)', async () => {
    const db = await dbmod.openTerminalDb(); // left open on purpose
    expect(idb.openConnections('shareat-pos-terminal')).toBe(1);
    const blocked = vi.fn();
    const req = idb.open('shareat-pos-terminal', 3); // a "future" build in another tab
    req.onblocked = blocked;
    req.onupgradeneeded = () => {};
    const upgraded = await new Promise<number>((res, rej) => {
      req.onsuccess = () => res((req.result as IDBDatabase).version);
      req.onerror = () => rej(req.error);
    });
    expect(upgraded).toBe(3);
    // the old connection must have closed on its own (it never called close() here)
    expect(db.version).toBeDefined();
    expect(idb.openConnections('shareat-pos-terminal')).toBe(1); // only the new one
  });

  it('opening twice returns working connections (each caller may close its own)', async () => {
    const [a, b] = await Promise.all([dbmod.openTerminalDb(), dbmod.openTerminalDb()]);
    a.close();
    const tx = b.transaction('terminal', 'readwrite');
    tx.objectStore('terminal').put(V1_ROW, 'current');
    await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error); });
    b.close();
    expect(idb.rows('terminal')).toEqual([V1_ROW]);
  });
});
