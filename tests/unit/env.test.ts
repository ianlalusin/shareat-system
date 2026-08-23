import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * PROJECT_BIBLE.md §7 rule 9 — "Secrets fail closed. A missing secret aborts startup."
 *
 * The Firebase Admin credentials are deliberately NOT required until the auth bridge
 * lands (Phase 0 T-006), because nothing reads them yet and Phase 1 never touches auth.
 * That relaxation is scoped to development and test ONLY. These tests exist so the
 * production requirement cannot be lost by accident later.
 *
 * The empty-string case is the one that actually bit: an unset variable in a .env file
 * arrives as '', not undefined, so a bare `.optional()` does not accept it.
 */

const BASE = {
  DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev',
  SESSION_SECRET: 'x'.repeat(48),
  APP_TIMEZONE: 'Asia/Manila',
};

let saved: NodeJS.ProcessEnv;

/**
 * `process.env.NODE_ENV` is typed readonly once Next's types are in scope, and
 * ProcessEnv does not structurally accept a plain object literal. Tests legitimately
 * need to drive both, so go through one deliberately-typed accessor rather than
 * scattering casts.
 */
type MutableEnv = Record<string, string | undefined>;
const E = () => process.env as unknown as MutableEnv;

beforeEach(() => {
  saved = process.env;
  process.env = { ...BASE } as unknown as NodeJS.ProcessEnv;
  vi.resetModules();
});

afterEach(() => {
  process.env = saved;
});

async function loadEnv() {
  const mod = await import('@/lib/env');
  return mod.env();
}

describe('env — Firebase credentials outside production', () => {
  it('starts when the Firebase variables are entirely absent', async () => {
    E().NODE_ENV = 'development';
    await expect(loadEnv()).resolves.toMatchObject({ NODE_ENV: 'development' });
  });

  it('starts when the Firebase variables are present but blank', async () => {
    // This is what `.env.local` actually produces for `FIREBASE_PROJECT_ID=`.
    E().NODE_ENV = 'development';
    E().FIREBASE_PROJECT_ID = '';
    E().FIREBASE_SERVICE_ACCOUNT_KEY = '   ';
    const cfg = await loadEnv();
    expect(cfg.FIREBASE_PROJECT_ID).toBeUndefined();
    expect(cfg.FIREBASE_SERVICE_ACCOUNT_KEY).toBeUndefined();
  });
});

describe('env — Firebase credentials in production fail closed', () => {
  it('REFUSES to start when they are absent', async () => {
    E().NODE_ENV = 'production';
    await expect(loadEnv()).rejects.toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('REFUSES to start when they are blank', async () => {
    E().NODE_ENV = 'production';
    E().FIREBASE_PROJECT_ID = '';
    E().FIREBASE_SERVICE_ACCOUNT_KEY = '';
    await expect(loadEnv()).rejects.toThrow(/is required in production/);
  });

  it('starts when they are supplied', async () => {
    E().NODE_ENV = 'production';
    E().FIREBASE_PROJECT_ID = 'shareat-erp';
    E().FIREBASE_SERVICE_ACCOUNT_KEY = '{"type":"service_account"}';
    await expect(loadEnv()).resolves.toMatchObject({ FIREBASE_PROJECT_ID: 'shareat-erp' });
  });
});

describe('env — the non-negotiable secrets never relax', () => {
  it('REFUSES to start without DATABASE_URL, in development', async () => {
    E().NODE_ENV = 'development';
    delete E().DATABASE_URL;
    await expect(loadEnv()).rejects.toThrow(/DATABASE_URL/);
  });

  it('REFUSES to start without SESSION_SECRET, in development', async () => {
    E().NODE_ENV = 'development';
    delete E().SESSION_SECRET;
    await expect(loadEnv()).rejects.toThrow(/SESSION_SECRET/);
  });

  it('REFUSES a SESSION_SECRET that is too short to be meaningful', async () => {
    E().NODE_ENV = 'development';
    E().SESSION_SECRET = 'short';
    await expect(loadEnv()).rejects.toThrow(/SESSION_SECRET/);
  });
});
