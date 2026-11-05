# T-510 — Menu dayparts: a repeating daily window on a menu offer

**Status:** SPEC APPROVED by BOSS (Opus review, 3 Nov 2026) with the R3/R4 fix applied. Written by the settings session. T-510 is confirmed as ours. **Migration number: 0233** (BOSS renumbered it from the planned 0227; 0232 is T-508's, on main).
**Owner:** settings session. **Migration:** one, **0233** (hand-authored, ADR-012 §5; journal idx 233). BOSS renumbered it: the spec first said 0227 and then sat on top of T-508's 0226, but T-508 shipped as 0232 on main, so ours is the next free number. It is on no database yet.
**Housekeeping:** this draft sits in the main checkout (stale branch `t448-modal-forms-and-density`). Before committing, move it into a worktree cut from origin/main or lane/t508, with node_modules junctions. Never `git worktree remove --force`.
**Gate:** cleared. Ian chose one package with two daypart offers (3 Nov). S0 started.
**Lanes:** Sonnet tester → builder → auditor per slice (auditor Sonnet: schema + money). Discovery slices Haiku.

## Why (Ian, 3 Nov)
Unlimited packages are the core product, and Lipa prices them by time of day. Ian: *"yes add daypart NOW."*
Live check (read-only, 3 Nov): Lipa has **Lunch 08:00–17:00** and **Dinner 17:00–08:00**, every day. 10 of its 12 enabled
packages are gated. Each of 5 packages exists twice, an LT and a DT variant, at different per-head prices:

| Package | Lunch | Dinner |
|---|---|---|
| Pork and Chicken | 298 | 298 |
| Pork and Beef | 338 | 358 |
| Chicken and Beef | 338 | 358 |
| Triple Feast | 358 | 378 |
| Seafood Cruise | 378 | 398 |

Davao and Malvar have the same two schedules. Bundles and the Valentine promos are not gated.
**CORRECTED 5 Nov (live scan):** the windows differ by store. Lipa 08:00-17:00 / 17:00-08:00; Malvar 01:00-17:00 / 17:00-01:00; Davao 11:00-17:00 / 17:00-23:00. Package ids are the same in every store, so the pairs are the same everywhere; prices differ by store (see `settings-audit/T510-PAIRING-TABLE-FOR-IAN.md`).
T-508 R9 already blocks any store from moving its menu to ERP (`POS_MENU_SOURCE=erp`) until this exists. **It does not
affect 7 Dec:** Lipa launches POS v2 on its v1 Firestore menu, where the schedules keep working.

## v1 goal (requirements, not design — §1.2d)
**Goal:** the cashier can only start, or change to, a package whose time window is open, and the price is the one for that window.
v1 (`POS/src/lib/schedule/isScheduleActiveNow.ts:12-43`; gates at `session-list-view.tsx:265-273`,
`request-change-dialog.tsx:101-104`, `store-packages-settings.tsx:114`):
- A schedule = name, days, start, end. Overnight works (start later than end). One schedule per package (`storePackages.menuScheduleId`).
- No schedule, or schedule not found = always on (fails open). Only packages are gated. Refills carry the field but nothing reads it.
- The price is fixed when the session starts. A table that started at 16:55 keeps its lunch price after 17:00.

**v1 defects this design removes:** two near-identical packages to keep in step (LT and DT); a missing schedule silently means "always on"; a field `hub/packages.scheduleIds` that nothing reads.

## Rulings
- **R1 — One table, store-scoped.** `menu_dayparts` (id, org_id, store_id, name, `days smallint[]` 0–6 non-empty,
  start_time, end_time, status `active|retired`, created_by, timestamps). `end_time < start_time` means overnight;
  `end_time = start_time` is refused. Times are in the store's own timezone (`stores.timezone`, `stores.ts:61`).
  Unique (store_id, lower(name)) where active. Same-org composite FKs like `menu.ts`. Classify in
  `cutover/classification.ts` and `rls/registry.ts`. A "copy dayparts from another store" action is a convenience only: the three stores' windows are NOT identical (corrected 5 Nov, see Why), so the cutover loads each store's own.
- **R2 — A daypart belongs to an offer, not an item.** `menu_offers` gains `daypart_id` (nullable, composite FK on
  (store_id, daypart_id)). `null` = all day. Existing rows stay null, so nothing changes until a daypart is chosen. The
  slot unique key becomes (store_id, variant_id, channel, daypart_id NULLS NOT DISTINCT, effective_from). Offers stay
  immutable (the 0196 triggers), so a price change is a new row, as today.
- **R3 — Guards (extend the 0196 insert guard).** A live offer's daypart must be active and in the same store. For one
  variant and channel, live dayparted offers may not overlap in time. A variant may not have a live all-day offer and a live
  dayparted offer at the same moment (the cashier would not know which price applies). Retiring a daypart is refused
  while any live offer uses it (count and a link, like T-508 R3).
- **R4 — Which offer is live right now.** For a variant and channel: if the variant has dayparted offers, the one whose
  daypart contains now (store timezone, overnight and day-of-week aware, then latest `effective_from` ≤ now); if the variant
  has no dayparted offers, its all-day offer; else **not offered now**. R3 forbids mixing the two kinds live for one variant
  and channel, so there is never a fallback from a dayparted variant to an all-day price. "Not offered now" is a normal
  state, not an error. The projection returns it with `availableFrom` (e.g. 17:00) so
  the cashier sees why, not a blank.
- **R5 — Price is fixed at session start.** A session started in one window keeps that window's price after the window
  closes. A package change re-checks the window (v1 behaviour).
- **R6 — Projection and device.** T-508's projection (`StoreMenuV2`) gains `dayparts[]` and a daypart on each offer. The
  projection's existing `nextChangeAt` (T-508 R6) also becomes the next daypart boundary, so a device refetches at 17:00 and
  08:00. The device resolves "live now" offline from its cached projection and the store timezone. Adds `StoreMenuV3` only
  if T-508 has merged; otherwise it extends V2 before release (no production reader yet, so no shim).
- **R7 — Daypart is about price, the business day is about reporting.** Dinner ends 08:00, the business day starts 05:00
  (ruled C-009). A 06:00 sale is a dinner-price sale and belongs to the next business day. No conflict, and a test pins it.
- **R8 — Who may edit.** Dayparts (windows): `manage_store_settings` (T-508 R10). **The pairing structure (which offer belongs to which daypart or all-day: creating a pairing, re-linking, switching to all-day, withdrawing a slot of a dayparted variant) is super admin only: new capability `pair_menu_dayparts` (org, super_admin ✅, admin/manager/staff ✗; Ian, 5 Nov).** A plain price change on an existing slot stays `set_menu_price` (managers, own store; rows 316 and 428). Offers keep the capability that edits prices today:
  `set_menu_price` (store scope; checked at `domain/menu/pricing.ts:138,218,243,272,299`; the `/menu` route needs `view_menu`). Every ✅ has a test proving the ✗ fires (cashier, and a manager of another store).
- **R9 — Screens.** Store page `admin/stores/[id]` gains **Dayparts** (list, add, rename, edit days and times, retire, copy
  from another store). The offer form on `/menu/prices` gains **When**: All day, or one of the store's dayparts. Plain labels,
  existing form density (T-448).
- **R10 — Cutover load.** v1 `menuSchedules` become `menu_dayparts` (Lipa 2, Davao 2, Malvar 2; the TEST stores are
  ignored). v1 `storePackages.menuScheduleId` becomes the offer's `daypart_id`. Ungated packages load with null. Packages
  with a missing schedule id load all-day and are listed in the load report (v1 failed open, v2 says so out loud).
  Banay-Banay is not loaded (bible row 377).
- **R11 — Website menu.** The Website bakes the schedules into its own menu (discovery 11:97) and reads v1 Firestore. Out of
  scope here, listed so it is not forgotten when the Website moves.
- **R12 — Audit.** Create, edit and retire of a daypart write `audit_log` rows. Money offers already do.

## DECIDED (Ian, 5 Nov, answers to the pairing table; S5 loads from these)
1. The 5 pairs are right (Pork and Chicken, Pork and Beef, Chicken and Beef, Triple Feast, Seafood Cruise; v1 `DT_Pork and Beef` is the typo of `DT-Pork and Beef`). **A super admin must be able to modify the pairing afterwards in the ERP:** re-link an offer to a different daypart or to all-day, and edit a package's lunch and dinner prices (S2 domain + S3 screens; capability `pair_menu_dayparts`, R8).
2. (a) Where lunch = dinner, ONE all-day offer: Pork and Chicken at Lipa and Malvar, and all 5 pairs at Davao.
3. (a) Davao "Pork Premium" (258): one package in the lunch window only (11:00-17:00), no dinner offer.
4. The 4 disabled packages (Valentine Promo and Valentine Promo 2 at Lipa and Malvar; Davao "Beef" and "Pork Regular") are NOT loaded.
5. Who edits a store's lunch and dinner hours: admins and the store's own managers (`manage_store_settings`, "a"). Only the pairing structure is super admin.
6. Per-store windows as in Why. Bundles (Barkada, Squad, VIP, VIP 2, VIP PARTY) have no window in v1 and load all-day.

## DECIDED (Ian, 3 Nov): one package, two daypart offers
Pork and Chicken (298 at lunch and dinner) becomes one all-day offer. The LT/DT pairing table comes to Ian to sign before the load (S5). Davao also has an unpaired gated package, "Pork Premium", which the table must place.
The two options as put to Ian, kept for the record. v1 has each package twice (LT and DT). v2 can hold it either way.
- **One package, two daypart offers (recommended).** One item to maintain, one recipe and depletion rule, sales reports
  combine lunch and dinner, a price change is one new offer. Cost: the cashier sees one "Pork and Beef", not two; the load must
  pair LT and DT by name (names are inconsistent, e.g. `DT_Pork and Beef`), so the pairing table is signed by Ian first. And
  4 of 5 pairs differ in price, but Pork and Chicken is 298 both times, so it becomes one all-day offer.
- **Two packages, each gated by a daypart.** Matches v1 one for one, zero change for cashiers, a direct load. Cost: two of
  everything to keep in step, and reports split lunch and dinner unless someone adds them up.

## Slices (each: tester writes failing tests → builder → auditor; one PR per slice through the queue)
- **S0 (Haiku, read-only) — DONE, full list in `settings-audit/t510-s0.md`.** On origin/main: 3 writer sites
  (`repo/menu.ts:421` insert, `:448` hard delete, `domain/menu/pricing.ts:191,223,247`), about 9 readers (`repo/menu.ts:95,443,543,586`;
  ERP `menu/lib.ts:195,388,464`), SQL functions `menu_offer_in_force` (0196:531) and `menu_variant_has_live_offer` (0196:546), about 15 test
  files that insert offers. Guards to change in S1: `menu_offers_insert_guard()` (0196:647, monotonic check at :663),
  `historyClash` (`repo/menu.ts:95`), unique key `menu_offers_slot_unique` (0196:213). The v1 bridge (`menu_pos_v1_links`,
  `repo/menu.ts:719-751`) is read through `domain/pos/depletion-source.ts` only. T-508 adds no offer readers. Migrations: origin/main
  highest 0225; 0226 is on `lane/t508` only; 0227 free. The board (`webapps/shareat-coord/BOARD.md`) has no claim on 0227 or T-510.
  Unverified: body of `menu_history_delete_guard` (0196:616); whether `project.ts` callers pass daypart-blind rows.
- **S1 schema (S1a: migration 0233, classification and RLS rows; the repo `packages/db/src/repo/dayparts.ts` is S1b):** migration 0233 (R1–R3). Tests:
  overnight containment, overlap refused, all-day vs dayparted clash refused, retire refused, cross-store daypart refused by FK,
  existing offers unchanged. **Full suite on a fresh gate DB** (migration rule).
- **S1b repo and readers (after S1a merges).** Writers must handle the lock rule: **every write that touches several offers or a daypart in one transaction must retry once on SQLSTATE 40P01** (the locks are daypart row, then item key, then variant keys, enforced inside each guard but not across statements of one transaction; the integration test `known limit: ...` documents the exact interleaving). The monotonic rule is daypart-blind (a new row of any daypart may not be dated earlier than a stored row of another daypart). Readers that must learn about dayparts (found by the S1a audit, line numbers as of `lane/t510`):
  - `repo/menu.ts` `offersInForce` (~:543-566): the online lateral join `b` (~:553-554) must match on daypart too, or an online dayparted slot reads the wrong row.
  - `historyClash` `repo/menu.ts:95`: daypart-blind, so it over-refuses same-instant rows of different dayparts (Lunch and Dinner starting together).
  - `apps/erp/src/app/menu/lib.ts:195` and `:464`, and `apps/erp/src/app/menu/prices/page.tsx:61`.
  - `packages/domain/src/menu/project.ts:96` (`offerAt` keyed on variant + channel, last row wins): must pick by the daypart open now (R4), not the last row.
  - `menuSnapshot` (every reader of `menu_offer_in_force`, which now returns one row per LIVE daypart slot, or exactly one withdrawn row when nothing is live).
- **S2 domain:** live-offer resolution (R4), authorize (R8), audit (R12). Tests: Sunday 16:59 / 17:00 / 07:59 / 08:00 in
  `Asia/Manila`, day-of-week at midnight, not-offered-now result with `availableFrom`. The resolver's not-offered-now result
  also carries `availableAt` (UTC instant of the next opening) and `availableDay` (store-local weekday, 0-6); bad zone, instant,
  window or tied offers resolve to `invalid` with a reason (`daypart.ts`).
- **S3 ERP screens (R9).** Any action that writes several offers or a daypart in one transaction (for example switching a package from all-day to dayparted: withdraw, then add two) retries once on SQLSTATE 40P01, as in S1b. The form must explain a monotonic refusal in plain words (the rule is per store, variant and channel and ignores dayparts: a new row of any daypart cannot be dated earlier than a stored row of another daypart).
- **S4 projection (R6).** Needs T-508 S3 merged first.
- **S5 cutover load (R10)** with the signed pairing table and the load report. Practice proof with Lipa's real two
  schedules and prices.

## Out of scope
Discounts, charges, tenders and loyalty (next spec on the T-508 carrier) · holiday or date-specific windows · per-day price
differences inside one window · refill windows (v1 never read them) · Website menu (R11) · per-variant dayparts beyond the
offer.

## Acceptance
On the practice copy with `POS_MENU_SOURCE=erp` and Lipa's data: at 16:59 only lunch prices start; at 17:00 only dinner
prices start; a table started at 16:55 keeps the lunch price; at 03:00 the dinner price applies; the cashier sees "from
17:00" for a package outside its window. Gates green per slice.
