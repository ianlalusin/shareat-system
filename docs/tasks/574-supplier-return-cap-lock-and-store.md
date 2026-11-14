# T-574 — Supplier return: serialise the returnable cap and refuse another store's delivery (DEF-838, DEF-857)

Status: SPEC (BOSS, 2026-11-13). Stock + money: Sonnet builder + Sonnet auditor. No migration unless the
trigger option is chosen below (then reserve the next migration number on BOARD.md first).

## Problem (verified on main 4c250d2)
- **DEF-838** `packages/domain/src/stock/supplier-returns.ts:143-157`: `recordReturn` reads the delivery line and
  sums posted returns with no lock. Two users returning at once both pass the cap: 10 received, 8 + 8 returned.
  The advisory lock exists only in void (:314) and refund (:425).
- **DEF-857** same file: authorization is on `input.storeId` (:86); the delivery and line are loaded by id with
  org-RLS only (`deliveries.ts:45,61`) and only the supplier is compared (:140). A user with the return right at
  store A can cite store B's delivery line.

## Rules
1. **Same store.** After loading the delivery, refuse unless `delivery.storeId === input.storeId`, with a plain
   message naming both stores ("That delivery was received at <B>, not <A>"). Check before any stock read.
2. **Serialise per delivery line.** Before reading the returnable quantity, lock the delivery line row
   (`SELECT ... FOR UPDATE`, or a new `advisoryLocksRepo.lockDeliveryLine(tx, lineId)` matching the existing
   `lockSupplierCredit` style — pick the advisory lock if a trigger elsewhere fights FOR UPDATE on that table;
   read `channel-settlements.ts:519` for the precedent). Lock lines in a stable order (sorted id) when a return
   has several lines, so two multi-line returns cannot deadlock.
3. `voidReturn` must take the same line lock(s), so a void and a new return on one line also serialise.
4. Check `trade/returns.ts` (~:99): the no-charge internal-transfer path has the same unlocked cap (verifier note).
   Apply the same lock there, or state in the PR why it cannot race.

## Tests (must fail on main first)
- Integration: two parallel `recordReturn` on one line (10 received, 8 each): exactly one succeeds, the other is
  refused with the cap message; stock moved once.
- Integration: a return at store A citing store B's delivery line is refused; nothing posted.
- Multi-line return pair in opposite line order completes without deadlock (both run, cap respected).
- Mutant: removing the lock call turns the race test red; removing the store check turns the store test red.

## Out of scope
- A database CHECK/trigger backstop on the cap (would need a migration and the full suite). Propose it in the
  PR notes if the builder thinks the lock is not enough.
