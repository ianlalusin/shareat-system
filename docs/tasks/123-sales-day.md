# T-123 — Sales day: the other half of the 88%

> **Status:** spec 2026-08-25. **Wave 1, the last item.** The 30 September checkpoint asks whether
> Wave 1 is in staff hands; T-122 shipped, this is what remains.
> **Research-first:** the posting side was settled by T-108 (five verified patterns); the document
> side is ported from v1's own `sales-report-draft.actions.ts` behaviour, not invented.
> **Depends on:** T-121 (roles), T-105 (`postEntry`), ADR-006 (period close).
> **Reads:** `docs/POSTING-PATTERNS.md` §sale.* · `docs/GLOSSARY.md` · `docs/discovery/22-pos-build-assessment.md`

## What this is

**The ERP's record of a day's selling, per store** — not the till. POS owns the sale; the sales day
is the document that **recognises the revenue**. It is pulled from POS's read-only
`/api/external/sales` endpoint (discovery 22 §5) and confirmed by a human.

`sale` legs were **2,945** of the captured corpus against expenses' 4,396 — together 88% of all
real activity, measured, not guessed.

---

## 1. The three rules, and all three already exist in v1

Ian, 2026-08-25 (bible row 126). **Every one is a port** — `saveSalesDayDraftAction` in
`ERP-rebuild` implements all three today, and the v1 behaviour carries carve-outs that matter.

### 1.1 An unverified sales day recognises NO revenue

v1 recognises revenue only for status ∈ `{verified, partially_remitted, remitted}`.

> ⚠️ **In v1 this is enforced in THREE separate readers** — the income statement, the dashboard,
> and the sales-report month roll-up — with a code note saying *"keep them in sync if you add a
> 4th."* **A rule enforced in three places is a rule that will one day be enforced in two.**

**v2 removes the problem instead of managing it: verification is what POSTS.** An unverified day
has no journal entry, so *every* reader gets the rule for free and there is nothing to keep in
sync. This is bible row 118 applied — prefer the design that removes a problem over the one that
manages it.

**Consequence, which Ian already accepted in v1:** the current day reads zero revenue until its
report is verified.

### 1.2 A new report cannot be created while an older one is unverified

**The forcing function.** Without it, unrecognised revenue accumulates silently; with it, the pile
cannot grow past one and the person who must act cannot do their next job until they do.

⚠️ **v1's carve-outs are load-bearing and must be ported with the rule — they are what stop it
deadlocking:**

| Always allowed, even when an older day is unverified | Why |
|---|---|
| **Editing the existing draft** | Otherwise the blocked day cannot be fixed |
| **Backfilling an OLDER date** | You must be able to fill the gap that caused the block |
| **Starting a shift** | The block is about recognition, never about trading |

**Admins bypass the block** (v1 flipped to this deliberately on 2026-06-20 at Ian's request —
`docs/DEFECTS-REGISTER.md` discipline: do not "restore" the no-exemption version). Matches the
standing admin/manager bypass pattern.

### 1.3 The entry dates on the SALES DAY, never the posting date

A 31 December sale confirmed on 2 January is **December revenue**. Without this the block would
merely relocate the error into the wrong month.

> Together, 1.2 and 1.3 make the close honest: **the period cannot silently accumulate
> unrecognised revenue, and nothing lands in the wrong month.**

---

## 2. ⛔ The flaw v2 must not inherit: revenue comes from the LEDGER

v1's income statement reads `Σ salesDays.totalSales` — **the mirror document is the revenue, not
the journal.** That is why disabling the commissary auto-create mattered so much in v1, and why
three readers had to agree.

**In v2 the journal is the revenue.** The sales day is a source document that posts, exactly like
an expense. It has no authority of its own.

⚠️ **The v1 consequence to check for in the ETL:** commissary branch-sale revenue only reached the
income statement if a report already existed for that day; otherwise the receivable was correct and
the P&L revenue was simply **deferred indefinitely**. Any v1 figure we compare against carries that
distortion.

---

## 3. Posting — inherited from T-108, not re-decided

Five patterns are already pinned and verified in `docs/POSTING-PATTERNS.md`:
`sale.unli.simple` · `sale.alacarte.simple` · `sale.discount.senior-pwd` · `sale.comps` ·
`sale.mixed`. **Look them up; do not decide.**

Two traps they encode, both from `GLOSSARY.md`:

- **`dineInSales` is unlimited-package sales only** — not "all dine-in". Posts to 4100.
- **`takeOutSales` is a RESIDUAL**, `max(0, totalGross − dineInSales)`. It absorbs dine-in à la
  carte, take-out **and** delivery together, because POS has no take-out flag at all. Posts to
  4150. **Never chart it as take-out.**

> ⚠️ `POSTING-PATTERNS.md:184` records that **v1's own `sale.builder.ts` posts only the cash and
> online legs — zero revenue, zero discount, zero comps.** Sales day in v2 is where the nominal
> legs come into existence. **This is not a port; it is the repair.**

---

## 4. Where the money lands — Ian's owner split, and the gap in it

Ian, 2026-08-25: *"The accounts have 2 owners, cashier and office, and cashier has cash and online
accounts — the cashier till always exists with cash and online, same for office-owned. This clearly
shows money movement."*

**This is a good model and it is retained.** It answers *"whose hands is this money in?"*, which is
the question a till reconciliation actually asks.

### What v1 has

| | Mechanism |
|---|---|
| **Cash** | Three hardcoded accounts — `cash__cashier`, `cash__office`, `cash__staff` |
| **Online** | `online__{paymentAccountId}`, with `owner?: 'cashier' \| 'office' \| null` **on the payment-account config doc** |

### ⚠️ Two problems, and v2 currently inherits the worse one

1. **v2's chart loses the owner split on online entirely.** Cash keeps it — 1110 cashier, 1120
   staff custodian, 1130 office. But **1140 is a single "E-wallet / online channels" control**,
   subdivided per provider, with **no owner dimension at all**. So *"how much online money is in
   the cashier's hands versus the office's"* is currently unanswerable in v2. **Ian's split is only
   half retained.**
2. **v1 expresses the same concept two different ways** — owner is baked into the account code for
   cash, and is a nullable field on a config doc for online. And because it is `owner?: ... | null`,
   **an account with no owner is representable.**

### Not designed here — flagged, with the shape of the answer

Ian: *"or if industry has a better way of doing it, same to that effect."* **That comparison is a
research pass, not a guess**, and it is not blocking this task. Two things worth naming now so
they are not lost:

- Every reference system treats **a real-world funds location as its own GL account** — so
  "cashier till" and "office cash" being separate accounts is already the industry answer, not a
  deviation. The fix is likely to *extend* the model to online, not replace it.
- v1's `isRemittedDaily` flag suggests the till is remitted to the office daily. **The money that
  has left the till but not yet reached the office is a real state with a standard name**
  (*cash in transit* / *undeposited funds*). v1 has no account for it. Worth the research pass.

---

### ⛔ Remittance does NOT live on the sales day — do not port v1's fields

v1 stores `actualRemittanceCash`, `actualRemittanceOnline`, `remittanceRefNo`,
`remittanceDiscrepancyCash`/`Online` **as fields on the sales day**, plus `partially_remitted` /
`remitted` statuses. **That makes a remittance unable to span days by construction** — and Ian has
asked for pooled remittance (3-day, weekly), which T-136 records.

**So T-123 must NOT bake those fields onto the day.** The day carries revenue recognition; a
separate remittance document (T-136) references the days it covers, and **the day's remittance
status is derived from what covers it.** Porting v1's shape here would block pooling before it
starts, and unpicking it later means touching every reader.

## 5. The channel gap — this is T-123's problem, not POS v2's

Discovery 22 §3.3: POS stamps `receipt.source = "online"` and **never reads it**. Online-order
sales fold into the same bucket as in-store à la carte. **A sales-channel dimension does not exist
as one column anywhere in POS today.**

But v1's ERP salesDay **does** carry `salesChannelBreakdown` — the ERP adds the dimension POS
cannot supply. **So the channel breakdown is the ERP's to own, and it is reconstructed here, not
read from POS.** Anything that presents it must state its basis, because it is derived from a
residual (§3).

---

## 6. Capabilities

Already in the matrix, unchanged: `record_sale` (all four roles) · `submit_sales_day` (incl. staff
— a cashier closes their own day) · `verify_sales_day` (**not staff**) · `void_sales_day` (**not
staff**) · `accept_remittance` (**not staff**).

> ⭐ **`submit` and `verify` are deliberately different capabilities.** *"The person who submits
> should not be the one who verifies."* The matrix already says so; this task is where that
> segregation first does real work.

⚠️ **DEF-052** — `accept_remittance` in v1 is a grant that enforces nothing. **Every ✅ needs a
test proving the ✗ fires.**

## 7. Invariants

1. An unverified sales day has **no journal entry**. Proven by asserting the ledger, not a reader.
2. Verifying posts; the entry dates on the **business date**, not `now()`.
3. **Creating a new day is blocked while an older one is unverified** — and *editing that draft,
   backfilling an older date, and starting a shift are NOT blocked.* All four proven.
4. An **admin bypasses** the create-block. With a test.
5. Voiding a verified day **reverses** its entry; the original stands (bible §4).
6. The five T-108 patterns post exactly as pinned, through `postEntry`.
7. Cash posts to the **owning** account (1110 cashier / 1130 office); online posts to 1140.
   ⚠️ A day whose split cannot be resolved **blocks** rather than defaulting to cashier —
   an unmappable funding source is the same defect class as an unmapped expense category (T-122
   invariant 7).
8. A verified day is **immutable**; corrections are a void-and-reissue.
9. Every capability has a denial test.
10. No sales day posts into a **closed period** (ADR-006).

## Out of scope

Replacing POS · the remittance/handover workflow itself (`accept_remittance` is only gated here) ·
the cash-in-transit research (§4) · channel settlement (T-130/131) · VAT computation — **§3's
discount is management reporting, never a BIR VAT-exemption computation.**

## Open

1. **Does the POS pull run on a schedule, or is it a button?** v1 is *"button-only creation"* by
   deliberate decision — auto-creators were removed. Suggest porting that: a report should exist
   because a person filed it.
2. **What happens when POS's figure changes after verification?** A late void in POS moves a day
   already recognised. Suggest: it does not silently re-post — it becomes an OIL finding (T-135).
3. **Per-store or per-store-per-shift?** v1 is per store per business date. Suggest keeping that.
