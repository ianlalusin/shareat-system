import { describe, expect, it } from 'vitest';
// T-406 — the helper does not exist yet. This import is expected to fail until the builder adds it.
import {
  ACCOUNT_WORDS,
  UNKNOWN_ACCOUNT,
  accountCodeAndName,
  accountLabel,
} from './account-label';
// Same relative-import pattern as tests/integration/constraint-message-lookup.test.ts.
import { CHART_OF_ACCOUNTS } from '../../../../packages/db/seed/chart-of-accounts';

/**
 * T-406 — `accountLabel` shows account WORDS on ordinary screens, never a GL number (bible row 229:
 * what a person sees names things in words, never an id, a code or a key). Spec:
 * docs/tasks/406-account-label-helper.md. Mutants M1-M3 are named inline.
 */

describe('accountLabel — known code', () => {
  it('returns the plain words for a known code', () => {
    expect(accountLabel('2110')).toBe('Owed to suppliers');
    expect(accountLabel('1220')).toBe('Due from delivery platforms');
    expect(accountLabel('5400')).toBe('Stock count differences');
  });

  it('returns the same words for the same code every time', () => {
    expect(accountLabel('2110')).toBe(accountLabel('2110'));
  });
});

describe('accountLabel — a miss (M1, M2)', () => {
  // Mutant M1 returns the code on a miss. Mutant M2 returns ''.
  it.each(['9999', '0000', '2111'])('returns UNKNOWN_ACCOUNT for unknown code %s', (code) => {
    expect(accountLabel(code)).toBe(UNKNOWN_ACCOUNT);
  });

  it.each(['', null, undefined])('returns UNKNOWN_ACCOUNT for empty/absent value %j', (value) => {
    expect(accountLabel(value as string | null | undefined)).toBe(UNKNOWN_ACCOUNT);
  });

  it('uses the exact wording from the spec', () => {
    expect(UNKNOWN_ACCOUNT).toBe('Other account');
  });

  it('never echoes the bare code on a miss', () => {
    expect(accountLabel('9999')).not.toBe('9999');
    expect(accountLabel('9999')).not.toContain('9999');
  });

  it('never returns an empty string', () => {
    expect(accountLabel('')).not.toBe('');
    expect(accountLabel('9999')).not.toBe('');
  });
});

describe('accountLabel — words only, never a number (M3)', () => {
  // Mutant M3 returns accountCodeAndName output ("2110 · Owed to suppliers"), which contains digits.
  it.each(Object.keys(ACCOUNT_WORDS))('label for %s is words, not the code, and has no digit', (k) => {
    const label = accountLabel(k);
    expect(label).not.toBe(k);
    expect(label).not.toMatch(/\d/);
  });

  it('never returns the code-and-name form for a known code', () => {
    expect(accountLabel('2110')).not.toContain('·');
    expect(accountLabel('2110')).not.toContain('2110');
  });
});

describe('ACCOUNT_WORDS — every key is a real chart account', () => {
  const chartCodes = new Set(CHART_OF_ACCOUNTS.map((a) => a.code));

  it('has at least one entry', () => {
    expect(Object.keys(ACCOUNT_WORDS).length).toBeGreaterThan(0);
  });

  it.each(Object.keys(ACCOUNT_WORDS))('key %s exists in the seeded chart of accounts', (k) => {
    expect(chartCodes.has(k)).toBe(true);
  });
});

describe('accountCodeAndName — reports only', () => {
  it('returns "code · name" for a known code', () => {
    expect(accountCodeAndName('2110')).toBe('2110 · Owed to suppliers');
  });

  it('returns UNKNOWN_ACCOUNT for an unknown code (never the bare code)', () => {
    expect(accountCodeAndName('9999')).toBe(UNKNOWN_ACCOUNT);
  });
});
