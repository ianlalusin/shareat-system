# Ian's 2026-10-14 list — inspected against the bible, the plans, and the code

> **Source:** [`2026-10-14-ian-raw.md`](./2026-10-14-ian-raw.md) (verbatim, 31 items).
> **Method:** five read-only research passes over `PROJECT_BIBLE.md` §13, `docs/tasks/`, `docs/plans/`,
> `docs/decisions/`, `docs/CAPABILITY-GAPS.md`, `docs/DEFECTS-REGISTER.md`, `docs/discovery/` and the code.
> v1 itself was **not** re-read (it lives on Ian's PC) — v1 claims below come from `docs/discovery/`.
> **What was built in this session:** [`docs/tasks/404-ian-2026-10-14-quick-fixes.md`](../tasks/404-ian-2026-10-14-quick-fixes.md).
>
> ⚠️ **Nothing here amends the bible.** Items marked **PIVOT** reverse or narrow a recorded decision;
> each needs Ian's yes and then an Opus-planner bible row before any build (RULES §1 #14).

## Verdict key

| Verdict | Meaning |
|---|---|
| ✅ **BUILT** | Already in v2 (maybe differently than Ian pictured) |
| 🗓️ **PLANNED** | A spec/plan/gap row already owns it |
| ➕ **NEW** | Not planned, but fits the current design — additive task |
| 🔀 **PIVOT** | Reverses or narrows a recorded decision — Ian must re-decide |
| 🛠️ **FIXED TODAY** | Built in T-404 this session |

## One-screen summary

| # | Item | Verdict | Blocking decision / key fact |
|---|---|---|---|
| 1 | Till custody to POS v2 | 🔀 if *moved* · ➕ if *mirrored* | Row 130: "POS frontend, ERP backend" for money |
| 2 | Channel settlement: parse zip, post to collections | ➕ parsers · 🔀 "mirror to v1" | T-150 reserved the parsers; writing to v1 breaks rows 78/106 |
| 3 | Gmail wastage scan (Foodpanda/Grab) | ➕ | Discovery 16:90 "NOT PLANNED — ADD (small, cheap)" |
| 4a | Cashier: all payment methods on expenses | ✅ | No role filter exists — need to know what Ian saw |
| 4b | Bulk actions (verify, salary advance, …) | ➕ / 🔀 for invoice verify | Invoice verify = 4 attestations per invoice (Ian 2026-08-28) |
| 5a | Clock-in and app log-in same credential | 🔀 if PIN clock returns | Row 165: "no pin" for attendance |
| 5b | Multi-role: choose a role at sign-in | 🔀 | Row 198: "a position never enters the check path" |
| 6 | Attendance — dedicated session | 🗓️ | Agree. Agenda below |
| 7 | Tablet pairing one-time until revoked | ✅ mostly · gaps | DEF-260; T-304 vs in-memory persistence; row 280 Firebase exit |
| 8a | Government benefits switchable off | ✅ de facto · ➕ switch | Statutory (T-190) not built — payroll already runs without it |
| 8b | v1 payroll addition/deduction templates | ➕ | Discovery 15 lists it; no Phase-5 slice owns it |
| 9 | Expense category "needs receipt" switch | 🔀 | T-196 decision 2: "`needReceipts` is **not** ported" |
| 10 | Supplier OR toggle + VAT status | ✅ data · ➕ screens/report | Invoice form drops `vatType`/OR; no input-VAT list |
| 11 | Budgets auto-reissue | ✅ | T-215; check the systemd timer is armed in prod |
| 12 | Expense sub-category / defined expensable items | 🔀 sub-category · ➕ defined items | T-229 dropped `sub_category` (migration 0134) |
| 13 | Whole row clickable | 🛠️ started · ➕ sweep | T-258 decided it (Ian 2026-09-10); shipped on 1 page |
| 14 | Audit trail always shows actor name | 🗓️ + ➕ | T-402 S4 `/activity` not built; 4 pages fall back to raw id |
| 15 | Account numbers on screens | 🛠️ /inventory, /till · ➕ ~16 files | Row 229 already says "never an id, a code or a key" |
| 16 | /inventory/locations row height, icon edit | ➕ | No icon-button component; 25 pages use EditableRecord |
| 17 | AI/OCR hook on every receipt upload | ➕ hook · 🔀 any AI call | Row 251: "no need for receipt be sent to ai" |
| 18 | Usage recorded by each department | ✅ permission · ➕ enforcement | Nothing makes a dishwasher record soap |
| 19 | Production: slice / cook / convert | ✅ built · gaps · 🔀 fold convert | T-176 §4 "do not relax" convert; slicer pay = Phase 5 |
| 20 | Retire POS usage pull / item map / wastage pull | 🗓️ | Rows 270, ADR-015 P2 — already the plan |
| 21 | /money-accounts dashboard style | ➕ | UI-only; row 283 allows redesign |
| 22 | Liabilities ↔ recurring expenses | ➕ / needs a ruling | T-128 §5 kept them apart; DEF-074 |
| 23 | Service charge on/off toggle | ➕ | Row 222: no flag exists anywhere |
| 24 | Supplier page vs invoice page split; manager-only suppliers | ➕ | `/ap/suppliers` has no read gate today |
| 25 | `/ap/suppliers/[id]` blank | 🛠️ | Not a crash — all details were inside a closed box |
| 26 | Customer built for customer app v2 | 🗓️ | ADR-015 P3; diner ≠ AR customer (ADR-008 §11) |
| 27 | Customer price list: UOM, rate modes, bulk | ➕ | UOM is free text today — drift is real |
| 28 | Multi-row edit, one Save | ➕ | No batch-edit component exists |
| 29 | Destructive buttons guarded (PIN / password / retype) | ➕ needs a choice | ~45 danger buttons; no guard component |
| 30 | Collapsing table on /admin/users/[id] | ➕ | grid.tsx grouping not yet a shared component |
| 31 | Hide stores form, show button | 🛠️ | |

---

## Detail, item by item

### 1 · Till custody → POS v2 — 🔀 if moved, ➕ if mirrored
- **Today:** `/till` (open shift, count, close, charge a shortage) and `/remittance` live in the ERP — T-186, T-153, T-143, T-366.
- **Why:** **row 130** (Ian, 2025-08-25): *"for v2 POS will only transact… ERP will handle the money: where it goes… POS frontend, ERP backend."* The POS cannot see cashier-paid expenses, cash requests or AP paid from the till, so a POS-owned handover forces a second entry. Also rows 128, 143, 144, ADR-010. ADR-015 §2 gives the POS receipts and table sessions only — no till entity.
- **Recommendation:** **mirror, don't move.** With one shared Postgres (ADR-015), the POS v2 screen can show and drive the *same* till/shift tables through ERP domain functions. Ownership stays where row 130 put it. Needs an ADR-015 amendment row + a P1/P2 task. **Moving** ownership re-opens rows 128/130/143/157.
- **Ask Ian:** confirm "mirror" (the POS screen is a window onto ERP till custody).

### 2 · Channel settlement: parse docs incl. zip → collections — ➕ (parsers) / 🔀 ("mirror to v1")
- **Today:** manual entry at `/channel-settlements` (T-150; patterns `channel_settlement.plain`/`.promo_credit`, POSTING-PATTERNS 965-1011). T-150 says: *"Manual entry first; the parsers are their own task."* No parser code exists.
- **v1:** routes zip files by filename substring (`"lip 15.zip"` → Lipa) — discovery 23:98 calls it fragile.
- **"Mirrored to v1":** writing v2 data into v1 conflicts with ADR-003 / row 78 and row 106 (v1 is a comparison subject, never written). If the goal is *seeing both side-by-side during dual-run*, **T-392 S1b already does that read-only.**
- **Recommendation:** new task — Grab + Foodpanda payout parsers (zip → statements → draft settlement), **explicit store selection instead of filename routing** (row 283), posting through the existing settlement action (idempotent, gated). Parsed result is a *draft* a person posts.
- **Ask Ian:** what does "mirrored to v1" mean — dual-run comparison (have it) or writing into v1 (no)?

### 3 · Gmail wastage monitor — ➕
- **Today:** `/wastage` is hand-entered channel wastage (T-178, row 180: monitor, 48h dispute window, 15-day backstop). No email ingest; no `/api/ingest` route.
- **v1:** a mailbox-side script POSTs to `/api/ingest/wastage-email` with a shared secret (discovery 12:273). It broke on 2026-08-10 (OC-41). ⚠️ discovery 02 calls it a Cloudflare Email Worker — the two docs disagree; confirm against v1 `Code.gs`.
- **Why it isn't built:** never scheduled. Discovery 16:90 — *"NOT PLANNED — ADD (small, cheap, already proven)."* Row 179 (nothing silently dropped) makes it an obligation.
- **Recommendation:** a daily scheduled job (T-140 runner pattern) reading the Gmail API, parsing Foodpanda/Grab wastage emails into **draft** wastage records via `recordOrderWastage`; machine principal (not a fake person — row 183), idempotency key = message id, quarantine for unparseable mail (bible §5 rule 5). Not a Firebase dependency, so row 280 is fine.

### 4a · Cashier may use all payment methods — ✅ already true in code
- `createExpenseAction` needs only `create_expense` (cashier holds it, CAPABILITY-MATRIX:48). The method list (`loadMoneyLines`) is filtered by **store**, not role. Restrictions live at **approve** (manager+), cross-store draw (`transfer_funds`), overdraft (row 154).
- **Ask Ian:** which screen showed a cashier fewer methods? Possibly the store has fewer than five money accounts seeded (row 156), or the cashier is on `/expenses/new` against an invoice whose supplier is COD (credit/AP hidden by terms — T-362).

### 4b · Bulk actions — ➕ (expense approve) / 🔀 (invoice verify)
- **Today:** every verify/approve is one record at a time. Nothing in the registers asks for bulk.
- **Constraint:** invoice **verify** is an attestation — Ian 2026-08-28: *"right supplier, right invoice data, right items, right price… plus an uploaded photo"* (T-130's four checkboxes). A bulk verify either keeps four ticks per row (a review grid with one Submit) or relaxes the attestation — the second is Ian's call.
- **Salary advance:** the mechanism exists (1230/1235, T-189) but there is no single-record screen to bulk yet (CAPABILITY-GAPS:378).
- **Recommendation:** one shared "select rows → act" pattern (checkbox column + one action bar + per-row result report), first on expense approve and cash requests; invoice verify as a grid that still shows the four attestations per row.

### 5a · Clock-in = app log-in credentials — 🔀 if the clock PIN comes back
- **Today:** app sign-in = 6-digit PIN per person (T-302). Clock = **fingerprint or card only**; PIN clock-in is *unrepresentable* (migration 0085).
- **Why:** **row 165** (Ian, 2026-08-29): *"in v2 only fingerprint face and card will be mode of attendance no pin."* The two credential tables are kept apart so a terminal mirror can never carry a PIN verifier.
- **Option that needs no pivot:** let the **same fingerprint/card open the app** at a store terminal (`person_credentials` already declares `biometric`; ADR-015 O5 offline verifier). One credential *experience*, two tables.
- **Ask Ian:** "same credentials" = PIN for both (reverses row 165) or fingerprint/card for both (additive)?

### 5b · Multi-role staff — 🔀 (Ian leans to "choose a role")
- **Today: UNION.** A person has one RBAC role (staff/manager/admin/super_admin) plus **position grants** materialised per position (T-289/T-318). Cashier + Server = both positions' grants. Sessions carry no role/position.
- **Why:** **row 198**: *"A position never enters the check path and is never a parameter to authorize()."* Plan 289 §4 test: *"Cashier+Cook keeps the union."* v1 also used the union.
- **Recommendation (if Ian confirms the lean):** add the pick as a **narrowing-only** session attribute — `sessions.acting_position_id` (null = all), asked after the PIN **only** for staff holding ≥2 positions at that store. Enforced inside `resolveActor`/`decide`/`heldCapabilities` by dropping position-sourced grants from other positions — it can only *remove* access, never widen it, and none of the ~568 `authorize()` call sites change.
- **Rules that need a decision:** (1) hand grants and elevations — kept under a pick, or dropped? (recommend kept); (2) switching mid-shift — a "switch role" action with PIN re-entry (recommend) vs sign out; (3) a manager who also covers cashier — the manager *role* is not a position, so the pick does not narrow it.
- **Audit is not broken:** `actor_person_id` stays the person; record the acting position in the audit row.
- Needs a new bible row superseding part of 198.

### 6 · Attendance — dedicated session — 🗓️ agree
- Core built (T-155…T-204); ROADMAP shows Phase 4 complete. **Open:** T-314 fingerprint capture/APK/OTG (blocked on hardware), per-person schedules (CAPABILITY-GAPS ~581), the sweep timer on the droplet (T-199), DEF-260 terminal pairing confirm.
- **Agenda for that session:** row 280 (off Firebase → the clock carrier changes), T-314 hardware, row 302 Q1(a) attendance+payroll on v2 from 1 Jan 2027, item 5a above, the "non-standard setup" (05:00 shift-day, open-hour anchor, offline lanes).

### 7 · Tablet pairing one-time until revoked — ✅ mostly, with gaps
- **Clock terminals:** provision → QR token → pair; no expiry on the terminal row; only an admin revoke ends it (`provision_clock_terminal`, row 165). Re-pair keeps the same device row.
- **Gaps:** (a) **DEF-260** — `activateTerminal` has no caller, so every terminal reads "not yet paired"; Ian ruled a manager confirms on the terminals screen — not built. (b) Clearing browser/app data loses pairing. (c) **Sign-in terminal:** T-304 records Ian's ruling *"terminal password remembered… Indefinite"*, but `sign-in/firebase-client.ts` uses `inMemoryPersistence` — **looks contradictory; verify on a real tablet.** (d) Row 280 moves pairing off Firebase — carry "one-time, revoke-only" into that redesign as a hard requirement.

### 8a · Government benefits switchable off — ✅ de facto, ➕ switch
- Statutory (T-190) and remittance (T-193) are **not built and have no spec** — payroll today computes `net = gross − advance recovered`. So "a store can process payroll with benefits off" is **today's behaviour.**
- **Why:** phase-5 plan §2: *"Do NOT port the statutory engine yet… a machine with no fuel"* (until real SSS numbers exist). Row 217 puts statutory incl. employer share in January scope.
- **Recommendation:** when T-190 is specified, include an **effective-dated switch** (per org or store, possibly per employment) that the compute reads, default **off** until HR IDs exist; with it off, nothing posts to 6110-6130 or 2210-2240. Preserve v1's "total deductions capped at gross".

### 8b · Payroll addition/deduction templates — ➕
- v1: typed addition/deduction catalogue, assign per staff, bulk assign, keep-vs-remit fork (discovery 15:109-111). Discovery 15 classes it "P5 / DUPLICATE" but **no Phase-5 slice owns it.** New task; restates the payslip net identity check (payroll.ts:270 already warns).

### 9 · Expense category "needs receipt" — 🔀
- **Today:** every expense must reference a supplier invoice; the photo is checked at invoice verify. No per-category flag.
- **Why:** T-196 :222 — *"Evidence stays unconditional. v1's per-category `needReceipts` is **not** ported. It is exactly why v1 needs a detective scan for orphan expenses."* Discovery 28:151 marks the flags "delete". In v1 only "Employee Expenses / Incentive" was exempt.
- **Middle ground:** keep evidence unconditional but let *what counts* vary — a category flag "evidence may be a signed petty-cash voucher photo" (T-196 already names this). That gives Ian "some need a receipt, some don't" without orphan expenses.
- **Ask Ian:** true exemption (no evidence at all) or alternate evidence?

### 10 · Supplier OR toggle + VAT status — ✅ data, ➕ screens and report
- **Built:** `suppliers.vat_status`, `tin`, `issues_official_receipt`; invoice-level `is_official_receipt`, `vat_type`, `vat_amount`, `vat_exclusive_amount`; domain `recordInvoice` accepts them.
- **Gap:** `recordInvoiceAction` passes **none** of them — the invoice form cannot capture VAT or OR, and there is no input-VAT list.
- **Recommendation:** wire VAT type/amount + OR into the invoice form (defaulted from the supplier), and a manager list "invoices by VAT type × OR" per month for matching against the physical receipt file. An input-VAT *posting* (split to a VAT-input account) is a new posting pattern — separate decision.

### 11 · Budgets auto-reissue — ✅
- T-215: per store × category × period, intervals daily → annually, "renew automatically", job `budget-reissue` (systemd timer 03:30 Manila). **Check:** the timer is installed on `159.223.46.224` (DEF-194).
- Note: v1 keyed budgets on a sub-category; v2 keys on category (see 12).

### 12 · Expense sub-category / defined expensable items — 🔀 sub-category, ➕ defined items
- **Today:** two levels (group → category). `sub_category` was **dropped** (migration 0134, T-229). `particulars` is free text.
- **Why:** *"v1's second free-text level is what produced its 8 catch-all categories"* ("Please Specify", "OTHER"…). T-145 measured the same disease in items: 842 records, 385 distinct names.
- **Ian's "defined items" idea is the better fix and does not need the sub-category back.** Plan:
  1. `expense_items` master: name, **its category (fixed)**, default unit, optional default supplier, receipt policy (ties to 9), active flag.
  2. The expense line **picks an item**; category is derived from the item, never re-chosen → bottled water always lands in the same place.
  3. Unknown item → "request a new expense item" queue for a manager (same pattern as the item request flow), not free text.
  4. Analysis: spend by item → category → group, per store, per period; budgets can later key on item or category.
  5. Open design call: one master with stock `items` (bottled water bought for resale *is* a stock item — T-149 sellability) vs a separate expense-item master. Recommend: **separate master for non-stock spend**, with a guard that refuses an expense item whose name matches a stock item, so stock purchases still go through invoices→inventory.
- **Ask Ian:** approve this direction → planner writes the spec.

### 13 · Whole row clickable — 🛠️ started, ➕ sweep
- **Decided already:** T-258 (Ian, 2026-09-10): *"the WHOLE ROW becomes tappable — not a taller row with a small link inside it."* Shipped on `/customers/[id]` only.
- **Today:** applied to `/admin/stores` and the new invoice list on `/ap/suppliers/[id]`.
- **Remaining:** ~75 hand-rolled tables. Recommend a shared `RowLink` primitive in `components/ui/Table.tsx` (stretched link, `relative` row, buttons in a trailing cell above the stretch) and a sweep task with a census test like `tappable-rows.test.ts`.

### 14 · Audit trail shows actor name — 🗓️ + ➕
- T-402 S4 (`/activity`, "who / what / store / when") is specified, not built. Row 229 already rules *"never an id, a code or a key."*
- **Bug class found:** `expenses/[id]`, `sales-days/[id]`, `ap/invoices/[id]`, `ap/page.tsx` fall back to the raw UUID when a name lookup misses (`?? personId`). Recommend a shared `PersonName` helper rendering "Unknown person" and a sweep.

### 15 · Account numbers on screens — 🛠️ partly
- **Fixed:** `/inventory` ("Inventory on the books", "In transit (branch orders)") and `/till` ("Charge to this person", "as an advance to that employee").
- **Remaining (~16 files):** deliveries, counts, money-transfers, channel-settlements, customers, AP, payroll, money-accounts, commissary discrepancies, prepaid, ap-aging. Recommend an `accountLabel(code)` helper reading the chart of accounts. Reports and accountant pickers may keep "code · name".

### 16 · Row height / icon edit — ➕
- `/inventory/locations` stacks Edit + Make default + Deactivate vertically (each `min-h-11`). Recommend: a compact table density + an icon-only Button variant (pencil) that still meets the 44px touch-target test via padding, and actions in one horizontal row. Touches the 25 `EditableRecord` pages.

### 17 · AI/OCR hook on receipt uploads — ➕ hook, 🔀 any AI call
- **Upload path is centralised** (`uploadFile` in `packages/domain/src/files/index.ts`, 3 callers) — a hook is cheap.
- **Conflict:** **row 251** (Ian, 2026-09-29): *"q5 no need for receipt be sent to ai"* → Phase 1b dropped. ADR-014 is still PROPOSED. T-146 (OCR) is parked; its rule: *OCR proposes, a human disposes.*
- **Recommendation:** build the **seam only** — an `after-upload` event (purpose + file id) and a `document_proposals` table a future engine writes into; nothing calls a model. Whether an engine is attached (and whether a *local* OCR is outside row 251) is Ian's re-decision.

### 18 · Usage by every department — ✅ permission, ➕ enforcement
- Everyone on the floor can draft usage; a manager posts (T-168). Department is an *optional* tag; nothing expects a dishwasher to record soap.
- **Improve on v1:** an **expected-usage list per position/department** (soap → Dishwasher, thermal paper → Cashier…), and a daily "not recorded" finding on the manager dashboard. Optionally the usage form opens pre-filtered to the signed-in person's items. Verify the Cashier position has the usage capability.

### 19 · Production modes — ✅ built, with gaps
- `production_records.kind` = slice | cook | convert (T-176). Recipes exist (`production_recipes`).
- **Gaps:** (1) slice pickers show **every** item — meat-only is a soft warning; (2) **cook is not wired to recipes in the form** — the domain accepts `recipeId`, the screen never sends it, so the "exact ingredients go to usage" rule isn't enforced on screen; (3) slicer pay is a stub (`hasLiveSlicerPaymentCovering` returns false), planned Phase 5 (CAPABILITY-GAPS:183) with `performed_by_person_id` + piece rate.
- **Fold convert into slice?** 🔀 — T-176 §4: convert is zero-GL, same-slab re-cut only, *"the re-cut constraint is the whole point; do not relax it."* Recommend: add **paid / unpaid on slice** (who performed it, piece rate) and keep convert as the narrow re-cut — or rename it on screen as "Slice (unpaid re-cut)".
- **Recommend now:** filter slice pickers to meat slab → meat sliced (hard), wire cook to a mandatory recipe with exact scaled lines.
- Note: Ian says cook ingredients "go to usage" — they do leave stock and post at record time, but through production movements, **not** the usage register. Ask whether they must also *appear* on the usage screen.

### 20 · Retire POS usage pull / item map / wastage pull — 🗓️ already the plan
- Row 270 + ADR-015 P2: usage pull and day feed retire **per store** as POS v2 receipts arrive. The item map is **migrated** onto the menu item's depletion rule at P1 (T-401 S5 seam). Recommend a per-store retirement checklist. **Ask Ian:** "wastage pull" isn't a screen in v2 — POS refunds (row 282 Q-B)?

### 21 · /money-accounts dashboard — ➕
- UI-only (row 283). Recommend cards per store → per account (custodian, derived balance, last movement, warnings), reusing T-387 S5 KPI cards; edit/retire moved into each card. Data shape stays (ADR-010).

### 22 · Liabilities ↔ recurring expenses — ➕, needs a ruling
- Kept apart on purpose: T-128 §5 — *"T-140's runner owns scheduling; a second cron is how v1 ended."* Row 183: a recurring expense drafts and never auto-pays. DEF-074 (one liability in three places) is why.
- **Recommendation:** fold the **pages** (one "Recurring obligations" screen with two tabs), not the data. "Sync" = a recurring template may target a liability (accrue `DR expense / CR 2500` on schedule) instead of drafting an expense, on the same T-140 runner.
- **Ask Ian:** which obligations? (rent accrual, permits, loans?) — that picks the posting path.

### 23 · Service charge on/off — ➕
- No flag anywhere (row 222 measured it). T-187: enabling service charge in production *"is separate and still open."*
- **Recommendation:** one per-store `service_charge_enabled` setting (audited, own capability), shown on `/service-charge` **and** the store/POS-link settings — one source, two entry points. The sales-day derivation and POS P1 read it; a store with it off cannot receive a service-charge figure. Needs a migration (ADR-012).

### 24 · Supplier page vs invoices page; manager-only suppliers — ➕
- Routes are already separate (`/ap` = invoices, `/ap/suppliers`, `/ap/suppliers/[id]`, `/ap/invoices/[id]`), but `/ap` still bundles "Record a supplier" and the supplier table, and **`/ap/suppliers` has no read gate** (not in `ROUTE_CAPABILITY`) — any signed-in staff can open it by URL.
- **Done today:** the supplier page now lists the supplier's invoices.
- **Recommendation:** a cashier-facing **Receipts & invoices** screen (log at delivery, photo), `/ap/suppliers*` gated on `approve_supplier` (manager+) for reads, supplier creation moved off `/ap`, and an `/ap/invoices` register for managers.

### 25 · `/ap/suppliers/[id]` blank — 🛠️
- **Root cause:** not a crash. Every supplier field lived inside a **collapsed** "Edit this supplier" box, and the invoice list was **loaded but never rendered**. A supplier with nothing open showed a name, ₱0 and a closed box.
- **Fixed:** a read-only details card (status, VAT, OR, TIN, terms, contacts, masked bank, notes) and an Invoices table. If Ian still sees a truly empty page after deploy, check the server log for that request — that would be a separate bug.

### 26 · Customer built for customer app v2 — 🗓️
- ERP `customers` = wholesale/AR buyers only. Diners are a `person` with a phone identity (ADR-015 §2, row 273 loyalty, built at P3 ≈ Q2 2027). Row 307: CUSTOMER v2 has no admin panel — menu/prices/ads/rewards edited in ERP. **Ask Ian:** does he want the ERP customer screen to also show a diner's loyalty profile? That's a new person↔customer link.

### 27 · Customer price list — ➕
- `price_list_items.unit` is **free text** defaulting to "kg" — exactly the drift Ian fears; trade orders copy it.
- Commissary already has the rate model: `item_pricing.pricing_mode` = fixed | fixed_markup | percent_markup.
- **Recommendation:** UOM always = the item's base unit (drop the input); rate mode = fixed | ±% | ±amount over a named basis (item cost or the branch price); edit as a grid with one Save (28); bulk "apply +5% to selected". **Decision:** store the rule (live) vs compute once and store the rate — recommend **store the rule, freeze the rate onto each order line** (discovery 19 §3.4 already requires the freeze). Also: `setPrice` authorizes `manage_chart_of_accounts` — probably wrong; give it a pricing capability.

### 28 · Multi-row edit, one Save — ➕
- Per-row Save everywhere (low-stock thresholds, commissary catalogue, price lists, settings). Recommend a shared `BatchEditTable` (one `<form>`, per-row inputs, changed-rows-only submit, per-row error report, T-389 keep-typing) and convert price lists, commissary prices, low-stock thresholds first.

### 29 · Destructive buttons guarded — ➕, needs one choice
- ~45 `variant="danger"` submits; only voids ask for a reason. PIN verification exists only at sign-in.
- **Recommendation:** a `ConfirmDestructive` wrapper with **two tiers**: retype-the-name for reversible-ish actions (retire, deactivate); **admin PIN re-entry, verified server-side** for money/irreversible ones (void posted, delete, cutover, separation). The server action re-checks — a client dialog alone is not a gate (bible §2 rule 7).
- **Ask Ian:** confirm the two tiers, or one rule for all.

### 30 · Collapsing table on /admin/users/[id] — ➕
- `access-defaults/grid.tsx` does it with native `<details>` per scope/area. Extract it into a shared component and render the user's grants grouped by area (`CAPABILITY_AREA`) and store.

### 31 · Hide stores form — 🛠️
- `/admin/stores` now shows only an "Open a branch" button; the form opens on click (and re-opens itself after a refused create).

---

## Questions for Ian (answer these and the planner can spec)

1. **Till (1):** mirror into POS v2, ownership stays in ERP — yes?
2. **Settlements (2):** "mirrored to v1" = side-by-side comparison (have it) or write into v1?
3. **Cashier methods (4a):** which screen showed a cashier fewer payment methods?
4. **Credentials (5a):** one credential = PIN for both, or fingerprint/card for both?
5. **Choose role (5b):** OK with narrowing-only pick for multi-position staff, hand grants kept, PIN to switch?
6. **Needs receipt (9):** true exemption, or alternate evidence (signed voucher photo)?
7. **Expense items (12):** approve a separate expense-item master with a request queue?
8. **Convert (19):** keep convert as the unpaid re-cut and add paid/unpaid to slice?
9. **Liabilities (22):** which obligations should auto-accrue?
10. **Price list (27):** store the rule and freeze the rate on each order — yes?
11. **Destructive (29):** two tiers (retype / admin PIN) — yes?
12. **AI hook (17):** seam only now; is a *local* OCR engine inside or outside row 251?
13. **Customer (26):** should the ERP customer screen show diner loyalty too?
14. **Wastage pull (20):** what does it refer to?
