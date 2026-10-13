import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/audit/canonical-json';
import { isSecretKey, keyTokens, redactPayload } from '../src/audit/redact';

/**
 * T-402 S1b - redaction by key TOKENS (R5, Invariants 6 and 7) and canonical JSON (R10, Invariant 22b).
 * TESTER, not BUILDER. Red today: packages/db/src/audit/{redact,canonical-json}.ts do not exist (module not found).
 *
 * NAMES THE BUILDER MUST MATCH
 *   redact.ts:         keyTokens(key): string[]   lower-case tokens, split on camelCase, '_' and '-'  (pinHash -> ['pin','hash'])
 *                      isSecretKey(key): boolean  (R5 token set + adjacent pairs api+key, private+key, session+id, refresh+token)
 *                      redactPayload(value, opts?): { value: unknown; redactedKeys: string[] }
 *                          - walks objects and arrays recursively, returns a COPY (never mutates the input)
 *                          - redacted value is the string '[REDACTED]'; redactedKeys are dot paths RELATIVE to `value`
 *                            ('nested.passwordHash', 'Api_Key'; array members 'items.0.pin')
 *                          - also redacts, whatever the key, a string value shaped like a scrypt hash (scrypt$...), a JWT
 *                            (eyJ... with two dots)
 *                          - a key whose LAST tokens are account+number is MASKED, not redacted: '1234567890123' -> '••••0123'
 *                            (four U+2022 bullets + the last 4 digits), and the sibling '<key>Changed' boolean is added
 *                            (computed by the caller of redactPayload through opts.compareWith, see below)
 *                      opts.compareWith?: unknown  the OTHER side's unmasked payload; when given, a masked key K also gets
 *                          'KChanged': true|false = (this.K !== compareWith.K), compared BEFORE masking.
 *   canonical-json.ts: canonicalJson(value): string   RFC 8785 style: sorted keys at every depth, no whitespace
 */
describe('keyTokens (R5)', () => {
  it('splits camelCase, snake_case, kebab-case and SCREAMING_CASE into lower-case tokens', () => {
    expect(keyTokens('pinHash')).toEqual(['pin', 'hash']);
    expect(keyTokens('API_KEY')).toEqual(['api', 'key']);
    expect(keyTokens('Api_Key')).toEqual(['api', 'key']);
    expect(keyTokens('session-id')).toEqual(['session', 'id']);
    expect(keyTokens('sessionId')).toEqual(['session', 'id']);
    expect(keyTokens('refreshToken')).toEqual(['refresh', 'token']);
    expect(keyTokens('bankAccountNumber')).toEqual(['bank', 'account', 'number']);
    expect(keyTokens('spinach')).toEqual(['spinach']);
  });
});

describe('isSecretKey (R5, Invariant 6)', () => {
  const SECRET = [
    'password', 'passwordHash', 'newPassword', 'PASSWORD', 'passcode', 'pin', 'PIN', 'pinHash', 'pin_hash', 'userPin', 'old-pin',
    'token', 'accessToken', 'refresh_token', 'secret', 'clientSecret', 'otp', 'hash', 'salt', 'scrypt', 'cookie', 'authorization',
    'jwt', 'apiKey', 'api_key', 'API-KEY', 'Api_Key', 'privateKey', 'private_key', 'sessionId', 'session_id', 'SESSION-ID',
  ];
  const SAFE = [
    'pinned', 'isPinned', 'spinach', 'opinion', 'shipping', 'hashtag', 'tokenized', 'note', 'storeId', 'bankName', 'staffCode',
    'sessionStart', 'primaryKey', 'monkey', 'keyboard', 'apiVersion', 'privateNote', 'sessions', 'identity', 'saltine', 'cookies',
  ];
  for (const k of SECRET) it(`redacts the key ${k}`, () => expect(isSecretKey(k), k).toBe(true));
  for (const k of SAFE) it(`keeps the key ${k} (false-positive list)`, () => expect(isSecretKey(k), k).toBe(false));
});

describe('redactPayload (R5, Invariants 6 and 7)', () => {
  it('Invariant 6: the spec example - pin, nested passwordHash, Api_Key redacted; note kept; three paths recorded', () => {
    const input = { pin: '1234', nested: { passwordHash: 'scrypt$abc$def' }, Api_Key: 'x', note: 'ok' };
    const { value, redactedKeys } = redactPayload(input);
    expect(value).toEqual({ pin: '[REDACTED]', nested: { passwordHash: '[REDACTED]' }, Api_Key: '[REDACTED]', note: 'ok' });
    expect([...redactedKeys].sort()).toEqual(['Api_Key', 'nested.passwordHash', 'pin']);
    expect(input.pin, 'the input object is not mutated').toBe('1234');
  });

  it('mutant "top-level only": a secret three levels deep and inside an array is redacted', () => {
    const { value, redactedKeys } = redactPayload({ a: { b: { c: { token: 'zzz' } } }, items: [{ ok: 1 }, { pin: '654321' }] });
    expect(JSON.stringify(value)).not.toMatch(/zzz|654321/);
    expect(redactedKeys.some((k) => k.endsWith('token'))).toBe(true);
    expect(redactedKeys.some((k) => k.startsWith('items') && k.endsWith('pin'))).toBe(true);
  });

  it('mutant "case-sensitive match": PIN, Password and API_KEY all redact', () => {
    const { value } = redactPayload({ PIN: '1111', Password: 'p', API_KEY: 'k', SessionId: 's' });
    expect(Object.values(value as Record<string, unknown>)).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]']);
  });

  it('false positives survive untouched and record nothing', () => {
    const input = { pinned: true, isPinned: false, spinach: 'x', opinion: 'y', shipping: 12, hashtag: '#a', tokenized: 'b' };
    const { value, redactedKeys } = redactPayload(input);
    expect(value).toEqual(input);
    expect(redactedKeys).toEqual([]);
  });

  it('a scrypt-shaped or JWT-shaped STRING is redacted whatever its key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnLW5hdHVyZV8x';
    const { value, redactedKeys } = redactPayload({ note: `scrypt$16384$8$1$deadbeef`, memo: jwt, plain: 'eyJnotajwt' });
    expect(value).toEqual({ note: '[REDACTED]', memo: '[REDACTED]', plain: 'eyJnotajwt' });
    expect([...redactedKeys].sort()).toEqual(['memo', 'note']);
  });

  it('null, numbers, booleans and an empty object pass through', () => {
    expect(redactPayload(null).value).toBeNull();
    expect(redactPayload(5).value).toBe(5);
    expect(redactPayload({}).value).toEqual({});
  });

  it('R5 masking: an account+number key keeps the last 4 digits, is NOT counted as redacted, and the Changed flag compares the UNMASKED values', () => {
    const before = { bankName: 'BDO', bankAccountNumber: '1234567890123' };
    const after = { bankName: 'BDO', bankAccountNumber: '9876543210987' };
    const a = redactPayload(after, { compareWith: before });
    expect(a.value).toEqual({ bankName: 'BDO', bankAccountNumber: '••••0987', bankAccountNumberChanged: true });
    expect(a.redactedKeys, 'masked is not redacted').toEqual([]);
    const b = redactPayload(before, { compareWith: after });
    expect((b.value as Record<string, unknown>).bankAccountNumber).toBe('••••0123');
    expect((b.value as Record<string, unknown>).bankAccountNumberChanged).toBe(true);
    const same = redactPayload(before, { compareWith: { ...before } });
    expect((same.value as Record<string, unknown>).bankAccountNumberChanged).toBe(false);
    expect(JSON.stringify([a.value, b.value])).not.toMatch(/\d{5,}/);
  });

  it('R5 masking mutant "changed flag computed after masking": two different numbers ending in the same 4 digits still read changed', () => {
    const { value } = redactPayload({ accountNumber: '1111222233334444' }, { compareWith: { accountNumber: '9999888877774444' } });
    expect((value as Record<string, unknown>).accountNumber).toBe('••••4444');
    expect((value as Record<string, unknown>).accountNumberChanged).toBe(true);
  });

  it('a null account number stays null (a first set has before = null)', () => {
    const { value } = redactPayload({ bankAccountNumber: null }, { compareWith: { bankAccountNumber: '1234567890123' } });
    expect((value as Record<string, unknown>).bankAccountNumber).toBeNull();
    expect((value as Record<string, unknown>).bankAccountNumberChanged).toBe(true);
  });
});

describe('canonicalJson (R10, Invariant 22b)', () => {
  it('the same value with keys in another order is byte-identical; no whitespace', () => {
    const a = { b: 1, a: { y: [1, { d: 4, c: 3 }], x: null } };
    const b = { a: { x: null, y: [1, { c: 3, d: 4 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":null,"y":[1,{"c":3,"d":4}]},"b":1}');
  });

  it('different values differ; arrays keep their order; numbers are normalised (1.0 and 1 are the same, -0 is 0)', () => {
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ n: 1.0 })).toBe(canonicalJson({ n: 1 }));
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
  });
});
