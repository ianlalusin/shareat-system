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
