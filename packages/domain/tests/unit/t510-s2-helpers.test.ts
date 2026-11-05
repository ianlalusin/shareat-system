/**
 * T-510 S2 - the pure parts of the daypart writers: SQLSTATE lookup, the one-retry transaction wrapper when a caller's transaction is handed in
 * (never retried: the aborted transaction is the caller's), and the 23514 backstop wording. The database-backed behaviour is in
 * tests/integration/t510-s2-writers.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Tx } from '@shareat/db';
import { daypartGuardRefusal } from '../../src/menu/dayparts';
import { inTxRetry, pgCode } from '../../src/menu/shared';

const pgErr = (code: string, message = 'x') => Object.assign(new Error(message), { code });
const wrapped = (inner: Error) => Object.assign(new Error('Failed query'), { cause: inner });

describe('pgCode', () => {
  it('reads the code on the error, or through the ORM wrapper (cause), and nothing else', () => {
    expect(pgCode(pgErr('40P01'))).toBe('40P01');
    expect(pgCode(wrapped(pgErr('23514')))).toBe('23514');
    expect(pgCode(new Error('plain'))).toBeUndefined();
    expect(pgCode(undefined)).toBeUndefined();
    expect(pgCode(null)).toBeUndefined();
  });
});

describe('inTxRetry with a caller transaction', () => {
  const tx = {} as Tx;
  it('runs once and returns the value', async () => {
    let n = 0;
    expect(await inTxRetry(tx, 'org', async (t) => (n++, t === tx ? 'ok' : 'wrong tx'))).toBe('ok');
    expect(n).toBe(1);
  });
  it('does NOT retry a deadlock (the aborted transaction belongs to the caller)', async () => {
    let n = 0;
    await expect(
      inTxRetry(tx, 'org', async () => {
        n++;
        throw pgErr('40P01');
      }),
    ).rejects.toMatchObject({ code: '40P01' });
    expect(n).toBe(1);
  });
});

describe('daypartGuardRefusal', () => {
  it('words a 0233 guard refusal as a sentence for the user', () => {
    const r = daypartGuardRefusal(wrapped(pgErr('23514', 'live dayparted offers of one variant, store and channel may not overlap in time (x)')));
    expect(r?.userMessage).toMatch(/clash/);
  });
  it('leaves other errors alone: another SQLSTATE, or a 23514 that is not a daypart rule', () => {
    expect(daypartGuardRefusal(pgErr('23505', 'daypart'))).toBeUndefined();
    expect(daypartGuardRefusal(pgErr('23514', 'menu_offers rows are never back-dated'))).toBeUndefined();
    expect(daypartGuardRefusal(new Error('daypart'))).toBeUndefined();
  });
});
