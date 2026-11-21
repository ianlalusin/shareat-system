/**
 * T-598 S9 / DEF-373: the deploy preflight refuses a build that carries an emulator host.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_ONLY_ENV_KEYS, devOnlyKeysSet } from '../../scripts/lib/dev-only-env';

describe('devOnlyKeysSet', () => {
  it('names each dev-only variable that is set', () => {
    expect(devOnlyKeysSet({ FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' })).toEqual(['FIREBASE_AUTH_EMULATOR_HOST']);
    expect(devOnlyKeysSet({ NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182' })).toEqual(['NEXT_PUBLIC_FIREBASE_EMULATOR_HOST']);
  });
  it('ignores an unset or empty one', () => {
    expect(devOnlyKeysSet({})).toEqual([]);
    expect(devOnlyKeysSet({ FIREBASE_AUTH_EMULATOR_HOST: '', NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: undefined })).toEqual([]);
  });
  it('the list is not empty, and the preflight script uses it', () => {
    expect(DEV_ONLY_ENV_KEYS.length).toBeGreaterThan(0);
    expect(readFileSync(join(__dirname, '..', '..', 'scripts', 'deploy-preflight.ts'), 'utf8')).toContain('devOnlyKeysSet(process.env)');
  });
});
