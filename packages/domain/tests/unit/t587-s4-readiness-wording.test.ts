import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatBusinessDayLong } from '@shareat/core/datetime';
import { countOf } from '@shareat/core/sentence';

/**
 * T-587 S4 - the store readiness sentences are plain words: a real plural ("1 room", "4 rooms", never "room(s)"),
 * no defect numbers or jargon, long dates. The rendered sentences are covered by the integration tests
 * (stores, t338, t346); this file pins the helper and scans the text the checks are built from.
 */
describe('countOf', () => {
  it('1 is singular, 4 and 0 are plural', () => {
    expect(countOf(1, 'room')).toBe('1 room');
    expect(countOf(4, 'room')).toBe('4 rooms');
    expect(countOf(0, 'admin')).toBe('0 admins');
    expect(countOf(1, 'person', 'people')).toBe('1 person');
    expect(countOf(2, 'person', 'people')).toBe('2 people');
  });
});

describe('formatBusinessDayLong', () => {
  it('a business date in long words, and the raw text for anything that is not a date', () => {
    expect(formatBusinessDayLong('2022-02-14')).toBe('February 14, 2022');
    expect(formatBusinessDayLong('not a date')).toBe('not a date');
  });
});

describe('storeReadiness wording', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'stores', 'service.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function storeReadiness'));
  // what a person reads: the string literals of the function, comments dropped
  const text = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('no "(s)" hedges', () => {
    expect(text).not.toContain('(s)');
  });
  it('no defect numbers or developer words in the sentences', () => {
    for (const bad of ['DEF-', 're-fans', 'screenshot', 'scope row', 'scoped.']) expect(text, bad).not.toContain(bad);
  });
});
