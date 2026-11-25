import { describe, expect, it } from 'vitest';
import { KeyCryptoError, decryptSecret, encryptSecret, keyContext, lastFour, parseMasterKey } from '../src/crypto';

/**
 * T-640 test 1 (the unit half): AES-256-GCM round trip, the stored value is not the plaintext, a ciphertext is bound to its row, and a changed byte or a wrong master key opens nothing.
 * The database half (the column holds only the envelope; no list, view, audit row or message holds the key) is packages/domain/tests/integration/t640-ai-hub.test.ts.
 * Every key below is made up for the test.
 */
const MASTER = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);
const KEY = 'sk-test-0123456789abcdefghijklmnopqrstuvwxyz-ZZZZ';
const CTX = keyContext('org-1', 'openai');

describe('T-640 key cipher', () => {
  it('round-trips, and the stored envelope holds neither the key nor any 8-character piece of it [kills: storing the plaintext, or a cipher that leaks a prefix]', () => {
    const env = encryptSecret(KEY, MASTER, CTX);
    expect(env.startsWith('v1.')).toBe(true);
    expect(decryptSecret(env, MASTER, CTX)).toBe(KEY);
    expect(env).not.toContain(KEY);
    for (let i = 0; i + 8 <= KEY.length; i++) expect(env, KEY.slice(i, i + 8)).not.toContain(KEY.slice(i, i + 8));
  });

  it('two encryptions of the same key differ (a fresh IV each time) [kills: a fixed IV]', () => {
    expect(encryptSecret(KEY, MASTER, CTX)).not.toBe(encryptSecret(KEY, MASTER, CTX));
  });

  it('a wrong master key, a wrong organisation, a wrong provider and a changed byte each open NOTHING and say nothing about the key [kills: no authentication, or a cipher not bound to its row]', () => {
    const env = encryptSecret(KEY, MASTER, CTX);
    const attempts: Array<() => string> = [
      () => decryptSecret(env, OTHER, CTX),
      () => decryptSecret(env, MASTER, keyContext('org-2', 'openai')),
      () => decryptSecret(env, MASTER, keyContext('org-1', 'google')),
      () => {
        const [v, iv, tag, ct] = env.split('.');
        const flipped = Buffer.from(ct!, 'base64');
        flipped[0] = (flipped[0]! ^ 1) & 255;
        return decryptSecret([v, iv, tag, flipped.toString('base64')].join('.'), MASTER, CTX);
      },
      () => decryptSecret('v2.a.b.c', MASTER, CTX),
      () => decryptSecret('not an envelope', MASTER, CTX),
    ];
    for (const a of attempts) {
      let message = '';
      expect(() => {
        try {
          a();
        } catch (e) {
          message = (e as Error).message;
          throw e;
        }
      }).toThrow(KeyCryptoError);
      expect(message).not.toContain(KEY.slice(0, 12));
      expect(message).not.toContain(env.slice(0, 12));
    }
  });

  it('only the last four characters can be shown [kills: showing more of the key]', () => {
    expect(lastFour(KEY)).toBe('ZZZZ');
    expect(lastFour(KEY)).toHaveLength(4);
  });

  it('the master key is 64 hex characters or base64 of 32 bytes; anything else (or nothing) is not a key [kills: accepting a short key]', () => {
    expect(parseMasterKey('ab'.repeat(32))?.length).toBe(32);
    expect(parseMasterKey(Buffer.alloc(32, 5).toString('base64'))?.length).toBe(32);
    expect(parseMasterKey('  ' + 'ab'.repeat(32) + '\n')?.length).toBe(32);
    for (const bad of [undefined, null, '', '   ', 'ab'.repeat(31), 'zz'.repeat(32), Buffer.alloc(16, 5).toString('base64'), 'short']) expect(parseMasterKey(bad as string | undefined), String(bad)).toBeNull();
  });

  it('a key that is not 32 bytes cannot encrypt [kills: AES with a weak key]', () => {
    expect(() => encryptSecret(KEY, Buffer.alloc(16, 1), CTX)).toThrow();
  });
});
