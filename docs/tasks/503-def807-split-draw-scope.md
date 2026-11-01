# T-503: DEF-807 — a split expense judges each balance pool once, not once per account

**Status:** SPEC 2026-11-01 (AUDIT, from Codex 31st-pass finding `expense-split-draws-not-grouped-by-balance-scope`, audit id F37).
Numbers: T-503 / DEF-807 given by BOSS 1 Nov. Tests first (Sonnet tester), then builder, then audit.

## 1. The problem in plain words

`approveExpense` judges "can this money account cover it" per money account (`approvalDraws` sums a split per account id;
the drawers loop reads one `available` per account; `approvalVerdict` judges each account's own `drawn` against it). For a
cash account (1110 / 1120 / 1130) `moneyAccountsRepo.balanceOf` is not the account's own balance: it is the whole pool of
(org, store, GL code). Two active accounts in one pool therefore both read the same figure. A single split expense of
700 + 700 over a pooled 1,000 passes both checks, and the pool ends at −400. T-501 locks concurrent draws (D6/D7) but no
test covers several account ids inside ONE expense, and a lock cannot help: there is no competitor.

Reach is narrow: `createMoneyAccount` refuses a second ACTIVE cash account per (store, custodian). It can still happen when two
creates race, when an old retired account is named by an older draft (approve has no `is_active` check), or after a seed,
import or direct insert (T-501 D7 builds it by direct insert). 1140 wallets are party-scoped (one total each) and are unaffected.

## 2. Rulings

- **R1.** The balance decision groups the accounts a split draws from by **balance scope**: (org, store, GL code) for 1110 /
  1120 / 1130; the account id alone for 1140 (the same definition `balanceOf` and T-501 A2's `lockForDraw` use). Each group's
  total drawn (the sum of its accounts' draws, plus what earlier drafts of the same invoice already carry in the verify
  cascade, per account) is judged ONCE against that scope's one `available` figure.
- **R2.** A group of one account is judged exactly as today, same message, same account name. A group of several is judged
  with `judgeDraw` as one account named "A + B" (names joined), the custodian of the non-cashier member if any (blocking beats
  warning), and the SMALLEST overdraft limit among them. Never widen a limit.
- **R3.** The same grouping applies to `approvalWarnings` (a cashier pool shows one warning, not one per account).
- **R4.** `previewInvoiceDrafts` (the verify cascade) already carries draws per account id; with R1 the carried amounts of
  same-scope accounts add up in the group, so a second draft that tips the pool is named.
- **R5.** No migration, no new table, no change to `judgeDraw` or `lockForDraw(s)`. Fix only in `expenses/approve.ts`.
- **R6.** Out of scope (separate decision): a race-proof "one active cash account per store and custodian" constraint.

## 3. Tests (real Postgres on a dedicated `_test` database; written first, see `tests/integration/t503-split-draw-scope.test.ts`)

| Id | Case | Expected | Kills |
|---|---|---|---|
| S1 | Two same-store 1130 safes, pooled 1,000, one split expense 700 + 700 | approve is refused (`RefusalError`), expense stays draft, no journal entry, pool still 1,000 | per-account judging kept |
| S2 | Same, 500 + 500 | posts, pool ends 0 | refusing too much (positive control) |
| S3 | Two 1140 wallets, each holding its own 1,000, 700 online from each | posts, each wallet ends 300 | grouping 1140 by GL code (wallets must stay separate) |
| S4 | Verify cascade: two drafts on one invoice, 700 from each of two same-store safes, pool 1,000 | first draft's verdict is null, second is blocked | carried draws not summed per scope |
| U1-U3 | Pure `judgeDrawers`: single account unchanged; pool sums; pool uses smallest cashier limit and blocks if any member is non-cashier | exact messages / flags | R1, R2 |

Existing T-501 D1-D8, A4 and the t475 / expenses suites stay green.

## 4. Fences
Write only: `packages/domain/src/expenses/approve.ts`, the two new test files, this spec, the DEF-807 register row.
