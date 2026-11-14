# Ledger
## Overview
The only write path to `journal_entries` and `journal_lines`. `postEntry` and `reverseEntry` are deliberately thin: balance, account eligibility and period-open rules live in the database as constraints and triggers; this layer resolves dates and codes, applies idempotency, and orders the writes. Also holds the inter-store pairing helper and the v1-to-v2 legacy leg adapter.

## Interface
- `post-entry.ts`: `postEntry(tx | null, input)`, `lineAmount`, types `PostEntryLine`, `PeriodOverride`, `PostEntryInput`, `PostEntryResult`.
- `reverse-entry.ts`: `reverseEntry`, types `ReverseEntryInput`, `ReverseEntryResult`.
- `inter-store.ts`: `withInterStoreLegs`, `authorizeOtherStores`, type `InterStoreInput`.
- `legacy-adapter.ts`: `inferLegacyAccountNature`, `adaptLegacyLegs`, types `LegDirection`, `LegacyLeg`, `NormalBalance`, `ResolvedAccount`, `AdaptedLine`, `Finding`, `AdaptResult`.

## Invariants
- Everything that posts goes through `postEntry`; it does not re-check balance, minimum lines, account eligibility, period-open or posted-immutability (a second copy would drift from the DB).
- `entryDate` resolves to a fiscal period; callers never supply a period id.
- Write order: insert entry as `draft`, insert all lines, flip to `posted` last.
- `periodOverride` (admin/super_admin) only raises a transaction-local flag after `authorize()` and writes an audit row; the DB still decides. `locked` periods are never overridable.
- Idempotency short-circuit on the caller's key.
- `reverseEntry` writes the exact opposite (debit/credit swapped, same account/store/channel), posts to the original's period if open else the supplied `reversalDate` (memo prefixed `[prior period]`), backfills `reversal_of_entry_id`, and flips the original to `reversed`.
- Inter-store: a store's own lines must net to zero; cross-store money uses `1250`/`2150` pairs with `partyId` set to the other store's CODE, not its id.
- `adaptLegacyLegs` is pure, imports nothing from `@shareat/db`, never throws for bad legacy data, does no balance pre-check, and always writes v2's declared polarity (a disagreement with v1's prefix inference emits a `Finding`).

## Side Effects
- `postEntry`/`reverseEntry` write journal rows (and an audit row for a period override); they join the caller's transaction or open one (`transaction(...)`) when `tx` is `null`.
- `reverseEntry` opens a transaction-local exemption from the active-account check (migration 0005).
- `legacy-adapter.ts`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
