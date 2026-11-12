# T-557 - store the chosen option ids on session lines and receipt lines (follow-up to T-556 / audit P-001)

Owner: AUDIT. Ian 11 Nov via BOSS: "store option ids NOW, before go-live"; number T-557, MIGRATION 0249 (reserved), its `when` =
0248's + 1 day, merges after T-531's 0247 and T-558's 0248. Stacked on T-556 (branch audit/t556-replay-same-content, PR #219):
this replaces the name-based shortcut in `sameChoices` (order.ts). Hand-authored migration per ADR-012 s5.

## Why

T-556 compares a replayed line's options by NAME because `table_session_lines` keeps options only inside `name` (" + A, B"). That
breaks if an option is renamed between the order and a replay, and it cannot be backfilled for receipts later. Store the ids now.

## Change

1. **Migration `packages/db/migrations/0249_t557_line_option_ids.sql`** (header per ADR-012 s5: task, why, shape, lock budget):
   `ALTER TABLE "table_session_lines" ADD COLUMN "option_value_ids" uuid[];` and
   `ALTER TABLE "pos_sales_receipt_lines" ADD COLUMN "option_value_ids" uuid[];` - NULLABLE, no default: NULL means "a line written
   before 0249" (its options are only in the name), `{}` means "no options chosen". Catalogue-only change, no rewrite.
   No new table: RLS registry and cutover classification unchanged. Check `pos_sales_receipt_lines` for the T-524 append guard /
   frozen-row triggers and column grants: INSERT must keep working; UPDATE stays forbidden; if a column-level grant list or
   trigger enumerates columns, extend it. No new UPDATE grant on the session-line column is needed unless the app updates it
   (it must not: set at insert only).
2. **Journal** `packages/db/migrations/meta/_journal.json`: idx 249, `when` = 1807327907084 (0246) + 3 x 86400000 = 1807587107084 if
   0247/0248 are still not on main when you build; if main has moved (git fetch; look at origin/main journal head) use
   previous.when + 86400000 x (249 - previous.idx). Never the wall clock. The journal guard test must pass.
3. **Schema** `packages/db/schema/pos-v2.ts`: `optionValueIds: uuid('option_value_ids').array()` on `tableSessionLines` and
   `posSalesReceiptLines` (nullable), with the usual comment.
4. **Repo** `packages/db/src/repo/pos-v2.ts`: `NewSessionLine` and the receipt-line insert type carry `optionValueIds`; the line
   row types already come from the schema.
5. **Write path** `packages/domain/src/pos/order.ts` `writeLines`: store the distinct chosen ids of the line, SORTED (a stable
   canonical form: same set, any order, is the same line), as `[]` when none. The derived bundle "extra heads" line stores the
   same ids as its parent. `packages/domain/src/pos/sale.ts` copies the session line's `optionValueIds` onto the receipt line.
6. **Replay compare** `sameChoices` (T-556): when the stored line's `optionValueIds` is NOT NULL compare the sorted distinct id sets
   (input vs stored); no menu read and no name matching in that case (this also fixes the order-sensitivity T-556 noted). When it
   is NULL (a legacy line) keep the existing name-based path unchanged. Remove the `shortcut:` comment's "upgrade by storing ids"
   wording and say legacy lines use names.

## Files

`packages/db/migrations/0249_t557_line_option_ids.sql`, `packages/db/migrations/meta/_journal.json`,
`packages/db/schema/pos-v2.ts`, `packages/db/src/repo/pos-v2.ts`, `packages/domain/src/pos/order.ts`,
`packages/domain/src/pos/sale.ts`; tests below. Any census/count/pin test that counts columns must be RE-MEASURED, never hand-edited
(report it).

## Tests (real PostgreSQL, write first)

`packages/domain/tests/integration/t557-line-option-ids.test.ts` (extend the T-556 fixture): a line added with options stores the
sorted ids on the session line and the receipt line; no options stores `{}`; replay with the same ids in a different ORDER is a
no-op; a renamed option value between order and replay does not break an identical replay (red under the T-556 name compare);
other option ids -> recordedDifferently; a legacy line (set `option_value_ids = NULL` by SQL) still replays by the name path (identical
no-op, different refused); extra-heads bundle line carries the ids. Existing T-524/T-525/T-556 tests stay green. The migration must apply
from zero on a fresh DB (the mkdb script does this) and `migration-journal` tests pass.

## Out of scope

Backfilling old lines (impossible: names only); changing option rules (T-552); P-002.
