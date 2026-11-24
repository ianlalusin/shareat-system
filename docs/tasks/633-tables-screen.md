# T-633 — Table numbers screen

Status: building on `feat/t633-tables` (from origin/main 450c6fd). No migration.

## Why

Ian, 2026-11-24: table numbers are individual to each store. Today `pos_stands`
(`packages/db/schema/pos-v2.ts:129`; number unique per store; status active/retired; a retired number
is never reused) has NO ERP screen. Only `upsertPosStand` (`packages/domain/src/pos/store-setup.ts:23`)
exists, called by the v1 copy CLI.

## Rule

1. Add a "Tables" section on `/admin/pos-tablets`, beside Discounts and Charges, following their
   pattern (T-622/T-627: list, Add, Retire). Per store, capability `manage_store_settings` at the
   store (the same as Discounts). `authorize()` first; audit rows written.
2. Add: a single number, or a range typed as "1-20", created through `upsertPosStand`, one
   transaction per submit. Report the counts in words ("Added 18 tables; 2 already existed").
3. Retire: a new domain function `retirePosStand` (authorize first, audit, refuse a stand with an OPEN
   table session, in words). Retired numbers are listed in a collapsed "Retired" block and are never
   reused (keep the existing rule).
4. The list shows the table numbers in numeric order, as compact chips or a compact table. At 390px:
   no sideways scroll; tap targets 44px.
5. The POS snapshot already reads active stands by store, so nothing changes there.

Not in scope: copy-from-store for tables; table layout or zones.

## Tests (each with a mutant proven red)

- the range parser: "1-20", "5", bad input, a reversed range, a cap of 200 per submit
- retire refused with an open session
- authorize first
- the audit row

Unit tests run on DELL. DB integration tests are written; CI runs them.

Then `npm run census:write`. tsc only if memory allows. Commit locally, do not push. Report (≤15 lines)
to `C:\shareat\t633-report.txt`.

## As built

(filled in by the builder)
