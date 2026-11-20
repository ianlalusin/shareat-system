/**
 * T-598 S4 -- DEF-449: the "Jan 10, 2027" wording of a refusal or finding date is written once, in core.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mediumBusinessDate, parseBusinessDate } from '@shareat/core/datetime';
import { humanDate } from '../../packages/domain/src/shared/refusal-leaf';

const ROOT = join(__dirname, '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'tests') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('mediumBusinessDate', () => {
  it('says Jan 10, 2027, and humanDate says the same', () => {
    const d = parseBusinessDate('2027-01-10');
    expect(mediumBusinessDate(d)).toBe('Jan 10, 2027');
    expect(humanDate(d)).toBe(mediumBusinessDate(d));
  });

  it('is the only place that spells the medium-date formatter out (no second copy to drift)', () => {
    const copy = /businessDayRange\([^)]*\)\.start,\s*\{\s*dateStyle:\s*'medium'\s*\}/;
    const offenders = ['packages/core/src', 'packages/db/src', 'packages/domain/src', 'apps/erp/src']
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) => copy.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).replace(/\\/g, '/'));
    expect(offenders).toEqual(['packages/core/src/datetime.ts']);
  });
});
