import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inMemoryDriver, resolveStorageDriver, setStorageDriver } from '../../packages/domain/src/files/driver';

/**
 * T-495 S1 / DEF-791 - production with no private bucket must refuse the volatile fallback.
 * Before: with FIREBASE_STORAGE_BUCKET absent, resolveStorageDriver() built the in-memory driver in ANY NODE_ENV, so a production
 * process with a missing setting accepted a receipt into process memory and lost it on restart.
 */
describe('T-495 S1 - resolveStorageDriver in production', () => {
  beforeEach(() => {
    setStorageDriver(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setStorageDriver(null);
  });

  it('production, bucket absent, no driver installed: refuses, naming the missing setting', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FIREBASE_STORAGE_BUCKET', '');
    expect(() => resolveStorageDriver()).toThrow(/FIREBASE_STORAGE_BUCKET/);
  });

  it('production, bucket blank (whitespace), no driver installed: refuses', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FIREBASE_STORAGE_BUCKET', '   ');
    // S2: NEW message, distinct from the DEF-308 one - red with the fix reverted.
    expect(() => resolveStorageDriver()).toThrow(/volatile memory/);
    expect(() => resolveStorageDriver()).not.toThrow(/no driver is installed. Call/);
  });

  it('production, bucket set, no driver installed: still refuses (existing DEF-308 backstop)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FIREBASE_STORAGE_BUCKET', 'some-private-bucket');
    expect(() => resolveStorageDriver()).toThrow(/no driver is installed/);
  });

  it('production with an installed driver: returns it (the boot hook path is untouched)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FIREBASE_STORAGE_BUCKET', 'some-private-bucket');
    const installed = inMemoryDriver();
    setStorageDriver(installed);
    expect(resolveStorageDriver()).toBe(installed);
  });

  it('development and test keep the in-memory fallback, and cache it', () => {
    for (const env of ['development', 'test']) {
      setStorageDriver(null);
      vi.stubEnv('NODE_ENV', env);
      vi.stubEnv('FIREBASE_STORAGE_BUCKET', '');
      const d = resolveStorageDriver();
      expect(d.name).toBe('in-memory');
      expect(resolveStorageDriver()).toBe(d);
    }
  });
});

/** S1 startup: the ERP boot hook itself must throw, not log and return. */
describe('T-495 S1 - instrumentation register() in production', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setStorageDriver(null);
  });

  it.each([
    ['absent', ''],
    ['whitespace-only', '   '],
  ])('production, bucket %s: register() throws naming FIREBASE_STORAGE_BUCKET', async (_l, bucket) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('FIREBASE_STORAGE_BUCKET', bucket);
    const { register } = await import('../../apps/erp/src/instrumentation');
    await expect(register()).rejects.toThrow(/FIREBASE_STORAGE_BUCKET/);
  }, 60000);

  it('development and test: register() resolves and falls back to memory', async () => {
    for (const env of ['development', 'test']) {
      vi.stubEnv('NODE_ENV', env);
      vi.stubEnv('NEXT_RUNTIME', 'nodejs');
      vi.stubEnv('FIREBASE_STORAGE_BUCKET', '');
      const { register } = await import('../../apps/erp/src/instrumentation');
      await expect(register()).resolves.toBeUndefined();
    }
  }, 60000);
});
