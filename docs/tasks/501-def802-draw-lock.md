# T-501: DEF-802 — a refused draw speaks to staff, and two draws cannot both pass

**Status:** SPEC 2026-10-30 (orchestrator, Opus). Sonnet tester first, then Sonnet builder, then Sonnet auditor.
**Defect:** DEF-802 (orchestrator, 29 Oct, found while building T-193).

## 1. The problem in plain words

`checkDraw` (`packages/domain/src/money-accounts/overdraft.ts:46`) is the one rule for "may this account give up this
money" (bible row 154). It has two faults:

1. **It throws a plain `Error`** with developer text (`"<context>: <message>"`), so a refused draw shows staff a
   function name, and it slips past the refusal plumbing every other refusal uses (`refuse()`,
   `packages/db/src/refusal.ts`).
2. **It reads the balance without locking the account.** Two draws on the same non-cashier account at the same moment
   each read the same balance, each pass, and together they overdraw an account the rule says can never go negative.

## 2. Rulings

- **R1.** A blocked draw is a `refuse(...)` whose user sentence is `verdict.message` (already plain words, from
  `judgeDraw`), with the `context` kept only in the developer detail. The throw ratchet must go DOWN by one, never up.
- **R2.** Before reading the balance, `checkDraw` locks the money account row (`SELECT … FOR UPDATE` through a new
  `moneyAccountsRepo.lockForDraw(tx, orgId, accountId)` in the repo; no SQL outside `packages/db/src/repo/`). The lock
  is held to the end of the caller's transaction, so the second draw waits, then reads the balance including the
  first draw's posting.
- **R3.** Lock order. If any caller draws from **more than one** money account in one transaction, it must lock them
  all first in ascending id order (a `lockForDraws(tx, orgId, ids[])` helper), then call `checkDraw` for each. The
  builder lists every `checkDraw` caller (12 files today: ap, cash-requests, expenses/reimbursement, liabilities, loans,
  money-transfers index/prepare/settle, owners, payroll/statutory-payments, service-charge) and says which, if any,
  draw from two accounts.
- **R4.** Cashier accounts keep the row-154 behaviour: a shortfall there is a **warning, never a refusal** (the till
  holds money the ledger cannot see yet). Locking still applies (cheap, and keeps one code path).
- **R5.** No migration, no new table, no change to `judgeDraw`'s rule.

## 3. Tests (tester first; each names the mutant it kills)

| Id | Case | Expected | Kills |
|---|---|---|---|
| D1 | Non-cashier account ₱1,000; one draw ₱1,200 | `RefusalError` whose user sentence is `judgeDraw`'s message; no developer context in it | plain `Error` kept |
| D2 | Two connections, same non-cashier account ₱1,000, each drawing ₱700 through a real caller (e.g. `createMoneyTransfer`), with a barrier so both read before either commits | exactly one succeeds, the other is refused in words; balance ends at ₱300, never −₱400 | no `FOR UPDATE` |
| D3 | Same as D2 on a **cashier** account | both succeed, the second returns the warning message; nothing refused | lock made to block cashier draws / R4 lost |
| D4 | Two transfers A→B and B→A at once (if any caller locks both sides) | both complete, no deadlock error within the test timeout | lock taken in caller order, not id order |
| D5 | Throw ratchet | count goes down by one | — |

## 4. Fences
- Write only: `overdraft.ts`, `packages/db/src/repo/money-accounts.ts` (the lock helpers), callers only if R3 needs it,
  and the throw-ratchet baseline if it is a regenerated file.
- Do NOT change `judgeDraw`, `draw-verdict.ts`, any posting pattern, or any amount.

## 5. Done when
D1-D5 red→green, every existing test of the 12 callers green, throw ratchet down by one, typecheck clean, Sonnet audit.
