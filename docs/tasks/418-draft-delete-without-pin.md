# T-418 — Deleting an unposted draft needs no administrator's PIN

**Status:** DONE 2026-10-16 (merged to main); **Ian's answers folded in 16 Oct (both questions closed)**. Opus spec. Reopens **T-412** Question 2 (`docs/tasks/412-confirm-destructive-tiers.md`).
**Source:** bible row 348 (Ian, 16 Oct, decisions page): *"deleting an unposted DRAFT needs NO admin PIN; only posted records
do."* T-412 shipped the opposite default (Q2 "keep that literal"), so three draft deletes ask for a PIN today.
**Model: SONNET** (one builder, one tester; Haiku not used: auth-adjacent). **No migration.** **No capability change**
(`CAPABILITY-MATRIX.md` unchanged). Size S.

## Goal, in plain words
A cashier who started an expense or a usage sheet by mistake can throw the draft away without finding an administrator.
Nothing about a draft has touched the books or the stock, so the PIN protects nothing there. Anything **posted** keeps the
PIN: it is voided or reversed, never deleted, and that path does not change.

## What changes (the three draft deletes found; counted at `21b5603`)
| Button (page) | Server action | Domain call (already refuses a non-draft) |
|---|---|---|
| "Delete draft", `app/expenses/[id]/page.tsx` | `deleteDraftAction`, `app/expenses/actions.ts:410` | `deleteExpenseDraft` refuses `status !== 'draft'` (`packages/domain/src/expenses/delete.ts`) |
| "Delete usage draft", `app/inventory/usage/[id]/page.tsx` | `deleteUsageDraftAction`, `app/inventory/usage/actions.ts:154` | `deleteUsageDraft` -> `loadDraftForEdit` refuses a non-draft (`packages/domain/src/stock/usage-records.ts:241`) |
| "Delete template", `app/expenses/recurring/page.tsx` | `deleteTemplateAction`, `app/expenses/recurring/actions.ts:103` | `deleteRecurringTemplate` refuses once the template *"has already produced an expense"* (`recurring-expenses/index.ts:284`) |

The recurring template is in scope because it is the same case: it can only be deleted while it has never produced
anything, so no posted record is touched. **Out of scope, stays Tier P:** cutover "Remove opening figure"
(`app/cutover/actions.ts:113`) — **Ian 16 Oct: keeps the admin PIN** (answer 1 below). Every other Tier P row (voids, reversals, write-offs, posts) is unchanged.

## The tier these three get: **Tier W (no extra confirmation step)** — decided, with reasons
T-412 has three tiers: P (admin PIN), R (retype the name), W (unguarded workflow step: discard, withdraw, cancel).
- **R does not fit.** A draft has no stable name to retype (an expense draft's description can be blank or "x"); asking
  someone to type a made-up name is friction with no meaning, and Ian asked for less friction, not a different kind.
- **W fits exactly.** It is already the tier for "throw away unposted work": attendance "Discard event", "Withdraw cash
  request", "Cancel count". A draft delete is the same act. The domain comment in `delete.ts` already argues this:
  *"friction on a self-correction is what produces the abandoned drafts."*
- **No new "plain confirm" tier.** **Ian 16 Oct: one click, no "Are you sure?"** (answer 2 below). The button deletes on
  the first click; no `confirm()`, no second-click state, no dialog.

## Server contract (the gate stays on the server)
1. The three actions **drop** `loadDestructiveTarget`, `verifyAdminApproval` and `recordApproval`. They call the domain
   function inside `withOrgPrincipal` as before. No `adminPin` is read. No `destructive.approved` audit row is written
   (there is no approver).
2. **Authorization is unchanged and stays in the domain:** `deleteExpenseDraft` keeps its edit gate (creator inside the
   48-hour window with `edit_own_expense`, else `edit_any_expense`); `deleteUsageDraft` keeps `loadDraftForEdit`'s gate;
   `deleteRecurringTemplate` keeps `manage_recurring_expenses`. Removing the PIN must not remove these.
3. **A posted record is never deleted, PIN or not.** The domain status refusals above are the gate. The posted path is
   void/reverse, which keeps `verifyAdminApproval` (`voidExpenseAction` `:367`, `voidUsageAction` `:190`) — unchanged.
4. The usage action's form field `storeId` stays navigation-only (the redirect). It is never used for authorization.

## Files
**BUILDER (source only):**
`apps/erp/src/app/expenses/actions.ts` (`deleteDraftAction` only) · `apps/erp/src/app/expenses/[id]/page.tsx` (the
"Delete draft" `<ConfirmDestructive tier="admin-pin">` becomes a plain `<Button variant="danger">` in its form) ·
`apps/erp/src/app/inventory/usage/actions.ts` (`deleteUsageDraftAction` only) · `apps/erp/src/app/inventory/usage/[id]/page.tsx`
· `apps/erp/src/app/expenses/recurring/actions.ts` (`deleteTemplateAction` only) · `apps/erp/src/app/expenses/recurring/page.tsx`.
Remove any import left unused. Keep the consequence sentence as visible text beside the button
(e.g. "Deletes this draft. Nothing was posted.").

**TESTER (tests only):**
NEW `apps/erp/tests/integration/t418-draft-delete.test.ts` (cases 1-8) ·
NEW `apps/erp/tests/t418-draft-delete-one-click.test.ts` (case 10) ·
EDIT `apps/erp/tests/t412-destructive-census.test.ts` — the three rows move `tier: 'P'` -> `tier: 'W'`; header arithmetic
becomes P 32 / R 14 / W 13 / X 4 (63 controls unchanged) ·
EDIT `apps/erp/tests/integration/t412-destructive-actions.test.ts` — remove the `deleteDraftAction` I10 case (its
"no PIN -> refused" leg is now wrong); the other batches stay.

**DO NOT TOUCH (lane T-416 is editing them now):** `packages/auth/src/sessions.ts`, `packages/auth/src/admin-approval.ts`,
the pin-attempts / throttle code under `packages/auth/src` and `packages/db/src/repo` that T-416 lists,
`packages/auth/tests/integration/t412-admin-approval.test.ts`. T-418 needs none of them, so it **can run beside T-416**.
If a builder finds it must edit any of them, stop and wait for T-416 to merge.
Also untouched: the domain delete functions (their refusals are what this task relies on) and `ConfirmDestructive.tsx`.

## Acceptance cases (real Postgres; each names the mutant it kills)
1. Manager (has `edit_any_expense`, not an admin) deletes another person's **draft expense** with no `adminPin` -> row gone,
   redirect to `/expenses`. *Kills: leaving `verifyAdminApproval` in `deleteDraftAction`.*
2. Same for a **usage draft** -> record and its lines gone. *Kills: leaving the PIN check in `deleteUsageDraftAction`.*
3. Same for a recurring **template that never produced** -> gone. *Kills: leaving the PIN check in `deleteTemplateAction`.*
4. `deleteDraftAction` on a **posted** expense, with and without a valid admin PIN -> refused with *"Only a draft can be
   deleted"*; status still `posted`, journal unchanged. *Kills: dropping the status check in `deleteExpenseDraft`.*
5. `deleteUsageDraftAction` on a **posted** usage record -> refused; record, lines and stock movements unchanged.
   *Kills: dropping the draft check in `loadDraftForEdit`.*
6. `deleteTemplateAction` on a template that **has produced** an expense -> refused with the "pause it instead" sentence.
   *Kills: dropping the produced-count check.*
7. A cashier with only `edit_own_expense`, **not** the creator, deletes someone else's draft -> refused, row present.
   *Kills: removing the domain `authorize` call along with the PIN (or the action skipping the domain function).*
8. Regression: `voidExpenseAction` and `voidUsageAction` on posted records with no `adminPin` -> refused with
   `ADMIN_PIN_REFUSED`, nothing changed; and no `destructive.approved` row exists after cases 1-3.
   *Kills: deleting `verifyAdminApproval` from a void action in the same file; writing an approval row with no approver.*
9. Census (`t412-destructive-census.test.ts`): the three rows are W; their pages hold no `<ConfirmDestructive>` for that
   button; their action functions contain no `verifyAdminApproval(`; "Remove opening figure" is still P.
   *Kills: leaving `tier="admin-pin"` on one page; moving the cutover row by mistake.*

Each mutant shown red, then reverted. No mutant survives in the merged diff (grep it).

## Done when
`npm run typecheck` clean · cases 1-10 green · `t412-destructive-actions` and the census green · CI PR green (row 296) ·
screenshots of `/expenses/[id]` (draft) and `/inventory/usage/[id]` (draft) at 390 and 1280 showing a plain Delete button.
Orchestrator notes T-412 Q2 as superseded by row 348 in `412-confirm-destructive-tiers.md`.

## Ian's answers (16 Oct) — binding
1. **Opening balances at go-live keep the admin PIN.** Removing an opening figure before go-live stays Tier P
   (`app/cutover/actions.ts:113` untouched). Case 9 already pins it.
2. **Draft delete is one click.** No "Are you sure?" step. Case 10 pins it.

## Added case (from answer 2)
10. Render (`apps/erp/tests/t418-draft-delete-one-click.test.ts`, TESTER): each of the three pages' delete control is a plain
    submit button inside its form, with no `onClick` that calls `confirm(`, no `ConfirmDestructive`, no dialog role and no
    "Are you sure" text; source grep of the three page files finds no `confirm(`. *Kills: adding a browser confirm or a
    two-click "Click again to delete" state.*
