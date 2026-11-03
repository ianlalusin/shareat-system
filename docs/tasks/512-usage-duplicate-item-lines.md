# T-512: a usage, wastage or return with the same item twice is refused in plain words (audit CR-1)

**Status:** SPEC 2026-11-03 (AUDIT). Number from the orchestrator (BOARD line 130). Source: Goldfish review GF-70 issue 2,
confirmed on origin/main 92382176 as CR-1 (`shareat-audits/OPEN/claude-current-revision-2026-11-03-findings.md`).
No migration expected; if one turns out to be needed, STOP and ask the orchestrator for a number. No DEF row (Ian, 28 Oct:
audit findings stay out of the register). Branch `audit/t512-usage-duplicate-items`, worktree `wt-audit-t512`.

## 1. The problem in plain words

A cook can save a usage (or wastage) draft that lists the same item on two lines. Saving works. Posting then fails with a
raw database error (`23505`, unique index `stock_movements_source_pair_key` on
`(source_type, source_id, item_id, location_id) WHERE reversal_of_id IS NULL`, migration 0063:71), because
`postUsageRecord` (packages/domain/src/stock/usage.ts:113-125) calls `consume` once per line with the same `sourceId`.
The transaction rolls back, so no stock is corrupted, but the user sees a database message and the draft can never post.
`recordReturn` (packages/domain/src/stock/supplier-returns.ts) has the same shape: one `returnId` as the source for every
line, so two lines for the same item at the same location hit the same index.

## 2. Ruling (planner, AUDIT; no Ian ruling needed)

Refuse, do not merge. A document lists each item once (per location, for returns). Merging quantities silently would hide
a likely data-entry mistake and change what the user typed. The refusal is a normal `{ ok: false, reason }` outcome, in
plain words, BEFORE any write, naming the item: `Item <name or id> is on this record twice. Put it on one line with the
total quantity.` Use the item's display name if the function already has it cheaply; the id is acceptable otherwise.

## 3. Changes

1. `packages/domain/src/stock/usage-records.ts`
   - `saveUsageDraft`: after the existing blank/zero checks and before any insert, refuse when two input lines share an
     `itemId`.
   - `addUsageLine`: refuse when the draft already has a line for `input.itemId`.
   - `postUsage`: refuse when the loaded lines contain a repeated `itemId` (protects drafts saved before this fix), before
     the tolerance gate and before any write.
2. `packages/domain/src/stock/usage.ts` `postUsageRecord`: defensive guard at the top (before the reserved-category check's
   writes and before the loop), returning the same `{ ok: false, reason }`. Grep for every other caller of
   `postUsageRecord` / `postLoadedUsageRecord` and confirm each is covered.
3. `packages/domain/src/stock/supplier-returns.ts` `recordReturn`: refuse two lines with the same `(itemId, locationId)`,
   after the blank/zero checks, before any write.
4. Check the ERP form/action for usage and returns (`apps/erp/src/app/inventory/...`): if the UI already prevents
   duplicates, say so; if not, no UI change is required in this task, since the domain refusal message is shown by the
   existing action error path. Confirm that path shows `reason`.

## 4. Tests (write them FIRST, show them failing on unchanged code, then fix)

Integration, real PostgreSQL on `shareat_test_audit512` (already in this worktree's `.env.local`; never print that file;
never use shareat_test or shareat_dev). Name: `tests/integration/t512-duplicate-item-lines.test.ts` (or under
packages/domain/tests/integration if that is where stock tests live; follow the neighbours). Use existing stock fixtures.
- (a) `saveUsageDraft` with item X twice: `ok:false`, reason names the item, NO usage record or line row written.
- (b) `addUsageLine` adding X to a draft that has X: `ok:false`, line count unchanged.
- (c) Legacy draft: insert two X lines through the repo directly (bypassing the new save check), then `postUsage`:
  `ok:false` with the plain reason (NOT a thrown 23505), record still `draft`, zero stock_movements and zero journal
  entries for that record, FIFO layers unchanged.
- (d) Wastage kind: same as (a) for a wastage draft.
- (e) `recordReturn` with two lines for the same item and location: `ok:false`, nothing written. Same item at two
  DIFFERENT locations is a positive control and still succeeds (or, if the fixture cannot model two locations, state that).
- (f) Positive control: two DIFFERENT items still save and post exactly as before (amounts unchanged).
Assert the outcome object and the reason text pattern, not a bare `rejects.toThrow()`.

## 5. Checks
- Root `npm run typecheck` clean.
- The new test file, plus the existing stock usage/wastage/supplier-returns integration files it touches, green on
  `shareat_test_audit512`.
- `npx vitest run --project unit tests/unit/` guard and census files (`*guard*`, `*census*`, app-boundaries) green.
- No CR bytes in the diff. `git diff --stat` shows only the files above, the new test and this spec.

## 6. Acceptance
No user path can produce a raw 23505 from repeated items on a usage, wastage or return document; each is refused in plain
words before any write; different-item documents behave exactly as before. Closing CR-1 in `shareat-audits` happens after
merge.
