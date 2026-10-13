import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_AREA, CAPABILITY_AREAS, CAPABILITY_LABEL, CAPABILITY_MATRIX, CAPABILITY_SCOPE, type Capability } from '../src/capabilities';

/**
 * T-402 S1b, R8 - the two new capabilities, cell by cell, pinned by hand (the matrix test only proves code = document;
 * a wrong cell written into BOTH would pass it). docs/tasks/402-activity-log.md R8, Invariant 24 (every check mark has
 * its refusal test: the DB-backed refusals are in t402-s1b-capability-authorize.test.ts).
 *   view_activity_log             store  super ok  admin ok  manager ok  staff NO
 *   view_activity_log_restricted  org    super ok  admin ok  manager NO  staff NO
 * Red today: neither exists, so every lookup is undefined and the Capability type does not include them (tsc).
 */
type Cell = { scope: 'org' | 'store'; super_admin: boolean; admin: boolean; manager: boolean; staff: boolean; killsMutant: string };
const CELLS: Record<string, Cell> = {
  view_activity_log: { scope: 'store', super_admin: true, admin: true, manager: true, staff: false, killsMutant: 'scope org (a manager would then read every store); staff allowed' },
  view_activity_log_restricted: { scope: 'org', super_admin: true, admin: true, manager: false, staff: false, killsMutant: 'manager allowed (managers would see grants, credential changes, exports and denials)' },
};

describe('T-402 S1b / R8 - the two activity-log capabilities, cell by cell', () => {
  for (const [cap, want] of Object.entries(CELLS)) {
    it(`${cap}: scope ${want.scope}; super ${want.super_admin} admin ${want.admin} manager ${want.manager} staff ${want.staff}. Mutant: ${want.killsMutant}`, () => {
      const row = (CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>)[cap];
      expect(row, `${cap} is not in CAPABILITY_MATRIX`).toBeDefined();
      expect(row).toEqual({ super_admin: want.super_admin, admin: want.admin, manager: want.manager, staff: want.staff });
      expect((CAPABILITY_SCOPE as Record<string, string | undefined>)[cap]).toBe(want.scope);
      expect((CAPABILITIES as readonly string[]).includes(cap), `${cap} listed in CAPABILITIES`).toBe(true);
      expect(CAPABILITY_AREAS as readonly string[], `${cap} has an area`).toContain((CAPABILITY_AREA as Record<string, string | undefined>)[cap]);
      expect(((CAPABILITY_LABEL as Record<string, string | undefined>)[cap] ?? '').length, `${cap} has a label`).toBeGreaterThan(3);
    });
  }

  it('the restricted capability is strictly narrower than the plain one: nobody holds it who lacks the plain one', () => {
    const m = CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>;
    for (const role of ['super_admin', 'admin', 'manager', 'staff']) {
      if (m.view_activity_log_restricted?.[role]) expect(m.view_activity_log?.[role], role).toBe(true);
    }
  });

  it('CAPABILITY-MATRIX.md carries both rows with the same scope and cells', () => {
    const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'decisions', 'CAPABILITY-MATRIX.md'), 'utf8');
    const rowOf = (cap: string) => doc.split('\n').find((l) => l.startsWith(`| \`${cap}\``));
    const plain = rowOf('view_activity_log');
    const restricted = rowOf('view_activity_log_restricted');
    expect(plain, 'row for view_activity_log').toBeDefined();
    expect(restricted, 'row for view_activity_log_restricted').toBeDefined();
    const cells = (l: string) => l.split('|').map((c) => c.trim()).slice(2, 7);
    expect(cells(plain!)).toEqual(['store', '✅', '✅', '✅', '✗']);
    expect(cells(restricted!)).toEqual(['org', '✅', '✅', '✗', '✗']);
  });

  it('type check: the two names are Capability members (compile-time; fails tsc until the builder adds them)', () => {
    const names: Capability[] = ['view_activity_log', 'view_activity_log_restricted'];
    expect(names).toHaveLength(2);
  });
});
