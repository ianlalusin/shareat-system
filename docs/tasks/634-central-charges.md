# T-634 — Central charges (MIGRATION 0278)

Status: building on `feat/t634-central-charges` (from origin/main 450c6fd).

## Why

Ian, 2026-11-24: "charges i guess shall be centralized so charges are uniform across the brand". The pattern is T-629 (payment options,
migration 0277): an org master list, the store row is the switch, and a trigger keeps the mirror in sync. Read 0277 and
`packages/domain/src/pos/payment-options.ts` first and copy that shape.

## Today

`pos_charge_presets` (`packages/db/schema/pos-v2.ts`, T-627) is per store (name, amount, per_unit, status). It is edited per store on
`/admin/pos-tablets` in ChargesSection, with "Copy from another store" kind 'charges'. `table_session_charges` and
`pos_sales_receipt_charges` keep a preset id plus name/amount snapshots.

## Rule

1. New org table `charge_options`: name (1-40, unique per org on the normalised a-z0-9 key), amount (> 0, ≤ 100,000), per_unit, sort,
   status active/retired, audit. One brand-wide name and amount.
2. `pos_charge_presets` gains `charge_option_id` NOT NULL (same-org composite FK, unique per store+option). The option owns name, amount
   and per_unit; the preset row mirrors them by trigger, so the snapshot, the tablet and the sale keep working unchanged. A store row with
   status active means switched on.
3. Changing an option's amount changes it for every store from now on. Charges already on open tables and receipts keep their snapshots;
   check that the code really snapshots at add time.
4. Backfill in 0278: group existing presets by the normalised name within the org into one option. If the same name has a DIFFERENT amount
   or per_unit at two stores, RAISE (the deploy stops). Add a read-only pre-check query in "As built" for Ian to run before deploy. Never
   merge two presets of one store.
5. ERP:
   - the master list "Charges (all stores)" at the top of /admin/pos-tablets: add / change amount / retire (refused while any store has it on)
   - each store's Charges section becomes on/off switches (the T-631 compact-table look)
   - master capability: pick an existing ORG-scope capability that fits brand pricing, and say which and why
   - store switch: `manage_store_settings` at the store
   - authorize first; audit
6. Remove the 'charges' kind from Copy from another store (it is now pointless). Keep the other kinds.
7. Seed: none (Ian adds them).

## Tests (each with a mutant proven red)

- backfill groups same-name presets across stores
- a conflicting amount RAISEs
- an amount change mirrors to all store rows
- retire refused while on
- authorize first; a store manager is refused on the master list
- an open table's charge keeps its old amount after a change
- the snapshot carries the switched-on charges only

Hand-authored migration per ADR-012 §5. Register the new table in classification and the RLS registry (plus the trigger registry and audit
catalogue). DB integration tests are written; CI runs them. census:write and unit tests on DELL. tsc only if memory allows. Commit
locally, do not push. Report (≤20 lines) to `C:\shareat\t634-report.txt`.

## As built

(filled in by the builder)
