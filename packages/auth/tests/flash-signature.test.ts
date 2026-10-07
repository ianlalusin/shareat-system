import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * T-380 S1a / R4 / REV-11 - `signFlash` and `flashSignatureMatches` (packages/auth/src/credentials.ts).
 *
 * The flash cookie is signed with a key used for nothing else. What these tests defend is that the
 * flash key is NOT the setup-identity key (nor the session-token or pin-lookup key): a cookie signed
 * for one purpose must not verify for another, because a sibling `*.shareat.net` host can set a
 * cookie with this name and the signature is the only thing that stops a forged banner.
 *
 * Killing mutant (cross-purpose legs): make `signFlash` use `derivedKey('setup-identity')` ->
 * "differs from the setup-identity signature" and both cross-verify legs go red.
 * Killing mutant (tamper legs): make `flashSignatureMatches` return true / skip the compare.
 */

const SECRET = 'x'.repeat(48);
const PAYLOAD = Buffer.from(JSON.stringify({ v: 1, n: 'abc', exp: 1, msg: { error: 'Refund is more than the balance' } })).toString(
  'base64url',
);

type Cred = typeof import('../src/credentials');
let cred: Cred;

/** The same derivation `derivedKey` in credentials.ts uses: HMAC(secret, "shareat:<label>:v1") as hex. */
function keyFor(label: string): string {
  return createHmac('sha256', SECRET).update(`shareat:${label}:v1`).digest('hex');
}
function signWith(label: string, payload: string): string {
  return createHmac('sha256', keyFor(label)).update(payload).digest('base64url');
}

beforeAll(async () => {
  process.env = {
    ...process.env,
    DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev',
    SESSION_SECRET: SECRET,
    APP_TIMEZONE: 'Asia/Manila',
  } as unknown as NodeJS.ProcessEnv;
  cred = await import('../src/credentials');
}, 60_000);

describe('signFlash / flashSignatureMatches', () => {
  it('round-trips: a signature over a payload verifies against that payload', () => {
    const sig = cred.signFlash(PAYLOAD);
    expect(sig.length).toBeGreaterThan(20);
    expect(cred.flashSignatureMatches(PAYLOAD, sig)).toBe(true);
  });

  it('one changed byte in the payload -> false', () => {
    const sig = cred.signFlash(PAYLOAD);
    const flipped = (PAYLOAD[0] === 'A' ? 'B' : 'A') + PAYLOAD.slice(1);
    expect(cred.flashSignatureMatches(flipped, sig)).toBe(false);
    expect(cred.flashSignatureMatches(PAYLOAD + 'A', sig)).toBe(false);
  });

  it('one changed character in the signature -> false; empty or malformed signature -> false, never a throw', () => {
    const sig = cred.signFlash(PAYLOAD);
    const bad = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(cred.flashSignatureMatches(PAYLOAD, bad)).toBe(false);
    expect(cred.flashSignatureMatches(PAYLOAD, '')).toBe(false);
    expect(cred.flashSignatureMatches(PAYLOAD, '!!!not-base64!!!')).toBe(false);
    expect(cred.flashSignatureMatches(PAYLOAD, sig.slice(0, -4))).toBe(false);
  });

  it('REV-11: the flash signature differs from the setup-identity signature over the same bytes, and neither verifies as the other', () => {
    const flash = cred.signFlash(PAYLOAD);
    const setup = cred.signSetupIdentity(PAYLOAD);
    expect(flash).not.toBe(setup);
    expect(cred.flashSignatureMatches(PAYLOAD, setup)).toBe(false);
    expect(cred.setupIdentitySignatureMatches(PAYLOAD, flash)).toBe(false);
  });

  it('the flash key is not the session-token key or the pin-lookup key either', () => {
    const flash = cred.signFlash(PAYLOAD);
    for (const label of ['session-token', 'pin-lookup', 'setup-identity']) {
      expect(signWith(label, PAYLOAD)).not.toBe(flash);
      expect(cred.flashSignatureMatches(PAYLOAD, signWith(label, PAYLOAD))).toBe(false);
    }
  });
});
