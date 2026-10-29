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
  ROLE_ONLY_CAPABILITIES,
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
  // ⭐ 49 -> 53 on 2026-08-30 (T-173/T-174/T-175): `confirm_receipt`,
  // `resolve_trade_discrepancy`, `set_item_threshold`, `post_order_message`. All four had been
  // DEFERRED across three task reports for the same reason — "no caller yet, so the ✗ cannot be
  // tested" — and all four landed together the moment the commissary screens gave them one.
  // ⚠️ That is the debt this pin is designed to make visible: a capability with no caller is a
  // capability nobody has proved refuses anyone.
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
  // ⭐ 52 -> 56 on 2026-08-30, at the inventory merge: `confirm_receipt` (T-173),
  // `resolve_trade_discrepancy` (T-174), `set_item_threshold` and `post_order_message` (T-175).
  // FOURTH independent addition in three days, on a fourth branch. The count is the SUM of every
  // lane's; taking one side of this conflict leaves a green test asserting a wrong number.
  // ⭐ 56 -> 58 on 2026-08-30, T-186: `record_till_count` and `resolve_till_variance`. The
  // pair is deliberately asymmetric on `staff` — recording a count is the cashier's job,
  // charging the shortage it reveals is not. That asymmetry IS the control, so a future edit
  // that quietly equalises them should fail this file, not pass it.
  // ⭐ 58 -> 60 on 2026-08-31, T-189: `set_pay_rate` and `run_payroll`. Both admin-yes /
  // manager-no, so both also JOIN the adminless-manager fallback below with no edit to any
  // list — see the reasoning there before assuming that is a mistake.
  // ⭐ 60 -> 62 on 2026-09-02, T-167: `transfer_stock` (staff-open) and `void_transfer`
  // (manager+, same asymmetry as `void_expense`). 62 -> 65 same day, T-170:
  // `record_supplier_return` (staff-open), `void_supplier_return` (manager+),
  // `apply_supplier_credit` (manager+, checked inside recordPayment).
  // ⭐ 69 -> 74 on 2026-09-03, DEF-136/DEF-129: `place_branch_order` and `fulfil_branch_order`
  // (both staff-open — the two SIDES of one order, each resolved at a different store) and
  // `dispatch_branch_order` (manager+, the posting event); `manage_commissary_offerings` and
  // `manage_commissary_map` (manager+, store-scoped to the commissary and the branch
  // respectively). T-171's third, `import_commissary_catalogue`, is NOT added: the bulk import
  // is unbuilt and a capability with no caller is the debt this pin exists to expose.
  // ⭐ 74 -> 81 on 2026-09-03, DEF-135 (T-160/T-166/T-168/T-169 finally get screens):
  // `manage_locations` (manager+), `receive_delivery` (staff-open), `allow_over_receipt`
  // (manager+), `post_usage` and `void_usage_record` (manager+), `open_count_session` and
  // `commit_count` (manager+). The four specs also named `allocate_stock`, `can_charge_staff`,
  // `bypass_count_freeze` and `can_adjust_inventory`: the first three are NOT added (no caller —
  // the same debt as `import_commissary_catalogue`), and the last two already exist as
  // `charge_staff_for_discrepancy` / `adjust_inventory`.
  it('finds exactly 119 capability rows — NOT the "36" the task documents say in prose', () => {
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
    // 50 since T-137 added `record_statutory_discount` and `void_statutory_discount`,
    // 88 since T-176 (`post_production`, `edit_posted_production`, `void_production`) and
    // T-178 (`record_order_wastage`, `resolve_order_wastage`, `charge_staff_for_wastage`,
    // `reverse_auto_charge`) landed as two concurrent lanes and both sets of rows merged.
    // 93 since T-222 (`manage_stores`). 92 since T-177 (`manage_pos_map`, `request_pos_map`, `decide_pos_map_request`,
    // `finalize_pos_usage_pull`).
    // ⭐ 96 -> 97 on 2026-09-25 (T-344/DEF-422): `create_missing_period`. ORG-scoped, admin and up
    // only — the admin-only remedy for a month missing inside closed books (Q2). Not offerable to
    // a position (R1.3), and does not backfill the adminless-manager fallback for a manager
    // already elevated before this landed (R1.4; the gap is expected empty per bible row 211).
    // ⭐ 97 -> 98 (T-345): `book_missed_month`. ORG-scoped, admin and up only — the admin-only
    // remedy for a scheduled charge missed in a closed/locked/missing month, booked once into an
    // open month (Ian 2026-09-25). Not offerable to a position, same reasoning as
    // `create_missing_period` immediately above.
    // ⭐ 98 -> 99 (T-350/DEF-477): `set_channel_payout`. STORE-scoped, admin and up only — Ian,
    // 2026-09-28: "admin must be able to change that when set". Replaces `manage_store_settings`
    // as the gate on `setChannelPayoutDestination`, both the first set and every later change.
    // Having to edit this number is the guard WORKING: a capability cannot be slipped
    // into the enforcement without also being written into the document people actually
    // read, and vice versa.
    // ⭐ 99 -> 100 (T-382 S1, A3): `unlink_store_from_pos`. ORG-scoped, super_admin only, audited — Ian,
    // 2026-10-07 (`t375-unlink-safety`). ⛔ RED until the builder adds the row: today's document has 99.
    // ⭐ 100 -> 101 (T-385 S3, A3): `verify_own_sales_day`. super_admin only (scope is the builder's call, store or org) — Ian,
    // 2026-10-09 (t385-q1 = a). ⛔ RED until the builder adds the row: today's document has 100.
    const { rows } = parseCapabilityMatrixDoc();
    // ⭐ 101 -> 108 (T-401 S2): seven menu capabilities (view_menu, add_menu_item, manage_menu, request_menu_item, set_menu_price, set_menu_depletion, switch_usage_source).
    // ⭐ 111 -> 112 (T-424): `approve_pos_correction` (store, admin yes, manager no: held by grant).
    // ⭐ 112 -> 113 (T-434): `view_staff_signature` (store, admin yes, manager no: held by position grant). Also joins the derived ELEVATED set.
    // ⭐ 113 -> 114 (T-436): `view_leave_document` (store, admin yes, manager yes, position-grantable).
    // ⭐ 114 -> 115 (T-190): `manage_payroll_rates` (org, admin only: the accountant).
    // ⭐ 115 -> 116 (T-464): `pair_pos_tablet` (store, admin yes, manager yes, staff no).
    // ⭐ 116 -> 117 (T-475 S3): `verify_own_supplier_invoice` (org, admin yes, manager no; ROLE ONLY).
    // T-398 S6: 117 -> 118 (`view_franchise_access_log`, org, super/admin/manager yes, staff no; ROLE ONLY). Combined with T-193 S3: 118 -> 119.
    // T-193 S3: `remit_statutory` (org, admin yes, manager no, staff no): paying the statutory agencies. Merge of main + T-193: re-measured.
    expect(rows.length).toBe(119);
    // ⭐ 109 -> 111 (T-402 S1b): `view_activity_log` (store) and `view_activity_log_restricted` (org).
    // ⭐ 108 -> 109 (T-403): `manage_recipes` (org, admin-only).
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

  it('CAPABILITIES, CAPABILITY_MATRIX and CAPABILITY_SCOPE all enumerate the same 119 capabilities', () => {
    // ⭐ 99 -> 100 (T-382 S1, A3): `unlink_store_from_pos`. ⛔ RED until the builder adds it to capabilities.ts.
    // ⭐ 100 -> 101 (T-385 S3, A3): `verify_own_sales_day`. ⛔ RED until the builder adds it to capabilities.ts.
    // ⭐ 101 -> 108 (T-401 S2): the seven menu capabilities.
    // T-398 S6: `view_franchise_access_log`. T-193 S3: `remit_statutory`. Merge of main + T-193: re-measured.
    expect(CAPABILITIES.length).toBe(119);
    expect(Object.keys(CAPABILITY_MATRIX).length).toBe(119);
    expect(Object.keys(CAPABILITY_SCOPE).length).toBe(119);
    // ⭐ 108 -> 109 (T-403): `manage_recipes`.
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
    const expected = CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].admin && !CAPABILITY_MATRIX[c].manager && !ROLE_ONLY_CAPABILITIES.has(c)).sort();
    // T-402 (Ian): with no admin the manager serves as admin, so the restricted activity log IS lent to them.
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).toContain('view_activity_log_restricted' satisfies Capability);
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
        // ⭐ T-189's two JOINED this set on 2026-08-31, also with no edit to any list. ⚠️ Worth
        // the same moment's thought: in an org with NO admin, a manager DOES get `set_pay_rate`
        // and `run_payroll` as real granted rows. That is correct — somebody has to pay people,
        // and where there is no admin the manager is the top of the tree.
        //
        // ⭐ And unlike `set_cash_policy`, payroll does not rely on rank alone: `postPayRun`
        // refuses to pay the POSTER'S OWN employment whatever their role. The control moves from
        // RANK to IDENTITY — the stronger of the two, exactly as it did for `write_off_receivable`.
        'set_pay_rate',
        'run_payroll',
        'manage_users',
        // ⭐ T-222's `manage_stores` JOINED this set on 2026-09-06 with no edit to any list — it is
        // admin-yes / manager-no, and the set is derived from exactly that. ⚠️ Worth the moment's
        // thought this pinned copy exists to force, because it is a real access decision: in an org
        // with NO admin, a manager DOES get `manage_stores` as a granted row and can open or close a
        // branch. That is correct on the same reasoning as `manage_users` directly above it — the
        // fallback lends a manager what only an admin holds, and where there is no admin the manager
        // is the top of the tree and somebody must be able to. It is materialised as an auditable
        // row rather than inferred at check time.
        'manage_stores',
        // ⭐ T-403: `manage_pos_map` LEFT manager (admin-only now) and `manage_recipes` is new admin-only; both are
        // admin-yes / manager-no, so the derived set gains both. Deliberate: an org with no admin lends them to a manager.
        'manage_pos_map',
        'manage_recipes',
        // ⭐ T-402 S1b: `view_activity_log_restricted` is admin-yes / manager-no (org), so the derived set gains it (Ian: with no admin the manager serves as admin).
        'view_activity_log_restricted',
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
        // ⭐ T-264 slice 3's `override_period_lock` JOINED this set on 2026-09-12 with no edit to
        // any list — admin-yes / manager-no, and the set is derived from exactly that. ⚠️ This one
        // was escalated rather than re-pinned, because bible row 193 says the override is for
        // `admin` and `super_admin` and NOBODY ELSE, and the fallback appears to contradict that.
        // ⭐ Ian ruled on 2026-09-12 (bible row 196) that the enrolment is CORRECT: an org with no
        // active administrator has nobody else who could ever authorise a late entry, and the grant
        // is revoked the moment an administrator arrives (row 188). The alternative — a carve-out in
        // a derived set — is precisely what this pin's own comments say drifts.
        'override_period_lock',
        // ⭐ `provision_clock_terminal` JOINED this set on 2026-08-29, the moment Ian made it
        // admin-only (bible row 165) — it is admin-yes / manager-no, and the set is derived from
        // exactly that. ⚠️ **This is the ONE documented exception to "admin only", and it is
        // recorded rather than special-cased.** An org with no admin would otherwise be unable to
        // pair a single clock terminal, so attendance could never start there at all; the fallback
        // exists to bootstrap exactly that, is evaluated ONCE at appointment, and leaves a
        // `person_grants` row behind. Excluding it would need a hand-maintained carve-out in a set
        // whose whole point is being derived — and a carve-out is what drifts.
        'provision_clock_terminal',
        // ⭐ T-344/DEF-422's `create_missing_period` JOINED this set on 2026-09-25 with no edit to
        // any list — admin-yes / manager-no, and the set is derived from exactly that. ⚠️ This is
        // the DERIVATION only: `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` is recomputed from
        // `CAPABILITY_MATRIX` at import time, so every future manager elevation in an adminless org
        // picks it up automatically. It does NOT retroactively backfill a manager already elevated
        // before this landed (R1.4) — that manager holds it only once re-elevated. Bible row 211:
        // the one production org has an admin, so that gap is expected to be empty.
        'create_missing_period',
        // ⭐ T-345's `book_missed_month` JOINS this set with no edit to any list — admin-yes /
        // manager-no, same derivation, same reasoning as `create_missing_period` directly above:
        // an adminless org's manager is the top of the tree and somebody must be able to catch up
        // a scheduled charge a closed month trapped. ⛔ T-345 RED — the key is not a Capability yet,
        // so this line is why `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` fails to compile as
        // `Capability[]` today (see `t345-book-missed-month-capability.test.ts`).
        'book_missed_month',
        // T-350 S2 (F10) — the previous wording here borrowed `set_cash_policy`'s own reasoning
        // ("raise the ceiling") for a capability that has no ceiling at all: `set_channel_payout`
        // is ROUTING (which existing account a channel's payout lands in), not a limit anyone's
        // custody is measured against. The real reason is the DERIVATION itself (bible §13 row
        // 196): `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` is admin-yes/manager-no capabilities,
        // computed from the matrix — so `set_channel_payout` JOINS this set with no edit to any
        // list, the same way `override_period_lock` did. In an org with no admin the manager is
        // the top of the tree, and somebody must still be able to point a channel's payout
        // somewhere; the grant is revoked the instant an administrator arrives (row 188).
        'set_channel_payout',
        // T-401 S2: admin-yes, manager-no, so they JOIN by the derivation (no list edit): manage_menu, set_menu_depletion
        // (Ian 2026-10-13: only admin edits recipes), switch_usage_source (changes what live stock posts).
        'manage_menu',
        'set_menu_depletion',
        'switch_usage_source',
        // T-424: admin-yes, manager-no (held by grant: the store-manager positions' defaults), so it JOINS by the derivation. In an org with no
        // admin the manager serves as admin and may approve a POS refund / correction / void with their PIN.
        'approve_pos_correction',
        // ⭐ T-434: `view_staff_signature` is admin-yes / manager-no (store), so the derived set gains it; with no admin the manager serves as admin.
        'view_staff_signature',
        // ⭐ T-436: `view_leave_document` is admin-yes / manager-no (store), so the derived set gains it; with no admin the manager serves as admin.
        'view_leave_document',
        // ⭐ T-190: `manage_payroll_rates` is admin-yes / manager-no (org), so the derived set gains it.
        'manage_payroll_rates',
        // ⭐ T-193 S3: `remit_statutory` is admin-yes / manager-no (org), so the derived set gains it (in an org with no admin the manager is the top of the tree).
        'remit_statutory',
      ].sort(),
    );
  });

  it('excludes capabilities admin itself lacks (post_journal_entry, cross_org_access, view_franchise_sales)', () => {
    for (const c of ['post_journal_entry', 'cross_org_access', 'view_franchise_sales'] satisfies Capability[]) {
      expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).not.toContain(c);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-382 S1 — A1 and A3: `unlink_store_from_pos`, the fifth super_admin-only capability.
// `docs/tasks/382-pos-store-unlink.md` R6. ⛔ RED until the builder adds the code row and the document row.
// ---------------------------------------------------------------------------------------------------------------
describe('T-382 A1/A3 — unlink_store_from_pos: org scope, super_admin only, and the document says the same', () => {
  const CAP = 'unlink_store_from_pos' as string as Capability;

  it('A1: the typed matrix — super_admin yes, admin no, manager no, staff no; org scope; not conditional', () => {
    expect(CAPABILITIES as readonly string[]).toContain(CAP);
    expect(CAPABILITY_MATRIX[CAP]).toEqual({ super_admin: true, admin: false, manager: false, staff: false });
    expect(CAPABILITY_SCOPE[CAP]).toBe('org');
    expect(CONDITIONAL_CAPABILITIES.has(CAP)).toBe(false);
    // admin lacks it, so the adminless-manager fallback (the admin-minus-manager delta) cannot hand it to a manager either
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER as readonly string[]).not.toContain(CAP);
  });

  it('A3: the document row exists exactly once and matches the code row (parsed, not hand-compared)', () => {
    const { rows } = parseCapabilityMatrixDoc();
    const mine = rows.filter((r) => r.capability === CAP);
    expect(mine.length, 'CAPABILITY-MATRIX.md carries exactly one unlink_store_from_pos row').toBe(1);
    expect(mine[0]!.scope).toBe('org');
    expect(mine[0]!.cells).toEqual([true, false, false, false]);
    expect(mine[0]!.conditionalManager).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-385 S3 - A1 and A3: `verify_own_sales_day`, the sixth super_admin-only capability.
// `docs/tasks/385-verify-only-after-submit.md` S3 (Ian 2026-10-09, t385-q1 = a): the person who submitted a day may not
// verify it, EXCEPT a super-admin. The exception is a capability so `authorize()` stays the one decider.
// ⛔ RED until the builder adds the code row and the document row.
// ---------------------------------------------------------------------------------------------------------------
describe('T-385 A1/A3 - verify_own_sales_day: super_admin only, and the document says the same', () => {
  const CAP = 'verify_own_sales_day' as string as Capability;

  it('A1: the typed matrix - super_admin yes, admin no, manager no, staff no; not conditional', () => {
    expect(CAPABILITIES as readonly string[]).toContain(CAP);
    expect(CAPABILITY_MATRIX[CAP]).toEqual({ super_admin: true, admin: false, manager: false, staff: false });
    expect(['store', 'org']).toContain(CAPABILITY_SCOPE[CAP]);
    expect(CONDITIONAL_CAPABILITIES.has(CAP)).toBe(false);
    // admin lacks it, so the adminless-manager fallback (the admin-minus-manager delta) cannot hand it to a manager either
    expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER as readonly string[]).not.toContain(CAP);
  });

  it('A3: the document row exists exactly once and matches the code row (parsed, not hand-compared)', () => {
    const { rows } = parseCapabilityMatrixDoc();
    const mine = rows.filter((r) => r.capability === CAP);
    expect(mine.length, 'CAPABILITY-MATRIX.md carries exactly one verify_own_sales_day row').toBe(1);
    expect(mine[0]!.scope).toBe(CAPABILITY_SCOPE[CAP]);
    expect(mine[0]!.cells).toEqual([true, false, false, false]);
    expect(mine[0]!.conditionalManager).toBe(false);
  });
});
