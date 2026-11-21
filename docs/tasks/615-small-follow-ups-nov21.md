# T-615: small follow-ups from the 20-21 Nov reviews

**Owner:** builder (Sonnet). **Spec:** BOSS (Opus), 21 Nov 2026. **No migration.**
Each item is one commit, with a test that fails without the fix (a mutant). Lines are approximate; re-locate on current main.

1. **Customer-return void checks the right before the record exists** (the twin of DEF-562, T-598 part 2).
   - `packages/domain/src/trade/returns.ts` (~566): voiding a customer return must authorize **before** saying "return <id> does not exist", as the supplier-return void now does.
   - Test: an unauthorised caller with a random id gets the authorization refusal, not "does not exist".
2. **The journal-lines page totals in SQL, then caps the rows** (T-602 S6-5, skipped).
   - `apps/erp/src/app/journal-lines/page.tsx` sums the rows it was given. Compute the debit and credit totals with a SQL aggregate over the same filter, then load at most 500 rows for display with a "showing 500 of N" line.
   - The totals must equal today's for any filter. Test with more than 500 rows: totals are unchanged and 500 rows are shown.
3. **AR outstanding queries filter by the customer** (T-602 note).
   - `packages/db/src/repo/ar.ts` `outstandingForCharge` and the CTE near ~723 read the whole table. Add the same filtered semi-join or `WHERE` that T-602 S5 used.
   - Behaviour is unchanged; prove it with the existing AR tests plus one plan-shape test (Index Cond on the filter column).
4. **The preset audit label.** `upsertPosDiscountPreset` writes its audit rows with `source: 'etl'` even when an admin copies presets from another store (T-611 S3). Let the caller pass the source: `'web'` from the copy action, `'etl'` from the loader. Test both.

## Out

- The 13 routes awaiting Ian's per-route decision, and making deny-by-default work at runtime: they wait for his answer.
