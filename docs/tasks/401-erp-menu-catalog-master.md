# T-401: the ERP menu and catalog master (POS v2 P1 prerequisite)

**Status:** SPEC APPROVED WITH CHANGES 2026-10-13 (revised after Ian's answers; fresh Opus review applied). S1 built on lane, to be amended in place.
(S1 = migration 0196 on `lane/t401-s1`, commit 16ab42a, worktree `wt-t401`; not merged, not deployed, so 0196 is edited
in place, never followed by a 0197 fix-up. S2 is half-built and paused; §6a lists the tests that Ian's answers make wrong.)
Earlier status: SPEC APPROVED WITH CHANGES 2026-10-13 (fresh Opus review applied). Written at HEAD a9e299b.
**Review cuts (orchestrator, 2026-10-13; Ian may override any):** (a) the v1 import is deferred to the P1 carrier window; (b) the drift page is dropped; (c) S4 is trimmed to three routes.
**Model:** Sonnet lanes, tester first then builder, per slice. Any amendment is written in plan mode (Opus).
**Migration:** ONE, hand-authored (ADR-012 §5), number = next free at merge (0194 is held by T-398 S1's lane today).
**Source:** bible §13 row 307 (Ian, 2026-10-11: the menu is edited in ERP only; CUSTOMER's `categories` folds into it);
ADR-015 §2 (P1: "Postgres owns ... menu with depletion rule"), §7 (hot set gains menu and prices at P1); rows 269, 270,
276, 280, 283; DEF-595 (packages never deplete stock), DEF-021 (refill rules are magic numbers), DEF-003 (float money);
`docs/discovery/09-pos-system.md` §1.2, `10-customer-app.md` §7, `pos-pull-redesign-proposal.md` (orphans disappear
once every menu item carries a depletion rule).

⛔ **Not cutover work.** POS v1 keeps selling through 1 Jan 2027 and beyond, store by store. S1-S4 may not read from,
write to, or change the behaviour of the live v1 feed: `pos_v1_store_links`, `pos_v1_day_feeds`, `tenders`,
`pos_item_maps`, `pos_map_requests`, `pos_usage_pulls*`, `packages/domain/src/pos/**` (T-375, T-382, T-384, T-177, T-388).
**One exception, by Ian's Q3 ruling (2026-10-13): S5** adds a single seam file, `packages/domain/src/pos/depletion-source.ts`,
through which the usage pull of a store that has been **switched** reads menu depletion rules for its **linked** POS items.
A store with no switch row behaves byte-for-byte as today (R7, I16). The rest of the menu still has no production reader
until the POS v2 carrier spec (P1) wires one.

**Ian's rulings 2026-10-13 (§11 answered).** Q1 managers price their own store · Q2 one org menu; only super admin adds
items; managers request them, with a duplicate check · Q3 the v1 usage pull reads menu rules now, safely (S5) · Q4 a
separate online price, which may be a rule over the store price · Q5 flavours are an option group shared by many items.
Binding context: **AI is to be a central hub for the whole app family.** The AI parts of Q2 (AI duplicate check,
photo-assisted item entry) are a separate task built on that hub (§7a); T-401 builds the request workflow they plug into.

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
Effort weighed: 13 tables, one migration, ≈ 10.75 lane-days (§6, re-sized 2026-10-13 after Ian's answers). The payoff is P1's whole menu half, DEF-595's end
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
  **Ian, Q5 (2026-10-13): confirmed, and "flavours attach to many items".** One "Flavour" group is linked to every
  item or variant that uses it (`menu_option_group_links` already allows one group to many targets); adding a flavour
  adds one value, seen by all of them. No schema change.
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
- **R7 (REPLACED by Ian's Q3, 2026-10-13: "yes, switch now"), the v1 usage pull may read menu rules, per store, by
  switch.** Smallest correct cut-over, built in S5:
  1. **Link, store by store.** `menu_pos_v1_links (store, pos_item_key, variant, location_id)` says "this v1 POS item
     at this store is that menu variant". It is a store fact (the v1 key is per store, `stores/{s}/inventory` doc id),
     so it carries the store's own stock-location override (the `pos_item_maps.location_id` column, which an org rule
     cannot hold). A link may only be made to a variant with a depletion rule **in force now** (trigger), and rules are
     append-only with no withdraw, so a linked item always has a rule from then on.
  2. **Switch, store by store.** `menu_usage_source_switches (store, source pos_item_maps | menu_rules, reason,
     difference_count)`, append-only; the latest row is the store's source; **no row = `pos_item_maps`** (today).
  3. **What the pull does.** Source `pos_item_maps`: exactly today's code path (`listActiveMaps`), untouched.
     Source `menu_rules`: a sold v1 item with an active link uses its variant's rule **in force at the instant the plan
     is built** (the same "current mapping at plan time" semantics `pos_item_maps` has today, so a rule added this
     morning resolves yesterday's orphan exactly as a map does now; finalize rebuilds at its own instant and the
     existing plan/finalize diff refuses only a confirmed key that disappeared, `usage-pull.ts:519-523`, and a changed
     **posted** line, `:542-557`). ⚠️ **That diff is not enough for a source change:** plan keys are
     `direct:${posItemKey}` (`plan.ts:183`), so a map → rule swap with the same key, or a quantity change, keeps the key
     and passes for every not-yet-posted line. So two guards: **`switchUsageSource` locks the store row (`FOR UPDATE`)
     and is refused while the store has any `planned` pull** (that includes a partly finalized one: status stays
     `planned` until every section is stamped, `schema/pos-mapping.ts:197`); and **`setDepletionRule` /
     `cancelScheduledDepletionRule` are refused for a variant linked at a switched store that has a `planned` pull**,
     naming the store and business date ("finish or void the 12 Oct pull at Lipa first"). An **unlinked** item falls
     back to its `pos_item_maps` row, and with neither it is an orphan, as today. The pull's audit row carries
     `depletionSource` **only when the store is switched**; an unswitched store's audit payload is unchanged (I16).
  4. **Compare before switching (dry run).** `compareDepletionSources(store, days = 7)` rebuilds the plan both ways
     from the **stored** day feeds (T-375: usage never calls POS): per business date, the feed is
     `posV1Repo.latestForDay(tx, org, store, date, 'sold_items')` (`packages/db/src/repo/pos-v1.ts:353`, the feed usage
     itself reads) and the location is that day's pull location (`pos_usage_pulls.location_id`) if a non-void pull
     exists, else the store's default usage location. It lists every difference per day: lines only one side has,
     quantity and location differences, orphans each side. **It also diffs every active link's rule against the
     store's active map for that key whether or not the item sold in the window** (shape, item, recipe, quantity,
     location), so a slow seller cannot hide a difference. Read-only, writes nothing. Both plans come from one
     two-way builder in `depletion-source.ts` (`rebuildLines` is private to `usage-pull.ts`; the builder calls the
     same `explodePosSales` with each lookup map).
  5. **Switching to `menu_rules` is refused unless** the comparison, run inside the same call over the last 7 stored
     feeds (or all if fewer, at least 1), shows **zero differences**, or the actor passes `acceptDifferences` with a
     reason; the count and reason are stored on the switch row. **Switching back to `pos_item_maps` is always allowed,
     immediate, no comparison** (the rollback is one click).
  6. **Seeding.** `seedLinkFromMap(store, posItemKey, variant)` makes the link from the store's active map and, when the
     variant has no rule in force, sets the rule to that map's shape from now. This pulls forward the one part of the
     deferred import (§7) the switch cannot live without; the menu items themselves are still entered by hand (super
     admin, R14) until the import exists.
  7. **What happens to `pos_item_maps`.** Nothing. It is not migrated, edited or deleted by this task. It stays the
     authority for every unswitched store and the fallback for unlinked items in switched ones; map editing and map
     requests keep working. P2 retires it per store as before. The links table is also what P2 needs (it replaces the
     deferred import's planned `v1_master_links` extension for v1 POS item keys).
  ⚠️ **The new coupling, stated:** a menu rule is org-level, so once two switched stores link to one variant, changing
  that rule changes both stores' usage. `setDepletionRule` therefore returns, and the screen shows, the switched
  stores linked to the variant before saving (K7), **and it calls `authorize(actor, 'set_menu_depletion', store)` for
  every switched store with an active link to the variant**: `set_menu_depletion` is org-scoped, but such a rule
  changes live stock at those stores, so a manager scoped to Lipa only cannot change a rule Malvar's usage follows.
  8. **Stock item retirement.** `retireReadout` (`packages/db/src/repo/items.ts:1111-1135`) today counts on-hand,
     active `pos_item_maps` and active recipes; S5 adds `activeMenuRules`: depletion rules **in force or scheduled**
     naming the item (directly, or through a recipe that uses it) on a variant with an active link at a switched
     store. Retiring a stock item that a switched store's usage still depletes is refused like an active map.
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
- **R14, who edits what (Ian, Q1 + Q2, 2026-10-13).** (a) **Prices are per store and a manager sets them for their
  own store** (`set_menu_price` manager ✅, store-scoped: the store scope of `authorize()` is what keeps "their own").
  Admin and super admin price any store they are scoped to. (b) **Items are centralised: only super admin adds an
  item or a variant** (new `add_menu_item`, super ✅ only). Editing the rest of the menu (categories, option groups,
  links, package refills, item edits and retirement) stays `manage_menu` (super + admin): Ian ruled on *adding*, not
  editing; if he wants editing super-only too it is one cell. (c) **A manager requests an item** (`request_menu_item`,
  store-scoped, manager ✅, admin ✅, super ✅): `menu_item_requests` (store, name, item type, category hint, note,
  status `open | approved | duplicate | rejected | withdrawn`). At submit the domain runs a **deterministic duplicate
  check** (normalised exact name, then `pg_trgm` `similarity ≥ 0.4`, the extension is installed since 0050) and
  returns the likely matches so the requester can use an existing item instead; the request is still allowed after
  seeing them. **Only super admin resolves it** (orchestrator ruling 2026-10-13, consistent with "only super admin adds
  items"; all three under `add_menu_item`): **approve** (creates the item with `createMenuItem` in the same transaction
  and records it), **duplicate** (points at the existing item; the requester sees which), or **reject** (reason). A
  requester may **withdraw only their own** open request.
  The **AI** duplicate check and photo-assisted entry are the separate task in §7a; they write to this same table, so
  nothing here is thrown away.
- **R15, online price can be a rule (Ian, Q4, 2026-10-13: "we have this in commissary pricing v1, so items with volatile
  price adjust automatically").** Reuses the commissary model **as is**: the mode names are v1's and v2's
  `PRICING_MODES = fixed | fixed_markup | percent_markup` (`packages/db/schema/items.ts:342`, T-151; v1
  `ERP-rebuild/src/lib/financial/commissary/pricing.ts:81`), with `markup_percent numeric(8,4)` and
  `fixed_markup_amount numeric(14,2)` as in `item_pricing`. The **basis is the store-channel price in force at the
  same instant** (commissary's basis is landed cost; ours is the counter price). So:
  `fixed` = `amount` as typed (a manual online price, today's behaviour) · `percent_markup` = store × (100 + p)/100,
  `p` signed (−10 = 10 % lower), `p > −100` · `fixed_markup` = store ± a peso amount (signed). **The rule is resolved at
  read, never stored**, exactly as T-151's `branchPriceFor` resolves at read (no stored online price can go stale):
  when the store price changes, the online price follows from that instant with no second write. Rules are on the
  `online` channel only (`store` rows are always `fixed`), on **offers rows** (so they are append-only and effective-
  dated like every price: changing a rule is a new row). **Rounding:** exact decimal arithmetic, rounded **once,
  half-up on the absolute value, to the centavo**, the same rule as `computeBranchPrice`
  (`packages/domain/src/items/branch-price.ts:82-88`); the S2 builder extracts that pure step into one shared helper
  rather than writing a second (examples: ₱85.50 at +7.5 % = 91.9125 → **91.91**; ₱10.10 at +5 % = 10.605 → **10.61**;
  ₱99.00 at −10 % = **89.10**). A **bundle** store offer: the rule applies to both `amount` and `extra_head_amount`,
  and the online row inherits `bundle_heads` from the store offer (a rule row carries no bundle columns). A rule whose
  basis is missing (no store offer in force, or the store offer withdrawn) means **not offered online** at that
  instant; a rule that resolves **below ₱0.00** also means not offered online, with the reason `rule_below_zero`
  shown on `/menu/prices`; it is never clamped to zero. Refills: no rule (they carry no price). Option-value deltas
  online stay `fixed` only (deltas are small; a rule there is a later ask, not built).

---

## 3. Contract: tables (S1 defines them in `packages/db/schema/menu.ts`)

All: `id uuid pk default uuidv7()`, `org_id uuid not null → organizations`, `created_by → persons`, `created_at`.
Same-org composite FKs on every org→org reference (R10).

**Parent uniques the composite FKs need (purely additive, S1 adds them):** `UNIQUE (org_id, id)` on `items`,
`production_recipes`, `menu_categories`, `menu_items`, `menu_item_variants`, `menu_option_groups` and
`menu_option_values`, plus **`stock_locations`** (new 2026-10-13, for `menu_pos_v1_links.location_id`; add it only if it
is not already there). `stores` and `persons` get theirs from T-398 S1 (migration 0194); S1 builds after it, and if
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
| `menu_item_requests` **(new, R14)** | `store_id`, `requested_by → persons`, `name`, `item_type`, `category_id` NULL (a hint), `note`, `status open|approved|duplicate|rejected|withdrawn`, `resolved_item_id → menu_items` NULL, `resolved_by → persons` NULL, `resolved_at` NULL, `resolution_note` NULL, `updated_at` | CHECK name not blank; CHECK status `open` ⇔ all `resolved_*` NULL; CHECK `approved`/`duplicate` ⇒ `resolved_item_id` NOT NULL; CHECK `rejected` ⇒ `resolution_note` not blank; trigger: only `open → approved|duplicate|rejected|withdrawn`, a resolved request never changes again; trigger: `name`, `store_id`, `requested_by`, `item_type` frozen on UPDATE; index (org, status) | yes (status workflow only) | no |
| `menu_pos_v1_links` **(new, R7)** | `store_id`, `pos_item_key text`, `variant_id`, `location_id → stock_locations` NULL, `status active|inactive`, `updated_at` | UNIQUE (store, pos_item_key) WHERE active; CHECK key not blank; trigger on INSERT and on re-activation: the variant has a depletion rule **in force now** and is active; trigger: `variant_id`, `store_id`, `pos_item_key` immutable (relink = deactivate + insert); location's store = link's store | yes (status, location) | no |
| `menu_usage_source_switches` **(new, R7)** | `store_id`, `source pos_item_maps|menu_rules`, `reason text` NULL, `difference_count int ≥ 0` NULL | the instant is `created_at` (no `effective_from`: a switch is immediate, never scheduled, never back-dated; INSERT trigger sets `created_at = now()`); CHECK `menu_rules` with `difference_count > 0` ⇒ reason not blank; append-only: UPDATE guard `ENABLE ALWAYS`, no DELETE grant; index (store, created_at desc) | no | no |

**The three new tables follow R10 exactly as the first ten:** `ENABLE` **and `FORCE ROW LEVEL SECURITY`**, the
`org_column` policy, and composite same-org FKs `(org_id, col) → parent(org_id, id)` for every org-scoped reference:
`menu_item_requests.store_id`, `requested_by`, `resolved_by`, `resolved_item_id`, `category_id`;
`menu_pos_v1_links.store_id`, `variant_id`, `location_id`; `menu_usage_source_switches.store_id` (and `created_by`
on all three, as on the ten).

**`menu_offers` gains three columns (R15, Q4) in 0196 in place:** `pricing_mode text NOT NULL DEFAULT 'fixed'`
(CHECK in `fixed, fixed_markup, percent_markup`), `markup_percent numeric(8,4)` NULL, `fixed_markup_amount numeric(14,2)`
NULL. New CHECKs: `menu_offers_store_channel_fixed_check` (channel `store` ⇒ mode `fixed`);
`menu_offers_rule_shape_check` (`fixed` ⇒ both rule columns NULL; `percent_markup` ⇒ `markup_percent` NOT NULL, finite,
`> -100`, `amount`, bundle columns and `fixed_markup_amount` NULL; `fixed_markup` ⇒ `fixed_markup_amount` NOT NULL and
finite (signed), `amount`, bundle columns and `markup_percent` NULL); `menu_offers_withdrawn_no_amounts_check` widens
to "withdrawn ⇒ mode `fixed` and every amount and rule column NULL". The insert guard's "non-refill live ⇒ amount NOT
NULL" becomes "non-refill live **fixed** ⇒ amount NOT NULL", and "refill ⇒ amount NULL" becomes "refill ⇒ mode `fixed`
and amount NULL". The K2 SQL function `menu_offer_in_force` keeps returning raw rows; the rule is resolved in the
domain (R15), never in a trigger or a stored column.

`v1_master_links` is **not** touched here: `menu_pos_v1_links` is the v1-POS-key link (R7.7); the deferred import may
still extend `v1_master_links` for the global catalog ids (§7).

**Registries (the build refuses otherwise):** `packages/db/src/rls/registry.ts`: all **thirteen** `org_column`.
`packages/db/src/cutover/classification.ts`: all thirteen `keep` (standing configuration, same class as `pos_item_maps`
and `tenders`; an offer history is the price record, not pilot activity; a switch row is configuration; a request is
the item master's intake, kept with it).

**Capabilities** (`packages/auth/src/capabilities.ts`, every map; area `sales`; `docs/decisions/CAPABILITY-MATRIX.md`
"Configuration" rows; position defaults: none new).

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `view_menu` | org | ✅ | ✅ | ✅ | ✗ | Read the menu, offers and their history. Staff position-granted only (T-318) |
| `add_menu_item` **(new)** | org | ✅ | ✗ | ✗ | ✗ | `createMenuItem`, `addMenuVariant`, and every request resolution (approve, duplicate, reject). Ian, Q2: "items are centralised and ONLY super admin adds them" |
| `manage_menu` | org | ✅ | ✅ | ✗ | ✗ | Categories, item and variant edits and retirement, option groups, links, package refills. Row 307: one editor. Does **not** resolve requests |
| `request_menu_item` **(new)** | store | ✅ | ✅ | ✅ | ✗ | Ask for an item to be added; see the duplicate check; withdraw one's own open request (R14) |
| `set_menu_price` | store | ✅ | ✅ | **✅** | ✗ | Append an offer (fixed or online rule) or option offer; schedule; cancel a future one. **Ian, Q1: managers set prices for their own store** (changed from ✗) |
| `set_menu_depletion` | org | ✅ | ✅ | ✗ | ✗ | Depletion rules (the stock recipe). **Ian 2026-10-13: only admin edits recipes**, so the manager is ✗; this matches `manage_pos_map` and `manage_recipes` after T-403 |
| `switch_usage_source` **(new, S5)** | store | ✅ | ✅ | ✗ | ✗ | Switch a store's usage pull to menu rules or back (R7.5). It changes what live stock posts, so it sits above the map editors. Links themselves use the existing `manage_pos_map` (store, manager ✅): a link is the same store fact a map is |

**Domain** (`packages/domain/src/menu/`): `createMenuCategory`, `editMenuCategory`, `retireMenuCategory`,
`createMenuItem` (creates its default variant), `editMenuItem`, `retireMenuItem`, `addMenuVariant`, `editMenuVariant`,
`retireMenuVariant`, `createOptionGroup`, `editOptionGroup`, `addOptionValue`, `editOptionValue`, `linkOptionGroup`,
`unlinkOptionGroup`, `setPackageRefills`, `setDepletionRule`, `cancelScheduledDepletionRule`, `setMenuOffer`,
`withdrawMenuOffer`, `cancelScheduledOffer`, `setOptionOffer`, `cancelScheduledOptionOffer`; **added 2026-10-13:**
`requestMenuItem` (returns `possibleDuplicates`), `withdrawMenuItemRequest`, `approveMenuItemRequest`,
`markMenuItemRequestDuplicate`, `rejectMenuItemRequest` (S2); `resolveOfferPrice` (pure, R15: offer + store basis →
`{ amount, extraHeadAmount, bundleHeads } | { notOffered: 'no_basis' | 'withdrawn' | 'rule_below_zero' }`);
`linkPosV1Item`, `unlinkPosV1Item`, `seedLinkFromMap`, `compareDepletionSources`, `switchUsageSource` (S5). Every
mutating one takes `(actor, input, tx?)`, calls `authorize()` first, writes one `audit_log` row. Reads in
`packages/db/src/repo/menu.ts`: `menuSnapshot(orgId)`, `offerHistory(storeId, variantId)`, `offersInForce(storeId, at)`
(online rule rows come back with their store basis row, both from `menu_offer_in_force` at the same `at`),
`similarMenuItems(orgId, name)`, `usageSourceInForce(storeId)`, `activeLinks(storeId)`.
Projection in `packages/domain/src/menu/project.ts` (R12); it receives online prices already resolved by
`resolveOfferPrice`, so it does no money arithmetic of its own.

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
| I11 | Org isolation | S1 test as app role: org B reads 0 rows of org A's **thirteen** tables; composite FK refuses an offer pointing at org B's store and a variant pointing at org B's item | one table missing its policy (the registry test also catches it) |
| I12 | Capabilities: every ✅ has a ✗ that fires (**revised for Q1/Q2**) | `t401-s2-capabilities.test.ts` + `packages/auth/tests/t401-capability-cells.test.ts`: **a manager may `setMenuOffer` at a store they are scoped to and is refused at a store they are not**; admin is refused `createMenuItem` / `addMenuVariant` (`add_menu_item`) while super admin may; manager refused `manage_menu`; staff refused `set_menu_depletion`, `view_menu`, `request_menu_item`; a staff member granted `set_menu_price` **for store A by position** (T-318) succeeds at A and is refused at B; manager refused `switch_usage_source`; **a manager scoped to store A only is refused `setDepletionRule` on a variant linked at switched store B** (S5); positive: an admin may `set_menu_depletion`; a manager is refused it (Ian, only admin edits recipes) and may `request_menu_item` | `set_menu_price` scoped `org` instead of `store` (the manager then prices every store); `add_menu_item` wired like `manage_menu` (admin adds items) |
| I13 | Money: offer amounts ≥ 0, deltas signed, all finite; no float arithmetic in domain | S1 CHECK test; S2 test passes `'0.1' + '0.2'`-shaped inputs through `@shareat/core/money` | domain uses `Number()` |
| I13b | More than 2 decimal places is refused, never rounded (rule figures: `markup_percent` more than **4**, `fixed_markup_amount` more than **2**) | S2 test: `setMenuOffer` with `'10.005'` refused with a named message, and no row written; an online `percent_markup` of `'7.12345'` refused (4 dp `'7.1234'` accepted); a `fixed_markup` of `'-5.005'` refused | domain lets the cast round |
| I14 | Projection is pure, deterministic, carrier-neutral | S3: same snapshot twice → same hash; key order shuffled → same hash; a unit test greps `project.ts` imports for `firebase`, `@shareat/db`, `fetch` | hash over non-canonical JSON |
| I15 | `nextChangeAt` names the next scheduled change | S3: future offer at T → `nextChangeAt = T`; none → null | returns last instead of next |
| I16 | ⛔ The live v1 feed is untouched **except through one seam, and an unswitched store is byte-identical** (revised for Q3) | S2 unit guard `tests/unit/t401-v1-feed-untouched.test.ts`: no file under `packages/domain/src/pos/**` or `packages/domain/src/sales-days/**` imports `menu` **except `pos/depletion-source.ts`** (S5 adds that one allow-list entry, nothing else); the existing T-177/T-375/T-382/T-384/T-388 suites pass **unchanged** on the S1 migration and again after S5; S5 test: a store with no switch row builds a plan, and writes audit payloads, deep-equal to the **golden** output the S5 tester captures from `main` **before the builder edits anything** (committed as a fixture) for the same stored feed; `depletionSource` appears in the audit payload only for a switched store | a builder reads `menu_depletion_rules` in `plan.ts`; S5 changes `listActiveMaps` or the no-switch path |
| I17 | Every audited write | S2: each mutating function leaves one `audit_log` row naming actor and entity | one function skips the audit |
| I18 | **Online rule resolution (Q4).** `percent_markup` and `fixed_markup` online prices are computed from the store offer in force **at the queried instant**, rounded once half-up to the centavo | `t401-s2-online-rule.test.ts`: store ₱85.50, online +7.5 % → 91.91; ₱10.10 at +5 % → 10.61; ₱99.00 at −10 % → 89.10; ₱99.00 + (−₱5.00) → 94.00; **store price changes at T → online price at T+1s follows with no new online row**; bundle store offer → rule applied to `amount` and `extra_head_amount`, `bundle_heads` inherited | resolver reads the store offer in force at the **online row's `effective_from`** instead of at *t* (the online price then never follows); rounding per step instead of once |
| I19 | Rule edge cases: no basis or a withdrawn basis means not offered online; a result below zero means not offered online, never 0.00 | same file: store withdrawn → `notOffered: 'withdrawn'`; no store row → `'no_basis'`; ₱3.00 + (−₱5.00) → `'rule_below_zero'`; the projection marks each not orderable online | clamp to `0.00` |
| I20 | Rule shape in the DB | S1 test: `store` channel with `percent_markup` refused; `percent_markup` with an `amount` refused; `markup_percent = -100` refused, `-99.9999` accepted; `fixed_markup` with NULL amount column accepted; a refill with any rule refused; withdrawn with a rule column refused | rule-shape CHECK dropped (an `amount` and a rule on one row: which wins?) |
| I21 | **Only super admin adds an item; a request resolves once** (Q2) | S1 test (requests table): status `open → approved` with no `resolved_item_id` refused; a resolved request updated again refused; `rejected` without a note refused. S2 test `t401-s2-item-requests.test.ts`: manager `requestMenuItem` "Samgyupsal Set" with "Samgyupsal set" already on the menu returns it in `possibleDuplicates`; approve by super admin creates the item **and** resolves the request in one transaction (roll back → neither); approve, mark-duplicate and reject by **admin** each refused (`add_menu_item`); duplicate needs an existing item id; a manager cannot request for a store outside their scope; **manager B cannot withdraw manager A's request** (refused, request stays `open`). S1: an UPDATE changing `name`, `store_id`, `requested_by` or `item_type` refused | approval creates the item on another connection, or leaves the request `open`; resolution gated by `manage_menu` (admin resolves) |
| I22 | A v1 link always has a rule | S1 test: link to a variant with no rule in force refused; with a rule only scheduled for the future refused; with a rule in force accepted; two active links for one (store, key) refused; changing `variant_id` refused (relink = deactivate + insert) | trigger accepts "any rule exists" |
| I23 | **Usage source resolution (Q3).** Switched store: linked key → menu rule in force at plan time, with the link's location; unlinked key → its `pos_item_maps` row; neither → orphan. Unswitched store: maps only | `t401-s5-depletion-source.test.ts` (domain integration, stored feed fixture): three sold keys (linked, map-only, neither) → menu line, map line, orphan; a rule added **after** the business day but before the plan resolves that day's line (plan-time semantics, as maps do today); **`switchUsageSource` refused while the store has a `planned` pull, including one with the direct section already stamped; accepted once it is finalized or void**; **`setDepletionRule` on a variant linked at a switched store with a `planned` pull refused, naming store and date** | fallback skipped (map-only items become orphans on switch day); source read from the link instead of the switch row |
| I24 | **No blind switch.** Switching to `menu_rules` runs the comparison itself; with differences it is refused unless `acceptDifferences` + a reason, stored with the count; switching back needs nothing | `t401-s5-switch.test.ts`: 7 stored feeds, one key's rule differs from its map → refused naming the day and key; with reason → accepted, row carries `difference_count = 1`; switch back accepted at once and the next plan is maps-only; `compareDepletionSources` writes no row (row counts before/after equal) | switch skips the comparison; comparison writes a plan or a pull row |
| I25 | `seedLinkFromMap` copies the map exactly | S5 test: a `direct` map (item, qty 0.25, location L) → link with location L and, the variant having no rule, a rule `direct`/item/0.25 from now; the comparison for that key is then zero-difference; a variant that already has a different rule keeps it and the difference is reported, not overwritten | seed overwrites an existing org rule (silently changes another switched store) |
| I26 | Switches are append-only history | S1 test: UPDATE refused even in replica mode (`ENABLE ALWAYS`); DELETE not granted; `created_at` supplied in the past is overwritten to `now()` | UPDATE guard left `ENABLE` (origin only) |
| I27 | A stock item a switched store still depletes through the menu cannot be retired | S5 test: item X used by a rule on a variant linked at switched store A → `retireReadout.activeMenuRules = 1` and retire refused; store A switched back (or link inactive) → 0 and retire allowed (if nothing else holds it); a rule only **scheduled** also counts | readout counts `pos_item_maps` only |

---

## 5. Screens (S4, `apps/erp/src/app/menu/`), one visual family (§1.2c), nav entry gated by `view_menu`

| Route | What | Writes gated by |
|---|---|---|
| `/menu` | Items by category; filters: type, status, store, "no depletion rule", "not offered at store X". Categories are created, renamed, sorted and retired **inline** here | `manage_menu` (categories) |
| `/menu/items/[id]` | Item, its variants, option groups (inherited vs own; groups and values created and edited **inline**), package refills, depletion history, and a per-store offer table with the full history and any scheduled change | `manage_menu`, `set_menu_depletion`, `set_menu_price` |
| `/menu/prices` | Store picker (a manager sees only their own stores, Q1) → grid of variants × channel: price in force, scheduled change, "set new price from [date/time]" (default now), withdraw, cancel scheduled; option-value deltas per channel below. **Online column (Q4):** "Fixed ₱ / % over store / ₱ over store" with the resolved price shown beside the rule and a `rule_below_zero` or "no counter price" warning. ⚠️ The date/time is read as **Asia/Manila** through `@shareat/core/datetime` and stored as an **instant** (timestamptz), never as a business date: 00:00 Manila on 1 Dec is `2026-11-30T16:00Z` (I2) | `set_menu_price` |
| `/menu/requests` **(new, Q2)** | A manager: "Request an item" (name, type, category hint, note) → the duplicate check's matches shown first ("Samgyupsal Set already exists: use it?"), then submit; their requests and outcomes. Super admin: the open queue, each with its matches; approve (opens the new-item form pre-filled), mark duplicate (pick the item), reject (reason) | `request_menu_item`; `add_menu_item` (super admin) to resolve |
| `/menu/usage-source` **(new, S5, Q3)** | Store picker → current source and its history; links table (v1 POS key and name from the store's maps and feeds → variant, location), "seed from map", unlink; **Compare** (last 7 stored days, differences per day and key); **Switch to menu rules** (refused with the list if differences, or with a typed reason) and **Switch back** (always available) | `manage_pos_map` (links), `switch_usage_source` |

Every write is a server action that calls the domain (bible §7); a refused save keeps the typing (T-389 pattern).
A price is never typed into a URL (T-380). Smoketest on 9008 per `docs/SMOKETEST.md`.

---

## 6. Slices (TESTER and BUILDER paths are disjoint; tester first, red for the right reason)

| Slice | Size | Depends on | TESTER writes | BUILDER writes |
|---|---|---|---|---|
| **S1** schema + migration | M 2.0 | T-398 S1 merged (0194: `UNIQUE (org_id, id)` on stores and persons, its census, the next number) | `packages/db/tests/integration/t401-s1-*.test.ts` (I1, I1b, I3-I8, I5b, I10-I11, I13 DB half; amend: I20, I21 DB half, I22, I26) | `packages/db/schema/menu.ts`, `schema/index.ts`, `schema/v1-master-links.ts` (entity list + NOTE), `schema/items.ts` (the `sellable_retail` comment only), `migrations/NNNN_t401_menu_catalog.sql`, `migrations/meta/_journal.json`, `src/rls/registry.ts`, `src/cutover/classification.ts` |
| **S2** domain, repo, capabilities | M 2.75 | S1 | `packages/domain/tests/integration/t401-s2-*.test.ts`, `packages/auth/tests/**/t401-*.test.ts`, `tests/unit/t401-v1-feed-untouched.test.ts` (I2, I12, I13, I13b, I16, I17; amend: I18, I19, I21) | `packages/domain/src/menu/*.ts` (not `project.ts`), `packages/domain/src/index.ts`, `packages/db/src/repo/menu.ts`, `packages/db/src/repo/index.ts`, `packages/auth/src/capabilities.ts` (**all seven** capabilities, including S5's `switch_usage_source`, so S5 never edits it), `docs/decisions/CAPABILITY-MATRIX.md` (**seven rows**), `packages/domain/src/items/branch-price.ts` (extract the once-only half-up rounding step into the shared helper R15 uses; behaviour unchanged), `docs/production-caller-baseline.txt` |
| **S3** projection | S 0.75 | S2 (repo types) | `packages/domain/tests/unit/t401-s3-project.test.ts` (I9, I10, I14, I15) | `packages/domain/src/menu/project.ts` |
| **S4** ERP screens (`/menu`, `/menu/items/[id]`, `/menu/prices`, `/menu/requests`) | M 2.0 (was 1.5: + requests page, online-rule column) | S2 | `apps/erp/tests/integration/t401-s4-*.test.ts` (server actions refuse without capability; prices form round-trip including the Manila-midnight case and an online % rule; a manager's store picker lists only their stores; inline category and option-group edits; request → duplicate shown → submit; approve as super admin) | `apps/erp/src/app/menu/**` (not `usage-source/`), `apps/erp/src/components/nav.tsx` (one entry) |
| **S5** v1 usage pull switch (Q3) **(new)** | M 2.5 | S2; T-388 merged (it is) | **first** the golden no-switch plan and audit fixture captured from `main` (I16); `packages/domain/tests/integration/t401-s5-*.test.ts` (I23-I25, I27), `tests/unit/t401-v1-feed-untouched.test.ts` (the one allow-list entry, I16), `apps/erp/tests/integration/t401-s5-usage-source.test.ts` | `packages/domain/src/pos/depletion-source.ts` (**new; the only new file under `pos/**`**; holds the lookup loader and the two-way plan builder), `packages/domain/src/pos/usage-pull.ts` (**`rebuildLines` only**: its `listActiveMaps` call becomes `loadDepletionLookups`, and the audit payload gains `depletionSource`; nothing else in the file), `packages/domain/src/menu/links.ts`, `menu/compare.ts`, `packages/db/src/repo/menu.ts` (links, switches), `packages/db/src/repo/items.ts` (`retireReadout` only) and its caller in `packages/domain/src/items/index.ts` (the retire refusal), `apps/erp/src/app/menu/usage-source/**`, `docs/production-caller-baseline.txt` |

Total ≈ 10.75 lane-days (S1 2.75 = 2.0 built + 0.75 amend, S2 2.75, S3 0.75, S4 2.0, S5 2.5; was 6.25); **8.75 still to
do**. (The first revision's 9.75 mis-added these figures.) S3 and S4 may
run in parallel **only** on separate lane databases (bible §3.4). **S5 runs last and alone in its window**: it is the
only slice that touches the live pull, so it gets the full suite on a fresh gate DB before merge, and no store is
switched in production until Ian picks the first store after a zero-difference comparison there.

**Re-sizing (2026-10-13).** S1 amend (in place, 0196): + 3 tables, + 3 `menu_offers` columns and 2 CHECKs, 2 guard
edits, `stock_locations` unique; ≈ 0.75. S2: was 2.0, + requests workflow and duplicate check 0.5, + `resolveOfferPrice`
and the shared rounding helper 0.25 → 2.75. Cost and risk per question: Q1 ≈ 0 (one cell, tests flip); Q2 ≈ 1.0 across
S1/S2/S4, low risk (new tables, no live reader); Q4 ≈ 0.75, low risk (resolved at read, reuses T-151's maths); Q5 0;
**Q3 ≈ 3.25 (S5 plus its S1 tables), the only change with production risk**, contained by the per-store switch, the
mandatory comparison and the one-click rollback.


---

## 6a. S1/S2 tests Ian's answers make wrong (tester: change these first; all in `wt-t401`)

| File | Case | Change |
|---|---|---|
| `packages/domain/tests/integration/t401-s2-capabilities.test.ts:95` | "manager is refused setMenuOffer at a store they are scoped to (mutant: manager allowed, Q1 option b)" | **Inverts**: manager succeeds at own store and is refused at a store outside their scope (the fixture scopes every role to both stores, `_fixtures/t401-s2-menu.ts:5`: add a manager scoped to A only) |
| same file `:78` | "manager is refused createMenuCategory and createMenuItem with manage_menu" | Split: `createMenuCategory` stays `manage_menu`; the `createMenuItem` refusal names `add_menu_item` |
| same file `:87` | "positive: admin and super_admin may" | `createMenuItem`: super admin only; admin refused with `add_menu_item`. Categories: both still may |
| same file `:122` | "positive: admin and super_admin may set a price at either store" | Keep; add manager at own store |
| `packages/auth/tests/t401-capability-cells.test.ts:21` (cell table) | `set_menu_price` manager ✗ | manager ✅; add `add_menu_item`, `request_menu_item`, `switch_usage_source` cells |
| same file `:30` | "the only store-scoped one of the four is set_menu_price" | **Wrong**: seven capabilities, three store-scoped (`set_menu_price`, `request_menu_item`, `switch_usage_source`) |
| same file `:35` | "the four names are Capability members" | Seven names |
| `t401-s2-item-lifecycle.test.ts:28,38,48,64` and `t401-s2-audit.test.ts:95,97` | `createMenuItem(c.admin, …)` / `addMenuVariant` as admin | Actor becomes `c.superAdmin` (admin is now refused) |
| `packages/db/tests/integration/t401-s1-refills-isolation.test.ts:142,156,195` | "each of the ten tables", "ALL TEN", "all ten menu tables" | Thirteen |
| `t401-s1-offer-rules.test.ts:34` | "non-refill live offer with NULL amount refused" | Still right for `fixed`; add: a `percent_markup` online row with NULL amount is **accepted** (I20) |
| `t401-s1-offer-rules.test.ts:43` | withdrawn with an amount refused | Extend to the rule columns (I20) |
| `t401-s1-history-guards.test.ts:31,49` | "the three history UPDATE guards", "tgenabled is A for the three" | Four (adds `menu_usage_source_switches`, I26) |

Not wrong: I1, I1b, I2 (the channel case stays true for `fixed` rows), I3 refill case, I5-I8, I10, I13, I13b,
concurrency C1-C5, money tests.

## 7. Out of scope

Sales receipts, ordering, table state, KDS, kitchen tickets and routing, refill cooldowns and requests (DEF-021), the
86/sold-out event, discounts, charges, tenders (the tender master stays T-375's), loyalty rewards and the loyalty ledger,
store settings, images and diner content, the carrier (Firestore mirror or device outbox, row 280), any change to the
v1 day feed, any change to the usage pull beyond S5's seam (R7, I16), online **rules** on option-value deltas (R15),
deleting or migrating `pos_item_maps` (R7.7), retiring `items.sellable_retail` (a follow-up once P2 reads the menu), BIR item
codes, the Website `/menu` (DEF-011), editing the bible (the P1 carrier spec amends §5.3), a drift report between
`pos_item_maps` and menu rules (review cut (b); S5's comparison is per store and on demand, not a standing report),
separate category and option-group pages (review cut (c)), every AI feature (§7a).

**The one-time v1 import is deferred to the P1 carrier window (review cut (a)).** Run now, it goes stale while v1
keeps selling, so menus would be entered twice. When it is specced, it follows T-391's extract, plan, sheet and apply
pattern; it extends `v1_master_links` with menu entities (the per-store POS inventory doc id → variant link P2 needs);
it writes offers at the apply time and never back-dates (I1b); it fills `menu_pos_v1_links` (R7, in place of the planned
`v1_master_links` POS-key extension) and never overwrites a link or rule S5 already made; it maps v1's "online price ≤ 0 = withheld" to a
withdrawn `online` offer and an unset online price to an `online` offer equal to the store price; it expands v1's
"empty means all refills"; it seeds depletion rules from `pos_item_maps` where stores agree and lists the rest on a
sheet; it routes Padre Garcia into its own org; and its `extract` produces the census of v1 shapes first. Its
idempotence and org-routing invariants belong to that spec.

## 7a. The AI parts of Q2: a separate task, on the AI hub

Ian, 2026-10-13: AI checks whether a requested item already exists and tells the requester; AI-assisted item addition
(upload a picture, AI searches product details) with the human approving; and **AI is to be a central hub for the
whole app family**. Recorded as binding context. Built **outside T-401**, as a new task (next free number), "AI hub:
menu item assist", which first needs a short **AI hub ADR** extending ADR-014: one provider client, keys, a per-call
cost and audit log, prompt versioning, and one human-approval contract every AI suggestion follows, callable from ERP,
POS, CUSTOMER and the Website. Sizing: hub ADR S 0.5 (planner) + hub foundation M ≈ 2.0 + menu assist M ≈ 2.0
(semantic duplicate match over `menu_items` returning the same `possibleDuplicates` shape; photo → draft name,
description, type and category on a **request**, never an item; super admin still approves through
`approveMenuItemRequest`). **What T-401 hands it:** the `menu_item_requests` table, the `possibleDuplicates` contract
and the approval function, so AI only adds suggestions to a human flow that already works without it. Open for that
spec, not this one: where uploaded item photos are stored (R13 leaves images to row 280's hosting move), and confirming
that sending a **menu** photo to the provider is not the receipt-photo case row 251 forbade.

## Ian ruling on recipes (2026-10-13; binding)
"Only admin can edit recipe." `set_menu_depletion` (the menu depletion rule, which is the stock recipe of a menu variant) is **super admin and admin only**; manager is ✗ (with a ✗ test). This supersedes the manager ✅ in the capability table and removes review finding 2's cross-store authorize (admin is org-wide). Ian 2026-10-13 ("go with recommendation"): it also applies to `manage_pos_map` (the v1 bridge mapping, admin-only; delete each store's mapping after it moves to POS v2) and to production recipes. Both are done in T-403, not here. **Q6 ANSWERED: the online rule follows the counter price.**

## Ian ruling on stock usage (2026-10-13; binding)
"Stock usage can simultaneously be posted. The cashier may count the same item that the server also records. We will just be queueing them, then we will allow all staff to see who moves what so they can cross-check. All drafts: the manager posts." So:
- Several people at a store may record usage for the same item at the same time. Each entry is its own **draft** with its author; nothing is merged or refused because another draft exists.
- Every staff member at the store can see the queue: who recorded what, when and how much, so duplicates are caught by people cross-checking.
- Only the **manager posts** the drafts (approves, edits or rejects each). Posting is what moves stock.
- The S5 refusal (no usage-source switch and no depletion-rule change while a store has a pull in status planned) still stands. It does not block anyone recording drafts; it only stops the recipe from changing underneath a draft the manager has not posted.
- Whether this replaces or sits beside today's v1 usage pull and the existing stock-usage drafts is to be confirmed in the S5 build against the current usage code; flag any conflict to the orchestrator.

## S2 audit rulings (orchestrator, 2026-10-13; binding)
- The domain pre-checks the monotonic and same-instant rules (offers, option offers, depletion rules). A clash is refused in a sentence before the database would raise.
- Two "now" writes for the same key in one transaction are refused in a sentence.
- withdrawMenuItemRequest authorizes before it reads or locks the request.
- **S4 note:** the price form omits effectiveFrom for "now" and never sends the client clock. A scheduled time is parsed as Asia/Manila. The S4 tester owns the form test that kills the "parsed as UTC" mutant.

## S1 audit rulings (orchestrator, 2026-10-13; binding)
- Every check that reads another row (rule in force, live offer, retire) first locks the variant row (`FOR UPDATE`) or takes a per-variant advisory lock, so concurrent edits serialise.
- The three history UPDATE guards are `ENABLE ALWAYS` (history_guard), so replica mode cannot rewrite price history. Insert (clock) guards stay at origin.
- Offers on a retired variant or item are refused; `menu_item_id` cannot change once a variant has offers or package-refill links; the item_type guard also counts `menu_package_refills`.
- History is monotonic per key: an insert earlier than the latest row for the same key is refused (it would otherwise be accepted and never take effect).
- "Exactly one default variant" (I7) is the database guaranteeing at most one plus the retire check; the S2 domain must create the default variant in the same transaction as the item, and refuse re-activating an item without one.

## 8. Done when

- [ ] I1-I26 (with I1b, I5b, I13b) green; each tester file was red first for the stated reason; each mutant named in §4 was tried and killed.
- [ ] Migration applies from zero in CI; registry, classification, journal, DEF-491 census (if on main) and app-boundary tests green.
- [ ] Full suite green on the wrap-up PR; the T-177/T-375/T-382/T-384/T-388 suites, and the T-151/T-371 branch-price
  suites (after S2's rounding extraction), unchanged and green.
- [ ] `/menu/**` smoketested on 9008 as admin (create a category inline, item, variant, option group inline, depletion rule, price now, price scheduled at Manila midnight, cancel) and as manager (menu read-only, depletion editable, **price set at own store, refused at another**, item request with a duplicate shown); as super admin approve that request; an online `% over store` rule follows a store price change. S5: compare and switch a test store, then switch back.
- [ ] `npm run build` green with the dev server stopped; typecheck clean; LF only.

## 9. Outcome

_(filled by the lanes: commits, test counts.)_

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| K1 | Two depletion truths during dual existence (`pos_item_maps` per store, menu rule per org) drift | **Revised for Q3:** per store, one source is in force (the switch row); within a switched store each sold item has exactly one source (link → rule, else map). The comparison shows drift before a switch and on demand after it; P2 retires the map per store |
| K7 **(Q3)** | One org rule now drives several switched stores: a manager fixing "their" recipe changes another store's usage | `setDepletionRule` returns the switched stores linked to the variant and `/menu/items/[id]` lists them before save; `seedLinkFromMap` never overwrites an existing rule (I25); a store-specific recipe is a separate variant, linked only there |
| K8 **(Q3)** | A bad switch posts wrong usage for real days | Switch is per store, compared over 7 stored days first (I24), and reversible at once; a pull already finalised is voided and re-run through the existing `voidPosUsagePull` path, as for a bad map today. First store chosen by Ian |
| K9 **(Q3)** | The menu is empty until someone enters it (the v1 import stays deferred), so "switch now" has nothing to switch to | Stated plainly to Ian: S5 pays off only for items super admin has entered; `seedLinkFromMap` copies each store's existing map into the rule so entry is name + category + link, not recipe re-typing. Pulling the import forward is a separate decision |
| K10 **(Q4)** | Volatile online price surprises a diner mid-order | Price resolves at the instant the order line is priced (P2), like any offer; the projection's `nextChangeAt` already includes store price changes, so the carrier republishes when an online rule's basis moves |
| K2 | An effective-dated "in force" query written twice (projection, repo) disagrees | One SQL function `menu_offer_in_force(store, variant, channel, at)` in the migration; repo and tests both call it; the projection receives rows already resolved |
| K3 | Org-level menu does not fit a store that sells something unique | A store-unique item is an org item offered at one store only. If Ian wants store-owned items (Q2 (b)), it is a new column, not a new table |
| K4 | The P1 carrier wants a stored snapshot (version number the till reports) | R12 returns a deterministic hash; a `store_menu_versions` table, if wanted, is the carrier spec's addition and needs no change here |
| K5 | v1 has no price history, so comparisons of "price before" the import are impossible | Stated, not hidden: the first offer row is written at import time and is never back-dated (I1b) |
| K6 | T-398 S1's census lands after S1 and finds a bare FK | R10 builds the composite FKs now; S1 waits on T-398 S1 merging if both are in flight |

## 11. Questions for Ian: Q1-Q5 ANSWERED 2026-10-13; Q6 OPEN (Open Questions page)

- **Q1, who edits the menu and prices? ANSWERED (b):** Ian: *"managers set prices for THEIR OWN store"* (not admin-only).
  → R14(a), `set_menu_price` manager ✅ store-scoped, I12 revised.
- **Q2, can a store own an item? ANSWERED (a), extended:** Ian: one org menu, as recommended; *"items are centralised
  and ONLY super admin adds them; managers REQUEST an item to be added; AI checks whether it already exists and tells
  the requester so they can use the existing one; AI-assisted item addition (upload a picture, AI searches product
  details) with the human approving."* → R14(b)(c), `add_menu_item`, `menu_item_requests`, I21; AI parts §7a.
- **Q3, should the v1 usage pull read menu rules before P2? ANSWERED (b):** Ian: *"YES, switch now … design this
  SAFELY: v1 POS keeps selling until 1 Jan 2027."* → R7 replaced, S5, I16 revised, I22-I25, K7-K9.
- **Q4, does an online price differ? ANSWERED (a), extended:** Ian: keep a separate online price, *"AND an online price
  can be a RULE: % higher/lower than the store price, a ± peso amount, or a manual fixed price — we have this in
  commissary pricing v1, so items with volatile price adjust automatically."* → R15, I18-I20, K10.
- **Q5, flavours as an option group? ANSWERED (a):** Ian: as recommended; *"flavours attach to many items."* → R3 note.

- **Q6 (OPEN, added 2026-10-13 by the review), what does an online rule follow?** "Online rule follows the counter
  price (as specced), or should it follow ingredient cost like commissary pricing?" (a) the counter price: "online
  = counter + 10 %", so one counter change moves both · (b) ingredient cost: "online = landed cost × 3", the
  commissary basis (`lastTwoLandedMax`, T-151), so a pork price rise lifts the online price by itself, but the counter
  price would still be typed by hand and the two could cross. **Recommended (a)**: a menu item is many ingredients
  (cost = a recipe roll-up the menu does not hold yet), and diners compare the online price with the counter price,
  not with cost. Built as (a) unless Ian says otherwise; (b) later is a new `pricing_basis` column, not a redesign.

Earlier wording of the questions and the planner's recommendations are in git history (commit 68a77f0).
