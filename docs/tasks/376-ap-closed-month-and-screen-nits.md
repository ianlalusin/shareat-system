# T-376: AP late-bill override and two screen nits — DEF-581, DEF-582, DEF-583

**Status:** DONE 2026-10-05. **S1 SHIPPED `dde37cb` (DEF-581); S2 SHIPPED `13d61fb` (DEF-582); S3 STOPPED AT STEP 0 under R7: DEF-583 did not reproduce on 9008 under `next dev` (absent → 1) or a production build with client-side navigation (2 → 3, no reload); nothing built; DEF-583 closed as not reproduced.** Earlier: APPROVED 2026-10-04 after independent Opus review (✎X); no migration. Earlier: SPEC 2026-10-04 (Opus planner).
Written at HEAD `ca852eb`. The tree held uncommitted T-367 S5 work (retiring `other`/`ar_collection`) in
`expenses/{routing,create,edit}.ts`, `shared/money-lines.ts`, `repo/expenses.ts`, `schema/expenses.ts`,
`apps/erp/src/app/expenses/actions.ts` and migration 0182. Line numbers below were read in that tree.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** none. (If one turns out to be needed, the next free number after T-316's 0184 and T-375's 0185 is **0186**. Stop
and report first: it would be a spec defect.)

## Goal
Three places where the AP or cash screens say something untrue or nothing at all:
- an admin can post a supplier bill dated in a closed month from the bills screen, through the same closed-month
  override that expense approval already has (DEF-581, ⚠️ money);
- recording a supplier return, or a refund of supplier credit, says what happened; a refusal shows as a banner,
  never as a crash digest (DEF-582);
- the remittance variance banner shows the right count right after a handover (DEF-583).

## v1 as requirements (§1.2d)
- **DEF-581.** v1 has no closed-month override as such. `src/lib/financial/lockedDay.guard.server.ts` lets an admin
  past every day lock, silently (header comment, "Two lock layers, both bypassed by admin"). v1's receipt verify
  (`src/lib/actions/receipt.actions.ts:429`) posts nothing; v1 posts an expense when it is saved.
  - **The goal v1 serves:** an admin can still book a genuinely late supplier bill into the month it belongs to.
  - **v2 already beats it** for expense approval (T-369 S5b): explicit, per entry, a typed reason, an audit row,
    admin only, never for stock. **v2 lost the goal on the bills screen**, because since T-196 verifying a bill IS
    its approval (`verifyInvoice` posts its drafts) and that path was built with no override.
- **DEF-582.** v1's `SupplierReturnDialog.tsx:173-177` shows a success toast naming the quantity, the item and the
  supplier, and an error toast with the reason (`:188`). **Goal:** the person knows the return took. v2 shows
  nothing on success.
- **DEF-583.** Not a v1 question. It is a v2 screen fault.

## Census, verified at source (corrections to the register marked ✎)

### DEF-581 (⚠️) — a late bill cannot be posted from the bills screen
- Confirmed. `verifyInvoice` (`packages/domain/src/ap/index.ts:658`) posts every draft on the bill through
  `approveExpense(trx, actor, d.id, { noPeriodOverride: true })` (`:745`), in one transaction with the status flip.
  A refusal is rewrapped keeping the inner `userMessage` (`:746-764`), and the bill stays `pending`.
- `approveExpense` (`packages/domain/src/expenses/approve.ts`):
  - `ApproveExpenseOptions` (`:41-48`) has `periodOverride?` and `noPeriodOverride?`;
  - `:253-272`: the override is passed to `postEntry` **only when the expense's own month is `closed`** (an open
    month ignores it, so no audit noise and no `override_period_lock` check);
  - `noPeriodOverride` only swaps the two sentences: *"{Month} is closed, and a bill's expense can't be posted into
    a closed month from the bills screen yet. Nothing was saved."* and a locked twin.
  - `postEntry` authorises `override_period_lock` against the actor and writes one `period_overrides` row per entry
    (`schema/period-overrides.ts`).
- Every draft on a bill has `businessDate = invoice.invoiceDate`: `createExpense` forces it server-side
  (`expenses/create.ts:212`, ✎X-8 ≈`:214` in the dirty tree; re-read). So the bill's date decides the month for all of its drafts.
- Logging a late bill and adding its drafts already works. `recordInvoice` and `createExpense` make no period check.
  Only the posting is blocked.
- ✎ **A second path has the same hole.** `recordExpenseForInvoice` (`ap/index.ts:871`, `:887`
  `{ noPeriodOverride: true }`) is the "Record an expense against this invoice" form on a VERIFIED bill
  (`ap/invoices/[id]/page.tsx:461-500`; action `recordExpenseForInvoiceAction`, `expenses/actions.ts:268-296`, ✎X-8 ≈`:266` once T-367 S5 lands). A bill
  verified before its month closed cannot take another expense afterwards. It is also the only route when the
  bill's only admin is the person who logged it (see R4).
- ✎ **A committed test pins the sentence this task retires:** `packages/domain/tests/integration/t369-s5-closed-month-override.test.ts:351-398`
  asserts that a manager verifying a closed-month bill gets the bill sentence and NOT *"post this one entry"*.
  Nothing else pins `noPeriodOverride` or its sentences (grep of `packages`, `apps`, `tests`).
- ✎ **The stock allowlist test must widen.** `tests/unit/t369-override-not-on-stock-screens.test.ts`
  `ALLOWED_IMPORTERS` holds exactly `app/expenses/reimbursements/page.tsx` and `app/expenses/[id]/page.tsx`.
  `app/ap/...` is not a stock directory, so I5 is untouched.
- Screen today (`ap/invoices/[id]/page.tsx`): the verify form (`:339-372`) has the four attestation boxes and no
  date field. The page already lists the drafts verification will post (`:68-73`, `draftExpenses`). The record form
  (`:461`) shows only when `canRecord` (`:52`).
- The screen helpers exist: `apps/erp/src/lib/period-override.ts` (`closedMonths`, `closedMonthOf`,
  `readPeriodOverride`, `periodOverrideProblem`), `components/ClosedMonthOverride.tsx`, and
  `canOverrideClosedMonth(actor)` (`expenses/reimbursements/lib.ts:79`). The model to copy is `approveExpenseAction`
  (`expenses/actions.ts:298-322`) and the mount on `expenses/[id]/page.tsx:95-99, 261-266`.

### DEF-582 (🔸) — a supplier return says nothing
- Confirmed. `recordReturnAction` (`apps/erp/src/app/inventory/returns/actions.ts:27-54`) calls `revalidatePath`
  and returns. No `ok` banner, though the page renders one (`page.tsx:134-138`).
- ✎ **Wider than the register:**
  - `refundCreditAction` (`:78-98`), on the same screen, is silent the same way.
  - Both actions **throw** on a refusal (`throw new Error(result.reason)`, `:51`, `:95`), and a domain
    `refuse()`/`AuthorizationError` is not caught. A production build shows a thrown server-action error as a digest
    (the file's own comment at `:61-62`). So a refused return or refund shows no sentence either.
  - `voidReturnAction` (`:56-76`) already does it right: try/catch, `?error=`, `?ok=`, store kept. That is the pattern.
- ✎ `apps/erp/src/app/trade/returns/actions.ts` `recordReturnAction` (`:27-51`) and `applyCreditAction` (`:75-92`)
  have the same fault on the customer-returns screen. **Not in this task** (N1).

### DEF-583 (🔸) — the variance banner lags a handover
- The banner (`apps/erp/src/app/remittance/page.tsx:185-205`) is server-rendered from `openVariances` and
  `openVarianceCountForOrg` (`remittance/lib.ts:91-111`), plain reads, no cache. The page is `force-dynamic` (`:33`).
- `createRemittanceAction` (`remittance/actions.ts:59-184`) redirects with `back()` and **never calls
  `revalidatePath`**. The other three actions (`reverseRemittanceAction` `:186-198`, `resolveVarianceAction`
  `:201-255`, `setCashPolicyAction` `:266-284`) do not either. Each one changes what the page shows.
- Next 16.3.2's own guide says to call `revalidatePath` before `redirect` when the destination needs fresh data
  (`node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:504`; `02-guides/server-actions.md:72`).
- ⚠️ **The cause is NOT confirmed.** A `force-dynamic` page re-rendered by a redirect should already read fresh rows.
  So S3 reproduces first, on HEAD, in a browser, and names the cause before any edit (R7).

## Rulings (planner)
- **R1 (S1). The bills screen reuses T-369's override, unchanged.** Same capability (`override_period_lock`,
  authorised inside `postEntry` against the domain function's own `actor`), same `period_overrides` row, same typed
  reasons, same helpers, same component, same refusal sentences. No new capability, no new table, no new sentence
  for the refusals.
  - **Ian's Q3 (a) covers it.** It put "expense approval" behind the override, and since T-196 verifying a bill IS the
    approval of its expenses. The register row says a late supplier bill is the motivating case.
  - Ian's other T-369 rulings carry over as they are: no override for stock, ever (I5). The t369-q1 ruling (a void
    may be redone by a manager, never staff) and the t369-s0 ruling (the person picks the reversal date) are about
    sales days and voids, not posting into a closed month. Nothing here touches them.
- **R2 (S1). `noPeriodOverride` is deleted, with its two sentences.** Every path now gets `approveExpense`'s ordinary
  sentences:
  - closed, no override: *"{Month} is closed. Ask an administrator to post this one entry into it."*
  - locked: *"{Month} is locked. Nothing can be posted into it, not even with the closed-month override."*
  - The bill sentence existed only because the bills screen had no override. With the override in place it would be
    false. The T-369 test leg at `:351-398` is rewritten to assert the ordinary sentence (TESTER path).
- **R3 (S1). The override reaches both AP posting paths.**
  - `verifyInvoice(tx, actor, invoiceId, attestation, options?: { periodOverride? })` passes
    `{ periodOverride: options?.periodOverride }` to `approveExpense` for EACH draft.
  - `RecordExpenseForInvoiceInput` gains `periodOverride?`, forwarded the same way.
  - `approveExpense` keeps its rule: forwarded to `postEntry` only when that expense's month is `closed`.
  - So a bill with N drafts in a closed month writes **N `period_overrides` rows**, one per entry. All have the same
    actor, reason and note. This is the table's own meaning: one row per entry.
- **R4. Verifying a bill still needs two people, override or not.** `verifyInvoice` refuses the person who logged the
  bill before it posts anything (`:676-684`), and the override changes nothing about that.
  - If the org's only admin logged the late bill: a manager verifies it with no drafts on it, then the admin records
    the expense through the record form with the override (R3). Both steps work under rules already in force.
  - A manager in an org that has an admin never gets the override (bible rows 193, 196). In an org with no admin,
    the manager holds it through the adminless fallback (row 196).
- **R5 (S1). The action forwards the override only when it applies.** Both actions follow
  `approveExpenseAction`'s order exactly:
  - read the invoice and `authorize()` the gate first (`verify_supplier_invoice` at the bill's store for verify;
    `parseExpenseForm` already authorises `create_expense` + `approve_expense` for record). T-364: nothing about
    the bill's month is said before the gate is proven;
  - then `inClosedMonth = closedMonthOf(await closedMonths(orgId), invoice.invoiceDate)`. The date is read on the
    server, never taken from the form;
  - `periodOverride = readPeriodOverride(fd)` only if `inClosedMonth`, else dropped (no audit noise);
  - `periodOverrideProblem(fd)` when `inClosedMonth`, thrown as the banner sentence.
- **R6 (S1). Where the control shows.** It goes only to `canOverrideClosedMonth(actor)` holders, and only when the
  bill's date is in a closed month:
  - on the **verify** form, when the bill is `pending` AND has at least one draft (with none, verifying posts
    nothing and needs no override);
  - on the **record** form, when it renders (`canRecord`).
  - It is mounted like `expenses/[id]/page.tsx:261-266`: a hidden `<input name="invoiceDate">` plus
    `<ClosedMonthOverride closedMonths={[closedMonth]} dateFieldName="invoiceDate" initialDate={invoice.invoiceDate}
    … />`.
  - **Copy:** `ClosedMonthOverride` gains an optional `count?: number` (default 1). With `count` 1 or absent, the
    text stays exactly as it is today (the T-369 render tests stay green unchanged). With `count` above 1:
    - summary: *"{Month} is closed — post these {n} expenses anyway"*;
    - body: *"{Month} is closed. You can post these {n} expenses into it. Each will be recorded against your name
      with the reason below."*
    - The verify form passes `count={draftExpenses.length}`. The record form passes nothing.
- **R7 (S3). Reproduce, name the cause, then fix.** The planned fix is `revalidatePath('/remittance')` immediately
  before the success `back()` in all four remittance actions.
  - If HEAD does not reproduce on 9008, the tester stops and reports. Nothing is built.
  - If it reproduces and the fix does not cure it on screen, the builder stops and reports. No second guess is
    stacked on the first (§3.4a).
- **R8 (S2). Return and refund say what happened.** Both actions take `voidReturnAction`'s shape: try/catch around
  the domain call; `{ok:false}` and a thrown error both go to `?error=` through `errorMessage`; success goes to
  `?ok=`; the store is kept (`store=<storeId>`). `revalidatePath` stays, called before the redirect.
  - Record: *"Return recorded. The stock is taken out, and the supplier owes us the credit."*
  - Refund: *"Refund recorded. The supplier's credit is reduced by what they paid back."*

## Parallel plan
| Slice | DEF | Risk | Files (BUILDER) | Shared state | Parallel-safe with |
|---|---|---|---|---|---|
| S1 | 581 | ⚠️ a late bill cannot be booked | `domain/src/expenses/approve.ts`, `domain/src/ap/index.ts`, `apps/erp/src/app/ap/actions.ts`, `apps/erp/src/app/ap/invoices/[id]/page.tsx`, `apps/erp/src/app/expenses/actions.ts` (the `recordExpenseForInvoiceAction` hunk only), `apps/erp/src/components/ClosedMonthOverride.tsx` | `period_overrides`, ledger, the lane DB | S2, S3 |
| S2 | 582 | 🔸 a silent screen | `apps/erp/src/app/inventory/returns/actions.ts` | none | S1, S3 |
| S3 | 583 | 🔸 a stale banner | `apps/erp/src/app/remittance/actions.ts` | none | S1, S2 |

- The three slices share no files.
- ⚠️ **Overlap with the uncommitted T-367 S5 work:** only `apps/erp/src/app/expenses/actions.ts`. T-367 S5
  deletes `PAYMENT_METHODS` (`:69`). S1 edits `recordExpenseForInvoiceAction` (`:268-296`, ✎X-8 ≈`:266` after T-367 S5), a different hunk.
  ✎X-8: every line number in S1 that touches `expenses/` is re-read by the builder after T-367 S5 commits.
  **S1's builder edits that file only after T-367 S5 has committed**, and re-reads the line numbers then. S1's
  tester can start now. `approve.ts` and `ap/index.ts` are clean in the tree; T-367 S5 does not touch them.
- No slice touches `POSTING-PATTERNS.md` or `tests/worked-examples/fixtures.ts`. S1 posts the same entries as
  today, into a different period, through `postEntry`'s existing override.
- Each lane runs on its own lane DB (§3.4 row 94).

## Invariants (every slice)
- I1. `authorize()` first, before any read-for-write or any sentence about the record (T-364). The ✗ is proven in the
  domain AND in the action.
- I2. No new capability. S1 uses `override_period_lock`, `verify_supplier_invoice`, `create_expense` and
  `approve_expense`, as today. S2 and S3 change no gate.
- I3. The database enforces the period. `postEntry`'s period check and the override authorisation stay the only
  enforcement. Nothing in the app decides who may post into a closed month.
- I4. The override's actor is always the domain function's own `actor`. The form supplies only `reason` and `note`.
- I5. Never on a stock screen. The allowlist test widens by exactly one file, `app/ap/invoices/[id]/page.tsx`.
- I6. Refusals a person sees carry no ids and no column names. Banners use the existing `?error=`/`?ok=` pattern.
  No `alert()`, no `confirm()`.

---

## S1: DEF-581, the closed-month override on the bills screen
**BUILDER:**
- `packages/domain/src/expenses/approve.ts`: delete `noPeriodOverride` from `ApproveExpenseOptions` and the two
  conditional sentences (`:258-271`). Keep the ordinary ones. Update the `ApproveExpenseOptions` doc comment.
- `packages/domain/src/ap/index.ts`:
  - `verifyInvoice` gains `options?: { periodOverride?: { reason: PeriodOverrideReason; note?: string | null } }`
    and passes it to every `approveExpense` (R3). Update the T-196 doc comment: a closed month is posted through the
    override when the verifier holds it; otherwise it refuses in `approveExpense`'s words.
  - `RecordExpenseForInvoiceInput` gains `periodOverride?`; `recordExpenseForInvoice` forwards it (`:887`).
- `apps/erp/src/app/ap/actions.ts` `verifyInvoiceAction` (`:237-253`): R5. Read the invoice via `apRepo`, authorise
  `verify_supplier_invoice` at its store, then apply the closed-month logic, then call `verifyInvoice` with
  `periodOverride ? { periodOverride } : undefined`. The ok sentence stays.
- `apps/erp/src/app/expenses/actions.ts` `recordExpenseForInvoiceAction`: R5, after `parseExpenseForm`. The invoice's
  date comes from `apRepo.getSupplierInvoiceById` on `parsed.supplierInvoiceId`, not from the form. **After T-367 S5
  commits.**
- `apps/erp/src/app/ap/invoices/[id]/page.tsx`: R6 on both forms. One `closedMonth` lookup, computed only for a
  holder.
- `apps/erp/src/components/ClosedMonthOverride.tsx`: the optional `count` prop (R6). Default copy byte-identical.

**TESTER:**
- `packages/domain/tests/integration/t376-s1-verify-override.test.ts` (new). Fixture from
  `t369-s5-closed-month-override.test.ts:351-398`, with a third person (staff) who LOGS the bill, so the admin may
  verify it. Lipa; January 2026 closed, February open; bill dated 2026-01-10 with **two** drafts (₱1,200 and ₱800,
  cash).
- `apps/erp/tests/integration/t376-s1-verify-override-web.test.ts` (new). Harness from
  `apps/erp/tests/integration/t369-s5-override-web.test.ts` (`submit`, `param`, the render legs).
- `apps/erp/tests/t376-s1-verify-action-drop.test.ts` (new, ✎X-1): W3b, mocked domain.
- Edit `packages/domain/tests/integration/t369-s5-closed-month-override.test.ts:351-398` (R2): expect *"January 2026
  is closed. Ask an administrator to post this one entry into it."*; keep the pending/draft/no-uuid legs. ✎X-5: also assert zero `period_overrides` rows for the org.
- Edit `tests/unit/t369-override-not-on-stock-screens.test.ts`: `ALLOWED_IMPORTERS` gains
  `app/ap/invoices/[id]/page.tsx`; the stock-directory legs are unchanged. ✎X-3: add a positive leg beside `:52-65`'s
  two, *"the bills page IMPORTS it"* (`expect(importers).toContain('app/ap/invoices/[id]/page.tsx')`), so the widened
  allowlist keeps its "must be present" half.

**Tests (domain):**
- T1 (red on HEAD): the admin verifies the January bill with `{ periodOverride: { reason: 'late_supplier_invoice',
  note: 'Bill arrived in October' } }`. Expect:
  - the bill is `verified`, both drafts are `posted`, two entries dated 2026-01-10;
  - **two** `period_overrides` rows, each with actor = the admin, the reason, the note, and
    `period_status_at_post = 'closed'`.
  - Red on HEAD: the fifth argument is ignored → the bill sentence.
  - ✎X-6: on HEAD the fifth argument does not typecheck. The red is shown by **vitest** (which does not typecheck),
    not by `tsc`. No cast (`as any`, `as never`, `@ts-expect-error`) may survive into the committed test: once S1 is
    built the call typechecks as written.
- T2 (✗): the manager (org WITH an admin) verifies with the same override → the refusal's `userMessage` reaches the
  caller through the rewrap, with no uuid. The bill stays `pending`, both drafts stay `draft`, zero entries, zero
  rows. Positive control: T1.
- T3: no override, January closed → the admin AND the manager each get *"January 2026 is closed. Ask an administrator
  to post this one entry into it."*. Bill pending, drafts draft, zero rows. Positive control: T1.
- T4: January **locked**, admin + override → *"January 2026 is locked. Nothing can be posted into it, not even with
  the closed-month override."*. Pending, zero rows.
- T5: a February (open) bill, the MANAGER verifies with an override → verified and posted, zero rows, no
  `AuthorizationError`. This is the "an open month ignores it" control.
- T6: a January bill with **no drafts**, admin + override → verified, zero entries, zero rows.
- T7 (R4, segregation): the admin who LOGGED the bill verifies it with the override → the segregation sentence
  (*"You logged this invoice, so you cannot also verify it…"*). Zero rows. Positive control: T1.
- T8 (I4): an `actor` smuggled inside `periodOverride` (cast) changes nothing. The row's actor is the caller.
- T9 (`recordExpenseForInvoice`): on a VERIFIED January bill with room left:
  - admin + override → posted, one row;
  - admin with no override → the T3 sentence, and no expense row survives (`createExpense` unwinds with it);
  - manager + override → `AuthorizationError`, no expense row, no row.
- Mutants:
  - keep `{ noPeriodOverride: true }` at `ap/index.ts:745` → T1 red;
  - forward the override to the FIRST draft only → T1 red (one row, not two; second draft refused);
  - `authorize('override_period_lock')` in `verifyInvoice` whenever an override is present → T5 red (the manager lacks the capability). ✎X-2: T6 stays green (its admin holds
    it), so T6 is not a killer for this mutant;
  - keep the bill sentence in `approve.ts` → T3 red;
  - drop the forward in `recordExpenseForInvoice` → T9 first leg red.

**Tests (web):**
- W1 (red on HEAD): admin, January bill, confirm + reason + note → the ok banner *"Verified. Expenses can now be
  recorded against it."*; two rows for the admin.
- W2: the manager submits the fields anyway → an error banner, no uuid; pending; zero rows. Positive control: W1.
- W3: a February bill with the fields → verified; **zero rows**. ✎X-1: this pins the outcome, not the action's
  drop. `approveExpense` forwards only for a closed month (`approve.ts:256`), so an open-month bill writes zero rows
  either way and "forward unconditionally" is unkillable here. The action's drop is defence in depth.
- W3b (✎X-1, unit, mocked domain): `apps/erp/tests/t376-s1-verify-action-drop.test.ts` (new; harness as S2's). A
  February invoice with a full, ticked override → `verifyInvoice` is called with no `periodOverride` (options
  `undefined`); a January invoice → called with it. Mutant: forward unconditionally → the February leg red.
- W4: confirm ticked with no reason → *"Choose a reason for posting into the closed month, or untick the
  confirmation."*; "Other" with no note → the note sentence; neither is the closed-month refusal; nothing posts.
- W5 (T-364): a staff member without `verify_supplier_invoice` submits a ticked, half-filled override on a January
  bill → the generic authorization refusal, not a closed-month or override sentence.
- W6 (render): the admin's HTML for the pending January bill with two drafts carries `data-closed-month-override`,
  the three field names, the four reason labels, and *"post these 2 expenses anyway"*. The manager's HTML carries
  none of them. Positive control: both carry the Verify button. The admin's HTML for a January bill with NO drafts
  has no marker in the verify form.
- W7 (record form): admin, verified January bill → the record form carries the marker with the singular copy;
  submitting with the override posts and redirects to the new expense; one row.
- The T-369 render and override-web tests stay green UNCHANGED (the default copy did not move).

**Migration:** none.
**Smoke (9008, `shareat_test_setup`):** use SMOKETEST.md's sign-in. Close a month with the existing period screen
(as T-369 S5's smoke did).
1. Log a bill dated in that month as one person and add a draft.
2. As the admin, open the bill: the amber panel shows with the plural or singular copy. Pick *Late supplier bill*,
   add a note, tick the box, verify → the green banner; the draft is posted.
3. `select * from period_overrides order by created_at desc limit 2` shows the row(s).
4. As a manager, on a second such bill: no panel; verifying gives *"{Month} is closed. Ask an administrator…"*.
5. The open panel at 375px and in dark mode.
Screenshots of 2, 4 and 5, and the SQL output.

---

## S2: DEF-582, a supplier return and a refund say what happened
**BUILDER:** `apps/erp/src/app/inventory/returns/actions.ts`, `recordReturnAction` and `refundCreditAction` only, per
R8. `voidReturnAction` is the model and stays untouched. The page already renders both banners. No page edit.

**TESTER:**
- `apps/erp/tests/t376-s2-return-banners.test.ts` (new). Harness from `apps/erp/tests/t369-s4f-void-actions.test.ts`:
  a `RedirectSignal` captures `redirect`, `revalidatePath` is a spy that logs its call order, the domain is mocked.
- Edit `apps/erp/tests/t374-s2-posted-dates.test.ts` `runAll` (`:42-47`): the two supplier calls now end in a
  redirect. Catch the redirect signal for those two; the captured dates and their assertions are unchanged.
  ✎X-4: the mock throws a plain `Error('redirect:…')` (`:16`), so catch ONLY an error whose message matches
  `/^redirect:/` and rethrow anything else; a blanket catch would hide a real failure.

**Tests:**
- R1 (red on HEAD): `recordReturn` → `{ ok: true }` → redirect to `/inventory/returns?store=<storeId>&ok=<R8 record
  sentence>`. Red on HEAD: no redirect at all.
- R2 (red on HEAD): `{ ok: false, reason: 'a return with no lines returns nothing' }` → a redirect with `error=`
  carrying the reason through `errorMessage`, and nothing thrown.
- R3 (red on HEAD): the domain throws `refuse(raw, 'The quantity must be a number.')` → `error=` carries the user
  sentence, not `raw`.
- R4–R6: the same three for `refundCreditAction`, with the R8 refund sentence.
- R7: on success, `revalidatePath('/inventory/returns')` is called BEFORE the redirect.
- Positive control: the existing `voidReturnAction` legs in `t369-s4f-void-actions.test.ts` stay green unchanged.
- Mutants:
  - drop `ok` from the success redirect → R1 red;
  - rethrow instead of redirecting → R2/R3 red;
  - lose `store` → R1 red.

**Migration:** none.
**Smoke (9008):**
- record a return → the green banner with the sentence, on the same store;
- refund part of a supplier credit → the green banner;
- refund more than the credit → a red banner with a sentence, no digest, no uuid.
Screenshots of each.

---

## S3: DEF-583, the variance banner after a handover
**Step 0 (TESTER, before anything is built). Reproduce on HEAD.** On 9008, at a store with an open day. ✎X-7: name the
build mode in the report. Try `next dev` first; if it does not reproduce, stop the dev server and try a production
build (`npm run build` then `next start` on 9008) before stopping under R7, since router caching differs between them:
- note the banner's count (N);
- record a handover SHORT by ₱10 → the ok banner says *"SHORT by 10.00 — recorded as an open item."*;
- read the variance banner (expect N+1), and the database count by the same rule the page uses
  (`remittanceRepo.countOpenVariances`, `repo/remittance.ts:470`: open variances on a live remittance), for that org.
- Screenshot both. Record the root cause in the slice report. If the banner shows N+1 on HEAD, stop: the defect does
  not reproduce, and the register row is re-examined (R7).

**BUILDER:** `apps/erp/src/app/remittance/actions.ts`. `revalidatePath('/remittance')` immediately before the success
`back()` in `createRemittanceAction`, `reverseRemittanceAction`, `resolveVarianceAction` and `setCashPolicyAction`.
Error paths are unchanged.

**TESTER:** `apps/erp/tests/t376-s3-remittance-revalidate.test.ts` (new). Same harness as S2. The domain and `./lib`
are mocked; `revalidatePath` and `redirect` each push a mark onto one shared array.

**Tests:**
- V1 (red on HEAD): `createRemittanceAction`, one line, the domain returns a `varianceId` → the marks are
  `['revalidate:/remittance', 'redirect:/remittance?ok=…']`, in that order.
- V2–V4 (red on HEAD): the same for reverse, resolve and set-cash-policy, on success.
- V5 (control): on a refusal, `redirect` carries `error=` (as today).
- Mutant: `revalidatePath` placed after `back()` (unreachable) → V1–V4 red.
- ⚠️ V1–V4 prove the call. **The proof of the defect is the smoke.** A unit test cannot see a stale screen.

**Migration:** none.
**Smoke (9008):** Step 0 again on the fixed build → the banner shows N+1 straight after the redirect, no reload.
Resolving that variance → the banner drops back to N straight after. Screenshots of both, beside Step 0's.

---

## Out of scope
- N1: `trade/returns/actions.ts` `recordReturnAction` and `applyCreditAction` are silent and throw on refusal, the
  same fault as DEF-582 on the customer-returns screen. The orchestrator files it.
- N2: a pre-click notice telling a non-holder that a closed-month bill will be refused. T-369's expense page has
  none either. The refusal sentence names who can do it.
- The override on AP payments, customer collections or any other screen. Q3 (b)/(c) were not chosen.
- `CAPABILITY-MATRIX.md`'s "used by" note for `override_period_lock` (it now also serves bill verification and the
  record form), the register and the bible. The orchestrator's, at wrap-up.

## Done when
- S1–S3 green. Each red is shown red on HEAD, or against its named mutant, before the build. S3's Step 0 is recorded.
- Typecheck clean. The unit suite passes, including the widened allowlist test, `domain-actions-have-callers` and
  `route-capability-coverage`. The FULL integration suite passes on a fresh gate DB before any push.
- Each slice's smoke on 9008 with screenshots. `npm run build` passes with the dev server stopped. Touched files are LF.
- Each builder touched only its BUILDER paths; each tester only its TESTER paths. S1's `expenses/actions.ts` edit
  landed after T-367 S5's commit.
- The orchestrator, at wrap-up:
  - marks DEF-581, 582, 583 fixed with hashes;
  - applies the ✎ corrections: 581 also covers `recordExpenseForInvoice`; 582 also covers the refund and the thrown
    refusals; 583's cause as S3 Step 0 found it;
  - files N1;
  - adds the matrix "used by" note.

## Questions only Ian can answer
None. Ian's T-369 Q3 (a) ("expense approval and staff reimbursement payouts … that is where late paperwork lands")
already covers bill verification, because verification is the approval of a bill's expenses (T-196). The register
names a late supplier bill as the motivating case. Who may use the override is ruled (bible rows 193, 196). The
"only admin logged the bill" route works under rules already in force (R4).

## Ruling log
- 2026-10-04, planner: R1–R8 above.
  - No migration and no new capability.
  - `noPeriodOverride` and its two sentences are retired (R2). This supersedes the T-369 S5b audit fix that added
    them as a stopgap pending this defect.
  - The census widens DEF-581 to `recordExpenseForInvoice` and DEF-582 to the refund and the thrown refusals.
  - DEF-583's cause is unconfirmed until S3's Step 0.
- 2026-10-04, independent review: CHANGES (small), applied as ✎X-1..8. X-1 W3's mutant unkillable, W3b added;
  X-2 T6 is not a killer for the authorize-when-present mutant; X-3 bills-page import leg; X-4 catch only
  `/^redirect:/`; X-5 t369 rewrite asserts zero override rows; X-6 T1's red is vitest's, no surviving cast;
  X-7 Step 0 names the build mode and tries `next start`; X-8 stale line numbers re-read after T-367 S5.
