/**
 * T-593 / DEF-874 - the owners repo turns the ledger's numeric text into money with `@shareat/core/money`, never `Number(...)` / `toFixed(...)`.
 * No behaviour test can tell the difference (toFixed rounds a float drift away), so this scans the source: the only `Number(` left is the day
 * count of `agedReceivables` (`daysOutstanding`, a whole number of days, not money).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './lib/document-facts';

const code = codeOnly(readFileSync(join(__dirname, '..', '..', 'packages', 'db', 'src', 'repo', 'owners.ts'), 'utf8'));

describe('T-593 DEF-874 - no float money in the owners repo', () => {
  it('has no toFixed( at all', () => {
    expect(code.match(/toFixed\(/g) ?? []).toEqual([]);
  });

  it('has no Number( except the daysOutstanding day count', () => {
    const lines = code.split('\n').filter((l) => /\bNumber\(/.test(l));
    expect(lines.map((l) => l.trim())).toEqual(['daysOutstanding: Number(r.days_outstanding ?? r.daysOutstanding ?? 0),']);
  });
});
