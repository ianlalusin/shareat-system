import { describe, it, expect } from 'vitest';
import { generateMatchToken, mintUniqueToken } from './token';

// Carried across from v1's fingerprint-token.test.ts unchanged (T-314 slice A ruling,
// 2026-09-14): under the mint-not-derive contract, "unique across many calls with no
// input" is exactly the property a random mint needs, not a stale test.
describe('generateMatchToken', () => {
  it('is 32 lowercase hex chars', () => {
    expect(generateMatchToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is effectively unique across many calls', () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(generateMatchToken());
    expect(set.size).toBe(1000);
  });
});

describe('mintUniqueToken', () => {
  it('returns a candidate nothing claims', async () => {
    const token = await mintUniqueToken(async () => false);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('retries past a taken candidate', async () => {
    let calls = 0;
    const token = await mintUniqueToken(async () => {
      calls++;
      return calls === 1; // first candidate taken, second is free
    });
    expect(calls).toBe(2);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('throws rather than hand back an empty token when every candidate collides', async () => {
    await expect(mintUniqueToken(async () => true)).rejects.toThrow(/exhausted/i);
  });
});
