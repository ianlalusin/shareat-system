/**
 * T-530a — `db.ts`: the one opener, its four stores, and the two refusals that matter.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '../../../tests/helpers/fake-idb';
import { DB_VERSION, NO_INDEXED_DB_MESSAGE, openDeviceDb } from './db';

let fake: FakeIdbFactory;

beforeEach(() => {
  fake = createFakeIdb({ commitDelayMs: 2 });
  vi.stubGlobal('indexedDB', fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T-530a — the device database', () => {
  it('opens version 1 with four stores', async () => {
    const db = await openDeviceDb();
    try {
      expect(db.version).toBe(DB_VERSION);

      const names = [...db.objectStoreNames];
      expect(names.sort()).toEqual(['meta', 'outbox', 'snapshot', 'verifiers']);

      const outbox = db.transaction('outbox', 'readonly').objectStore('outbox');
      expect(outbox.keyPath).toBe('seq');

      const verifiers = db.transaction('verifiers', 'readonly').objectStore('verifiers');
      expect(verifiers.keyPath).toBe('personId');
      expect([...verifiers.indexNames]).toContain('byEmployeeId');
      expect(verifiers.index('byEmployeeId').keyPath).toBe('employeeId');
    } finally {
      db.close();
    }
  });

  it('no IndexedDB → the plain refusal', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(openDeviceDb()).rejects.toThrow(NO_INDEXED_DB_MESSAGE);
    await expect(openDeviceDb()).rejects.toThrow('This device cannot store sales (no IndexedDB).');
  });

  it('reads indexedDB lazily', () => {
    // This module was imported at the top of this file, before any fake was installed — if `db.ts`
    // touched `indexedDB` at import time it would already have thrown with no global defined.
    expect(typeof openDeviceDb).toBe('function');

    const source = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*(?:const|let|var)\s+\w+\s*=\s*(?:globalThis\.)?indexedDB\b/m);
    expect(source).toMatch(/\(globalThis as unknown as \{ indexedDB\?: IDBFactory \}\)\.indexedDB/);
  });
});
