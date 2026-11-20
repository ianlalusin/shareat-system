/**
 * T-598 S7 / DEF-411: `manilaToday` names ONE clock (the database's, `packages/db/src/repo/sql-time.ts`).
 * The two recurring-expense helpers read the process clock and are called `manilaTodayFromClock`, so an editor cannot mix them up.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('DEF-411: one definition of manilaToday', () => {
  it('only packages/db/src/repo/sql-time.ts defines a function with that name', () => {
    const def = /\b(?:async\s+)?function\s+manilaToday\s*\(/;
    const definers = ['packages', 'apps']
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) => def.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).replace(/\\/g, '/'));
    expect(definers).toEqual(['packages/db/src/repo/sql-time.ts']);
  });
});
