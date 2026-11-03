# One Place for Every Setting: Unify v1 Settings into ERP v2

* **Author:** Ian Lalusin
* **Date:** 2026-11-03

## Overview

Today, settings live in three old apps: ERP v1, POS v1 and Customer v1. Some settings exist in more than one app. Some exist only in POS or Customer. ERP v2 has some of them, but not all.

The idea: **ERP v2 becomes the only place where any setting is edited.** POS v2 and Customer v2 only read settings. They never edit them. Nothing from the three v1 apps may be lost.

Example of a gap: POS v1 needs a package to have a kitchen location. ERP v2 has no kitchen-location setting yet.
Example of a duplicate: POS v1 and ERP v1 both have store settings. These become one store record. It keeps every field from both, including fields only POS has (such as geo location).

Decisions from Ian:
- Order of work: list first, then spec, then build.
- If ERP v1 and another app disagree, ERP wins.
- "All settings" means all of them, including values fixed in code and values kept in Firestore config that no screen edits today.

Status: the reviewer report was not fully checked against source code. The "already in v2" claims below are unverified until the inventory is built.

## Analysis

**What already exists (so we do not redo it)**
- The destination is already decided. Bible row 307 (`PROJECT_BIBLE.md:1642`) says POS v2 and Customer v2 have no admin panels.
- ERP v2 already has a Settings hub with 8 cards.
- `docs/discovery/23-store-settings-and-config.md` already compares ERP v1 with POS v1 store settings. It does not cover Customer v1.
- What is new is one complete inventory of every setting across all three apps.

**Problems found, ranked**

1. **"ERP wins" is unsafe as a permanent rule.**
   - It reverses decisions already made in `discovery/28` (one phone field, tax owned by the organisation, some fields dropped).
   - `taxType` is stored in both v1 apps and they can disagree (`discovery/23` §1). Wrong tax means wrong receipts.
   - Fix: use "ERP wins" only once, when loading old data into v2. An empty ERP value must never erase a real POS value. Produce a list of every conflict per store and per field, with both live values. Ian signs it off. Conflicts on tax, money, opening hours or sales channels stop the load until someone decides.

2. **A setting change must not hit a sale already in progress.** A till that was offline sells under the old VAT. The server then recalculates under the new VAT and flags every sale.
   - Fix: stamp each sale with the settings version it used. Money-related settings start from a set date and time. They never apply to past sales. `store_attendance_config` already works this way.

3. **"Setting" is not defined yet.** Menu items, prices, packages, roles, PINs and API keys could each be counted in or out.
   - Fix: write down a test for what counts as a setting. Say who may edit each one. Give each a scope: whole company, per store, or per package. "Already in v2" must mean three things: the column exists, a screen edits it, and POS or Customer has a way to read it.

4. **Hard-coded values need sorting.** Four groups:
   - Must stay in code (for example `WASTAGE_REASONS`, posting accounts; `discovery/28` §3.1 explains why).
   - Real operating knobs that become settings (for example refill cooldowns, DEF-021).
   - Delete (the `000000` PIN shortcut).
   - Not a setting at all (image hosts, paper widths).
   - Things that stay on the device (printers) or on the floor app (sold-out, reprint) are marked "intentionally elsewhere", not "missing".

5. **"Keep every field" conflicts with bible 1.2d** (read v1 for its goal, not its method). Each field gets a decision: carry as is, rename, retire with a reason, or defer to a named phase. Nothing is dropped silently.

6. **The way POS reads settings does not exist yet.** The chosen carrier is a POS server route (`/api/pos2/...`), per bible row 280 (completely off Firebase), T-462 step 4 and T-508 R6. The store comes from the terminal link. The device keeps a versioned snapshot in IndexedDB and refreshes it with an ETag. There is no Firestore mirror entity and no `MIRROR_ENTITIES` change. Still to define for each setting POS reads: a staleness limit, and what POS does if config is missing (stop selling, not guess).

7. **Different kinds of values need different handling.** Settings edited only in ERP are separate from live state that POS writes during service (open/closed toggle, drawer count). Content such as flash ads, games and banners should not share the money-settings pipeline.

8. **Secrets** (payment keys, partner codes) must not go into settings tables or the snapshot a device downloads. List them by name only. Needs Ian's ruling.

9. **While v1 is still live, both v1 screens and v2 could edit the same data.** Use a one-way load from v1 to v2 only. Freeze each v1 settings screen on its cutover day. No two-way sync.

10. **Shape of the data.** One owner per setting family, with typed, versioned records. Not one big blob, not a generic settings framework (`discovery/28` §7 rejected that).

11. **Permissions and audit.** One capability per settings family (for example `set_cash_policy`, `manage_stores`), not one "settings" capability. Money settings get an append-only change log. `audit_log` has no writers today.

**Checked examples**
- Kitchen location: a real gap, but POS v1 does not require it on the form (`StorePackageEditDialog.tsx:24` allows empty). It is enforced at sale time (`cashier/firestore.ts:310-312`). The spec should read "required before the package can be sold". ERP v2 has no kitchen routing at all (`schema/menu.ts`). Task 401 (R13) deferred it to a store-settings spec that does not exist yet.
- Store duplicate: only about 9 fields overlap. v2 `stores` (`schema/stores.ts:50-131`) lacks geo, delivery and pickup radius, opening and closing time, online-order mode, reservation and chat flags, tax rate and type, loyalty and forecast config. Most "duplicates" disappear because v2 has one row. Real ones to rule on: `offersAlaCarte`/`offersUnlimited` and `storeKind`/`hasProduction`.
- Other gaps: capitalization policy (threshold 5000, 5 years), salary advance (deliberately deferred), flavors, dayparts, dining tables, discounts and charges.

**How to guarantee nothing is lost**
- Build the inventory as a spreadsheet (CSV) with one row per field and a stable ID (S-001, S-002...). Use three scans:
  1. A code scan of v1 Store, Settings and Config types and form fields.
  2. A read-only scan of live Firestore listing every field name with a count and sample value (needs Ian's approval).
  3. A manual pass for hard-coded values.
- Columns: app, kind, path:line, collection/doc, field, type and unit, default, live sample, who edits, who reads, scope, v2 status, v2 table.column, decision, conflict note.
- A test, in the style of `cutover-classification.test.ts`: every v1 field must map to a v2 column or be marked "dropped" with a reason. It fails on any unmapped field. Start it as a warning only.
- The inventory is complete when: every settings page has a row, every field of both Store types is listed, every scanned key is in the inventory, every row has a status, every merge row names a winner and a reason, and the v1 repos are untouched.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  - One inventory of every setting in ERP v1, POS v1 and Customer v1, with a status for each.
  - One merged record per duplicate, with all fields kept (or explicitly retired with a reason).
  - ERP v2 screens for every missing setting.
  - A read path so POS v2 and Customer v2 can use these settings.
  - A conflict list for Ian to sign, with ERP winning by default.
* **Out-of-Scope Non-Goals:**
  - Admin panels inside POS v2 or Customer v2.
  - Two-way sync with v1 while v1 is live.
  - A generic "settings framework".
  - Moving secrets into settings tables.
  - Device-only settings (printers) and floor-app actions (sold-out, reprint).
  - Menu content, prices, and promotional content (flash ads, games, banners), unless Ian rules them in.

## Key Decisions & Staging for Next Steps

**Decided by Ian**
- List first, then spec, then build.
- ERP wins on disagreement.
- "All settings" includes everything, including hard-coded values and Firestore-only config.

**Decided by Ian (2026-11-03)**
- Conflict list first: done, see `settings-audit/CONFLICTS-FOR-IAN.md` (37 conflicts). Ian signs it.
- v2 is not live and no real sales are affected, so the "sale in progress" risk is off the table for now. The load of live v1 values at cutover still needs the conflict list.
- Everything is edited in ERP v2. POS and Customer are slices of one app and only read.
- A read-only scan of live v1 Firestore is approved, and was run (field names only, no secrets).

**Suggested, waiting for Ian's OK**
- (Settled by the chosen carrier, BOSS 3 Nov) Customer v2 reads settings through a server route in ERP v2, returning only public-safe fields. Same pattern as POS (server route, no Firestore mirror).
- (BOSS 3 Nov) **Kitchen stations, per-item kitchen routing and the slow-order limit are owned by T-508** (`docs/tasks/508-kitchen-stations-and-menu-to-pos.md`, branch `t508-menu-to-pos-spec`, capability `manage_store_settings`). The inventory marks kitchen location "owned by T-508" and does not spec it again.
- Per-user preferences (language, theme) are out of scope. They get one "not a setting" line in the inventory.

**Decided by Ian, section A of the conflict list (2026-11-03)** — full table in `settings-audit/CONFLICTS-FOR-IAN.md`
- VAT: VAT or non-VAT only, no exclusive. Business-day start: one setting, default 05:00. Offline limit: 24 hours for everything. Receipt format: editable per store, no "OR-" default (POS prints billing and acknowledgement only; cashiers issue official receipts by hand). Staff session: 8 hours company-wide. Targets: one table, POS daily, ERP monthly. Slow-order limit: per-station ERP setting, default 10 minutes. Senior/PWD: already built in v2 (T-426). Retention: 3 years (re-issue notice before cutover). Table PIN: 2 hours for both. Payday lag: 3 days.

**Still open**
- VAT status is now known (Ian, 3 Nov): Malvar is VAT-registered and is Lipa's branch (same TIN, branch number ending in 1). Davao is non-VAT. ERP v1 is wrong for Malvar. POS v1 is wrong for Davao. Both get corrected by hand at load.
- (Settled, Ian 3 Nov) Davao has its own TIN, so it is its own organisation in v2. VAT mode stays per organisation. No per-store VAT override needed. (Banay-Banay is closing and is dropped from v2 completely: bible row 377, T-454. It needs no v2 settings and is not loaded.)
- Where do secrets live? (names listed in `settings-audit/A2-customer-detail.md` §4)
- Does ERP edit both monthly and daily targets? (assumed yes)
- (Settled, Ian 3 Nov) Section B of the conflict list: ERP wins on all 12.
- Live per-store comparison for settings other than VAT (not done yet).
- These rulings are in files only; they go into the bible decision log at wrap-up.

**Proposed staging**
1. **Docs only, no schema change.** Inventory ERP v1 against the v2 `/settings` hub, and the POS v1 and Customer v1 fields that POS v2 and Customer v2 must read. Extend `discovery/23` instead of redoing it. Save at `docs/discovery/43-settings-unification-inventory.md` plus table files. Ian signs the conflict list and the "becomes a setting?" column.
2. **Spec.** One plan plus one task per area, using T-229 as the shape: store identity, channels and payments, POS and devices, roles, menu and kitchen, customer config, thresholds. Areas already fully in v2 get a one-line check, not a task. Keep one grouped Settings hub; fold `/admin/stores`, users and access-defaults under it.
3. **First build.** The store settings POS v2 needs before the Lipa launch on 7 Dec (hours, online-order mode and open state, radii, geo). Check T-401 and the POS-tablet work for overlap first. Prove the pattern end to end on one small setting (migration, access rules, classification, permission plus a test that a denied user is refused, audit log, screen, POS server route, read-only POS stub). Do not start the build or touch the schema before telling BOSS, so two sessions do not both write the same migration. Migration 0226 (kitchen_stations, kitchen_routes) is taken by T-508 (BOSS, 3 Nov). Settings work takes 0227 or later, after telling BOSS.
4. **Customer v2 settings** (May to June 2027) can wait.
