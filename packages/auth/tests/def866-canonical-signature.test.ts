import { beforeAll, describe, expect, it } from 'vitest';

/**
 * T-580 / DEF-866 - the three HMAC verifiers in packages/auth/src/credentials.ts refuse a signature that is not the canonical base64url of its own bytes.
 *
 * A 32-byte HMAC is 43 base64url characters; the last carries 4 real bits and 2 padding bits, and `Buffer.from(x, 'base64url')` ignores the padding bits. So a
 * "padding variant" (the last character with only its low bits changed) decodes to the SAME bytes. It used to verify; it must now be refused.
 *
 * Killing mutant (each verifier): in `canonicalSignatureBytes` return `Buffer.from(signature, 'base64url')` (drop the re-encode compare) -> the three "padding variant" tests go red.
 */

const SECRET = 'y'.repeat(48);
const PAYLOAD = Buffer.from(JSON.stringify({ v: 1, n: 'def866' })).toString('base64url');
const CLAIM = { orgId: 'o', storeId: 's', pairingId: 'p', approverId: 'a', action: 'line.cancelled', targetId: 't', exp: 1_900_000_000_000, detail: '' };
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

type Cred = typeof import('../src/credentials');
let cred: Cred;

beforeAll(async () => {
  process.env = { ...process.env, DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev', SESSION_SECRET: SECRET, APP_TIMEZONE: 'Asia/Manila' } as unknown as NodeJS.ProcessEnv;
  cred = await import('../src/credentials');
}, 60_000);

/** Same bytes, different string: flip the lowest bit of the last character (always a padding bit of a 43-char HMAC). Always one of 4 characters sharing the same top 4 bits. */
function paddingVariant(sig: string): string {
  expect(sig).toHaveLength(43);
  return sig.slice(0, -1) + ALPHABET[ALPHABET.indexOf(sig.at(-1)!) ^ 1];
}

const cases: [string, (sig: string) => boolean, () => string][] = [
  ['setupIdentitySignatureMatches', (s) => cred.setupIdentitySignatureMatches(PAYLOAD, s), () => cred.signSetupIdentity(PAYLOAD)],
  ['flashSignatureMatches', (s) => cred.flashSignatureMatches(PAYLOAD, s), () => cred.signFlash(PAYLOAD)],
  ['posLineApprovalMatches', (s) => cred.posLineApprovalMatches(CLAIM, s), () => cred.signPosLineApproval(CLAIM)],
];

describe.each(cases)('%s refuses a non-canonical signature (DEF-866)', (_name, verify, sign) => {
  it('the canonical signature passes', () => {
    expect(verify(sign())).toBe(true);
  });

  it('a padding-bits variant decodes to the same bytes but is refused', () => {
    const sig = sign();
    const variant = paddingVariant(sig);
    expect(variant).not.toBe(sig);
    expect(Buffer.from(variant, 'base64url').equals(Buffer.from(sig, 'base64url')), 'precondition: same bytes').toBe(true);
    expect(verify(variant)).toBe(false);
  });

  it('every padding variant of the last character is refused, and a non-string is refused without a throw', () => {
    const sig = sign();
    const group = ALPHABET.indexOf(sig.at(-1)!) & ~3;
    for (let i = group; i < group + 4; i++) {
      const v = sig.slice(0, -1) + ALPHABET[i];
      expect(verify(v), v).toBe(v === sig);
    }
    expect(verify(undefined as unknown as string)).toBe(false);
  });
});
