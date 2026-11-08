// ASSUMED API (T-530a): none. This file touches only T-526's own pure module.
// ASSUMED API: apps/erp/src/lib/pos-device/pin-verifier.ts exports
//   POS_VERIFIER_ITERATIONS: number (>= 210_000)
//   deriveVerifier(pin: string, opts?: { iterations?: number }): Promise<{ salt: string; hash: string; iterations: number }>
//     salt = base64 of 16 random bytes; hash = base64 of the 32-byte PBKDF2-SHA256 output; rejects when iterations < POS_VERIFIER_ITERATIONS
//   verifyPin(pin: string, v: { salt: string; hash: string; iterations: number }): Promise<boolean>   (false, never throws, for a verifier under the floor)
//   constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean   (one `return`, no early exit)
/**
 * T-526 R4 / R6 - the offline PIN verifier: derive, verify, constant-time compare. Pure, WebCrypto only.
 * Spec: docs/tasks/526-pos-kiosk-shell.md R4. Written BEFORE the code (tester lane); red until `pin-verifier.ts` exists.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { POS_VERIFIER_ITERATIONS, constantTimeEqual, deriveVerifier, verifyPin } from '@/lib/pos-device/pin-verifier';

const PIN = '482916';
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'src', 'lib', 'pos-device', 'pin-verifier.ts'), 'utf8');

/** The same PBKDF2-SHA256 computed independently, so "it hashes with PBKDF2-SHA256 and that salt" is proven, not assumed. */
async function independentHash(pin: string, saltB64: string, iterations: number): Promise<string> {
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(saltB64, 'base64'), iterations }, key, 256);
  return Buffer.from(bits).toString('base64');
}

describe('T-526 R4 - pin-verifier', () => {
  let v: Awaited<ReturnType<typeof deriveVerifier>>;
  beforeAll(async () => {
    v = await deriveVerifier(PIN);
  }, 30_000);

  it('the iteration constant is a security floor of at least 210,000 (the current OWASP figure)', () => {
    expect(POS_VERIFIER_ITERATIONS).toBeGreaterThanOrEqual(210_000);
    expect(v.iterations).toBe(POS_VERIFIER_ITERATIONS);
  });

  it('derive then verify: the right PIN is true, a wrong PIN is false (positive control and its refusal)', async () => {
    expect(await verifyPin(PIN, v)).toBe(true);
    expect(await verifyPin('482917', v)).toBe(false);
    expect(await verifyPin('', v)).toBe(false);
  }, 30_000);

  it('is PBKDF2-SHA256 over a 16-byte salt, 32 bytes out: an independent computation gives the same hash', async () => {
    expect(Buffer.from(v.salt, 'base64').length).toBe(16);
    expect(Buffer.from(v.hash, 'base64').length).toBe(32);
    expect(await independentHash(PIN, v.salt, v.iterations)).toBe(v.hash);
  }, 30_000);

  it('two derives of the same PIN differ in salt AND in hash (the salt is per verifier)', async () => {
    const other = await deriveVerifier(PIN);
    expect(other.salt).not.toBe(v.salt);
    expect(other.hash).not.toBe(v.hash);
    expect(await verifyPin(PIN, other)).toBe(true);
  }, 30_000);

  it('refuses to derive with fewer iterations than the constant', async () => {
    await expect(deriveVerifier(PIN, { iterations: POS_VERIFIER_ITERATIONS - 1 })).rejects.toThrow(/iterations/i);
  });

  it('refuses to verify against a verifier made under the floor, even with the right PIN and a genuinely matching hash', async () => {
    const low = 1000;
    const weak = { salt: v.salt, hash: await independentHash(PIN, v.salt, low), iterations: low };
    expect(await verifyPin(PIN, weak)).toBe(false);
  });

  it('constantTimeEqual: equal bytes true; one byte off false; different lengths false', () => {
    const a = Uint8Array.from([1, 2, 3, 4]);
    expect(constantTimeEqual(a, Uint8Array.from([1, 2, 3, 4]))).toBe(true);
    expect(constantTimeEqual(a, Uint8Array.from([1, 2, 3, 5]))).toBe(false);
    expect(constantTimeEqual(a, Uint8Array.from([0, 2, 3, 4]))).toBe(false);
    expect(constantTimeEqual(a, Uint8Array.from([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('constantTimeEqual has no early return (read the source): exactly one `return`, no break/continue', () => {
    const at = source.search(/(?:function\s+constantTimeEqual|constantTimeEqual\s*=)/);
    expect(at, 'constantTimeEqual not found in pin-verifier.ts').toBeGreaterThanOrEqual(0);
    const open = source.indexOf('{', source.indexOf(')', at));
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = source.slice(open, end + 1);
    expect(body.match(/\breturn\b/g)?.length, 'more than one return means an early exit').toBe(1);
    expect(body).not.toMatch(/\b(break|continue)\b/);
  });

  it('the PIN is never logged or sent: the module has no console, fetch or storage call', () => {
    expect(source).not.toMatch(/\bconsole\./);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/localStorage|sessionStorage/);
  });
});
