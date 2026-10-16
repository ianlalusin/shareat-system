# T-414: an expense shows every open cash request at its store, and approve cannot over-spend one

**Status:** SPEC 2026-10-16 (Opus planner). Branch `lane/t414` from `main` `a879264`.
**Model:** Sonnet lanes, tester first, then builder (bible row 184). Money path: Sonnet, not Haiku.
**Migration:** none. `expense_payments.money_account_id` is nullable with no CHECK (0025, 0141). Next free number unchanged.
**Source:** Ian, live, 16 Oct: a store with a RELEASED cash request; New expense does not offer it under Paid from.
*"It must show all open cash requests, filtered by coverage based on balance."*

## Diagnosis (verified at `a879264`)
- Floats reach the Cash row's Paid from `<Select>` (`apps/erp/src/components/money/MoneyLines.tsx:281-315`) from
  `loadMoneyLines` -> `openFloatsFor` (`apps/erp/src/lib/money-lines/load.ts:59-99`). Open = `status='released'`
  (`packages/db/src/repo/cash-requests.ts:210-222`); balance = 1120 ledger by party (`:174-207`); outstanding <= 0 dropped
  (`load.ts:96`); grouped covers / short / empty by `groupSourcesByCoverage` (`packages/domain/src/shared/money-lines.ts:265-280`).
- **A. Wrong store's list.** `apps/erp/src/app/expenses/new/page.tsx:35,40` load sources once for `?store=` or the FIRST
  store. The Store `<Select name="storeId">` (`:92`) is uncontrolled: picking another store keeps store 1's list. The
  action reloads for the submitted store (`apps/erp/src/app/expenses/actions.ts:203`), so a float shown would be refused anyway.
  The invoice picker (`page.tsx:32`, `listOpenInvoicesForPicker(orgId)`) has the same flaw: org-wide, but `actions.ts:188`
  refuses an invoice from another store.
- **B. No staff account, no floats.** `load.ts:70-71` returns `[]` when the store has no staff-custody cash money account.
  `releaseCashRequest` never needs one (`packages/domain/src/cash-requests/index.ts:263-285` debits 1120 directly), and
  routing takes the GL code only from `moneyAccountGlCode` (`packages/domain/src/expenses/routing.ts:166-171`).
- **C. Over-spend at approve.** Amount <= outstanding is checked only at create (`money-lines.ts:376-385`, re-run at
  `actions.ts:208`). `approve.ts:176-178` checks money accounts only. Two drafts can each pass on one ₱1,000 float and both post.
- **v1 (requirements, not design):** `ERP-rebuild/src/components/payments/CashRequestPicker.tsx:52` store-scoped, open
  only, refetches on store change; `lib/financial/cash-request/picker-options.ts:19-29` remaining > 0, label
  "{requester} - Balance: ₱{remaining}". v2 keeps the goal; the balance is the ledger, not a stored column.

## Other screens (census `grep -rln "loadMoneyLines\|<MoneyLines" apps/erp/src`)
| Screen | Store | Verdict |
|---|---|---|
| `expenses/new/page.tsx` | user-chosen `<Select>` | **Bug A** — fixed here |
| `ap/invoices/[id]/page.tsx:60,496` | fixed: `invoice.storeId`, hidden input | Not affected by A; gets B and the label for free |
| `expenses/[id]`, `expenses/reimbursements`, `expenses/recurring` | — | Do not use MoneyLines; no float source. Out of scope |
Re-run the grep at S1 start; a new caller with a store select joins S3.

## Rulings
1. **Store first, by `?store=` navigation (the boring standard).** The Store picker moves OUT of the expense form into a
   `<FilterRow submitLabel="Use this store">` (`apps/erp/src/components/FilterRow.tsx`, GET) above it; the expense form
   carries `storeId` as a hidden input. Why: it is the app's existing filter pattern (26 pages), the server already reloads
   per store, it needs no client fetch route and no new API surface, and the page and the action then read the SAME list.
   Typed values are NOT carried across a store switch: T-380 forbids typed values in the URL and T-389's keep is for
   refusals only. The store is the first decision; the PageDescription says "Pick the store first."
   A refused save still keeps typing (T-389) and returns to the same `?store=`. Rejected: a server-fetched source list
   (new route, second loader path, client cache that can disagree with the action).
2. **Invoice picker follows the store.** `listOpenInvoicesForPicker` gains an optional `storeId` filter; the page passes it.
3. **Floats show regardless of a staff account.** `openFloatsFor` no longer gates on `staffAccounts[0]`. A float's
   `moneyAccountId` is the store's staff account when one exists, else `null`. Routing: a `cash` leg with a
   `cashRequestId` and no money account credits **1120** at the expense's store, party `cash_request` = that request.
   A cash leg with neither still refuses (`routing.ts:166`). The validator keys floats by `float:<id>` already (`:176-182`).
4. **Label:** `"{holderName} · cash request — Balance ₱{outstanding}"` for a float option. Accounts unchanged.
5. **Ordering:** existing covers / short / empty groups (`groupSourcesByCoverage`); within a group, holder name A-Z. Every
   open float with outstanding > 0 shows; "empty" never holds a float (they are dropped). No new grouping.
6. **Approve re-checks every cash-request leg against LIVE outstanding**, inside the approve transaction, before posting:
   lock each named request `SELECT ... FOR UPDATE` (new repo fn `lockForSpend(tx, orgId, ids)`, ids sorted to avoid
   deadlock), require `status='released'` and `storeId === expense.storeId`, then read `floatPositionOf` AFTER the lock and
   compare the SUM of this expense's legs per request (exact centavos, `add`) to outstanding. Cash-request legs are
   excluded from `drawnPerAccount`/`checkDraw` (the per-request check replaces it; no double refusal).
7. **Refusal sentence** (via `refuse(log, userReason)`): `"{holder}'s cash request has {₱outstanding} left — this expense
   draws {₱drawn} from it. Lower the amount or pay the rest another way."` Not released: `"{holder}'s cash request is no
   longer open ({status}). Pick another source."` The expense stays a draft.

## Invariants (each with the mutant that must turn a test red)
- I1 The list is the chosen store's. Mutant M1: page ignores `?store=` and uses `storeRows[0]`.
- I2 Page list === action list for the same store. M2: action loads sources for `storeRows[0]` instead of the posted id.
- I3 A store with a released float and NO staff account offers it. M3: restore the `if (!floatAccount) return []` gate.
- I4 Such a float posts: credit 1120, party = request, at the expense store. M4: routing drops the party on the null-account path.
- I5 Drained float (outstanding <= 0) is not offered. M5: change `> 0` to `>= 0` at `load.ts:96`.
- I6 Two drafts of ₱600 on one ₱1,000 float: first approves, second refused with the I7 sentence. M6: delete the approve check.
- I7 Two legs of ₱600 on one float in ONE expense refused at approve. M7: compare per leg, not summed per request.
- I8 Concurrent approves of the two drafts (two connections): exactly one posts. M8: drop `FOR UPDATE` (test must use two
  real transactions with a barrier; a sequential test does not catch M8).
- I9 Liquidated / cancelled request at approve refuses. M9: drop the status check.
- I10 Option label exact text. M10: revert to `· float`.
- I11 Invoice picker shows only the chosen store's invoices. M11: drop the `storeId` filter.

## Slices (tests first; tester commits red, builder makes green)
- **S1 domain + repo (I4, I6-I9).** TESTER: `packages/domain/tests/integration/t414-s1-cash-request-approve.test.ts`,
  `packages/domain/tests/unit/t414-s1-routing-float-null-account.test.ts`. BUILDER: `packages/db/src/repo/cash-requests.ts`
  (`lockForSpend`), `packages/domain/src/expenses/approve.ts`, `packages/domain/src/expenses/routing.ts`.
- **S2 loader + label (I3, I5, I10).** TESTER: `apps/erp/tests/integration/t414-s2-money-lines-floats.test.ts`, extend
  `apps/erp/tests/t353-money-lines-first-paint-render.test.ts` for the label. BUILDER: `apps/erp/src/lib/money-lines/load.ts`,
  `packages/domain/src/shared/money-lines.ts` (FloatOption `moneyAccountId: string | null`), `MoneyLines.tsx` option text.
- **S3 page (I1, I2, I11).** TESTER: `apps/erp/tests/integration/t414-s3-expense-store-first.test.ts` (renders page for
  `?store=B`, posts the action, asserts list equality). BUILDER: `apps/erp/src/app/expenses/new/page.tsx`, the invoice
  picker repo fn (find with grep; one optional arg), `apps/erp/src/app/expenses/actions.ts` only if I2 needs it.
- Each slice: run every named mutant, record red/green in the hand-back. Grep the diff for leftover mutants before commit.

## Done when
- All I1-I11 tests green; each mutant shown red. `npm run typecheck`, lint and the affected suites green; census counts
  re-pinned if a sweep moves.
- Browser check on **9008** at **390** and **1280** wide: store B (released float, no staff account) -> Use this store ->
  Cash -> Paid from lists "Name · cash request — Balance ₱X" under the right band; switch to store A, list changes; save a
  draft; approve two over-spending drafts, second shows the I7 sentence. Screenshots in the hand-back; no horizontal scroll at 390.
- DEFECTS-REGISTER: one entry for A+B+C (next free DEF number), closed by this task. No bible change needed.

## Not in scope
Return/shortage paths' locking (if `returnCashRequest` does not lock the request row, log it as a finding, do not fix);
v1; the reimbursement and recurring screens.

## Ruling R-AUTO (Ian, 2026-10-16; binding, supersedes "floats shown regardless of a staff account")
**Releasing a cash request creates the store's staff cash account if the store has none,** in the SAME transaction as the
release, so the released money always has a place to go. The account is a normal money account: custodian `staff`,
instrument `cash`, the store's, named "Staff cash — <store name>", on the existing staff-custody GL account the current
float routing uses; it is audited (`money_account.created`, source = the release, actor = the releasing user) and is
idempotent (two releases at once create ONE account: take a lock on the store's money accounts, or rely on a unique
constraint if one exists — check; no migration unless unavoidable). `load.ts` keeps requiring the account, which now
always exists after a release. Existing released requests at stores with no account (production may have some): the
loader shows them anyway AND the next release or a one-off backfill creates the account — the builder adds a
read-only count to the Done-when so Ian can see how many stores are affected before deploy.
