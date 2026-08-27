# T-125 — Prepaid items and amortisation

> **Status:** spec 2026-08-26, **v1 read first**. Wave 2's second item.
> **Depends on:** T-105 (`postEntry`), T-106 (`reverseEntry`), T-121, T-138, and T-124 — whose
> `asset_policy` row now carries the threshold this task also reads (bible row 141).
> **Feeds:** T-134 (cutover opening balances), T-135 (the missed-period finding).
> **One of ADR-005's five January-required capabilities.** v1 posts 38 amortisation legs; omit
> this and a paid-in-advance insurance premium either hits one month in full or never lands at all.

---

## 1. What this is, in one line

A prepaid item is **an expense already paid for but not yet used up** — a year of insurance, a
mayor's permit, six months of rent in advance. It sits on the balance sheet at 1400 and is
released into the P&L a month at a time.

⭐ **The shape is T-124's, and the accounting is not.** Both are a balance-sheet figure consumed
over time by an idempotent periodic posting, so the machinery is nearly identical. §10 is the list
of places where copying T-124 would be wrong.

---

## 2. What v1 has, and is worth porting

`PrepaidItemPlain` — `ERP-rebuild/src/types/index.ts:2718-2765`, stored at
`stores/{storeId}/prepaidItems/{id}`.

| Field | Note |
|---|---|
| `category` | Six values: Insurance · Permits & Licenses · Rent Prepaid · Software & Subscriptions · Maintenance Contracts · Other Prepaid |
| `coverageStartDate`, `coverageMonths` | ⭐ **Months only, whole integers, 1–120.** No days unit anywhere |
| `totalCost` | Gross, frozen after create |
| `sourceAccountId`, `supplierId` | What funded it |
| `status` | `active` · `fully_amortized` · `written_off` · `voided` |
| write-off / legacy-import fields | See §5 and §9 |

**Three things v1 does here that are genuinely good and should survive:**

1. **22 seeded templates with per-category default coverage** (`seed-expense-entries.ts:353-491`)
   — 5 insurance types, 6 permit/licence types (mayor's permit, BIR 0605, barangay clearance,
   DTI/SEC, sanitary permit, FSIC), rent advances defaulting to 6 months, subscriptions and
   maintenance contracts to 12. ⭐ **`sys_rent` carries `defaultCoverageMonths: 1`** so ordinary
   monthly rent stays an immediate expense while a multi-month advance routes to prepaid — a
   distinction somebody clearly got wrong once.
2. **Edit is metadata-only.** Name, type and notes stay editable; amount, dates, coverage and
   funding freeze at create (`prepaid.actions.ts:217-219`). *"To change a schedule, operators must
   void + re-create."* Correct — a schedule that can be edited after it has posted is a schedule
   whose history no longer explains its entries.
3. **Refund and write-off are separate legs** (§5) — a cancellation refund is not an expense
   reversal, and v1 is right to keep them apart.

---

## 3. ⛔ What NOT to inherit

### 3.1 The two stored running totals

`amortizedToDate` and `remainingBookValue` are hand-incremented at **every** write site — create,
runner, write-off, void, import — and never reconciled against the `prepaid__{id}` balance they
are supposed to mirror. The type's own comment admits they are kept in sync *"by convention"*
(`types/index.ts:2737`).

⚠️ **v1 already has two different code paths computing "total remaining prepaid" that never read
from each other**: the sum of the stored column, and `getPrepaidBalanceSummaryAction`
(`monthly-runs.actions.ts:167-200`) scanning `accounts/` for `prepaid__*` balances. Two answers to
one question, with nothing deciding which is right.

**v2 stores neither.** `amortised_to_date` and `remaining` are derived from the journal exactly as
T-124 derives accumulated depreciation — this is DEF-044's lesson applied a second time, and it is
cheaper here than it was there.

### 3.2 `monthlyAmortization` as a stored, frozen, pre-rounded number

v1 computes `totalCost / coverageMonths`, **rounds it, and stores it** at create — then uses that
rounded figure as the basis for every period. v2 computes the schedule from cost and term, with the
remainder landing on the final period, so the schedule sums to exactly the cost. The `schedule.ts`
engine T-124 already has does this; §6 says how much of it is reusable.

### 3.3 The delete that orphans the ledger

`prepaidItems` is in v1's `DELETABLE_COLLECTIONS` but has **no reversal branch** in
`adminDeleteRecordAction` — it falls through every `else if` to a bare `ref.delete()`
(`admin-record-ops.actions.ts:660`). Every posted leg survives, permanently misstating 1400.
Identical to the asset hole T-124 recorded. **v2 has no delete path for either.**

### 3.4 The expense → prepaid handoff that loses everything

v1's expense editor shows a banner when the picked template is `capitalizable`, and its button
does `router.push('/inventory/prepaid')` with **no data handed over at all**
(`expense-editor.tsx:896-918`) — no amount, no date, no supplier. The user re-types everything.
**Fixed by §11** — v2 carries amount, date, supplier and the source expense id across.

---

## 4. Idempotency, and the missed period

The run is idempotent per **(item, period)** —
`idempotencyKey = prepaid:{id}:amortisation:{period}` — so re-running a month is safe and
catching up is running it again. Identical in spirit to T-124's
`asset:{id}:depreciation:{period}`, and for the same reason.

A missing period is an **OIL finding** (T-135): *"an active prepaid item with no amortisation
posted for a closed period."* ⚠️ ADR-005 puts the *watchdog* on its "can wait past January" list —
the **run itself does not wait**.

---

## 5. Posting

| Event | Posting |
|---|---|
| **Purchase** | DR **1400**, CR the funding side — already what T-122 does when the category maps to 1400 |
| **Amortisation** | DR **6750** amortisation, CR **1400** |
| **Write-off** (early termination, unrecovered part) | DR **6750**, CR **1400** |
| **Refund** (early termination, recovered part) | DR cash / e-wallet, CR **1400** |

### ⭐ There is NO contra account, and that is the deliberate difference

Depreciation credits a **contra-asset** (1590) and leaves 1510 at cost for the asset's whole life,
because *"what did we pay for it"* is a question an auditor asks about a fridge. A prepaid has no
such question — the balance simply runs down. v1 states this explicitly
(`amortization.builder.ts:12-14`):

> *"This differs from depreciation (which uses a contra_asset account and preserves gross cost) —
> prepaid-expense accounting directly reduces the current-asset balance, matching US GAAP / IFRS
> practice."*

**Ported unchanged.** Do not add a contra account for symmetry with T-124; the asymmetry is the
correct treatment.

### ⚠️ A refund never touches the P&L

Cancel a ₱24,000 policy at month 7 with ₱10,000 refunded: ₱14,000 is a real loss and hits 6750;
the ₱10,000 is cash coming back and moves balance sheet to balance sheet only. Booking the whole
remainder as expense and the refund as income would double-count the cancellation.

---

## 6. Scope

**In.** The `prepaid_items` table · creation from a source expense and by hand · a straight-line
monthly schedule · the amortisation run · early termination with optional refund · **per-month
reversal** (§7.8) · derived amortised-to-date and remaining · the screens.

**Out.** Multiple amortisation methods · non-monthly intervals (§10) · automatic renewal ·
supplier-contract management · the scheduler itself (T-124 §12.1 owns that question for both).

### Reuse, and one thing that must not be reused blindly

`packages/domain/src/fixed-assets/schedule.ts` already solves this arithmetic — straight line, a
remainder on the final period, `periodsThrough` for catch-up. **Extract it to
`packages/domain/src/shared/straight-line.ts`** and have both call it, rather than copying.

⚠️ v1 duplicated the two runners by hand — the idempotency probe, the transaction shape, the
account seeding, all copied — and the copies then drifted (assets got a per-month void; prepaid
never did). **The duplication is what allowed the drift.**

⛔ But `salvageValue` and `interval` do **not** carry over. A prepaid runs to zero, monthly. Passing
`salvageValue: 0` is fine; adding an interval selector is §10's mistake.

---

## 7. Invariants

1. **Amortised-to-date and remaining are never stored.** Provable by no column, plus a test that
   the derived figure equals the ledger sum.
2. **Idempotent per (item, period)** — running twice posts once.
3. **Never amortises past the cost.** The final period takes the remainder; the schedule sums to
   exactly `total_cost`.
4. **Coverage starts the schedule.** A period before `coverage_start_date` owes nothing —
   v1 gets this right by lexicographic `YYYY-MM` compare, which crosses year boundaries correctly.
5. **A written-off or fully-amortised item stops amortising.**
6. **A refund never debits 6750**, and write-off + refund never exceed the remaining balance.
7. **A missed period surfaces as a finding, not silence.**
8. ⭐ **A single posted month can be reversed on its own** — see below.
9. Every capability has a denial test.

### 7.8 Per-month reversal — the one place v2 should exceed v1

v1 has `voidMonthlyDepreciationAction` for assets and **nothing equivalent for prepaid**
(grep-confirmed, zero hits). The only way to undo one bad amortisation month is
`voidPrepaidItemAction`, which cascade-voids **every** leg including the original purchase — so
correcting one month means re-creating the item and re-running every prior period.

v2 builds `reverseAmortisation(itemId, period)` on top of `reverseEntry`. It is nearly free here:
because the balance is derived, reversing the entry restores the correct figure with no column to
repair. **In v1 it was expensive precisely because the stored totals had to be walked back** — the
missing feature and the stored column are the same problem wearing two hats.

---

## 8. The refusal, and the threshold

**One threshold, ₱5,000, shared with fixed assets** — `asset_policy.capitalization_threshold`
(bible row 141). Below it, the purchase is an ordinary expense.

⚠️ v1 kept **two** — `appConfig/capitalization` (org-level) for assets and
`stores/{id}/financialConfig/thresholds` (store-scoped) for prepaid — same default by coincidence,
different scope, never reconciled. v1's own `ACCOUNTING_BLUEPRINT.md:1046` still lists the split as
**unresolved**. That is settled here by not having two.

**The policy read fails closed**, reusing T-124's `readPolicyOrRefuse` unchanged: absent means no
policy is set and the default applies; **unreadable stops the posting**. v1's prepaid path does
refuse, but only incidentally — the exception escapes to a generic *"Failed to save prepaid item."*
Assets get a message explaining what was not recorded and why. **Prepaid gets the same message.**

Below-threshold rejection should keep v1's clarity (`prepaid.actions.ts:122-125`):

> *"Total cost ₱X is below the capitalisation threshold (₱5,000). File as immediate OPEX instead."*

⚠️ And it must be said **before** the form is submitted. v1's own comment claims a client-side
warning exists; it does not, so a user learns only after filling everything in.

---

## 9. Cutover and the opening balance

v1's `importLegacyPrepaidItemAction` posts a pure balance-sheet entry — `IN prepaid__{id}` +
`IN equity__opening_balance`, no cash, no P&L — with the already-elapsed months entered by hand.
v2 does **not** port this as a feature: **T-134 owns opening balances**, and v2 opens on one
balance-sheet entry of counted, present-day facts.

What T-125 must provide is the *shape* T-134 needs: an item created with a coverage start already
in the past, whose schedule then continues from the next unposted period. §7.2's idempotency gives
this for free — the elapsed periods are simply never posted.

---

## 10. Where prepaid deliberately differs from fixed assets

**Read this before reusing anything from T-124.**

| | Fixed assets (T-124) | Prepaid (T-125) |
|---|---|---|
| **Account shape** | 1510 at cost **plus contra** 1590 | ⭐ **1400 alone, decremented directly** |
| **Salvage** | Yes — depreciates to salvage | ⛔ None — runs to zero |
| **Interval** | monthly / quarterly / semi-annual / annual (row 140) | ⛔ **Monthly only** |
| **Life** | `useful_life_months`, an ESTIMATE of replacement | `coverage_months`, a **contractual term** |
| **Auto-created from an expense** | Yes, over threshold, flagged `needs_review` | ✅ Yes — from a `prepaid_eligible` category (§11) |
| **`needs_review`** | Yes — life and salvage were guessed | ✅ Yes — the **coverage term** is guessed (§11.1) |
| **Early termination** | Disposal: write off remaining book value | Write-off **plus optional refund** |
| **Ends when** | Fully depreciated, or disposed | Fully amortised, written off, or refunded |

### Why monthly only, and why that is not laziness

An asset's interval is a genuine choice — a building's cost can reasonably be recognised annually.
A prepaid's term is **contractual**: a 12-month policy covers 12 months. Charging it quarterly
would recognise a cost for months not yet covered, which is the error prepaid accounting exists to
prevent. v1 offers no interval here either, and is right not to.

### `needs_review` — and why §11 changed the answer

This section originally argued the flag did not apply: a prepaid's coverage comes from the document
being paid, so nothing is guessed. **Choosing option B makes that false**, and the correction is
worth keeping visible rather than silently rewriting.

The amount and date do come from the invoice. **The term does not** — it is the category's default,
applied because the expense cannot know that this particular permit runs 24 months rather than 12.
A wrong term is wrong in every period it posts, so it is flagged, counted, and reviewed (§11.2).

---

## 11. Settled — the expense seam is option B (Ian, 2026-08-26)

**v2 had no way to express "this expense should become a prepaid."** `expense_categories` carried
only `group` (OPEX · COGS · CAPEX · PERSONAL) — no `capitalizable` flag, no prepaid group. Fixed
assets have a clean seam (a CAPEX category whose account is 1510); prepaid had none.

> **Ian:** *"ok lets do B. but design that the review is obvious not just a toast notif — I suggest
> a prepaid expenses page with a counter of pending items to be decided."*

### 11.1 The seam

Two columns on `expense_categories`:

| Column | Meaning |
|---|---|
| `prepaid_eligible` (boolean, default false) | Spend in this category may be a prepayment |
| `default_coverage_months` (integer, nullable) | The term to apply when nobody has said otherwise |

An approved expense in a `prepaid_eligible` category that clears the **₱5,000** threshold
(bible row 141) creates a prepaid item carrying **amount, business date, supplier and the source
expense id** — the four things v1 threw away — with the default term applied and
`needs_review = true`.

⭐ This is v1's 22 seeded templates (`capitalizable` + `defaultCoverageMonths`) rebuilt on the table
v2 already has, rather than a new taxonomy. It also **fixes** v1's handoff, which was a button that
navigated to an empty form and lost every value the user had typed.

⚠️ **`needs_review` now means something for prepaid, reversing §10.** The amount and date come from
the invoice, but **the coverage term is a guess** — the default for the category, not the term
written on the document. A 12-month default applied to a 24-month permit is wrong by half, silently,
for two years. That is precisely what the flag is for.

### 11.2 ⛔ The review must be a place, not a notification

> **Ian:** *"design that the review is obvious not just a toast notif."*

A toast is gone in four seconds and is seen by whoever happened to be looking. **The review lives
on the page**, and the page is the thing the business opens.

| Requirement | |
|---|---|
| **A pending counter, on the module** | `/prepaid` shows *"N items need a term confirmed"* as a persistent banner and a filter, not a dismissible alert. It reads zero when there is nothing to do — a counter that is only ever present is a counter people stop seeing |
| **Nothing expires the queue** | An item stays pending until a human confirms or changes the term. There is no auto-accept after N days: a default silently becoming permanent is exactly the failure this whole task is built against |
| **Confirming is one action** | Opening the item, seeing the guessed term next to the source expense, and either accepting or correcting it. Confirming clears the flag — the same rule T-124 already uses: only a human editing the terms clears `needs_review` |
| **The source expense is one click away** | The reviewer's first question is *"what did we actually buy?"*, and `source_expense_id` can answer it |

⭐ **The counter is the whole design.** An auto-created prepaid item with a guessed term is a
liability that gets worse with time — it posts a wrong amount every month, quietly, and the only
thing standing between that and the books is somebody noticing. A number on a page that does not go
away until the work is done is what noticing looks like.

⚠️ **T-124's assets have the same problem and a weaker answer.** `/fixed-assets` shows a
needs-review banner today, but nothing counts *across* modules. If a third auto-capitalising
source ever appears, this becomes a dashboard concern rather than a per-module one — noted, not
built here.

## 12. Done when

- [x] `prepaid_items` in the schema, classified in `cutover/classification.ts` **and**
      `rls/registry.ts`, with RLS policies in the migration.
- [x] Straight-line arithmetic extracted to a shared module, with T-124 switched onto it and its
      22 existing tests still green.
- [x] Repo, services (create · amortise · write-off/refund · reverse-a-month), and screens.
- [x] Integration tests for all nine invariants, including a denial test per capability and a test
      that no `amortised_to_date` or `remaining` column exists.
- [x] Driven end to end in a browser: a ₱24,000 / 12-month policy created, 8 months released in
      one catch-up run, **2026-02 reversed on its own** and then re-posted as `#2` — the other
      seven no-opping — and the ledger checked directly (1400 −₱16,000, 6750 +₱16,000, balanced).
- [x] Gates: typecheck · unit 545 · integration 844 · build, dev server stopped.
