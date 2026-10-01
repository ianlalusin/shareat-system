FINDINGS: 5 (HIGH 1, MED 3, LOW 1)
HIGH · packages/domain/src/stock/count-sessions.ts:79 · commitCountSession never checks countedOn before movement writes, so a closed-date count reaches the trigger instead of the required sentence · A two-line count with countedOn in September 2026 → first variance movement raises raw P0001 rather than the stock refusal.
MED · packages/domain/src/stock/transfers.ts:46 · transferNow/dispatch/receive/void still use an ID-bearing fiscal-period message instead of the required sentence · A room transfer during a closed month → refusal exposes the period UUID and raw fiscal dates.
MED · packages/domain/src/stock/period-guard.ts:63 · the “today” refusal omits the required date, override clause, and open-month instruction · recordReturn when returnedOn is open but today's period is closed → user gets the shortened sentence.
MED · packages/domain/src/stock/supplier-returns.ts:301 · the locked re-read correctly wins the race, but its user-facing refusal exposes the return UUID and says “already void” · Two concurrent voidReturn calls → the waiter receives “return {UUID} is already void”.
LOW · packages/domain/src/stock/supplier-returns.ts:313 · supplier-return credit arithmetic still converts numeric quantity and unit cost through Number() · A fractional quantity/cost near a cent boundary → floating rounding can misstate the contribution checked against supplier credit.

CHECKED CLEAN
- All S4-listed production, customer-return, delivery, usage, supplier-return, and trade paths have a guard at the specified date before their first write; receiveTradeOrder checks before the line update loop.
- No stock flow accepts or forwards periodOverride. The new checks do not replace the database trigger; migration 0145 is unchanged.
- The S4 integration tests assert the refusal text and no-write state, with open-period positive controls; deleting a guard exposes trigger text. Admin override and locked-month cases are covered.
- voidReturn re-reads status after taking the supplier advisory lock, before the spent-credit check.

Model: GPT-6
