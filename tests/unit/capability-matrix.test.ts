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
 * a human transcription (including this test's own author's) to have gotten all 41 rows
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
function parseCapabilityMatrixDoc(): { rows: DocRow[]; unparsed: string[] } {
  const unparsed: string[] = [];
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
    let rowUnparsed = false;
    const toBool = (cell: string, roleLabel: string): boolean => {
      if (cell === '✅') return true;
      if (cell === '✗') return false;
      if (cell === 'conditional') {
        conditionalManager = true;
        // The document's own baseline: a manager CAN close (bible row 101), subject to
        // the extra store-scope condition described in the notes column — see
        // packages/auth/src/capabilities.ts's CONDITIONAL_CAPABILITIES comment.
        return true;
      }
      // DEF-056: this used to THROW, and a throw here aborts the whole file before any
      // assertion runs — so one prose cell ("✅ only with ORG-WIDE store scope") silently
      // disabled every check in the suite whose entire job is catching document-vs-code
      // drift, and a real drift went unnoticed underneath it. Record and continue: the
      // offending row is reported as a named assertion failure below, and because the row
      // is DROPPED, the "exactly 38 rows" check fails too. **Two loud signals instead of
      // one silent one.**
      unparsed.push(`${capMatch[1]} — ${roleLabel} cell '${cell}' is not ✅, ✗ or conditional`);
      rowUnparsed = true;
      return false;
    };

    const parsed: DocRow = {
      capability: capMatch[1]!,
      scope,
      cells: [
        toBool(roleCells[0]!, 'super'),
        toBool(roleCells[1]!, 'admin'),
        toBool(roleCells[2]!, 'manager'),
        toBool(roleCells[3]!, 'staff'),
      ],
      conditionalManager,
    };
    // A row whose cells could not be read is NOT pushed — a guessed boolean would be worse
    // than a missing row, because the comparison tests would then "pass" against a value
    // nobody wrote.
    if (!rowUnparsed) rows.push(parsed);
  }
  return { rows, unparsed };
}

describe('CAPABILITY-MATRIX.md parses to the expected shape', () => {
  it('every role cell is a closed enum — ✅, ✗ or conditional, never prose (DEF-056)', () => {
    // The role columns are MACHINE-READABLE. A cell like "✅ only with org-wide scope" reads
    // fine to a human and is unreadable here — and when this parser threw on one, the throw
    // took the whole file down and hid a genuine document-vs-code drift underneath it.
    // Conditions belong in the NOTES column; the cell stays an enum.
    const { unparsed } = parseCapabilityMatrixDoc();
    expect(
      unparsed,
      unparsed.length === 0
        ? ''
        : `Unreadable role cells in CAPABILITY-MATRIX.md:\n  ${unparsed.join('\n  ')}\n\n` +
            'Role cells must be exactly ✅, ✗ or conditional. Put the condition in the notes ' +
            'column instead — see packages/auth/src/capabilities.ts CONDITIONAL_CAPABILITIES.',
    ).toEqual([]);
  });

  it('finds capability rows at all', () => {
    // Sanity floor — an enumeration that silently found nothing would make every
    // assertion below pass vacuously, which invariant 3 exists specifically to prevent.
    const { rows } = parseCapabilityMatrixDoc();
    expect(rows.length).toBeGreaterThan(5);
  });

  // ⭐ 41 -> 42 on 2026-08-28 (T-134): `run_cutover`. ORG-scoped, held by manager and up. This
  // count is a PIN, so adding a capability is a deliberate act - which is exactly why it caught
  // this one before the matrix doc had a row for it.
  //
  // ⭐ 48 -> 49 on 2026-08-29 (T-152): `set_cash_policy`. STORE-scoped, admin and up, and
  // deliberately NOT manager — Ian: "configurable by admin". It is separate from
  // `manage_store_settings` because a manager must not be able to raise the ceiling their own
  // cash custody is measured against.
  // ⭐ 49 -> 50 on 2026-08-30, at the attendance merge: `set_cash_policy` (T-152, main) and
  // `provision_clock_terminal` (T-185, attendance lane) were added independently on two branches.
  // ⚠️ The merged total is the sum, not either side's number — resolving this conflict by taking
  // one side would leave a GREEN test asserting a count the code does not have.
  // ⭐ 50 -> 52 on 2026-08-30, at the T-137 merge: `record_statutory_discount` and
  // `void_statutory_discount`. Third independent addition in two days, on a third branch — the
  // count is the SUM of every lane's, never the last one to merge.
  it('finds exactly 52 capability rows — NOT the "36" the task documents say in prose', () => {
    // docs/tasks/121-roles-and-access.md and CAPABILITY-MATRIX.md's own Contract section
    // both say "36 rows" / "36 capabilities". The table itself had 38: the two
    // ⚠️-flagged open cells (set_credit_limit, close_period) plus the two platform-only
    // rows (cross_org_access, view_franchise_sales) brought the true count to 38. This is
    // reported as a spec defect in the task report, not silently corrected in prose —
    // this test pins the ACTUAL count so a future edit to the document that changes it
    // is caught rather than re-drifting unnoticed.
    //
    // ⭐ 39 since bible row 150 added `transfer_funds`, 41 since T-125 added
    // `manage_prepaid_items` and `run_amortisation`, 44 since T-130 added
    // `record_supplier_invoice`, `verify_supplier_invoice` and `void_supplier_invoice`,
    // 50 since T-137 added `record_statutory_discount` and `void_statutory_discount`.
    // Having to edit this number is the guard WORKING: a capability cannot be slipped
    // into the enforcement without also being written into the document people actually
    // read, and vice versa.
    const { rows } = parseCapabilityMatrixDoc();
    expect(rows.length).toBe(52);
  });

  it('has no duplicate capability names', () => {
    const { rows } = parseCapabilityMatrixDoc();
    const names = rows.map((r) => r.capability);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('invariant 3 — the typed matrix matches CAPABILITY-MATRIX.md exactly, parsed not hand-compared', () => {
  const { rows } = parseCapabilityMatrixDoc();
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

  it('CAPABILITIES, CAPABILITY_MATRIX and CAPABILITY_SCOPE all enumerate the same 52 capabilities', () => {
    expect(CAPABILITIES.length).toBe(52);
    expect(Object.keys(CAPABILITY_MATRIX).length).toBe(52);
    expect(Object.keys(CAPABILITY_SCOPE).length).toBe(52);
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
    // ⭐ `write_off_receivable` LEFT this set on 2026-08-28, hours after joining it, when Ian made
    // write-off manager-level. Same reasoning as set_credit_limit below: the fallback lends a
    // manager what only an admin holds, and a manager now holds this in the baseline. Nothing to
    // lend. ⚠️ The control did not weaken — it moved from RANK to IDENTITY, which is the stronger
    // of the two: `writeOffCharge` refuses the charge's own author regardless of role.
    // `set_credit_limit` LEFT this set on 2026-08-25 (bible row 121) and that is correct,
    // not a regression: the fallback exists to lend a manager what only an admin holds, and
    // a manager now holds credit limits in the baseline. Nothing to lend.
    expect([...ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER].sort()).toEqual(
      [
        'view_trial_balance',
        // ⭐ T-152's `set_cash_policy` JOINED this set on 2026-08-29 with no edit to any list —
        // admin-yes / manager-no, and the set is derived from exactly that. ⚠️ Worth a moment's
        // thought rather than a reflexive re-pin: it means that in an org with NO admin, a manager
        // DOES get the ceiling as a real granted row. That is correct — the conflict this
        // capability guards against is a manager raising a bar an admin set, and where there is no
        // admin the manager is the top of the tree and somebody must hold it. The grant is
        // materialised as an auditable row rather than inferred at check time.
        'set_cash_policy',
        'manage_users',
        'grant_capability',
        'manage_price_lists',
        'manage_fixed_assets',
        'run_depreciation',
        // ⭐ T-125's two JOINED this set with no edit to any list — they are admin-yes /
        // manager-no, and the set is derived from exactly that. Updating this pinned copy is the
        // only manual step, and it exists so the enrolment is NOTICED rather than silent: a
        // capability quietly gaining a fallback grant is how access widens without a decision.
        'manage_prepaid_items',
        'run_amortisation',
        'manage_chart_of_accounts',
        // ⭐ `provision_clock_terminal` JOINED this set on 2026-08-29, the moment Ian made it
        // admin-only (bible row 165) — it is admin-yes / manager-no, and the set is derived from
        // exactly that. ⚠️ **This is the ONE documented exception to "admin only", and it is
        // recorded rather than special-cased.** An org with no admin would otherwise be unable to
        // pair a single clock terminal, so attendance could never start there at all; the fallback
        // exists to bootstrap exactly that, is evaluated ONCE at appointment, and leaves a
        // `person_grants` row behind. Excluding it would need a hand-maintained carve-out in a set
        // whose whole point is being derived — and a carve-out is what drifts.
        'provision_clock_terminal',
      ].sort(),
    );
  });

  it('excludes capabilities admin itself lacks (post_journal_entry, cross_org_access, view_franchise_sales)', () => {
    for (const c of ['post_journal_entry', 'cross_org_access', 'view_franchise_sales'] satisfies Capability[]) {
      expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).not.toContain(c);
    }
  });
});
