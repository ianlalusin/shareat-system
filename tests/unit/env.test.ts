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
  const mod = await import('@shareat/core/env');
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

/**
 * T-232 slice 1 — `publicEnv()`'s first caller is the email sign-in form, and it must not be
 * blocked by a value Firebase Auth never reads.
 *
 * ⭐ The pair matters more than either test alone: the second is the non-zero control for the first.
 * Without it, "a blank storage bucket is accepted" would also pass against a schema that had gone
 * fully optional and would sign a person in against a project with no api key at all.
 */
async function loadPublicEnv() {
  const mod = await import('@shareat/core/env');
  return mod.publicEnv();
}

describe('publicEnv — identity is required, storage and analytics are not', () => {
  const IDENTITY = {
    NEXT_PUBLIC_FIREBASE_API_KEY: 'AIza-test',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'studio-test.firebaseapp.com',
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'studio-test',
  };

  it('accepts a BLANK storage bucket and app id — a different project, and no path here reads them', async () => {
    // ⚠️ This is what `.env.local` and an unset GitHub Secret both actually produce: '', not absent.
    Object.assign(E(), IDENTITY, {
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: '',
      NEXT_PUBLIC_FIREBASE_APP_ID: '   ',
    });
    const cfg = await loadPublicEnv();
    expect(cfg.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe('studio-test');
    expect(cfg.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET).toBeUndefined();
    expect(cfg.NEXT_PUBLIC_FIREBASE_APP_ID).toBeUndefined();
  });

  it('⛔ still REFUSES a blank api key — the sign-in form must fail loudly, not sign in against nothing', async () => {
    Object.assign(E(), IDENTITY, { NEXT_PUBLIC_FIREBASE_API_KEY: '' });
    await expect(loadPublicEnv()).rejects.toThrow(/NEXT_PUBLIC_FIREBASE_API_KEY/);
  });

  it('⛔ and REFUSES an ABSENT api key — the distinction this file exists for', async () => {
    // ⚠️ Blank and absent are different inputs and this schema treats them differently by design:
    // `.min(1)` catches '' while `.optional()` would have waved it through. An unset GitHub Secret
    // arrives absent; an empty line in .env.local arrives blank. Both must be refused here, and only
    // asserting one of them leaves half the guard untested.
    Object.assign(E(), IDENTITY);
    delete E().NEXT_PUBLIC_FIREBASE_API_KEY;
    await expect(loadPublicEnv()).rejects.toThrow(/NEXT_PUBLIC_FIREBASE_API_KEY/);
  });

  it('⛔ still REFUSES a missing auth domain or project id', async () => {
    Object.assign(E(), IDENTITY);
    delete E().NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
    await expect(loadPublicEnv()).rejects.toThrow(/NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN/);

    Object.assign(E(), IDENTITY);
    delete E().NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    await expect(loadPublicEnv()).rejects.toThrow(/NEXT_PUBLIC_FIREBASE_PROJECT_ID/);
  });
});

/**
 * T-292 / DEF-315 — `loadServerEnv()`'s own two value-vs-documentation checks, executed against
 * the real function (not `checkValuesMatch` in isolation — that is `tests/unit/
 * config-contract.test.ts`'s job). `BASE.APP_TIMEZONE` is already `'Asia/Manila'`, which is also
 * `BUSINESS_TIMEZONE`, so every test elsewhere in this file that never touches `APP_TIMEZONE` is
 * already a passing control for that check — it does not need repeating per file.
 */
describe('env — DEF-315: APP_TIMEZONE must match BUSINESS_TIMEZONE (packages/core/src/datetime.ts)', () => {
  it('⛔ REFUSES when APP_TIMEZONE disagrees with BUSINESS_TIMEZONE', async () => {
    E().NODE_ENV = 'development';
    E().APP_TIMEZONE = 'UTC';
    await expect(loadEnv()).rejects.toThrow(/BUSINESS_TIMEZONE/);
  });

  it('⭐ CONTROL: resolves when APP_TIMEZONE matches — proves the plant above is the check firing, not something else broken', async () => {
    E().NODE_ENV = 'development';
    E().APP_TIMEZONE = 'Asia/Manila';
    await expect(loadEnv()).resolves.toMatchObject({ APP_TIMEZONE: 'Asia/Manila' });
  });

  it('⭐ CONTROL: resolves on the default (APP_TIMEZONE unset) — the common case in every other test in this file', async () => {
    E().NODE_ENV = 'development';
    delete E().APP_TIMEZONE;
    await expect(loadEnv()).resolves.toMatchObject({ APP_TIMEZONE: 'Asia/Manila' });
  });
});

describe('env — DEF-315: FIREBASE_PROJECT_ID must match NEXT_PUBLIC_FIREBASE_PROJECT_ID when both are visible', () => {
  it('⛔ REFUSES when both are set and disagree', async () => {
    E().NODE_ENV = 'development';
    E().FIREBASE_PROJECT_ID = 'studio-7300228488-a394e';
    E().NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'a-different-project';
    await expect(loadEnv()).rejects.toThrow(/NEXT_PUBLIC_FIREBASE_PROJECT_ID/);
  });

  it('⭐ CONTROL: resolves when both are set and agree', async () => {
    E().NODE_ENV = 'development';
    E().FIREBASE_PROJECT_ID = 'studio-7300228488-a394e';
    E().NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'studio-7300228488-a394e';
    await expect(loadEnv()).resolves.toMatchObject({
      FIREBASE_PROJECT_ID: 'studio-7300228488-a394e',
    });
  });

  it("⭐ CONTROL: resolves when NEXT_PUBLIC_FIREBASE_PROJECT_ID is ABSENT — today's actual production shape (T-292 Finding 2), and the executed proof this check is a genuine no-op there, not merely reasoned to be one", async () => {
    E().NODE_ENV = 'development';
    E().FIREBASE_PROJECT_ID = 'studio-7300228488-a394e';
    delete E().NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    await expect(loadEnv()).resolves.toMatchObject({
      FIREBASE_PROJECT_ID: 'studio-7300228488-a394e',
    });
  });
});
