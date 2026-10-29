# T-499 — A customer return refused partway leaves nothing behind (DEF-798)

**Status:** spec written 2026-10-29 (Opus planner, AUDIT session). Source: DEF-798, logged 2026-10-28 by the AUDIT
session while reviewing T-493 S2 (F23). Fix agreed by the orchestrator on 28 Oct: pre-validate every line before the
first stock move, and throw on any later refusal so the transaction rolls back. One PR, branch `audit/t499-return-partial-refusal`.

## The defect
`packages/domain/src/trade/returns.ts` claims "EVERY refusal decided before the first write" (:209), but both posting
helpers still return `{ ok: false }` AFTER stock has moved:
- `recordExternalReturn` (:272-325) — per line: item missing (:275), no inventory account (:277), no dispatch movement
  (:281), `reverseConsumption` refused (:298), the unsellable `consume` refused (:320); then after the loop, a refund
  with no `moneyAccountId` (:332) or an unknown money account (:334).
- `recordInternalReturn` (:438-489) — per line: item missing (:441), mapped branch item missing (:447), no inventory
  account (:450), `consume` refused (:462).
`apps/erp/src/app/trade/returns/actions.ts:49` runs the call in `withOrgPrincipal`, which COMMITS on a returned
`{ ok: false }` — only a throw rolls back. So any such refusal on line 2+ (or the refund checks, on any line count)
commits line 1's stock movements and layer changes with no return row and no journal entry. Today's screen sends one
line and always a real account (`page.tsx:210-213`), so it is latent (🔸); any multi-line or API caller hits it.

## Rulings
1. **Pre-validate.** Before the first `reverseConsumption` / `consume` / `insertMovement`, each helper checks for EVERY
   line everything that does not depend on a prior stock write: the item exists, its inventory account exists, (external)
   the dispatch movement exists, (internal) the mapped branch item exists and both accounts exist; and (external, refund)
   `moneyAccountId` is given and the account exists — move :332-334 up beside the T-493 S2 checks at :252-260. Each
   refusal keeps its current sentence. Build a per-line "resolved" record in that pass and use it in the write loop
   (no second lookup).
2. **Throw after the first write.** Any refusal still possible after stock has moved (`reverseConsumption` / `consume`
   returning `ok:false`) throws `refuse(raw, sentence)` (`packages/db/src/refusal.ts`) with the SAME plain sentence it
   returns today, so the transaction rolls back and the action's existing `catch` shows that sentence. Follow how
   `packages/domain/src/trade/index.ts:225-245` throws `refuse(...)`. The return type stays `RecordCustomerReturnOutcome`;
   `{ ok:false }` remains for refusals decided before any write.
3. Fix the :209 comment so it is true, and add one line at the top of each helper saying "no `{ ok:false }` after the
   first stock write — throw".
4. **The action must not commit on `{ ok:false }`** (orchestrator, 29 Oct). In `apps/erp/src/app/trade/returns/actions.ts`
   `recordReturnAction`, a `{ ok:false }` result throws INSIDE the `withOrgPrincipal` callback so the transaction rolls back,
   and the existing `catch` shows the same plain sentence. Use an existing shared helper for this if the tree has one
   (grep `withOrgPrincipal` callers that throw on `!ok`); else throw `refuse(raw, result.reason)`. Belt and braces with
   rulings 1-2: the domain stops leaving writes behind, and the action never commits a refused return. Check the void
   action next to it the same way and report what it does (change it only if it also commits on `{ ok:false }`).
   No change to the screen or any posting. `voidCustomerReturn` already throws (:599, :606).
   Test: an ERP unit test following `apps/erp/tests/t380-s4-actions.test.ts` / `t379-s2-customer-return-banners.test.ts`
   shows a refused result reaches the flash as the same sentence and that the callback threw (rolled back).
5. `docs/DEFECTS-REGISTER.md` DEF-798 row → `✅ fixed by T-499`, full row shape, naming the test.

## Tests (red first, real Postgres, fresh `*_test` DB)
`packages/domain/tests/integration/t499-return-partial-refusal.test.ts`, reusing the fixtures of
`packages/domain/tests/integration/customer-returns.test.ts`. Each case runs the call the way the action does — inside a
transaction that COMMITS on `{ ok:false }` and rolls back only on a throw — then counts, after commit, the
`stock_movements` with `source_type IN ('customer_return','customer_return_unsellable')`, the layer quantities of the
dispatched items, `customer_returns` rows and `journal_entries` for `customer_return`, against a before-snapshot:
(a) external, TWO lines, refund=true with `moneyAccountId` = a random uuid → refused with "that money account does not
    exist."; zero new movements, layers unchanged (RED today: line 1 and 2 reversed and committed);
(b) external, two lines, refund=true, `moneyAccountId` null → refused "a cash refund needs a money account."; nothing moved;
(c) a two-line return where LINE 2 fails a per-line pre-check (pick one reachable with real fixtures, e.g. no dispatch
    movement for its item) → refused with the current sentence; line 1 did not move;
(d) a late refusal: line 2's stock write refuses after line 1 moved (find a real way with fixtures; only if none exists,
    use a narrow seam and say so in the report) → the call THROWS a RefusalError with the plain sentence; after the
    rollback nothing moved;
(e) internal transfer, two lines, line 2 fails a pre-check → nothing moved;
(f) positive controls: a valid two-line external return (one unsellable) and a valid internal return still post exactly
    as before; `customer-returns.test.ts` and the t369/t373/t383 return tests stay green.

## Acceptance
Red then green; root + ERP typecheck clean; the WHOLE unit project green (`npx vitest run --project unit
--testTimeout=120000 --maxWorkers=3`); the return integration tests green on a fresh DB; `tests/unit/register-row-shape.test.ts`
green; the t343 refusal censuses green (a new `refuse(` second argument must be a plain sentence). LF only.
