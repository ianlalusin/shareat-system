# T-494 — A charge's open amount counts every credit already taken off it; a credit and a collection lock the charge in one order

**Status:** spec written 2026-10-27 (Opus planner, AUDIT session). Source: Codex audit 20th pass
(`C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-27-twentieth-pass.md`): `franchise-credit-collection-outstanding-mismatch`
(numbered F26, DEF-789) and `franchise-credit-charge-lock-gap` (F27, DEF-790). Confirmed on origin/main. Branch
`audit/t494-ar-credited-outstanding`, own PR. Task number and fix shape agreed with the orchestrator (owner of T-398 S5).

## F26 — DEF-789 (P1, money): collections cap on a figure that ignores credit notes and returns
- `packages/db/src/repo/ar.ts` `openItems` (~215-243) computes `outstanding = total - collections - write-offs` and
  filters on it. `outstandingForCharge` (~263-299, DEF-748) also subtracts the 1210 credit legs of posted customer
  returns and resolved `franchise_credit` discrepancies (CTE `credit_entries` / `credited`).
- `packages/domain/src/ar/index.ts` `recordCollection` (~525-540) locks the charge, then caps each allocation with
  `openItems`. After a ₱620 shortage credit on a ₱3,100 charge it accepts ₱3,100 and credits 1210 by ₱3,100: the
  receivable goes to −₱620 and nothing goes to 2140 (customer store credit / overpayment). The same happens after an
  ordinary posted customer return (pre-S5; the only case reachable on production today).

### Rulings
1. **One definition.** Extract the "credited against this charge" SQL into ONE shared fragment/helper in
   `packages/db/src/repo/ar.ts` and use it in BOTH `outstandingForCharge` and `openItems` (per charge, for the
   customer's set). No second copy. `openItems`' filter (`> EPSILON`) and its `outstanding` both use the net figure;
   add a `creditedAmount` field to the open-item shape if the screen shows the parts (keep existing field names).
2. **Never drive 1210 negative.** With the corrected cap, `recordCollection` refuses an allocation above the net open
   amount exactly as it refuses one above today's figure (existing sentence). Any customer overpayment keeps going
   where the existing surplus rule sends it (2140 / the collection's unapplied remainder) — read the posting pattern
   (`docs/POSTING-PATTERNS.md`, `trade_dispatch.franchise_transit_shortage` and the AR collection patterns) and follow
   it; do not invent a new route.
3. **Other consumers.** Find every reader of `openItems` (ageing, write-off, statements, customer screens) and make
   sure they now see the net figure; write-off must not write off an amount already credited. List them in the report.
4. Keep money arithmetic as it is in each function (do not widen scope to unrelated `Number()` uses).

## F27 — DEF-790 (P2): the shortage credit does not take the collection's charge lock
`packages/domain/src/trade/franchise-credit.ts` (~106) reads `outstandingForCharge` without
`arRepo.lockChargesForAllocation` on the order's `arChargeId`, while `recordCollection` takes that lock before reading
its cap. A collection committing between the credit's read and its commit over-credits 1210.

### Rulings
5. The shortage-credit path (`postFranchiseShortageCredit` / `creditShipment`, whichever reads the outstanding) takes
   `arRepo.lockChargesForAllocation(tx, orgId, [order.arChargeId])` BEFORE reading the outstanding. Lock order: the
   charge first, then the shipment / discrepancy rows. Check every path that locks both (credit, collection, customer
   return, write-off) and make the order charge → shipment/discrepancy everywhere, or show in the report that no cycle
   is possible. The customer-return and write-off reducers use the same charge lock before their read.

## Tests (red first, real Postgres, a DEDICATED fresh *_test DB built from zero; never shareat_test/shareat_dev)
- `packages/domain/tests/integration/t494-ar-credited-outstanding.test.ts`:
  (a) inter-entity: dispatch charge ₱3,100, received ₱2,480, ₱620 shortage credit posted → `openItems` shows ₱2,480;
  a ₱3,100 collection allocation is refused (or the excess handled per Ruling 2); ₱2,480 settles it to zero and the
  charge leaves the open list; 1210 for the customer never goes negative.
  (b) ordinary: a posted customer return against a charge → same assertions.
  (c) write-off of the full original amount after a credit is refused / capped at the net.
  (d) every other `openItems` consumer the builder finds: one assertion each that it sees the net figure.
  (e) F27: two connections — a collection and a shortage credit on the same charge started together; after both,
  1210 for the customer is never negative and the credit/collection that loses either waits and re-reads or is refused.
  Use the existing S5 fixtures (`packages/domain/tests/integration/_fixtures/`, T-398 S5 tests) for the inter-entity case.
- Existing AR, collections, returns, write-off, ageing and T-398 S5 tests stay green (fix fixtures only if they relied
  on the old figure, and say which).

## Files
`packages/db/src/repo/ar.ts`, `packages/domain/src/ar/index.ts` (only if the cap read needs it),
`packages/domain/src/trade/franchise-credit.ts` (and the shipment credit path it calls), the customer-return / write-off
reducers only for the lock order, the new test file, `docs/DEFECTS-REGISTER.md` (DEF-789, DEF-790, full row shape).
Nothing else; no migration.

## Acceptance
Red then green; affected integration tests green; root + ERP typecheck clean; WHOLE unit project green
(`npx vitest run --project unit --testTimeout=120000 --maxWorkers=3`); register-row-shape green.
