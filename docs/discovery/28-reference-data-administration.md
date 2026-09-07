# 28 — Reference-data administration: the settings shelf

**Date:** 2026-09-07 · **For:** T-229 · **Method:** bible §1.2d, four steps per item, in order
**Read-only** over `ERP-rebuild` (v1) at source; **read-only** over `shareat-system` (v2) at source.
**Firestore and the ETL landing table were NOT read** — this lane has no access to either, so every
live-data count below is either cited from an existing `docs/discovery/*` pass or written
`unknown`. Nothing is estimated. (§1.2d step 3 is only worth doing when the number is real.)

**Source gap:** `docs/CAPABILITY-GAPS.md` § "Added 2026-09-06", five items.
**Defects in play:** DEF-192 (fixed by T-227 — the `/settings` hub was dropped rather than built,
"when a second settings surface lands, a hub earns its place"), DEF-193 (expense categories are
seed-only and a detector fires on a condition no screen can fix).

---

## 0. ⚠️ Three corrections to the gap row itself, found by reading v1 at source

The gap section is right that the shelf is missing. Three of its five item descriptions do not
survive contact with the code, and two of them change what gets built. Recorded first because
everything below depends on them.

### 0.1 ⛔ v1's "Organization" screen is not organization details

`ERP-rebuild/src/app/manager/settings/organization/page.tsx:19` — `ORG_TABS = ['positions',
'locations', 'departments']`. Its own header comment (`:3-7`) says it "merges the former
Positions, Locations, and Departments settings pages into one tabbed page", and
`src/app/manager/settings/positions/page.tsx:1-8` is a **redirect into that page's Positions tab**,
kept only so old bookmarks work. The hub card's own description says the same thing
(`settings/page.tsx:48`): *"Manage staff positions, inventory locations, and supply departments."*

**Consequences, both material:**

1. The gap table counts **Positions** and **Organization details** as two separate items. In v1
   they are **one screen**, and *locations* and *departments* — which the gap section lists under
   "already covered in v2, deliberately not counted as gaps" — are the other two tabs of it.
2. There is no business-details editing surface at `/manager/settings/*` at all.

### 0.2 ⭐ v1's business identity lives on the STORE, at `/admin/stores`

`ERP-rebuild/src/app/admin/stores/store-editor.tsx:56-70` — an "Identity & Tax" section carrying
`logoPath`, `name`, `storeCode`, **`legalName`**, **`tin`** (*"Tax ID Number (TIN)"*, `:62`) and
`taxType` (VAT / Non-VAT, `:63`), with `email`/`phone`/`contactNo`/`telephone` under Contact and a
full `address` under Location. Read back at
`src/app/admin/stores/[id]/store-details-client.tsx:234`.

**v1 has no organization entity at all** — the store *is* the top of its hierarchy, so it is where
the legal identity had to go. That is the requirement the gap row was reaching for, and it is
evidenced on a different screen than the one it names.

### 0.3 ⛔ v1's "Wastages" screen configures order-wastage TYPES, not stock-loss reasons

`ERP-rebuild/src/app/manager/settings/wastages/wastage-settings-client.tsx:3-4`, the file's own
header: *"Per-store wastage TYPE config. Each type is `tracked` (full lifecycle) or `instant`
(booked on creation). Seeds FoodPanda/Grab/Dine-in on first load."* Each row is
`{ id, name, mode: 'tracked' | 'instant', active }` (`:67-72`).

That is **T-178's domain** — the channel an order wastage came from and whether it enters the
created → acknowledged → charged lifecycle. It is **not** `WASTAGE_REASONS`
(`packages/domain/src/stock/wastage-reasons.ts:18-38` — spoilage, expiry, theft, prep loss), which
is T-164/T-168's stock-loss taxonomy. v2's own file says the two must not be conflated
(`wastage-reasons.ts:12-16`, of the *delivery-shortage* list: *"They share two words and no
purpose, and merging them would make both reports wrong."* The same holds here).

**Consequence:** the item labelled "wastage reasons" is two questions, with two different answers.
§3 splits them.

---

## 1. Expense categories — the DEF-193 remedy

### 1.1 v1 at source

| | |
|---|---|
| Master list | `expenseEntries/{id}`, a **single global Firestore collection**, not per-store — `src/lib/actions/expense-entry.actions.ts:12` |
| Admin screen | `/admin/configurations/expense-entries` — create, edit, delete, xlsx batch import |
| Manager screen | `/manager/settings/expense-entries` — **toggle visibility only** for the active store (`storeActiveMap`), `expense-entry.actions.ts:339-453` |
| Shape | `group` (5-value enum) → `category` (free text) → `subCategory` (free text), plus `needReceipts`/`needParticulars`/`needBudget`, `isActive`, `isSystem`, `capitalizable`/`defaultCoverageMonths`/`prepaidCategory` |
| Editing | free-text inputs with `<datalist>` autocomplete from existing values — `expense-entry-editor.tsx:209-252` |
| Protection | `isSystem` rows cannot be hard-deleted (`expense-entry.actions.ts:180-182`); their `id` and `group` are frozen in the editor |
| Gate | every mutation on `ctx.isAdmin` (`:70`, `:173`, `:225`); the store toggle is manager-level |

### 1.2 The goal it was built to achieve

> **One shared, owner-maintained list of what money gets spent on, so a new kind of spend becomes a
> row somebody types rather than a deploy — and so the P&L line a spend lands on is decided by that
> list rather than by whatever the spender wrote in the notes field.**

Written before judging the code, per §1.2d step 2. Note what the goal does **not** say: it says
nothing about a GL account, because v1's list has none (§1.3).

### 1.3 The live data — counted, and it is not in good shape

All figures from `docs/discovery/08-expense-categories.md`, which read the live collection directly
on 2026-08-23. Not re-counted here (Firestore is out of this lane's reach); cited, not estimated.

| Measure | Value | Source |
|---|---|---|
| Live entries | **132** | 08 §2 |
| System-seeded (`isSystem`) | **48** | 08 §2.1 |
| Owner-added by hand or importer | **84** | 08 §2.1 |
| Group split | CAPEX 5 · COGS 46 · OPEX 80 · PERSONAL 1 · OTHERS 0 | 08 §2.1 |
| Entries carrying an account mapping | **0 of 132** | 08 §3 — every doc scanned for `/account\|gl[_A-Z]\|glCode\|ledger\|coa/i`, zero matches |
| Stores using the per-store enable/disable | **0 of 5 sampled** — `defaultEnabled: true`, zero override keys everywhere | 08 §1.2 |

**And the quality problems, which are the finding:**

- **A true duplicate, both active** — `Exp1000` and `sys_rent` are both `Rent / Store Rent`
  (08 §5.1). This is the exact case bible §4.4 was written about.
- **Four id schemes in one collection** — `SE_EX##`, `Exp1000`/`EXP1002`/`SEX999`/`PER1`, `sys_*`,
  and one raw 20-char Firestore auto-id from the blank-id create path (08 §5.7).
- **At least 8 distinct catch-all sub-categories** — "Please Specify", "OTHER", "OTHERS",
  "Specify", "specify", "General Repair", "Miscellaneous" — siblings of specific ones rather than
  one sanctioned pattern (08 §5.5). The real classification lives in free text a human typed.

⛔ **§1.2d's bad-data rule applies in full.** The 132-row taxonomy is evidence of the **need** and
not of the practice. The v2 rule is therefore designed, not ported — **and that call was already
made and shipped**: `packages/db/seed/expense-categories.ts` seeds **38** categories from the
decided crosswalk, with the file's own reason stated at the top (*"not from v1's 132 free-text
entries with their duplicates and inconsistent casing"*). This pass **re-confirms that decision and
does not reopen it.** What it opens is the half nobody built: a way to maintain the list afterwards.

### 1.4 v2 at source, today

| | |
|---|---|
| Table | `expense_categories` — `packages/db/schema/expenses.ts:57-89` |
| Columns | `org_id`, `group`, `category`, `sub_category`, `account_code`, `prepaid_eligible`, `default_coverage_months` |
| `account_code` | **nullable on purpose** — the schema comment: *"a category with no account mapped blocks posting rather than defaulting to 6900 (invariant 7)"* |
| Uniqueness | `unique (org_id, category)` — `expenses.ts:85` |
| Only writer, ever | `seedExpenseCategories` — `packages/db/seed/expense-categories.ts:117-147`, `on conflict (org_id, category) do nothing`, deliberately never `do update` |
| Seeded rows | **38** (9 COGS · 27 OPEX · 1 PERSONAL · 1 CAPEX), **35 distinct account codes** — counted from the seed file on 2026-09-07 |
| The detector | `expenseCategoryUnpostable` — `packages/db/src/repo/findings.ts:1538-1571`. Fires on a *draft* expense older than 3 days whose category has `account_code is null`, with the message *"…cannot post until one is."* |

⛔ **The circle DEF-193 names, stated precisely: every writer that exists always sets
`account_code`, and no writer that can clear or set it exists.** So today the detector can only
fire on a row the ETL or a hand-typed `INSERT` created — and when it does, its own message asks for
an action no screen offers. That is the thing slice 1 closes, and it is the smallest possible piece
of this task.

### 1.5 v2 design — the four verbs

| v1 behaviour | Verb | v2 |
|---|---|---|
| An owner-maintained category list, no deploy needed | **duplicate** | The screen. Same need, same shape |
| `capitalizable` + `defaultCoverageMonths` | **duplicate** | Already columns (`prepaid_eligible`, `default_coverage_months`) — editable on the same form |
| `isSystem` rows deactivatable, never deletable | **duplicate** | Bible §4.4 rule 2, and v2 has **neither column yet** — slice 2's migration |
| **No account mapping anywhere** | ⭐ **add** | The whole point. `account_code` becomes settable and clearable, and clearing it is what makes the detector's condition reachable *and* fixable by the same person |
| Free-text `category` + `subCategory` with autocomplete | ⛔ **correct** | One `category` string, `sub_category` retired (§1.6). Autocomplete-from-existing-values is a spelling *suggestion*; the constraint is the control |
| `unique (org_id, category)` as written | ⛔ **correct** | Case- and whitespace-**sensitive**, so `Rent` and `rent ` both insert. Bible §4.4 rule 3 specifies `lower(trim(...))` and the schema does not implement it — **the duplicate-Rent defect is not actually closed today.** Filed, §8.1 |
| `needReceipts` / `needParticulars` / `needBudget` per category | **delete** | Not columns in v2, and their v2 equivalents already exist elsewhere and are stronger: the receipt requirement is a DB CHECK on the expense, the budget link is T-215's `expense_budgets`. Re-adding them as category flags would be a second copy of two rules |
| Per-store `storeActiveMap` visibility toggle | **delete** | Measured unused — 0 override keys across 5 sampled stores (08 §1.2). A mechanism nobody uses, whose only effect is that two stores' pickers can silently disagree |
| Human-typed document id (`SE_EX86`, `SEX999`) | **delete** | `uuidv7()` already. v1's own §5.7 shows what a human-chosen key becomes |
| xlsx batch importer | **delete for now** | 84 rows arrived through it over years; v2 starts from 38 seeded rows and adds them one at a time. A bulk importer is the thing that made v1's list unauditable. Not adopted — §7 |

### 1.6 `sub_category` — a verdict, because it is a live column with no live use

`sub_category` exists on the table and **every seeded row leaves it NULL**; nothing reads it.
v1's two-level free-text hierarchy is what produced the 8 catch-alls. Two honest options:

- **(a) Retire it** — drop the column in slice 2, one level only. Simplest, and matches what the
  seeded data already is.
- **(b) Keep it, unused** — a nullable column costs nothing and a future need might want it.

**Recommendation: (a), retire it.** A column that is always NULL and appears in a picker is how
v1's catch-alls arrived. ⚠️ Reversing this later is a migration, so it is stated as an open
question rather than assumed — **open question 2.**

### 1.7 Which capability governs it

⭐ **Reuse `manage_chart_of_accounts`** — org-scoped, `super_admin ✅ · admin ✅ · manager ✗ ·
staff ✗` (`packages/auth/src/capabilities.ts:505`, `:729`). Three reasons:

1. **It matches v1's own gate exactly.** Every master-list mutation in v1 is `ctx.isAdmin`
   (`expense-entry.actions.ts:70`, `:173`, `:225`); the manager-level screen is the store toggle
   that this pass is deleting.
2. **Mapping a category to an account IS a chart decision.** The matrix's stated reason for that
   row — *"The technical residue. Exactly what Ian was right not to hand over"* — is the reason,
   verbatim.
3. **Reuse before inventing** (RULES §5, CAPABILITY-MATRIX header). A new capability is a new row
   in a build-guarded exhaustive table, a new denial test, and a new thing to reason about.

**Not adopted: a new `manage_expense_categories`.** Its only argument is that *naming* a new kind
of spend feels operational while *mapping* it is technical — but they are one form, and splitting
one form across two capabilities means a manager can create a category they cannot make postable,
which manufactures DEF-193's condition on purpose. **Open question 1** records the alternative,
because it is Ian's call whether a franchise manager may add a category.

---

## 2. Positions — ⚠️ the gap row is wrong, and the remaining gap is small

### 2.1 v1 at source

`/manager/settings/positions` redirects into `/manager/settings/organization?tab=positions`
(§0.1), rendering `src/components/settings/PositionsPanel.tsx` (275 lines). Its verbs:

- **list**, with a *"Show archived"* toggle (`:144`, `:169-171`)
- **add** a store-defined extra — the panel's own copy: *"…are always available as local-user
  positions. Add extras for your store (e.g. Barista, Supervisor, Driver) — they merge with the
  canonical list"* (`:150-151`)
- **archive / restore** a store-defined position (`:202-211`)
- a `sortOrder` on each row (`:199`)
- ⛔ **canonical positions cannot be edited or archived** — *"Always active. Cannot be edited or
  archived."* (`:183`, `:189-199`)

### 2.2 The goal

> **Let a store name the jobs its own people actually do, so attendance, pay and permissions attach
> to a real role — without letting a store rename or retire the six roles the whole organisation's
> reporting is built on.**

### 2.3 The live data

**Unknown.** Position counts live in Firestore, which this lane cannot read. What *is* on record:
`project_add_griller_feature` was a whole engineering task about adding **one** position — cited by
the gap section itself as the evidence that this need is real and recurs.

### 2.4 v2 at source — ⛔ the gap row's claim does not hold

The gap row says positions are *"seed-only"* and *"a store cannot add one"*, naming
`seedCanonicalPositions` → `employmentRepo.seedCanonical` as the only writers. **There is a third
writer and it is wired to a screen:**

| | |
|---|---|
| Domain | `upsertStorePosition` — `packages/domain/src/people/index.ts:213-239`, authorized `manage_store_settings`, refuses a name that collides with a canonical one with a message telling you to assign it instead |
| Repo | `employmentRepo.insertStorePosition` |
| Action | `upsertStorePositionAction` — `apps/erp/src/app/staff/actions.ts:205-216` |
| Screen | **`/staff` already ships it** — `apps/erp/src/app/staff/page.tsx:128-157`, a *"This store's positions"* section listing every position with a `(canonical)` badge and an "Add a position" form |
| Table | `positions` — `packages/db/schema/employment.ts:99-135`, with `is_canonical`, **`is_active`**, `created_by`, and a CHECK that canonical ⇔ org-wide |

**So `add` is done.** What is genuinely missing:

1. **Retire.** `is_active` is a column with a comment stating its purpose — *"Retire a position
   without deleting it — historical employments still reference it"* — and **no writer anywhere**
   sets it `false`. `employmentRepo.listPositions` filters `is_active = true`, so the read half is
   built and the write half is not.
2. **Rename.** `upsertStorePosition`'s doc comment says *"Add or rename a store's own position"*
   and the function **cannot rename** — it finds-or-inserts by name and returns the existing row.
   Filed, §8.2.
3. **`seedCanonicalPositions` has no app caller** — true, and it is **T-228's** to fix, not this
   task's: the canonical six are seeded when an org is created. Flagged to the orchestrator (§9).

### 2.5 v2 design — and the recommendation is *not to build a screen*

| v1 | Verb | v2 |
|---|---|---|
| Add a store position | **duplicate** | Already shipped on `/staff` |
| Canonical rows locked | **duplicate** | Already enforced, in the domain **and** by a DB CHECK |
| Archive / restore | **add** | Two domain functions + two buttons on the panel that already exists |
| Rename | **add** | One domain function; the current one only claims to |
| `sortOrder` | **delete** | Six-to-twelve rows sorted canonical-first then alphabetically (`listPositions` already does this). A hand-maintained order on a list this size is a field to keep correct for no reader |
| A dedicated positions settings screen | ⛔ **delete** | See below |

⭐ **Recommendation: extend `/staff`'s existing panel; do not put positions on the settings shelf.**
§1.2c asks for familiar-but-upgraded, and this is the "upgraded" half: v1 put positions under
Settings because v1 had nowhere else, and the consequence is that assigning a position and creating
one are two screens and two navigations. In v2 they are already one screen. Moving it to
`/settings/positions` would be *reinventing towards v1's layout*, which is the opposite of the
rule. **A cross-link from the shelf to `/staff#positions` gives discoverability at zero cost.**

**Capability: `manage_store_settings`, unchanged** — store-scoped, manager ✅, already what
`upsertStorePosition` authorizes. Retire and rename ride on the same one: they are the same
decision as adding, one step later.

---

## 3. Wastage — two questions, two answers

§0.3 established that the gap row's "wastage reasons" conflates two lists.

### 3.1 `WASTAGE_REASONS` — ⛔ verdict: KEEP THE CONSTANT. No table, no screen.

**The goal of a reason list:** *classify a stock loss so the same kind of loss is countable across
every module that can produce one.*

`packages/domain/src/stock/wastage-reasons.ts:1-38` — ten codes, one canonical list shared by item
usage, meat usage and general inventory, and the file already states v1's own reason for that
sharing: *"reports can aggregate 'spoilage' or 'theft' across all item kinds without per-module
string normalization."*

⛔ **A store-extensible reason list destroys the single property the list exists for.** The moment
one store can add "Spoiled", the question *"how much did we lose to spoilage last quarter"* needs a
normalisation pass over history — which is precisely the failure the constant prevents, and
precisely what v1's 132 free-text expense categories became (§1.3).

**The cost of this verdict, stated plainly:** adding an eleventh reason is a deploy. That is
acceptable at the observed cadence — all ten came across from v1 verbatim, and `other` exists for
the long tail. The gap section already leaned this way (*"the right answer may well be keep it a
constant… Needs a verdict, not necessarily a screen"*); this is that verdict, with the reason
recorded so it is not re-litigated.

⚠️ **One thing to fix while here, and it is not cosmetic:** `stock_usage_records.reason_code` is
plain `text` with **no CHECK against the ten codes**. Migration `0067_t168_stock_usage.sql:37-40`
constrains *reserved* categories and nullability, not membership; the enum is enforced only in the
domain layer (`isWastageReason`). Bible §6.3 — *"the database enforces the rules, not the service
layer"* — says that is the wrong side of the line, and an ETL row or a hand-typed `INSERT` bypasses
it. Filed, §8.3. **A one-line CHECK, and it is a natural passenger on slice 2's migration.**

### 3.2 ⭐ The capability the gap row actually found: tracked-vs-instant is a per-record choice

**v1's goal:** *decide once, per store, which sources of wastage are serious enough to enter the
charge lifecycle — so the person recording one cannot decide that their own is not.*

`wastage-settings-client.tsx` seeds FoodPanda / Grab / Dine-in and holds `mode` per type. The
policy memo the same screen drafts (`:25-36`) is what the mode is *for*: a tracked wastage gets a
monitor, a 48-hour dispute window, and a **15-day auto-charge backstop**.

**v2 at source:**

| | |
|---|---|
| The column | `order_wastages.type_mode` — `packages/db/schema/order-wastage.ts:35`, `:75` |
| Who decides it | **the caller** — `RecordOrderWastageInput.typeMode`, `packages/domain/src/wastage/orders.ts:201` |
| Which means | **the person filling the form** — `apps/erp/src/app/wastage/page.tsx:133-136`, two radio buttons, `tracked` merely the default |
| Per-store type registry | **none exists** |

⛔ **This is a control hole, not a missing screen.** A staffer recording a FoodPanda wastage can
select `instant` + `absorbed` and the row is booked to `5300` and closed in the same call — no
monitor, no dispute window, no 15-day backstop, no charge. v1 made this a store policy for exactly
that reason, and v2 handed the choice to the person with the incentive.

⭐ **v2's design, and it is better than v1's:** put the mode **on the sales channel**, not in a
parallel type list. `order_wastages.channel` is already resolved against a real `sales_channels`
row by name at posting time (`order-wastage.ts:67-72`), so v1's types and v2's channels are already
the same objects under two names — and a mode column on `sales_channels` makes them agree by
construction instead of by matching strings. `recordOrderWastage` then **derives** `typeMode` and
stops accepting it.

| v1 | Verb | v2 |
|---|---|---|
| Per-store list of wastage types with a mode | **duplicate** the intent | `sales_channels.wastage_type_mode` — one column, no second list |
| A separate `wastageTypes` collection whose names match nothing | ⛔ **delete** | The channel registry already is that list |
| Caller-chosen `typeMode` | ⛔ **correct** | Derived. The form stops asking |
| The policy-memo generator on the settings screen | **defer** | Memos are not a v2 module yet. Named, not built — §7 |

**Capability: `manage_store_settings`** (store, manager ✅) — same bar as the channel row it sits
on. ⚠️ **This item needs Ian's call before it is built**: it removes an operator choice that exists
today, which §1.2's "if a feature looks pointless, ASK" cuts both ways. **Open question 3.**

---

## 4. Salary-advance policy — ⛔ recommend deferring out of T-229, and the reason is the point

### 4.1 v1 at source

`/manager/settings/salary-advance` (`page.tsx`, 16 KB), writing
`stores/{storeId}/salaryAdvanceSettings/default`
(`src/lib/financial/salary-advance/settings-schema.ts:65`). Six fields (`page.tsx:32-41`):

| Field | What it does | Enforced at |
|---|---|---|
| `allowedTxTypes` | which of `salary_advance` / `repayment` / `charge` may be recorded; at least one required | `salary-advance.actions.ts:437-439` |
| `allowedDaysOfWeek` | days a *salary advance* may be recorded at all | `:441-448` |
| `maxAmountPerDay` | per staffer per day, on `salary_advance` only, voided rows excluded | `:450-468` |
| `maxBalancePerStaff` | a ceiling on outstanding balance, evaluated against the staffer's **combined cross-store** balance, not this store's slice | `:470-…` |
| `defaultChargeCounterAccountId` | the counter-account a non-cash charge posts to. ⭐ **Server-derived, client value ignored, allowlist-checked** — `:286-306` | `:286-306` |
| `defaultRepaymentDestAccountId` | where a repayment lands | |

All four rule checks run **inside the Firestore transaction**, on a re-read of the settings doc
(`:433`, with the comment *"so day-total + balance reads are serially consistent with rule
enforcement"*). ⭐ **This is one of the better-built things in v1** and it is worth saying so:
gates are server-side, the account is never trusted from the client, and the read is transactional.

### 4.2 The goal

> **Keep a staff advance from quietly becoming an unrecoverable loan — bound what one person can
> take in a day and carry in total, and keep the account a non-cash charge lands in out of the
> recorder's hands.**

### 4.3 The live data

**Unknown** — the settings docs and advance balances are in Firestore. Two facts *are* on record
and both matter: `src/lib/stores/store-readiness.ts:149` lists `salaryAdvanceSettings` as a
**store-readiness key**, so v1 treats a store without it as not fully set up; and the charging
policy memo drafted by the *wastage* screen carries the line *"Wastage charges are deducted from
pay and are not subject to the usual salary-advance limits"*
(`wastage-settings-client.tsx:36`) — evidence that the limits are live enough to need a written
carve-out.

### 4.4 v2 at source — the mechanism shipped, the bound did not

`1230 Advances to employees` is **party-bearing** and is raised by **four** independent paths:

| Path | Where |
|---|---|
| Cash-request shortage — `DR 1230 · CR 1120` | `packages/domain/src/cash-requests/index.ts:31`, `:281` |
| Order-wastage staff charge | `packages/domain/src/wastage/orders.ts:44` |
| Commissary transit discrepancy charge | `packages/domain/src/commissary/discrepancy.ts:34` |
| Owner drawing settled against pay — `DR 1230 · CR 1260` | `packages/domain/src/owners/index.ts:26`, `:383-391` |

…and recovered by `postPayRun`, separation final pay and 13th-month
(`payslips.advance_recovered`, `separations.advance_recovered`). ⛔ **Not one of the four raise
paths consults any ceiling, because none exists.** A staffer's `1230` balance is unbounded by
construction.

⭐ **One correction is free.** v1 reconstructs a combined balance by walking cross-store identity
documents; v2 already has the honest version — `packages/domain/src/payroll/index.ts:322`,
*"What a person still owes on `1230`, read from the LEDGER."* Any v2 cap reads that.

### 4.5 The four verbs — and what survives is one number

| v1 field | Verb | v2 |
|---|---|---|
| `maxBalancePerStaff` | **duplicate + correct** | ⭐ The control worth keeping. Read from the ledger, not a stored balance |
| `maxAmountPerDay` | ⚠️ **question** | v2 has no "salary advance document" to cap per day. Its nearest equivalent is cash released to one person in a day, which is `cash_requests`' concern, not `1230`'s |
| `allowedDaysOfWeek` | ⛔ **delete** | v2's four raise paths are a shortage, a wastage, a transit loss and a drawing. **Refusing to record a real shortage because it is a Tuesday produces an unrecorded fact**, which is strictly worse than the exposure it prevents |
| `allowedTxTypes` | ⛔ **delete** | No free-form advance document exists to switch off. Each raise path is its own document with its own capability |
| `defaultChargeCounterAccountId` | ⛔ **delete** | `docs/POSTING-PATTERNS.md` fixes the counter account **per business event**. A configurable one is configuration deciding accounting — the shape §16.10 exists to prevent |
| `defaultRepaymentDestAccountId` | ⛔ **delete** | Same |

**So the honest port is a single nullable number per store: a staff-advance ceiling.**

### 4.6 ⛔ Why this should NOT ship inside T-229

The screen half is one input. The **enforcement** half is four domain call sites in four modules,
each needing its own refusal test and its own decision about what happens when a legitimate
operational fact (a real till shortage) would breach the cap — refuse the shortage, or record it
and flag it? That is a genuine design question with an accounting answer, not a settings form.

⛔ **And shipping the input without the enforcement is the worse of the two failures.** A field
labelled "maximum advance balance" that nothing checks is a control that is not one — DEF-052's
exact shape (*"in v1 this grant enforced nothing"*), which this project has already met twice.

**Recommendation: file it as its own task and take it out of T-229's scope.** T-229 delivers the
shelf and puts the item on it as a stated, visible gap — the pattern T-216's screen already set
(*"the screen SAYS the job does not exist, in a banner, in plain language"*). **Open question 4.**

**Capability when it is built: reuse `set_cash_policy`** — store-scoped, `admin ✅ · manager ✗`
(`capabilities.ts:492`, matrix row). Its stated reason transfers word for word: *"the ceiling is
the number a store's cash custody is measured against, so whoever is measured must not move it. A
risk limit is not an operating setting."* A staff-advance ceiling is the same species, and a
manager who can raise the cap on advances they approve is the control failing at the point it
matters.

---

## 5. Organization details — ⛔ larger than "no screen": the fields do not exist

### 5.1 v1 at source

Per §0.2: `ERP-rebuild/src/app/admin/stores/store-editor.tsx:56-70`, an "Identity & Tax" section on
the **store** carrying `legalName`, `tin`, `taxType`, plus contact fields and a full address. There
is no organization-level entity in v1 to put them on.

### 5.2 The goal

> **Hold the legal identity the books are kept under, so a document that has to carry a business
> name and a TIN carries the right ones — and so correcting a registered name is a form, not a
> support request.**

### 5.3 The live data

**Unknown** (Firestore). The relevant count is not of rows anyway — there are single digits of
stores — it is of *fields*, and that count is zero (§5.4).

### 5.4 v2 at source

| Table | Identity columns |
|---|---|
| `organizations` (`packages/db/schema/organizations.ts:11-19`) | `id`, `name`, `code`, `is_active`, timestamps. **No TIN, no legal name, no address** |
| `stores` (`packages/db/schema/stores.ts:48-127`) | `code`, `name`, `timezone`, `is_active`, `stock_model`, `remittance_cadence`, `unremitted_ceiling`, `wastage_monitor_person_id`. **No TIN, no legal name, no address, no tax type** |
| `updateStoreDetails` (`packages/domain/src/stores/service.ts:169-177`) | patches `name` and `timezone`. That is the whole surface |

⛔ **TIN and legal name are not "unreachable from a screen" — they were not carried across at all.**
A statutory identifier that v1 records on every store is absent from v2's schema. That is a
replatform loss, and it is filed as such (§8.4).

### 5.5 v2 design — one improvement on v1 worth stating

| v1 | Verb | v2 |
|---|---|---|
| `legalName`, `tin`, `taxType` on every store | **duplicate the need**, ⛔ **correct the placement** | ⭐ **The org owns the registered name, the TIN and the tax type; the store owns its branch code, trading address and contact.** v1 put the whole TIN on each store because v1 had no org to put it on. In PH a corporation holds one TIN and its branches carry a branch code against it, so copying the same number onto seven store rows is seven places for it to be wrong — and discovery 23 §1 already recorded exactly that class of failure for `taxType` duplicated across ERP and POS (*"the receipt the customer holds and the books disagree about VAT"*) |
| Store `address`, `email`, `phone`, `contactNo`, `telephone` | **duplicate**, trimmed | One `address` and one contact number per store. Four phone fields is v1's form growing rather than a requirement |
| Store logo upload | **defer** | Not a books concern; nothing in v2 renders one yet |
| `status: active/inactive/under_construction/closed` | **delete** | v2 has `is_active` and T-222's readiness checks. *Under construction* is a readiness state, and `storeReadiness` computes it live rather than storing a label somebody has to remember to change (`service.ts:219-230` — *"a stored 'store is ready' flag… someone ticks it, the sales channel is later deleted, and the store reports ready forever"*) |

⚠️ **Guard rail, and it must be in the spec:** bible §13 row 75 — this is a **management ledger,
not a statutory filing basis**, and *"never label or export output as BIR-ready."* A TIN field
exists so a document can print the right identity. It must not be presented as, or grow into, a
compliance feature.

### 5.6 Capability

- **Org identity** (`organizations.legal_name` / `tin` / `tax_type`): ⭐ **`manage_users` is wrong,
  `manage_stores` is wrong.** The nearest correct existing row is **`manage_chart_of_accounts`**
  (org, admin ✅, manager ✗) — the same "technical residue, admin only" bar as §1.7. Editing the
  legal identity of the entity the books belong to is not a store-operations act. ⚠️ Its *name*
  reads oddly for this use; the alternative is one new org-scoped row (`manage_organization`).
  **Open question 5.**
- **Store identity** (`stores.address` / contact / branch code): **`manage_stores`** — org-scoped,
  admin ✅, manager ✗, already what `updateStoreDetails` authorizes today (`service.ts:174`).
  ⛔ **Not `manage_store_settings`**, which is manager-level: a manager who could edit the trading
  name and address on the store's own documents is a wider grant than a manager needs.

### 5.7 ⚠️ Lane collision with T-228 — flagged, not resolved here

T-228 (`createOrganization`, `scripts/bootstrap-org.ts`) is being built in a parallel lane against
the same `organizations` table. Adding identity columns to it and teaching `createOrganization` to
accept them is a **sequencing decision for the orchestrator**, not something two lanes should each
assume. Raised in §9.

---

## 6. The shelf itself — the container is the gap

The gap section's own framing is right: *"Each item below is small; what is missing is the shelf
they stand on."*

**v1's shelf** (`src/app/manager/settings/page.tsx:21-88`): a responsive card grid
(`md:grid-cols-2 xl:grid-cols-3`), one card per destination, each with an icon, a **title**, and a
**one-sentence description of what you can change there** — plus one card that opens a modal rather
than navigating. Eleven cards.

**Why the description line is the part worth duplicating:** it is what makes a settings hub
navigable without opening every child. v1's are specific — *"Control allowed transaction types,
maximum amount per record, and allowed days of the week"* — not category labels.

**v2 today:** `/settings` is not a route. DEF-192's disposition (2) dropped the nav entry rather
than building a hub, with the reason stated: *"A hub page listing exactly one child is a screen
that exists to satisfy a link; when a second settings surface lands, a hub earns its place."*
**T-229 is that moment** — it lands the expense-category screen beside `/settings/attendance`, and
cross-links to `/staff` (positions), `/admin/stores` (store identity) and `/budgets`.

**Under §1.2c, familiar-but-upgraded:** same card-grid-with-descriptions, in v2's house style
(Server Actions, plain Tailwind, no shadcn — matching `/settings/attendance` and every other
`apps/erp` screen). ⚠️ **And it must pass at 390 px** — DEF-199 measured 24 of 66 routes scrolling
sideways, and a card grid is exactly where a fixed `min-w` creeps in.

---

## 7. ⛔ What we are NOT adopting, and why — bible §3.6 guard 3

Research that returns only a list of things to add has become a shopping list.

| Not adopted | Why |
|---|---|
| **A `wastage_reasons` table** | §3.1. The list's whole value is that it is closed. Extensibility is the defect, not the feature |
| **An xlsx batch importer for categories** | §1.5. 84 hand-added rows over years is what made v1's list unauditable. v2 starts from 38 seeded rows; a bulk path is how the 39th through 130th arrive unreviewed |
| **Per-store visibility toggles for categories** (`storeActiveMap`) | Measured **unused** — 0 override keys across 5 sampled stores (08 §1.2). Its only live effect would be two stores' pickers silently disagreeing |
| **`sub_category`, v1's second free-text level** | §1.6. It produced the 8 catch-alls and is NULL on all 38 seeded rows |
| **v1's `allowedDaysOfWeek` / `allowedTxTypes` / configurable counter-accounts** | §4.5. Two are configuration deciding accounting; one refuses to record facts that happened |
| **A dedicated positions settings screen** | §2.5. `/staff` already has it, and moving it there would be reinventing towards v1's layout |
| **`sortOrder` on positions** | §2.5. A hand-maintained order over ~10 rows, with no reader |
| **A generic "settings framework"** (typed schema → auto-rendered forms) | Four screens do not justify an abstraction, and every one of them has a different shape: an effective-dated supersede (attendance), a list CRUD (categories), a single number (advance ceiling), a record edit (org identity). The industry name for the alternative is *"just write the four forms"*, and at this scale it wins |
| **A settings **audit log** table** | `audit_log` already exists with **zero writers and zero readers** (DEF-169). Adding a second consumer to a table nobody reads is not the fix; every table here already carries `updated_at` / `created_by` |
| **v1's policy-memo generator on the wastage screen** | §3.2. Memos are not a v2 module. Named so it is not rediscovered |
| **A store-level TIN copied per store** | §5.5. One number in seven places is seven chances to be wrong; discovery 23 §1 records that exact failure for `taxType` |

**Genuinely standard vs. one vendor's choice** (guard 4): the *reference-data-with-a-system-flag*
pattern — seeded rows marked `is_system`, deactivatable, never deletable, uniqueness on a
normalised key — is standard across ERPs (SAP, Odoo, ERPNext, QuickBooks all do a version of it)
and is already the bible's §4.4 rule. The *effective-dated config supersede* pattern
(`store_attendance_config`) is narrower and stays where it is: it is right for a policy that
retroactively changes computed pay, and wrong for a category list, where "which account did this
map to last March" is answered by the posted journal line, not by the category row.

---

## 8. ⭐ Found in passing — logged before moving on (RULES §3, bible §13 row 164)

All `reported`, none verified beyond the citation given. **None of these is in T-229's scope**;
they are here because this pass is the only session that will have had this context.

### 8.1 §E — the duplicate-Rent defect that bible §4.4 exists to close is not actually closed

`packages/db/schema/expenses.ts:85` — `uniqueIndex('expense_categories_org_id_category_unique')
.on(t.orgId, t.category)`. Bible §4.4 rule 3 specifies **`UNIQUE (org_id, group, lower(trim(
category)), lower(trim(sub_category)))`** and says of it: *"This is the actual fix."* The shipped
index is case- and whitespace-sensitive, so `Rent`, `rent` and `Rent ` are three rows. Harmless
while `seedExpenseCategories` is the only writer; **it becomes live the moment T-229 slice 2 ships
creation**, which is why that slice carries the migration. `positions` gets this right and says so
(`employment.ts:130-135` — a hand-added expression index, *"Drizzle's builder cannot express"* it);
`expense_categories` did not get the same treatment.

### 8.2 §E — `upsertStorePosition`'s doc comment claims a verb it does not implement

`packages/domain/src/people/index.ts:212` — *"Add or rename a store's own position."* The body
(`:213-239`) finds-or-inserts by name and returns the existing row on a hit. **There is no rename
path.** A stale comment on a security-adjacent function is how the next reader concludes the
capability exists.

### 8.3 §E — `stock_usage_records.reason_code` is unconstrained text

`packages/db/migrations/0067_t168_stock_usage.sql:37-40` constrains reserved categories and
nullability; **nothing constrains membership of `WASTAGE_REASONS`**. Enforcement is domain-only
(`isWastageReason`), which bible §6.3 puts on the wrong side of the line, and the ETL and any hand
`INSERT` bypass it. One-line CHECK.

### 8.4 §E — TIN and legal name were not carried across from v1 at all

§5.4. `organizations` and `stores` between them hold no `tin`, no `legal_name`, no `tax_type` and
no `address`; v1 records all four per store (`store-editor.tsx:56-70`). This is a **statutory field
lost in a replatform**, and it is a defect rather than a gap because the data exists in v1 today
and nothing in v2 can receive it.

### 8.5 ⛔ `stores.wastage_monitor_person_id` has ZERO writers, and a screen tells users to set it

`packages/db/schema/stores.ts:103` declares it; the only assignment anywhere is a raw `UPDATE`
inside `packages/domain/tests/integration/order-wastage.test.ts:109`. Meanwhile:

- `apps/erp/src/app/wastage/page.tsx:146` instructs the user: *"…seeds this store's Wastage Monitor
  as the responsible party if none is named here — **set the Monitor under Settings**"* — pointing
  at a settings surface that does not exist. DEF-192's shape, in prose instead of a nav entry.
- `packages/db/src/cutover/classification.ts:71-77` **clears** the column at cutover and records
  *"cleared and re-assigned at cutover"* — with no path to re-assign it.
- The consequence is silent: `recordOrderWastage`'s invariant 2 seeds the Monitor only *"if
  monitor"* (`orders.ts:262-264`), so with none set every tracked wastage is created ownerless and
  falls to the backstop's third tier — *store absorbs, net zero*. **Nothing is recovered and
  nothing errors.**

⭐ This is the single most consequential thing this pass found that was not on anyone's list, and
it is a one-field form. **Recommended for T-229's shelf** if the orchestrator wants a sixth item —
it is smaller than every item on the list and costs real money today.

### 8.6 ⛔ `sales_channels` has no production writer, and store readiness blocks on it

`packages/domain/src/stores/service.ts:259-268` — readiness check `salesChannel`, **`blocking:
true`**: *"Without one a sales day has nowhere to land, and an unresolvable channel blocks rather
than silently defaulting (DEF-059)."* The only writers anywhere are `scripts/dev-seed.ts:139-146`
(guarded to `_dev` databases) and integration-test fixtures. `recordChannelSettlement` writes
`destination_money_account_id` on an existing row (`repo/channel-settlements.ts:393-404`) and
creates none.

**So a store created through T-222's `/admin/stores` is permanently not-ready, its own readiness
panel says so, and there is no remedy** — DEF-193's shape again, one severity higher, on the path
between "the pilot org exists" (T-228) and "a store can record a sales day". Cross-check against
T-228 before the pilot.

### 8.7 🔸 Three documents state the seeded-category count as 39; it is 38

`packages/db/seed/expense-categories.ts` holds **38** entries (9 COGS · 27 OPEX · 1 PERSONAL ·
1 CAPEX) across **35** distinct account codes, unchanged since commit `9209b8f` (2026-08-25).
`docs/DEFECTS-REGISTER.md` DEF-193 says *"39 categories, 36 distinct codes"*;
`docs/CAPABILITY-GAPS.md` says *"39 rows"*; and **`docs/tasks/228-organization-bootstrap.md:204`
makes it a test assertion** — *"seeds 93 accounts and 39 categories"* — so lane A's test 1 will
fail on a correct implementation. Worth correcting before T-228 is built, not after.

### 8.8 🔸 A stale assertion title in the capability guard

`tests/unit/capability-matrix.test.ts:292` — the test is named *"…all enumerate the same 93
capabilities"* and asserts `95` on the next line. Cosmetic, but it is the file every future
capability row is added to, and the number in the title is what a reader trusts.

---

## 9. For the orchestrator — decisions this pass could not make alone

1. **The 38-vs-39 category count (§8.7) reaches lane A.** T-228's test 1 asserts 39.
2. **`seedCanonicalPositions` has no caller** (§2.4) — it belongs in `createOrganization`, which is
   T-228's file, not this lane's.
3. **Org identity columns (§5) touch `organizations`,** which lane A is building against. The
   migration and `createOrganization`'s input shape need sequencing between the two lanes.
4. **§8.5 (`wastage_monitor_person_id`) and §8.6 (`sales_channels`)** are both bigger than three of
   the five items in this lane's brief. Neither is in T-229's scope as written. Both want a
   decision rather than a discovery note.

## 10. Method note

1. **v1 read at source**, read-only, no `git`, no `npm`, nothing written:
   `src/app/manager/settings/page.tsx`, `.../organization/page.tsx`, `.../positions/page.tsx`,
   `.../wastages/{page.tsx,wastage-settings-client.tsx}`, `.../salary-advance/page.tsx`,
   `src/components/settings/PositionsPanel.tsx`,
   `src/app/admin/configurations/expense-entries/expense-entry-editor.tsx`,
   `src/app/admin/stores/store-editor.tsx`, `src/app/admin/stores/[id]/store-details-client.tsx`,
   `src/lib/actions/salary-advance.actions.ts`,
   `src/lib/financial/salary-advance/settings-schema.ts`, `src/lib/stores/store-readiness.ts`.
2. **v2 read at source**: the schema, seed, repo, domain, app and test files cited inline above.
3. **Live counts** are cited from `docs/discovery/08-expense-categories.md` (which did read
   Firestore, on 2026-08-23) or written `unknown`. **This pass read no Firestore and no ETL landing
   table**, and estimated nothing.
4. **Nothing outside `docs/discovery/` and `docs/tasks/` was created or modified by this pass.**
