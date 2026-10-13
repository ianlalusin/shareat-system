# T-401: the ERP menu and catalog master (POS v2 P1 prerequisite)

**Status:** SPEC APPROVED WITH CHANGES 2026-10-13 (fresh Opus review applied); not scheduled: build after the 2 Nov dual-run work unless Ian says otherwise. Written at HEAD a9e299b.
**Review cuts (orchestrator, 2026-10-13; Ian may override any):** (a) the v1 import is deferred to the P1 carrier window; (b) the drift page is dropped; (c) S4 is trimmed to three routes.
**Model:** Sonnet lanes, tester first then builder, per slice. Any amendment is written in plan mode (Opus).
**Migration:** ONE, hand-authored (ADR-012 §5), number = next free at merge (0194 is held by T-398 S1's lane today).
**Source:** bible §13 row 307 (Ian, 2026-10-11: the menu is edited in ERP only; CUSTOMER's `categories` folds into it);
ADR-015 §2 (P1: "Postgres owns ... menu with depletion rule"), §7 (hot set gains menu and prices at P1); rows 269, 270,
276, 280, 283; DEF-595 (packages never deplete stock), DEF-021 (refill rules are magic numbers), DEF-003 (float money);
`docs/discovery/09-pos-system.md` §1.2, `10-customer-app.md` §7, `pos-pull-redesign-proposal.md` (orphans disappear
once every menu item carries a depletion rule).

⛔ **Not cutover work.** POS v1 keeps selling through 1 Jan 2027 and beyond, store by store. Nothing in this task may read
from, write to, or change the behaviour of the live v1 feed: `pos_v1_store_links`, `pos_v1_day_feeds`, `tenders`,
`pos_item_maps`, `pos_map_requests`, `pos_usage_pulls*`, `packages/domain/src/pos/**` (T-375, T-382, T-384, T-177, T-388).
The menu built here has **no reader in production** until the POS v2 carrier spec (P1) wires one.

---

## 1. Goal (row 283: v1's goal, not its method)

| | |
|---|---|
| **v1 today** | A global catalog in POS Firestore (`products`, `packages`, `refills`, `flavors`, option groups, `addonCategories`) plus a per-store **copy** of each sellable thing carrying its own price (`stores/{s}/inventory/{id}.sellingPrice` / `onlinePrice`, `storePackages.pricePerHead`, `storeRefills`, `storeFlavors`), discovery 09 §1.2 (`POS/src/lib/types.ts:26-409`). Prices are JS floats (DEF-003), overwritten in place, with no history. CUSTOMER reads a POS-built per-store snapshot (`stores/{s}/catalogCache/main`) and a second self-built refill cache; its own `categories` master (`CUSTOMER/src/app/admin/categories/page.tsx`) is read by nothing, so editing it changes nothing a diner sees. The ERP maps POS items to stock by hand per store (`pos_item_maps`, T-177), and package (unli) tables never deplete stock at all (DEF-595) |
| **The goal v1 serves** | One list of what each store sells, at what price, with which choices, so the till can ring it, the diner can order it, the kitchen can make it, and the books and stock can follow it |
| **What v1 gets wrong** | Two to three editors for one fact (POS admin, POS manager, CUSTOMER admin); a price changed today silently rewrites what "the price" was yesterday; the same product is a separate document per store; float money; a sentinel "empty list means every refill"; refills and flavours as separate masters with five alias spellings of one flag (`refill-options-cache.ts:145`); depletion lives outside the menu, so an unmapped item is discovered at the pull, as an orphan |
| **v2 goal** | **One org-level menu, edited in the ERP only.** Every sellable thing is a **variant**; every variant has a **depletion rule** before any store may offer it; a store's **price is an append-only, effective-dated offer**, so the price at any past moment is a query, never a guess, and a price change can be scheduled. Flavours and add-ons are **option groups**; refills are menu items that **cannot carry a price**; a package names its allowed refills explicitly. One pure, carrier-neutral **store-menu projection** is what the till and the diner app will later receive, by whichever carrier row 280's plan picks |

**Research (row 163 / row 283, brief).** Industry pattern (Toast, Square, Lightspeed, Odoo POS): a back-office item
master with variants and modifier groups, a per-location price/availability layer, and the register only toggling
86/sold-out. Effective-dated price rows are the ERPNext `Item Price` (valid_from/valid_upto) and Odoo pricelist shape;
we take the append-only half (no `valid_upto` to keep true: the next row ends the previous). Not adopted: Odoo's
generic pricelist rule engine (formulae, quantity breaks), it is promotions/discounts territory, which row 307 lists
separately; a generic product-configurator (unbounded attribute matrices), v1 never needed more than one variant axis.
Effort weighed: 10 tables, one migration, ≈ 6.25 lane-days (§6). The payoff is P1's whole menu half, DEF-595's end
state (packages deplete through refill servings) and the deletion of three v1 editors.

**v1 shapes counted (code read 2026-10-13, POS `e26d0c1a`, CUSTOMER `36adce0`).** Global `products` (`kind single|group|variant`,
no price, `POS/src/lib/types.ts:26-80`), per-store `stores/{s}/inventory` (`sellingPrice`, `onlinePrice` where unset
= follow and ≤ 0 = withheld, `isAddon`, `customerEnabled`, `onlineEnabled`, `kitchenLocationId`, `:256-329`; its doc id
is the ERP's `posItemKey`, equal to the product id for new rows only), global `packages` (no price) + `storePackages`
(`pricePerHead`, bundle fields, `refillsAllowed` with empty = all, `flavorsAllowed`, `menuScheduleId`, `:357-390`),
`refills`/`storeRefills` (no price, `isOther`), `flavors`/`storeFlavors`, global `optionGroups` with signed
`priceDelta` and a per-store disable list, categories as free-text `subCategory` (the `category` field is hard-coded
"Add-on", `admin/menu/products/page.tsx:296`). Prices are overwritten in place with no history or audit
(`manager/inventory/page.tsx:404,421`). **Neither repo holds any real menu data** (no seed, export or fixture: 0
products, 0 packages, 0 categories), so the live counts can only come from Firestore: the deferred import's `extract` (§7)
produces the census first. Daypart gates (`menuSchedules`, `types.ts:530`) and kitchen routing (per store per item) are store
settings (R13). v1 flaws noted for the register by the orchestrator: client-cached prices written onto bill lines
unvalidated (`store-context.tsx:307`), a manager-run client rebuild of `storeConfig/current` that leaves stale package
prices on failure (`lib/manager/dataManagement.ts:~120`), every product save resetting category sort to 0
(`admin/menu/products/page.tsx:320`), CUSTOMER's refill submit trusting client item/station/qty
(`CUSTOMER/src/app/api/customer/submit-refill/route.ts:84-111`).

**What already exists:** `items` (org-level stock master, T-145; `sellable_retail` at `packages/db/schema/items.ts:117-119`,
whose comment "POS owns the menu" this task makes false), `production_recipes` (T-176), `pos_item_maps` modes
`direct | recipe | no_stock` (`schema/pos-mapping.ts:65-109`), the pure explosion `explodePosSales`
(`packages/domain/src/pos/plan.ts`), `v1_master_links` and the read-only v1 extract (`packages/etl/src/master-data/
snapshot.ts`, `makeReadOnlyV1Client`), the apply pattern (`scripts/lib/master-data-apply.ts`: domain functions as a
named actor, one transaction, dry run = rollback, one audit row), `stores`, `persons`, `authorize()`. Wholesale
`price_lists` / `price_list_items` (`schema/customers.ts:46-105`) are **not** reused: they price stock items for B2B,
are edited in place, and carry no store or time. Different subject, different rules.

---

## 2. Rulings (planner)

- **R1, the variant is the sellable unit.** Every `menu_item` has one or more `menu_item_variants`; a plain item has
  exactly one (its default). Price, depletion, option-group overrides, offers and v1 links key on the variant. This
  replaces v1's `kind: single | group | variant` trichotomy (`POS/src/lib/types.ts:26-107`) with one shape.
- **R2, item types: `a_la_carte | package | refill`.** A package variant is priced **per head** or as a **bundle**
  (`bundle_heads` + `extra_head_amount`, v1's `isBundle/bundlePrice/bundleMaxCap/bundleExtraHeadPrice`). A refill is a
  zero-price serving a package entitles; **no offer row may carry an amount for a refill** (DB-enforced). Add-on is not
  a type: it is the item flag `sold_in_package_session` (v1 `isAddon`), beside `sold_a_la_carte` and
  `diner_orderable` (v1 `customerEnabled`).
- **R3, flavours are option values.** v1's `flavors` / `storeFlavors` / `requiresFlavor` / `allowedFlavorIds` become
  an option group (e.g. "Flavour", single, min 1) linked to the refill (or package) variants that need it, values at
  delta 0. One mechanism instead of two. A per-store flavour switch is an option-value **offer** (R5).
- **R4, option groups.** `menu_option_groups` (name, `selection_mode single|multi`, `min_selections`,
  `max_selections`; required = `min_selections > 0`, never a separate boolean) with `menu_option_values`. Linked to an
  item or to a variant; **a variant's links, if any, replace its item's** (v1's resolver, `CUSTOMER/src/lib/catalog/
  project.ts:471-476`; POS's server resolver instead takes the union parent ∪ variant ∪ store,
  `POS/src/lib/server/catalog-shared.ts`, so the two v1 apps disagree; v2 picks the replace rule and the import
  writes variant links as the union so nothing a cashier sees today disappears). Value deltas are **signed**, as in v1
  (`OptionGroup.values[].priceDelta`, `POS/src/lib/types.ts:242`: "no rice, -₱10" is real); a line can never price
  below zero (checked where a sale is recorded, P2).
- **R5, price is an OFFER: append-only, effective-dated, per store and channel.** `menu_offers (store, variant,
  channel, effective_from, amount | NULL, bundle_heads, extra_head_amount, withdrawn)`. ⛔ Never UPDATEd. The offer in
  force at time *t* is the row with the greatest `effective_from ≤ t`; `withdrawn = true` means "not sold from then";
  **no row in force means not offered** at that store on that channel. ⛔ **No back-dating:** an INSERT with
  `effective_from < now()` is refused by trigger (the column defaults to `now()`, so "from now" always passes; the past
  is never rewritten, not even by an import). A future row may be **deleted** until it takes effect (a cancelled
  scheduled change); a row in effect never can (DB trigger). Channels: `store` (counter and table, diner ordering
  included) and `online` (own online ordering, v1 `onlinePrice`); platform sales stay outside (row 130). **Amount:**
  on a per-head package offer `amount` is the price per guest; on a bundle offer (`bundle_heads` set) `amount` is the
  bundle price covering the first `bundle_heads` guests and `extra_head_amount` is charged per guest beyond; on any
  other variant it is the unit price. Whether a diner may order an item is the item flag `diner_orderable` (R2), not
  an offer column. Option-value deltas use the same shape in `menu_option_offers`, **with the same `channel`**: an
  `online` line prices its options from the `online` option offer, and an option value with no row in force on a
  channel is not offered there (so an option can be withheld online without being withheld at the counter).
  Money is `numeric(14,2)`, finite; amounts ≥ 0, deltas signed (R4) (bible §6). ⚠️ `numeric(14,2)` silently rounds
  `'10.005'`, so the domain refuses any input with more than 2 decimal places through `@shareat/core/money` before
  it reaches the cast.
- **R6, depletion is mandatory and effective-dated.** `menu_depletion_rules (variant, effective_from, mode direct |
  recipe | no_stock, item_id | recipe_id, quantity_per_sale)`, the `pos_item_maps` shape, append-only and
  never back-dated, like offers.
  ⛔ **A store may not hold a live (non-withdrawn) offer for a variant that has no depletion rule in force at the
  offer's `effective_from`** (DB trigger), so P2's orphan section cannot occur. The rule cannot be broken from the
  other side either: **deleting a scheduled rule re-checks every live offer that would rely on it** (DELETE trigger;
  refused if any would be left with no rule in force), and **retiring a variant or an item is refused while any live
  offer for it is in force or scheduled** (withdraw first). A package variant is normally
  `no_stock` (the head fee); its **refill** variants carry the serving's rule, which P3 applies per served refill
  ticket: DEF-595's end state. Option values may carry a rule; none means nothing extra is consumed. Quantities are in
  the stock item's base unit (as `pos_item_maps`).
- **R7, the menu does NOT feed the v1 usage pull.** `pos_item_maps` stays the pull's only authority until P2 retires
  the pull per store. No code path joins them, and no drift report is built here (review cut (b)); the deferred
  import seeds depletion rules from `pos_item_maps` when it runs (§7). (Q3.)
- **R8, a package names its refills.** `menu_package_refills (package_variant, refill_item)`. No "empty means all"
  sentinel (v1 `storePackages.refillsAllowed: []`); the deferred import expands that sentinel to the explicit list.
- **R9, categories.** `menu_categories`, org-level, one optional level of parent (v1 `category` + `subCategory`),
  `sort_order`, `status active|retired`. Every item has exactly one category. This **is** row 307's fold of
  CUSTOMER's `categories`: CUSTOMER's master is not imported (nothing reads it, §1); POS's category names are.
- **R10, org-scoped, with the same-org FK shape from day one.** Every table carries `org_id`, RLS `org_column`, and
  every FK to another org-scoped table has its composite companion `(org_id, col) → parent(org_id, id)` (T-357 /
  T-398 R2 shape), so T-398's DEF-491 census is green on arrival. Padre Garcia (row 305, T-398) has its **own menu in
  its own org**: no cross-org copy action exists (it would be a cross-org write). The deferred import loads PG's menu
  from v1 into PG's org, filtered to what the PG v1 store offers (`PADRE_GARCIA_V1_STORE_ID`,
  `master-data/store-map.ts`).
- **R11, names.** No table or column uses `session`, `receipt`, `product` or `dine_in` (GLOSSARY). "Offer" means a
  store's price row; the word is defined in the S1 schema header.
- **R12, the projection is pure and carrier-neutral.** `projectStoreMenu(snapshot, storeId, at)` returns a versioned
  JSON (`schemaVersion: 1`) plus `contentHash` (sha256 of a canonical serialisation) plus `nextChangeAt` (the earliest
  offer or rule `effective_from > at`, so a carrier knows when to republish a scheduled price). It imports no
  Firestore, HTTP or DB module. **It is not added to `mirror_outbox` / `MIRROR_ENTITIES`**: the hot set is closed
  (bible §5.3) and the carrier is undecided (row 280); the P1 carrier spec adds the entity or the device endpoint and
  amends the bible. Sold-out (86) is a POS floor action (row 307), written at P1 as a POS event; the projection
  carries `orderable` from offers only and leaves 86 to the overlay the carrier spec defines.
- **R13, out of this table set:** daypart menus (v1 `menuSchedules`), kitchen routing (a store-settings spec keys on `menu_item_variants.id`), refill
  cooldowns (DEF-021, store settings), images (diner content: public storage is decided with row 280's hosting
  move), discounts/charges/tenders, loyalty rewards.

---

## 3. Contract: tables (S1 defines them in `packages/db/schema/menu.ts`)

All: `id uuid pk default uuidv7()`, `org_id uuid not null → organizations`, `created_by → persons`, `created_at`.
Same-org composite FKs on every org→org reference (R10).

**Parent uniques the composite FKs need (purely additive, S1 adds them):** `UNIQUE (org_id, id)` on `items`,
`production_recipes`, `menu_categories`, `menu_items`, `menu_item_variants`, `menu_option_groups` and
`menu_option_values`. `stores` and `persons` get theirs from T-398 S1 (migration 0194); S1 builds after it, and if
0194 is not on main when S1 starts, S1 stops and reports rather than adding them itself. Grants: SELECT+INSERT for `shareat_app`; UPDATE only where
marked; DELETE only where marked.

| Table | Columns (beyond the common ones) | Keys / CHECKs / triggers | UPDATE | DELETE |
|---|---|---|---|---|
| `menu_categories` | `name`, `parent_id` (self, nullable), `sort_order int`, `status active|retired`, `updated_at` | UNIQUE (org, lower(name)); trigger: a parent has no parent; a retired category holds no active item | yes | no |
| `menu_items` | `category_id`, `name`, `description`, `item_type a_la_carte|package|refill`, `sold_a_la_carte bool`, `sold_in_package_session bool`, `diner_orderable bool`, `sort_order`, `status active|retired`, `updated_at` | UNIQUE (org, item_type, lower(name)) (a "Pork" refill and a "Pork" à la carte item are both real); CHECK refill ⇒ not `sold_a_la_carte` and not `sold_in_package_session`; trigger: `item_type` fixed once any variant has an offer; trigger: retire refused while a live offer for any variant is in force or scheduled | yes | no |
| `menu_item_variants` | `menu_item_id`, `label` (NULL only for the default), `is_default bool`, `sort_order`, `status`, `updated_at` | UNIQUE (item) WHERE is_default; UNIQUE (item, lower(label)); trigger: an active item keeps exactly one default; trigger: retire refused while a live offer is in force or scheduled | yes | no |
| `menu_option_groups` | `name`, `selection_mode single|multi`, `min_selections int ≥0`, `max_selections int`, `status`, `updated_at` | CHECK `max ≥ max(min,1)`; CHECK single ⇒ max = 1 | yes | no |
| `menu_option_values` | `option_group_id`, `name`, `sort_order`, `status`, `updated_at` | UNIQUE (group, lower(name)) | yes | no |
| `menu_option_group_links` | `option_group_id`, exactly one of `menu_item_id` / `variant_id`, `sort_order` | CHECK num_nonnulls(item, variant) = 1; UNIQUE per target+group | no | yes (unlink) |
| `menu_package_refills` | `package_variant_id`, `refill_item_id` | UNIQUE pair; trigger: variant's item is `package`, refill's item is `refill` | no | yes |
| `menu_depletion_rules` | `variant_id`, `effective_from timestamptz`, `mode`, `item_id`, `recipe_id`, `quantity_per_sale numeric(14,6)` | the `pos_item_maps_mode_shape_check` shape; qty > 0 finite; UNIQUE (variant, effective_from); triggers: INSERT refused when `effective_from < now()`; no UPDATE; DELETE only while `effective_from > now()` **and** no live offer would be left without a rule in force (R6) | no | future only |
| `menu_offers` | `store_id`, `variant_id`, `channel store|online`, `effective_from`, `amount numeric(14,2)` NULL, `bundle_heads int` NULL, `extra_head_amount numeric(14,2)` NULL, `withdrawn bool` | UNIQUE (store, variant, channel, effective_from); CHECK withdrawn ⇒ amounts NULL; CHECK amount ≥ 0 finite; CHECK (bundle_heads NULL) = (extra_head_amount NULL), bundle_heads ≥ 1; triggers: refill ⇒ amount NULL, non-refill live ⇒ amount NOT NULL; bundle only on a package; **live offer needs a depletion rule in force** (R6); store and variant same org; INSERT refused when `effective_from < now()`; append-only as above | no | future only |
| `menu_option_offers` | `store_id`, `option_value_id`, `channel store|online`, `effective_from`, `price_delta numeric(14,2)` NULL, `withdrawn bool` | UNIQUE (store, option_value, channel, effective_from); CHECK withdrawn ⇒ delta NULL, live ⇒ delta NOT NULL; delta signed, finite (R4); no back-dating, append-only, future-only DELETE as `menu_offers`. No row in force = not offered on that channel. Replaces v1's `stores/{s}/optionOverrides/main` disable list | no | future only |

`v1_master_links` is **not** touched here: extending its entity list belongs to the deferred import (§7).

**Registries (the build refuses otherwise):** `packages/db/src/rls/registry.ts`: all ten `org_column`.
`packages/db/src/cutover/classification.ts`: all ten `keep` (standing configuration, same class as `pos_item_maps`
and `tenders`; an offer history is the price record, not pilot activity).

**Capabilities** (`packages/auth/src/capabilities.ts`, every map; area `sales`; `docs/decisions/CAPABILITY-MATRIX.md`
"Configuration" rows; position defaults: none new).

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `view_menu` | org | ✅ | ✅ | ✅ | ✗ | Read the menu, offers and their history. Staff position-granted only (T-318) |
| `manage_menu` | org | ✅ | ✅ | ✗ | ✗ | Categories, items, variants, option groups, links, package refills. Row 307: one editor; the menu is org master data, same bar as `manage_price_lists` (Q1) |
| `set_menu_price` | store | ✅ | ✅ | ✗ | ✗ | Append an offer or option offer; schedule; cancel a future one. "Pricing is a commercial decision" (`manage_price_lists` row) (Q1) |
| `set_menu_depletion` | org | ✅ | ✅ | ✅ | ✗ | Depletion rules. Same bar as `manage_pos_map` / `manage_items`: the manager knows the recipe |

**Domain** (`packages/domain/src/menu/`): `createMenuCategory`, `editMenuCategory`, `retireMenuCategory`,
`createMenuItem` (creates its default variant), `editMenuItem`, `retireMenuItem`, `addMenuVariant`, `editMenuVariant`,
`retireMenuVariant`, `createOptionGroup`, `editOptionGroup`, `addOptionValue`, `editOptionValue`, `linkOptionGroup`,
`unlinkOptionGroup`, `setPackageRefills`, `setDepletionRule`, `cancelScheduledDepletionRule`, `setMenuOffer`,
`withdrawMenuOffer`, `cancelScheduledOffer`, `setOptionOffer`, `cancelScheduledOptionOffer`; every one takes `(actor,
input, tx?)`, calls `authorize()` first, writes one `audit_log` row. Reads in `packages/db/src/repo/menu.ts`:
`menuSnapshot(orgId)`, `offerHistory(storeId, variantId)`, `offersInForce(storeId, at)`.
Projection in `packages/domain/src/menu/project.ts` (R12).

---

## 4. Invariants and tests (one named mutant each; tester writes red first)

| # | Invariant | Test (file) | Mutant it must kill |
|---|---|---|---|
| I1 | An offer, option offer or depletion rule is never UPDATEd; a row in effect is never DELETEd; a future row may be | `t401-s1-offers-append-only.test.ts`: UPDATE refused; DELETE of past refused; DELETE of future allowed (as `shareat_app`), for all three tables | trigger allows DELETE regardless of `effective_from` |
| I1b | No back-dating: an INSERT with `effective_from < now()` is refused on `menu_offers`, `menu_option_offers` and `menu_depletion_rules`; the `now()` default passes | S1 test: `now() - interval '1 minute'` refused with the named message on each table; omitted `effective_from` accepted | back-dated insert accepted |
| I2 | The offer in force at *t* is the greatest `effective_from ≤ t`; withdrawn, or no row, means not offered; option offers resolve the same way per channel | `t401-s2-offer-in-force.test.ts`: 3 rows (past, now, future) queried at four instants; an option value offered on `store` only is offered there and absent `online`; an `online` option delta differs from the `store` one and each channel reads its own. Datetime case: the price form's "from 2026-12-01 00:00" (Asia/Manila, parsed by `@shareat/core/datetime`) stores `2026-11-30T16:00:00Z`, an instant, never a business date | `<` instead of `≤` in `offersInForce`; the form parses the time as UTC |
| I3 | A refill offer carries no amount; a non-refill live offer must | S1 test: both inserts refused with the named message | trigger checks only one direction |
| I4 | Bundle pricing only on a package; both bundle columns or neither | S1 test | CHECK on pair dropped |
| I5 | A live offer needs a depletion rule in force at its `effective_from` | S1 test: offer before rule refused; rule then offer accepted; rule dated after offer refused | trigger checks "any rule exists" instead of "in force at" |
| I5b | Deleting a scheduled rule cannot orphan an offer; retiring a variant or item with a live offer is refused | S1 test: rule R2 from T, offer from T+1h relying on R2 alone → DELETE R2 refused; with an earlier rule R1 still covering it → allowed; retire variant / item with an in-force or scheduled offer refused, after withdrawal allowed | rule delete skips the dependent-offer check |
| I6 | Depletion rule shape = `pos_item_maps` shape; qty > 0 | S1 test, one row per mode plus each bad shape | `recipe` branch accepts `item_id` |
| I7 | An active item has exactly one default variant | S1 test: second default refused; retiring the default without a replacement refused | partial unique index dropped |
| I8 | `item_type` cannot change once a variant has an offer; names are unique per org and type | S1 test: type change refused; a `refill` and an `a_la_carte` item both named "Pork" accepted; two `refill` items named "pork"/"Pork" refused | trigger checks variants instead of offers |
| I9 | A variant's option links replace its item's | `t401-s3-project.test.ts`: item links A, variant links B → projection shows B only; variant without links → A | resolver merges A ∪ B |
| I10 | Package refills: package → refill only; no empty-means-all | S1 + S3 tests: wrong types refused; package with no rows projects no refills | projection treats empty as all |
| I11 | Org isolation | S1 test as app role: org B reads 0 rows of org A's ten tables; composite FK refuses an offer pointing at org B's store and a variant pointing at org B's item | one table missing its policy (the registry test also catches it) |
| I12 | Capabilities: every ✅ has a ✗ that fires | `t401-s2-capabilities.test.ts`: manager refused `manage_menu` and `set_menu_price`; staff refused `set_menu_depletion` and `view_menu`; a staff member granted `set_menu_price` **for store A by position** (T-318) succeeds at A and is refused at B; positive: a manager may `set_menu_depletion` | `set_menu_price` scoped `org` instead of `store` |
| I13 | Money: offer amounts ≥ 0, deltas signed, all finite; no float arithmetic in domain | S1 CHECK test; S2 test passes `'0.1' + '0.2'`-shaped inputs through `@shareat/core/money` | domain uses `Number()` |
| I13b | More than 2 decimal places is refused, never rounded | S2 test: `setMenuOffer` with `'10.005'` refused with a named message, and no row written | domain lets the cast round |
| I14 | Projection is pure, deterministic, carrier-neutral | S3: same snapshot twice → same hash; key order shuffled → same hash; a unit test greps `project.ts` imports for `firebase`, `@shareat/db`, `fetch` | hash over non-canonical JSON |
| I15 | `nextChangeAt` names the next scheduled change | S3: future offer at T → `nextChangeAt = T`; none → null | returns last instead of next |
| I16 | ⛔ The live v1 feed is untouched | S2 unit guard: no file under `packages/domain/src/pos/**` or `packages/domain/src/sales-days/**` imports `menu`; the existing T-177/T-375/T-382/T-384/T-388 suites pass unchanged on the S1 migration | a builder "helpfully" reads `menu_depletion_rules` in `plan.ts` |
| I17 | Every audited write | S2: each mutating function leaves one `audit_log` row naming actor and entity | one function skips the audit |

---

## 5. Screens (S4, `apps/erp/src/app/menu/`), one visual family (§1.2c), nav entry gated by `view_menu`

| Route | What | Writes gated by |
|---|---|---|
| `/menu` | Items by category; filters: type, status, store, "no depletion rule", "not offered at store X". Categories are created, renamed, sorted and retired **inline** here | `manage_menu` (categories) |
| `/menu/items/[id]` | Item, its variants, option groups (inherited vs own; groups and values created and edited **inline**), package refills, depletion history, and a per-store offer table with the full history and any scheduled change | `manage_menu`, `set_menu_depletion`, `set_menu_price` |
| `/menu/prices` | Store picker → grid of variants × channel: price in force, scheduled change, "set new price from [date/time]" (default now), withdraw, cancel scheduled; option-value deltas per channel below. ⚠️ The date/time is read as **Asia/Manila** through `@shareat/core/datetime` and stored as an **instant** (timestamptz), never as a business date: 00:00 Manila on 1 Dec is `2026-11-30T16:00Z` (I2) | `set_menu_price` |

Every write is a server action that calls the domain (bible §7); a refused save keeps the typing (T-389 pattern).
A price is never typed into a URL (T-380). Smoketest on 9008 per `docs/SMOKETEST.md`.

---

## 6. Slices (TESTER and BUILDER paths are disjoint; tester first, red for the right reason)

| Slice | Size | Depends on | TESTER writes | BUILDER writes |
|---|---|---|---|---|
| **S1** schema + migration | M 2.0 | T-398 S1 merged (0194: `UNIQUE (org_id, id)` on stores and persons, its census, the next number) | `packages/db/tests/integration/t401-s1-*.test.ts` (I1, I1b, I3-I8, I5b, I10-I11, I13 DB half) | `packages/db/schema/menu.ts`, `schema/index.ts`, `schema/v1-master-links.ts` (entity list + NOTE), `schema/items.ts` (the `sellable_retail` comment only), `migrations/NNNN_t401_menu_catalog.sql`, `migrations/meta/_journal.json`, `src/rls/registry.ts`, `src/cutover/classification.ts` |
| **S2** domain, repo, capabilities | M 2.0 | S1 | `packages/domain/tests/integration/t401-s2-*.test.ts`, `packages/auth/tests/**/t401-*.test.ts`, `tests/unit/t401-v1-feed-untouched.test.ts` (I2, I12, I13, I13b, I16, I17) | `packages/domain/src/menu/*.ts` (not `project.ts`), `packages/domain/src/index.ts`, `packages/db/src/repo/menu.ts`, `packages/db/src/repo/index.ts`, `packages/auth/src/capabilities.ts`, `docs/decisions/CAPABILITY-MATRIX.md` (four rows), `docs/production-caller-baseline.txt` |
| **S3** projection | S 0.75 | S2 (repo types) | `packages/domain/tests/unit/t401-s3-project.test.ts` (I9, I10, I14, I15) | `packages/domain/src/menu/project.ts` |
| **S4** ERP screens (`/menu`, `/menu/items/[id]`, `/menu/prices`) | M 1.5 | S2 | `apps/erp/tests/integration/t401-s4-*.test.ts` (server actions refuse without capability; prices form round-trip including the Manila-midnight case; inline category and option-group edits) | `apps/erp/src/app/menu/**`, `apps/erp/src/components/nav.tsx` (one entry) |

Total ≈ 6.25 lane-days. S3 and S4 may run in parallel **only** on separate lane databases (bible §3.4).

---

## 7. Out of scope

Sales receipts, ordering, table state, KDS, kitchen tickets and routing, refill cooldowns and requests (DEF-021), the
86/sold-out event, discounts, charges, tenders (the tender master stays T-375's), loyalty rewards and the loyalty ledger,
store settings, images and diner content, the carrier (Firestore mirror or device outbox, row 280), any change to the
v1 usage pull or day feed (R7, I16), retiring `items.sellable_retail` (a follow-up once P2 reads the menu), BIR item
codes, the Website `/menu` (DEF-011), editing the bible (the P1 carrier spec amends §5.3), a drift report between
`pos_item_maps` and menu rules (review cut (b)), separate category and option-group pages (review cut (c)).

**The one-time v1 import is deferred to the P1 carrier window (review cut (a)).** Run now, it goes stale while v1
keeps selling, so menus would be entered twice. When it is specced, it follows T-391's extract, plan, sheet and apply
pattern; it extends `v1_master_links` with menu entities (the per-store POS inventory doc id → variant link P2 needs);
it writes offers at the apply time and never back-dates (I1b); it maps v1's "online price ≤ 0 = withheld" to a
withdrawn `online` offer and an unset online price to an `online` offer equal to the store price; it expands v1's
"empty means all refills"; it seeds depletion rules from `pos_item_maps` where stores agree and lists the rest on a
sheet; it routes Padre Garcia into its own org; and its `extract` produces the census of v1 shapes first. Its
idempotence and org-routing invariants belong to that spec.

## 8. Done when

- [ ] I1-I17 (with I1b, I5b, I13b) green; each tester file was red first for the stated reason; each mutant named in §4 was tried and killed.
- [ ] Migration applies from zero in CI; registry, classification, journal, DEF-491 census (if on main) and app-boundary tests green.
- [ ] Full suite green on the wrap-up PR; the T-177/T-375/T-382/T-384/T-388 suites unchanged and green.
- [ ] `/menu/**` smoketested on 9008 as admin (create a category inline, item, variant, option group inline, depletion rule, price now, price scheduled at Manila midnight, cancel) and as manager (read-only, depletion editable, price refused).
- [ ] `npm run build` green with the dev server stopped; typecheck clean; LF only.

## 9. Outcome

_(filled by the lanes: commits, test counts.)_

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| K1 | Two depletion truths during dual existence (`pos_item_maps` per store, menu rule per org) drift | R7: no join; the menu has no production reader until P1, the deferred import seeds rules from the maps, and P2 retires the map per store |
| K2 | An effective-dated "in force" query written twice (projection, repo) disagrees | One SQL function `menu_offer_in_force(store, variant, channel, at)` in the migration; repo and tests both call it; the projection receives rows already resolved |
| K3 | Org-level menu does not fit a store that sells something unique | A store-unique item is an org item offered at one store only. If Ian wants store-owned items (Q2 (b)), it is a new column, not a new table |
| K4 | The P1 carrier wants a stored snapshot (version number the till reports) | R12 returns a deterministic hash; a `store_menu_versions` table, if wanted, is the carrier spec's addition and needs no change here |
| K5 | v1 has no price history, so comparisons of "price before" the import are impossible | Stated, not hidden: the first offer row is written at import time and is never back-dated (I1b) |
| K6 | T-398 S1's census lands after S1 and finds a bare FK | R10 builds the composite FKs now; S1 waits on T-398 S1 merging if both are in flight |

## 11. Questions for Ian (Open Questions page; recommended option is what gets built)

- **Q1, who edits the menu and prices?** (a) admin and super-admin only; a branch manager, and a franchise owner
  (manager), asks you · (b) managers set prices for their own store; the menu itself stays admin · (c) managers edit
  both. **Recommended (a)**: one editor is row 307's point, and pricing is already admin-only for wholesale; you are
  admin of Padre Garcia's org too.
- **Q2, can a store own an item no other store sees in the editor?** (a) no: one org menu, a store simply does not
  offer it · (b) yes, a store-only item. **Recommended (a)**: fewer moving parts; "not offered" already hides it.
- **Q3, should the v1 usage pull start reading the menu's depletion rules before P2?** (a) no, `pos_item_maps` stays
  its only source until P2 · (b) yes, switch now. **Recommended (a)**: the live
  pull is not touched while v1 sells (row 307's sequencing, T-388 just stabilised it).
- **Q4, does an online price ever differ from the counter price?** (a) keep a separate `online` channel price (v1
  has `onlinePrice`) · (b) one price everywhere. **Recommended (a)**: v1 already carries it, the cost is one column
  value per offer, and dropping it is your call, not ours (§1.2d).
- **Q5, flavours as an option group on the refill (and package) instead of a separate flavour list?** (a) yes ·
  (b) keep a separate flavour master. **Recommended (a)**: same thing to the cashier and the diner, one editor, one
  per-store switch.
