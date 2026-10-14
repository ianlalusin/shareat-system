import { describe, expect, it } from 'vitest';
// T-405 — the helper does not exist yet. This import is expected to fail until the builder adds it.
import { NO_PERSON, UNKNOWN_PERSON, personName } from '../src/lib/person-name';

/**
 * T-405 — `personName` never renders a raw person id on screen (bible row 229: what a person sees
 * names things in words, never an id). Invariants I1-I4 each have a named mutant; see the spec at
 * docs/tasks/405-person-name-helper.md.
 */

const ID = '3f2b8c1e-9d4a-4b7e-8f10-2a6c5d9e7b41';
const OTHER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const mapLookup = new Map<string, string>([
  [ID, 'Ana Reyes'],
  [OTHER_ID, '   '],
]);

const arrayLookup = [
  { id: ID, displayName: 'Ana Reyes' },
  { id: OTHER_ID, displayName: '   ' },
];

describe('personName — constants', () => {
  it('uses the exact wording from the spec', () => {
    expect(UNKNOWN_PERSON).toBe('Unknown person');
    expect(NO_PERSON).toBe('—');
  });
});

describe('personName — found', () => {
  it('returns the display name for a found id (Map lookup)', () => {
    expect(personName(mapLookup, ID)).toBe('Ana Reyes');
  });

  it('returns the display name for a found id (array lookup)', () => {
    expect(personName(arrayLookup, ID)).toBe('Ana Reyes');
  });

  it('trims surrounding whitespace from a found name', () => {
    const lookup = new Map([[ID, '  Ana Reyes  ']]);
    expect(personName(lookup, ID)).toBe('Ana Reyes');
  });
});

describe('personName — no person at all (I2)', () => {
  // Mutant M2 swaps the two constants: no person must read as the dash, not as "Unknown person".
  it.each([null, undefined, ''])('returns the dash for %s', (value) => {
    expect(personName(mapLookup, value as string | null | undefined)).toBe(NO_PERSON);
    expect(personName(arrayLookup, value as string | null | undefined)).toBe(NO_PERSON);
  });

  it('never returns "Unknown person" when there is no person', () => {
    expect(personName(mapLookup, null)).not.toBe(UNKNOWN_PERSON);
  });
});

describe('personName — a miss (I1)', () => {
  const MISSING = '9c8d7e6f-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

  // Mutant M1 returns personId on a miss.
  it('returns Unknown person for an id that is not in the lookup (Map)', () => {
    expect(personName(mapLookup, MISSING)).toBe(UNKNOWN_PERSON);
  });

  it('returns Unknown person for an id that is not in the lookup (array)', () => {
    expect(personName(arrayLookup, MISSING)).toBe(UNKNOWN_PERSON);
  });

  it('never echoes the raw UUID of a miss', () => {
    const out = personName(mapLookup, MISSING);
    expect(out).not.toBe(MISSING);
    expect(out).not.toContain(MISSING);
    expect(out).not.toContain(MISSING.slice(0, 8));
  });
});

describe('personName — blank stored name is a miss (I3)', () => {
  // Mutant M3 drops the trim/blank check, so a blank name would render as empty or whitespace.
  it.each(['', '   ', '\t \n'])('treats the blank name %j as Unknown person (Map)', (blank) => {
    const lookup = new Map([[ID, blank]]);
    expect(personName(lookup, ID)).toBe(UNKNOWN_PERSON);
  });

  it('treats a blank stored name as Unknown person (array)', () => {
    expect(personName([{ id: ID, displayName: '  ' }], ID)).toBe(UNKNOWN_PERSON);
  });

  it('never returns an empty string', () => {
    const lookup = new Map([[ID, '']]);
    expect(personName(lookup, ID)).not.toBe('');
  });
});
