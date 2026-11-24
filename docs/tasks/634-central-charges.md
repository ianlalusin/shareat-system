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

- **Migration 0278** (`packages/db/migrations/0278_t634_charge_options.sql`): `charge_options` (org, name 1-40 unique per org on the a-z0-9 key, amount
  > 0 and ≤ 100,000, per_unit, sort_order, status), RLS + FORCE, grants SELECT/INSERT and UPDATE (amount, per_unit, sort_order, status, updated_at): never
  name, never DELETE. `pos_charge_presets.charge_option_id` NOT NULL with a same-org composite FK. Three origin triggers: `pos_charge_presets_mirror_option`
  (name/amount/per_unit come from the option; the option cannot change; a retired option cannot be switched on), `charge_options_guard` (org and name
  frozen; retire refused while any store has it on), `charge_options_mirror_presets` (an amount / per-unit change is copied onto every store row).
  Registered in classification (keep), the RLS registry (org_column), the trigger registry (+3) and the audit catalogue (+4: `charge_option.created`,
  `.updated`, `.retired`, `.reactivated`; ceiling 308 -> 312).
- **Deviation for BOSS: "unique per store+option" is a partial UNIQUE (WHERE status = 'active'), not a full one.** Under T-627 a store could retire
  "Leftover" and add it again, which leaves an old retired row that past bills point at and that can never be deleted. Both rows must join the one option.
  The domain's switch-on reuses the store's newest row, so no new duplicate is ever made.
- **Backfill**: one option per (org, normalised name). Its spelling, amount and per unit come from the earliest ACTIVE preset (or the newest retired one
  when none is active); its status is active if any store has it on. Every preset is set to its option's values. STOP (RAISE) when two ACTIVE presets of
  one store share a key (never merged), or when the ACTIVE presets of one key differ in amount or per unit at two stores. Retired rows are history and are
  not compared.
- **Snapshots checked**: `charges.ts` `resolveCharge` copies the preset's name and amount into `table_session_charges` when the charge is added;
  `sale.ts` copies those rows onto `pos_sales_receipt_charges`. So an amount change never moves a charge already on a table or a receipt. (Already true before
  this task: the server takes the amount when the tablet's `charge.added` event reaches it, not when the cashier tapped.)
- **Domain** `packages/domain/src/pos/charge-options.ts`: `createChargeOption`, `updateChargeOption` (bumps the snapshot version of every store that has it
  on), `setChargeOptionStatus` (retire refused while on, in words), `setStoreCharge` (on/off). Master capability **`manage_menu`** (org; admin and
  super admin): a charge is part of what the brand sells and at what price, which is what `manage_menu` governs. Not `manage_chart_of_accounts` (where
  money is booked) and not `set_menu_price` (store scope, the opposite of brand-wide). Store switch: `manage_store_settings` at the store.
  `upsertPosChargePreset` / `retirePosChargePreset` are gone.
- **Copy from another store**: the 'charges' kind is removed (domain, ERP dialog and action). `t627-copy-charges.test.ts` is deleted.
- **ERP** `/admin/pos-tablets`: "Charges (all stores)" (`ChargeOptionsSection`) above the store picker, as a compact table (Charge / Amount / Stores
  using / quiet Edit with Retire inside; a collapsed "Retired charges" block with Restore). Each store's Charges section is a compact table of switches
  (Status On/Off; "On" is one tap, "Off" asks once).

### Pre-check for Ian, before deploying (read-only)

Run this on production. **No rows = the migration will apply.** Each row names a charge that would stop it, and why.

```sql
with p as (
  select org_id, store_id, name, amount, per_unit,
         coalesce(nullif(regexp_replace(lower(name), '[^a-z0-9]', '', 'g'), ''), lower(btrim(name))) as k
  from pos_charge_presets where status = 'active'
)
select 'switched on twice at one store' as problem, org_id, store_id, string_agg(name || ' ' || amount::text, ' | ') as charges
from p group by org_id, store_id, k having count(*) > 1
union all
select 'different amount or per-unit between stores', org_id, null,
       string_agg(distinct name || ' ' || amount::text || case when per_unit then ' each' else ' per bill' end, ' | ')
from p group by org_id, k having count(distinct amount::text || '|' || per_unit::text) > 1;
```
