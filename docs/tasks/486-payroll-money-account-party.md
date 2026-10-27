# T-486 — Payroll payouts carry the money account's party (e-wallet) and refuse the staff float by name

**Status:** spec written 2026-10-26 (Opus planner, AUDIT session). Source: audit finding F19 (Claude posting-paths
pass, `C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-26-claude-posting-paths-pass.md`), re-verified on origin/main
26605d1. Branch `audit/t486-payroll-money-party`. Defect DEF-776. Numbers allocated by the orchestrator (BOARD.md).

## Finding — DEF-776 (P2, money: payroll cannot post)
Four payroll payout paths credit the chosen money account's GL code with no `partyType`/`partyId`:
`packages/domain/src/payroll/index.ts:757-765` (`postPayRun`), `payroll/thirteenth-month.ts:224-232`,
`payroll/separation.ts:198-200`, and `leave/payroll.ts:243-246` (`settleSilAtSeparation`, which receives only
`moneyAccountGlCode` from `separation.ts:219-227`). `1140 E-wallet` requires party `money_account` and `1120 Cash on
hand — staff custodian` requires party `cash_request` (chart seed `packages/db/seed/chart-of-accounts.ts:133,139`;
migration 0007 `journal_lines_party_requirement`), so a run paid from either is refused by Postgres (P0001) after it was
computed. The picker (`apps/erp/src/app/payroll/lib.ts:96-103` `cashAccountsFor`) offers every active account of the
store, including both. Every sibling money path already carries the party (`ar/index.ts:579-581` and ~12 more).

## Rulings
1. **E-wallet (1140):** each of the four credits carries `partyType: 'money_account', partyId: account.id` when
   `account.glAccountCode === '1140'`, using the exact inline shape of `ar/index.ts:579-581`
   (`EXPENSE_FUNDING_ACCOUNTS.ONLINE` from `expenses/routing.ts` may name the code). `settleSilAtSeparation` takes the
   money account's id as well as its GL code (one new input field, e.g. `moneyAccountId`), so its credit can carry the
   party; its only caller is `separation.ts`.
2. **Staff float (1120):** refused BY NAME before anything is computed or posted, in `postPayRun`, the 13th-month payout
   and the separation payout, mirroring `service-charge/index.ts:69-81` (same reasoning: a float belongs to one
   person's cash request; inventing a request corrupts `floatPositionOf`). Sentence: "That account is a staff cash
   float, which belongs to one person through a cash request. Payroll cannot be paid from it. Choose an office or
   e-wallet account." Use the repo's refusal helper if these functions already use one; otherwise match the
   service-charge error style.
3. **Picker:** `cashAccountsFor` no longer offers 1120 accounts (filter on `glAccountCode !== '1120'` after the list,
   or a repo filter if one exists). The server refusal in Ruling 2 stays: the screen is never the only guard.
4. No other behaviour changes: amounts, advance-recovery lines (already carry the employee party), idempotency keys and
   the same-store checks stay as they are.
5. Open business question for Ian (does NOT block this task): should payroll ever be payable from a staff float? Today
   the answer built here is "no, choose another account" (the safe default, matching service charges).

## Tests (red first, real Postgres, a dedicated fresh *_test database; never shareat_test/shareat_dev)
- `packages/domain/tests/integration/t486-payroll-money-party.test.ts`: for each of pay run, 13th month, separation
  (with an SIL balance so `settleSilAtSeparation` posts): paid from a `1140` e-wallet account → posts, and the credit
  line carries `party_type='money_account'`, `party_id` = that account's id (today: P0001); paid from the store's
  `1120` staff-float account → refused with the Ruling 2 sentence and nothing written (no journal entry, no status
  change); paid from the office cash account → unchanged (posts, no party).
- Fixture: reuse `money-accounts-access.test.ts`'s way of finding the foundation `Cashier online`/`Staff float`
  accounts, or `ar.test.ts:81`'s e-wallet select; fresh ids so the file shares a DB safely.
- One unit or integration assertion that `cashAccountsFor` (or the repo call behind it) omits 1120.

## Files
`packages/domain/src/payroll/index.ts`, `payroll/thirteenth-month.ts`, `payroll/separation.ts`,
`packages/domain/src/leave/payroll.ts`, `apps/erp/src/app/payroll/lib.ts`, the new test file, `docs/DEFECTS-REGISTER.md`
(section E, DEF-776). Guard/census baselines only if a guard says to re-measure. Nothing else.

## Acceptance
New tests red on 26605d1 for the stated reasons, then green; existing payroll integration tests green
(`payroll.test.ts`, `thirteenth-month.test.ts`, `separation.test.ts`, `t370-owner-cap-payroll-recovery.test.ts`,
`t436-leave-payroll.test.ts`, `t436-leave-audit.test.ts`); root typecheck clean; guard/census unit files green.
