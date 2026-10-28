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
    expect(() => resolveStorageDriver()).toThrow(/FIREBASE_STORAGE_BUCKET/);
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
