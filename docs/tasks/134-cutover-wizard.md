# T-134 — The 31 December **conversion**: a guided, verified switch to v2

> **Status:** design 2026-08-25, **corrected against `docs/discovery/21-migration-wizards.md`.**
> The first draft was written before that research, which was backwards — bible §3.6 requires
> research first, and Ian had to point it out. **Everything below has been checked against what
> Xero, Odoo and ERPNext actually do**, and three of the draft's decisions changed as a result.
> **Runs at least twice:** the November rehearsal (ADR-007) and the real cutover.
> **Depends on:** T-119 (the purge), T-121 (roles), ADR-005 (the opening entry), ADR-009 (cost).

## ⚠️ It is a CONVERSION, not an onboarding wizard — and the words matter

Ian asked for *"a multi-step guide … what to delete … what to add … a progress bar so nothing is
missed."* The draft called that a wizard, and the vocabulary pulled the design toward the wrong
prior art. **Xero and Odoo both use a specific word for this, and it is not "onboarding":**

| | Onboarding checklist | **Conversion** |
|---|---|---|
| Shape | A permissive, skippable tour | A small, tightly-scoped data-entry act |
| Steps | Dozens, generic, admin-authored | **~15, hardcoded, this business only** |
| Gates | Almost none | **One real correctness gate at the end** |
| Runs | Once per tenant, thousands of tenants | **Twice. One company. Four stores** |

**The draft's substance was already the second thing; only its vocabulary and a few mechanics were
the first.** Discovery 21's correction is to *pare back*, not elaborate — no step-type registry, no
CSV importer, no progress-visibility engine. **Fifteen rows in a table.**

## The design principle survives, narrowed

> **A step is complete when the SYSTEM can see it is complete, not when someone ticked a box.**

Still right — **but only where every mature system also puts its hard checks.** ERPNext's own
onboarding framework verifies **1 of 6** step types; Odoo verifies **2 of 8** accounting steps.
Everything else in both is a click. Real verification lives at the **close/cutover gate**, never
sprayed across a checklist (discovery 21 §3.3).

**So the ✅ list below stays at six. It does not grow.** Anything else is Attested and says so.

## Three kinds of step, shown differently on screen

| | How it completes | Example |
|---|---|---|
| ✅ **Verified** | A query proves it. **Cannot be ticked by hand** | *"3900 nets to zero"* · *"every purge-class table is empty"* |
| ✍️ **Attested** | A named person states it; name + timestamp recorded | *"I counted Lipa's stock on 31 Dec"* |
| ⚙️ **Performed** | The wizard runs it and records the result | The purge · posting the opening entry |

**Attested steps are visibly weaker and say so.** *"Recorded by Ian, 31 Dec 22:14 — not
machine-verifiable"* is honest; a green tick identical to a verified one is not. No system studied
does better on a physical count either — ERPNext's own opening-stock reconciliation still just takes
a human-typed quantity (§3.4, §5.2). **We are not behind the field here; the field has the same
limit.**

---

## The steps

### Phase A — in v1, during December

| # | Step | Kind | Why |
|---|---|---|---|
| A1 | **Clear the delivery-expensing backlog** | ✅ *no delivery in the period lacks a linked expense* | **The cost basis is weakest for exactly the stock being valued** (ADR-009). Counting first prices the newest — and only — stock at nothing |
| A2 | **Final v1 depreciation run** | ✅ *depreciation legs exist for the last period* | It lands directly in the opening balance. DEF-044 proved it stops silently |
| A3 | **Reconcile every cash and bank account to 31 Dec** | ✍️ attested per account | 🆕 **Added by the research.** Partial transfers are a named top-of-list migration failure, and an unreconciled bank account is the classic one skipped (§8.4). It was implicit inside the export step; implicit is how a step gets missed |
| A4 | **Export May–Dec figures** | ✍️ attested | Feeds Ian's 2026 spreadsheet (ADR-005). *Legacy basis, unaudited* — and it stays a spreadsheet, never a comparatives screen |

### Phase B — the physical work, 31 December

| # | Step | Kind | |
|---|---|---|---|
| B1 | **Valued stock count, per store** | ✍️ attested **per store** | Four attestations, not one. A single tick hides a store nobody visited |
| B2 | **Asset walk-round, per store** | ✍️ attested per store | Confirms existence **and remaining useful life** — without which v2 cannot depreciate anything (row 109) |
| B3 | **Enter counted quantities** | ✅ *every active item has a quantity, or an explicit zero* | **An item silently absent is indistinguishable from an item counted as zero.** Force the distinction |

### Phase C — the switch, 1 January

| # | Step | Kind | |
|---|---|---|---|
| C1 | **Backup taken and restore REHEARSED** | ✍️ attested + ✅ *a restore actually ran* | Bible §15.8. *"A backup was taken"* is not the claim that matters |
| C2 | **Run the purge** | ⚙️ `cutover:purge` | Dry-run first, always. Post-conditions assert inside the transaction (T-119) |
| C3 | **Enter opening balances** | ⚙️ a **draft** entry, built up over days | Mutable until locked, and the wizard tells you what is still missing |
| C4 | **3900 nets to exactly zero** | ✅ | **A residual HALTS.** Never plugged — see below. The running residual is **visible throughout C3**, not revealed here |
| C5 | **Trial balance ties, then POST** | ✅ then ⚙️ | Posting is what makes C3 immutable. The books are open |

---

## ⭐ Correction 1 — ordering: four named gates, not a blanket rule

The draft said *"a step is not startable until its prerequisites verify."* **Too strong.** No
reference system hard-blocks checklist steps on each other: Xero's four steps are ordered but freely
re-editable afterward, ERPNext opens on the first incomplete step but locks nothing, Odoo has no
ordering check at all (§4.1–4.3).

**But this project has a proven case where skipping ahead silently produces a wrong number** —
ADR-009's finding that counting before clearing the backlog prices the new stock at zero, which
*"nobody would have found by reasoning about it."* That is exactly the shape of transition every
system **does** hard-gate — inside close/reopen chains, never inside a setup wizard (§4.4).

**So: four hard gates, each already argued for by an existing ADR or defect.**

| Gate | Why it must be hard |
|---|---|
| **A1 → B1** | ADR-009. The inversion took *counting* to find |
| **C2 → C3** | Opening balances entered into a database still holding pilot data are meaningless, not merely risky |
| **C3 → C4** | The check has nothing to check against otherwise |
| **C4 → C5** | ADR-005's own stated order |

**Everything else is free-orderable** — A2/A3/A4 among themselves, B1/B2 among themselves, and all
four stores independently. **A blanket rule would have been stricter than every system studied, for
no evidenced reason.**

## ⭐ Correction 2 — no `REHEARSAL` flag. Isolation is the database

The draft proposed stamping rehearsal attestations `REHEARSAL`. **Drop it.**

**No system studied ships a rehearsal mode inside the live product** (§7.3). Every dress-rehearsal
practice in the literature is *the real software against an isolated copy* — a sandbox company, a
restored database, a test tenant. **ADR-007 already provides exactly that**, and ADR-007 §1 already
rejected this precise anti-pattern one level up: *"the table is the mark, there is no per-row flag."*

> **A flag is a marker a code path can forget to set** — and a forgotten one produces a rehearsal
> attestation indistinguishable from a real one. **The restored database cannot forget what it is.**

The November rehearsal is corroborated as standard practice, not an invented precaution — a "mock
cutover" run with the same data, people and clock is named ERP practice, and ADR-005's 30 Sep ETL
dry run is the documented *lighter, earlier* run that should precede it (§7.1–7.2).

## ⭐ Correction 3 — C3 is a mutable DRAFT until C5 posts it

The draft implied invariant 5 (posted records are immutable; corrections are reversals) applied from
the first figure typed. **Both dedicated conversion tools disagree, and they are right:** Xero
reverses and replaces its conversion journal on every save; Odoo refuses to touch the opening move
*only once it is posted*, and tells you to reset it to draft first (§1.4).

**C3 is one unposted `journal_entries` draft, editable in place across the entry window. C5's post
is what makes it immutable.**

> This **scopes** invariant 5's start point rather than weakening it — the same distinction as an
> original movement versus a correction to history. **Forcing a formal reversal to fix a typo in a
> document that was never final is ceremony, not control.** It also matches this project's own
> draft-first posting discipline (`postEntry`, DEF-031/T-105) — nothing new is being invented.

That also settles the draft's open Q3: **yes, partial entry across days.** Fourteen suppliers were
never going to be entered in one sitting, and now the model says so explicitly.

---

## "Show the user what is needed" — derived, never a static list

The opening-balance step does not present a form and hope. It computes what is outstanding and shows
the gap:

- **AR / AP:** every party carrying a balance in the v1 audit with **no opening figure yet** — by
  name, with the audited figure beside the entered one.
- **Cash and bank:** every cash/bank account with no opening entry.
- **Assets:** every asset from the walk-round with no opening book value **or no remaining life**.
- **Inventory:** every counted item with a quantity but no cost basis.

> **This is the difference between a checklist and a guide.** A checklist says *"enter opening AR."*
> A guide says *"14 suppliers still have no opening figure — here they are, and here is what the
> audit says each should be."*

**This is real prior art, not an invented pattern**: Odoo recomputes its opening debit/credit
straight off the ledger on every read, and ERPNext's opening-invoice tool groups live query results
— **neither keeps a hand-maintained tally** (§1.6, §2.1). And `docs/reviews/v1-audit-*.md` already
*is* the cross-system trial-balance comparison the practitioner literature still assumes a human
runs by hand (§2.3).

**Audited figures show as a reference, never as a default.** A pre-filled figure gets accepted
without being checked, and the whole point of the count is that someone checks.

### ⚠️ Name the double-counting trap, do not just avoid it

ADR-005's amendment enters AR/AP as **a lump balance per party**, allocation left to Ian's
spreadsheet. **This is the deliberate minority position** — Xero and QuickBooks both recommend
entering each outstanding invoice individually (§1.2). Ian weighed that tradeoff by name and chose
simplicity; it is not being reopened.

**But the named failure mode of the lump approach must be guarded explicitly:** if a party's opening
lump *and* a re-entered pre-cutover invoice both exist, the same money is counted twice (§8.3).
**Guard it by naming it** — C3 rejects any post-cutover document dated before the conversion date
for a party that already carries an opening balance.

## 🆕 Where the count's variance posts — and why that is not hiding it

**An opening-count variance posts against 3900 (Opening balance equity), never against 5400
(Inventory adjustment).** ERPNext enforces exactly this distinction with a dedicated error class: an
*opening*-stock reconciliation's difference account must be asset/liability type, while an ordinary
reconciliation's variance goes to a P&L stock-adjustment account (§5.1).

The reasoning matters, because posting a variance to equity looks like burying it:

- **v2 has no December P&L to charge it to.** v1 owns 2026 entirely; v2 starts from zero (row 106).
  Posting December's shrinkage to 5400 would land it in **January's** expenses — the wrong period,
  reported as if it were this year's operating result.
- **It stays visible.** The variance is a named line in the opening entry with a reason, and it is a
  finding in the OIL feed (T-135). **Recorded and explained beats charged to the wrong month.**

This is the one place ADR-009's *"the count verifies a computed value — and the variances mean
something"* needed a posting rule, and now it has one. *(Note: discovery 21 §5.1 calls this an
answer to ADR-009's open question 3 — it is not; question 3 is about how incomplete the cost basis
is. The finding is right, the cross-reference is off.)*

## Progress

`n of m` overall and per phase. **Blocked steps show as blocked with the reason** — *"B1 waits on
A1: 12 December deliveries still unexpensed"* tells you what to go and do. Hidden steps do not.

**Resumable across weeks**, and that needs no engineering: a persisted status row per (step, store)
carrying who, when, and verified/attested/performed. Odoo's own progress is exactly this — a
database row, not session state (§6.1). **Four stores means four rows, not a framework.**

## Who may run it

`run_cutover` — a **new capability**, held by nobody by default. Per the matrix's own rule it needs a
test proving the denial fires.

- **Attestations** — **manager**, for their own store, stamped with their name.
- **The purge and the opening entry** — **admin**. C2 and C5 are irreversible in practice.
- **Visibility** — the whole thing, read-only, to any manager; only their own store's attestations
  are editable. **Seeing the progress is part of what stops a store being forgotten**, and at four
  stores this needs none of Odoo's per-tenant machinery. *Closes open Q1.*

## ⚠️ Built 2026-08-28 — and two of the six ✅ checks cannot be checked here

Invariant 1 says *"the six ✅ checks are queries over real state."* Building it found that **two of
them are not queries this database can run**, and the honest thing is to say so rather than ship a
green tick that was never earned.

| Step | Spec says | Reality |
|---|---|---|
| **A1** delivery backlog | ✅ *no delivery in the period lacks a linked expense* | ⛔ The check is over **v1 deliveries**, and v2 holds no v1 data — it opens from a zero starting point by design |
| **A2** final depreciation run | ✅ *depreciation legs exist for the last period* | ⛔ Same: **v1** legs. ⚠️ v2's own equivalent IS machine-checked (T-135's `depreciationNotBooked`), but that watches v2 |
| **B3** counted quantities | ✅ *every active item has a quantity, or an explicit zero* | ✅ **Now real** — `opening_counts` was built for it, and it feeds C3's inventory figures too |
| **C2** purge complete | ✅ | ✅ Enumerated from `CUTOVER_CLASSIFICATION` at runtime, so a table classified `purge` later is covered without anybody remembering |
| **C4** 3900 nets to zero | ✅ | ✅ |
| **C5** trial balance ties | ✅ | ✅ |

A1 and A2 carry `cannotVerifyHere` with the reason, render as **not machine-verifiable**, and accept
an attestation. ⭐ **They are not silently downgraded** — the string is in the step definition and a
test asserts it.

### ⭐ And a real gap the build exposed: a verified check can pass VACUOUSLY

C4 asks whether `3900` nets to zero. **On an empty ledger it trivially does** — nothing has been
entered, so nothing is unbalanced. A step could therefore show green before its prerequisite had
run, which is precisely the false confidence the gates exist to prevent, and the same shape as
ADR-009's inversion where counting early produced a confident wrong number rather than an error.

⚠️ **So a blocked step is never `done`, even when its own check passes.** The check result and the
gate are both reported — `detail: null` with `blockedBy: "C4 waits on C3"` — because *"this would
pass, but it has not been asked yet"* is a different and more useful statement than either half
alone.

## Invariants

1. The six ✅ checks are queries over real state. **None can be satisfied by a click.**
2. **The ✅ list does not grow** without an evidenced reason — every system studied verifies a small
   minority of its steps, and a check that is really a tick is worse than an honest tick.
3. The four hard gates are the **only** enforced ordering. Everything else is free.
4. **No rehearsal flag exists anywhere.** Rehearsal is a restored database (ADR-007).
5. C3 is a draft until C5 posts it; after that, invariant 5 applies in full.
6. A 3900 residual **halts**. There is no plug account, and no code path that creates one.
7. Opening-count variance posts against 3900, never 5400.
8. Every attestation records a named person and a timestamp, and renders as *not machine-verifiable*.

## What we deliberately do NOT build

Named so the next person does not add them back thinking they were forgotten:

1. **A step-type registry** (Create Entry / Update Settings / Show Form Tour / …). Generality for a
   procedure that runs twice.
2. **Auto-plug to suspense.** Xero's *"Ask My Accountant"*, Odoo's automatic balancing line and
   GnuCash's `Imbalance-<currency>` are all real, and together they are the **majority** behaviour —
   **and all three are scale-driven.** They exist because those vendors serve millions of self-serve
   tenants who cannot get a human's attention for every mismatch. **One company, one cutover, Ian
   personally available: none of that constraint applies.** We halt. *This is the most consequential
   finding in discovery 21 — the divergence is deliberate and scale-driven, not us being more
   careful for its own sake.*

   > ### ⭐ But borrow the half of it that is actually useful
   >
   > Ian asked (2026-08-25) whether the halt is enough or whether we should mirror the field.
   > **Keep the halt** — but notice *what the plug account actually buys those vendors*, because
   > it is two things and only one of them is bad:
   >
   > | What auto-plugging gives | Keep it? |
   > |---|---|
   > | The residual becomes a **visible number** you can watch and chase | ✅ **Yes** |
   > | The residual becomes **postable**, so the books open while still wrong | ❌ **No** |
   >
   > So C3 shows a **running residual the whole time you are entering** — *"difference: ₱4,820.50"*
   > — updating as figures land. That is the early-warning the suspense account provides, without
   > the escape hatch. **An imbalance found on the tenth supplier is a typo; the same imbalance
   > found after the last one is an investigation.**
   >
   > And because C3 is now a **draft** (correction 3), the halt costs nothing: an unbalanced entry
   > is simply an entry that cannot post yet. **Nothing is lost, no session is abandoned, and no
   > fictional account is created.** That is strictly better than the plug — same convenience, none
   > of the harm.
3. **CSV import of the chart of accounts.** Ours is a fixed ~90-account set, already seeded.
4. **Comparative-balances screens.** ADR-005 declines to load 2026 comparatives as if they were
   real; a screen would invite treating a hand-scanned figure as audited because it sits next to
   audited ones.
5. **A progress-visibility engine.** Four stores. Four rows.

## Open

**None.** The draft's three questions are answered above — visibility (whole thing read-only, own
store editable), variance treatment (record both, post against 3900, surface as an OIL finding), and
partial entry across days (yes, by construction, now that C3 is a draft).
