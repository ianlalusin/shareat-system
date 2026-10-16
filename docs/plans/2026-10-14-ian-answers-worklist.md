# Work list from Ian's 2026-10-14 answers

> **Source:** [`docs/feedback/2026-10-14-ian-answers.md`](../feedback/2026-10-14-ian-answers.md) (Ian's 14 answers), recorded as
> bible §13 rows **319–331**, plus the ➕ "ready-to-spec" items in §4 of
> [`docs/feedback/2026-10-14-handoff-prompt.md`](../feedback/2026-10-14-handoff-prompt.md).
> **No task specs are written here.** Each line becomes a `docs/tasks/NNN-*.md` spec (written in plan mode) before any code.
> Migrations are hand-authored (ADR-012).

**Ordered by value against effort** — cheap, high-value work first; work blocked on a later phase last.

| # | Task | From | Size | Depends on | Migration | Spec first |
|---|---|---|---|---|---|---|
| 1 | Wire VAT type, VAT amount and the OR flag into the supplier-invoice form (defaulted from the supplier) + a monthly "invoices by VAT type × OR" list | §4 (review 10) | S | `recordInvoice` already accepts them | No | Yes (short) |
| 2 | `PersonName` helper ("Unknown person", never a raw UUID) + sweep of the 4 pages that fall back to `?? personId` | §4 (review 14) | S | — | No | Yes (short) |
| 3 | `accountLabel(code)` helper + sweep of the ~16 files still showing GL account numbers | §4 (review 15), row 229 | S | — | No | Yes (short) |
| 4 | Production: slice pickers limited to meat slab → meat sliced (hard); cook requires a recipe in the form and sends `recipeId` | §4 (review 19) | S | T-176 | No | Yes (short) |
| 5 | Per-category "no receipt needed" exemption: admin-only flag under its own capability, audited, stamped onto each expense; "spend without a receipt" register per store × month on manager/admin dashboards | Q6, row 324 | M | T-196, T-402 tags | Yes | Yes |
| 6 | Grab / Foodpanda settlement-file parsers (zip, xls/xlsx, pdf) → draft settlement → posted by a person through `recordChannelSettlement`; explicit store pick; unparseable lines quarantined; file kept as evidence | Q2, row 320 | L | T-150; **real sample files from Ian** for each channel and format | Yes (import/quarantine record) | Yes |
| 7 | `ConfirmDestructive` two tiers: retype-the-name (retire/deactivate); admin PIN re-verified on the server (void posted, delete, cutover, separation) + census of the ~45 danger buttons | Q11, row 329 | M | T-302 PIN verifier; row 196 adminless fallback | No | Yes |
| 8 | Identity guard: a test that every credential table resolves to `persons.id` and that no second identity table appears; confirm the T-391 load maps v1 staff + `staffIdentities` to one person | Q4, row 322 | S | — | No | Yes (short) |
| 9 | Recurring templates: pick a starting period on creation; the T-140 runner builds one draft per elapsed period (catch-up), still never auto-paying | Q9, row 327 | M | T-216, T-140 | Yes (starting period) | Yes |
| 10 | "Liabilities" as one read-only unpaid view: unpaid recurring drafts + unpaid AP invoices + open liability balances + unpaid payroll + open loans, each derived from its source | Q9, row 327 | M | #9 for the recurring half | No (repo query) | Yes |
| 11 | Service charge on/off per store (audited, own capability), shown on `/service-charge` and store settings; sales-day derivation and POS read it | §4 (review 23) | S–M | — | Yes | Yes |
| 12 | Position pick at sign-in (narrowing only): `sessions.acting_position_id`, asked only for ≥2 positions at the store; hand grants kept; "switch position" re-asks the PIN; acting position in the audit row | Q5, row 323 | M | T-289, T-318 | Yes | Yes (plan mode — touches `resolveActor`) |
| 13 | Customer price list: store the rule (fixed / ±% / ±₱ over cost or branch price), freeze the rate on each order line; unit always the item's base unit (drops free-text `unit`); give `setPrice` a pricing capability | Q10, row 328; §4 (review 27) | M | — | Yes | Yes |
| 14 | Expense-item master (item → fixed category) + "request a new expense item" queue + guard against stock-item names | Q7, row 325 | L | #5 (receipt policy lives on the item) | Yes | Yes |
| 15 | Slice paid/unpaid: who sliced (`performed_by_person_id`) and piece rate; slicer pay reads it (replaces the `hasLiveSlicerPaymentCovering` stub) | Q8, row 326 | M | #4; payroll for the paying half | Yes | Yes |
| 16 | Whole-row-click sweep: shared `RowLink` in `components/ui/Table.tsx` across ~75 tables + census test | §4 (review 13), T-258 | M | — | No | Yes (short) |
| 17 | OCR, local first — step 1: research the engine (accuracy on real Shareat receipts, memory on a 4 GB host) | Q12, row 330 | S (research) | — | No | Research note, not a spec |
| 18 | OCR step 2: the seam — after-upload event + `document_proposals` table; nothing posts | Q12, row 330 | M | #17 | Yes | Yes |
| 19 | OCR step 3: attach the chosen local engine; proposals fill fields, a person confirms | Q12, row 330 | L | #18; hosting decision from #17 | No | Yes |
| 20 | Gmail wastage ingest: daily job, draft wastage records, machine principal, message-id idempotency, quarantine | §4 (review 3) | M | Settle the Code.gs vs Cloudflare Worker disagreement (discovery 02 vs 12) | Maybe | Yes |
| 21 | ADR-015 amendment: POS gets a till *screen* over ERP till records (planner, docs only) | Q1, row 319 | S | — | No | No (ADR edit) |
| 22 | POS v2 till screen driving the ERP till/shift records through ERP domain functions | Q1, row 319 | M | #21; POS v2 P1 | No | Yes |
| 23 | ERP customer screen shows the diner's loyalty profile: optional, audited customer ↔ diner-person link | Q13, row 331 | M | ADR-015 P3 loyalty, diner principal | Yes | Yes |

**Closed with no work:** Q3 (row 321 — the balance rule is already enforced on the expense screen), Q14 (nothing to retire).

## Status census (orchestrator, 16 Oct, from code + task files)
DONE: 1 (T-408) · 2 (T-405, person-name.ts) · 4 (T-409) · 7 (T-412; draft deletes relaxed by T-418) · 8 (T-410) · 16 (T-411) · 17 (docs/discovery/41) · 21 (ADR-015 amendment).
PARTIAL: 3 (raw account code left at cutover/opening/page.tsx:357) · 6 (manual settlement only, no file parsers) · 9 (T-216 built, no catch-up → **T-430**) · 13 (price lists, no rule/frozen rate).
OPEN: 5 · 10 (→ **T-431**) · 11 · 12 · 14 · 15 · 18 · 19 · 20 · 22 · 23. Also DEF-662 AP float picker → **T-432**. Task numbers 422-429 are reserved for the POS v2 session.
