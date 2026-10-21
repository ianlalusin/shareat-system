import { describe, expect, it } from 'vitest';
// T-438 S2a - the module does not exist yet; this import is expected to fail until the builder adds it.
import { formatDisplayName, nameKey, normaliseNamePart } from '../../src/people/person-name';

/**
 * T-438 U1-U4 (docs/tasks/438-hire-name-parts-and-staff-pin-only.md, N2 + N4). Pure functions, no database.
 * Assumed signatures (spec lists names only): formatDisplayName({ lastName, firstName, middleName? }) -> string;
 * normaliseNamePart(string) -> trimmed, inner spaces collapsed; nameKey(string) -> string.
 */
const fmt = (lastName: string, firstName: string, middleName?: string | null) =>
  formatDisplayName({ lastName, firstName, ...(middleName === undefined ? {} : { middleName }) });

describe('T-438 U1 - the formatter prints "Last, First M."', () => {
  it('Santos / Maria / clara -> "Santos, Maria C."', () => {
    // Kills: initial not uppercased ("c."); full middle printed ("Clara"); no period ("C").
    expect(fmt('Santos', 'Maria', 'clara')).toBe('Santos, Maria C.');
  });
  it('multi-word parts keep their words: Dela Cruz / Juan Miguel / santos', () => {
    expect(fmt('Dela Cruz', 'Juan Miguel', 'santos')).toBe('Dela Cruz, Juan Miguel S.');
  });
});

describe('T-438 U2 - no middle name', () => {
  it('no middle, and a blank middle, both print "Santos, Maria" with no trailing " ."', () => {
    // Kills: trailing " ." / ", Maria ." for a missing middle.
    expect(fmt('Santos', 'Maria')).toBe('Santos, Maria');
    expect(fmt('Santos', 'Maria', '   ')).toBe('Santos, Maria');
    expect(fmt('Santos', 'Maria', null)).toBe('Santos, Maria');
  });
  it('a blank middle normalises to nothing (stored as NULL, never the empty string)', () => {
    // Kills: '' stored. The part is empty-ish (null or ''); the DB-level proof that NULL is stored is domain case H1b.
    expect(normaliseNamePart('   ') || null).toBeNull();
  });
});

describe('T-438 U3 - trim and collapse', () => {
  it("'  Dela   Cruz ' -> 'Dela Cruz'", () => {
    // Kills: no trim; no inner-space collapse.
    expect(normaliseNamePart('  Dela   Cruz ')).toBe('Dela Cruz');
    expect(fmt('  Dela   Cruz ', ' Juan   Miguel ', ' santos ')).toBe('Dela Cruz, Juan Miguel S.');
  });
});

describe('T-438 U4 - nameKey', () => {
  it('"Santos, Maria C." = "Maria Santos" = last santos / first MARIA', () => {
    // Kills: initial not dropped (key keeps "c"); order-sensitive key; case-sensitive key.
    const typed = nameKey('santos MARIA');
    expect(nameKey('Santos, Maria C.')).toBe(typed);
    expect(nameKey('Maria Santos')).toBe(typed);
    expect(nameKey('SANTOS,   maria')).toBe(typed);
  });
  it('different people do not collide, and punctuation is ignored', () => {
    expect(nameKey('Santos, Maria')).not.toBe(nameKey('Santos, Marie'));
    expect(nameKey('Santos, Maria')).not.toBe(nameKey('Reyes, Maria'));
    expect(nameKey("De la Cruz, Ma. Clara")).toBe(nameKey('de la cruz ma clara'));
  });
});
