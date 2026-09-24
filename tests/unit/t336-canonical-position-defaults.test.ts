import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  ROLES,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  type Capability,
} from '@shareat/auth';
import { CANONICAL_POSITIONS } from '@shareat/db/schema';
import { CANONICAL_POSITION_DEFAULTS, OFFERABLE_TO_POSITIONS } from '@shareat/domain';
import { EVERYDAY_CAPABILITIES } from '../../packages/domain/tests/integration/_fixtures/staff-everyday-access';

/**
 * T-336 — U1, U2, U3. `docs/tasks/336-per-position-access-defaults.md` §8, ruled by
 * `docs/decisions/PROPOSAL-DEF-413-default-position-capabilities.md` + its Amendment (2026-09-24).
 */

// -------------------------------------------------------------------------------------
// U1 — the constant is exactly the ruling: 38 rows, Server/Dishwasher = {F1, F3}.
// -------------------------------------------------------------------------------------

/**
 * ⛔ Independent oracle, typed out from the PROPOSAL's table + its Amendment — NOT built from
 * `CANONICAL_POSITION_DEFAULTS` itself (`access-defaults-lib.test.ts:21-27`'s own rule: a test
 * that imports the constant to build its own expectation only proves the grid equals itself).
 * Amendment 2026-09-24: Server and Dishwasher each gain F1 (record_stock_movement) — 1 -> 2 rows,
 * total 36 -> 38.
 */
const ORACLE: Readonly<Record<(typeof CANONICAL_POSITIONS)[number], readonly Capability[]>> = {
  Cashier: [
    'record_sale',
    'submit_sales_day',
    'record_statutory_discount',
    'record_till_count',
    'create_expense',
    'edit_own_expense',
    'record_order_wastage',
    'record_supplier_invoice',
    'receive_delivery',
    'confirm_receipt',
    'record_supplier_return',
    'place_branch_order',
    'fulfil_branch_order',
    'post_order_message',
    'set_item_threshold',
    'record_stock_movement',
    'transfer_stock',
    'record_wastage',
  ],
  Cook: ['record_stock_movement', 'record_wastage'],
  Server: ['record_stock_movement', 'record_wastage'],
  Dishwasher: ['record_stock_movement', 'record_wastage'],
  Slicer: ['record_stock_movement', 'record_wastage', 'request_pos_map'],
  'Inventory Staff': [
    'receive_delivery',
    'confirm_receipt',
    'record_supplier_return',
    'place_branch_order',
    'fulfil_branch_order',
    'post_order_message',
    'set_item_threshold',
    'record_stock_movement',
    'transfer_stock',
    'record_wastage',
    'request_pos_map',
  ],
};

const sortedEntries = (rec: Readonly<Record<string, readonly Capability[]>>) =>
  Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, [...v].sort()]));

describe('U1 — CANONICAL_POSITION_DEFAULTS is exactly the ruling (38 rows total)', () => {
  it('matches the independent oracle exactly, values sorted, keys the six canonical names', () => {
    expect(Object.keys(CANONICAL_POSITION_DEFAULTS).sort()).toEqual([...CANONICAL_POSITIONS].sort());
    expect(sortedEntries(CANONICAL_POSITION_DEFAULTS)).toEqual(sortedEntries(ORACLE));
  });

  it('the total is 38 (Amendment: Server and Dishwasher each gained F1, 36 -> 38)', () => {
    const total = Object.values(ORACLE).reduce((sum, caps) => sum + caps.length, 0);
    expect(total).toBe(38);
  });

  it('Server and Dishwasher are exactly {record_stock_movement, record_wastage} — the Amendment, not the original proposal', () => {
    expect([...CANONICAL_POSITION_DEFAULTS.Server].sort()).toEqual(['record_stock_movement', 'record_wastage'].sort());
    expect([...CANONICAL_POSITION_DEFAULTS.Dishwasher].sort()).toEqual(['record_stock_movement', 'record_wastage'].sort());
  });

  it('every value is a subset of EVERYDAY_CAPABILITIES (the 21 T-318 moved off the matrix)', () => {
    for (const [name, caps] of Object.entries(CANONICAL_POSITION_DEFAULTS)) {
      for (const c of caps) {
        expect(EVERYDAY_CAPABILITIES, `${name}: "${c}" is not one of the 21 everyday capabilities`).toContain(c);
      }
    }
  });

  it('every value is a subset of OFFERABLE_TO_POSITIONS', () => {
    for (const [name, caps] of Object.entries(CANONICAL_POSITION_DEFAULTS)) {
      for (const c of caps) {
        expect(OFFERABLE_TO_POSITIONS, `${name}: "${c}" is not offerable to a position`).toContain(c);
      }
    }
  });

  it('NEGATIVE: no value intersects SUPER_ADMIN_ONLY_CAPABILITIES, and close_period is absent from all six', () => {
    for (const [name, caps] of Object.entries(CANONICAL_POSITION_DEFAULTS)) {
      for (const c of caps) {
        expect(SUPER_ADMIN_ONLY_CAPABILITIES, `${name} should never default a super-admin-only capability`).not.toContain(c);
        expect(c, `${name} should never default close_period`).not.toBe('close_period');
      }
    }
  });

  it('mutation check: a Cashier row copying 0152 (all 21) would fail the oracle match', () => {
    const mutant = { ...sortedEntries(CANONICAL_POSITION_DEFAULTS), Cashier: [...EVERYDAY_CAPABILITIES].sort() };
    expect(mutant).not.toEqual(sortedEntries(ORACLE));
  });
});

// -------------------------------------------------------------------------------------
// U2 — seeding never outruns its actor: every manage_stores role also holds grant_capability.
// -------------------------------------------------------------------------------------

describe('U2 — seeding never outruns its actor', () => {
  it('every role holding manage_stores also holds grant_capability', () => {
    const rolesWithManageStores = ROLES.filter((r) => CAPABILITY_MATRIX.manage_stores[r]);
    expect(rolesWithManageStores.length).toBeGreaterThan(0); // non-zero control
    for (const role of rolesWithManageStores) {
      expect(CAPABILITY_MATRIX.grant_capability[role], `${role} holds manage_stores but not grant_capability`).toBe(true);
    }
  });

  it('mutation check: a matrix where manager holds manage_stores but not grant_capability is caught', () => {
    const mutantMatrix = {
      ...CAPABILITY_MATRIX,
      manage_stores: { ...CAPABILITY_MATRIX.manage_stores, manager: true },
      grant_capability: { ...CAPABILITY_MATRIX.grant_capability, manager: false },
    };
    const rolesWithManageStores = ROLES.filter((r) => mutantMatrix.manage_stores[r]);
    const offenders = rolesWithManageStores.filter((r) => !mutantMatrix.grant_capability[r]);
    expect(offenders).toContain('manager');
  });
});

// -------------------------------------------------------------------------------------
// U3 — seedStoreAccessDefaults has exactly one non-test caller: stores/service.ts.
// -------------------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '..', '..');
const REQUIRED_CALLERS = ['packages/domain/src/stores/service.ts'] as const;
const DEFINER_FILES: readonly string[] = ['packages/domain/src/people/position-defaults.ts'];
// §7:135 of the task spec requires this barrel re-export (`@shareat/domain` consumers, e.g. this
// repo's own grid test, import CANONICAL_POSITION_DEFAULTS/seedStoreAccessDefaults from here).
// U3's own stated reason (spec line 160, mutation example "a second caller, e.g. reactivateStore
// or a script over existing stores") is about an extra CALLER, not this re-export — so it is
// exempted from the import/re-export check below, but still scanned for an actual call.
const REQUIRED_REEXPORTERS: readonly string[] = ['packages/domain/src/people/index.ts'];
const SCAN_ROOTS = [
  'apps',
  'scripts',
  'packages/auth/src',
  'packages/core/src',
  'packages/db/src',
  'packages/domain/src',
  'packages/etl/src',
  'packages/etl-firestore/src',
  'packages/storage-firebase/src',
  'packages/sync-firestore/src',
] as const;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f.length > 0);
}

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function readRepoFile(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

// Same fix as T-335's U1 (audit round 2, finding 1): allows an optional namespaced-call prefix,
// so `positionDefaults.seedStoreAccessDefaults(` — or a bare call — both match, while a longer
// identifier merely ending in the name does not.
const CALL_RE = String.raw`(^|[^A-Za-z0-9_'"\`])(?:\w+\.)?seedStoreAccessDefaults\s*\(`;

function callsSeed(code: string): boolean {
  return new RegExp(CALL_RE).test(code);
}
function countSeedCalls(code: string): number {
  return (code.match(new RegExp(CALL_RE, 'g')) ?? []).length;
}

function reachesSeed(content: string, opts: { allowReexport: boolean } = { allowReexport: false }): string[] {
  const how: string[] = [];
  const code = codeOnly(content);
  if (!opts.allowReexport) {
    const named = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gs;
    for (const m of code.matchAll(named)) {
      if (new RegExp(String.raw`(^|[,\s])seedStoreAccessDefaults(\s+as\s+\w+)?\s*(,|$)`).test(m[1]!)) {
        how.push('imports/re-exports seedStoreAccessDefaults (named, with `from`)');
      }
    }
    const bare = /\bexport\s*\{([^}]*)\}\s*;/g;
    for (const m of code.matchAll(bare)) {
      if (new RegExp(String.raw`(^|[,\s])seedStoreAccessDefaults\s*(,|$)`).test(m[1]!)) {
        how.push('re-exports seedStoreAccessDefaults (bare, no `from`)');
      }
    }
  }
  if (callsSeed(code)) how.push('calls seedStoreAccessDefaults()');
  return [...new Set(how)];
}

describe('U3 — seedStoreAccessDefaults() has a closed, named caller list of exactly one', () => {
  it('the required caller is a real tracked file', () => {
    const files = trackedFiles();
    for (const rel of REQUIRED_CALLERS) {
      expect(files.includes(rel), `required caller "${rel}" is not a tracked file`).toBe(true);
    }
  });

  it('the required caller contains at least one call — not vacuously zero', () => {
    for (const rel of REQUIRED_CALLERS) {
      expect(countSeedCalls(codeOnly(readRepoFile(rel))), `${rel} was expected to call seedStoreAccessDefaults( at least once`).toBeGreaterThanOrEqual(1);
    }
  });

  it('the required re-exporter (§7:135) actually re-exports it — not vacuously satisfied', () => {
    for (const rel of REQUIRED_REEXPORTERS) {
      const how = reachesSeed(readRepoFile(rel));
      expect(how.some((h) => h.includes('re-exports')), `${rel} was expected to re-export seedStoreAccessDefaults`).toBe(true);
    }
  });

  it('⭐ the scanned set is non-empty', () => {
    const files = trackedFiles().filter(
      (f) =>
        SCAN_ROOTS.some((root) => f === root || f.startsWith(`${root}/`)) &&
        (f.endsWith('.ts') || f.endsWith('.tsx')) &&
        !f.includes('/tests/') &&
        !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(50);
  });

  it('no file outside the closed list calls seedStoreAccessDefaults, or imports/re-exports it outside the one required re-export (§7:135) — e.g. reactivateStore or a script over existing stores', () => {
    const scanned = trackedFiles().filter(
      (f) =>
        SCAN_ROOTS.some((root) => f === root || f.startsWith(`${root}/`)) &&
        (f.endsWith('.ts') || f.endsWith('.tsx')) &&
        !f.includes('/tests/') &&
        !f.endsWith('.test.ts') &&
        !DEFINER_FILES.includes(f) &&
        !(REQUIRED_CALLERS as readonly string[]).includes(f),
    );
    const offenders: string[] = [];
    for (const rel of scanned) {
      let content: string;
      try {
        content = readRepoFile(rel);
      } catch {
        continue;
      }
      const how = reachesSeed(content, { allowReexport: REQUIRED_REEXPORTERS.includes(rel) });
      if (how.length > 0) offenders.push(`${rel} — ${how.join(' and ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
