# 08 — Expense Categories / Particulars Inventory

Source repo: `C:\Users\ianla\webapps\ERP-rebuild` (read-only discovery — nothing modified). Live Firestore project read: `studio-7300228488-a394e` (read-only queries only — no writes, no credential material captured or printed anywhere in this doc or in the discovery script).

Purpose: exhaustive inventory of every expense category/particular ("expense entry") the ERP currently uses, as raw input to mapping each one onto a proper chart-of-accounts expense line in ERPv2. **No redesign, no recommendation — inventory and description only**, matching the format of `07-chart-of-accounts-inventory.md`.

Evidence format: `file:LINE`. Anything not directly verified is marked **UNCERTAIN**.

---

## 1. How categories are modelled

### 1.1 Collection & shape

The admin-config screen the owner means ("admin config → expense entries") is `/admin/configurations/expense-entries`, backed by a **single global Firestore collection**: `expenseEntries/{id}` — **not** per-store.

- Collection path: `expenseEntries` (root-level, global) — `src/lib/actions/expense-entry.actions.ts:12` (`const COLLECTION_PATH = 'expenseEntries'`), read on the admin list page via `collection(firestore, "expenseEntries")` — `src/app/admin/configurations/expense-entries/page.tsx:28`.
- Doc shape (`ExpenseEntryPlain`), `src/types/index.ts:168-212`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Firestore doc id. Either a human-chosen code (`SE_EX86`, `Exp1000`, `SEX999`), a `sys_*` constant for system-seeded entries, or (rarely) an auto-generated 20-char Firestore id from the "create" form leaving the id field blank. |
| `group` | `'OPEX'\|'COGS'\|'CAPEX'\|'PERSONAL'\|'OTHERS'` | Top-level P&L classification. `src/types/index.ts:162`. |
| `category` | string | Free-text, admin-typed (with autocomplete suggestions from existing values) — `src/app/admin/configurations/expense-entries/expense-entry-editor.tsx:209-228`. |
| `subCategory` | string | Same — free-text with autocomplete, optionally scoped to the chosen category — `expense-entry-editor.tsx:229-252`. |
| `needReceipts` / `needParticulars` / `needBudget` | boolean | Gate what the expense-recording form requires for this entry. |
| `isActive` | boolean | Soft-disable flag. |
| `isSystem` | boolean (optional) | True for entries the system depends on or that are seeded as universal defaults (`src/lib/financial/expense/seed-expense-entries.ts`). Hard-delete is blocked (`expense-entry.actions.ts:180-182`); `id` and `group` are frozen in the admin editor once `isSystem`. |
| `capitalizable` / `defaultCoverageMonths` / `prepaidCategory` | bool / number\|null / enum\|null | Slice-5e prepaid/amortization support — when set, the expense editor offers "capitalize as prepaid" instead of immediate OPEX. |
| `capitalizesToAsset` | boolean (optional) | When true, an expense on this entry capitalizes straight to a depreciating fixed asset (CAPEX path) instead of prepaid or immediate expense. |
| `defaultVatHandling` | enum\|null (optional) | Declared in the type (`src/types/index.ts:206`) but **every live doc has this `null`** — unused in practice today (confirmed by the live dump, see §2). |
| `requiresDelivery` | boolean\|null (optional) | Declared in the type (`:211`) — **every live doc has this `null`** too. |
| `createdAt` / `updatedAt` | Timestamp | Standard audit fields. |

No field named `accountId`, `glCode`, `chartOfAccountsId`, or similar exists anywhere in the type or in any live document (verified — see §3).

### 1.2 Global, not per-store — but store-level enable/disable exists

The 132-entry master list is **one global list shared by every store**. What *is* per-store is a separate, much smaller settings doc:

- `stores/{storeId}/expenseEntrySettings/default` — shape `ExpenseEntrySettings` (`src/types/index.ts:233-239`): `{ storeActiveMap: {entryId: boolean}, defaultEnabled: boolean, updatedAtMs, updatedByUid }`.
- This only **toggles visibility** of an already-globally-defined entry for one store (e.g. a store with no delivery vehicle can hide "Vehicle Expense" sub-lines) — it cannot rename, recategorize, or reclassify. Read/write via `createStoreExpenseSettings` / `updateStoreExpenseSettings` / `migrateStoreExpenseSettings`, `src/lib/actions/expense-entry.actions.ts:339-453`.
- Live sample (5 stores read, see §5): **none had a non-empty `storeActiveMap`** — `defaultEnabled: true` with 0 override keys in every store that had the doc at all (one sampled store, `TEST`, had no settings doc). In practice, per-store toggling exists as a mechanism but is **not currently used** to differentiate the category set between stores — all stores effectively see the same active-category list.

### 1.3 Hierarchy: two-level, both free text

There is **no enum or fixed taxonomy** for `category`/`subCategory` — it's a flat `group` (5-value enum) → free-text `category` → free-text `subCategory`, with autocomplete-from-existing-values as the only spelling-consistency guard (`expense-entry-editor.tsx:131-139`, and the manager-facing datalist in `recurring-expense-editor.tsx` uses the same cached list). Nothing prevents two different `id`s from sharing the same `(category, subCategory)` pair — this happens in the live data (§4, Data-quality section).

There is a **third, per-particular layer** that is easy to mistake for "categories" but is a different thing: `stores/{storeId}/expenseParticulars/{normalized}` (`src/types/expense-particular.ts:1-28`, actions in `src/lib/actions/expense-particulars.actions.ts`). This is a **learned, store-scoped, free-text "particulars" autofill** — every time an expense is saved, the typed particulars text (e.g. "Pamasahe ng staff") is normalized to a doc id and the `(category, subCategory, expenseEntryId)` it was tagged with is recorded, purely so the next time someone types the same particulars text the form can suggest the same category. It is **not** an editable admin taxonomy and is **not** the list the owner is asking for — it is a cache/suggestion index keyed on whatever staff happen to type, per store. The task's target ("admin config → expense entries") is the global `expenseEntries` master described in §1.1, not this.

### 1.4 Who can edit

- **Create / edit / delete / batch-import the master `expenseEntries` list**: admin-only. Every mutation in `expense-entry.actions.ts` gates on `ctx.isAdmin` (`upsertExpenseEntry:70`, `deleteExpenseEntry:173`, `batchUpsertExpenseEntries:225`), and the page itself redirects non-admins (`src/app/admin/configurations/expense-entries/page.tsx:18-19`, `useRequireRole('admin')`).
- **Toggle an entry on/off for one store** (`storeActiveMap`): manager or admin, gated via `ctx.isManager` + `hasStoreAccess` (`expense-entry.actions.ts:342-343, 385-386`), exposed at `/manager/settings/expense-entries` (`useRequireRole('manager')`, `src/app/manager/settings/expense-entries/page.tsx:29`).
- System entries (`isSystem: true`) additionally can't have their `id` or `group` changed, and can't be hard-deleted (`isActive:false` is the only disable path) — this protects the ids the code itself depends on (e.g. `sys_platform_fee`, `sys_salary_wages`, the 7 `sys_ooe_*` online-order-expense deductions).

---

## 2. THE LIST — all 132 expense entries (live data, all stores)

**Method note for this section**: obtained by a new read-only Node script (see §5) querying the global `expenseEntries` collection directly — this is **not** the code-seed list, because the live collection (132 docs) is materially larger than the 48-entry code seed in `seed-expense-entries.ts` (§2.1 explains why). This is the single global list; it is not store-specific, so no "which store" caveat applies to the rows below — but see §1.2 for the one caveat that does apply (a store *could* in principle hide some of these, though none currently do).

### 2.1 Two layers inside this one list

1. **48 system-seeded entries** (`isSystem: true`, `id` starts with `sys_` or is `SYS_*`-derived) — hardcoded in `src/lib/financial/expense/seed-expense-entries.ts:108-492`, written by `ensureSystemExpenseEntries()` at store-creation time and idempotently re-synced. These exist because the code depends on their `id` (platform fee auto-expense on AR collection, depreciation/amortization cron, disposal write-off, the 7 online-order-expense settlement deductions) or because they're near-universal for any restaurant (rent, utilities, salary, insurance, permits, subscriptions, maintenance contracts).
2. **84 admin/owner-added entries** — created by hand through the `/admin/configurations/expense-entries` "Create" form or the xlsx batch importer (`expense-entry-importer.tsx`, driving `batchUpsertExpenseEntries`). These are the restaurant's own operational categories: the meat/sides/condiments COGS breakdown, marketing, repairs, vehicle expense, employee expense sub-types, etc. Their ids are a mix of a `SE_EX##` sequence (most common), a few ad hoc codes (`Exp1000`, `EXP1002`, `SEX999`, `PER1`), and one raw Firestore auto-id (`npCwvHUg7izKbjLoIbdP` — created via the blank-id "Create" path rather than the numbered sequence).

Group totals (live, verified against the 132-doc dump): **CAPEX 5, COGS 46, OPEX 80, PERSONAL 1, OTHERS 0.**

### 2.2 Full table

Legend: **Sys** = `isSystem:true`. **Act** = `isActive`. Notes flag anything relevant to account-mapping (capitalizable/prepaid parent, budget-tracked, or a data-quality issue — cross-referenced in §4).

#### CAPEX (5)

| id | Category | Sub-Category | Act | Sys | Notes |
|---|---|---|---|---|---|
| `SE_EX86` | Capitalization (More than 5k) | Purchases | Y | N | Owner-added catch-all CAPEX bucket, threshold-named |
| `SE_EX80` | Construction and Renovations | "NOT REPAIRS! New constructions OR Renovations only!" | Y | N | `capitalizesToAsset:true`; sub-category is itself a usage instruction, not a label |
| `sys_capex_appliances` | Equipment & Fixtures | Appliances | Y | Y | `capitalizesToAsset:true` — routes to Asset category "Appliances" |
| `sys_capex_equipment` | Equipment & Fixtures | Equipment | Y | Y | `capitalizesToAsset:true` — routes to Asset category "Equipment" |
| `sys_capex_smallwares` | Equipment & Fixtures | Smallwares | Y | Y | `capitalizesToAsset:true` — routes to Asset category "Smallwares"; see overlap with OPEX `SE_EX85` in §4 |

#### COGS (46)

| id | Category | Sub-Category | Act | Sys | Notes |
|---|---|---|---|---|---|
| `SE_EX42` | Beverages | Please Specify | Y | N | Catch-all sub-category |
| `sys_cogs_commissary` | Commissary Purchases | Commissary Purchases | **N** | N | Retired — code comment (`seed-expense-entries.ts:49-51`) says branches now use real category/sub-category per commissary line instead of one lumped bucket; live doc confirms `isActive:false` |
| `SE_EX36` | Condiments, Ingredients and Seasoning | Butter & Cheese (NOT Melted Cheese for Dips) | Y | N | |
| `SE_EX34` | Condiments, Ingredients and Seasoning | Cooking Oils / Sesame Oil | Y | N | |
| `SE_EX37` | Condiments, Ingredients and Seasoning | OTHER | Y | N | Catch-all |
| `SE_EX35` | Condiments, Ingredients and Seasoning | Salt, Pepper, and other Grains and Powder | Y | N | |
| `SE_EX32` | Condiments, Ingredients and Seasoning | Soy Sauce, Vinegar, Fish Sauce and other Liquid Seasoning | Y | N | |
| `SE_EX33` | Condiments, Ingredients and Seasoning | Spices (Onion, Garlic, Ginger etc) | Y | N | |
| `SE_EX31` | Condiments, Ingredients and Seasoning | Sugar , Honey, Corn Syrup | Y | N | |
| `sys_cogs_general` | Cost of Goods Sold | General | **N** | Y | Seed comment calls this the "starter" entry meant to be superseded by specific ones — live data confirms it's deactivated, i.e. this store already replaced it with the Meat/Sides/etc. breakdown below |
| `SE_EX04` | Meat | Beef | Y | N | |
| `SE_EX06` | Meat | Chicken Breast | Y | N | |
| `SE_EX05` | Meat | Chicken Leg | Y | N | |
| `EXP1002` | Meat | Chicken Wings | Y | N | Only entry with `needParticulars:false` in the Meat group |
| `SE_EX02` | Meat | Pork Belly | Y | N | |
| `SE_EX01` | Meat | Pork Jowls | Y | N | |
| `SE_EX03` | Meat | Pork Kasim/Moksal | Y | N | Slash in sub-category — the exact case the particulars-normalizer (`src/types/expense-particular.ts:31-58`) was hardened for |
| `SE_EX07` | Meat | Seafoods | Y | N | |
| `SE_EX24` | Meat Sauce Dips and Flavors | Bulgogi | Y | N | |
| `SE_EX26` | Meat Sauce Dips and Flavors | Galbi | Y | N | |
| `SE_EX28` | Meat Sauce Dips and Flavors | Gochujang 14kg | Y | N | |
| `SE_EX30` | Meat Sauce Dips and Flavors | Mayonaise | Y | N | |
| `SE_EX29` | Meat Sauce Dips and Flavors | Melted Cheese & ingredients | Y | N | |
| `SE_EX25` | Meat Sauce Dips and Flavors | Spicy Bulgogi | Y | N | |
| `SE_EX27` | Meat Sauce Dips and Flavors | Ssamjang 14kg | Y | N | |
| `SE_EX40` | Product Packaging | SharEat | Y | N | Brand-specific packaging line |
| `SE_EX41` | Product Packaging | Xlice | Y | N | Brand-specific packaging line |
| `SE_EX39` | Retail Inventory | Butane | Y | N | |
| `SE_EX38` | Retail Inventory | Retail Items | Y | N | |
| `SE_EX21` | Sides | Bean Sprought / Bell Pepper | Y | N | Typo ("Sprought") + slash-combined sub-category |
| `SE_EX20` | Sides | Carrots | Y | N | |
| `SE_EX09` | Sides | Corn | Y | N | |
| `SE_EX19` | Sides | Cucumber | Y | N | |
| `SE_EX14` | Sides | Egg | Y | N | |
| `npCwvHUg7izKbjLoIbdP` | Sides | Enoki Mushroom | Y | N | Raw Firestore auto-id, unlike every other `SE_EX##` sibling in this category |
| `SE_EX13` | Sides | Fishcake | Y | N | |
| `SE_EX22` | Sides | Green Peas | Y | N | |
| `SE_EX11` | Sides | Kimchi | Y | N | |
| `SE_EX10` | Sides | Lettuce | Y | N | |
| `SE_EX23` | Sides | OTHER | Y | N | Catch-all |
| `SE_EX15` | Sides | Potato marbles | Y | N | |
| `SE_EX18` | Sides | Radish and Pickled Radish | Y | N | |
| `SE_EX08` | Sides | Rice | Y | N | |
| `SE_EX17` | Sides | Singkamas | Y | N | |
| `SE_EX16` | Sides | Sweet Potato | Y | N | |
| `SE_EX12` | Sides | Tteokbokki | Y | N | |

#### OPEX (80)

| id | Category | Sub-Category | Act | Sys | Notes |
|---|---|---|---|---|---|
| `SE_EX70` | Administrative Expenses | Bank Fees, Interest, and Penalties | Y | N | Overlaps in name with the separate system "Bank Fees" and "Interest Expense" categories below |
| `SE_EX65` | Administrative Expenses | Bookeeping Fee | Y | N | Typo — should be "Bookkeeping" |
| `SE_EX67` | Administrative Expenses | Communication | Y | N | |
| `SE_EX69` | Administrative Expenses | Tax | Y | N | |
| `sys_amortization` | Amortization | Prepaid Expense | Y | Y | Aggregate monthly-runner entry, `needParticulars:false` |
| `sys_bad_debt` | Bad Debt | AR Write-Off | Y | Y | Posted by `writeOffArTransactionAction` |
| `sys_bank_fees` | Bank Fees | Bank Charges | **N** | Y | System entry, deactivated live — see §4 |
| `sys_depreciation_sl` | Depreciation | Straight-Line | Y | Y | Auto-generated by depreciation cron, `needParticulars:false` |
| `SE_EX49` | Employee Expenses | Bonuses | Y | N | |
| `SE_EX51` | Employee Expenses | Food Allowance | Y | N | **Only entry in the entire live collection with `needBudget:true`** |
| `SE_EX50` | Employee Expenses | Government Benefits | Y | N | |
| `SE_EX48` | Employee Expenses | Incentive | Y | N | Only Employee Expenses row with `needReceipts:false` |
| `SE_EX52` | Employee Expenses | Transportation Allowance | Y | N | |
| `SE_EX53` | Employee Expenses | Uniform | Y | N | |
| `sys_ins_fire` | Insurance | Fire Insurance | Y | Y | `capitalizable:true`, `prepaidCategory:"Insurance"`, 12-month default |
| `sys_ins_gli` | Insurance | General Liability Insurance | Y | Y | Same prepaid pattern |
| `sys_ins_property` | Insurance | Property Insurance | Y | Y | Same prepaid pattern |
| `sys_ins_health_staff` | Insurance | Staff Health Insurance | Y | Y | Same prepaid pattern |
| `sys_ins_vehicle` | Insurance | Vehicle Insurance | Y | Y | Same prepaid pattern |
| `sys_interest_expense` | Interest Expense | Loan Interest | Y | Y | Used by the loan module |
| `sys_loss_on_disposal` | Loss on Disposal | Asset Write-Off | Y | Y | Posted by `disposeAssetAction` — per `07-chart-of-accounts-inventory.md §1.1`, the paired journal account `expense__loss_on_disposal` is **posted to but never read by the P&L report** (a pre-existing gap, not something this doc introduces) |
| `sys_maint_aircon` | Maintenance | AC Maintenance | Y | Y | `prepaidCategory:"Maintenance Contracts"` |
| `sys_maint_cctv` | Maintenance | CCTV / Security System | Y | Y | Same |
| `sys_maint_generator` | Maintenance | Generator Maintenance | Y | Y | Same |
| `sys_maint_pest_control` | Maintenance | Pest Control | Y | Y | Same — note separate owner-added "Pest Control and Waste Management" category below, a likely near-duplicate (§4) |
| `SE_EX57` | Marketing and Advertising | Collaborations | Y | N | |
| `SE_EX58` | Marketing and Advertising | Decorations | Y | N | |
| `SE_EX55` | Marketing and Advertising | Offline Ads | Y | N | |
| `SE_EX54` | Marketing and Advertising | Online Ads | Y | N | |
| `SE_EX59` | Marketing and Advertising | OTHERS | Y | N | Catch-all |
| `SE_EX56` | Marketing and Advertising | Print Media | Y | N | |
| `sys_ooe_commission` | Online Order Expenses | Commission | Y | Y | Booked from the platform clearing account at Grab/FoodPanda settlement |
| `sys_ooe_marketing` | Online Order Expenses | Marketing & Ads | Y | Y | Same settlement mechanism |
| `sys_ooe_penalty` | Online Order Expenses | Penalty & Adjustment | Y | Y | Same |
| `sys_ooe_platform_fee` | Online Order Expenses | Platform Fee | Y | Y | Same |
| `sys_ooe_variance` | Online Order Expenses | Settlement Variance | Y | Y | Same |
| `sys_ooe_vat` | Online Order Expenses | VAT on Charges | Y | Y | Same |
| `sys_ooe_wht` | Online Order Expenses | Withholding Tax | Y | Y | Same |
| `sys_prepaid_other` | Other Prepaid | Other | Y | Y | Catch-all prepaid bucket, `defaultCoverageMonths:null` (user picks) |
| `sys_permit_barangay` | Permits & Licenses | Barangay Clearance | Y | Y | `prepaidCategory:"Permits & Licenses"`, 12-month |
| `sys_permit_bir` | Permits & Licenses | BIR Registration | Y | Y | Same |
| `sys_permit_dti_sec` | Permits & Licenses | DTI / SEC Registration | Y | Y | Same |
| `sys_permit_fire_safety` | Permits & Licenses | Fire Safety Inspection | Y | Y | Same |
| `sys_permit_mayors` | Permits & Licenses | Mayor's Permit | Y | Y | Same |
| `sys_permit_sanitary` | Permits & Licenses | Sanitary Permit | Y | Y | Same |
| `SE_EX64` | Pest Control and Waste Management | Specify | Y | N | Catch-all; likely overlaps `sys_maint_pest_control` (§4) |
| `sys_platform_fee` | Platform Fee | Platform Commission | Y | Y | Referenced directly by AR-collection auto-expense logic |
| `SEX999` | Platform Fee | Specify | Y | N | Catch-all sibling of the system entry directly above — likely redundant (§4) |
| `Exp1000` | Rent | Store Rent | Y | N | **Identical (category, subCategory) to `sys_rent` below, both active** — live duplicate (§4) |
| `sys_rent` | Rent | Store Rent | Y | Y | `capitalizable:true`, `prepaidCategory:"Rent Prepaid"`, 1-month default |
| `sys_rent_store_prepaid` | Rent | Store Rent (Advance) | Y | Y | 6-month default coverage |
| `sys_rent_warehouse_prepaid` | Rent | Warehouse Rent (Advance) | Y | Y | 6-month default coverage |
| `SE_EX61` | Repairs and Maintenance | Building Maintenance | Y | N | |
| `SE_EX60` | Repairs and Maintenance | Equipment Repair | Y | N | |
| `SE_EX63` | Repairs and Maintenance | General Repair | Y | N | Catch-all within the category |
| `SE_EX62` | Repairs and Maintenance | Vehicle Maintenance | Y | N | Overlaps "Vehicle Expense" category below (§4) |
| `sys_salary_wages` | Salary | Wages | Y | Y | Payroll — staff salaries/wages |
| `SE_EX85` | Smallwares | Purchases | Y | N | `capitalizesToAsset:true` — separate category from the CAPEX `Equipment & Fixtures / Smallwares` system entry; likely the same real-world spend routed through two different entries depending on who records it (§4) |
| `sys_sub_accounting_sw` | Subscriptions | Accounting Software | Y | Y | 12-month prepaid default |
| `sys_sub_email` | Subscriptions | Email Service | Y | Y | Same |
| `sys_sub_pos_license` | Subscriptions | POS License | Y | Y | Same |
| `sys_sub_hosting` | Subscriptions | Website / Hosting | Y | Y | Same |
| `SE_EX89` | Subscriptions (OTHER) | Specify | Y | N | Separate `category` string from "Subscriptions" above (parenthetical) — a spelling/consistency issue, not a true different bucket (§4) |
| `SE_EX77` | Supplies and Stocks | Cashier and Office | Y | N | |
| `SE_EX76` | Supplies and Stocks | Dine-in | Y | N | |
| `SE_EX75` | Supplies and Stocks | Kitchen | Y | N | |
| `SE_EX78` | Supplies and Stocks | Miscellaneous | Y | N | Catch-all |
| `SE_EX79` | Uncategorized Expenses | Specify | Y | N | The store's true catch-all-of-catch-alls |
| `SE_EX43` | Utilities | Electricity | **N** | N | Legacy owner-added row, deactivated in favor of the system one below |
| `sys_utilities_electricity` | Utilities | Electricity | Y | Y | Active successor |
| `SE_EX45` | Utilities | Internet | **N** | N | Same legacy/superseded pattern |
| `sys_utilities_internet` | Utilities | Internet | Y | Y | Active successor |
| `SE_EX46` | Utilities | LPG | **N** | N | Same pattern (cooking gas) |
| `sys_utilities_lpg` | Utilities | LPG | Y | Y | Active successor |
| `SE_EX44` | Utilities | Water | **N** | N | Same pattern |
| `sys_utilities_water` | Utilities | Water | Y | Y | Active successor |
| `SE_EX74` | Vehicle Expense | Delivery Expenses | Y | N | |
| `SE_EX73` | Vehicle Expense | Driver Fee | Y | N | |
| `SE_EX71` | Vehicle Expense | Gas and Oil | Y | N | |
| `SE_EX72` | Vehicle Expense | Toll Fees | Y | N | |

#### PERSONAL (1)

| id | Category | Sub-Category | Act | Sys | Notes |
|---|---|---|---|---|---|
| `PER1` | OWNER | specify | Y | N | Only `PERSONAL`-group entry that exists; group is excluded from the P&L entirely (§4.4) |

#### OTHERS (0)

No live entry currently uses the `OTHERS` group value, though the type/schema allows it.

---

## 3. Existing category → account mapping: **none, at the entry level**

Every one of the 132 live docs was checked programmatically for any field name matching `/account|gl[_A-Z]|glCode|ledger|coa/i` (the discovery script's `accountLikeFields` scan, §5) — **zero matches**. No `expenseEntries` document carries an account id, GL code, or chart-of-accounts reference of any kind. The only "downstream routing" fields that exist are:

- **`prepaidCategory`** (6 possible parent buckets: Insurance, Permits & Licenses, Rent Prepaid, Software & Subscriptions, Maintenance Contracts, Other Prepaid) — drives which prepaid-asset parent an amortizing expense rolls up under on `/inventory/prepaid`, not a GL account.
- **`capitalizesToAsset` + a keyword-matching function** `assetCategoryFromSubCategory()` (`src/lib/actions/expense.actions.ts:92-100`) — for CAPEX-routed entries only, does a `.includes()` match on the `subCategory` string ("furniture"/"fixture" → Furniture & Fixture, "machinery" → Machinery, "vehicle" → Vehicles, "construction"/"renovation"/"building" → Building, "appliance" → Appliances, "smallware" → Smallwares, else → Equipment) to pick a fixed-asset register category. This is a **text-matching heuristic**, not a data-level mapping, and only fires for the 6 CAPEX-flagged entries.

Separately, the **journal/ledger side of the app** (`src/lib/financial/accounts/account-defs.ts`, fully inventoried in `07-chart-of-accounts-inventory.md`) defines exactly **8 fixed `expense__*` accounts**: `expense__platform_fee`, `expense__online_order_expenses`, `expense__depreciation`, `expense__salary`, `expense__salary_additions`, `expense__loss_on_disposal`, `expense__interest`, `expense__amortization`. Per `07-chart-of-accounts-inventory.md §1.1` and confirmed again here: these correspond only to a **handful of the system-seeded entry ids** (`sys_platform_fee`, the `sys_ooe_*` group, `sys_depreciation_sl`, `sys_salary_wages`, `sys_interest_expense`, `sys_amortization`, `sys_loss_on_disposal`) — not to `category`/`subCategory` at all, and **not to any of the 84 owner-added entries** (the entire Meat/Sides/Condiments COGS breakdown, Marketing, Repairs, Vehicle Expense, Employee Expenses, Supplies and Stocks, Administrative Expenses, etc. have no corresponding ledger account whatsoever). Of those 8 journal accounts, only 4 (`expense__platform_fee`, `expense__salary`, `expense__salary_additions`, `expense__interest`) are actually read directly by the P&L report — the rest are either redundant plumbing (the P&L instead reads the paired `/expenses` doc for depreciation/amortization/online-order-expenses) or a known gap (`loss_on_disposal` is posted but never read).

**Bottom line for the rebuild**: there is no existing category→account mapping table to migrate — one must be built from scratch, and the 132-row list above (particularly the 84 non-system, owner-added `category`/`subCategory` pairs) is the actual input list that needs a GL account assigned to each.

---

## 4. How the category drives accounting today — confirmed `expenseEntryGroup` mechanism

Verified directly in `src/lib/actions/income-statement.actions.ts:154-209` and cross-referenced against `src/lib/financial/ACCOUNTING_BLUEPRINT.md:169-171,598-601,717-720,729-732`:

1. The P&L (income statement) does **not** read the journal/ledger for expense lines. It queries `stores/{storeId}/expenses` directly — `where('dayKey', ...).where('status', '==', 'posted')` (`income-statement.actions.ts:156-161`) — i.e. it scans expense **documents**, not `expense__*` account balances.
2. Each `/expenses/{id}` doc carries a **denormalized `expenseEntryGroup`** field, copied from `expenseEntries/{expenseEntryId}.group` **at post time** (`expense.actions.ts:340-341,640`; also frozen to `'OPEX'` when a below-threshold CAPEX purchase is auto-recorded as immediate opex, `expense.actions.ts:346`). The expense doc also carries a denormalized `category`/`subCategory` copy of the entry's values at time of posting (spread into the write via `...expenseData`, `expense.actions.ts:627-628`, where `expenseData.category`/`.subCategory` were populated client-side from the chosen `expenseEntries` doc).
3. The report groups strictly by this frozen field, never by a live lookup: `group === 'COGS'` → bucket into `cogsByCategory[cat]`; `group === 'OPEX'` → `opexByCategory[cat]`; a `null`/missing group (entry not found in the master, e.g. deleted) is **defensively treated as OPEX** rather than silently dropped (`income-statement.actions.ts:190-200`). `CAPEX`, `PERSONAL`, and `OTHERS` groups are excluded from the P&L entirely (`:201` comment) — this is why the sole `PERSONAL` entry (`PER1`/OWNER) and all 5 `CAPEX` entries never appear on an income statement.
4. This is a **deliberate, documented invariant**: `ACCOUNTING_BLUEPRINT.md:601,720` states explicitly that `expenseEntryGroup` must **never** be re-derived from the `expenseEntries` master at report time — doing so would retroactively reclassify historical P&L whenever an admin edits an entry's group later. History is frozen at the moment an expense is posted.

So: **the `category` string itself (not an account id) is the P&L line label**, and `expenseEntryGroup` (COGS/OPEX/CAPEX/PERSONAL/OTHERS, frozen per expense) is what decides whether/where it appears. This confirms the premise in the task brief.

---

## 5. Data-quality problems found in the live list

These are observations from the live 132-row dump, not judgments about what to do — flagged because they matter directly for building a clean category→account map:

1. **True duplicate, both active**: `Exp1000` and `sys_rent` are both `Rent / Store Rent`, both `isActive:true`. Any two-way mapping from `(category, subCategory)` → account needs a rule for which id wins, or both need to be merged before mapping.
2. **Superseded-but-not-deleted legacy rows** (harmless, but noisy for a raw export): `SE_EX43/44/45/46` (Utilities: Electricity/Water/LPG/Internet) are inactive owner-added duplicates of the active `sys_utilities_*` system rows. Similarly `sys_cogs_general` and `sys_cogs_commissary` are inactive system/former-system starter buckets superseded by the specific Meat/Sides/Condiments/Retail breakdown. These are already deactivated, so they don't currently double-count — but a naive "export every row" pass would need to filter `isActive` first.
3. **Same real-world spend, two different entries/paths**: `SE_EX85` (OPEX, "Smallwares/Purchases", `capitalizesToAsset:true`) vs. `sys_capex_smallwares` (CAPEX, "Equipment & Fixtures/Smallwares", `capitalizesToAsset:true`). Both ultimately capitalize to the same Asset-register category ("Smallwares") but live in different `group`s and different `category` labels — whoever records the expense picks which one applies, so the same purchase type could land in either bucket depending on who's recording it.
4. **Likely-overlapping categories that should probably be one**: `sys_maint_pest_control` (Maintenance/Pest Control) vs. `SE_EX64` (Pest Control and Waste Management/Specify); `sys_platform_fee` (Platform Fee/Platform Commission) vs. `SEX999` (Platform Fee/Specify); "Subscriptions" (4 system rows) vs. "Subscriptions (OTHER)" (`SE_EX89`) as a separate `category` string rather than a sub-category of the same one; `SE_EX62` (Repairs and Maintenance/Vehicle Maintenance) vs. the whole "Vehicle Expense" category (`SE_EX71-74`).
5. **Unlabelled catch-alls scattered across categories rather than centralized**: "Please Specify" (Beverages), "OTHER"/"OTHERS" (Condiments, Sides, Marketing and Advertising), "Specify" (Pest Control and Waste Management, Platform Fee, Subscriptions (OTHER), Uncategorized Expenses), "specify" (PERSONAL/OWNER), "General Repair" (Repairs and Maintenance), "Miscellaneous" (Supplies and Stocks). At least 8 distinct catch-all sub-categories exist as siblings of specific ones instead of a single sanctioned "Other" pattern — each one obscures what was actually purchased behind free-text `particulars`, which makes assigning a single GL account per catch-all inherently approximate (the real classification lives in text a human typed, not in structured data).
6. **A typo and a slash-combined line**: "Bookeeping Fee" (`SE_EX65`, missing a "k"); "Bean Sprought / Bell Pepper" (`SE_EX21`, two different produce items forced into one sub-category, and "Sprought" is a typo for "Sprout").
7. **Inconsistent id scheme** (cosmetic, not a mapping risk, but worth knowing before an import): most owner-added rows follow `SE_EX##`, but `Exp1000`, `EXP1002`, `SEX999`, `PER1` break that pattern, and one row (`npCwvHUg7izKbjLoIbdP`) is a raw Firestore auto-id from the blank-id create path — none of this affects the `(category, subCategory)` values that matter for accounting, but it means id is not a reliable stable "code" the way a chart-of-accounts number would be.
8. **`defaultVatHandling` and `requiresDelivery`** are declared fields on every doc but **null on all 132 live rows** — these hooks exist in the type but aren't populated anywhere yet; not a data-quality defect exactly, but confirms these two fields carry no information today and shouldn't be treated as an existing signal.

---

## 6. Method note

1. **Code read** (Step 1): `src/types/expense-particular.ts`, `src/lib/actions/expense-particulars.actions.ts`, `src/lib/server/expense-particulars-index.ts`, `src/lib/actions/expense-entry.actions.ts`, `src/app/admin/configurations/expense-entries/{page,expense-entry-editor,expense-entry-importer}.tsx`, `src/app/manager/settings/expense-entries/page.tsx`, `src/lib/client/expense-entries-cache.ts`, `src/types/index.ts` (`ExpenseEntryPlain`/`ExpenseEntryGroup`/`ExpenseEntrySettings`/`PrepaidCategory`), `src/lib/financial/expense/seed-expense-entries.ts` (full 48-entry seed + `ensureSystemExpenseEntries`), `src/lib/actions/expense.actions.ts` (denormalization of `expenseEntryGroup`/`category`/`subCategory` onto the posted expense, and `assetCategoryFromSubCategory`), `src/lib/actions/income-statement.actions.ts:130-229` (the P&L read path), `src/lib/financial/journal/builders/expense.builder.ts` (confirms the journal legs route by *payment method*, never by category), `src/lib/actions/expense-budget.actions.ts` (confirms per-store budgets key off `expenseEntryId`, not a separate taxonomy), and the relevant sections of `src/lib/financial/ACCOUNTING_BLUEPRINT.md` and `src/lib/financial/accounts/account-defs.ts` (cross-checked against the existing `07-chart-of-accounts-inventory.md`).
2. **Existing dump script check**: the repo's only pre-existing debug script, `_dbg-dump.mjs`, was inspected — it's a one-off Lipa-wastage-collection probe, not an expense-entries reader, so it wasn't reusable as-is but its Admin-SDK bootstrap pattern (reads `FIREBASE_SERVICE_ACCOUNT_KEY` from `.env.local`, referenced **by name only**, never its value) was reused for the new script.
3. **New read-only script**: `dump-expense-entries.mjs`, written to and run from the scratchpad directory (never copied into the repo). It:
   - Loads `dotenv`/`firebase-admin` from the ERP-rebuild repo's own `node_modules` via `createRequire`, since the scratchpad path is outside any npm project and Node ESM won't otherwise resolve those packages.
   - Reads `FIREBASE_SERVICE_ACCOUNT_KEY` from ERP-rebuild's `.env.local` (never printed).
   - Runs **read-only Firestore queries only**: `db.collection("expenseEntries").get()` (132 docs) and, for §1.2, a `.limit(5)` sample of `stores` docs plus a `.get()` on each one's `expenseEntrySettings/default` sub-doc.
   - Performs **zero writes** — no `.set()`, `.update()`, `.delete()`, `.add()`, batch, or transaction call anywhere in the script.
   - Prints only business-config fields (id, group, category, subCategory, active/system flags, capitalization/prepaid flags) plus a boolean check for any unmodeled account-like field name — never a credential, and never customer/staff PII (the `expenseEntries` collection contains none).
4. **Confirmed no writes occurred** during this discovery: every Firestore call in the new script and every action file read in Step 1 was inspected as source code only (no server actions were invoked); the two `node` executions of the dump script performed `.get()` calls exclusively, both exiting 0 with the expected read counts logged to stderr (`expenseEntries collection: 132 docs`; 5 stores sampled). ERP-rebuild's git state was not touched — no file inside the repo was created, edited, or deleted at any point in this task.
