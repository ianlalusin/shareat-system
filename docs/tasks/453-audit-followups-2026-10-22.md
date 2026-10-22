# T-453 — Audit follow-ups on the 19–21 October merges

**Status:** IN PROGRESS 2026-10-22 on lane/t453-audit-followups; not merged. Spec 2026-10-22 (Opus planner). Five findings from the audit of work merged 19–21 Oct (T-390/T-440 cutover,
T-443 PR #37, T-451 PR #45, T-450 screen state, T-343 L2a). Defects DEF-727, DEF-728, DEF-729. **No migration**
(see item 2). Build on Sonnet; each item is independent and may land as its own slice.

## Goal

Close three behaviour gaps (a liability booked as an asset, three unaudited catalogue writes, privileged holders hidden
from the positions list), one performance wart (sessionStorage written on every scroll event), and one wrong test oracle.

## Scope (exact files)

| # | Files |
|---|---|
| 1 | `apps/erp/src/app/cutover/actions.ts` (`addOpeningFigureAction`, ~L96) · `packages/domain/src/cutover/opening.ts` (`OpeningFigureInput`, `addOpeningFigure`) · `packages/domain/src/field-rules/cutover.ts` (`CUTOVER_FIGURE_RULES.direction`) · test `packages/domain/tests/integration/t453-cutover-direction.test.ts` (new) |
| 2 | `packages/domain/src/items/index.ts` (`setItemVariantOf` ~L1054, `dismissDuplicatePair` ~L1078, `undoDuplicateDismissal` ~L1103, and the wrong doc comment at ~L1051) · `packages/db/src/repo/items.ts` (`deleteDismissal` ~L939) · `packages/db/src/audit/catalogue.ts` · test `packages/domain/tests/integration/t443-item-variations-dismissals.test.ts` (extend) |
| 3 | `apps/erp/src/app/staff/page.tsx` (~L153) · `apps/erp/src/app/staff/role-title.ts` (new pure helper) · test `apps/erp/tests/t451-staff-role-title.test.ts` (extend) |
| 4 | `apps/erp/src/components/shell/screen-state.ts` (`rememberScreen`) · test `apps/erp/tests/t450-screen-state.test.ts` (extend) |
| 5 | `apps/erp/tests/integration/t343-s5-5v-followups.test.ts` (L2a, ~L357) |
| — | `docs/DEFECTS-REGISTER.md` (DEF-727..729 state on close), this task |

## Contract

### 1 — Opening figure direction (DEF-727)
- The action passes the raw value: `direction: str(formData, 'direction')`. No mapping in the app.
- `OpeningFigureInput.direction` becomes `string` at the boundary; `addOpeningFigure` narrows it to `'debit' | 'credit'`
  only after the field check passes.
- `CUTOVER_FIGURE_RULES.direction` becomes `kind: 'pattern'`, `pattern: '^(debit|credit)$'`, same `requires`
  ("Choose whether the business has this or owes it."). `bad()` prefers `requires`, so blank, `Credit`, `xyz` all refuse
  with that one sentence. The `<Select>` keeps its two options; `nativeAttrs` adds no browser pattern (by design).
- Order unchanged: `authorize` → `assertFieldRules` → opening lock (T-440 S9).

### 2 — Item catalogue audit trail (DEF-728)
- **No migration 0212.** `audit_log.action` is plain `text` (0197 L253); the closed list is the TS catalogue
  (`packages/db/src/audit/catalogue.ts`), enforced by `append`. 0197's VALUES list is only for copying legacy snake_case
  rows; new actions are dotted and need no SQL (T-430/T-433/T-434 precedent). The comment at items/index.ts ~L1051
  ("backed by a database table (migration 0197)") is wrong — replace it.
- Three catalogue entries, owner `T-453`, same labels as `rename_item` (`'stock', 'normal', 'org'`):
  `item.variant_set` (entity `items`), `item_duplicate.dismissed` and `item_duplicate.dismissal_undone`
  (entity `item_duplicate_dismissals`). 186 → 189 entries; the `t402-s1b-catalogue` ceiling is 190 — do not raise it.
- `setItemVariantOf`: append after the UPDATE, only when `changed`; `before: { variantOfItemId: old }`,
  `after: { variantOfItemId: input.parentId }`, `entityId: itemId`, `storeId: null`, `source: 'web'`.
- `dismissDuplicatePair`: append only when `created`; `entityId: dismissalId`, `after: { itemAId, itemBId, note }`
  (ordered ids as stored).
- `deleteDismissal` returns the removed row (`{ itemAId, itemBId, note } | null`) via `.returning`;
  `undoDuplicateDismissal` appends only when a row was removed, `before:` that row, `after: null`; return shape
  `{ removed: boolean }` unchanged.

### 3 — Who holds this position (DEF-729)
- New pure `positionHolders(roster, positionId)` in `role-title.ts`: every roster row with an assignment to the
  position, whatever its role (including `null`). Each gets `note: string | null`:
  - `staff` → `null`;
  - `manager` / `admin` / `super_admin` → `` `${staffRoleTitle(role, null)} — legacy position, grants still apply` ``;
  - no active role → `'No active role — legacy position'`.
- `page.tsx` uses it; the count in the summary counts all holders; the note renders after the name in
  `text-xs text-neutral-500`. Staff first, then flagged, each by display name.

### 4 — Screen-state scroll throttle
- The capture-phase `scroll` listener schedules a trailing write (one `setTimeout` ~250 ms; repeated events do not
  reschedule more than one pending write). `toggle`, `click`, `pagehide` and cleanup call `write()` directly and cancel
  any pending timer first, so the final position is never lost. Cleanup clears the timer before `disposed = true`.

### 5 — L2a oracle
- L2a submits `'-1'` and must ask `expectRuleSentence(errorOf(to), LOAN_ADD_RULES.interestRate, '-1')`. Nothing else.

## Invariants
- No ledger posting changes; a valid `debit`/`credit` figure books exactly as today.
- No refused write appends an audit row (append stays after the write; no-op paths append nothing).
- No role, scope, grant or assignment changes from item 3 — presentation only.
- No schema change, no new migration.

## Tests (write first; each with the mutant it must kill)
| Test | Asserts | Mutant that must turn it red |
|---|---|---|
| T1 (item 1, real PG) | `''`, `'Credit'`, `'xyz'` each refuse with the rule sentence, zero journal rows | restore the action's `=== 'credit' ? … : 'debit'` mapping (garbled → asset, no refusal); revert the rule to `kind: 'text'` |
| T2 | `'credit'` books Cr account / Dr 3900; `'debit'` the reverse | swap the direction branch in `opening.ts:146` |
| T3 (item 2, real PG) | set + clear a variant → 2 rows `item.variant_set` with before/after parents; repeat set → no new row | delete the append; append before the `changed` check |
| T4 | dismiss → 1 `item_duplicate.dismissed`; dismiss again → still 1; undo → 1 `item_duplicate.dismissal_undone` with the pair in `before`; undo again → still 1 | drop the `created` / `removed` guard |
| T5 | a refused variant (merged item / cross-kind parent) writes no audit row | move the append above `assertCanBeVariationOf` |
| T6 (unit) | catalogue contains the three actions; `t402-s1a-action-coverage` stays green | omit one catalogue entry |
| T7 (item 3, unit) | roster of staff + manager + admin + super_admin + role-less on one position → 5 holders, notes as specified | re-add `r.role === 'staff'` filter |
| T8 (item 4, jsdom) | 50 scroll events → ≤1 `setItem` before the timer fires; after it fires the stored y is the LAST position; cleanup mid-window stores the last position | write on every event; drop the trailing flush on cleanup |
| T9 (item 5) | L2a passes with the `'-1'` sentence | revert to `'1,5'` |

## Out of scope
- Raising the catalogue ceiling, relabelling legacy actions, any other T-443/T-451 behaviour, bulk-clearing legacy
  manager/admin assignments (T-451 deliberately left that explicit), the other T-343 oracles (DEF-708).

## Done when
- T1–T9 green on real PostgreSQL / jsdom; each listed mutant shown red once; `npm run typecheck` clean;
  `t402-s1a-action-coverage` and `t402-s1b-catalogue` green; DEF-727..729 marked fixed with the commit.
