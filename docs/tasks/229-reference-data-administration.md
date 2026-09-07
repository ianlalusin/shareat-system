# T-229 — Reference-data administration: the settings shelf

> **Status**: 🟢 **SLICE 1 BUILT 2026-09-07** — `/settings` hub + `/settings/expense-categories`,
> `setCategoryAccount`, four repo functions, **8 integration tests green on `shareat_test_t229`**.
> ⛔ **DEF-193 is closed by test 7**, which was watched to fail on the live condition first: the
> detector returned one finding, the mapping was made, the detector returned none.
> **Slices 2, 3 and 4 not started. ⛔ Slice 5 moved out to
> [T-230](230-sales-channels-admin-and-wastage-policy.md) on 2026-09-07** once Ian answered Q3 —
> the per-channel wastage mode and DEF-207's sales-channel admin surface touch the same table and
> need the same migration, so they ship as one package.
>
> ⚠️ **One deviation from the approved Scope, reported not worked around (RULES §3.4a):** the scope
> line said *"packages/db/src/repo/expenses.ts — ADD a new update function only"*. Four were added,
> not one — `listCategoriesForAdmin`, `accountForMapping`, `mappableAccounts` and
> `setCategoryAccountCode`. The literal reading is unbuildable: bible §4.3 puts **all** SQL in the
> repo, and the screen needs a list read, a validation read and a picker read besides the write.
> `listCategories` and `getCategoryById` are untouched, which is what the constraint was protecting.
>
> ⭐ **Decisions taken 2026-09-07 (orchestrator, on this spec's open questions):** Q1 —
> `manage_chart_of_accounts`, no new capability, and create + map stay ONE capability. Q2 — drop
> `sub_category` in slice 2. Q3 — ✅ **answered the same day (bible §13 row 180): the channel carries
> the mode, and the work left this task with slice 5.** Both carve-outs accepted: the salary-advance ceiling becomes its own task, and no dedicated
> positions screen is built. **The wastage-monitor field was accepted INTO T-229 as slice 3.**
>
> Discovery:
> `docs/discovery/28-reference-data-administration.md`. Source gap:
> `docs/CAPABILITY-GAPS.md` § "Added 2026-09-06". Defects: **DEF-193** (the remedy slice 1 ships),
> **DEF-192** (fixed by T-227 with the note *"when a second settings surface lands, a hub earns its
> place"* — slice 1 is that moment).
>
> ⚠️ **Three of the gap section's five item descriptions did not survive reading v1 at source**, and
> two of them change what gets built. Discovery §0 has the citations; the short version:
> **(a)** v1's `/manager/settings/organization` is a Positions + Locations + Departments tab hub,
> not a business-details screen — so the gap table counts one v1 screen as two items, and v1's TIN
> and legal name live on the **store**, at `/admin/stores` (`store-editor.tsx:56-70`);
> **(b)** v1's `/manager/settings/wastages` configures order-wastage **types** (channel +
> tracked/instant mode), which is T-178's domain — not `WASTAGE_REASONS`, which is T-164/T-168's
> stock-loss taxonomy;
> **(c)** positions are **not** seed-only — `upsertStorePosition` is wired to a form that already
> ships on `/staff` (`apps/erp/src/app/staff/page.tsx:128-157`).
>
> ⛔ **Two items are recommended OUT of this task, with reasons, per bible §0.3/§0.4:** the
> salary-advance ceiling (discovery §4.6 — an input with no enforcement is DEF-052's shape) and a dedicated
> positions screen (discovery §2.5 — `/staff` already has it, and moving it would be reinventing *towards* v1).
> Both recommendations are reversible by Ian; say so and they go back in.

---

## Goal

**A store's reference data can be maintained by the people who run it, without an engineer writing
a migration — starting with the one case where a live detector reports a problem nobody can fix.**

Observable outcome, slice 1: an admin opens `/settings`, opens Expense categories, sets an account
on a category that has none, and the `expenseCategoryUnpostable` finding for the expense stuck
behind it clears on the next detector run.

---

## Slices, in order

| # | Ships | Migration | New capability | Blocked on |
|---|---|---|---|---|
| **1** ✅ | ⭐ **The `/settings` hub + map a category to an account** — DEF-193's remedy | ⛔ **none** | ⛔ **none** | — **BUILT 2026-09-07** |
| **2** ✅ | Create / rename / retire a category, `is_system`/`is_active`, the normalised unique index — **DEF-205** | ✅ **0134** | ⛔ none | — **BUILT 2026-09-07** |
| **3** ✅ | ⭐ **Assign the store's Wastage Monitor** — DEF-206 | ⛔ **none** | ⛔ **none** | — **BUILT 2026-09-07** |
| **4** | Store & organization identity — legal name, TIN, tax type, address | ✅ one | ⚠️ open q. 5 | T-228 landing (discovery §9) |
| ~~**5**~~ | ~~Order-wastage mode moves onto the sales channel; the form stops asking~~ | — | — | ⛔ **MOVED OUT 2026-09-07 → T-230** |

⛔ **Slice 5 is no longer this task's.** Ian answered open question 3 on 2026-09-07 (bible §13 row
180: the mode becomes a **per-channel policy**), and the same day's DEF-207 call gave sales channels
an **admin surface**. Both change `sales_channels` and both need one migration, so they are one
package: **`docs/tasks/230-sales-channels-admin-and-wastage-policy.md`**, migration slot 0133.
⚠️ **T-230 also carries the normalised-uniqueness fix for `sales_channels`** — DEF-205's rule
(bible §4.4 rule 3) on a second table, for the same reason slice 2 carries it here: the index ships
in the migration that first lets a human create a row, never after.

⭐ **Slice 3 was not in the original spec — it was found in passing (discovery §8.5) and accepted
into this task by the orchestrator on 2026-09-07.** `stores.wastage_monitor_person_id` has **zero
writers** outside one test's raw `UPDATE`, `/wastage` tells the user *"set the Monitor under
Settings"* (a surface that did not exist), and the cutover **clears** the column saying it is
*"re-assigned at cutover"* with no path to re-assign it. With none set, `recordOrderWastage`'s
invariant-2 seed silently does nothing and every tracked wastage falls to the backstop's third
tier — *store absorbs, net zero*. Nothing is recovered and nothing errors. It is a one-field form
and it costs real money today, which is why it sorts above the two migration slices.

⭐ **Slice 1 is deliberately the smallest thing that closes DEF-193**, and it needs no migration, no
capability row, no schema change and no new table — every column already exists. As built it is two
pages, one server action, one gated domain function and four repo functions.

⛔ **Slices 2 and 4 do not start until slice 1 is committed, and never two at once.** Each
carries a migration, and bible §3.4 / RULES §2 forbid two lanes holding
`migrations/meta/_journal.json` at the same time. ⚠️ **T-230 holds the journal on slot 0133 while
it is in flight**, so neither may start beside it. **Slice 3 carries no migration** and is
therefore the one that can run beside another lane safely.

---

## Scope — the exact files each slice may create or modify

### Slice 1

**Create**
- `apps/erp/src/app/settings/page.tsx` — the hub
- `apps/erp/src/app/settings/expense-categories/page.tsx`
- `apps/erp/src/app/settings/expense-categories/actions.ts`
- `apps/erp/src/app/settings/expense-categories/lib.ts`
- `packages/domain/src/expenses/categories.ts`
- `packages/domain/tests/integration/expense-categories-admin.test.ts`

**Modify**
- `packages/db/src/repo/expenses.ts` — ⚠️ **as built, four additions, not one** (see the deviation
  note in the Status block): `listCategoriesForAdmin`, `accountForMapping`, `mappableAccounts`,
  `setCategoryAccountCode`, plus the `ExpenseCategoryAdminRow` interface. `listCategories` and
  `getCategoryById` already exist (`:63`, `:83`) and are **not** touched
- `packages/domain/src/expenses/index.ts` — one line, `export * from './categories';`

**✅ Pre-wired by the orchestrator, not by this lane** (per the lane brief) — **both landed 2026-09-07**:
- `apps/erp/src/components/nav.tsx` — in the **Setup** group, **replace** line 154
  `{ href: '/settings/attendance', label: 'Attendance settings' }` with
  `{ href: '/settings', label: 'Settings' }`. ⭐ The direct attendance link is dropped on purpose:
  `tests/unit/nav-route-reachability.test.ts` checks reachability **transitively**, and the hub
  links to it. Two entries where one suffices is how the Setup group grows into v1's eleven cards.
- `packages/domain/src/expenses/index.ts` — `export * from './categories';`, added by the
  orchestrator (concurrent lanes collide on barrels, and lane A was editing the sibling
  `packages/domain/src/index.ts` at the same time).

⚠️ **The nav entry alone was NOT enough, and the reason is worth keeping.** With `/settings` in
nav, `nav-route-reachability` **still** failed on `/settings/expense-categories`: the hub rendered
its children from a `CARDS` array as `<a href={card.href}>`, and the guard's `LINK` regex trusts
only a literal `href=` + quote + path, deliberately (*"a bare string that happens to look like a
path is not a link"*). The links worked at runtime and the build was red anyway — the guard was
right by its own contract. Fixed by making every hub `href` a literal at the call site; the page's
header comment says so, so nobody tidies it back into a data table.

### Slice 2 ✅ **BUILT 2026-09-07** — migration `0134_t229_expense_category_admin.sql`

> ⛔ **Q2's premise was WRONG, recorded here so the next reader does not inherit it.** Q2 was taken
> on *"`sub_category` is NULL on all 38 seeded rows, read by nothing"*. The first half held; the
> second did not — the column had **four live SQL readers** (`budgets.listForStorePeriod`,
> `budgets.categoriesWithoutBudget`, `commissary.orderableCatalogue`'s label CASE, and
> `commissary-catalogue.listMap`'s `expenseSubCategory`, which `/commissary/catalogue` rendered).
> ⚠️ **Only `repo/expenses.ts` used Drizzle's typed builder; the other three are raw `sql` strings
> TypeScript cannot see** — so dropping it would have gone green through typecheck, unit tests and
> build, then failed at runtime on the budgets screen and the commissary catalogue. Found by
> grepping the **snake_case** column name before writing the migration; the lesson generalises.
> All four were fixed in the same commit, readers first, and each is now **executed** against real
> Postgres by tests 16-18.
>
> ⭐ **Retire is wired all the way through the pickers** — Ian, 2026-09-07, overruling this lane's
> proposal to defer it: *"fix the pickers too, don't wait for lane A."* `listCategories` gained an
> `activeOnly` option and `expenses/lib.ts` gained `listActiveCategoriesGrouped` beside the existing
> `listCategoriesGrouped` (**additive only** — lane A holds that file for DEF-211, so its function
> bodies were not touched). ⚠️ **It is a picker-vs-history split, not a blanket filter**, the same
> distinction T-230 drew for sales channels: `/expenses/new`, recurring templates and the commissary
> map take the ACTIVE list; `/expenses`' filter and the AP invoice's existing-line labels keep the
> FULL list; and `/expenses/[id]`'s edit select shows retired options only when the expense already
> carries one, marked `(retired)` — filtering them out unconditionally would silently re-point the
> expense at whatever option happened to be first. Test 19 pins both halves and was watched to fail
> with the filter defeated.
>
> ⚠️ **A second invisible coupling:** `seedExpenseCategories`' `on conflict (org_id, category)`
> names the very index 0134 replaces, and Postgres infers the arbiter from an existing unique
> index — so the old clause matched nothing. It now repeats the index expression exactly. Loud
> rather than silent (the seed runs in T-228's bootstrap and most fixtures), but invisible from
> either file alone.

**Create** `packages/db/migrations/XXXX_expense_category_admin.sql` (⛔ hand-written from the schema file —
`npm run db:generate` is unusable here, its snapshot chain dead since 0019 (DEF-073/DEF-121, 0133's header) — and never hand-applied).
**Modify** `packages/db/schema/expenses.ts` *(orchestrator pre-wires — schema is out of this
lane)*, `packages/db/src/repo/expenses.ts`, `packages/domain/src/expenses/categories.ts`,
`apps/erp/src/app/settings/expense-categories/{page,actions}.tsx`, the integration test.

### Slice 3 — the Wastage Monitor ✅ **BUILT 2026-09-07** (no migration)

> **As built: `/settings/wastage-monitor`, its own route — NOT a panel on `/wastage`.** The scope
> line below said *"decide by where the person already is"* and leaned toward `/wastage`, because
> that is the screen that reports the problem. ⛔ **Reading the capability grid overrules that:
> `record_order_wastage` is `staff: true`.** `/wastage` is an operational screen used by the people
> who record their own losses, so a `manage_store_settings` form there would sit beside the button a
> staffer presses to log their own wastage — the wrong adjacency for a control about who gets
> charged. `/wastage` links here and now NAMES the current Monitor (or says nobody is named and what
> that costs); the `/settings` hub carries a card.
>
> ⭐ **The screen is not a bare person-picker.** It shows the unresolved TRACKED wastages at that
> store with **no owner at all**, count and peso — derived on read, never stored (bible §4.2 rule 7).
> A picker with no number gives a manager no reason to care; the number is DEF-206's harm, stated.
>
> ⚠️ **And it says plainly that naming a Monitor does NOT retro-own what is already open.** An
> allocation is an attribution, and back-filling one would assert a decision nobody made — so the
> count deliberately does not drop when you save, and a number that stubbornly does not move reads
> as a broken button unless the screen says why. Test 8 pins this.
>
> ⚠️ **Store scope is deliberately NOT required of the Monitor.** The pool is everyone active in the
> org, per `listActivePersons`' own stated reason — who money can be charged to is a WIDER pool than
> who can act in the ERP, and a scope filter would exclude exactly the people who never sign in.
>
> ⚠️ **`setWastageMonitor` lives in `stores/service.ts` as specced, but with its own capability
> constant.** That file's `const CAPABILITY = 'manage_stores'` is admin-only; this one is
> `MONITOR_CAPABILITY = 'manage_store_settings'`, stated separately so the gate cannot be copied
> from the function above by accident.
>
> ⚠️ **One rename, found in self-review:** the new store-repo read was first called
> `wastageMonitorFor`, colliding with `orderWastageRepo.wastageMonitorFor` (id-only, the hot path
> `recordOrderWastage` uses). Renamed to `wastageMonitorWithName`; T-178's read is untouched.

**Create** `apps/erp/src/app/settings/wastage-monitor/{page,actions,lib}.tsx`, or a section on the
existing `/settings` hub — ⚠️ **decide by where the person already is.** `/wastage` is the screen
that tells them the Monitor is unset, so a link from there matters more than a new route.
**Modify** `packages/domain/src/stores/service.ts` (a `setWastageMonitor` beside
`updateStoreDetails`, gated `manage_store_settings`), `packages/db/src/repo/stores.ts`,
`apps/erp/src/app/wastage/page.tsx` (its copy currently points at a screen that did not exist),
and a new integration test.
⛔ **`packages/db/src/cutover/classification.ts:71-77` clears this column at cutover and says it is
*"re-assigned at cutover"* — that sentence only becomes true when this slice ships.**

### Slice 4 — organization and store identity

**Create** `packages/db/migrations/XXXX_org_and_store_identity.sql`,
`apps/erp/src/app/settings/organization/{page,actions,lib}.tsx`.
**Modify** `packages/db/schema/{organizations,stores}.ts` *(orchestrator)*,
`packages/db/src/repo/stores.ts`, `packages/domain/src/stores/service.ts`,
`apps/erp/src/app/admin/stores/[id]/page.tsx`.

### ~~Slice 5 — order-wastage mode onto the channel~~ → **T-230**

⛔ **Moved out 2026-09-07.** See `docs/tasks/230-sales-channels-admin-and-wastage-policy.md`, which
carries the same files plus the DEF-207 admin surface they both need. Nothing in this spec's Scope,
Contract, Invariants or Tests refers to slice 5 any longer.

### ⛔ Out of bounds in every slice

`PROJECT_BIBLE.md` · `docs/ROADMAP.html` · `docs/DEFECTS-REGISTER.md` ·
`docs/decisions/CAPABILITY-MATRIX.md` · `packages/auth/src/capabilities.ts` ·
`apps/erp/src/components/nav.tsx` · anything under `ERP-rebuild` · anything T-228 owns
(`scripts/bootstrap-org.ts`, `packages/domain/src/organizations/`,
`packages/db/src/repo/organizations.ts`).

---

## Contract

### 1. `setCategoryAccount` — slice 1's whole write path

```ts
// packages/domain/src/expenses/categories.ts
export interface SetCategoryAccountInput {
  categoryId: string;
  /** ⭐ `null` CLEARS the mapping — see invariant 3. Never `undefined` for "leave alone". */
  accountCode: string | null;
}

export async function setCategoryAccount(
  tx: Tx,
  actor: Actor,
  input: SetCategoryAccountInput,
): Promise<void>;

/** The picker's read, with the mapped account's name resolved for display. */
export async function listCategoriesWithAccounts(
  tx: Tx,
  actor: Actor,
): Promise<readonly CategoryWithAccount[]>;

export interface CategoryWithAccount {
  readonly id: string;
  readonly group: 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';
  readonly category: string;
  readonly accountCode: string | null;
  readonly accountName: string | null;
  /** ⭐ Derived, never stored — how many DRAFT expenses are stuck behind an unmapped category. */
  readonly blockedDraftCount: number;
}
```

`setCategoryAccount` does exactly four things, in this order:

1. `await authorize(tx, actor, 'manage_chart_of_accounts', {})` — org-scoped, so no `storeId`.
2. Load the category by `(id, actor.orgId)`; a miss throws, so one org cannot address another's row.
3. When `accountCode` is non-null: resolve it in **`accounts`** for this org (`packages/db/schema/
   accounts.ts:31-79` — the table is `accounts`, not `chart_of_accounts`) and **refuse a
   non-existent code, one with `is_postable = false`, and one whose `status` is not `'active'`**
   (invariant 2).
4. `expensesRepo.setCategoryAccount(tx, orgId, categoryId, accountCode)` and stamp `updated_at`.

⛔ **No `create`, no `delete`, no `is_active` in slice 1.** Creating needs the normalised unique
index that does not exist yet (invariant 5), and deactivating needs a column that does not exist
yet. Both are slice 2, and pretending otherwise is how the duplicate-Rent defect reopens.

### 2. `expensesRepo.setCategoryAccount` — the repo half

```ts
// packages/db/src/repo/expenses.ts
export async function setCategoryAccount(
  tx: Tx,
  orgId: string,
  categoryId: string,
  accountCode: string | null,
): Promise<void>;
```

One `update … where id = $1 and org_id = $2`, setting `account_code` and `updated_at = now()`.
**No business rule here** — the repo does not decide what a valid account is.

### 3. `/settings` — the hub

Server component, no client JS. A card grid on `/settings/attendance`'s exact styling, one card per
destination, each carrying a **title and a one-sentence description of what changes there** —
§1.2c's familiar-but-upgraded, duplicating what makes v1's hub navigable
(`ERP-rebuild/src/app/manager/settings/page.tsx:21-88`) and not its shadcn `Card`.

| Card | Href | Description |
|---|---|---|
| Expense categories | `/settings/expense-categories` | *"Which account each kind of spend posts to. A category with no account mapped blocks posting rather than guessing."* |
| Attendance & payroll | `/settings/attendance` | existing screen, unchanged |
| Store positions | `/staff` | ⭐ a **cross-link**, not a screen — discovery §2.5 |
| Stores | `/admin/stores` | cross-link |
| Expense budgets | `/budgets` | cross-link (T-215) |

⚠️ **Every card is a plain `<Link>` and the grid wraps.** DEF-199 measured 24 of 66 routes
scrolling sideways at 390 px; a card grid with a `min-w` is how a 25th arrives. Phone portrait is
the canvas.

### 4. `/settings/expense-categories` — the screen

One table, grouped by `group`, ordered `category`. Columns: category · group · account (code +
name) · **blocked drafts** · a one-field form per row.

⭐ **Unmapped rows sort first and are visually marked**, because they are the only actionable state
on the page and `expenseCategoryUnpostable` is already telling somebody about them
(`packages/db/src/repo/findings.ts:1538-1571`).

⭐ **The blocked-draft count is derived on read**, one grouped query, never a stored counter —
bible §4.2 rule 7 (§13 row 173: *"a separately-accumulated counter is forbidden even when it is
called a cache"*).

Account choice is a `<select>` over **`accounts` rows with `is_postable = true` and
`status = 'active'` only**, plus an explicit
`— none (blocks posting) —` option that submits `null`. ⛔ **The blank option is a real choice, not
an empty string**: `Number('')` is `0` and `''` is not `null` — DEF-087's failure shape, which T-201
§2.3 already had to guard once on this same house-style form.

### 5. Slice 2 DDL — stated now so slice 1's shape is honest about what it defers

```sql
-- 1. Bible §4.4 rule 3, the rule the shipped index does not implement (discovery §8.1).
--    ⚠️ Drizzle's builder cannot express this; hand-added in the migration, exactly as
--    packages/db/schema/employment.ts:130-135 already documents for `positions`.
drop index "expense_categories_org_id_category_unique";
create unique index "expense_categories_org_id_category_unique"
  on "expense_categories" ("org_id", lower(trim("category")));

-- 2. Bible §4.4 rule 2 — seeded rows may be deactivated, never deleted.
alter table "expense_categories"
  add column "is_system" boolean not null default false,
  add column "is_active" boolean not null default true;

-- 3. Backfill: everything that exists today came from the seed.
update "expense_categories" set "is_system" = true;

-- 4. Discovery §1.6's verdict — always NULL on all 38 seeded rows, and v1's second free-text
--    level is what produced its 8 catch-alls. ⚠️ Gated on open question 2.
alter table "expense_categories" drop column "sub_category";
```

⚠️ **`seedExpenseCategories` must set `is_system = true` in the same slice**, or the next org
created by T-228 gets 38 unprotected rows and the flag means nothing.
⚠️ **The migration's `when` must track its `idx`** in `migrations/meta/_journal.json` — a reserved
number block must reserve timestamps too, or Drizzle silently skips one.

---

## Invariants

1. **The gate is inside the domain function, never in the action.** `setCategoryAccount` calls
   `authorize` itself; `actions.ts` does not re-check. — bible §2 rule 7, and
   `apps/erp/src/app/settings/attendance/actions.ts:6-9` states the reason: *"A gate here would
   protect only this one caller, and the screen would be one new form away from a hole."*
2. **An account may be mapped only if `accounts.is_postable = true` and
   `accounts.status = 'active'`.** — bible §16.9: only leaf accounts are postable, and `reserved`
   is *"No"* in the postable, picker and report columns alike. Mapping a category to a parent or a
   reserved account makes a picker entry that blocks at posting time for a reason the person who
   mapped it cannot see. ⚠️ `is_postable` is the column; "leaf" is enforced separately by the
   trigger named in `packages/db/schema/accounts.ts:76-79`, and this task must not re-implement it.
3. ⭐ **Clearing a mapping is allowed and must stay allowed.** `account_code` is nullable **on
   purpose** — `packages/db/schema/expenses.ts:66-68`: *"a category with no account mapped blocks
   posting rather than defaulting to 6900 (invariant 7)."* A screen that could only ever *set* a
   mapping would make a wrong mapping unremovable, and a wrong account posts silently where an
   absent one refuses loudly (`packages/domain/src/expenses/routing.ts:263-268`).
4. **Never falls back to `6900`.** Nothing in this task may introduce a default account —
   `routing.ts:267`, *"cannot post (never falls back to 6900)"*, and discovery 23 §2 is the
   standing example of what a silent fallback costs (`posSalesChannelId`'s `"dine"` substring
   match: *"the day simply reports less money"*).
5. ⛔ **No category may be created until the normalised unique index exists.** — bible §4.4 rule 3:
   *"A UNIQUE constraint on normalised identity… This is the actual fix."* The shipped index is
   `(org_id, category)`, case- and whitespace-sensitive (discovery §8.1), so `Rent` and `rent ` both
   insert. **This is why creation is slice 2 and not slice 1.**
6. **Seeded rows are deactivated, never deleted, and their identity is stable forever.** — bible
   §4.4 rule 2. Slice 2.
7. **One writer per row class.** The seed owns system rows; the screen owns user rows; neither
   writes the other's. — bible §4.4 rule 5 / §4.2 rule 8.
8. **The blocked-draft count is computed on read.** — bible §4.2 rule 7 (§13 row 173).
9. **A TIN is not a compliance feature.** Slice 3 only. — bible §13 row 75: this is a *management
   ledger*, **not** a statutory filing basis; nothing may be labelled or exported as BIR-ready.

---

## Tests — written before the implementation, and each must fail for the right reason first

Runner: `node C:\Users\ianla\.claude\skills\orchestrator\tools\it.mjs shareat_test_t229 <files>`.
⛔ **Never `npm run test:integration`** — it truncates a database shared with other lanes.

### Slice 1 — `packages/domain/tests/integration/expense-categories-admin.test.ts`

| # | Case | Proves |
|---|---|---|
| 1 | An **admin** maps `6200` onto a category whose `account_code` is `null`; re-read shows `6200` | The happy path |
| 2 | A **manager** is refused with `AuthorizationError`; a **staff** actor likewise | Invariant 1 — the ✗ is exercised, per CAPABILITY-MATRIX rule 1 (*"a capability with no denial test is a checkbox, not a control"*) |
| 3 | Mapping `null` onto a mapped category **succeeds**, and the row reads `null` after | Invariant 3 — the clear path, the one a "set-only" screen would lose |
| 4 | Mapping a code that is not in `accounts` for this org is refused | Invariant 2 |
| 5 | Mapping an account with `is_postable = false` is refused; mapping one with `status = 'reserved'` is refused | Invariant 2, both halves |
| 6 | A category id belonging to **another org** is refused (not silently no-op) | Cross-org isolation |
| 7 | ⭐ **The round trip.** Seed a category with `account_code = null` + a draft expense on it dated 4 days ago → `findingsRepo.expenseCategoryUnpostable` returns one row → `setCategoryAccount` → the detector returns **zero** | ⛔ **DEF-193 itself.** This is the only test that proves the remedy is a remedy; the other six prove the function |
| 8 | `listCategoriesWithAccounts` returns `blockedDraftCount = 2` for a category with two stuck drafts and `0` for a mapped one | Invariant 8, and the number on the screen |

⭐ **Test 7 is the one to write first and watch fail.** Seed the guard with a live failure — a
green first run has proved nothing (T-220's lesson, quoted in CAPABILITY-GAPS' own sweep note).

### Slice 1 — smoketest on 9008, dev server running (bible §9.4)

1. `/settings` renders, every card links somewhere real, and **the page does not scroll sideways at
   390 px** (`document.documentElement.scrollWidth − clientWidth === 0`) — DEF-199's measurement.
2. `/settings/expense-categories` lists all 38 with their accounts; unmapped rows sort first.
3. Clear one mapping → the row moves to the top and shows the blocked-draft count.
4. Re-map it → the banner confirms and `/findings` no longer carries that row.
5. Sign in as a manager: the nav still shows Settings (hiding a link is presentation), and
   submitting the form is **refused by the server** with a readable message, not a stack trace.

### Slice 2 (stated now, written then)

Duplicate-by-case (`Rent` vs `rent `) is refused **by the database** with an error naming the
existing row · a `is_system` row cannot be deleted · deactivating one keeps it readable on posted
history · `seedExpenseCategories` re-run changes zero rows and sets `is_system` on new ones.

---

## Out of scope

| Not done | Why |
|---|---|
| ⛔ **The salary-advance ceiling** <!-- STALE-IF-EXISTS: apps/erp/src/app/settings/salary-advance --> | Discovery §4.6. The screen half is one input; the **enforcement** half is four domain call sites (`cash-requests:31`, `wastage/orders:44`, `commissary/discrepancy:34`, `owners:26`) each needing its own refusal test and its own answer to *"a real till shortage would breach the cap — refuse the shortage, or record it and flag it?"*. ⛔ **Shipping the input alone is DEF-052's exact shape** — a control that enforces nothing. Recommended as its own task; `/settings` names it as a known gap in the meantime, the way `/expenses/recurring` names its missing job |
| ⛔ **A dedicated positions screen** <!-- STALE-IF-EXISTS: apps/erp/src/app/settings/positions --> | Discovery §2.5. `upsertStorePosition` is already wired to a form on `/staff` (`page.tsx:128-157`). What is missing is **retire** and **rename**, two functions on that panel — and moving positions to `/settings` would be reinventing *towards* v1's layout, which §1.2c forbids. The hub cross-links instead |
| ⛔ **A `wastage_reasons` table or screen** | Discovery §3.1's verdict: **keep the constant.** The list's value is that it is closed — `wastage-reasons.ts:5-7` states v1's own reason. Adding an eleventh is a deploy, at an observed cadence of never |
| **The xlsx category importer** | Discovery §7 (what we are NOT adopting). 84 rows arriving unreviewed is what made v1's list unauditable |
| **Per-store category visibility** (`storeActiveMap`) | Measured unused — 0 override keys across 5 sampled stores (discovery 08 §1.2) |
| **`audit_log` writes for settings changes** | `audit_log` has **zero writers and zero readers** (DEF-169). Every table here already carries `updated_at`; adding a consumer to a table nobody reads is not an audit trail |
| **A generic settings framework** | Four forms, four different shapes. Write the four forms |
| **`docs/ops/**`, deployment, arming any timer** | Owned by Ian and the orchestrator (DEF-194, T-215's scope conflict). Nothing here is scheduled |

---

## Open questions — for Ian

1. ⭐ **Who may edit an expense category — admin only, or a manager too?**
   Specced as **`manage_chart_of_accounts`** (org, admin ✅, manager ✗), matching v1's own gate
   (every mutation in `expense-entry.actions.ts` is `ctx.isAdmin`) and the matrix's stated reason
   for that row (*"the technical residue"*). ⚠️ **The cost is real:** a franchise manager who needs
   a fortieth category files a request. The alternative is a new `manage_expense_categories` row —
   ⛔ but splitting *create* from *map* across two capabilities lets a manager create a category
   they cannot make postable, which manufactures DEF-193's condition deliberately. **If managers
   should hold it, the whole screen moves, not half of it.**
2. **Retire `expense_categories.sub_category`?** NULL on all 38 seeded rows, read by nothing, and
   v1's second free-text level is what produced its 8 catch-alls (discovery 08 §5.5).
   **Recommended: drop it in slice 2.** Reversing later is a migration, so it is asked rather than
   assumed.
3. ✅ **ANSWERED by Ian, 2026-09-07 — bible §13 row 180. No: the sales channel carries the mode and
   the recorder no longer picks it.** Built in **T-230**, not here. The original text stands below
   as the record of what was asked.

   ⚠️ **Should the person recording an order wastage still choose tracked vs instant?**
   Today they do (`apps/erp/src/app/wastage/page.tsx:133-136`), which means a staffer can select
   `instant` + `absorbed` and skip the monitor, the 48-hour dispute window and the 15-day
   auto-charge backstop on their own wastage. v1 made it a **store policy** for that reason.
   **Recommended: move it onto the sales channel and stop asking** (slice 4). ⛔ This removes a
   choice people have today, so §1.2 says ask.
4. **Salary-advance ceiling — its own task, or forced into this one?** Recommendation and reasoning
   in Out of scope. **A number nothing enforces is worse than no number.**
5. **Which capability governs the organization's legal identity (slice 3)?** Nearest existing row
   is `manage_chart_of_accounts` (org, admin-only) — right bar, odd name. The alternative is one new
   `manage_organization` row. ⚠️ **Also a lane-sequencing question**, since T-228 is building
   against `organizations` right now (discovery §9).

---

## Done when

**Slice 1** — all of it, per bible §9:

- [x] `/settings` renders a hub; `/settings/expense-categories` lists all 38 categories with their
      accounts, unmapped first, with a derived blocked-draft count
- [x] `setCategoryAccount` maps and **clears**, gated on `manage_chart_of_accounts`, refusing a
      manager, a staff member, another org's row, a non-existent code, a parent and a `reserved`
      account
- [x] **8 integration tests pass against real Postgres** (`shareat_test_t229`), test 7 having been
      watched to fail on the live DEF-193 condition before the implementation existed
- [x] typecheck clean · `npm test` **1058 passed / 0 failed / 1 skipped, 64 of 64 files** — green
      only after the hub's hrefs were made LITERAL at the call site. ⚠️ **A mapped
      `<a href={card.href}>` over a CARDS array is invisible to
      `tests/unit/nav-route-reachability.test.ts`**, whose `LINK` regex trusts only a literal, on
      purpose (*"a bare string that happens to look like a path is not a link"*). The runtime links
      worked; the guard was right by its own contract, and the URL smoketest could never have caught
      it. Recorded in the page's own header so nobody tidies it back into a data table
- [x] **smoketested on 9008** — `/settings` and `/settings/expense-categories` both measure
      `scrollWidth − clientWidth = 0px` at 390×844; clear → re-map round trip with correct banners
      and the row moving to the top; header account `6000` absent from the picker; a **manager is
      refused at the write** with a readable message and the row unchanged. Hub links re-verified by
      CLICKING after the refactor, not by typing URLs
- [x] `npm run build` succeeds **with the dev server stopped** — exit 0, all three `/settings*`
      routes emitted
- [ ] self-reviewed line by line; committed with a message saying *why*
- [ ] ⛔ **`docs/DEFECTS-REGISTER.md` DEF-193's Disposition updated to `✅ Corrected`** — by the
      orchestrator, not this lane
- [ ] ⛔ **Discovery §8's seven findings filed** — by the orchestrator. Two of them
      (§8.5 `wastage_monitor_person_id` has zero writers while a screen tells users to set it;
      §8.6 `sales_channels` has no production writer while store readiness **blocks** on it) are
      larger than three of this task's five items and want a decision, not a register row alone

**Slices 2 and 4** — each: migration generated and applied to **both** databases and recorded, its
own integration tests, its own smoketest, its own `Done when`, written when it starts.
**Slice 3** needs no migration. **Slice 5 is T-230's** and has its own `Done when` there.
