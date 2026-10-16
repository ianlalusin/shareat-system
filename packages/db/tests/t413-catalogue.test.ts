import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Pure module (no db import): runs before any migration.
import { AUDIT_CATALOGUE, catalogueEntry, catalogueProblems } from '../src/audit/catalogue';

/**
 * T-413 S1 - R5: the four recipe audit actions are in the closed catalogue (docs/tasks/413-production-recipe-admin.md).
 * category stock, sensitivity normal, scope org, entity production_recipes, owner T-413, not reserved (a writer exists).
 * Red today: the four entries are missing. Mutants: an action misspelt; wrong category; scope store; entity wrong; reserved.
 */
const ACTIONS = ['production.recipe_create', 'production.recipe_edit', 'production.recipe_retire', 'production.recipe_restore'] as const;
const ROOT = join(__dirname, '..', '..', '..');

describe('the four production.recipe_* entries', () => {
  for (const action of ACTIONS) {
    it(`${action} is catalogued with the R5 shape`, () => {
      const e = catalogueEntry(action);
      expect(e, `${action} is not in AUDIT_CATALOGUE`).toBeDefined();
      expect(e).toMatchObject({ action, category: 'stock', sensitivity: 'normal', scope: 'org', entity: 'production_recipes', owner: 'T-413', reserved: false });
    });
  }
  it('no duplicates, exactly the four, and the catalogue guard is clean for them when each has a writer', () => {
    const mine = AUDIT_CATALOGUE.filter((e) => e.action.startsWith('production.recipe_')).map((e) => e.action).sort();
    expect(mine).toEqual([...ACTIONS].sort());
    const problems = catalogueProblems(AUDIT_CATALOGUE.filter((e) => e.action.startsWith('production.recipe_')), new Set(ACTIONS));
    expect(problems).toEqual([]);
  });
  it('the guard names a recipe action with no writer (so an unwritten entry cannot sit there)', () => {
    const mine = AUDIT_CATALOGUE.filter((e) => e.action.startsWith('production.recipe_'));
    expect(mine.length, 'entries missing').toBe(4);
    const problems = catalogueProblems(mine, new Set(ACTIONS.slice(0, 3)));
    expect(problems.join('\n')).toContain('production.recipe_restore');
  });
});

describe('each action has a writer in the domain (a literal in a production source file)', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.ts$/.test(n)) out.push(p);
    }
    return out;
  }
  it('packages/domain/src/production contains all four action strings', () => {
    const text = walk(join(ROOT, 'packages', 'domain', 'src', 'production')).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const a of ACTIONS) expect(text.includes(`'${a}'`), `${a} is never written`).toBe(true);
  });
});
