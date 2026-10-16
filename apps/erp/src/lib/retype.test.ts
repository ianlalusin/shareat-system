import { describe, expect, it } from 'vitest';

/**
 * T-412 S2 (TESTER) - `retypeMatches(typed: unknown, expected: string): boolean`, the Tier R comparison.
 * docs/tasks/412-confirm-destructive-tiers.md "How the server verifies a Tier R action": string only; NFC, trim, collapse
 * inner whitespace, case-insensitive; empty never matches.
 *
 * Red today: apps/erp/src/lib/retype.ts does not exist, so each case fails on the dynamic import with
 * "MISSING MODULE ..." (never a vacuous pass: the 'never match' cases assert `false`, which a missing function cannot return).
 *
 * MUTANTS: M-r1 drop the lowercase fold -> "case" red; M-r2 drop NFC -> "NFC" red; M-r3 `startsWith` instead of equality ->
 * "prefix" red; M-r4 accept `String(typed)` -> "non-strings" red; M-r5 skip the empty guard -> "empty" red.
 */
async function retypeMatches(typed: unknown, expected: string): Promise<boolean> {
  let mod: Record<string, unknown>;
  try {
    // ts-ignore (never ts-expect-error): the import is a type error only until the module exists, and the typecheck gate must
    // stay clean both while this file is red and after the builder lands retype.ts.
    // @ts-ignore
    mod = (await import('./retype')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/lib/retype.ts (T-412 S2 has not been built). ${(e as Error).message}`);
  }
  if (typeof mod.retypeMatches !== 'function') throw new Error('MISSING EXPORT: retype.ts does not export retypeMatches.');
  return (mod.retypeMatches as (t: unknown, e: string) => boolean)(typed, expected);
}

describe('retypeMatches - what DOES match', () => {
  it('the exact name', async () => {
    expect(await retypeMatches('Pork Belly', 'Pork Belly')).toBe(true);
  });
  it('case: any capitalisation', async () => {
    expect(await retypeMatches('pork belly', 'Pork Belly')).toBe(true);
    expect(await retypeMatches('PORK BELLY', 'Pork Belly')).toBe(true);
  });
  it('trim: leading and trailing blanks are ignored', async () => {
    expect(await retypeMatches('  Pork Belly \t', 'Pork Belly')).toBe(true);
    expect(await retypeMatches('Pork Belly', '  Pork Belly ')).toBe(true);
  });
  it('inner whitespace collapses: runs of blanks, tabs and newlines read as one space', async () => {
    expect(await retypeMatches('Pork    Belly', 'Pork Belly')).toBe(true);
    expect(await retypeMatches('Pork\t\nBelly', 'Pork Belly')).toBe(true);
    expect(await retypeMatches('Pork Belly', 'Pork   Belly')).toBe(true);
  });
  it('NFC: a decomposed e + combining acute equals the composed e-acute (a phone keyboard may send either)', async () => {
    const composed = 'Café Lipa';
    const decomposed = 'Café Lipa';
    expect(composed).not.toBe(decomposed);
    expect(await retypeMatches(decomposed, composed)).toBe(true);
    expect(await retypeMatches(composed, decomposed)).toBe(true);
  });
});

describe('retypeMatches - what NEVER matches', () => {
  it('empty: an empty or blank typed value never matches, even against an empty or blank name', async () => {
    expect(await retypeMatches('', 'Pork Belly')).toBe(false);
    expect(await retypeMatches('   ', 'Pork Belly')).toBe(false);
    expect(await retypeMatches('', '')).toBe(false);
    expect(await retypeMatches('   ', '   ')).toBe(false);
    expect(await retypeMatches('Pork Belly', '')).toBe(false);
  });
  it('prefix and suffix: part of the name, or the name plus more, is not the name', async () => {
    expect(await retypeMatches('Pork', 'Pork Belly')).toBe(false);
    expect(await retypeMatches('Pork Belly Extra', 'Pork Belly')).toBe(false);
    expect(await retypeMatches('Belly', 'Pork Belly')).toBe(false);
  });
  it('accents are NOT folded: cafe is not café', async () => {
    expect(await retypeMatches('cafe', 'café')).toBe(false);
  });
  it('a joined word is not a spaced one: collapse means "one space", not "no space"', async () => {
    expect(await retypeMatches('PorkBelly', 'Pork Belly')).toBe(false);
  });
  it('non-strings: null, undefined, a number, an array, an object that prints as the name, a File-like value', async () => {
    expect(await retypeMatches(null, 'Pork Belly')).toBe(false);
    expect(await retypeMatches(undefined, 'Pork Belly')).toBe(false);
    expect(await retypeMatches(123, '123')).toBe(false);
    expect(await retypeMatches(['Pork Belly'], 'Pork Belly')).toBe(false);
    expect(await retypeMatches({ toString: () => 'Pork Belly' }, 'Pork Belly')).toBe(false);
    expect(await retypeMatches(new Blob(['Pork Belly']), 'Pork Belly')).toBe(false);
  });
});
