# T-597 — Money guards: cash-request settle/cancel, supplier refunds, payroll draw (DEF-885..DEF-889)

Status: SPEC (Opus), 2026-11-18. Facts verified on main `9892641`. Risk class: **high** (money). Builder: Sonnet.
No migration. No new capability. Numbers reserved: DEF-885..889, DEF-895, DEF-905. The builder adds all seven register rows in
`docs/DEFECTS-REGISTER.md` in S1 (none is there on `9892641`).

## Rulings (BOSS, 18 Nov)
1. DEF-889: **Ian ruled A** ("1 A", 18 Nov, via BOSS). Payroll follows the same draw rule as every other payout
   (bible row 154): refused when an office safe or bank account is short, warned for a cashier drawer. S5 is unblocked.
   Option C (show the verdict on the payroll preview before posting) is a named follow-up, **not in this task**.
2. The missing retired-account check in AP payment, loan payment and statutory remittance is **DEF-895**, built here as
   slice **S4b**: one helper, one refusal sentence, one test and mutant per caller. It touches
   `packages/domain/src/loans/index.ts`, which **T-593 S1 also edits: T-593 S1 must land on main first**; rebase S4b on it.
3. The builder adds register rows DEF-885..889, DEF-895 and DEF-905.
4. The two corrections to the partial work (C1 replay rule; DEF-888 comment label) stand as written.
5. Final (BOSS): the supplier-refund page also excludes the staff cash account, one line in S4.
6. Final (BOSS): the retired-account check on liability payments is **DEF-905**, in S4b with the same helper, one test
   and mutant. Owner payouts are already covered by **T-593 (DEF-874)**; not duplicated here.

## Partial work from the stopped builder — KEEP most of it

Worktree `C:\Users\ianla\webapps\shareat-system\.claude\worktrees\agent-accac474e5ea8bffa` (base `9892641`, uncommitted,
5 files, +76/-17). Copy its hunks into the new branch, then apply the corrections below.

| Hunk | Verdict |
|---|---|
| `cash-requests/[id]/page.tsx` hidden `settleId` = `crypto.randomUUID()` | Keep. `settleId`, not `requestId`: that name already carries the cash request's id on this form |
| `cash-requests/actions.ts` passes `settleId: str(formData, 'settleId')` | Keep |
| `repo/cash-requests.ts` `update(..., expectedStatus?)` with `inArray(status)` predicate + refusal | Keep |
| `index.ts` decide/release/cancel pass expected status; cancel + release take `lockForSpend` | Keep |
| `index.ts` settle: `requireRequestId`, keys on `settleId`, `postEntryOnce`, store + active checks | Keep, **fix the replay test** (C1) |
| `supplier-returns.ts` refund store + active checks | Keep |
| `supplier-returns.ts` `recordReturn` throws | Keep, **fix the comment**: it says DEF-889, it is DEF-888 |

C1. The builder's `replay` is true if EITHER key exists. A retry with the same `settleId` that adds a leg the first call
did not post (back button, edit, resubmit) would skip the status and held checks and post the new leg. Replace with:
`replay` = at least one requested leg exists under its key AND every leg this call asks for (return if `returned > 0`,
shortage if `short > 0`) already exists. A partial match is not a replay: the normal checks run.

No tests were written. Nothing else in the worktree. Do not `git worktree remove --force` it (memory: junction incidents).

## DEF-885 — settle keys on (date, amount): a second identical return posts nothing and reports success

`packages/domain/src/cash-requests/index.ts` on main:
```ts
449        idempotencyKey: `cash-request:${req.id}:return:${input.on}:${returned}`,
479        idempotencyKey: `cash-request:${req.id}:shortage:${input.on}:${short}`,
```
Confirmed real: two ₱500 returns on one day → `postEntry` answers `created:false` with the first entry, the action says
"Recorded". Change (pattern T-488/DEF-777, `packages/domain/src/ledger/replay.ts`):
- input gains `settleId: string`. After `assertFieldRules` (line 381): `const settleId = requireRequestId('settleCashRequest', input.settleId);`
  (refusal sentence comes from the helper: "This form is out of date. Reload the page and try again.").
- keys `cash-request:${req.id}:return:${settleId}` and `cash-request:${req.id}:shortage:${settleId}`; both `postEntry` →
  `postEntryOnce` (same id + different figures or date → "This was already recorded with different figures…").
- replay probe via `journalRepo.findEntryByIdempotencyKey` before the status check (C1 rule); on replay skip the status
  and held refusals; set `liquidated` status only `if (liquidated && req.status === 'released')`.
- Lock order unchanged: request row (`lockForSpend`, line 377) first, then postings.
- Old entries keep their old keys; nothing reads the key shape (grep `:return:` finds only this file).

Callers (every one must pass `settleId`; tests mint `crypto.randomUUID()` per call):
- `apps/erp/src/app/cash-requests/actions.ts:119`; form `apps/erp/src/app/cash-requests/[id]/page.tsx:225` (hidden input).
- `packages/domain/tests/integration/cash-requests.test.ts:259,338,350,495`; `t414-s1-cash-request-approve.test.ts:435`;
  the shared `settle` helper at line 170/172 of `t415-ap-payment-float`, `t415-release-staff-account-warning`,
  `t415-settle-lock`, `t415-void-float` (`.test.ts`); `apps/erp/tests/integration/t343-s5-5s-followups.test.ts:425,452,471,497,859`.

## DEF-886 — settle takes the returned cash into any account

Main lines 441-442: `const account = await moneyAccountsRepo.getById(...); if (!account) throw new Error(...)` — then posts.
Release refuses another store's account (257-266) but, **correction to the finding**, release does NOT check `isActive`
either. Change, in both settle (after 442, skipped on replay) and release (after 266):
- `account.storeId !== req.storeId` → `refuse(raw, "That money account belongs to another store. Choose one of this store's accounts for the returned cash.")` (release keeps its existing throw).
- `!account.isActive` → `refuse(raw, '"<name>" is retired and cannot take the returned cash. Choose another account.')`;
  release: `'"<name>" is retired. Choose another account to release from.'`
- Capability: none added. Settle already authorizes `approve_expense` at `req.storeId` (line 379), the same gate release
  uses; a same-store account keeps that gate sufficient (bible row 153 is about cross-store, which is now refused).
- The picker (`cash-requests/lib.ts:73`, `listMoneyAccounts` store + active only) already hides both; this closes a crafted POST.

## DEF-887 — cancel racing release leaves the float stuck in 1120

Main: `cancelCashRequest` line 183 `const req = await cashRequestsRepo.getById(...)` (no lock), 192 `update(...)`;
`packages/db/src/repo/cash-requests.ts:100-113` `update` matches only `id` + `org_id`. Release 218 also reads unlocked.
Confirmed: both read `approved`; release posts DR 1120 and sets `released`; cancel's UPDATE waits on the row, then
overwrites with `cancelled`. Change:
- cancel (183) and release (218): `const [req] = await cashRequestsRepo.lockForSpend(trx, actor.orgId, [input.requestId]);`
- repo `update(tx, orgId, id, values, expectedStatus?)` adds `inArray(status, expected)`; 0 rows + row exists →
  `refuse(raw, 'This cash request was changed by someone else a moment ago. Reload the page and look again.')`
  (`refuse` from `packages/db/src/refusal.ts`). Pass: decide `'requested'` (123,148), cancel `['requested','approved']`,
  release `'approved'` (332), settle `'released'` (511).
- Cancel's status throw (187-191) → `refuse(raw, 'This cash request has already been released, so it cannot be withdrawn. Record what comes back instead.')`.
- Lock order everywhere: cash request row, then money account (`checkDraw`). Same as AP `ap/index.ts:1256→1288` and
  `expenses/approve.ts:221→250`. No new deadlock pair.
- Other `cashRequestsRepo.update` callers: only this file (grep). The new parameter is optional.

## DEF-888 — supplier refund into any account; recordReturn commits half a return

`packages/domain/src/stock/supplier-returns.ts` main 473-474 fetches the account and posts. Change after 474 (outcome
style, matching the function): other store → `{ ok:false, reason: "That money account belongs to another store. Choose one of this store's accounts for the refund." }`;
retired → `{ ok:false, reason: '"<name>" is retired and cannot receive the refund. Choose another account.' }`.
Capability: none added (`apply_supplier_credit` at `input.storeId`, line 457, covers a same-store account).
Page: `apps/erp/src/app/inventory/returns/page.tsx:108-112` picks the first store cash account with no active filter;
add `eq(schema.moneyAccounts.isActive, true)` or the page can hand the domain a retired account forever, and
`ne(schema.moneyAccounts.custodian, 'staff')` (ruling 5: a staff float's 1120 line needs a cash-request party, so a
refund into it fails). Web test: the page's hidden `moneyAccountId` is never a retired or staff account.

`recordReturn` main line 232 `if (!result.ok) return result;` runs inside the line loop after earlier lines' `consume()`
wrote stock movements; the action's transaction commits them. Change to
`if (!result.ok) throw refuse(\`recordReturn: ${result.reason}\`, result.reason);` (same as `voidReturn`, line 408).
The action (`inventory/returns/actions.ts:41-60`) already turns a thrown refusal into the banner. The UI sends one line,
so production reach is multi-line callers; the fix is still right.

## DEF-895 — AP, loan and statutory payouts draw on a retired account (slice S4b)

Add to `packages/domain/src/money-accounts/overdraft.ts` (next to `checkDraw`, re-exported the same way):
```ts
export function assertActiveAccount(account: { name: string; isActive: boolean }, fn: string): void {
  if (!account.isActive) throw refuse(`${fn}: money account "${account.name}" is retired.`, `"${account.name}" is retired. Choose another account to pay from.`);
}
```
Call it right after the not-found check, before any cross-store `authorize` or position read:
- `packages/domain/src/ap/index.ts:1189` (`recordPayment`, after `if (!account) throw gone(...)`). Not at 1491 (void reads
  the original account; a void must still work after retirement).
- `packages/domain/src/loans/index.ts:235` (`recordLoanPayment`). Not at 138 (`disburseLoan` puts money IN; out of scope).
- `packages/domain/src/payroll/statutory-payments.ts:228` (`recordStatutoryPayment`, before `assertPayrollMoneyAccount`).
- DEF-905: `packages/domain/src/liabilities/index.ts:203` (`payLiability`, after `if (!account) throw ...`).
- Owner payouts: not here, T-593 (DEF-874) covers them.
Tests, `packages/domain/tests/integration/t597-retired-account.test.ts`: per caller, an active funded account posts
(positive); the same account retired (`update money_accounts set is_active = false`) → refused with the sentence, no
entry, no payment row. Mutant: delete that caller's call → its case goes red. S5 reuses the same helper for payroll.

## DEF-889 — payroll pays from an account without checkDraw or an active check (S5: option A, Ian 18 Nov)

Main: `payroll/index.ts:684-689`, `thirteenth-month.ts:179-184`, `separation.ts:157-162` each do getById → store match
→ `assertPayrollMoneyAccount`, then post (`index.ts:794`, `thirteenth-month.ts:242`, `separation.ts:210`). AP, loans,
liabilities, owners, statutory call `checkDraw`. **Correction:** none of AP, loans or statutory checks `isActive` either;
only reimbursement, money-transfers, channel settlements, POS day-close and sales days do. Fixed as DEF-895 (S4b).

### Options (for Ian, plain words)
- **A. Same rule as every other payout (row 154). Recommended.** Office safe or bank short → the run is refused with
  the existing sentence ("…record the money coming in first…"). Cashier drawer short → it posts and warns.
  Cost: on payday someone must first record the transfer into the paying account (a minute), then post.
  Why: an office balance is complete; if it cannot cover wages, either a transfer is unrecorded or the money is truly
  not there. Paying anyway makes the safe read negative and hides the missing transfer.
- **B. Payroll always warns, never refuses.** Payday is never blocked, but the safe can go negative and the one rule
  "overdraft belongs to the account, not the screen" (row 154) breaks. Needs a new bible row from Ian.
- **C. A, plus show the verdict on the payroll preview before posting** (`judgeDraw` is client-safe), so a shortfall is
  seen days ahead. Best, but it is screen work: a follow-up task, not this one.

### Change (option A)
After `assertPayrollMoneyAccount` in each function:
- `assertActiveAccount(account, '<fn>');` (the S4b helper; same sentence).
- `const warning = await checkDraw(trx, actor.orgId, account, <cashOut>, '<fn>');` where cashOut is exactly what is
  credited to the account: pay run = sum of `slip.netPay` > 0 over `preview.slips`; 13th month = sum of positive
  `payout.netPay`; separation = `netPay` if > 0 (skip the call at zero). Checked BEFORE `insertPayRun` /
  `insertThirteenthMonthRun` / `insertPostedSeparation`, so a refusal writes nothing. Lock: `checkDraw` locks the account.
- Return `warning?: string` from all three; actions append ` ⚠️ ${warning}` like `cash-requests/actions.ts:101`:
  `apps/erp/src/app/payroll/actions.ts:68`, `payroll/thirteenth-month/actions.ts:42`, `payroll/separations/actions.ts:60`.
- Out of scope: the separation's SIL cash-out inside `settleSilAtSeparation` (`leave/payroll.ts:201`) is a second draw
  not counted here.

### Fixture fallout (the big part of S5)
Every payroll test pays from the store's unfunded foundation office account, so option A refuses them all. Add
`packages/domain/tests/integration/_fixtures/fund-account.ts` (move the `fundAccount` body from
`t415-settle-lock.test.ts:57-72`; for `1140` add party `money_account`) and fund the paying account (`'10000000.00'`)
in each fixture: `payroll.test.ts`, `separation.test.ts`, `thirteenth-month.test.ts`, `t190-def670-671`,
`t190-statutory`, `t370-owner-cap-payroll-recovery`, `t431-unpaid-liabilities`, `t436-leave-audit`,
`t436-leave-payroll`, `t486-payroll-money-party`, `t519-s1-deduction-agreements`, `t521-deduction-limit-per-run`,
`t555-agreement-signed-on` (domain), `apps/erp/tests/integration/t343-s5-5q-followups`, `t500-pg-rates-page`.
Fund on a date inside an open period; if a test counts journal entries, adjust its count, never drop the assertion.

## Tests (each refusal: positive case, refusal case, mutant shown red; quote the red in the PR)

`packages/domain/tests/integration/t597-cash-request-guards.test.ts` (fixture: copy `t415-settle-lock.test.ts` 1-170):
1. two settles, two `settleId`s, ₱500 each, same day → two return entries, outstanding drops ₱1,000. Mutant: key back on
   `${input.on}:${returned}` → red.
2. same `settleId` twice, sequential → one entry, second returns the same `entryIds`, no refusal. Then same id, different
   amount → "already recorded with different figures". Same id, adds a shortage → normal checks run (C1). Missing or
   garbage `settleId` → "This form is out of date…", nothing written.
3. concurrent: same `settleId` via `heldRace` (`_fixtures/held-race.ts`) → one entry.
4. settle into another store's account → refused, no entry; retired account → refused; same-store active → posts.
   Release from a retired account → refused. Mutant: delete each check → red.
5. concurrent: release held open vs cancel → cancel waits, refused "already released"; status `released`; 1120 holds
   the amount. Reverse: cancel held open vs release → release refused; no entry; status `cancelled`.
   Mutant: cancel back to `getById` AND `update` without expected status → red.
6. repo: `update` with a stale expected status → the "changed by someone else" refusal; unknown id → `recordGone`.

`packages/domain/tests/integration/supplier-returns.test.ts` (extend):
7. refund to another store's account / retired account → `ok:false` with the sentence, 1240 unchanged; positive is
   the existing "a cash refund draws 1240 to zero" (538).
8. two-line return, second line short → throws; on-hand of line 1 unchanged; no `supplier_returns` row. Mutant: restore
   `return result` → red. Existing case at 392-409 ("more than ON-HAND") becomes `rejects.toThrow(<sentence>)`;
   re-run 378, 650-660, 685-695 and `t512-duplicate-item-lines.test.ts` and convert only cases that now throw.

`packages/domain/tests/integration/t597-payroll-draw.test.ts`:
9. each of postPayRun / post13thMonthRun / postSeparation: funded office → posts; unfunded office → refused with the
   `judgeDraw` office sentence and no run/payout/separation row, no entry; cashier account short within limit → posts
   with `warning`; retired account → refused. Mutant: delete the `checkDraw` call → red; delete the active check → red.

`apps/erp/tests/def778-form-request-id.test.ts` (extend): page source has `name="settleId" value={crypto.randomUUID()}`;
`cash-requests/actions.ts` passes `settleId: str(formData, 'settleId')`.

## Census pins and guards to re-run (re-measure, never hand-edit)
- `tests/unit/t343-throw-ratchet.test.ts`: `packages/domain/src/cash-requests` ceiling 16 → re-count (cancel's throw
  becomes `refuse`, expect 15) and lower it; `payroll` 34 and `stock` 8 must not rise (all new refusals use `refuse()`).
- `apps/erp/tests/t384-s3-lock-and-save-guard.test.ts` + `editable-record-baseline.json` (`cash-requests/[id]/page.tsx`: 3):
  the new hidden `settleId` sits in an existing form; the count must stay 3.
- `apps/erp/tests/t542-no-dev-markers-on-screen.test.ts` (the page is listed): DEF codes only inside `{/* */}` comments.
- `tests/unit/t371-numeric-write-guard.test.ts` (scans `cash-requests/index.ts`), `packages/domain/tests/t502-s1-service-readers.test.ts`.

## Out of scope
`isActive` on owner payouts (T-593, DEF-874) and on loan disbursement; the payroll preview verdict (option C, named follow-up); the separation
SIL draw; cross-store float funding (T-144 §6).

## Build order (one commit per slice; one PR)
- S1 DEF-887: repo `expectedStatus`, locks in cancel/release, cancel `refuse`, tests 5-6, register rows if missing.
- S2 DEF-885: `settleId` domain + form + action + C1 replay rule, all 19 caller updates, tests 1-3, def778 case.
- S3 DEF-886: settle + release store/active checks, test 4.
- S4 DEF-888: refund checks + returns page active filter + `recordReturn` throw, tests 7-8.
- S4b DEF-895 + DEF-905: `assertActiveAccount` helper + AP/loan/statutory/liability calls + `t597-retired-account.test.ts`.
  **Waits for T-593 S1 on main** (shared `loans/index.ts`).
- S5 DEF-889 (option A, ruling 1): shared `fund-account` fixture + 15 fixtures funded (commit alone first, suite still green), then
  payroll active + `checkDraw` + warning in actions, test 9.
- S6 Opus verify: ratchet re-measure, mutants, typecheck.

Commands (no dev server; stop any before building; never `next build` here):
```
npx tsc --noEmit -p packages/domain && npx tsc --noEmit -p apps/erp
npx vitest run --project unit tests/unit/t343-throw-ratchet.test.ts tests/unit/t371-numeric-write-guard.test.ts apps/erp/tests/def778-form-request-id.test.ts apps/erp/tests/t384-s3-lock-and-save-guard.test.ts apps/erp/tests/t542-no-dev-markers-on-screen.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/t597-cash-request-guards.test.ts packages/domain/tests/integration/cash-requests.test.ts packages/domain/tests/integration/t414-s1-cash-request-approve.test.ts packages/domain/tests/integration/t415-*.test.ts apps/erp/tests/integration/t343-s5-5s-followups.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/supplier-returns.test.ts packages/domain/tests/integration/t512-duplicate-item-lines.test.ts packages/domain/tests/integration/t488-request-id-keys.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/t597-payroll-draw.test.ts packages/domain/tests/integration/payroll.test.ts packages/domain/tests/integration/separation.test.ts packages/domain/tests/integration/thirteenth-month.test.ts packages/domain/tests/integration/t190-*.test.ts packages/domain/tests/integration/t370-owner-cap-payroll-recovery.test.ts packages/domain/tests/integration/t431-unpaid-liabilities.test.ts packages/domain/tests/integration/t436-*.test.ts packages/domain/tests/integration/t486-payroll-money-party.test.ts packages/domain/tests/integration/t519-s1-deduction-agreements.test.ts packages/domain/tests/integration/t521-deduction-limit-per-run.test.ts packages/domain/tests/integration/t555-agreement-signed-on.test.ts apps/erp/tests/integration/t343-s5-5q-followups.test.ts apps/erp/tests/integration/t500-pg-rates-page.test.ts --maxWorkers=2
```
Full suite runs in CI on the PR (memory: PR route).

## Open questions (each with a recommendation)
1. DEF-889 refuse or warn? **ANSWERED: A** (Ian, "1 A", 18 Nov). Follow-up task to open: option C, the payroll preview
   shows the `judgeDraw` verdict for the chosen account before posting.
2. Should settle/refund demand `transfer_funds` on top of the existing gate? **Recommend no**: same-store only, and the
   existing gate is the one release and refunds already use.
3. Refund page may pick the staff float? **ANSWERED** (BOSS, ruling 5): exclude it in S4, one line.
4. Retired-account check on liabilities and owner payouts? **ANSWERED** (BOSS, ruling 6): liabilities = DEF-905 in S4b;
   owner payouts = T-593 (DEF-874).
