# T-502 — Expense item catalog (one item list for everything bought)

**Status:** SPEC (Opus, 31 Oct 2026). S0 (v1 export script) built on this branch. S1–S5 not started.
**Owner:** orchestrator. **Migration:** 0224 (board). **Lanes:** Sonnet tester → Sonnet builder → Sonnet auditor.

## 1. Why (Ian, 31 Oct)

> "something like a catalog of items … each item has an ID and a category/sub-category like v1, so cost drivers are
> visible … two cashiers never record the same item under different names (chili / sili / siling pula)."

Ian's picks: **1A** one item list for everything bought (food, supplies, services) · **2A** any admin approves a new
item (was: super-admin only, Ian 2026-08-28 — this is a deliberate change, record as a bible row) · **3A** services
(rent, power, water, internet) are items too.

Evidence (v1 export, May–Oct 2026, 7 stores, ₱15.58M): 4,078 distinct free-text particulars collapse to **258
items** covering 89% of spend; ₱950k sat in "Please Specify / OTHER"; ₱568k of food was filed as supplies; 122
particulars (₱174k) in the wrong category. Review sheets live OFF the repo in `C:\Users\ianla\v1-expense-export\catalog\`
(real purchase data — never commit them).

## 2. Verdict — build a SMALLER thing than asked, on what already exists

v2 already has most of this. Do not build a second item list.

| Need | Already in v2 | Gap |
|---|---|---|
| One item master with codes | `items` (T-145, code `CHWN-001`, kinds, units, variations T-443, merge) | no `service` kind |
| What a bill was FOR | `supplier_invoice_lines.item_id` (T-145/T-147), filled on the invoice page before verify | **optional** — nothing makes a store itemise |
| Ask for a new item, someone approves | `item_requests` + trigram similar-name warning | approver is super-admin only (2A changes it) |
| Category | `expense_categories` (group + category, admin-managed T-229) | an item has no default category |
| Same item, different spellings | — | **no aliases**: the picker only matches the official name |
| Cost drivers | income statement by account; budgets by category | **no report by category → item** |

**v1's sub-category is NOT brought back.** It was dropped on purpose (0134: v1's free-text second level is what made
its 8 catch-all buckets — "Please Specify" alone held ₱950k). In v2 **the item IS the sub-category**: v1's
"COGS / Sides / Lettuce" is category *Sides* + item *Lettuce*. The report reads Group → Category → Item, which is
the drill-down Ian asked for, without a free-text level to dump into. ⚠️ Ian has not been told this in these words
yet — the orchestrator confirms it with him before S1 is built (§9 Q1).

## 3. Rulings already made (do not reopen)

- **Meat:** two kinds only, slab and sliced (existing `meat_slab` / `meat_sliced`). "Dine-in", "panda", "retail" are
  pack labels of a sliced item → model them as **variations** (`variant_of_item_id`, T-443), not new kinds or columns.
- **Butane** = a supply (fuel for the customers' table grills), not retail.
- **System-written costs** (depreciation, amortisation, Foodpanda/Grab commission and fees) are posted by the system
  through journals, never through an invoice → they get **no item** and never appear in the picker.
- **Owner car/house amortisation, insurance** → PERSONAL group (admin re-files categories on screen; no code).
- **Foodpanda/Grab period rows** (May) are not duplicates — the daily rows start 1 Jun / 8 Jun. Nothing to do in v2.
- **Nothing is loaded automatically.** Ian, 30 Oct: data is set up by an admin on screen. The 258-item draft enters
  through an import screen that an admin previews and confirms (S4), never through a script we run.

## 4. Slices

### S1 — schema (migration 0224, hand-authored per ADR-012; classify the new table in cutover + RLS registries)
1. `ITEM_KINDS` += `'service'`; label "Service". A service item: `base_unit = 'pcs'` (shown as "each" for services),
   `is_purchasable = true`, never sellable, **never stocked** — every stock/count/recipe/costing reader must exclude it
   (tester greps every `ITEM_KINDS` / `kind` reader and lists them in the red tests).
2. `items.expense_category_id uuid NULL` → `expense_categories`, with the same-org composite FK (no single-column
   org→org FK: board rule 7). NULL allowed for existing rows; **required when a request is approved** (S2).
3. New table `item_aliases (id, org_id, item_id, alias text, created_by, created_at)`; unique
   `(org_id, lower(trim(alias)))` hand-added (expression index, same pattern as `expense_categories`); same-org FKs;
   an alias may not equal any item's name in the org (trigger or domain check + constraint-messages entry). RLS by org.
4. Audit catalogue entries for alias add/remove.

### S2 — any admin approves (2A) + category on the item
- `approveItemRequest` / `rejectItemRequest`: allowed for any holder of the admin role in the org (capability, not a
  role-name check — add to CAPABILITY-MATRIX with a ✗ test for manager/cashier). Requester ≠ approver stays.
- Request form and approval form carry the expense category (required at approve for purchasable items).
- Item page: admin can set/change an item's expense category and add/remove aliases.
- Bible: new decision row — "2A, Ian 31 Oct: any admin approves items; supersedes the 2026-08-28 super-admin rule".

### S3 — the picker matches aliases, and expenses get itemised
- Invoice line item picker (`/ap/invoices/[id]`) searches name, code AND aliases; shows the official name. Typing an
  unknown word offers "Ask for a new item" (existing request flow), never free text.
- **Itemising becomes required before an expense is recorded** against an invoice: an invoice with no lines cannot be
  recorded as an expense (domain refusal + constraint message; a utility/service bill takes one line with a service
  item). ⚠️ Existing posted expenses are untouched; the rule applies to new recordings only. Tester first checks every
  current caller of the record-expense path (incl. reimbursement, recurring, POS cash-out if any) and lists which
  ones this blocks — the orchestrator rules on each before the builder starts.
- The expense form pre-fills the category from the lines' items when they all share one category; when they don't,
  it shows which lines differ (warning, not block — the ledger category stays the person's choice).

### S4 — import screen for the draft list (admin only)
- `/items/import`: upload a CSV (`item_name, kind, base_unit, expense_category, aliases`), preview each row as
  *new item · matches existing item · alias clashes · category not found*, then **Confirm** creates the items and
  aliases in one transaction, audited, as the admin who confirmed. Re-uploading the same file changes nothing.
- No hidden defaults: a row with an unknown category is refused in the preview, not guessed.
- The orchestrator converts Ian's reviewed `items.csv` to this shape and hands the FILE to Ian; Ian (or his admin)
  uploads it on screen.

### S5 — cost report by category → item
- `/reports/expense-items`: date range + store (or all), Group → Category → Item, ₱ and % of total, times bought,
  average unit price; drill to the invoice lines. Money from **posted** expenses only (draft/voided excluded); item
  split from the invoice lines of those expenses. Branded Money throughout (t371 guard); store scope per `authorize()`.
- A store-vs-store row per item (Ian's Max Glow question: Lipa spends 4–5× Malvar on dishwashing liquid).

## 5. Deliberately OUT

| Out | Why |
|---|---|
| Re-adding sub-category | The item is the sub-category; a free-text level is what produced ₱950k of "Please Specify" |
| Auto-loading the 258 items or re-filing v1 history | Ian 30 Oct: data is set up on screen. v1 history stays in v1 |
| Fixing v1's category tree in v1 | v1 is read-only; v2 categories are admin-managed already (T-229). `category-fixes.md` is advice for the admin |
| Items for system-posted costs | Posted through journals, not invoices |
| Fuzzy auto-merge of names | Aliases + human approval do not degrade as the list grows (items.ts `item_requests` note) |
| Stock/inventory for service items | A service is never counted |

## 6. Gates
Typecheck · touched guards (t371, t343 ratchet, t402 audit catalogue, constraint-messages count, cutover + RLS
registries, capability census, app-boundaries) · migration ⇒ **FULL integration suite on a fresh `shareat_test_*` DB**
then CI · §9.4 smoke of S3–S5 screens on port 9018 with forged sessions (admin, manager, cashier).

## 7. Order
S1 → S2 → S3 (S3's caller list ruled first) → S4 → S5. S4 and S5 may run in parallel after S3. One PR at the end
(migration ⇒ CI on the PR before merge).

## 8. Numbers
Migration 0224 · next DEF from the board (DEF-806+) · this task T-502.

## 9. Open for Ian (asked by the orchestrator, recorded here when answered)
- **Q1** v1 sub-category becomes "the item" (Group → Category → Item); no free-text sub-category. Recommended: yes.
- **Q2** `vague.csv` answers (beef cut, ulam, water…) — only change the draft list, not the build.

## 10. Orchestrator rulings after the tester's pass (31 Oct)

| # | Question | Ruling |
|---|---|---|
| R1 | Requester ≠ approver does not exist today | Build it. Refused unless the actor `holdsSuperAdminAuthority` (Ian, single-admin orgs). Plain message: "Someone else must approve an item you asked for." |
| R2 | `approve_item` also gates create/merge/rename/unit | New capability **`approve_item_request`** (admin ✅, manager ✗, cashier ✗). `approve_item` and everything it gates stay super-admin. Update capabilities.ts, the matrix + count, items.test.ts's "an ADMIN cannot approve" leg, and the "waiting for a super-admin" sentence |
| R3 | Adminless-manager fallback (row 196) | **Excluded.** The item list is org-wide; a manager never approves it. Use the existing exclusion mechanism (e.g. `ROLE_ONLY_CAPABILITIES`) and add a ✗ test for a manager in an org with no admin |
| R4 | Kind checks | Widen BOTH `items_kind_check` and `item_requests_kind_check`; `item_requests.expense_category_id` gets the same-org composite FK too |
| R5 | Alias rule one-way | Both ways: creating/renaming an item to a name an alias already holds is refused. Turn the `it.todo` into a test |
| R6 | Service shape | DB CHECKs as written (pcs, purchasable, never sellable) |
| R7 | `cogsCategoryForItemKind('service')` | Throws (a service never reaches COGS-by-kind) |
| C | Never stocked | DB trigger refusing a service item on `stock_movements`, recipe input/output, `delivery_lines`, `stock_usage_lines`; `listItems` gains a stocked-only filter used by every stock/count/recipe/commissary/delivery/trade picker. The invoice-line picker includes services. Tester extends tests to the untested pickers |
| D | Itemise-first callers | Enforce in `createExpense` and `editExpense` (not `approveExpense`). Option `requireItemised` defaults **true**; the recurring-expense job and inter-entity receipt pass `false` explicitly with a comment (system-made invoices). Follow-up (not this task): recurring templates pick a service item |

## 11. Q1 answered — sub-category KEPT, on the item (Ian, 1 Nov: "yes")

Supersedes §2's "v1's sub-category is NOT brought back" and §9 Q1. Ian asked why the item should replace the
sub-category; the answer (a middle level that GROUPS items — Meat → Pork → kasim/jowls/belly — is worth having for
reports; the v1 harm came from the cashier typing it on every expense) led to this design, which he approved:

- New table `expense_subcategories (id, org_id, category_id → expense_categories, name, is_active, created_by,
  created_at)`; unique `(org_id, category_id, lower(trim(name)))` (expression index, hand-added); same-org composite
  FKs; RLS by org; retire, never delete. **No free text, no "Please Specify"/"OTHER"/"Specify"/"Others" names**
  (refused by a CHECK on `lower(trim(name))`, plain message).
- `items.expense_subcategory_id` and `item_requests.expense_subcategory_id` nullable, same-org FKs; a trigger refuses
  a sub-category whose `category_id` differs from the row's `expense_category_id`.
- **Required at approve** when the chosen category has at least one active sub-category; optional otherwise.
- **The cashier never picks it.** Category and sub-category come from the item. Admin manages the list on the
  expense categories screen (add, rename, retire) and sets it on the item page.
- S5 report drills Group → Category → Sub-category → Item (items with no sub-category show under "(none)").
- Capability: managing sub-categories uses the same capability as managing expense categories today (T-229).

## 12. S3 revised — the expense screen follows the items; batch recording on the invoice (Ian, 1 Nov)

> Ian, 1 Nov (screenshot of /expenses/new): "align this screen with our decision on how expense can be recorded. add a
> record expense batch record on invoice page also so 1 invoice can be batched recorded in expense"

Supersedes S3's "the ledger category stays the person's choice (warning, not block)". Facts this rests on
(discovery, 1 Nov): `supplier_invoice_lines.item_id` is NOT NULL (a saved line is always an item); one invoice may
carry many expenses, capped by `apRepo.capacityOf` (remaining = invoice total − live expenses) and trigger 0176;
`expenses` has ONE `category_id`, no line link, no sub-category; payments are `expense_payments` rows.

### Rule: an expense is one CATEGORY slice of an itemised invoice
- **No lines, no expense.** `createExpense` / `editExpense` refuse an invoice with no lines (`requireItemised`,
  default true; recurring job + inter-entity receipt pass `false`, §10 D). Plain message: "List what was on this bill
  first (invoice page), then record the expense."
- **The category comes from the lines.** The invoice's lines group by their item's `expense_category_id`. An expense's
  `category_id` must be one of those groups. Lines whose item has NO category form an "Uncategorised" group: for that
  group only, the person picks the category (and the item page should be fixed — show a link "Set this item's
  category").
- **Amount ceiling per group:** an expense for category C may not exceed (lines total in C) − (live expenses on this
  invoice with category C). Domain refusal + message; the existing whole-invoice capacity trigger stays.
- **No link table.** Which lines an expense covers is derived (invoice + category), so voiding an expense frees its
  group automatically and nothing double-counts. Sub-category is NOT copied onto the expense — the S5 report reads it
  from the lines' items.
- **Particulars** stays (a note on the ledger line) but is PRE-FILLED from the group's item names
  ("Pork kasim, Pork belly"), editable, never the place the category comes from.

### Screen: /expenses/new (and edit)
Store → Supplier invoice → then, instead of a free Category select:
- invoice has no lines → panel "This bill isn't itemised yet — List what was on it" (link to /ap/invoices/[id]); save off.
- invoice has lines → a **"Which part of this bill?"** select listing each category group with its remaining amount
  ("Meat — ₱4,250.00 left"). Groups with nothing left are shown disabled. Picking one pre-fills Particulars and the
  first payment amount with the remaining amount.
- "Uncategorised" group → shows an extra Category select for that group only.
- Payments unchanged (split across sources still allowed here).
- Live "Save is off until" rules updated to the new fields.

### Invoice page: "Record expenses" batch (/ap/invoices/[id])
Shown when the invoice has lines and at least one group has something left.
- A table: one row per category group with remaining > 0 — Category · items · amount left · ☐ include (ticked).
  Uncategorised row needs its category picked or is unticked.
- **Payments for the batch may come from several sources** (Ian, 1 Nov), using the same InvoiceMoneyLines rows as
  the single screen. The payments total must EQUAL the ticked groups' total (save off until it does). The split is
  **filled in order**: the groups in table order take money from the payment rows in their listed order; a group
  takes what is left of the current source, then moves to the next. Ian's example — groups 100 and 50, payments
  80 cash then 70 GCash → group 1: 80 cash + 20 GCash; group 2: 50 GCash. Each expense gets one `expense_payments`
  row per source it drew from (so group 1 gets 2 rows, group 2 gets 1). Pure function `allocateBatchPayments(groups,
  payments)` in the domain (Money in, Money out, never floats), unit-tested, and the SAME function feeds a live
  preview under the form ("Meat ₱100.00 = Cash ₱80.00 + GCash ₱20.00").
- Submit creates one expense per ticked group, amount = that group's remaining, particulars pre-filled, **in one
  transaction** (all or none), via a new `recordInvoiceExpensesBatch` domain function that calls the same
  `createExpense` path per group (no second validation path). Audited as each `expense.drafted` plus one
  `expense.batch_recorded` (invoice id, expense ids).
- Status follows today's rule: invoice **pending** → the expenses are drafts (verify posts them, as now); invoice
  **verified** → they post immediately, as the existing "+ Record expense" does (reuse its approve path, same
  capability checks — no new permission).
- Re-submitting when every group is fully recorded does nothing (button hidden; domain refuses with "Everything on
  this bill is already recorded").
- Capability: the same capability `createExpense` checks today; store scope per `authorize()`.

### Tests (tester writes first, red)
1. no-lines invoice → createExpense refused; recurring/inter-entity path still allowed.
2. category not among the invoice's groups → refused.
3. amount over a group's remaining → refused; voiding an expense frees the group.
4. uncategorised group needs an explicit category.
5. batch: 3 groups → 3 expenses, amounts = remaining, one tx (force a failure on the 3rd → none saved).
6. batch on pending → drafts; on verified → posted (journal entries exist, one per expense).
7. batch twice → second refused / no new rows.
8. manager/cashier permissions match createExpense's (✓ where it is ✓, ✗ where ✗); other store refused.
10. allocateBatchPayments: Ian's example (100/50 vs 80 cash/70 GCash → 80+20 / 50); one source covering all; a
    source exactly ending at a group boundary (no zero-amount rows); centavo amounts; payments ≠ total refused.
9. picker data carries expense_category_id (ap/lib.ts itemPickerFor + CatalogueEntry).

### Out
- Linking expenses to individual lines (derived by category instead — simpler, void-safe).
- Re-filing existing posted expenses.

## 13. Audit of S1+S2 (commit 340fad9) — orchestrator rulings (1 Nov)

| # | Finding | Ruling |
|---|---|---|
| A1 | `cutoverRepo.itemsWithoutCount` (repo/cutover.ts:78-90) lists service items → an approved "Electricity" wedges the B3 gate | Exclude `kind = 'service'`; add the service trigger to `opening_counts` |
| A2 | `setStoreSellability` (domain items ~1400) lets a manager mark a service sellable | Refuse in the domain (plain message) AND a DB trigger on `store_item_sellability` |
| A3 | "Never stocked" triggers cover 5 tables | Widen in 0224 (unmerged, still editable): count-session lines, transfer lines, trade order lines, supplier + customer return lines, stock_layers, item thresholds, opening_counts. Builder greps for any other table with an `item_id` that carries stock and lists it |
| A4 | Capability tests thin | Pin `approve_item_request` explicitly as NOT in the adminless-manager fallback (not derived from ROLE_ONLY); a person grant cannot confer it; a super-admin approves their own request (single-admin org) ✓ |
| A5 | `mergeItems` ignores service vs stocked and category | Refuse merging a service with a non-service ("A service can only be merged into another service"); when categories differ, the winner keeps its own and the audit row records the loser's category |
| A6 | `variationParentOptions` (items/lib.ts:81) offers services | Use `stockedOnly`... services may not be variations at all: refuse `variant_of_item_id` on a service (CHECK or trigger) |

## 14. §12 rulings after the tester's pass (1 Nov)

| # | Question | Ruling |
|---|---|---|
| Q1 | Where `requireItemised` lives | ONE place: `input.requireItemised` (default true) on createExpense and editExpense. Tests use that only |
| Q2/Q3 | Batch + allocator shapes | As the tester wrote them (§12 tests) |
| Q4 | Uncategorised room vs a real group | Room per category C = lines(C) − live expenses(C). The **open room** = (uncategorised lines + invoice fees, Q5) − Σ over C of max(0, live expenses(C) − lines(C)). An expense for C is allowed when live expenses(C) + amount ≤ lines(C) + open room. So picking "Meat" for uncategorised lines while Meat is a group simply lets Meat use the open room; voiding frees it; nothing needs a stored link |
| Q5 | Lines total ≠ invoice total (delivery fee, other fees) | The difference (invoice total − lines total) joins the open room, shown as its own row "Fees and other charges on this bill", whose category the person picks (same as Uncategorised). Never negative: if lines exceed the total, the invoice cannot be verified already (t367) — refuse batch with the plain message |
| Q6 | Sentences | Not among the parts: "This bill has nothing under {category}. Pick one of the parts listed." · Over the room: "Only ₱{left} of {category} on this bill is left to record." · Uncategorised/fees without a pick: "Pick a category for the items that don't have one yet." · Payments ≠ total: "The payments add up to ₱{paid}, but the parts you ticked total ₱{parts}. They must match." |
| Q7 | Legacy drafts on lineless invoices | Intended: editing refuses with the itemise-first message (itemise the invoice, then edit); delete still works |
| Q8 | Verified path | Approve runs inside the batch transaction; all-or-none |
| — | `recordExpenseForInvoice` ("+ Record expense" on the invoice page) | Follows the same rules (it is a single-group record); its modal gets the "Which part of this bill?" select like /expenses/new |
| — | Recurring job | Passes `requireItemised: false` with a comment (system-made lineless invoice). Inter-entity never calls createExpense — nothing to change |
| — | ~40 existing tests on lineless invoices | Shared fixtures (t475-ap `f.draft`, t402-s3-money, others) pass `requireItemised: false` with a one-line comment "legacy fixture: lineless invoice". Do not itemise them; do not weaken any assertion |

### §14 addendum after the audit of 1f35989 (1 Nov)
- **Q4 as built is the ruling:** a category's headroom = lines(C) − live(C) + (open room computed WITHOUT C's own
  spill). The literal sentence above double-counted C's own spill; `headroomFor` (parts.ts) is correct.
- **Uncategorised recorded as a real category** is absorbed into that category while it is under its own lines; the
  invoice-wide total can never be exceeded and every row stays consistent. Accepted — no stored link.
- **Double-submit:** the batch and the single-expense Save buttons disable while the request is in flight (existing
  pending-button pattern). No server idempotency key.
- **Closed month:** the batch has no closed-month override; a verified invoice in a closed month is recorded one part at
  a time with "+ Record expense" (which has the override). Accepted.

## 15. S4 rulings after the tester's pass (1 Nov)
1. Capability `approve_item_request` (any admin, 2A). The import is an admin's bulk create+approve: it inserts through the
   repo (not createItem's super-admin gate), keeps the code allocator (CHWN-001 style), and audits every created item and
   alias as the confirming admin. Requester ≠ approver does not apply (there is no request).
2. **No partial confirm.** Any row that is not `new` or `exists` blocks Confirm; the preview lists every problem so the
   admin fixes the file and re-uploads.
3. A row matching an existing item is skipped; the preview says so per row ("already in the list — its other names and
   category in the file were not applied").
4. Caps: 1,000 rows, 1 MiB, checked before parsing.
5–8. As the tester assumed (sub-category required when the category has active ones; blank/retired category refused;
   a name starting = + - @ is invalid; return shapes and line numbers as in the tests).
- CSV parsing: a small hand-written parser in packages/core (quotes, escaped quotes, BOM, CRLF/LF), unit-tested. No new dependency.
