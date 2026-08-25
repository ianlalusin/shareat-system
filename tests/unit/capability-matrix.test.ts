import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  CONDITIONAL_CAPABILITIES,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  ROLES,
  type Capability,
} from '../../packages/auth/src/capabilities';

/**
 * docs/tasks/121-roles-and-access.md Contract §3 invariants 1-3 — no database.
 *
 * `docs/decisions/CAPABILITY-MATRIX.md` IS the decision; `packages/auth/src/capabilities.ts`
 * is the enforcement. Invariant 3 requires the two to match "exactly — parsed, not
 * hand-compared", so this file PARSES the markdown table with a regex rather than trusting
 * a human transcription (including this test's own author's) to have gotten all 38 rows
 * right by eye.
 *
 * Invariants 1 and 2 ("every capability has an explicit decision for all four roles" /
 * "a capability added without decisions fails to compile or fails the test") are primarily
 * a TYPE-level guarantee: `CAPABILITY_MATRIX` and `CAPABILITY_SCOPE` are both typed as
 * `Record<Capability, ...>`, so TypeScript itself refuses to compile a `Capability` union
 * member missing from either object. The task report documents a deliberate probe of that
 * (temporarily removing a capability's matrix entry, capturing the real `tsc` error, then
 * reverting) — a compile-time guard is not something a vitest run can demonstrate directly.
 * This file's job is the complementary runtime proof: that the compiled object's CONTENT,
 * not just its shape, agrees with the document.
 */

const DOC_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'docs', 'decisions', 'CAPABILITY-MATRIX.md');

interface DocRow {
  capability: string;
  scope: string;
  cells: [boolean, boolean, boolean, boolean]; // super, admin, manager, staff
  conditionalManager: boolean;
}

/**
 * Parses every capability row out of CAPABILITY-MATRIX.md. Deliberately tolerant of the
 * document's own formatting quirks (a leading ⚠️, a bold **org** or **conditional**, a
 * trailing "(direct)" on one capability name) rather than requiring the document to be
 * reformatted for the parser's convenience — the document is the decision; this adapts to
 * it, not the other way round.
 */
function parseCapabilityMatrixDoc(): DocRow[] {
  const raw = readFileSync(DOC_PATH, 'utf8');
  // Strip markdown bold globally first — it only ever wraps a single cell's content in
  // this document (a scope like **org**, or **conditional**), never spans a cell
  // boundary, so this is safe and turns every cell into plain text.
  const stripped = raw.replace(/\*\*/g, '');

  const VALID_SCOPES = new Set(['store', 'org', 'platform']);
  const rows: DocRow[] = [];
  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const capMatch = trimmed.match(/^\|\s*(?:⚠️\s*)?`([a-z_]+)`/);
    if (!capMatch) continue; // not a row that OPENS with a backtick-quoted name — the
    // document has other tables further down (§B) with backticks elsewhere in the row
    // (e.g. `select`, `isAdmin()`) that must not be mistaken for a capability row.

    const cells = trimmed.split('|').map((c) => c.trim());
    // cells[0] = '' (before the leading pipe), cells[1] = capability cell, cells[2] = scope,
    // cells[3..6] = super/admin/manager/staff, cells[7] = notes.
    const scope = cells[2];
    const roleCells = [cells[3], cells[4], cells[5], cells[6]];
    if (scope === undefined || !VALID_SCOPES.has(scope) || roleCells.some((c) => c === undefined)) {
      // Not one of the 9 capability tables (e.g. the "How to read this" or "§B" prose
      // tables) — skip rather than throw, since only a row that OPENS with a
      // backtick-quoted capability name AND has an unrecognised scope truly indicates a
      // parser bug worth failing loudly on, and none of the document's other tables do.
      continue;
    }

    let conditionalManager = false;
    const toBool = (cell: string, roleLabel: string): boolean => {
      if (cell === '✅') return true;
      if (cell === '✗') return false;
      if (cell === 'conditional') {
        conditionalManager = true;
        // The document's own baseline: a manager CAN close (bible row 101), subject to
        // the extra store-scope condition CAPABILITY-MATRIX.md §Open 2 describes — see
        // packages/auth/src/capabilities.ts's CONDITIONAL_CAPABILITIES comment.
        return true;
      }
      throw new Error(`capability-matrix.test.ts parser: unrecognised ${roleLabel} cell '${cell}' for '${capMatch[1]}'`);
    };

    rows.push({
      capability: capMatch[1]!,
      scope,
      cells: [
        toBool(roleCells[0]!, 'super'),
        toBool(roleCells[1]!, 'admin'),
        toBool(roleCells[2]!, 'manager'),
        toBool(roleCells[3]!, 'staff'),
      ],
      conditionalManager,
    });
  }
  return rows;
}

describe('CAPABILITY-MATRIX.md parses to the expected shape', () => {
  it('finds capability rows at all', () => {
    // Sanity floor — an enumeration that silently found nothing would make every
    // assertion below pass vacuously, which invariant 3 exists specifically to prevent.
    const rows = parseCapabilityMatrixDoc();
    expect(rows.length).toBeGreaterThan(5);
  });

  it('finds exactly 38 capability rows — NOT the "36" the task documents say in prose', () => {
    // docs/tasks/121-roles-and-access.md and CAPABILITY-MATRIX.md's own Contract section
    // both say "36 rows" / "36 capabilities". The table itself has 38: the two
    // ⚠️-flagged open cells (set_credit_limit, close_period) plus the two platform-only
    // rows (cross_org_access, view_franchise_sales) bring the true count to 38. This is
    // reported as a spec defect in the task report, not silently corrected in prose —
    // this test pins the ACTUAL count so a future edit to the document that changes it
    // is caught rather than re-drifting unnoticed.
    const rows = parseCapabilityMatrixDoc();
    expect(rows.length).toBe(38);
  });

  it('has no duplicate capability names', () => {
    const rows = parseCapabilityMatrixDoc();
    const names = rows.map((r) => r.capability);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('invariant 3 — the typed matrix matches CAPABILITY-MATRIX.md exactly, parsed not hand-compared', () => {
  const rows = parseCapabilityMatrixDoc();
  const byName = new Map(rows.map((r) => [r.capability, r]));

  it('every row in the document exists in the typed Capability union', () => {
    const missing = rows.map((r) => r.capability).filter((c) => !CAPABILITIES.includes(c as Capability));
    expect(missing, `In the document but not in capabilities.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('every Capability in the typed union exists in the document', () => {
    const extra = CAPABILITIES.filter((c) => !byName.has(c));
    expect(extra, `In capabilities.ts but not the document: ${extra.join(', ')}`).toEqual([]);
  });

  it.each(CAPABILITIES)('%s — scope matches the document', (capability) => {
    const docRow = byName.get(capability);
    expect(docRow, `${capability} missing from the document`).toBeDefined();
    expect(CAPABILITY_SCOPE[capability]).toBe(docRow!.scope);
  });

  it.each(CAPABILITIES)('%s — all four role cells match the document', (capability) => {
    const docRow = byName.get(capability);
    expect(docRow, `${capability} missing from the document`).toBeDefined();
    const [docSuper, docAdmin, docManager, docStaff] = docRow!.cells;
    expect(CAPABILITY_MATRIX[capability]).toEqual({
      super_admin: docSuper,
      admin: docAdmin,
      manager: docManager,
      staff: docStaff,
    });
  });

  it('the document\'s "conditional" cells are exactly CONDITIONAL_CAPABILITIES', () => {
    const docConditional = rows.filter((r) => r.conditionalManager).map((r) => r.capability).sort();
    expect(docConditional).toEqual([...CONDITIONAL_CAPABILITIES].sort());
    // Pinned to the one capability the document currently flags this way, so a second
    // conditional cell appearing later is a deliberate, reviewed addition rather than a
    // silent parser pass-through.
    expect(docConditional).toEqual(['close_period']);
  });
});

describe('invariant 1 — every capability has an explicit decision for all four roles', () => {
  it('every capability has a boolean (never undefined) for every role', () => {
    const problems: string[] = [];
    for (const capability of CAPABILITIES) {
      for (const role of ROLES) {
        const value = CAPABILITY_MATRIX[capability][role];
        if (typeof value !== 'boolean') {
          problems.push(`${capability}.${role} is ${String(value)}, not a boolean`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every capability has a declared scope', () => {
    const problems = CAPABILITIES.filter((c) => !['store', 'org', 'platform'].includes(CAPABILITY_SCOPE[c]));
    expect(problems).toEqual([]);
  });

  it('CAPABILITIES, CAPABILITY_MATRIX and CAPABILITY_SCOPE all enumerate the same 38 capabilities', () => {
    expect(CAPABILITIES.length).toBe(38);
    expect(Object.keys(CAPABILITY_MATRIX).length).toBe(38);
    expect(Object.keys(CAPABILITY_SCOPE).length).toBe(38);
    expect(new Set(Object.keys(CAPABILITY_MATRIX))).toEqual(new Set(CAPABILITIES));
    expect(new Set(Object.keys(CAPABILITY_SCOPE))).toEqual(new Set(CAPABILITIES));
  });
});

describe('role hierarchy sanity — authority strictly nests (CAPABILITY-MATRIX.md "How to read this")', () => {
  // "Each role strictly contains the one below it in AUTHORITY" — every capability a
  // lower role holds, the role above it also holds. NOT true of scope (that is the whole
  // point of store scoping existing at all), only of the matrix's role column itself.
  it('super_admin holds every capability admin holds', () => {
    const gaps = CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].admin && !CAPABILITY_MATRIX[c].super_admin);
    expect(gaps).toEqual([]);
  });

  it('admin holds every capability manager holds', () => {
    const gaps = CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].manager && !CAPABILITY_MATRIX[c].admin);
    expect(gaps).toEqual([]);
  });

  it('manager holds every capability staff holds', () => {
    const gaps = CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].staff && !CAPABILITY_MATRIX[c].manager);
    expect(gaps).toEqual([]);
  });
});

describe('ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER — derived, not hand-listed', () => {
  it('is exactly the admin-minus-manager delta of the matrix', () => {
    const expected = CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].admin && !CAPABILITY_MATRIX[c].manager).sort();
    expect([...ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER].sort()).toEqual(expected);
  });

  it('matches the specific set the task report and CAPABILITY-MATRIX.md §B.1 name', () => {
    // manage_users is called out by name in §B.1 as one of the capabilities the fallback
    // must cover — pinned here so a matrix edit that accidentally drops it is caught.
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).toContain('manage_users' satisfies Capability);
    expect([...ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER].sort()).toEqual(
      [
        'set_credit_limit',
        'view_trial_balance',
        'manage_users',
        'grant_capability',
        'manage_price_lists',
        'manage_fixed_assets',
        'run_depreciation',
        'manage_chart_of_accounts',
      ].sort(),
    );
  });

  it('excludes capabilities admin itself lacks (post_journal_entry, cross_org_access, view_franchise_sales)', () => {
    for (const c of ['post_journal_entry', 'cross_org_access', 'view_franchise_sales'] satisfies Capability[]) {
      expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).not.toContain(c);
    }
  });
});
