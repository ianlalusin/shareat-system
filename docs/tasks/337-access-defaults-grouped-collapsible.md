**Status:** SPECCED 2026-09-24 by a planner subagent, revised for the auditor's 6 findings, APPROVED by the orchestrator. NOT BUILT. Runs after T-336.

# T-337: group /admin/access-defaults by business area, with every group collapsible

**Ian, verbatim:** *"admin/access-defaults? group the access like sales, inventory, customer, attendance
etc. keep the store and org scope groupings make every grouping collapsible"*
**Migration slot:** ⛔ **none.** No schema, no data. Report any need for one as BLOCKED.
**Model:** Sonnet builds. §6's screenshots go to Ian; they decide what §3–§4 only nominate.

> ⛔ **NOTHING ABOUT WHAT IS GRANTED CHANGES.** Same four actions, same forms, same hidden fields,
> same values, same count of forms. This task moves rows into groups. §5 proves it.

---

## 1. The taxonomy — one source of truth, in `packages/auth/src/capabilities.ts`

Measured 2026-09-24: `CAPABILITIES` = 96; `OFFERABLE_TO_POSITIONS` = 91 (`packages/domain/src/people/position-defaults.ts:50-55`).
**No area exists anywhere today** (grep `CAPABILITY_AREA|CapabilityArea`: 0 hits). The grid groups by
`CAPABILITY_SCOPE` only (`admin/access-defaults/lib.ts:77-86`) and renders 76 store rows + 15 org rows flat.

Add, directly below `CAPABILITY_SCOPE` and built the same way:
```ts
export const CAPABILITY_AREAS = ['sales','expenses','inventory','production','commissary','suppliers',
  'customers','staff','books','admin','franchise'] as const;          // display order
export type CapabilityArea = (typeof CAPABILITY_AREAS)[number];
export const CAPABILITY_AREA_LABEL: Readonly<Record<CapabilityArea, string>> = { … };  // table below
export const CAPABILITY_AREA: Readonly<Record<Capability, CapabilityArea>> = { … };    // all 96
```
- ⭐ **The exhaustiveness guard is the type, exactly as for `CAPABILITY_SCOPE`** (file header `:6-17`): a
  capability with no area fails to compile; a key that is not a `Capability` fails the object literal's
  excess-property check, so no capability can be invented here. Keyed on **all 96**, not the 91, so the
  guard needs no filter and a future capability cannot slip past it by being non-offerable.
- Re-export all four from `packages/auth/src/index.ts` (`:7-14`); a lost re-export is T-290's bug.
- ⛔ **Presentation only.** `authorize()` never reads it (U3). `CAPABILITY-MATRIX.md` is not edited: its
  parser test compares role cells, and an area is not an access decision.
- Why `auth` and not the page: the scope map already lives there, T-336 does not touch `packages/auth`,
  and a second screen (`admin/users`' `GrantPicker`) can reuse it. Why not `docs/…MATRIX.md` sections:
  those put customer returns under Inventory and have no Customers or Attendance heading.

| Area (label) | Members, in `CAPABILITIES` order | All | Offered: store / org |
|---|---|:-:|:-:|
| `sales` Sales & cash | record_sale, submit_sales_day, verify_sales_day, void_sales_day, record_statutory_discount, void_statutory_discount, accept_remittance, record_till_count, resolve_till_variance, transfer_funds, record_order_wastage, resolve_order_wastage, charge_staff_for_wastage, reverse_auto_charge | 14 | 14 / 0 |
| `expenses` Expenses | create_expense, edit_own_expense, edit_any_expense, void_expense, approve_expense, manage_expense_budgets, manage_recurring_expenses | 7 | 7 / 0 |
| `inventory` Inventory | record_stock_movement, adjust_inventory, record_wastage, charge_staff_for_discrepancy, transfer_stock, void_transfer, manage_locations, post_usage, void_usage_record, open_count_session, commit_count, manage_items, approve_item | 13 | 11 / 1 |
| `production` Production & POS usage | post_production, edit_posted_production, void_production, manage_pos_map, request_pos_map, decide_pos_map_request, finalize_pos_usage_pull | 7 | 7 / 0 |
| `commissary` Commissary orders | confirm_receipt, resolve_trade_discrepancy, set_item_threshold, post_order_message, place_branch_order, fulfil_branch_order, dispatch_branch_order, manage_commissary_offerings, manage_commissary_map | 9 | 9 / 0 |
| `suppliers` Suppliers & receiving | record_supplier_return, void_supplier_return, apply_supplier_credit, receive_delivery, allow_over_receipt, approve_supplier, record_ap_payment, record_supplier_invoice, verify_supplier_invoice, void_supplier_invoice | 10 | 9 / 1 |
| `customers` Customers & wholesale | record_customer_return, void_customer_return, apply_customer_credit, refund_customer, approve_buyer, set_credit_limit, override_credit_limit, record_ar_collection, write_off_receivable, create_wholesale_order, dispatch_wholesale_order | 11 | 10 / 1 |
| `staff` Staff, attendance & payroll | enrol_staff, manage_attendance, set_pay_rate, run_payroll, provision_clock_terminal | 5 | 5 / 0 |
| `books` Books & reporting | run_cutover, view_financial_reports, view_trial_balance, reverse_entry, close_period, override_period_lock, post_journal_entry, manage_fixed_assets, run_depreciation, manage_prepaid_items, run_amortisation, manage_chart_of_accounts | 12 | 2 / 8 |
| `admin` Administration & settings | manage_users, manage_stores, grant_capability, manage_store_settings, set_cash_policy, manage_price_lists | 6 | 2 / 4 |
| `franchise` Franchisor (super-admin) | cross_org_access, view_franchise_sales | 2 | 0 / 0 |
| | **Total** | **96** | **76 / 15 = 91** |

**Evidence for the calls that are not obvious:** order wastage sits with sales (the nav's `Daily` group,
`components/nav.tsx:29-45`; DEF-413's till column T7). `confirm_receipt` and `set_item_threshold` follow
the commissary order they belong to (T-173; DEF-413 O4). Customer returns and credit leave Inventory for
Customers, which is Ian's word. Payroll joins attendance because both are the `/attendance`–`/payroll`
people surfaces. **Aligned with `PROPOSAL-DEF-413…md:52-79`:** Till ⊂ Sales & cash + Expenses; Ordering ⊂
Commissary orders; Floor F1–F3 ⊂ Inventory. Differs: R3 `confirm_receipt` → Commissary, R5/R6 → Customers,
F4 `request_pos_map` → Production & POS usage. ⚠️ An area's membership is a planner call Ian may move by
one line; its exhaustiveness is not. ⚠️ The area for the two platform-scoped capabilities is
`franchise`, **not** `platform`, so an AREA can never be read as the `platform` SCOPE (`SCOPE_ORDER`).

## 2. Nesting: scope OUTSIDE, area INSIDE

Store-scoped ▸ {Sales & cash, Expenses, Inventory, …} and Org-scoped ▸ {Inventory, Suppliers, Customers,
Books, Administration}. Why this way round: (a) Ian said *keep* the scope groupings, which reads as the
existing top level; (b) the scope note (`SCOPE_NOTE`, `lib.ts:44-48`) is said once per scope, not once per
area; (c) `SCOPE_ORDER` and its tests (`apps/erp/tests/access-defaults-lib.test.ts:34-66`) survive unchanged.
Cost, accepted and shown on screen (§6): three org areas hold ONE row each. Empty areas are omitted, and
the `platform` scope group stays in the data and unrendered, as today.

`gridCapabilityGroups()` returns `GridScopeGroup { scope, note, areas: GridAreaGroup[] }` with
`GridAreaGroup { area, label, capabilities: GridCapability[] }`. `capabilities` moves from the scope group
to the area group (one representation, no flat copy to drift). Within an area, `CAPABILITIES` order.

## 3. Collapsible: native `<details>`/`<summary>` everywhere; no client component

Works with JS off, keyboard-operable (Tab, Enter/Space) with no ARIA to maintain, and the mobile layout
already uses it (`page.tsx:362`). The page stays a pure server component.
- ⚠️ **`<details>` cannot live inside a `<table>`**, so the desktop grid becomes: one header table (the
  current `<thead>`, Retire forms included, rendered **once**), then per group a `<details>` holding its own
  `<table>`. Every table is `table-fixed` with **one shared `<colgroup>` component**, so columns align, and
  each area table repeats the position names as a plain-text header row (no Retire form; an expanded area
  stays readable when the ones above are collapsed). **All of it sits inside ONE `overflow-x-auto`
  wrapper**, so the tables scroll together below 640px. Alignment needs EXPLICIT widths, or `table-fixed`
  sizes each table from its own first row: every table carries `w-full min-w-[640px] table-fixed`; the
  shared `<colgroup>` fixes the capability `<col>` at `w-64` and leaves position `<col>`s unset, which
  `table-fixed` splits equally from the same remaining width in every table.
- **The header table sits ABOVE the groups and stays visible when every group is collapsed.** That is
  expected, not a defect: it carries the position names, holder counts and the Retire forms exactly once.
- Mobile: per-position `<details>` (unchanged, first open) ▸ scope `<details>` ▸ area `<details>`.
- **Defaults:** scope groups `open`; area groups **closed**. A collapsed page is the overview: two scope
  headers and ~15 area lines with counts.
- **Persistence: none.** No cookie, no storage, no URL parameter. ⛔ A URL parameter would have to ride
  in every toggle form, which changes the form set §5 freezes. The DOM keeps a user-opened group across
  a toggle's redirect **only if React reconciles rather than remounts** — S5 must SEE it. If S5 fails,
  STOP and report; do not add persistence.
- **Counts** (pure `areaOnCount(capabilities, activeSet)` in `lib.ts`; "on" = the cell renders `On` or
  `On (role)`). Mobile area summary: `Sales & cash · 7/14 on`. Desktop area summary: `Sales & cash · 14`
  and a second line `On: Cashier 7 · Cook 0 · …` in column order. That line MAY wrap, to at most **two
  lines at 1280px** with the six canonical positions plus one store-invented; wrapping breaks only
  between positions (each `Name N` is `whitespace-nowrap`), never inside one. More than two lines at
  1280 is an S1-class finding: report it, do not truncate or abbreviate. Scope summary: label, row count, note.
  ⚠️ Word is **on**, never "granted": a default is not a grant (`person_grants` is), and the buttons say On.

## 4. Styling rules

New markup (the `<details>`, `<summary>`, count lines) uses tokens only: `bg-surface`,
`border-surface-border`, `text-ink` (ADR-013; `components/ui` has no disclosure primitive and `Card`
renders a `div`, so neither is adopted). ⛔ Add **zero** `dark:` classes: T-334 slice 3 tracks a `dark:`
baseline (`334-slice-3…md:236`). Removing the old scope header row's `dark:` pairs is fine; the count in
the access-defaults files may fall, never rise. ⛔ **`INPUT` and `LINK_BTN` are untouched**. They belong to
T-334 slice 3, which names this file (`:281`). If a slice-3 tranche is open on `page.tsx`, serialise
behind it. The native summary marker stays; S3 decides whether it reads in dark.

## 5. Proving nothing about WHAT is granted changed — and TWO commits

⭐ **Commit 1, pure extraction:** move `DesktopGrid`, `MobileSections`, `ToggleButton`, `InheritedBadge`
byte-for-byte into `grid.tsx`, change no markup, write R2 and see it GREEN there. **Commit 2, the regroup**
(§1–§4), with R2 unchanged and still green. R2 cannot render the components while they live inside
`page.tsx`, so without commit 1 its "before" run is not genuine. Commit 1's diff: `grid.tsx`, `page.tsx`
(imports only), the R2 test. Nothing else.

The toggle forms are the grant surface (`page.tsx:217-221`: `storeId`, `positionId`, `capability`, `on`).
- **R2, the oracle.** Render `DesktopGrid` and `MobileSections` separately with a fixture (2 canonical + 1
  store-invented position, some active defaults). Parse every `<form>` to a record of its hidden
  `name=value` pairs, then compare the multiset to an **independently built** expectation. Per layout,
  exactly one toggle per (position × each of the 91), with `on` = the negation of active, plus one Retire
  per store-invented position. ⭐ **R2 is green at commit 1 (unchanged markup) before commit 2 begins.**
  It is a preservation test, and a pass before the regroup is what makes a pass after it evidence.
  NEGATIVE: mutation-test it by duplicating one capability into two areas, then by dropping one area. Both must fail.
- **S-forms, in the real app (§6):** in the browser,
  `JSON.stringify([...document.forms].map(f=>[...new FormData(f)]).sort())` before vs after, same store,
  same DB. Must be byte-identical.
- `actions.ts` is not in the diff.

## 6. On screen, both themes (Ian's standing rule: rendering decides; `334-slice-3…md:285-292`)

App on 9008, smoke DB, same store, same data, before = HEAD before T-337. Theme is set by cookie
`shareat_theme=light|dark` (`components/shell/theme-state.ts:27`). Files named
`t337-<view>-<theme>-{before,after}.png` and **kept**, never overwritten (the slice-3 lesson, `:196-203`).

| View | Light + dark | What the tester compares |
|---|---|---|
| V1 desktop 1280, default | before + after | after is the overview: every area collapsed, counts visible |
| V2 desktop, Sales & cash + org Books expanded | after | **S1** position columns align across header table and both area tables (`getBoundingClientRect().left` of each `th`, within 1px), at 1280 and at 640. ⛔ **If S1 fails: STOP and report, with the V2 screenshots and the measured offsets.** No improvised fallback (no CSS grid, no single table, no client component). The planner re-decides |
| V3 desktop, every group expanded | after vs V1-before | **S2** 91 capability rows, same set as before (read row text) |
| V4 desktop, store scope collapsed | after | the org scope and its summary still read |
| V5 mobile 390, Cashier open + one area open | before + after | three nesting levels legible; no horizontal page scroll |
| V6 org Inventory (one-row area) | after | the singleton cost from §2, shown to Ian as-is |

Plus: **S3** summary text and marker are readable in dark. **S4** Tab to a summary; Enter and Space toggle
it; the focus ring is visible in both themes. **S5** expand Inventory, toggle one cell, and after the redirect
Inventory is still open. **S6** with JS disabled, groups still open and close. **S7** each area's desktop
count equals the `On` buttons in that expanded area for two positions. **S-forms** (§5).

## 7. Tests: every one has a negative half

Class assertions split `class="…"` on whitespace and test token membership (never `toContain` on a
substring). Boolean `open` is read from the parsed opening tag, and its absent case is asserted too.
`.test.ts` + `createElement` + `renderToStaticMarkup`, as in `apps/erp/tests/filter-row.test.ts:1-8`
(a `.test.tsx` matches no glob). `vi.mock` `actions.ts` if importing it touches the database.

| # | Positive | NEGATIVE |
|---|---|---|
| U1 | keys of `CAPABILITY_AREA` set-equal `CAPABILITIES`; every `CAPABILITY_AREAS` member used ≥1 | mutation: deleting one entry and adding `bogus_cap` each fail **typecheck** (record both in READY) |
| U2 | a **literal** per-area table typed out from §1 in the test (do not import to build it), sorted, `toEqual` the grouping | the literal table is itself a partition (no id in two areas); the non-offered five still carry an area (`approve_item`→inventory, `close_period`/`post_journal_entry`→books, two→franchise) |
| U3 | `authorize.ts`, with comments stripped, has 0 `CAPABILITY_AREA` tokens; floor: the scan read >0 bytes | the same scan run on `capabilities.ts` finds ≥1 (proves the scan can see a hit) |
| L1 | `gridCapabilityGroups`: scope order kept; per scope, area order ⊂ `CAPABILITY_AREAS` order; the 91 exactly once; store 76 / org 15 | no empty area; org has no `sales` area; the excluded five absent; the `platform` SCOPE has 0 areas; no scope contains the `franchise` AREA |
| L2 | `areaOnCount`: 0/n, n/n and partial cases | a capability active but outside the area is not counted |
| R1 | one `<details>` per scope, per area and per mobile position; `<summary>` is the first child; scope tags carry `open` | area tags have NO `open` attribute; new elements carry no `dark:` token and no `neutral-*` token |
| R2 | §5 oracle | §5 mutations |
| R3 | desktop: exactly one Retire form per store-invented position; every table in the grid has the same `<colgroup>` | area tables have no Retire form |

Update `apps/erp/tests/access-defaults-lib.test.ts` only where it flattens `g.capabilities` (now
`g.areas.flatMap(a => a.capabilities)`); every existing assertion keeps its meaning.

## 8. Scope: exact files

| File | Change |
|---|---|
| `packages/auth/src/capabilities.ts` | §1's four exports |
| `packages/auth/src/index.ts` | re-export them |
| `apps/erp/src/app/admin/access-defaults/lib.ts` | `gridCapabilityGroups` new shape, `GridAreaGroup`, `areaOnCount` |
| `apps/erp/src/app/admin/access-defaults/grid.tsx` (new) | `DesktopGrid`, `MobileSections`, `ToggleButton`, `InheritedBadge` moved out of `page.tsx`, so R1–R3 can render them without `requirePageAccess` |
| `apps/erp/src/app/admin/access-defaults/page.tsx` | imports from `grid.tsx`; header comment `:46-53` amended for the split tables |
| `apps/erp/tests/access-defaults-lib.test.ts` | flatten fix + L1, L2 |
| `tests/unit/t337-capability-areas.test.ts` (new) | U1–U3 |
| `apps/erp/tests/t337-access-defaults-grid-render.test.ts` (new) | R1–R3 |

⛔ **Do not touch:** `actions.ts`, `authorize.ts`, `CAPABILITY_MATRIX`, `CAPABILITY_SCOPE`, `CAPABILITIES`
order, `OFFERABLE_TO_POSITIONS`, `CAPABILITY-MATRIX.md`, T-336's files, `INPUT`/`LINK_BTN`, `components/ui/*`,
the bible. Capability rows keep their `font-mono` ids. Human labels are a separate task.

**Done when:** commit 1 lands with R2 green; commit 2 lands with U1–U3, L1–L2 and R1–R3 green, R1/L1
seen failing first against commit 1. Typecheck, unit and the FULL integration suite pass (DEF-412). `npm run build` passes with the dev
server stopped. §6's files exist, have been looked at, and S1–S7 and S-forms are reported with numbers.

## 9. Not verified by this planner

- That React keeps a user-opened `<details>` across the toggle's `redirect()` (`actions.ts:63`). S5 decides.
- That `table-fixed` + explicit `<colgroup>` widths aligns sibling tables in the real CSS. S1 decides; its failure branch is STOP.
- How Tailwind preflight renders the `<summary>` marker in dark, and whether three mobile levels read well.
- Whether a T-334 slice-3 `BTN` tranche is scheduled on `page.tsx` in the same window. The orchestrator checks.

**Orchestrator, 2026-09-24:** `admin/access-defaults/page.tsx` is one of slice 3's select-only
files (an R8 geometry bump only). No tranche of slice 3 may touch it until T-337 lands; that
tranche then applies R8 to the post-T-337 file.
